/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RafStreamHandler
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftLog from './RaftLog'
import RaftMsgHandler from './RaftMsgHandler';
import RaftCommsStats from './RaftCommsStats';
import { RaftOKFail, RaftStreamStartResp, RaftStreamType, RaftStreamDataProgressCBType } from './RaftTypes';
import RaftConnector from './RaftConnector';
import { RaftConnEvent } from './RaftConnEvents';
import { RICRESTElemCode } from './RaftProtocolDefs'
import RaftUtils from './RaftUtils';

export default class RaftStreamHandler {

  // Queue of audio stream requests
  /*
  private _streamAudioQueue: {
    streamContents: Uint8Array;
    audioDuration: number;
  }[] = [];
  */

  // Stream state
  private _streamID: number | null = null;
  DEFAULT_MAX_BLOCK_SIZE = 475;
  private _maxBlockSize: number = this.DEFAULT_MAX_BLOCK_SIZE;

  // Handler of messages
  private _msgHandler: RaftMsgHandler;

  // RaftCommsStats
  private _commsStats: RaftCommsStats;

  // RaftConnector 
  private _raftConnector: RaftConnector;

  // Flow control
  private _soktoReceived = false;
  private _soktoPos = 0;

  private _streamIsStarting = false;
  private _lastStreamStartTime = 0;

  private _isStreaming = false;
  private _isPaused = false;
  private _streamBuffer: Uint8Array<ArrayBuffer> = new Uint8Array();
  private _audioDuration = 0;
  private _audioByteRate = 0;
  private _streamPos = 0;
  private _numBlocksWithoutPause = 15;
  private _legacySoktoMode = false;


  // soundFinishPoint timer
  private soundFinishPoint: NodeJS.Timeout | null = null;

  constructor(msgHandler: RaftMsgHandler, commsStats: RaftCommsStats, raftConnector: RaftConnector) {
    this._raftConnector = raftConnector;
    this._msgHandler = msgHandler;
    this._commsStats = commsStats;
    this.onSoktoMsg = this.onSoktoMsg.bind(this);
  }

  setNumBlocksWithoutPause(numBlocks: number) {
    this._numBlocksWithoutPause = numBlocks;
  }

  setLegacySoktoMode(legacyMode: boolean) {
    RaftLog.debug(`Setting legacy sokto mode to ${legacyMode}`);
    this._legacySoktoMode = legacyMode;
  }

  /**
   * streamData - stream arbitrary data to a named firmware endpoint using the RT_STREAM protocol.
   * Returns a promise that resolves when the stream is complete or rejects on failure.
   * @param streamContents data to stream
   * @param fileName logical filename sent in ufStart (used by firmware to detect format, e.g. "pattern.thr")
   * @param targetEndpoint REST API endpoint name registered on the firmware (e.g. "streampattern")
   * @param progressCallback optional callback reporting (bytesSent, totalBytes, progressFraction)
   * @returns Promise<boolean> true if stream completed successfully
   */
  async streamData(
    streamContents: Uint8Array,
    fileName: string,
    targetEndpoint: string,
    progressCallback?: RaftStreamDataProgressCBType,
  ): Promise<boolean> {
    // Reject if another stream is starting
    if (this._streamIsStarting || this._lastStreamStartTime > (Date.now() - 500)) {
      RaftLog.warn(`streamData: unable to start, too soon since last request`);
      return false;
    }

    this._streamIsStarting = true;
    this._lastStreamStartTime = Date.now();
    this._soktoReceived = false;
    this._soktoPos = 0;
    this._streamPos = 0;
    this._streamBuffer = RaftUtils.toArrayBufferView(streamContents);

    // Send ufStart
    const startOk = await this._sendStreamStartMsg(
      fileName, targetEndpoint, RaftStreamType.REAL_TIME_STREAM, streamContents,
    );
    this._streamIsStarting = false;

    if (!startOk) {
      RaftLog.warn(`streamData: ufStart failed`);
      return false;
    }

    // Send blocks
    if (this._streamID === null) {
      return false;
    }

    let pos = 0;
    while (pos < this._streamBuffer.length) {
      // Respect SOKTO feedback — if firmware reported a position mismatch, rewind
      if (this._soktoReceived) {
        RaftLog.verbose(`streamData: sokto received, pos was ${pos}, soktoPos ${this._soktoPos}`);
        this._soktoReceived = false;
        // Slow down on backpressure
        await new Promise(r => setTimeout(r, 50));
      }

      const blockSize = Math.min(this._streamBuffer.length - pos, this._maxBlockSize);
      const block = this._streamBuffer.slice(pos, pos + blockSize);
      if (block.length > 0) {
        const sentOk = await this._msgHandler.sendStreamBlock(block, pos, this._streamID);
        this._commsStats.recordStreamBytes(block.length);
        if (!sentOk) {
          RaftLog.warn(`streamData: sendStreamBlock failed at pos ${pos}`);
          return false;
        }
        pos += blockSize;
        this._streamPos = pos;

        // Progress callback
        if (progressCallback) {
          const progress = this._streamBuffer.length > 0 ? pos / this._streamBuffer.length : 1;
          progressCallback(pos, this._streamBuffer.length, progress);
        }
      }

      // Yield to avoid hogging the event loop
      await new Promise(r => setTimeout(r, 1));
    }

    // Send ufEnd
    const endOk = await this._sendStreamEndMsg(this._streamID);
    RaftLog.debug(`streamData: complete, endOk=${endOk}`);
    return endOk;
  }

