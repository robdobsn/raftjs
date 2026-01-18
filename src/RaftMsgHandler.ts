/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftMsgHandler
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftCommsStats from './RaftCommsStats';
import { RaftMsgTrackInfo } from './RaftMsgTrackInfo';
import RaftLog from './RaftLog';
import RaftUtils from './RaftUtils';
import {
  RICSERIAL_MSG_NUM_POS,
  RICSERIAL_PAYLOAD_POS,
  RICSERIAL_PROTOCOL_POS,
  RICREST_REST_ELEM_CODE_POS,
  RICREST_HEADER_PAYLOAD_POS,
  RICREST_FILEBLOCK_FILEPOS_POS,
  RICREST_FILEBLOCK_PAYLOAD_POS,
  RICREST_BRIDGE_PAYLOAD_POS,
  RICREST_BRIDGE_ID_POS,
  RICRESTElemCode,
  RaftCommsMsgProtocol,
  RaftCommsMsgTypeCode,
} from './RaftProtocolDefs';
import RaftMiniHDLC from './RaftMiniHDLC';
import { RaftBridgeSetupResp, RaftReportMsg } from './RaftTypes';

// Message results
export enum RaftMsgResultCode {
  MESSAGE_RESULT_TIMEOUT,
  MESSAGE_RESULT_OK,
  MESSAGE_RESULT_FAIL,
  MESSAGE_RESULT_UNKNOWN,
}

export interface RaftMessageResult {
  onRxReply(
    msgHandle: number,
    msgRsltCode: RaftMsgResultCode,
    msgRsltJsonObj: object | null,
  ): void;
  onRxUnnumberedMsg(msgRsltJsonObj: object): void;
  onRxFileBlock(
    filePos: number,
    fileBlockData: Uint8Array
  ): void;
  onRxOtherMsgType(payload: Uint8Array, frameTimeMs: number): void;
}

export interface RaftMessageSender {
  sendTxMsg(
    msg: Uint8Array,
    sendWithResponse: boolean,
  ): Promise<boolean>;
  sendTxMsgNoAwait(
    msg: Uint8Array,
    sendWithResponse: boolean,
  ): Promise<boolean>;
  sendTxMsgRaw(msg: string): boolean;
  sendTxMsgRawAndWaitForReply<T>(msgPayload: Uint8Array): T;
}

export default class RaftMsgHandler {
  // Message numbering and tracking
  private _currentMsgNumber = 1;
  private _currentMsgHandle = 1;
  private _msgTrackInfos: Array<RaftMsgTrackInfo> = new Array<RaftMsgTrackInfo>(
    RaftMsgTrackInfo.MAX_MSG_NUM + 1,
  );
  private _msgTrackTimerMs = 50;
  private _msgTrackLastCheckIdx = 0;

  // report message callback dictionary. Add a callback to subscribe to report messages
  private _reportMsgCallbacks = new Map<string, (report: RaftReportMsg) => Promise<void>>();

  // Interface to inform of message results
  private _msgResultHandler: RaftMessageResult | null = null;

  // Interface to send messages
  private _msgSender: RaftMessageSender | null = null;

  // Comms stats
  private _commsStats: RaftCommsStats;

  // RaftMiniHDLC - handles part of RICSerial protocol
  private _miniHDLC: RaftMiniHDLC;

  // Raw message mode
  private _rawMsgMode = false;

  // Constructor
  constructor(commsStats: RaftCommsStats) {
    this._commsStats = commsStats;
    RaftLog.debug('RaftMsgHandler constructor');

    // Message tracking
    for (let i = 0; i < this._msgTrackInfos.length; i++) {
      this._msgTrackInfos[i] = new RaftMsgTrackInfo();
    }

    // Timer for checking messages
    setTimeout(async () => {
      this._onMsgTrackTimer(true);
    }, this._msgTrackTimerMs);

    // HDLC used to encode/decode the RICREST protocol
    this._miniHDLC = new RaftMiniHDLC();
    this._miniHDLC.setOnRxFrame(this._onHDLCFrameDecode.bind(this));
  }

