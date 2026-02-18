/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftConnector
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import RaftChannel from "./RaftChannel";
import RaftMsgHandler, { RaftMsgResultCode } from "./RaftMsgHandler";
import RaftChannelWebSocket from "./RaftChannelWebSocket";
import RaftChannelWebSerial from "./RaftChannelWebSerial";
import RaftChannelSimulated from "./RaftChannelSimulated";
import RaftCommsStats from "./RaftCommsStats";
import { RaftEventFn, RaftOKFail, RaftFileSendType, RaftFileDownloadResult, RaftProgressCBType, RaftStreamDataProgressCBType, RaftBridgeSetupResp, RaftFileDownloadFn, RaftReportMsg } from "./RaftTypes";
import RaftSystemUtils from "./RaftSystemUtils";
import RaftFileHandler from "./RaftFileHandler";
import RaftStreamHandler from "./RaftStreamHandler";
import RaftLog from "./RaftLog";
import { RaftConnEvent, RaftConnEventNames } from "./RaftConnEvents";
import { RaftGetSystemTypeCBType, RaftSystemType } from "./RaftSystemType";
import { RaftUpdateEvent, RaftUpdateEventNames } from "./RaftUpdateEvents";
import RaftUpdateManager from "./RaftUpdateManager";
import { createBLEChannel } from "./RaftChannelBLEFactory";


export default class RaftConnector {

  // Get system type callback
  private _getSystemTypeCB: RaftGetSystemTypeCBType | null = null;

  // System type
  private _systemType: RaftSystemType | null = null;

  // Channel
  private _raftChannel: RaftChannel | null = null;

  // Channel connection method and locator
  private _channelConnMethod = "";
  private _channelConnLocator: string | object = "";

  // Comms stats
  private _commsStats: RaftCommsStats = new RaftCommsStats();

  // Message handler
  private _raftMsgHandler: RaftMsgHandler = new RaftMsgHandler(
    this._commsStats
  );

  // RaftSystem
  private _raftSystemUtils: RaftSystemUtils = new RaftSystemUtils(this._raftMsgHandler);

  // Connection performance checker
  private readonly _testConnPerfBlockSize = 500;
  private readonly _testConnPerfNumBlocks = 50;
  private readonly _connPerfRsltDelayMs = 4000;

  // Retry connection if lost
  private _retryIfLostEnabled = true;
  private _retryIfLostForSecs = 60;
  private _retryIfLostIsConnected = false;
  private _retryIfLostDisconnectTime: number | null = null;
  private readonly _retryIfLostRetryDelayMs = 500;

  // File handler
  private _raftFileHandler: RaftFileHandler = new RaftFileHandler(
    this._raftMsgHandler,
    this._commsStats,
  );

  // Stream handler
  private _raftStreamHandler: RaftStreamHandler = new RaftStreamHandler(
    this._raftMsgHandler,
    this._commsStats,
    this
  );

  // get stream handler
  getStreamHandler(): RaftStreamHandler {
    return this._raftStreamHandler;
  }

  // Event listener
  private _onEventFn: RaftEventFn | null = null;

  // Update manager
  private _raftUpdateManager: RaftUpdateManager | null = null;

  /**
   * RaftConnector constructor
   * @param getSystemTypeCB - callback to get system type
    */
  public constructor(getSystemTypeCB: RaftGetSystemTypeCBType | null = null) {

    // Get system type callback
    this._getSystemTypeCB = getSystemTypeCB;

    // Debug
    RaftLog.debug('RaftConnector starting up');
  }

  /**
   * Configure the file handler
   * @param fileBlockSize - size of file blocks to send
   * @param batchAckSize - number of blocks to send before waiting for ack
   * @returns void
     */
  configureFileHandler(fileBlockSize: number, batchAckSize: number) {
    this._raftFileHandler.setRequestedFileBlockSize(fileBlockSize);
    this._raftFileHandler.setRequestedBatchAckSize(batchAckSize);
  }

