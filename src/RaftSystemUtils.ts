/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftSystem
// Part of RaftJS
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import {
  RaftSysModInfoWiFi,
  RaftWifiConnState,
  RaftWifiConnStatus,
} from "./RaftWifiTypes";
import RaftLog from "./RaftLog";
import RaftMsgHandler from "./RaftMsgHandler";
import { RaftCapabilityResolver, SystemCapabilities } from "./RaftCapabilities";

import {
  RaftFileList,
  RaftFriendlyName,
  RaftOKFail,
  RaftPubTopicRec,
  RaftPubTopicsResponse,
  RaftCapabilitiesResponse,
  RaftSubscriptionUpdateResponse,
  RaftSysModInfoBLEMan,
  RaftSystemInfo,
  RaftWifiScanResults,
} from "./RaftTypes";

export default class RaftSystemUtils {
  // Message handler
  private _msgHandler: RaftMsgHandler;

  // System info
  private _systemInfo: RaftSystemInfo | null = null;

  // Raft naming
  private _friendlyName: RaftFriendlyName | null = null;

  // WiFi connection info
  private _wifiConnStatus: RaftWifiConnStatus = new RaftWifiConnStatus();
  private _defaultWiFiHostname = "Raft";
  private _maxSecsToWaitForWiFiConn = 20;

  // Publish topic index/name lookup tables (session scoped)
  private _pubTopicIdxToName: { [idx: number]: string } = {};
  private _pubTopicNameToIdx: { [name: string]: number } = {};

  // Layered capability resolution (Layer A static table + Layer B runtime cache
  // + Layer C firmware caps). Seeded at connect, cleared on disconnect.
  private _capabilityResolver = new RaftCapabilityResolver();

  /**
   * constructor
   * @param raftMsgHandler 
   */
  constructor(raftMsgHandler: RaftMsgHandler) {
    this._msgHandler = raftMsgHandler;
  }

  /**
   * getMsgHandler
   * @returns RaftMsgHandler
   */
  getMsgHandler(): RaftMsgHandler {
    return this._msgHandler;
  }

  /**
   * Update publish topic maps from topic records.
   */
  updatePublishTopicMap(topicRecs: Array<RaftPubTopicRec> | undefined): void {
    if (!topicRecs || !Array.isArray(topicRecs)) {
      return;
    }
    for (const topicRec of topicRecs) {
      if (!topicRec || typeof topicRec.name !== "string" || typeof topicRec.idx !== "number") {
        continue;
      }
      this._pubTopicIdxToName[topicRec.idx] = topicRec.name;
      this._pubTopicNameToIdx[topicRec.name] = topicRec.idx;
    }
  }

  /**
   * Update publish topic maps from subscription response.
   */
  updatePublishTopicMapFromSubscriptionResponse(resp: RaftSubscriptionUpdateResponse | RaftOKFail | null | undefined): void {
    if (!resp || typeof resp !== "object") {
      return;
    }
    if ("topics" in resp) {
      this.updatePublishTopicMap((resp as RaftSubscriptionUpdateResponse).topics);
    }
  }

  /**
   * Fetch publish topic map from firmware endpoint.
   */
  async refreshPublishTopicMap(): Promise<boolean> {
    // Skip if the device is known not to support pubtopics (Layer A/B/C)
    if (this.isCapabilitySupported("pubtopics") === false) {
      return false;
    }
    try {
      const pubTopicsResp = await this._msgHandler.sendRICRESTURL<RaftPubTopicsResponse>("pubtopics");
      const ok = !!(pubTopicsResp && pubTopicsResp.rslt === "ok");
      // Learn the result at runtime (Layer B) - helps Generic/unknown devices
      this._capabilityResolver.recordResult("pubtopics", ok);
      if (ok) {
        this.updatePublishTopicMap(pubTopicsResp.topics);
        return true;
      }
    } catch (error) {
      RaftLog.debug(`refreshPublishTopicMap failed ${error}`);
    }
    return false;
  }