  registerForResults(msgResultHandler: RaftMessageResult) {
    this._msgResultHandler = msgResultHandler;
  }

  registerMsgSender(RaftMessageSender: RaftMessageSender) {
    this._msgSender = RaftMessageSender;
  }

  handleNewRxMsg(rxMsg: Uint8Array): void {
    this._miniHDLC.addRxBytes(rxMsg);
    // RaftLog.verbose(`handleNewRxMsg len ${rxMsg.length} ${RaftUtils.bufferToHex(rxMsg)}`)
  }

  // This is currently only for testing and simulated channels
  handleNewRxMsgRaw(rxMsg: Uint8Array, rxMsgType: RaftCommsMsgTypeCode, rxMsgNum: number, rxMsgTimeMs: number): void {
    // Check message types
    if (rxMsgType == RaftCommsMsgTypeCode.MSG_TYPE_RESPONSE) {
      // Convert raw Uint8Array to string assuming UTF-8
      const restStr = new TextDecoder('utf-8').decode(rxMsg);
      this._handleResponseMessages(restStr, rxMsgNum);
    } else if (rxMsgType == RaftCommsMsgTypeCode.MSG_TYPE_REPORT) {
      // Convert raw Uint8Array to string assuming UTF-8
      const restStr = new TextDecoder('utf-8').decode(rxMsg);
      this._handleReportMessages(restStr);
    } else {
      this._msgResultHandler?.onRxOtherMsgType(rxMsg, rxMsgTimeMs);
    }
  }

  reportMsgCallbacksSet(callbackName: string, callback: (report: RaftReportMsg) => Promise<void>): void {
    this._reportMsgCallbacks.set(callbackName, callback);
  }

  reportMsgCallbacksDelete(callbackName: string) {
    this._reportMsgCallbacks.delete(callbackName);
  }

  setRawMsgMode(isRawMode: boolean): void {
    this._rawMsgMode = isRawMode;
    RaftLog.debug(`setRawMsgMode ${isRawMode}`);
  }