  /**
   * Set event listener
   * @param onEventFn - event listener
   * @returns void
   *  */
  setEventListener(onEventFn: RaftEventFn): void {
    this._onEventFn = onEventFn;
  }

  /**
   * isConnected
   * @returns boolean - true if connected
   *  */
  isConnected() {
    // Check if connected
    const isConnected = this._retryIfLostIsConnected || (this._raftChannel ? this._raftChannel.isConnected() : false);
    return isConnected;
  }

  /**
   * Set try to reconnect if connection lost
   * @param enableRetry - true to enable retry
   * @param retryForSecs - retry for this many seconds
   * @returns void
   * */
  setRetryConnectionIfLost(enableRetry: boolean, retryForSecs: number): void {
    this._retryIfLostEnabled = enableRetry;
    this._retryIfLostForSecs = retryForSecs;
    if (!this._retryIfLostEnabled) {
      this._retryIfLostIsConnected = false;
    }
    RaftLog.debug(`setRetryConnectionIfLost ${enableRetry} retry for ${retryForSecs}`);
  }

  /**
   * Get Raft system type (the type of hardware connected to - determined using the getSystemInfo API)
   * @returns RaftSystemType | null - Raft system type
   * */
  getSystemType(): RaftSystemType | null {
    return this._systemType;
  }

  /**
   * Get connection method
   * @returns string - connection method
   * */
  getConnMethod(): string {
    return this._channelConnMethod;
  }

  /**
   * Get connection locator
   * @returns string | object - connection locator
   * */
  getConnLocator(): any | null {
    return this._raftChannel ? this._raftChannel.getConnectedLocator() : null;
  }

  /**
   * Get Raft channel (this is the channel used for commuinications with the Raft application)
   * @returns RaftChannel | null - Raft channel
   * */
  getRaftChannel(): RaftChannel | null {
    return this._raftChannel;
  }

  /**
   * Get Raft system utils (access to system information and control)
   * @returns RaftSystemUtils - Raft system utils
   * */
  getRaftSystemUtils(): RaftSystemUtils {
    return this._raftSystemUtils;
  }

  /**
   * Get communication stats
   * @returns RaftCommsStats - communication stats
   * */
  getCommsStats(): RaftCommsStats {
    return this._commsStats;
  }

  /**
   * Get Raft message handler (to allow message sending and receiving)
   * @returns RaftMsgHandler - Raft message handler
   * */
  getRaftMsgHandler(): RaftMsgHandler {
    return this._raftMsgHandler;
  }

  /**
   * Pause connection
   * @param pause - true to pause, false to resume
   */
  pauseConnection(pause = true) {
    if (this._raftChannel) this._raftChannel.pauseConnection(pause);
  }

  /**
   * Initialize the Raft channel
   */
  async initializeChannel(method: string): Promise<boolean> {
    // Disconnect any existing channel first to avoid stale connections
    RaftLog.verbose(`[RaftConnector.initializeChannel] START method=${method} hasExistingChannel=${!!this._raftChannel}`);
    if (this._raftChannel) {
      RaftLog.verbose(`[RaftConnector.initializeChannel] Disconnecting existing channel...`);
      try {
        await this._raftChannel.disconnect();
        RaftLog.verbose(`[RaftConnector.initializeChannel] Existing channel disconnected successfully`);
      } catch (e) {
        RaftLog.warn(`[RaftConnector.initializeChannel] Error disconnecting existing channel: ${e}`);
      }
      this._raftChannel = null;
      RaftLog.verbose(`[RaftConnector.initializeChannel] Existing channel nulled`);
    }

    // Initialize raft channel
    RaftLog.verbose(`[RaftConnector.initializeChannel] Creating new channel...`);
    if (method === 'WebBLE' || method === 'PhoneBLE') {
      const RaftChannelBLE = createBLEChannel();
      this._raftChannel = new RaftChannelBLE();
      this._channelConnMethod = method;
    } else if (method === 'WebSocket' || method === 'wifi') {
      this._raftChannel = new RaftChannelWebSocket();
      this._channelConnMethod = 'WebSocket';
    } else if (method === 'WebSerial') {
      this._raftChannel = new RaftChannelWebSerial();
      this._channelConnMethod = 'WebSerial';
    } else if (method === 'Simulated') {
      this._raftChannel = new RaftChannelSimulated(); 
      this._channelConnMethod = 'Simulated';
    } else {
      RaftLog.warn('Unknown method: ' + method);
      return false;
    }

    // Check channel established
    if (this._raftChannel !== null) {
      // Set message handler
      this._raftChannel.setMsgHandler(this._raftMsgHandler);
      this._raftChannel.setOnConnEvent(this.onConnEvent.bind(this));

      // Message handling in and out
      this._raftMsgHandler.registerForResults(this);
      this._raftMsgHandler.registerMsgSender(this._raftChannel);
      this._raftMsgHandler.reportMsgCallbacksSet("eventHandler", this.onRxReportMsg.bind(this));

      return true;
    } else {
      this._channelConnMethod = "";
      return false;
    }
  }

