import RaftDeviceMgrIF from "./RaftDeviceMgrIF";
import RaftSystemUtils from "./RaftSystemUtils";
import { SystemCapabilities } from "./RaftCapabilities";
import { RaftEventFn } from "./RaftTypes";

export type RaftSubscribeForUpdatesCBType = (systemUtils: RaftSystemUtils, enable: boolean) => Promise<void>;
export type RaftStateIsInvalidCBType = () => void;
export type RaftRxOtherMsgType = (payload: Uint8Array, _frameTimeMs: number) => void;

export interface ConnectorOptions {
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