  _onHDLCFrameDecode(rxMsg: Uint8Array, frameTimeMs: number): void {
    // Add to stats
    this._commsStats.msgRx();

    // Validity
    if (rxMsg.length < RICSERIAL_PAYLOAD_POS) {
      this._commsStats.msgTooShort();
      return;
    }

    // RaftLog.verbose(`_onHDLCFrameDecode len ${rxMsg.length}`);

    // Decode the RICFrame header
    let rxMsgNum = rxMsg[RICSERIAL_MSG_NUM_POS] & 0xff;
    let rxProtocol = rxMsg[RICSERIAL_PROTOCOL_POS] & 0x3f;
    let rxMsgType = (rxMsg[RICSERIAL_PROTOCOL_POS] >> 6) & 0x03;

    // Check for RICREST bridging protocol
    if (rxProtocol == RaftCommsMsgProtocol.MSG_PROTOCOL_BRIDGE_RICREST) {

      // Debug
      const bridgeID = rxMsg.length > RICREST_BRIDGE_ID_POS ? rxMsg[RICREST_BRIDGE_ID_POS] : 0;
      RaftLog.info(
        `_onHDLCFrameDecode RICREST bridge rx bridgeID ${bridgeID} len ${rxMsg.length}`
      );

      // Simply remove the wrapper
      rxMsg = rxMsg.slice(RICREST_BRIDGE_PAYLOAD_POS);

      // Get the message info from the unwrapped message
      rxMsgNum = rxMsg[RICSERIAL_MSG_NUM_POS] & 0xff;
      rxProtocol = rxMsg[RICSERIAL_PROTOCOL_POS] & 0x3f;
      rxMsgType = (rxMsg[RICSERIAL_PROTOCOL_POS] >> 6) & 0x03;
    }

    // Check for RICREST protocol
    if (rxProtocol == RaftCommsMsgProtocol.MSG_PROTOCOL_RICREST) {
      RaftLog.verbose(
        `_onHDLCFrameDecode RICREST rx msgNum ${rxMsgNum} msgDirn ${rxMsgType} ${RaftUtils.bufferToHex(
          rxMsg,
        )}`,
      );
      // Extract payload
      const ricRestElemCode =
        rxMsg[RICSERIAL_PAYLOAD_POS + RICREST_REST_ELEM_CODE_POS] & 0xff;
      if (
        ricRestElemCode == RICRESTElemCode.RICREST_ELEM_CODE_URL ||
        ricRestElemCode == RICRESTElemCode.RICREST_ELEM_CODE_CMDRESPJSON ||
        ricRestElemCode == RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME
      ) {
        // These are all text-based messages
        const restStr = RaftUtils.getStringFromBuffer(
          rxMsg,
          RICSERIAL_PAYLOAD_POS + RICREST_HEADER_PAYLOAD_POS,
          rxMsg.length - RICSERIAL_PAYLOAD_POS - RICREST_HEADER_PAYLOAD_POS - 1,
        );
        RaftLog.verbose(
          `_onHDLCFrameDecode RICREST rx elemCode ${ricRestElemCode} ${restStr}`,
        );

        // Check message types
        if (rxMsgType == RaftCommsMsgTypeCode.MSG_TYPE_RESPONSE) {

          // Handle response messages
          this._handleResponseMessages(restStr, rxMsgNum);

        } else if (rxMsgType == RaftCommsMsgTypeCode.MSG_TYPE_REPORT) {

          // Handle report messages
          this._handleReportMessages(restStr);

        }

      } else {
        const binMsgLen = rxMsg.length - RICSERIAL_PAYLOAD_POS - RICREST_HEADER_PAYLOAD_POS;
        RaftLog.verbose(
          `_onHDLCFrameDecode RICREST rx binary message elemCode ${ricRestElemCode} len ${binMsgLen} data ${RaftUtils.bufferToHex(rxMsg)}`,
        );
        if (ricRestElemCode == RICRESTElemCode.RICREST_ELEM_CODE_FILEBLOCK) {
          const filePos = RaftUtils.getBEUint32FromBuf(rxMsg, RICSERIAL_PAYLOAD_POS + RICREST_HEADER_PAYLOAD_POS + RICREST_FILEBLOCK_FILEPOS_POS);
          this._msgResultHandler?.onRxFileBlock(
            filePos,
            rxMsg.slice(RICSERIAL_PAYLOAD_POS + RICREST_HEADER_PAYLOAD_POS + RICREST_FILEBLOCK_PAYLOAD_POS, rxMsg.length));
        }
      }

      // Other message types
    } else {
      this._msgResultHandler?.onRxOtherMsgType(rxMsg, frameTimeMs);
    }
  }

  _handleResponseMessages(restStr: string, rxMsgNum: number): void {
    try {
      let msgRsltCode = RaftMsgResultCode.MESSAGE_RESULT_UNKNOWN;
      const msgRsltJsonObj = JSON.parse(restStr);
      if ('rslt' in msgRsltJsonObj) {
        const rsltStr = msgRsltJsonObj.rslt.toLowerCase();
        if (rsltStr === 'ok') {
          RaftLog.verbose(
            `_handleResponseMessages RICREST rslt Ok ${rxMsgNum == 0 ? "unnumbered" : "msgNum " + rxMsgNum.toString()} resp ${msgRsltJsonObj.rslt}`,
          );
          msgRsltCode = RaftMsgResultCode.MESSAGE_RESULT_OK;
        } else if (rsltStr === 'fail') {
          msgRsltCode = RaftMsgResultCode.MESSAGE_RESULT_FAIL;
          RaftLog.warn(
            `_handleResponseMessages RICREST rslt fail ${rxMsgNum == 0 ? "unnumbered" : "msgNum " + rxMsgNum.toString()} resp ${restStr}`,
          );
        } else {
          RaftLog.warn(
            `_handleResponseMessages RICREST rslt not recognized ${rxMsgNum == 0 ? "unnumbered" : "msgNum " + rxMsgNum.toString()}resp ${restStr}`,
          );
        }

      } else {
        RaftLog.warn(
          `_handleResponseMessages RICREST response doesn't contain rslt ${rxMsgNum == 0 ? "unnumbered" : "msgNum " + rxMsgNum.toString()}resp ${restStr}`,
        );
      }

      // Handle matching of request and response
      this.msgTrackingRxRespMsg(rxMsgNum, msgRsltCode, msgRsltJsonObj);

    } catch (excp: unknown) {
      if (excp instanceof Error) {
        RaftLog.warn(
          `_handleResponseMessages Failed to parse JSON ${rxMsgNum == 0 ? "unnumbered" : "msgNum " + rxMsgNum.toString()} JSON STR ${restStr} resp ${excp.toString()}`,
        );
      }
    }

  }