  /**
   * Connect to a Raft device
   *
   * @param {string | object} locator - either a string (WebSocket URL or serial port) or an object (WebBLE)
   * @returns Promise<boolean>
   *
   */
  async connect(locator: string | object): Promise<boolean> {
    if (!this._raftChannel) {
      RaftLog.warn('Raft channel is not initialized.');
      return false;
    }

    // Store locator
    this._channelConnLocator = locator;

    // Get system type
    if (this._getSystemTypeCB) {
      // Get system type
      this._systemType = await this._getSystemTypeCB(this._raftSystemUtils);

      // Set defaults
      if (this._systemType && this._systemType.defaultWiFiHostname) {
        this._raftSystemUtils.setDefaultWiFiHostname(this._systemType.defaultWiFiHostname);
      }
    }

    // Connect
    let connOk = false;
    try {
      // Event
      this.onConnEvent(RaftConnEvent.CONN_CONNECTING);

      // Connect
      connOk = await this._connectToChannel();
    } catch (err) {
      RaftLog.warn('RaftConnector.connect - error: ' + err);
    }

    if (connOk) {

      // Setup system type
      if (this._systemType) {
        this._systemType.setup(this._raftSystemUtils, this._onEventFn);
      }

      // Check if subscription required
      if (this._systemType &&
        this._systemType.subscribeForUpdates &&
        this._raftChannel.requiresSubscription()) {
        try {
          // Subscription
          await this._systemType.subscribeForUpdates(this._raftSystemUtils, true);
          RaftLog.info(`connect subscribed for updates`);
        } catch (error: unknown) {
          RaftLog.warn(`connect subscribe for updates failed ${error}`)
        }
      }

      // configure file handler
      this.configureFileHandler(this._raftChannel.fhFileBlockSize(), this._raftChannel.fhBatchAckSize());

      // Send connected event
      this.onConnEvent(RaftConnEvent.CONN_CONNECTED);

    } else {
      // Failed Event
      this.onConnEvent(RaftConnEvent.CONN_CONNECTION_FAILED);

      // Clear system type
      this._systemType = null;
    }

    return connOk;
  }

  async disconnect(): Promise<void> {
    // Disconnect
    this._retryIfLostIsConnected = false;
    if (this._raftChannel) {
      // Store reference to channel before async operations to avoid race condition
      const channelToDisconnect = this._raftChannel;
      this._raftChannel = null;
      
      // Check if there is a RICREST command to send before disconnecting
      const ricRestCommand = channelToDisconnect.ricRestCmdBeforeDisconnect();
      if (ricRestCommand) {
        console.log(`sending RICREST command before disconnect: ${ricRestCommand}`);
        await this.sendRICRESTMsg(ricRestCommand, {});
      }
      // Pause a little before disconnecting
      await new Promise(resolve => setTimeout(resolve, 1000));
      // await this.sendRICRESTMsg("bledisc", {});
      await channelToDisconnect.disconnect();
    }
  }