  /**
   * Seed the capability resolver from the system type's static table (Layer A)
   * and the firmware version. Call once the system type and system info are
   * known (i.e. after getSystemInfo), before refreshCapabilities.
   */
  seedCapabilities(capabilities: SystemCapabilities | undefined, systemVersion: string): void {
    this._capabilityResolver.seed(capabilities, systemVersion);
  }

  /**
   * Resolve device capabilities at connect. Consults the static table to decide
   * whether to call the firmware "caps" endpoint at all:
   * - a type/version known not to have caps (e.g. old Marty) skips the probe and
   *   relies on the static table + runtime discovery;
   * - otherwise "caps" is queried and, when present, becomes authoritative
   *   (Layer C). When absent (older firmware) callers fall back to Layers A + B.
   * @returns Promise<boolean> true if an authoritative caps list was obtained
   */
  async refreshCapabilities(): Promise<boolean> {
    if (!this._capabilityResolver.shouldQueryCaps()) {
      RaftLog.info("refreshCapabilities skipping caps query (static table: unsupported for this version)");
      this._capabilityResolver.setCapsResult(null);
      return false;
    }
    try {
      const capsResp = await this._msgHandler.sendRICRESTURL<RaftCapabilitiesResponse>("caps");
      if (capsResp && capsResp.rslt === "ok" && Array.isArray(capsResp.caps)) {
        this._capabilityResolver.setCapsResult(capsResp.caps);
        RaftLog.info(`refreshCapabilities got ${capsResp.caps.length} capabilities (capsVersion ${capsResp.capsVersion ?? "?"})`);
        return true;
      }
      RaftLog.debug("refreshCapabilities device has no caps endpoint - using static table + runtime discovery");
    } catch (error) {
      RaftLog.debug(`refreshCapabilities failed ${error}`);
    }
    this._capabilityResolver.setCapsResult(null);
    return false;
  }

  /**
   * Query whether the device supports a given gated endpoint.
   * @param name - the gated endpoint key (e.g. "datetime", "devman/typeinfo")
   * @returns true/false when a verdict is known (from caps, runtime cache or the
   *          static table), or undefined when unknown - callers should then fall
   *          back to their existing behaviour (send once).
   */
  isCapabilitySupported(name: string): boolean | undefined {
    return this._capabilityResolver.isSupported(name);
  }

  /**
   * Record the outcome of sending a gated endpoint (Layer B runtime discovery).
   */
  recordCapabilityResult(name: string, supported: boolean): void {
    this._capabilityResolver.recordResult(name, supported);
  }

  /**
   * Resolve the BLE max write size for the connected system type/version from
   * the capability table's tuning, or undefined if the type declares none.
   */
  getBleMaxWriteSize(): number | undefined {
    return this._capabilityResolver.bleMaxWriteSize();
  }

  /**
   * Reset session-scoped capability state (call on disconnect).
   */
  resetCapabilities(): void {
    this._capabilityResolver.reset();
  }

  getPublishTopicName(topicIndex: number): string | undefined {
    return this._pubTopicIdxToName[topicIndex];
  }

  getPublishTopicIndex(topicName: string): number | undefined {
    return this._pubTopicNameToIdx[topicName];
  }

  /**
   * setDefaultWiFiHostname
   * @param defaultWiFiHostname
   */
  setDefaultWiFiHostname(defaultWiFiHostname: string) {
    if (defaultWiFiHostname) {
      this._defaultWiFiHostname = defaultWiFiHostname;
    }
  }
  
  /**
   * getFriendlyName
   *
   * @returns friendly name
   */
  getFriendlyName(): RaftFriendlyName | null {
    return this._friendlyName;
  }

  /**
   * invalidate
   */
  invalidate() {
    // Invalidate system info
    this._systemInfo = null;
    this._friendlyName = null;
    RaftLog.debug("RaftSystemUtils information invalidated");
  }