  _handleReportMessages(restStr: string): void {
    try {
      const reportMsg: RaftReportMsg = JSON.parse(restStr);
      reportMsg.timeReceived = Date.now();
      RaftLog.debug(`_handleReportMessages ${JSON.stringify(reportMsg)}`);
      this._reportMsgCallbacks.forEach(async (callback) => await callback(reportMsg));
    } catch (excp: unknown) {
      if (excp instanceof Error) {
        RaftLog.warn(
          `_handleReportMessages Failed to parse JSON report ${excp.toString()}`,
        );
      }
    }
  }

  async sendRICRESTURL<T>(
    cmdStr: string,
    bridgeID: number | undefined = undefined,
    msgTimeoutMs: number | undefined = undefined,
  ): Promise<T> {
    // Send
    return this.sendRICREST(
      cmdStr,
      RICRESTElemCode.RICREST_ELEM_CODE_URL,
      bridgeID,
      msgTimeoutMs,
    );
  }

  async sendRICRESTCmdFrame<T>(
    cmdStr: string,
    bridgeID: number | undefined = undefined,
    msgTimeoutMs: number | undefined = undefined,
  ): Promise<T> {
    // Send
    return this.sendRICREST(
      cmdStr,
      RICRESTElemCode.RICREST_ELEM_CODE_COMMAND_FRAME,
      bridgeID,
      msgTimeoutMs,
    );
  }

  async sendRICREST<T>(
    cmdStr: string,
    ricRESTElemCode: RICRESTElemCode,
    bridgeID: number | undefined = undefined,
    msgTimeoutMs: number | undefined = undefined,
  ): Promise<T> {
    // Put cmdStr into buffer
    const cmdStrTerm = new Uint8Array(cmdStr.length + 1);
    RaftUtils.addStringToBuffer(cmdStrTerm, cmdStr, 0);
    cmdStrTerm[cmdStrTerm.length - 1] = 0;

    // Send
    return this.sendRICRESTBytes(
      cmdStrTerm,
      ricRESTElemCode,
      true,
      bridgeID,
      msgTimeoutMs,
    );
  }

  async sendRICRESTNoResp(
    cmdStr: string,
    ricRESTElemCode: RICRESTElemCode,
    bridgeID: number | undefined = undefined,
  ): Promise<boolean> {

    // Check there is a sender
    if (!this._msgSender) {
      return false;
    }

    // Check for raw message mode (used for testing and simulated channels)
    if (this._rawMsgMode) {
      return this._msgSender.sendTxMsgRaw(cmdStr);
    }

    // Put cmdStr into buffer
    const cmdBytes = new Uint8Array(cmdStr.length + 1);
    RaftUtils.addStringToBuffer(cmdBytes, cmdStr, 0);
    cmdBytes[cmdBytes.length - 1] = 0;

    // Form message
    const cmdMsg = new Uint8Array(cmdBytes.length + RICREST_HEADER_PAYLOAD_POS);
    cmdMsg[RICREST_REST_ELEM_CODE_POS] = ricRESTElemCode;
    cmdMsg.set(cmdBytes, RICREST_HEADER_PAYLOAD_POS);

    // Frame the message
    let framedMsg = this.frameCommsMsg(cmdMsg,
      RaftCommsMsgTypeCode.MSG_TYPE_COMMAND,
      RaftCommsMsgProtocol.MSG_PROTOCOL_RICREST,
      true);

    // Wrap if bridged
    if (bridgeID !== undefined) {
      framedMsg = this.bridgeCommsMsg(framedMsg, bridgeID);
    }

    // Encode like HDLC
    const encodedMsg = this._miniHDLC.encode(framedMsg);

    // Send
    if (!await this._msgSender.sendTxMsg(encodedMsg, false)) {
      RaftLog.warn(`sendRICRESTNoResp failed to send message`);
      this._commsStats.recordMsgNoConnection();
    }

    return true;
  }

