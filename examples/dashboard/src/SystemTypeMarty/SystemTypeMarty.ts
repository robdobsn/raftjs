import { RaftSystemType } from "../../../../src/RaftSystemType";
import { RaftLog, RaftSystemUtils, RaftOKFail, RaftConnEventFn, RaftEventFn, RaftPublishEvent, RaftPublishEventNames, SystemCapabilities } from "../../../../src/main";
import RICAddOnManager from "./RICAddOnManager";
import RICCommsStats from "./RICCommsStats";
import RICLEDPatternChecker from "./RICLEDPatternChecker";
import RICServoFaultDetector from "./RICServoFaultDetector";
import { RICStateInfo } from "./RICStateInfo";

export default class SystemTypeMarty implements RaftSystemType {
  nameForDialogs = "Robotical Marty";
  defaultWiFiHostname = "Marty";
  firmwareDestName = "ricfw";
  normalFileDestName = "fs";
  connectorOptions = {wsSuffix: "ws", bleConnItvlMs: 7.5};
  BLEServiceUUIDs = ["aa76677e-9cfd-4626-a510-0d305be57c8d"];
  BLECmdUUID = "aa76677e-9cfd-4626-a510-0d305be57c8e";
  BLERespUUID = "aa76677e-9cfd-4626-a510-0d305be57c8f";

  // Static capability table (Layer A). Older Marty firmware (e.g. v1.3.21) has
  // no caps endpoint, so this omits "caps" - the resolver then skips the caps
  // probe entirely and relies on this table + runtime discovery. Newer Marty
  // builds that add datetime/pubtopics/devman (and caps) should add them here
  // with a minVersion bracket once the introducing version is known.
  capabilities: SystemCapabilities = {
    endpoints: {
      "filelist/local": true,
    },
    tuning: { bleMaxWriteSize: 182 },
  };

  // LED Pattern checker
  private _ledPatternChecker: RICLEDPatternChecker = new RICLEDPatternChecker();
  getLEDPatternChecker(): RICLEDPatternChecker {
    return this._ledPatternChecker;
  }

  // Latest data from servos, IMU, etc
  private _ricStateInfo: RICStateInfo = new RICStateInfo();
  getStateInfo(): RICStateInfo {
    return this._ricStateInfo;
  }

  // Add-on Manager
  private _addOnManager = new RICAddOnManager();
  getAddOnManager(): RICAddOnManager {
    return this._addOnManager;
  }

  // Properties for Marty
  private _ricServoFaultDetector: RICServoFaultDetector | null = null;
  getRICServoFaultDetector(): RICServoFaultDetector {
    return this._ricServoFaultDetector!;
  }

  // RIC comms stats
  private _commsStats = new RICCommsStats();
  getCommsStats(): RICCommsStats {
    return this._commsStats;
  }

  // Event handler
  private _onEvent: RaftEventFn | null = null;

  // Raft system utils
  private _systemUtils: RaftSystemUtils | null = null;

  // Setup
  setup(systemUtils: RaftSystemUtils, onEvent: RaftEventFn | null): void {
    this._systemUtils = systemUtils;
    this._onEvent = onEvent;
    this._ricServoFaultDetector = new RICServoFaultDetector(this._systemUtils!.getMsgHandler(), this._ricStateInfo);
  }

  // Subscribe for updates
  async subscribeForUpdates(systemUtils: RaftSystemUtils, enable: boolean): Promise<void> {
    // Subscription rate
    const subscribeRateHz = 10;
    try {
      const pubRecs = enable
        ? [
            { name: "MultiStatus", rateHz: subscribeRateHz },
            { name: "PowerStatus", rateHz: 1.0 },
            { name: "AddOnStatus", rateHz: subscribeRateHz },
          ]
        : [
            { name: "MultiStatus", rateHz: 0 },
            { name: "PowerStatus", rateHz: 0 },
            { name: "AddOnStatus", rateHz: 0 },
          ];
      const subscribeMsg = JSON.stringify({ cmdName: "subscription", action: "update", pubRecs });

      const msgHandler = systemUtils.getMsgHandler();
      const ricResp = await msgHandler.sendRICRESTCmdFrame<RaftOKFail>(subscribeMsg);

      // Debug
      RaftLog.debug(`subscribe enable/disable returned ${JSON.stringify(ricResp)}`);
    } catch (error: unknown) {
      RaftLog.warn(`getRICCalibInfo Failed subscribe for updates ${error}`);
    }
  }

  // Invalidate state
  stateIsInvalid(): void {
    if (this._systemUtils) {
      this._systemUtils.invalidate();
    }
  }

  // Other message type
  rxOtherMsgType(payload: Uint8Array, frameTimeMs: number) {
    // RICLog.debug(`onRxROSSerialMsg payload ${RaftUtils.bufferToHex(payload)}`);
    RaftLog.verbose(`onRxROSSerialMsg payloadLen ${payload.length}`);
    const topicIDs = this._ricStateInfo.updateFromROSSerialMsg(payload, this._commsStats, this._addOnManager, frameTimeMs);

    // Call event handler if registered
    if (this._onEvent) {
      this._onEvent("pub", RaftPublishEvent.PUBLISH_EVENT_DATA, RaftPublishEventNames[RaftPublishEvent.PUBLISH_EVENT_DATA],
        {
          topicIDs: topicIDs,
          payload: payload,
          frameTimeMs: frameTimeMs
        });
    }
  }

  // Device manager interface
  deviceMgrIF = this._ricStateInfo;
}

