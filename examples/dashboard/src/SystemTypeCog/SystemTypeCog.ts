import { RaftSubscribeForUpdatesCBType, RaftSystemType } from "../../../../src/RaftSystemType";
import { inspectPublishFrame, RaftEventFn, RaftLog, RaftPublishEvent, RaftPublishEventNames, RaftSubscriptionUpdateResponse, RaftSystemUtils } from "../../../../src/main";
import { CogStateInfo } from "./CogStateInfo";
import { DeviceManager } from "../../../../src/RaftDeviceManager";

const SUBSCRIBE_BINARY_MSGS = true;

export default class SystemTypeCog implements RaftSystemType {
    nameForDialogs = "Robotical Cog";
    defaultWiFiHostname = "Cog";
    firmwareDestName = "ricfw";
    normalFileDestName = "fs";
    connectorOptions = {wsSuffix: "wsjson", bleConnItvlMs: 50};
    BLEServiceUUIDs = ["da903f65-d5c2-4f4d-a065-d1aade7af874"];
    BLECmdUUID = "aa76677e-9cfd-4626-a510-0d305be57c8e";
    BLERespUUID = "aa76677e-9cfd-4626-a510-0d305be57c8f";

    // Event handler
    private _onEvent: RaftEventFn | null = null;

    // Raft system utils
    private _systemUtils: RaftSystemUtils | null = null;

    // Device manager
    private _deviceManager: DeviceManager = new DeviceManager();
    
    // Setup
    setup(systemUtils: RaftSystemUtils, onEvent: RaftEventFn | null): void {
      this._systemUtils = systemUtils;
      this._onEvent = onEvent;
      this._deviceManager.setup(systemUtils);
    }

    // Latest data from servos, IMU, etc
    private _stateInfo: CogStateInfo = new CogStateInfo(this._deviceManager);
    getStateInfo(): CogStateInfo {
      return this._stateInfo;
    }

    // Subscribe for updates
    subscribeForUpdates: RaftSubscribeForUpdatesCBType | null = async (systemUtils: RaftSystemUtils, enable: boolean) => {
      // Subscription rate
      const topic = SUBSCRIBE_BINARY_MSGS ? "devbin" : "devjson";
      const subscribeRateHz = 0.1;
      try {
        const subscribeDisable = '{"cmdName":"subscription","action":"update",' +
          '"pubRecs":[' +
          `{"name":"${topic}","rateHz":0,}` +
          ']}';
        const subscribeEnable = '{"cmdName":"subscription","action":"update",' +
          '"pubRecs":[' +
          `{"name":"${topic}","trigger":"timeorchange","rateHz":${subscribeRateHz.toString()}}` +
          ']}';

        const msgHandler = systemUtils.getMsgHandler();
        const ricResp = await msgHandler.sendRICRESTCmdFrame<RaftSubscriptionUpdateResponse>(
          enable ? subscribeEnable : subscribeDisable
        );

        // Cache topic index->name map from response, then refresh from pubtopics endpoint when enabling
        systemUtils.updatePublishTopicMapFromSubscriptionResponse(ricResp);
        if (enable) {
          await systemUtils.refreshPublishTopicMap();
        }

        // Debug
        RaftLog.debug(`subscribe enable/disable returned ${JSON.stringify(ricResp)}`);
      } catch (error: unknown) {
        RaftLog.warn(`getRICCalibInfo Failed subscribe for updates ${error}`);
      }
    };

    // Invalidate state
    stateIsInvalid(): void {};

    // Other message type
    rxOtherMsgType(payload: Uint8Array, frameTimeMs: number) {

      // RICLog.debug(`rxOtherMsgType payload ${RaftUtils.bufferToHex(payload)}`);
      RaftLog.verbose(`rxOtherMsgType payloadLen ${payload.length}`);

      const frameMeta = inspectPublishFrame(payload, (idx) => this._systemUtils?.getPublishTopicName(idx));
      let handledByDeviceManager = false;

      if (frameMeta.frameType === "binary") {
        if (frameMeta.binaryHasEnvelope) {
          if (frameMeta.topicName === "devbin") {
            this._stateInfo.handleBinaryPayload(payload);
            handledByDeviceManager = true;
          }
        } else if (SUBSCRIBE_BINARY_MSGS) {
          this._stateInfo.handleBinaryPayload(payload);
          handledByDeviceManager = true;
        }
      } else if (frameMeta.frameType === "json") {
        if (frameMeta.topicName === "devjson" || frameMeta.topicName === undefined) {
          if (frameMeta.jsonString !== undefined) {
            this._stateInfo.handleJsonPayload(frameMeta.jsonString);
            handledByDeviceManager = true;
          }
        }
      }

      const topicIDs = frameMeta.topicIndex !== undefined ? [frameMeta.topicIndex.toString()] : [];

      // Call event handler if registered
      if (this._onEvent) {
        this._onEvent("pub", RaftPublishEvent.PUBLISH_EVENT_DATA, RaftPublishEventNames[RaftPublishEvent.PUBLISH_EVENT_DATA],
          {
            topicIDs: topicIDs,
            topicName: frameMeta.topicName,
            topicIndex: frameMeta.topicIndex,
            topicVersion: frameMeta.version,
            frameType: frameMeta.frameType,
            handledByDeviceManager,
            payload: payload,
            frameTimeMs: frameTimeMs,
            isBinary: SUBSCRIBE_BINARY_MSGS
          });
      }
    };

    // Get device manager
    deviceMgrIF = this._deviceManager;
  }