  async sendRICRESTBytes<T>(
    cmdBytes: Uint8Array,
    ricRESTElemCode: RICRESTElemCode,
    withResponse: boolean,
    bridgeID: number | undefined = undefined,
    msgTimeoutMs: number | undefined = undefined,
  ): Promise<T> {
    // Form message
    const cmdMsg = new Uint8Array(cmdBytes.length + RICREST_HEADER_PAYLOAD_POS);
    cmdMsg[RICREST_REST_ELEM_CODE_POS] = ricRESTElemCode;
    cmdMsg.set(cmdBytes, RICREST_HEADER_PAYLOAD_POS);

    // Send
    return this.sendMsgAndWaitForReply<T>(
      cmdMsg,
      RaftCommsMsgTypeCode.MSG_TYPE_COMMAND,
      RaftCommsMsgProtocol.MSG_PROTOCOL_RICREST,
      withResponse,
      bridgeID,
      msgTimeoutMs,
    );
  }

  async sendMsgAndWaitForReply<T>(
    msgPayload: Uint8Array,
    msgDirection: RaftCommsMsgTypeCode,
    msgProtocol: RaftCommsMsgProtocol,
    withResponse: boolean,
    bridgeID: number | undefined = undefined,
    msgTimeoutMs: number | undefined,
  ): Promise<T> {

    // Check there is a sender
    if (!this._msgSender) {
      throw new Error('sendMsgAndWaitForReply failed no sender');
    }

    // Check for raw message mode (used for testing and simulated channels)
    if (this._rawMsgMode) {
      return this._msgSender.sendTxMsgRawAndWaitForReply(msgPayload);
    }

    // Frame the message
    let framedMsg = this.frameCommsMsg(msgPayload, msgDirection, msgProtocol, true);

    // Wrap if bridged
    if (bridgeID !== undefined) {
      framedMsg = this.bridgeCommsMsg(framedMsg, bridgeID);
      // RaftLog.debug(`sendMsgAndWaitForReply - bridged idx ${bridgeID}`)
    } else {
      // RaftLog.debug(`sendMsgAndWaitForReply - not bridged`)
    }

    // Encode like HDLC
    const encodedMsg = this._miniHDLC.encode(framedMsg);

    // Debug
    // RaftLog.debug(
    //   `sendMsgAndWaitForReply ${RaftUtils.bufferToHex(encodedMsg)}`,
    // );

    // Return a promise that will be resolved when a reply is received or timeout occurs
    const promise = new Promise<T>((resolve, reject) => {

      // Update message tracking
      this.msgTrackingTxCmdMsg<T>(
        encodedMsg,
        withResponse,
        bridgeID,
        msgTimeoutMs,
        resolve,
        reject,
      );
      this._currentMsgHandle++;
    });

    return promise;
  }

  frameCommsMsg(
    msgPayload: Uint8Array,
    msgDirection: RaftCommsMsgTypeCode,
    msgProtocol: RaftCommsMsgProtocol,
    isNumbered: boolean,
  ): Uint8Array {
    // Header
    const msgBuf = new Uint8Array(
      msgPayload.length + RICSERIAL_PAYLOAD_POS,
    );
    msgBuf[RICSERIAL_MSG_NUM_POS] = isNumbered ? this._currentMsgNumber & 0xff : 0;
    msgBuf[RICSERIAL_PROTOCOL_POS] = (msgDirection << 6) + msgProtocol;

    // Payload
    msgBuf.set(msgPayload, RICSERIAL_PAYLOAD_POS);

    // Return framed message
    return msgBuf;
  }