  // Mark: Tx Message handling -----------------------------------------------------------------------------------------

  /**
   *
   * sendRICRESTMsg
   * @param commandName command API string
   * @param params parameters (simple name value pairs only) to parameterize trajectory
   * @returns Promise<RaftOKFail>
   *
   */
  async sendRICRESTMsg(commandName: string, params: object,
    bridgeID: number | undefined = undefined): Promise<RaftOKFail> {
    try {
      // Format the paramList as query string
      const paramEntries = Object.entries(params);
      let paramQueryStr = '';
      for (const param of paramEntries) {
        if (paramQueryStr.length > 0) paramQueryStr += '&';
        paramQueryStr += param[0] + '=' + param[1];
      }
      // Format the url to send
      if (paramQueryStr.length > 0) commandName += '?' + paramQueryStr;
      return await this._raftMsgHandler.sendRICRESTURL<RaftOKFail>(commandName, bridgeID);
    } catch (error) {
      RaftLog.warn(`sendRICRESTMsg failed ${error}`);
      return { rslt: 'fail' };
    }
  }

  // Mark: Rx Message handling -----------------------------------------------------------------------------------------

  /**
   * onRxReply - handle a reply message
   * @param msgHandle number indicating the message that is being replied to (from the original message)
   * @param msgRsltCode result code
   * @param msgRsltJsonObj result object
   */
  onRxReply(
    msgHandle: number,
    msgRsltCode: RaftMsgResultCode,
    msgRsltJsonObj: object | null,
  ): void {
    RaftLog.verbose(
      `onRxReply msgHandle ${msgHandle} rsltCode ${msgRsltCode} obj ${JSON.stringify(
        msgRsltJsonObj,
      )}`,
    );
  }

  /**
   * onRxUnnumberedMsg - handle an unnumbered message
   * @param msgRsltJsonObj result object
   */
  onRxUnnumberedMsg(msgRsltJsonObj: { [key: string]: number | string }): void {
    RaftLog.verbose(
      `onRxUnnumberedMsg rsltCode obj ${JSON.stringify(msgRsltJsonObj)}`,
    );

    // Inform the file handler
    if ('okto' in msgRsltJsonObj) {
      this._raftFileHandler.onOktoMsg(msgRsltJsonObj.okto as number);
    } else if ('sokto' in msgRsltJsonObj) {
      this._raftStreamHandler.onSoktoMsg(msgRsltJsonObj.sokto as number);
    }
  }

  /**
   * onRxFileBlock - handle a file block
   * @param filePos file position
   * @param fileBlockData file block data
   */
  onRxFileBlock(
    filePos: number,
    fileBlockData: Uint8Array
  ): void {
    // RaftLog.info(`onRxFileBlock filePos ${filePos} fileBlockData ${RaftUtils.bufferToHex(fileBlockData)}`);
    this._raftFileHandler.onFileBlock(filePos, fileBlockData);
  }


  // Mark: Handling of other message types -----------------------------------------------------------------------------------------

  /**
   * onRxOtherMsgType - handle other message types
   * @param payload message payload
   * @param frameTimeMs time of frame
   */
  onRxOtherMsgType(payload: Uint8Array, _frameTimeMs: number): void {
    // RaftLog.debug(`onRxOtherMsgType payload ${RaftUtils.bufferToHex(payload)}`);
    RaftLog.verbose(`onRxOtherMsgType payloadLen ${payload.length}`);

    // Handle other messages
    if (this._systemType && this._systemType.rxOtherMsgType) {
      this._systemType.rxOtherMsgType(payload, _frameTimeMs);
    }
  }

  // Mark: File sending --------------------------------------------------------------------------------

