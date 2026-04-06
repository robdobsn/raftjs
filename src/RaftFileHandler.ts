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
  private _fileRxLastAckPos = 0;
  private OVERALL_FILE_TRANSFER_TIMEOUT_MS = 100000;
  private FILE_RX_ACK_RESEND_TIMEOUT_MS = 1000;

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
    if (fileStartResp.rslt !== 'ok') {
      RaftLog.warn(`sendFileStartMsg error ${fileStartResp.rslt}`);
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
    RaftLog.debug(
      `_fileSendStartMsg fileBlockSize req ${this._requestedFileBlockSize} resp ${fileStartResp.batchMsgSize} actual ${this._fileBlockSize}`,
    );
    RaftLog.debug(
      `_fileSendStartMsg batchAckSize req ${this._requestedBatchAckSize} resp ${fileStartResp.batchAckSize} actual ${this._batchAckSize}`,
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
    const cmdMsg = `{"cmdName":"ufEnd","reqStr":"${reqStr}","fileType":"${fileDest}","fileName":"${fileName}","fileLen":${fileLen}}`;

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
    return fileEndResp.rslt === 'ok';
  }

  async _sendFileCancelMsg(): Promise<void> {
    // File cancel command message
    const cmdMsg = `{"cmdName":"ufCancel"}`;

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
        let sendFromPos = this._ackedFilePos;
        const batchSize = sendFromPos == 0 ? 1 : this._batchAckSize;
        for (
          let i = 0;
          i < batchSize && sendFromPos < fileContents.length;
          i++
        ) {
          // Clear old batch acks
          if (i == batchSize - 1) {
            this._batchAckReceived = false;
          }
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
    const promRslt = this._msgHandler.sendFileBlock(fileContents.subarray(blockStart, blockEnd), blockStart);
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
      if (cmdResp.rslt != "ok") {
        RaftLog.warn(`fileReceive - failed to setup bridge ${cmdResp.rslt}`);
        return new RaftFileDownloadResult();
      }
      bridgeID = cmdResp.bridgeID;

      // Debug
      RaftLog.info(`fileReceive - bridge setup ${bridgeID}`);
    }

    // Send file start message
    if (!await this._receiveFileStart(fileName, bridgeID))
      return new RaftFileDownloadResult();

    // Send contents
    const fileContents = await this._receiveFileContents(progressCallback, bridgeID);

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

  async _receiveFileStart(fileName: string, bridgeID: number | undefined) : Promise<boolean> {

    const blockMaxSizeRequested = 5000;
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
    if (cmdResp.rslt === 'ok') {
      this._fileRxBatchMsgSize = cmdResp.batchMsgSize;
      this._fileRxBatchAckSize = cmdResp.batchAckSize;
      this._fileRxStreamID = cmdResp.streamID;
      this._fileRxFileLen = cmdResp.fileLen;
      // CRC may be provided at start (old firmware) or deferred to dfEnd (new firmware)
      this._fileRxCrc16 = cmdResp.crc16 ? parseInt(cmdResp.crc16, 16) : -1;
      this._fileRxBuffer = new Uint8Array(0);
      this._fileRxLastAckTime = 0;
      this._fileRxLastAckPos = 0;
      this._fileRxLastBlockTime = Date.now();
      this._fileRxActive = true;
    }
    return cmdResp.rslt === 'ok';
  }

  async _receiveFileContents(
        progressCallback: RaftProgressCBType | undefined,
        bridgeID: number | undefined
  ): Promise<RaftFileDownloadResult> {

    // Calculate dynamic timeouts based on file size and connection speed
    // Use batch message size as proxy for connection type:
    //   BLE ~500 byte blocks ~5 KB/s, WebSocket ~5000 byte blocks ~50 KB/s
    const estimatedBytesPerSec = this._fileRxBatchMsgSize <= 500 ? 5000 : 50000;
    const BASE_TIMEOUT_MS = 30000;
    const SAFETY_FACTOR = 2;
    const transferTimeMs = (this._fileRxFileLen / estimatedBytesPerSec) * 1000 * SAFETY_FACTOR;
    const overallTimeoutMs = BASE_TIMEOUT_MS + transferTimeMs;
    const blockTimeoutMs = this.BLOCK_ACK_TIMEOUT_MS;
    RaftLog.info(`_receiveFileContents - fileLen ${this._fileRxFileLen} batchMsgSize ${this._fileRxBatchMsgSize} ` +
        `estimatedBytesPerSec ${estimatedBytesPerSec} overallTimeoutMs ${overallTimeoutMs} blockTimeoutMs ${blockTimeoutMs}`);

    // Wait for file to be received
    return new Promise<RaftFileDownloadResult>((resolve, reject) => {
      const startTime = Date.now();
      const checkForComplete = async () => {

        // Check if we've received the whole file
        if (this._fileRxFileLen === this._fileRxBuffer.length) {
          this._fileRxActive = false;
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

        // Check for timeouts
        const now = Date.now();

        // Check for overall timeouts
        if ((now - startTime > overallTimeoutMs) || 
            (now - this._fileRxLastBlockTime > blockTimeoutMs)) {
          RaftLog.warn(`_receiveFileContents - time-out no new data received ` +
              `elapsed ${now - startTime}ms overallTimeout ${overallTimeoutMs}ms ` +
              `blockGap ${now - this._fileRxLastBlockTime}ms blockTimeout ${blockTimeoutMs}ms`);
          this._fileRxActive = false;
          reject(new Error('fileReceive failed'));
          return;
        }

        // Check if time to send ack
        let ackRequired = false;
        if (Date.now() - this._fileRxLastAckTime > this.FILE_RX_ACK_RESEND_TIMEOUT_MS) {
          ackRequired = true;
        }

        // Check if position to send ack
        if (this._fileRxBuffer.length - this._fileRxLastAckPos >= this._fileRxBatchAckSize * this._fileRxBatchMsgSize) {
          ackRequired = true;
        }
        // RaftLog.info(`_receiveFileContents ${ackRequired ? "ACK_REQUIRED" : "ACK_NOTREQUIRED"}  ${this._fileRxBuffer.length} ${this._fileRxLastAckPos} ${this._fileRxBatchAckSize} ${this._fileRxBatchMsgSize}`); 

        // Check if ack required
        if (ackRequired) {

          // Ack timing
          this._fileRxLastAckTime = Date.now();
          this._fileRxLastAckPos = this._fileRxBuffer.length;
    
          // Okto message
          const cmdMsg = `{"cmdName":"dfAck","okto":${this._fileRxBuffer.length},` +
                        `"streamID":${this._fileRxStreamID},"rslt":"ok"}`;

          // Send without waiting for response
          this._msgHandler.sendRICRESTNoResp(
            cmdMsg,
            RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
            bridgeID
          );

          // Debug
          RaftLog.verbose(`_receiveFileContents ack generated at ${this._fileRxBuffer.length} msg ${cmdMsg}`);
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

    // Check if this is the next block we are expecting
    if (filePos === this._fileRxBuffer.length) {

      // Add to buffer
      const tmpArray = new Uint8Array(this._fileRxBuffer.length + fileBlockData.length);
      tmpArray.set(this._fileRxBuffer, 0);
      tmpArray.set(fileBlockData, this._fileRxBuffer.length);
      this._fileRxBuffer = tmpArray;

      // Update last block time
      this._fileRxLastBlockTime = Date.now();

      // Debug
      // RaftLog.info(`onFileBlock filePos ${filePos} fileBlockData ${RaftUtils.bufferToHex(fileBlockData)} added to buffer`);

    } else {
      RaftLog.warn(`onFileBlock expected streamID ${this._fileRxStreamID} filePos ${filePos} fileBlockData ${RaftUtils.bufferToHex(fileBlockData)} out of sequence`);
    }
  }

  isFileRxActive(): boolean {
    return this._fileRxActive;
  }
}