  /**
   * retrieveInfo - get system info
   * @returns Promise<RaftSystemInfo>
   *
   */
  async retrieveInfo(): Promise<boolean> {

    // Get system info
    RaftLog.debug(`RaftSystemUtils retrieveInfo getting system info`);
    try {
      await this.getSystemInfo(true);
      RaftLog.debug(
        `retrieveInfo - Raft Version ${this._systemInfo?.SystemVersion}`
      );
    } catch (error) {
      RaftLog.warn("RaftSystemUtils retrieveInfo - frailed to get version " + error);
      return false;
    }

    // Get app name
    try {
      await this.getRaftName();
    } catch (error) {
      RaftLog.warn("retrieveInfo - failed to get Raft name " + error);
      return false;
    }

    // Get WiFi connected info
    try {
      await this.getWiFiConnStatus();
    } catch (error) {
      RaftLog.warn("RaftSystemUtils retrieveInfo - failed to get WiFi Status " + error);
      return false;
    }

    return true;
  }

  /**
   *
   * getSystemInfo
   * @param forceGet - true to force a get from the raft app
   * @returns Promise<RaftSystemInfo>
   *
   */
  async getSystemInfo(forceGet = false): Promise<RaftSystemInfo> {
    if (!forceGet && this._systemInfo) {
      return this._systemInfo;
    }
    try {
      this._systemInfo = await this._msgHandler.sendRICRESTURL<
        RaftSystemInfo
      >("v");
      RaftLog.debug(
        "getRaftSystemInfo returned " + JSON.stringify(this._systemInfo)
      );
      this._systemInfo.validMs = Date.now();
      // Check if friendly name is included in system info
      if (this._systemInfo.Friendly && (this._systemInfo.Friendly.length > 0)) {
        this._friendlyName = {"friendlyName": this._systemInfo.Friendly, "friendlyNameIsSet": true, "rslt": "ok", "validMs": Date.now()};
      }
      // Handle alternatives in system info
      if ((this._systemInfo.RicHwRevNo !== undefined) && (this._systemInfo.HwRev === undefined)) {
        this._systemInfo.HwRev = this._systemInfo.RicHwRevNo;
      } else if ((this._systemInfo.HwRev !== undefined) && (this._systemInfo.RicHwRevNo === undefined)) {
        this._systemInfo.RicHwRevNo = this._systemInfo.HwRev;
      }

      // Return system info
      return this._systemInfo;
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils getRaftSystemInfo Failed to get version ${error}`);
      return new RaftSystemInfo();
    }
  }

  /**
   *
   * setRaftName
   * @param newName name to refer to Raft - used for BLE advertising
   * @returns Promise<boolean> true if successful
   *
   */
  async setRaftName(newName: string): Promise<boolean> {
    try {
      this._friendlyName = await this._msgHandler.sendRICRESTURL<
        RaftFriendlyName
      >(`friendlyname/${newName}`);
      if (this._friendlyName) {
        this._friendlyName.friendlyNameIsSet = false;
        this._friendlyName.validMs = Date.now();
        if (
          this._friendlyName &&
          this._friendlyName.rslt &&
          this._friendlyName.rslt.toLowerCase() === "ok"
        ) {
          this._friendlyName.friendlyNameIsSet = true;
        }
        RaftLog.debug(
          "RaftSystemUtils setRaftName returned " + JSON.stringify(this._friendlyName)
        );
        return true;
      }
      return true;
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils setRaftName Failed to set name ${error}`);
      this._friendlyName = null;
      return false;
    }
  }

  /**
   *
   * getRaftName
   * @param forceGet - true to force a get from the raft app
   * @returns Promise<RaftNameResponse> (object containing rslt)
   *
   */
  async getRaftName(forceGet = false): Promise<RaftFriendlyName> {
    // Check if we have a cached value
    if (!forceGet && this._friendlyName && this._friendlyName.validMs) {
      return this._friendlyName;
    }
    try {
      this._friendlyName = await this._msgHandler.sendRICRESTURL<
        RaftFriendlyName
      >("friendlyname");
      if (
        this._friendlyName &&
        this._friendlyName.rslt &&
        this._friendlyName.rslt === "ok"
      ) {
        this._friendlyName.friendlyNameIsSet = this._friendlyName
          .friendlyNameIsSet
          ? true
          : false;
      } else {
        this._friendlyName.friendlyNameIsSet = false;
      }
      this._friendlyName.validMs = Date.now();
      RaftLog.debug(
        "RaftSystemUtils Friendly name set is: " + JSON.stringify(this._friendlyName)
      );
      return this._friendlyName;
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils getRaftName Failed to get name ${error}`);
      return new RaftFriendlyName();
    }
  }

  /**
   *
   * getFileList - get list of files on file system
   * @returns Promise<RaftFileList>
   *
   */
  async getFileList(): Promise<RaftFileList> {
    try {
      const ricFileList = await this._msgHandler.sendRICRESTURL<RaftFileList>(
        "filelist"
      );
      RaftLog.debug("RaftSystemUtils getFileList returned " + ricFileList);
      return ricFileList;
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils getFileList Failed to get file list ${error}`);
      return new RaftFileList();
    }
  }

  /**
   *
   * Get BLEMan sysmod info
   *
   * @returns RaftSysModInfoBLEMan
   *
   */
  async getSysModInfoBLEMan(): Promise<RaftSysModInfoBLEMan | null> {
    try {
      // Get SysMod Info
      const bleInfo = await this._msgHandler.sendRICRESTURL<
        RaftSysModInfoBLEMan
      >("sysmodinfo/BLEMan");

      // Debug
      RaftLog.debug(
        `getSysModInfoBLEMan rslt ${bleInfo.rslt} isConn ${bleInfo.isConn} paused ${bleInfo.isAdv} txBPS ${bleInfo.txBPS} rxBPS ${bleInfo.rxBPS}`
      );

      // Check for test rate
      if ("tBPS" in bleInfo) {
        RaftLog.debug(
          `getSysModInfoBLEMan testMsgs ${bleInfo.tM} testBytes ${bleInfo.tB} testRateBytesPS ${bleInfo.tBPS}`
        );
      }

      return bleInfo;
    } catch (error) {
      RaftLog.debug(`getSysModInfoBLEMan sysmodinfo/BLEMan failed ${error}`);
    }
    return null;
  }

  /**
   * Get hostname of connected WiFi
   *
   *  @return string - hostname of connected WiFi
   *
   */
  _getHostnameFromFriendlyName(): string {
    const friendlyName = this.getFriendlyName();
    if (!friendlyName) {
      return this._defaultWiFiHostname;
    }
    let hostname = friendlyName.friendlyName;
    hostname = hostname?.replace(/ /g, "-");
    hostname = hostname.replace(/\W+/g, "");
    return hostname;
  }

  /**
   * Get Wifi connection status
   *
   *  @return boolean - true if connected
   *
   */
  async getWiFiConnStatus(): Promise<boolean | null> {
    try {
      // Get status
      const ricSysModInfoWiFi = await this._msgHandler.sendRICRESTURL<
        RaftSysModInfoWiFi
      >("sysmodinfo/NetMan");

      RaftLog.debug(
        `wifiConnStatus rslt ${ricSysModInfoWiFi.rslt} isConn ${ricSysModInfoWiFi.isConn} paused ${ricSysModInfoWiFi.isPaused}`
      );

      // Check status indicates WiFi connected
      if (ricSysModInfoWiFi.rslt === "ok") {
        this._wifiConnStatus.connState =
          ricSysModInfoWiFi.isConn !== 0
            ? RaftWifiConnState.WIFI_CONN_CONNECTED
            : RaftWifiConnState.WIFI_CONN_NONE;
        this._wifiConnStatus.isPaused = ricSysModInfoWiFi.isPaused !== 0;
        this._wifiConnStatus.ipAddress = ricSysModInfoWiFi.IP;
        this._wifiConnStatus.hostname = ricSysModInfoWiFi.Hostname;
        this._wifiConnStatus.ssid = ricSysModInfoWiFi.SSID;
        this._wifiConnStatus.bssid = ricSysModInfoWiFi.WiFiMAC;
        this._wifiConnStatus.validMs = Date.now();
        return (
          ricSysModInfoWiFi.isConn !== 0 || ricSysModInfoWiFi.isPaused !== 0
        );
      }
    } catch (error) {
      RaftLog.debug(`[DEBUG]: wifiConnStatus sysmodinfo failed ${error}`);
      this._wifiConnStatus.validMs = 0;
    }
    this._wifiConnStatus.connState = RaftWifiConnState.WIFI_CONN_NONE;
    this._wifiConnStatus.isPaused = false;
    return null;
  }

  // Mark: WiFi Connection ------------------------------------------------------------------------------------

  /**
   * pause Wifi connection
   *
   *  @param boolean - true to pause, false to resume
   *  @return boolean - true if successful
   *
   */
  async pauseWifiConnection(pause: boolean): Promise<boolean> {
    try {
      if (pause) {
        await this._msgHandler.sendRICRESTURL<RaftOKFail>("wifipause/pause");
      } else {
        await this._msgHandler.sendRICRESTURL<RaftOKFail>("wifipause/resume");
      }
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils wifiConnect wifi pause ${error}`);
      return true;
    }
    return false;
  }

  /**
   * Connect to WiFi
   *
   *  @param string - WiFi SSID
   *  @param string - WiFi password
   *  @return boolean - true if successful
   *
   */
  async wifiConnect(ssid: string, password: string): Promise<boolean> {
    RaftLog.debug(`RaftSystemUtils Connect to WiFi ${ssid} password ${password}`);

    // Issue the command to connect WiFi
    try {
      const RaftRESTURL_wifiCredentials =
        "w/" +
        ssid +
        "/" +
        password +
        "/" +
        this._getHostnameFromFriendlyName();
      RaftLog.debug(
        `wifiConnect attempting to connect to wifi ${RaftRESTURL_wifiCredentials}`
      );

      await this._msgHandler.sendRICRESTURL<RaftOKFail>(
        RaftRESTURL_wifiCredentials
      );
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils wifiConnect failed ${error}`);
      return false;
    }

    // Wait until connected, timed-out or failed
    for (
      let timeoutCount = 0;
      timeoutCount < this._maxSecsToWaitForWiFiConn;
      timeoutCount++
    ) {
      // Wait a little before checking
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get status info
      const connStat = await this.getWiFiConnStatus();
      RaftLog.debug(`RaftSystemUtils wifiConnect connStat ${connStat}`);
      if (connStat) {
        return true;
      }
    }
    return false;
  }

  /**
   * Disconnect WiFi
   *
   *  @return boolean - true if successful
   *
   */
  async wifiDisconnect(): Promise<boolean> {
    try {
      RaftLog.debug(`RaftSystemUtils wifiDisconnect clearing wifi info`);

      await this._msgHandler.sendRICRESTURL<RaftOKFail>("wc");
      this.getWiFiConnStatus();
      return true;
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils wifiDisconnect clearing unsuccessful ${error}`);
    }
    return false;
  }

  // Mark: WiFi Scan ------------------------------------------------------------------------------------

  /**
   *  WiFiScan start
   *
   *  @return boolean - true if successful
   *
   */
  async wifiScanStart(): Promise<boolean> {
    try {
      RaftLog.debug(`RaftSystemUtils wifiScanStart`);
      await this._msgHandler.sendRICRESTURL<RaftOKFail>("wifiscan/start");
      return true;
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils wifiScanStart unsuccessful ${error}`);
    }
    return false;
  }
  /**
   *  WiFiScan get results
   *
   *  @return boolean - false if unsuccessful, otherwise the results of the promise
   *
   */
  async wifiScanResults(): Promise<boolean | RaftOKFail | RaftWifiScanResults> {
    try {
      RaftLog.debug(`RaftSystemUtils wifiScanResults`);
      return this._msgHandler.sendRICRESTURL<RaftOKFail | RaftWifiScanResults>(
        "wifiscan/results"
      );
    } catch (error) {
      RaftLog.debug(`RaftSystemUtils wifiScanResults unsuccessful ${error}`);
    }
    return false;
  }

  getCachedSystemInfo(): RaftSystemInfo | null {
    return this._systemInfo;
  }

  getCachedRaftName(): RaftFriendlyName | null {
    return this._friendlyName;
  }

  getCachedWifiStatus(): RaftWifiConnStatus {
    return this._wifiConnStatus;
  }
}