  bridgeCommsMsg(
    msgBuf: Uint8Array,
    bridgeID: number
  ) {
    // 
    const bridgedMsg = new Uint8Array(msgBuf.length + RICREST_BRIDGE_PAYLOAD_POS);

    // Bridged messages are unnumbered (msgNum == 0)
    bridgedMsg[RICSERIAL_MSG_NUM_POS] = 0;
    bridgedMsg[RICSERIAL_PROTOCOL_POS] = (RaftCommsMsgTypeCode.MSG_TYPE_COMMAND << 6) + RaftCommsMsgProtocol.MSG_PROTOCOL_BRIDGE_RICREST;
    bridgedMsg[RICREST_BRIDGE_ID_POS] = bridgeID;
    bridgedMsg.set(msgBuf, RICREST_BRIDGE_PAYLOAD_POS);
    return bridgedMsg;
  }

  msgTrackingTxCmdMsg<T>(
    msgFrame: Uint8Array,
    withResponse: boolean,
    bridgeID: number | undefined = undefined,
    msgTimeoutMs: number | undefined,
    resolve: (arg: T) => void,
    reject: (reason: Error) => void,
  ): void {
    // Record message re-use of number
    if (this._msgTrackInfos[this._currentMsgNumber].msgOutstanding) {
      this._commsStats.recordMsgNumCollision();
    }
    // Set tracking info
    this._msgTrackInfos[this._currentMsgNumber].set(
      true,
      msgFrame,
      withResponse,
      bridgeID,
      this._currentMsgHandle,
      msgTimeoutMs,
      resolve,
      reject,
    );

    // Debug
    RaftLog.debug(
      `msgTrackingTxCmdMsg msgNum ${this._currentMsgNumber} bridgeID ${bridgeID} msg ${RaftUtils.bufferToHex(msgFrame)} msgOutstanding ${this._msgTrackInfos[this._currentMsgNumber].msgOutstanding
      }`,
    );

    // Stats
    this._commsStats.msgTx();

    // Bump msg number
    if (this._currentMsgNumber == RaftMsgTrackInfo.MAX_MSG_NUM) {
      this._currentMsgNumber = 1;
    } else {
      this._currentMsgNumber++;
    }
  }

  msgTrackingRxRespMsg(
    msgNum: number,
    msgRsltCode: RaftMsgResultCode,
    msgRsltJsonObj: object,
  ) {
    // Check message number
    if (msgNum == 0) {
      // Callback on unnumbered message
      if (this._msgResultHandler !== null)
        this._msgResultHandler.onRxUnnumberedMsg(msgRsltJsonObj);
      return;
    }
    if (msgNum > RaftMsgTrackInfo.MAX_MSG_NUM) {
      RaftLog.warn('msgTrackingRxRespMsg msgNum > 255');
      return;
    }
    if (!this._msgTrackInfos[msgNum].msgOutstanding) {
      RaftLog.warn(`msgTrackingRxRespMsg unmatched msgNum ${msgNum}`);
      this._commsStats.recordMsgNumUnmatched();
      return;
    }

    // Handle message
    RaftLog.verbose(
      `msgTrackingRxRespMsg Message response received msgNum ${msgNum}`,
    );
    this._commsStats.recordMsgResp(
      Date.now() - this._msgTrackInfos[msgNum].msgSentMs,
    );
    this._msgCompleted(msgNum, msgRsltCode, msgRsltJsonObj);
  }

