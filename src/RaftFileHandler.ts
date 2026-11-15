/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftFileHandler
// Communications Library
//
// Rob Dobson & Chris Greening 2020-2022
// (C) 2020-2022
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftLog from './RaftLog'
import RaftMsgHandler from './RaftMsgHandler';
import {
  RaftFileDownloadResult,
  RaftFileDownloadStartResp,
  RaftFileDownloadEndResp,
  RaftFileSendType,
  RaftFileStartResp,
  RaftOKFail,
  RaftProgressCBType,
} from './RaftTypes';
import RaftCommsStats from './RaftCommsStats';
import RaftUtils from './RaftUtils';
import RaftMiniHDLC from './RaftMiniHDLC';
import { RICRESTElemCode } from './RaftProtocolDefs';

class FileBlockTrackInfo {
  isDone = false;
  prom: Promise<boolean>;
  constructor(prom: Promise<boolean>) {
    this.prom = prom;
    this.prom.then(
      () => {
        // RaftLog.debug('send complete');
        this.isDone = true;
      },
      rej => {
        RaftLog.debug(`FileBlockTrackInfo send rejected ${rej}`);
        this.isDone = true;
      },
    );
  }
  isComplete() {
    return this.isDone;
  }
  get() {
    return this.prom;
  }
}

// No data arrived for FILE_RX_STALL_MS and smaller blocks can be tried
class FileRxStalledError extends Error {
  constructor() {
    super('fileReceive stalled');
  }
}

export default class RaftFileHandler {
  private _msgHandler: RaftMsgHandler;

  // Timeouts
  private BLOCK_ACK_TIMEOUT_MS = 30000;

  // Contents of file to send
  private _requestedFileBlockSize = 500;
  private _fileBlockSize = 0;
  private _requestedBatchAckSize = 10;
  private _batchAckSize = 0;

  // File sending flow control
  private _sendWithoutBatchAcks = false;
  private _ackedFilePos = 0;
  private _batchAckReceived = false;
  private _isTxCancelled = false;
  private _fileTxStreamID = 0;

  // File receive info
  private _isRxCancelled = false;
  private _fileRxActive = false;
  private _fileRxBatchMsgSize = 0;
  private _fileRxBatchAckSize = 0;
  private _fileRxStreamID = 0;
  private _fileRxFileLen = 0;
  private _fileRxCrc16 = 0;
  private _fileRxBuffer = new Uint8Array(0);
  private _fileRxLastAckTime = 0;
  private _fileRxLastBlockTime = 0;
  private FILE_RX_ACK_RESEND_TIMEOUT_MS = 1000;
  private _fileRxBlocksSinceAck = 0;
  private _fileRxBridgeID: number | undefined = undefined;

  // Download block size to ask for (the device may lower it). A download that gets no data for
  // FILE_RX_STALL_MS starts again with blocks of half the size (down to FILE_RX_BLOCK_SIZE_MIN), and the size that
  // worked is then asked for first: firmware with RaftCore 1.67.0 or earlier can offer blocks its transport can't send (the
  // USB serial console drops a frame over 4096 bytes once encoded) and never sends smaller ones. Later firmware
  // halves the block size itself after 3s, which is why the wait here is longer
  private _fileRxBlockSizeToRequest = 5000;
  FILE_RX_STALL_MS = 6000;
  FILE_RX_BLOCK_SIZE_MIN = 300;

  // RaftCommsStats
  private _commsStats: RaftCommsStats;

  // Message await list
  private _msgAwaitList: Array<FileBlockTrackInfo> = new Array<FileBlockTrackInfo>();
  private MAX_OUTSTANDING_FILE_BLOCK_SEND_PROMISES = 1;

  constructor(msgHandler: RaftMsgHandler, commsStats: RaftCommsStats) {
    this._msgHandler = msgHandler;
    this._commsStats = commsStats;
    this._fileBlockSize = this._requestedFileBlockSize;
    this.onOktoMsg = this.onOktoMsg.bind(this);
  }

  setRequestedFileBlockSize(blockSize: number){
    this._requestedFileBlockSize = blockSize;
  }

  setRequestedBatchAckSize(batchAckSize: number){
    this._requestedBatchAckSize = batchAckSize;
  }

