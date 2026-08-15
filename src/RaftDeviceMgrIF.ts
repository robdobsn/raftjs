/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceMgrIF.ts
// Interface to devices state
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DeviceTypeAction, SampleRateResult } from "./RaftDeviceInfo";
import { DeviceAttributeState, DevicesState, DeviceState, DeviceStats } from "./RaftDeviceStates";

export default interface RaftDeviceMgrIF {

    // Get state of devices
    getDevicesState(): DevicesState;
    getDeviceState(deviceKey: string): DeviceState;
    getDeviceStats(deviceKey: string): DeviceStats;
    resetDeviceStats(deviceKey: string): void;

    // Settings
    setMaxDataPointsToStore(maxDataPointsToStore: number): void;

    // Callbacks
    addNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void;
    removeNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void;
    addNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void;
    removeNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void;
    addAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void;
    removeAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void;
    addDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void;
    removeDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void;

    // Send action to device
    sendAction(deviceKey: string, action: DeviceTypeAction, data: number[]): Promise<boolean>;
    sendCompoundAction(deviceKey: string, action: DeviceTypeAction, data: number[][]): Promise<boolean>;

    // Raw I2C write + read (returns read bytes, or null if unsupported/failed)
    cmdRawWriteRead(deviceKey: string, hexWr: string, numToRd: number, timeoutMs?: number): Promise<Uint8Array | null>;

    // Set sample rate with coordinated polling parameters
    setSampleRate(deviceKey: string, sampleRateHz: number, options?: {
        numSamples?: number;
        intervalUs?: number;
        maxNumSamples?: number;
    }): Promise<SampleRateResult>;
}