  // Start streaming audio
  streamAudio(streamContents: Uint8Array, clearExisting: boolean, audioDuration: number): void {
    if (!clearExisting)
      RaftLog.debug(`only clearExisting = true is supported right now.`);

    // TODO - if clearExisting is not set, form a queue
    if (this._streamIsStarting || this._lastStreamStartTime > (Date.now() - 500)) {
      RaftLog.warn(`Unable to start sound, too soon since last request`);
      return;
    }

    this._isPaused = true;
    this._streamIsStarting = true;
    this._lastStreamStartTime = Date.now();

    this._soktoReceived = false;
    this._soktoPos = 0;
    this._streamPos = 0;
    this._streamBuffer = RaftUtils.toArrayBufferView(streamContents);
    this._audioDuration = audioDuration;
    this._audioByteRate = (streamContents.length / audioDuration) * 1000;

    this.clearFinishPointTimeout();

    this._sendStreamStartMsg("audio.mp3", "streamaudio", RaftStreamType.REAL_TIME_STREAM, streamContents).then(
      (result: boolean) => {
        this._isPaused = false;
        this._streamIsStarting = false;
        if (!result) {
          RaftLog.warn(`Unable to start stream. ufStart message send failed`);
          return;
        }
        //this.streamingPerformanceChecker();
        if (!this._isStreaming) {
          this._isStreaming = true;
          this._sendStreamBuffer();
        }

      }
    );
  }

  async streamCancel(): Promise<void> {
    this._streamBuffer = new Uint8Array();
    this.clearFinishPointTimeout();
  }

  public isStreamStarting() {
    return this._streamIsStarting;
  }


  clearFinishPointTimeout() {
    if (this.soundFinishPoint) {
      clearTimeout(this.soundFinishPoint);
      this.soundFinishPoint = null;
    }
  }

  streamingPerformanceChecker() {
    if (this._audioDuration) {
      this.clearFinishPointTimeout();
      this.soundFinishPoint = setTimeout(() => {
        // if the streaming hasn't finished before the end of the audio
        // we can assume we are having streaming issues

        // publish event in case we are having issues
        this._raftConnector.onConnEvent(RaftConnEvent.CONN_STREAMING_ISSUE);

        this.clearFinishPointTimeout();
      }, this._audioDuration + 500);
    }
  }

  // Send the start message
  private async _sendStreamStartMsg(
    streamName: string,
    targetEndpoint: string,
    streamTypeEnum: RaftStreamType,
    streamContents: Uint8Array,
  ): Promise<boolean> {
    // Stream start command message
    const streamType = 'rtstream';
    const cmdMsg = `{"cmdName":"ufStart","reqStr":"ufStart","fileType":"${streamType}","fileName":"${streamName}","endpoint":"${targetEndpoint}","fileLen":${streamContents.length}}`;

    // Debug
    RaftLog.debug(`sendStreamStartMsg ${cmdMsg}`);

    // Send
    let streamStartResp = null;
    try {
      streamStartResp = await this._msgHandler.sendRICREST<RaftStreamStartResp>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      );
    } catch (err) {
      RaftLog.warn(`sendStreamStartMsg error ${err}`);
      return false;
    }