  _msgCompleted(
    msgNum: number,
    msgRsltCode: RaftMsgResultCode,
    msgRsltObj: object | null,
  ) {

    // Lookup message in tracking
    const msgHandle = this._msgTrackInfos[msgNum].msgHandle;
    this._msgTrackInfos[msgNum].msgOutstanding = false;

    // Check if message result handler should be informed
    if (this._msgResultHandler !== null) {
      this._msgResultHandler.onRxReply(msgHandle, msgRsltCode, msgRsltObj);
    }

    // Handle reply
    // if (msgRsltCode === RaftMsgResultCode.MESSAGE_RESULT_OK) {
    const resolve = this._msgTrackInfos[msgNum].resolve;
    if (resolve) {
      RaftLog.verbose(`_msgCompleted msgNum ${msgNum} result ${msgRsltCode.toString()} ${JSON.stringify(msgRsltObj)}`);
      (resolve as ((arg: object | null) => void))(msgRsltObj);
    }
    // } else {
    //   const reject = this._msgTrackInfos[msgNum].reject;
    //   if (reject) {
    //     // eslint-disable-next-line @typescript-eslint/no-explicit-any
    //     try {
    //       RaftLog.debug(`_msgCompleted reject rsltCode ${msgRsltCode}`);
    //       // (reject as any)(new Error(`Message failed msgNum ${msgNum} rslt ${msgRsltCode}`));
    //     } catch (excp: unknown) {
    //       RaftLog.warn(`_msgCompleted reject ${excp}`);
    //     }
    //   }
    // }

    // No longer waiting for reply
    this._msgTrackInfos[msgNum].resolve = null;
    this._msgTrackInfos[msgNum].reject = null;
  }

  // Check message timeouts
  async _onMsgTrackTimer(chainRecall: boolean): Promise<void> {

    if (this._msgSender !== null) {
      // Handle message tracking
      for (let loopIdx = 0; loopIdx < this._msgTrackInfos.length; loopIdx++) {

        // Index to check
        const checkIdx = this._msgTrackLastCheckIdx;
        this._msgTrackLastCheckIdx = (checkIdx + 1) % this._msgTrackInfos.length;

        // Check if message is outstanding
        if (!this._msgTrackInfos[checkIdx].msgOutstanding) continue;

        // Get message timeout and ensure valid
        let msgTimeoutMs = this._msgTrackInfos[checkIdx].msgTimeoutMs;
        if (msgTimeoutMs === undefined) {
          msgTimeoutMs = RaftMsgTrackInfo.MSG_RESPONSE_TIMEOUT_MS;
        }

        // Check for timeout (or never sent)
        if ((this._msgTrackInfos[checkIdx].retryCount === 0) || (Date.now() > this._msgTrackInfos[checkIdx].msgSentMs + (msgTimeoutMs * (this._msgTrackInfos[checkIdx].retryCount)))) {

          // Debug
          RaftLog.verbose(`msgTrackTimer msgNum ${checkIdx} ${this._msgTrackInfos[checkIdx].retryCount === 0 ? 'first send' : 'timeout - retrying'} ${RaftUtils.bufferToHex(this._msgTrackInfos[checkIdx].msgFrame)}`);
          // RaftLog.verbose(`msgTrackTimer msg ${RaftUtils.bufferToHex(this._msgTrackInfos[i].msgFrame)}`);

          // Handle timeout (or first send)
          if (this._msgTrackInfos[checkIdx].retryCount < RaftMsgTrackInfo.MSG_RETRY_COUNT) {
            this._msgTrackInfos[checkIdx].retryCount++;
            try {

              // Send the message
              if (!await this._msgSender.sendTxMsg(
                this._msgTrackInfos[checkIdx].msgFrame,
                this._msgTrackInfos[checkIdx].withResponse)) {
                RaftLog.warn(`msgTrackTimer Message send failed msgNum ${checkIdx} ${RaftUtils.bufferToHex(this._msgTrackInfos[checkIdx].msgFrame)}`);
                this._msgCompleted(checkIdx, RaftMsgResultCode.MESSAGE_RESULT_FAIL, null);
                this._commsStats.recordMsgNoConnection();
              }

              // Message sent ok so break here
              break;

            } catch (error: unknown) {
              RaftLog.warn(`Retry message failed ${error}`);
            }
            this._commsStats.recordMsgRetry();
            this._msgTrackInfos[checkIdx].msgSentMs = Date.now();
          } else {
            RaftLog.warn(
              `msgTrackTimer TIMEOUT msgNum ${checkIdx} after ${RaftMsgTrackInfo.MSG_RETRY_COUNT} retries ${RaftUtils.bufferToHex(this._msgTrackInfos[checkIdx].msgFrame)}`,
            );
            this._msgCompleted(checkIdx, RaftMsgResultCode.MESSAGE_RESULT_TIMEOUT, null);
            this._commsStats.recordMsgTimeout();
          }
        }
      }
    }

    // Call again if required
    if (chainRecall) {
      setTimeout(async () => {
        this._onMsgTrackTimer(true);
      }, this._msgTrackTimerMs);
    }
  }

