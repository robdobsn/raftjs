import RaftDeviceMgrIF from "./RaftDeviceMgrIF";
import RaftSystemUtils from "./RaftSystemUtils";
import { SystemCapabilities } from "./RaftCapabilities";
import { RaftEventFn } from "./RaftTypes";

export type RaftSubscribeForUpdatesCBType = (systemUtils: RaftSystemUtils, enable: boolean) => Promise<void>;
export type RaftStateIsInvalidCBType = () => void;
export type RaftRxOtherMsgType = (payload: Uint8Array, _frameTimeMs: number) => void;

export interface ConnectorOptions {
  /**
   * WebSocket path used when the locator is a bare host (default "ws").
   * Note that RaftConnector resolves the system type (and so these options) only
   * after the channel is connected, so a bare host locator always connects to
   * ws://<host>/ws and reconnects reuse that same URL. To use a different endpoint
   * pass a complete ws:// or wss:// URL as the locator. The endpoint must speak
   * RICSerial (binary) - raftjs cannot use a RICJSON text WebSocket.
   */
  wsSuffix?: string;
  connTimeoutMs?: number;
  bleConnItvlMs?: number;
  bleUuid?: string;
  syncTimeOnConnect?: boolean;  // Send UTC time to device after connecting (default: true)
}

export interface RaftSystemType {
  nameForDialogs: string;
  defaultWiFiHostname?: string;
  BLEServiceUUIDs?: string[];
  BLECmdUUID?: string;
  BLERespUUID?: string;
  BLEDeviceNames?: string[];
  firmwareDestName?: string;
  normalFileDestName?: string;
  connectorOptions: ConnectorOptions;
  // Static capability table (Layer A). Omit/undefined for fully-dynamic types
  // (e.g. Generic) - every gated call is then discovered at runtime.
  capabilities?: SystemCapabilities;
  setup: (systemUtils: RaftSystemUtils, onEvent: RaftEventFn | null) => void;
  subscribeForUpdates: RaftSubscribeForUpdatesCBType | null;
  stateIsInvalid: RaftStateIsInvalidCBType | null;
  rxOtherMsgType: RaftRxOtherMsgType | null;
  deviceMgrIF?: RaftDeviceMgrIF;
  nonRaftTypeCode?: string;
}

export type RaftGetSystemTypeCBType = (systemUtils: RaftSystemUtils) => Promise<RaftSystemType | null>;