  async fileSend(
    fileName: string,
    fileType: RaftFileSendType,
    fileDest: string,
    fileContents: Uint8Array,
    progressCallback: ((sent: number, total: number, progress: number) => void) | undefined,
  ): Promise<boolean> {
    this._isTxCancelled = false;
    this._fileTxStreamID = 0;

    // Send file start message
    if (!await this._sendFileStartMsg(fileName, fileType, fileDest, fileContents))
      return false;

    // Send contents
    if (!await this._sendFileContents(fileContents, progressCallback))
      return false;

    // Send file end
    await this._sendFileEndMsg(fileName, fileType, fileDest, fileContents);

    // Clean up
    await this.awaitOutstandingMsgPromises(true);

    // Complete
    return true;
  }

  async fileSendCancel(): Promise<void> {
    // Await outstanding promises
    await this.awaitOutstandingMsgPromises(true);
    this._isTxCancelled = true;
  }

  // Send the start message
  async _sendFileStartMsg(
    fileName: string,
    fileType: RaftFileSendType,
    fileDest: string,
    fileContents: Uint8Array,
  ): Promise<boolean> {
    // File start command message
    const reqStr =
      fileType == RaftFileSendType.FIRMWARE_UPDATE
        ? 'espfwupdate'
        : 'fileupload';

    const fileLen = fileContents.length;
    const cmdMsg = `{"cmdName":"ufStart","reqStr":"${reqStr}","fileType":"${fileDest}","fileName":"${fileName}","fileLen":${fileLen},"batchMsgSize":${this._requestedFileBlockSize},"batchAckSize":${this._requestedBatchAckSize}}`;

    // Debug
    RaftLog.debug(`sendFileStartMsg ${cmdMsg}`);

    // Send
    let fileStartResp = null;
    try {
        fileStartResp = await this._msgHandler.sendRICREST<RaftFileStartResp>(
                cmdMsg,
                RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
        );
    } catch (err) {
      RaftLog.warn(`sendFileStartMsg error ${err}`);
      return false;
    }
    if (!fileStartResp || fileStartResp.rslt !== 'ok') {
      RaftLog.warn(`sendFileStartMsg error ${fileStartResp?.rslt ?? 'no response'}`);
      return false;
    }

    // Extract params
    if (fileStartResp.batchMsgSize) {
      this._fileBlockSize = fileStartResp.batchMsgSize;
    } else {
      this._fileBlockSize = this._requestedFileBlockSize;
    }
    if (fileStartResp.batchAckSize) {
      this._batchAckSize = fileStartResp.batchAckSize;
    } else {
      this._batchAckSize = this._requestedBatchAckSize;
    }
    const streamID = fileStartResp.streamID;
    this._fileTxStreamID = streamID !== undefined && streamID > 0 && streamID <= 0xff ? streamID : 0;
    RaftLog.debug(
      `_fileSendStartMsg fileBlockSize req ${this._requestedFileBlockSize} resp ${fileStartResp.batchMsgSize} actual ${this._fileBlockSize}`,
    );
    RaftLog.debug(
      `_fileSendStartMsg batchAckSize req ${this._requestedBatchAckSize} resp ${fileStartResp.batchAckSize} actual ${this._batchAckSize}`,
    );
    RaftLog.debug(
      `_fileSendStartMsg streamID ${this._fileTxStreamID}`,
    );
    return true;
  }