    // Extract params
    if (streamStartResp && (streamStartResp.rslt === 'ok')) {
      this._streamID = streamStartResp.streamID;
      this._maxBlockSize = streamStartResp.maxBlockSize || this.DEFAULT_MAX_BLOCK_SIZE;
      this.streamingPerformanceChecker();
      RaftLog.verbose(
        `sendStreamStartMsg streamID ${this._streamID} maxBlockSize ${this._maxBlockSize} streamType ${streamTypeEnum}`,
      );
    } else {
      RaftLog.warn(`sendStreamStartMsg failed ${streamStartResp ? streamStartResp.rslt : 'no response'}`);
      return false;
    }
    return true;
  }

  get maxBlockSize() {
    return this._maxBlockSize;
  }

  set maxBlockSize(maxBlockSize: number) {
    this._maxBlockSize = maxBlockSize;
    this.DEFAULT_MAX_BLOCK_SIZE = maxBlockSize;
  }

  private async _sendStreamEndMsg(
    streamID: number | null,
  ): Promise<boolean> {
    if (streamID === null) {
      return false;
    }
    // Stram end command message
    const cmdMsg = `{"cmdName":"ufEnd","reqStr":"ufEnd","streamID":${streamID}}`;

    // Debug
    RaftLog.debug(`sendStreamEndMsg ${cmdMsg}`);

    // Send
    let streamEndResp = null;
    try {
      streamEndResp = await this._msgHandler.sendRICREST<RaftOKFail>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      );
    } catch (err) {
      RaftLog.warn(`sendStreamEndMsg error ${err}`);
      return false;
    }
    return streamEndResp.rslt === 'ok';
  }

  /*
    private async _sendAudioStopMsg(): Promise<RaftOKFail> {
      const cmdMsg = `{"cmdName":"audio/stop"}`;
  
      // Debug
      RaftLog.debug(`sendAudioStopMsg ${cmdMsg}`);
  
      // Send
      return this._msgHandler.sendRICREST<RaftOKFail>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      );
    }
  
  
    private async _sendStreamCancelMsg(): Promise<RaftOKFail> {
      // File cancel command message
      const cmdMsg = `{"cmdName":"ufCancel","reqStr":"ufCancel","streamID":${this._streamID}}`;
  
      // Debug
      RaftLog.debug(`sendStreamCancelMsg ${cmdMsg}`);
  
      // Send
      return this._msgHandler.sendRICREST<RaftOKFail>(
        cmdMsg,
        RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      );
    }
  */

  private async _sendStreamBuffer(): Promise<boolean> {
    const streamStartTime = Date.now();

    // Check streamID is valid
    if (this._streamID === null) {
      return false;
    }

    let blockNum = 0;
    // Send stream blocks
    while (this._soktoPos < this._streamBuffer.length || this._isPaused) {
      if (this._isPaused) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }

      // Check for new sokto
      if (this._soktoReceived) {
        if (this._legacySoktoMode)
          this._streamPos = this._soktoPos;
        // apart from when in legacy mode, the sokto message is now informational only, 
        // to allow the central to slow down sending of data if it is swamping the peripheral
        RaftLog.verbose(`sendStreamContents ${Date.now() - streamStartTime}ms soktoReceived for ${this._streamPos}`);
        this._soktoReceived = false;

        // receiving an sokto message before the completion of the stream means that the streaming is not keeping up
        this._raftConnector.onConnEvent(RaftConnEvent.CONN_STREAMING_ISSUE);
      }

      // Send stream block
      const blockSize = Math.min(this._streamBuffer.length - this._streamPos, this._maxBlockSize);
      const block = this._streamBuffer.slice(this._streamPos, this._streamPos + blockSize);
      if (block.length > 0) {
        const sentOk = await this._msgHandler.sendStreamBlock(block, this._streamPos, this._streamID);
        this._commsStats.recordStreamBytes(block.length);

        RaftLog.verbose(
          `sendStreamContents ${sentOk ? "OK" : "FAILED"} ${Date.now() - streamStartTime}ms pos ${this._streamPos} ${blockSize} ${block.length} ${this._soktoPos}`,
        );
        if (!sentOk) {
          return false;
        }
        this._streamPos += blockSize;
        blockNum += 1;

        if (this._audioByteRate && blockNum > this._numBlocksWithoutPause) {
          const pauseTime = ((blockSize / this._audioByteRate) * 1000) - 10;
          RaftLog.verbose(`Pausing for ${pauseTime} ms between audio packets. Bit rate ${this._audioByteRate * 8}`)
          await new Promise((resolve) => setTimeout(resolve, pauseTime));
        }
      }

      // Wait to ensure we don't hog the CPU
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    this._isStreaming = false;
    this.clearFinishPointTimeout();
    await this._sendStreamEndMsg(this._streamID);

    return true;
  }

  onSoktoMsg(soktoPos: number) {
    // Get how far we've progressed in file
    this._soktoPos = soktoPos;
    this._soktoReceived = true;
    RaftLog.debug(`onSoktoMsg received file up to ${this._soktoPos}`);
  }
}