  /**
   * sendFile - send a file
   * @param fileName name of file to send
   * @param fileContents file contents
   * @param progressCallback callback to receive progress updates
   * @returns Promise<boolean> - true if file sent successfully
   */
  async sendFile(fileName: string,
    fileContents: Uint8Array,
    progressCallback: ((sent: number, total: number, progress: number) => void) | undefined,
  ): Promise<boolean> {
    return this._raftFileHandler.fileSend(fileName, RaftFileSendType.NORMAL_FILE, "fs", fileContents, progressCallback);
  }

  // Mark: Streaming --------------------------------------------------------------------------------

  /**
   * streamData - stream arbitrary data to a named firmware endpoint using the RT_STREAM protocol.
   * @param streamContents data to stream
   * @param fileName logical filename sent in ufStart (e.g. "pattern.thr")
   * @param targetEndpoint REST API endpoint name on the firmware (e.g. "streampattern")
   * @param progressCallback optional (sent, total, progress) callback
   * @returns Promise<boolean> true on success
   */
  async streamData(
    streamContents: Uint8Array,
    fileName: string,
    targetEndpoint: string,
    progressCallback?: RaftStreamDataProgressCBType,
  ): Promise<boolean> {
    if (this._raftStreamHandler && this.isConnected()) {
      return this._raftStreamHandler.streamData(
        streamContents, fileName, targetEndpoint, progressCallback,
      );
    }
    return false;
  }

  /**
   * streamAudio - stream audio
   * @param streamContents audio data
   * @param clearExisting true to clear existing audio
   * @param duration duration of audio
   */
  streamAudio(streamContents: Uint8Array, clearExisting: boolean, duration: number): void {
    if (this._raftStreamHandler && this.isConnected()) {
      this._raftStreamHandler.streamAudio(streamContents, clearExisting, duration);
    }
  }

  /**
   * isStreamStarting - check if stream is starting
   */
  isStreamStarting() {
    return this._raftStreamHandler.isStreamStarting();
  }

  // Mark: File system --------------------------------------------------------------------------------

  /**
   * fsGetContents - get file contents
   * @param fileName name of file to get
   * @param fileSource source of file to get (e.g. "fs" or "bridgeserial1", if omitted defaults to "fs")
   * @param progressCallback callback to receive progress updates
   * @returns Promise<RaftFileDownloadResult>
   */
  async fsGetContents(fileName: string,
    fileSource: string,
    progressCallback: RaftProgressCBType | undefined): Promise<RaftFileDownloadResult> {
    return await this._raftFileHandler.fileReceive(fileName, fileSource, progressCallback);
  }

  /**
   * setLegacySoktoMode - set legacy sokto mode
   * @param legacyMode true to set legacy mode
   */
  setLegacySoktoMode(legacyMode: boolean) {
    return this._raftStreamHandler.setLegacySoktoMode(legacyMode);
  }

  // Mark: Bridge serial --------------------------------------------------------------------------------

  /**
   * createCommsBridge - create a comms bridge
   * @param bridgeSource source of bridge (e.g. "Serial1")
   * @param bridgeName name of bridge
   * @param idleCloseSecs idle close time seconds
   * @returns Promise<RaftBridgeSetupResp>
   */
  async createCommsBridge(bridgeSource: string, bridgeName: string, idleCloseSecs = 0): Promise<RaftBridgeSetupResp> {
    return await this._raftMsgHandler.createCommsBridge(bridgeSource, bridgeName, idleCloseSecs);
  }

  // Mark: Connection performance--------------------------------------------------------------------------

  /**
   * ParkMiller random number generator
   * @param seed
   * @returns number
   */
  private parkmiller_next(seed: number) {
    const hi = Math.round(16807 * (seed & 0xffff));
    let lo = Math.round(16807 * (seed >> 16));
    lo += (hi & 0x7fff) << 16;
    lo += hi >> 15;
    if (lo > 0x7fffffff)
      lo -= 0x7fffffff;
    return lo;
  }

