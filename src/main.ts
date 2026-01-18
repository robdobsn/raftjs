/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftJS
// Commms library for the Raft ESP32 application framework supporting BLE, WebSockets and Serial
//
// Rob Dobson & Chris Greening 2020-2024
// (C) 2020-2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { createBLEChannel } from './RaftChannelBLEFactory';
const raftChannel = createBLEChannel();
export { raftChannel as RaftChannelBLE };

export { default as RaftCommsStats } from './RaftCommsStats';
export { default as RaftConnector } from './RaftConnector';
export { default as RaftChannel } from './RaftChannel';
export { default as RaftChannelWebSocket } from './RaftChannelWebSocket';
export { default as RaftChannelSimulated } from './RaftChannelSimulated';
export { default as RaftFileHandler } from './RaftFileHandler';
export { default as RaftLog } from './RaftLog';
export { default as RaftMiniHDLC } from './RaftMiniHDLC';
export { default as RaftMsgHandler } from './RaftMsgHandler'
export { default as RaftStreamHandler } from './RaftStreamHandler';
export { default as RaftSystemUtils } from './RaftSystemUtils';
export { default as RaftUtils } from './RaftUtils';
export { default as RaftSysTypeManager } from './RaftSysTypeManager';
export { default as RaftDeviceMgrIF } from './RaftDeviceMgrIF';
export { DeviceManager as RaftDeviceManager } from './RaftDeviceManager';
export type { DeviceDecodedData } from './RaftDeviceManager';

export * from './RaftTypes';
export * from './RaftSystemType';
export * from './RaftWifiTypes';
export * from './RaftConnEvents';
export * from './RaftUpdateEvents';
export * from "./RaftProtocolDefs";
export * from "./RaftDeviceStates";
export * from "./RaftDeviceInfo";