  async _sendFileEndMsg(
    fileName: string,
    fileType: RaftFileSendType,
    fileDest: string,
    fileContents: Uint8Array,
  ): Promise<boolean> {
    // File end command message
    const reqStr =
      fileType == RaftFileSendType.FIRMWARE_UPDATE
        ? 'espfwupdate'
        : 'fileupload';
    const fileLen = fileContents.length;
    const streamIDJson = this._fileTxStreamID !== 0 ? `,"streamID":${this._fileTxStreamID}` : '';
    const cmdMsg = `{"cmdName":"ufEnd","reqStr":"${reqStr}","fileType":"${fileDest}","fileName":"${fileName}","fileLen":${fileLen}${streamIDJson}}`;

    // Await outstanding promises
    try {
      await this.awaitOutstandingMsgPromises(true);
    } catch (err) {
      // Ignore
      RaftLog.warn(`sendFileEndMsg awaitOutstandingMsgPromises error ${err}`);
    }

    // Send
    let fileEndResp = null;
    try {
      fileEndResp = await this._msgHandler.sendRICREST<RaftOKFail>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      );
    } catch (err) {
      RaftLog.warn(`sendFileEndMsg error ${err}`);
      return false;
    }
    return fileEndResp?.rslt === 'ok';
  }

  async _sendFileCancelMsg(): Promise<void> {
    // File cancel command message
    const streamIDJson = this._fileTxStreamID !== 0 ? `,"streamID":${this._fileTxStreamID}` : '';
    const cmdMsg = `{"cmdName":"ufCancel"${streamIDJson}}`;

    // Await outstanding promises
    await this.awaitOutstandingMsgPromises(true);

    // Send
    try {
      return await this._msgHandler.sendRICREST(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      );
    } catch (err) {
      RaftLog.warn(`sendFileCancelMsg error ${err}`);
    }
  }

  async _sendFileContents(
    fileContents: Uint8Array,
    progressCallback: ((sent: number, total: number, progress: number) => void) | undefined,
  ): Promise<boolean> {
    if (progressCallback) {
      progressCallback(0, fileContents.length, 0);
    }

    this._batchAckReceived = false;
    this._ackedFilePos = 0;

    // Send file blocks
    let progressUpdateCtr = 0;
    while (this._ackedFilePos < fileContents.length) {
      // Sending with or without batches
      if (this._sendWithoutBatchAcks) {
        // Debug
        RaftLog.verbose(
          `_sendFileContents NO BATCH ACKS ${progressUpdateCtr} blocks total sent ${this._ackedFilePos} block len ${this._fileBlockSize}`,
        );
        if (!await this._sendFileBlock(fileContents, this._ackedFilePos))
          return false;
        this._ackedFilePos += this._fileBlockSize;
        progressUpdateCtr++;
      } else {
        // NOTE: first batch MUST be of size 1 (not _batchAckSize) because Raft performs a long-running
        // blocking task immediately after receiving the first message in a firmware
        // update - although this could be relaxed for non-firmware update file uploads
        //
        // Each batch is sent from the latest ack (go-back-N). Current RaftCore acks the first block out of sequence
        // at once and keeps its acks in step with the batches, so after a lost block this resends little and
        // doesn't wait for the device's timer ack. (Carrying on past an ack that covers only part of a batch
        // resends less with older firmware, but with current firmware it sends blocks the device then drops
        // without an ack, and waits 1s for the timer ack after every lost block)
        let sendFromPos = this._ackedFilePos;
        const batchSize = sendFromPos == 0 ? 1 : this._batchAckSize;
        // Acks that arrive while the batch is going out count (the device may ack part-way through a batch)
        this._batchAckReceived = false;
        for (
          let i = 0;
          i < batchSize && sendFromPos < fileContents.length;
          i++
        ) {
          // Debug
           RaftLog.debug(
             `_sendFileContents sendblock pos ${sendFromPos} len ${this._fileBlockSize} ackedTo ${this._ackedFilePos} fileLen ${fileContents.length}`,
           );
          if (!await this._sendFileBlock(fileContents, sendFromPos))
            return false;
          sendFromPos += this._fileBlockSize;
        }

        // Wait for response (there is a timeout at the ESP end to ensure a response is always returned
        // even if blocks are dropped on reception at ESP) - the timeout here is for these responses
        // being dropped
        await this.batchAck(this.BLOCK_ACK_TIMEOUT_MS);
        progressUpdateCtr += this._batchAckSize;
      }

      // Show progress
      if ((progressUpdateCtr >= 20) && progressCallback) {
        // Update UI
        progressCallback(
          this._ackedFilePos,
          fileContents.length,
          this._ackedFilePos / fileContents.length,
        );

        // Debug
        RaftLog.debug(
          `_sendFileContents ${progressUpdateCtr} blocks sent OkTo ${this._ackedFilePos} block len ${this._fileBlockSize}`,
        );

        // Continue
        progressUpdateCtr = 0;
      }
    }
    return true;
  }

  async batchAck(timeout: number): Promise<void> {
    // Handle acknowledgement to a batch (OkTo message)
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkForAck = async () => {
        if (this._isTxCancelled) {
          RaftLog.debug('checkForAck - cancelling file upload');
          this._isTxCancelled = false;
          // Send cancel
          await this._sendFileCancelMsg();
          // abort the upload process
          reject(new Error('Update Cancelled'));
          return;
        }
        if (this._batchAckReceived) {
          RaftLog.debug(`checkForAck - rx OkTo ${this._ackedFilePos}`);
          this._batchAckReceived = false;
          resolve();
          return;
        } else {
          const now = Date.now();
          if (now - startTime > timeout) {
            RaftLog.warn(`checkForAck - time-out no new ack received`);
            reject(new Error('Update failed. Please try again.'));
            return;
          }
          setTimeout(checkForAck, 100);
        }
      };
      checkForAck();
    });
  }

  async _sendFileBlock(
    fileContents: Uint8Array,
    blockStart: number,
  ): Promise<boolean> {
    // Calc block start and end
    const blockEnd = Math.min(
      fileContents.length,
      blockStart + this._fileBlockSize,
    );

    // Check if we need to await a message send promise
    await this.awaitOutstandingMsgPromises(false);

    // Send
    const promRslt = this._msgHandler.sendFileBlock(fileContents.subarray(blockStart, blockEnd), blockStart, this._fileTxStreamID);
    if (!promRslt) {
      return false;
    }

    // Record
    this._commsStats.recordFileBytes(blockEnd - blockStart);

    // Add to list of pending messages
    this._msgAwaitList.push(new FileBlockTrackInfo(promRslt));

    // Debug
    // RaftLog.debug(
    //   `sendFileBlock start ${blockStart} end ${blockEnd} len ${blockLen}`,
    // );
    return true;
  }

  onOktoMsg(fileOkTo: number) {
    // A late ack behind one already received says nothing new
    if (fileOkTo < this._ackedFilePos) {
      RaftLog.verbose(`onOktoMsg ignored late OkTo ${fileOkTo} acked ${this._ackedFilePos}`);
      return;
    }
    // Get how far we've progressed in file
    this._ackedFilePos = fileOkTo;
    this._batchAckReceived = true;
    RaftLog.verbose(`onOktoMsg received file up to ${this._ackedFilePos}`);
  }

  async awaitOutstandingMsgPromises(all: boolean): Promise<void> {
    // Check if all outstanding promises to be awaited
    if (all) {
      for (const promRslt of this._msgAwaitList) {
        try {
          await promRslt.get();
        } catch (error: unknown) {
          RaftLog.warn(`awaitAll file part send failed ${error}`);
        }
      }
      this._msgAwaitList = [];
    } else {
      // RaftLog.debug('Await list len', this._msgAwaitList.length);
      if (
        this._msgAwaitList.length >=
        this.MAX_OUTSTANDING_FILE_BLOCK_SEND_PROMISES
      ) {
        const fileBlockTrackInfo = this._msgAwaitList.shift();
        try {
          if (fileBlockTrackInfo) {
            await fileBlockTrackInfo.get();
          }
        } catch (error: unknown) {
          RaftLog.warn(`awaitSome file part send failed ${error}`);
        }
      }
    }
  }

  async fileReceive(
    fileName: string,
    fileSource: string,
    progressCallback: RaftProgressCBType | undefined,
  ): Promise<RaftFileDownloadResult> {
    this._isRxCancelled = false;

    // Check for bridgeserial1..N as fileSource - in this case use the RICREST bridging protocol
    // as attached devices using CommandSerial require bridging
    let bridgeID: number | undefined = undefined;
    const bridgeSerialPrefix = 'bridgeserial';
    if (fileSource.startsWith(bridgeSerialPrefix)) {

      // Establish a bridge
      const bridgedDeviceSerialPort = "Serial" + fileSource.slice(bridgeSerialPrefix.length);
      const cmdResp = await this._msgHandler.createCommsBridge(bridgedDeviceSerialPort, "fileSource");
      if (!cmdResp || cmdResp.rslt != "ok") {
        RaftLog.warn(`fileReceive - failed to setup bridge ${cmdResp?.rslt ?? 'no response'}`);
        return new RaftFileDownloadResult();
      }
      bridgeID = cmdResp.bridgeID;

      // Debug
      RaftLog.info(`fileReceive - bridge setup ${bridgeID}`);
    }

    // Start, and receive the contents - again with smaller blocks if no data arrives (see FILE_RX_STALL_MS)
    let blockSize = this._fileRxBlockSizeToRequest;
    let fellBack = false;
    let fileContents: RaftFileDownloadResult;
    for (;;) {
      if (!await this._receiveFileStart(fileName, bridgeID, blockSize))
        return new RaftFileDownloadResult();

      // Smaller blocks are worth trying if the device is using the size asked for (or more)
      const canShrink = (this._fileRxBatchMsgSize >= blockSize) &&
                  (Math.floor(blockSize / 2) >= this.FILE_RX_BLOCK_SIZE_MIN);
      try {
        fileContents = await this._receiveFileContents(progressCallback, bridgeID, canShrink);
        break;
      } catch (err) {
        if (!(err instanceof FileRxStalledError))
          throw err;
        blockSize = Math.floor(blockSize / 2);
        fellBack = true;
        RaftLog.warn(`fileReceive - no data from the device, trying ${blockSize}-byte blocks`);
      }
    }
    if (fellBack)
      this._fileRxBlockSizeToRequest = blockSize;

    // Send file end (and verify deferred CRC if applicable)
    if (!await this._receiveFileEnd(fileName, bridgeID))
      return new RaftFileDownloadResult();

    // Clean up
    await this.awaitOutstandingMsgPromises(true);

    // Complete
    return fileContents;
  }

  async fileReceiveCancel(): Promise<void> {
    this._isRxCancelled = true;
  }

  async _receiveFileStart(fileName: string, bridgeID: number | undefined,
              blockMaxSizeRequested = this._fileRxBlockSizeToRequest) : Promise<boolean> {

    const batchAckSizeRequested = 4;
    const fileSrc = "fs";

    // Request file transfer
    // Frames follow the approach used in the web interface start, block..., end
    // crcAt:end requests the server to defer CRC computation (non-blocking start)
    const cmdMsg = `{"cmdName":"dfStart","reqStr":"getFile","fileType":"${fileSrc}",` +
                    `"batchMsgSize":${blockMaxSizeRequested},` +
                    `"batchAckSize":${batchAckSizeRequested},` +
                    `"crcAt":"end",` +
                    `"fileName":"${fileName}"}`

    // Send
    let cmdResp = null;
    try {
      cmdResp = await this._msgHandler.sendRICREST<RaftFileDownloadStartResp>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
        bridgeID,
      );
    } catch (err) {
      RaftLog.warn(`_receiveFileStartMsg error ${err}`);
      return false;
    }
    RaftLog.info(`_receiveFileStartMsg rslt ${JSON.stringify(cmdResp)}`);
    if (cmdResp?.rslt === 'ok') {
      this._fileRxBatchMsgSize = cmdResp.batchMsgSize;
      this._fileRxBatchAckSize = cmdResp.batchAckSize;
      this._fileRxStreamID = cmdResp.streamID;
      this._fileRxFileLen = cmdResp.fileLen;
      // CRC may be provided at start (old firmware) or deferred to dfEnd (new firmware)
      this._fileRxCrc16 = cmdResp.crc16 ? parseInt(cmdResp.crc16, 16) : -1;
      this._fileRxBuffer = new Uint8Array(0);
      // An ack time of 0 makes _receiveFileContents ack (okto 0) as soon as it starts. The device sends its first
      // block when that ack arrives: a block sent straight after the reply to dfStart could arrive before this
      // handler was ready for it (_fileRxActive below), and be ignored
      this._fileRxLastAckTime = 0;
      this._fileRxBlocksSinceAck = 0;
      this._fileRxBridgeID = bridgeID;
      this._fileRxLastBlockTime = Date.now();
      this._fileRxActive = true;
    }
    if (!cmdResp) {
      RaftLog.warn(`_receiveFileStartMsg failed no response`);
      return false;
    }
    return cmdResp.rslt === 'ok';
  }

  async _receiveFileContents(
        progressCallback: RaftProgressCBType | undefined,
        bridgeID: number | undefined,
        canShrink = false
  ): Promise<RaftFileDownloadResult> {

    // The transfer fails if no data arrives for this long (however long the file takes, as long as data keeps
    // arriving: its speed depends on the link and the firmware)
    const blockTimeoutMs = this.BLOCK_ACK_TIMEOUT_MS;
    RaftLog.info(`_receiveFileContents - fileLen ${this._fileRxFileLen} batchMsgSize ${this._fileRxBatchMsgSize} ` +
        `blockTimeoutMs ${blockTimeoutMs}`);

    // Wait for file to be received
    return new Promise<RaftFileDownloadResult>((resolve, reject) => {
      const checkForComplete = async () => {

        // Check if we've received the whole file
        if (this._fileRxFileLen === this._fileRxBuffer.length) {
          this._fileRxActive = false;

          // The final ack (the device waits for dfEnd for 2s after the last data is acked)
          this._sendFileRxAck();

          // Progress callback
          if (progressCallback) {
            progressCallback(this._fileRxBuffer.length, this._fileRxFileLen);
          }

          // Check CRC if it was provided at start (old firmware)
          if (this._fileRxCrc16 >= 0) {
            const crc16 = RaftMiniHDLC.crc16(this._fileRxBuffer);
            if (crc16 !== this._fileRxCrc16) {
              RaftLog.warn(`_receiveFileContents - CRC error ${crc16} ${this._fileRxCrc16}`);
              reject(new Error('fileReceive CRC error'));
              return;
            } else {
              RaftLog.info(`_receiveFileContents - CRC OK ${crc16} ${this._fileRxCrc16}`);
            }
          }
          resolve(new RaftFileDownloadResult(this._fileRxBuffer));
          return;
        }

        // Check if file transfer cancelled
        if (this._isRxCancelled) {
          RaftLog.info('_receiveFileContents - cancelling file upload');
          this._isRxCancelled = false;
          this._fileRxActive = false;
          // Send cancel message
          this._sendFileRxCancelMsg(bridgeID);
          // abort the upload process
          reject(new Error('fileReceive Cancelled'));
          return;
        }

        // Check for no data arriving
        const now = Date.now();
        const sinceLastBlockMs = now - this._fileRxLastBlockTime;
        if (canShrink && (sinceLastBlockMs > this.FILE_RX_STALL_MS)) {
          // Smaller blocks may get through (see FILE_RX_STALL_MS)
          this._fileRxActive = false;
          this._sendFileRxCancelMsg(bridgeID);
          reject(new FileRxStalledError());
          return;
        }
        if (sinceLastBlockMs > blockTimeoutMs) {
          RaftLog.warn(`_receiveFileContents - time-out no new data received ` +
              `blockGap ${sinceLastBlockMs}ms blockTimeout ${blockTimeoutMs}ms`);
          this._fileRxActive = false;
          this._sendFileRxCancelMsg(bridgeID);
          reject(new Error('fileReceive failed'));
          return;
        }

        // Ack on a timer (a batch of blocks is acked as it completes - see onFileBlock)
        if (now - this._fileRxLastAckTime > this.FILE_RX_ACK_RESEND_TIMEOUT_MS) {
          this._sendFileRxAck();
        }

        // Progress callback
        if (progressCallback) {
          progressCallback(this._fileRxBuffer.length, this._fileRxFileLen);
        }

        // Set timeout for next check
        setTimeout(checkForComplete, 50);
      };
      checkForComplete();
    });
  }

  // Ack what has been received (sent without waiting for a response)
  _sendFileRxAck(): void {
    this._fileRxLastAckTime = Date.now();
    this._fileRxBlocksSinceAck = 0;
    const cmdMsg = `{"cmdName":"dfAck","okto":${this._fileRxBuffer.length},` +
                  `"streamID":${this._fileRxStreamID},"rslt":"ok"}`;
    this._msgHandler.sendRICRESTNoResp(
      cmdMsg,
      RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      this._fileRxBridgeID
    );
    RaftLog.verbose(`_sendFileRxAck ack at ${this._fileRxBuffer.length} msg ${cmdMsg}`);
  }

  async _receiveFileEnd(fileName: string, bridgeID: number | undefined): Promise<boolean> {

    // Send dfEnd and wait for response (may contain deferred CRC)
    const cmdMsg = `{"cmdName":"dfEnd","reqStr":"getFile",` +
          `"fileName":"${fileName}","fileLen":${this._fileRxBuffer.length},` +
          `"streamID":${this._fileRxStreamID}}`

    let cmdResp = null;
    try {
      cmdResp = await this._msgHandler.sendRICREST<RaftFileDownloadEndResp>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
        bridgeID,
      );
    } catch (err) {
      RaftLog.warn(`_receiveFileEnd error ${err}`);
      this._fileRxActive = false;
      return false;
    }

    // Check deferred CRC if start response didn't include one
    if (!cmdResp) {
      RaftLog.warn(`_receiveFileEnd failed no response`);
      this._fileRxActive = false;
      return false;
    }

    if (this._fileRxCrc16 < 0 && cmdResp.crc16) {
      const expectedCrc = parseInt(cmdResp.crc16, 16);
      const actualCrc = RaftMiniHDLC.crc16(this._fileRxBuffer);
      if (actualCrc !== expectedCrc) {
        RaftLog.warn(`_receiveFileEnd - CRC error actual=${actualCrc} expected=${expectedCrc}`);
        this._fileRxActive = false;
        return false;
      }
      RaftLog.info(`_receiveFileEnd - CRC OK ${actualCrc}`);
    }

    // No longer active
    this._fileRxActive = false;
    return true;
  }

  async _sendFileRxCancelMsg(bridgeID: number | undefined): Promise<void> {
    // Send file end message
    const cmdMsg = `{"cmdName":"dfCancel","reqStr":"getFile","streamID":${this._fileRxStreamID}}`
    this._msgHandler.sendRICRESTNoResp(
      cmdMsg,
      RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      bridgeID
    );
  }

  onFileBlock(
    filePos: number,
    fileBlockData: Uint8Array
  ): void {
    // RaftLog.info(`onFileBlock filePos ${filePos} fileBlockData ${RaftUtils.bufferToHex(fileBlockData)}`);

    if (!this._fileRxActive) {
      RaftLog.verbose(`onFileBlock ignored inactive transfer filePos ${filePos} len ${fileBlockData.length}`);
      return;
    }

    const streamID = (filePos >>> 24) & 0xff;
    const streamFilePos = filePos & 0x00ffffff;
    if (streamID !== 0 && streamID !== this._fileRxStreamID) {
      RaftLog.verbose(`onFileBlock ignored stale streamID ${streamID} active ${this._fileRxStreamID}`);
      return;
    }

    // Check if this is the next block we are expecting
    if (streamFilePos === this._fileRxBuffer.length) {

      // Add to buffer
      const tmpArray = new Uint8Array(this._fileRxBuffer.length + fileBlockData.length);
      tmpArray.set(this._fileRxBuffer, 0);
      tmpArray.set(fileBlockData, this._fileRxBuffer.length);
      this._fileRxBuffer = tmpArray;

      // Update last block time
      this._fileRxLastBlockTime = Date.now();

      // Ack a batch as soon as it is complete, so the device can send the next without waiting (counted in
      // blocks: the device may send smaller blocks than it said). The last block is acked when the transfer
      // is seen to be complete
      this._fileRxBlocksSinceAck++;
      if ((this._fileRxBlocksSinceAck >= this._fileRxBatchAckSize) &&
                  (this._fileRxBuffer.length < this._fileRxFileLen)) {
        this._sendFileRxAck();
      }

      // Debug
      // RaftLog.info(`onFileBlock filePos ${filePos} fileBlockData ${RaftUtils.bufferToHex(fileBlockData)} added to buffer`);

    } else {
      RaftLog.warn(`onFileBlock expected streamID ${this._fileRxStreamID} filePos ${streamFilePos} fileBlockData ${RaftUtils.bufferToHex(fileBlockData)} out of sequence`);
    }
  }

  isFileRxActive(): boolean {
    return this._fileRxActive;
  }
}