  /**
   * checkConnPerformance - check connection performance
   * @returns Promise<number | undefined> - connection performance
   */
  async checkConnPerformance(): Promise<number | undefined> {

    // Sends a magic sequence of bytes followed by blocks of random data 
    // these will be ignored by the Raft library (as it recognises magic sequence)
    // and is used performance evaluation
    let prbsState = 1;
    const testData = new Uint8Array(this._testConnPerfBlockSize);
    for (let i = 0; i < this._testConnPerfNumBlocks; i++) {
      testData.set([0, (i >> 24) & 0xff, (i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff, 0x1f, 0x9d, 0xf4, 0x7a, 0xb5]);
      for (let j = 10; j < this._testConnPerfBlockSize; j++) {
        prbsState = this.parkmiller_next(prbsState);
        testData[j] = prbsState & 0xff;
      }
      if (this._raftChannel) {
        await this._raftChannel.sendTxMsg(testData, false);
      }
    }

    // Wait a little to allow the Raft app to process the data
    await new Promise(resolve => setTimeout(resolve, this._connPerfRsltDelayMs));

    // Get performance
    const blePerf = await this._raftSystemUtils.getSysModInfoBLEMan();
    if (blePerf) {
      console.log(`checkConnPerformance result rate = ${blePerf.tBPS}BytesPS`);
      return blePerf.tBPS;
    } else {
      throw new Error('checkConnPerformance: failed to get BLE performance');
    }
  }

  // Mark: Connection event --------------------------------------------------------------------------

  /**
   * onConnEvent - handle connection event
   * @param eventEnum connection event enumeration
   * @param data data associated with event
   * @returns void
   */
  onConnEvent(eventEnum: RaftConnEvent, data: object | string | null | undefined = undefined): void {
    // Handle information clearing on disconnect
    switch (eventEnum) {
      case RaftConnEvent.CONN_DISCONNECTED:

        // Disconnect time
        this._retryIfLostDisconnectTime = Date.now();

        // Check if retry required
        if (this._retryIfLostIsConnected && this._retryIfLostEnabled) {

          // Indicate connection disrupted
          if (this._onEventFn) {
            this._onEventFn("conn", RaftConnEvent.CONN_ISSUE_DETECTED, RaftConnEventNames[RaftConnEvent.CONN_ISSUE_DETECTED]);
          }

          // Retry connection
          this._retryConnection();

          // Don't allow disconnection to propagate until retries have occurred
          return;

        }

        // Invalidate connection details
        this._raftSystemUtils.invalidate();

        // Invalidate system-type info
        if (this._systemType && this._systemType.stateIsInvalid) {
          this._systemType.stateIsInvalid();
        }
        break;
    }
    // Notify
    if (this._onEventFn) {
      this._onEventFn("conn", eventEnum, RaftConnEventNames[eventEnum], data);
    }
  }

  /**
   * Retry connection
   */
  private _retryConnection(): void {
    // Check timeout
    if ((this._retryIfLostDisconnectTime !== null) &&
      (Date.now() - this._retryIfLostDisconnectTime < this._retryIfLostForSecs * 1000)) {

      // Set timer to try to reconnect
      setTimeout(async () => {

        // Try to connect
        const isConn = await this._connectToChannel();
        if (!isConn) {
          this._retryConnection();
        } else {

          // No longer retrying
          this._retryIfLostDisconnectTime = null;

          // Indicate connection problem resolved
          if (this._onEventFn) {
            this._onEventFn("conn", RaftConnEvent.CONN_ISSUE_RESOLVED, RaftConnEventNames[RaftConnEvent.CONN_ISSUE_RESOLVED]);
          }

        }
      }, this._retryIfLostRetryDelayMs);
    } else {

      // No longer connected after retry timeout
      this._retryIfLostIsConnected = false;

      // Indicate disconnection
      if (this._onEventFn) {
        this._onEventFn("conn", RaftConnEvent.CONN_DISCONNECTED, RaftConnEventNames[RaftConnEvent.CONN_DISCONNECTED]);
      }

      // Invalidate connection details
      this._raftSystemUtils.invalidate();

      // Invalidate system-type info
      if (this._systemType && this._systemType.stateIsInvalid) {
        this._systemType.stateIsInvalid();
      }
    }
  }

  /**
   * Connect to channel
   * @returns Promise<boolean> - true if connected
   */
  private async _connectToChannel(): Promise<boolean> {
    // Connect
    try {
      if (this._raftChannel) {
        const connected = await this._raftChannel.connect(this._channelConnLocator, this._systemType ? this._systemType.connectorOptions : { });
        if (connected) {
          this._retryIfLostIsConnected = true;
          return true;
        }
      }
    } catch (error) {
      RaftLog.warn(`RaftConnector.connect() error: ${error}`);
    }
    return false;
  }

  // Mark: OTA Update -----------------------------------------------------------------------------------------

  /**
   * onUpdateEvent - handle update event
   * @param eventEnum 
   * @param data 
   */
  _onUpdateEvent(eventEnum: RaftUpdateEvent, data: object | string | null | undefined = undefined): void {
    // Notify
    if (this._onEventFn) {
      this._onEventFn("ota", eventEnum, RaftUpdateEventNames[eventEnum], data);
    }
  }

  /**
   * otaUpdateCheck - check for OTA update
   * @returns Promise<RaftUpdateEvent> - update event
   * */
  async otaUpdateCheck(): Promise<RaftUpdateEvent> {
    if (!this._raftUpdateManager)
      return RaftUpdateEvent.UPDATE_NOT_CONFIGURED;
    return await this._raftUpdateManager.checkForUpdate(this._raftSystemUtils.getCachedSystemInfo());
  }

  /**
   * otaUpdateStart - start OTA update
   * @returns Promise<RaftUpdateEvent> - update event
   * */
  async otaUpdateStart(): Promise<RaftUpdateEvent> {
    if (!this._raftUpdateManager)
      return RaftUpdateEvent.UPDATE_NOT_CONFIGURED;
    return await this._raftUpdateManager.firmwareUpdate();
  }

  /**
   * otaUpdateCancel - cancel OTA update
   * @returns Promise<void>
   * */
  async otaUpdateCancel(): Promise<void> {
    if (!this._raftUpdateManager)
      return;
    return await this._raftUpdateManager.firmwareUpdateCancel();
  }

  /**
   * setupUpdateManager - setup the update manager
   * @param appVersion - app version
   * @param appUpdateURL - app update URL
   * @param firmwareBaseURL - firmware base URL
   * @param fileDownloader - file downloader
   * @returns void
   * */
  setupUpdateManager(appVersion: string, appUpdateURL: string, firmwareBaseURL: string, fileDownloader: RaftFileDownloadFn): void {
    // Setup update manager
    const firmwareTypeStrForMainFw = 'main';
    this._raftUpdateManager = new RaftUpdateManager(
      this._systemType,
      this._raftMsgHandler,
      this._raftFileHandler,
      this._raftSystemUtils,
      this._onUpdateEvent.bind(this),
      firmwareTypeStrForMainFw,
      appVersion,
      fileDownloader,
      appUpdateURL,
      firmwareBaseURL,
      this._raftChannel
    );
  }

  async onRxReportMsg(reportMsg: RaftReportMsg): Promise<void> {
    // console.log(`onRxReportMsg ${JSON.stringify(reportMsg)}`);
    if (reportMsg.msgType && reportMsg.msgType.toLowerCase() === "sysevent") {
      if (reportMsg.msgName && reportMsg.msgName.toLowerCase() === "shutdown") {
        // Indicate disconnection
        if (this._onEventFn) {
          this._onEventFn("conn", RaftConnEvent.CONN_DISCONNECTED, RaftConnEventNames[RaftConnEvent.CONN_DISCONNECTED]);
        }
        // Disconnect
        await this.disconnect();
      }
    }
  }
}