  encodeFileStreamBlock(blockContents: Uint8Array,
    blockStart: number,
    streamID: number): Uint8Array {
    // Create entire message buffer (including protocol wrappers)
    const msgBuf = new Uint8Array(
      blockContents.length + 4 + RICREST_HEADER_PAYLOAD_POS + RICSERIAL_PAYLOAD_POS,
    );
    let msgBufPos = 0;

    // RICSERIAL protocol
    msgBuf[msgBufPos++] = 0; // not numbered
    msgBuf[msgBufPos++] =
      (RaftCommsMsgTypeCode.MSG_TYPE_COMMAND << 6) +
      RaftCommsMsgProtocol.MSG_PROTOCOL_RICREST;

    // RICREST protocol
    msgBuf[msgBufPos++] = RICRESTElemCode.RICREST_ELEM_CODE_FILEBLOCK;

    // Header
    msgBuf[msgBufPos++] = streamID & 0xff;
    msgBuf[msgBufPos++] = (blockStart >> 16) & 0xff;
    msgBuf[msgBufPos++] = (blockStart >> 8) & 0xff;
    msgBuf[msgBufPos++] = blockStart & 0xff;

    // Copy block info
    msgBuf.set(blockContents, msgBufPos);
    return msgBuf;
  }

  async sendFileBlock(
    blockContents: Uint8Array,
    blockStart: number
  ): Promise<boolean> {
    const msgBuf = this.encodeFileStreamBlock(blockContents, blockStart, 0);

    // // Debug
    // RaftLog.debug(
    //   `sendFileBlock frameLen ${msgBuf.length} start ${blockStart} end ${blockEnd} len ${blockLen}`,
    // );

    // Send
    try {
      // Send
      if (this._msgSender) {

        // Wrap into HDLC
        const framedMsg = this._miniHDLC.encode(msgBuf);

        // Send
        return this._msgSender.sendTxMsg(
          framedMsg,
          true,
          // Platform.OS === 'ios',
        );
      }
    } catch (error: unknown) {
      RaftLog.warn(`RaftMsgHandler sendFileBlock error${error}`);
    }
    return false;
  }

  async sendStreamBlock(
    blockContents: Uint8Array,
    blockStart: number,
    streamID: number,
  ): Promise<boolean> {

    // Ensure any waiting messages are sent first
    await this._onMsgTrackTimer(false);

    // Encode message
    const msgBuf = this.encodeFileStreamBlock(blockContents, blockStart, streamID);

    // // Debug
    // RaftLog.debug(
    //   `sendStreamBlock frameLen ${msgBuf.length} start ${blockStart} end ${blockEnd} len ${blockLen}`,
    // );

    // Send
    try {
      // Send
      if (this._msgSender) {

        // Wrap into HDLC
        const framedMsg = this._miniHDLC.encode(msgBuf);

        // Send
        return await this._msgSender.sendTxMsg(
          framedMsg,
          true,
          // Platform.OS === 'ios',
        );
      }
    } catch (error: unknown) {
      RaftLog.warn(`RaftMsgHandler sendStreamBlock error${error}`);
    }
    return false;
  }

  async createCommsBridge(bridgeSource: string, bridgeName: string, idleCloseSecs = 0): Promise<RaftBridgeSetupResp> {

    // Establish a bridge
    return await this.sendRICRESTURL<RaftBridgeSetupResp>(
      `commandserial/bridge/setup?port=${bridgeSource}&name=${bridgeName}&idleCloseSecs=${idleCloseSecs}`,
    )
  }

  async removeCommsBridge(bridgeID: number): Promise<boolean> {

    // Remove a bridge
    return await this.sendRICRESTURL<boolean>(
      `commandserial/bridge/remove?id=${bridgeID}`,
    )
  }
}
