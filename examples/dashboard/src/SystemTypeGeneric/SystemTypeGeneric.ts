import { RaftSubscribeForUpdatesCBType, RaftSystemType } from "../../../../src/RaftSystemType";
import { inspectPublishFrame, decodeCameraFramePublishMsg, RaftEventFn, RaftLog, RaftPublishEvent, RaftPublishEventNames, RaftSubscriptionUpdateResponse, RaftSystemUtils, SystemCapabilities } from "../../../../src/main";
import { StateInfoGeneric } from "./StateInfoGeneric";
import { DeviceManager } from "../../../../src/RaftDeviceManager";

const SUBSCRIBE_BINARY_MSGS = true;

export default class SystemTypeGeneric implements RaftSystemType {
    nameForDialogs = "Generic System";
    defaultWiFiHostname = "Generic";
    firmwareDestName = "ricfw";
    normalFileDestName = "fs";
    connectorOptions = {wsSuffix: "wsjson", bleConnItvlMs: 50};
    BLEServiceUUIDs = ["aa76677e-9cfd-4626-a510-0d305be57c8d", "da903f65-d5c2-4f4d-a065-d1aade7af874"];
    BLECmdUUID = "aa76677e-9cfd-4626-a510-0d305be57c8e";
    BLERespUUID = "aa76677e-9cfd-4626-a510-0d305be57c8f";

    // No static endpoint table - every gated call is discovered at runtime
    // (Layer B). Only tuning is declared, so BLE write size is set while endpoint
    // support stays fully dynamic.
    capabilities: SystemCapabilities = {
      tuning: { bleMaxWriteSize: 244 },
    };

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
    private _stateInfo: StateInfoGeneric = new StateInfoGeneric(this._deviceManager);
    getStateInfo(): StateInfoGeneric {
      return this._stateInfo;
    }

    // Subscribe for updates
    subscribeForUpdates: RaftSubscribeForUpdatesCBType | null = async (systemUtils: RaftSystemUtils, enable: boolean) => {
      // Subscription rate — must be high enough to match max polling rate
      const subscribeRateHz = 0.1;
      try {
        const topic = SUBSCRIBE_BINARY_MSGS ? "devbin" : "devjson";
        const subscribeDisable = '{"cmdName":"subscription","action":"update",' +
          '"pubRecs":[' +
          `{"name":"${topic}","rateHz":0}` +
          ']}';
        const subscribeEnable = '{"cmdName":"subscription","action":"update",' +
          '"pubRecs":[' +
          `{"name":"${topic}","trigger":"timeorchange","rateHz":${subscribeRateHz.toString()},"minMs":10}` +
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
      let topicNameForEvent = frameMeta.topicName;

      if (frameMeta.frameType === "binary") {
        if (frameMeta.binaryHasEnvelope) {
          if (frameMeta.topicName === "devbin") {
            this._stateInfo.handleBinaryPayload(payload);
            handledByDeviceManager = true;
          }
        } else if (SUBSCRIBE_BINARY_MSGS) {
          // Legacy path - no publish envelope, so the topic cannot be identified
          // from the frame. Older camera firmware publishes camera frames without
          // the envelope; sniff those out (valid camera header + JPEG SOI marker)
          // so they are not misparsed as devbin device records.
          const camFrame = decodeCameraFramePublishMsg(payload);
          if (camFrame && camFrame.jpegData.length >= 2 &&
              camFrame.jpegData[0] === 0xFF && camFrame.jpegData[1] === 0xD8) {
            topicNameForEvent = "Camera";
          } else {
            this._stateInfo.handleBinaryPayload(payload);
            handledByDeviceManager = true;
          }
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
            topicName: topicNameForEvent,
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
