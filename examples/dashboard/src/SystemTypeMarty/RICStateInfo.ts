import RaftDeviceMgrIF from "../../../../src/RaftDeviceMgrIF";
import { SampleRateResult } from "../../../../src/RaftDeviceInfo";
import { DeviceAttributeState, DevicesState, DeviceState, DeviceOnlineState } from '../../../../src/RaftDeviceStates';
import { RICSERIAL_PAYLOAD_POS } from "../../../../src/RaftProtocolDefs";
import RICAddOnManager from "./RICAddOnManager";
import RICCommsStats from "./RICCommsStats";
import { RICROSSerial, ROSCameraData, ROSSerialAddOnStatusList, ROSSerialIMU, ROSSerialPowerStatus, ROSSerialRobotStatus, ROSSerialSmartServos } from "./RICROSSerial";

export class RICStateInfo implements RaftDeviceMgrIF {
    smartServos: ROSSerialSmartServos = new ROSSerialSmartServos();
    smartServosValidMs = 0;
    imuData: ROSSerialIMU = new ROSSerialIMU();
    imuDataValidMs = 0;
    power: ROSSerialPowerStatus = new ROSSerialPowerStatus();
    powerValidMs = 0;
    addOnInfo: ROSSerialAddOnStatusList = new ROSSerialAddOnStatusList();
    addOnInfoValidMs = 0;
    robotStatus: ROSSerialRobotStatus = new ROSSerialRobotStatus();
    robotStatusValidMs = 0;
    cameraData: ROSCameraData = new ROSCameraData();
    cameraDataValidMs = 0;

    updateFromROSSerialMsg(rxMsg: Uint8Array, commsStats: RICCommsStats, 
              addOnManager: RICAddOnManager, frameTimeMs: number): Array<number> {
        return RICROSSerial.decode(
            rxMsg,
            RICSERIAL_PAYLOAD_POS,
            commsStats,
            addOnManager,
            this,
            frameTimeMs
          );    
    }

    getDevicesState(): DevicesState {

        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
        return {};
    }

    getDeviceState(deviceKey: string): DeviceState {

        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
        return {
            deviceTypeInfo: undefined,
            deviceTimeline: {
                timestampsUs: [],
                lastReportTimestampUs: 0,
                reportTimestampOffsetUs: 0,
                totalSamplesAdded: 0,
                emaLastSampleTimeUs: 0,
                emaIntervalUs: 0,
                emaPrevPollTimeUs: 0,
                emaCalibrated: false,
                emaCalibrationPolls: 0
            },
            deviceAttributes: {},
            deviceIsNew: false,
            stateChanged: false,
            onlineState: DeviceOnlineState.Offline,
            deviceAddress: "",
            deviceType: "",
            busName: ""
        };
    }

    setMaxDataPointsToStore(maxDataPointsToStore: number): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    addNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    removeNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    addNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    removeNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    addAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    removeAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    addDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    removeDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    sendAction(deviceKey: string, action: any, data: any): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    sendCompoundAction(deviceKey: string, action: any, data: any): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

    async setSampleRate(deviceKey: string, sampleRateHz: number, options?: {
        numSamples?: number; intervalUs?: number; maxNumSamples?: number;
    }): Promise<SampleRateResult> {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
        return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: 0, intervalUs: 0, numSamples: 0, error: 'Not implemented' };
    }

    getDeviceStats(deviceKey: string): any {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
        return {};
    }

    resetDeviceStats(deviceKey: string): void {
        // TODO - implement if RICStateInfo is to be used as a DeviceMgr
    }

  }
  