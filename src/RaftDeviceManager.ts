/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceManager
// Device manager for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DeviceAttributeState, DeviceAttributesState, DevicesState, DeviceState, getDeviceKey } from "./RaftDeviceStates";
import { DeviceMsgJson } from "./RaftDeviceMsg";
import { RaftOKFail } from './RaftTypes';
import { DeviceTypeInfo, DeviceTypeAction, DeviceTypeInfoRecs, RaftDevTypeInfoResponse } from "./RaftDeviceInfo";
import AttributeHandler from "./RaftAttributeHandler";
import RaftSystemUtils from "./RaftSystemUtils";
import RaftDeviceMgrIF from "./RaftDeviceMgrIF";
import { structPack } from "./RaftStruct";
// import RaftUtils from "./RaftUtils";

export interface DeviceDecodedData {
    deviceKey: string;
    busName: string;
    deviceAddress: string;
    deviceType: string;
    attrGroupName?: string;
    attrValues: Record<string, number[]>;
    timestampsUs: number[];
    markers?: Record<string, unknown>;
    fromOfflineBuffer?: boolean;
}

export class DeviceManager implements RaftDeviceMgrIF{

    // Max data points to store
    private _maxDatapointsToStore = 1000;

    // Min time between attempts to retrieve device type info
    private _minTimeBetweenDeviceTypeInfoRetrievalMs = 60000;

    // Attribute handler
    private _attributeHandler = new AttributeHandler();

    // Devices state
    public _devicesState = new DevicesState();

    // Last time each device was updated - used to detect devices that are no longer present
    private _deviceLastUpdateTime: { [deviceKey: string]: number } = {};

    // Flag indicating that removed devices should be removed from the state
    private _removeDevicesFlag = true;
    private _removeDevicesTimeMs = 60000;

    // System utils
    private _systemUtils: RaftSystemUtils | null = null;

    // Device callbacks
    private _newDeviceCallbacks: Array<(deviceKey: string, state: DeviceState) => void> = [];
    private _newDeviceAttributeCallbacks: Array<(deviceKey: string, attrState: DeviceAttributeState) => void> = [];
    private _newAttributeDataCallbacks: Array<(deviceKey: string, attrState: DeviceAttributeState) => void> = [];
    private _decodedDataCallbacks: Array<(decoded: DeviceDecodedData) => void> = [];

    // Debug message index (to help debug with async messages)
    private _debugMsgIndex = 0;

    public getDevicesState(): DevicesState {
        return this._devicesState;
    }

    public getDeviceState(deviceKey: string): DeviceState {
        return this._devicesState[deviceKey];
    }

    // Cached device type data
    private _cachedDeviceTypeRecs: DeviceTypeInfoRecs = {};

    // Cached device type previous attempt times
    private _cachedDeviceTypePreviousAttemptTimes: { [deviceType: string]: number } = {};

    // Pending device type requests - queue-based to maintain order
    private _pendingDeviceTypeRequests: { [deviceType: string]: {
        promise: Promise<DeviceTypeInfo | undefined>;
        waitingQueue: Array<{resolve: (value: DeviceTypeInfo | undefined) => void, reject: (reason?: any) => void}>;
    } } = {};

    // Constructor
    constructor() {
    }

    ////////////////////////////////////////////////////////////////////////////
    // Settings
    ////////////////////////////////////////////////////////////////////////////

    public setMaxDataPointsToStore(maxDatapointsToStore: number): void {
        this._maxDatapointsToStore = maxDatapointsToStore;
        // console.log(`DeviceManager setMaxDataPointsToStore ${maxDatapointsToStore}`);
    }

    ////////////////////////////////////////////////////////////////////////////
    // Send REST commands
    ////////////////////////////////////////////////////////////////////////////

    async sendCommand(cmd: string): Promise<boolean> {
        try {
            // Get the msg handler
            const msgHandler = this._systemUtils?.getMsgHandler();
            if (msgHandler) {
                const msgRslt = await msgHandler.sendRICRESTURL<RaftOKFail>(cmd);
                return msgRslt.rslt === "ok";
            }
            return false;
        } catch (error) {
            console.warn(`DeviceManager sendCommand error ${error}`);
            return false;
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // Setup
    ////////////////////////////////////////////////////////////////////////////

    public async setup(systemUtils: RaftSystemUtils): Promise<boolean> {

        // Save the system utils
        this._systemUtils = systemUtils;
        return true;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Register callbacks
    ////////////////////////////////////////////////////////////////////////////

    public addNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        if (!this._newDeviceCallbacks.includes(callback)) {
            this._newDeviceCallbacks.push(callback);
        }
    }

    public removeNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        this._newDeviceCallbacks = this._newDeviceCallbacks.filter((cb) => cb !== callback);
    }

    public addNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        if (!this._newDeviceAttributeCallbacks.includes(callback)) {
            this._newDeviceAttributeCallbacks.push(callback);
        }
    }

    public removeNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        this._newDeviceAttributeCallbacks = this._newDeviceAttributeCallbacks.filter((cb) => cb !== callback);
    }

    public addAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        if (!this._newAttributeDataCallbacks.includes(callback)) {
            this._newAttributeDataCallbacks.push(callback);
        }
    }

    public removeAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        this._newAttributeDataCallbacks = this._newAttributeDataCallbacks.filter((cb) => cb !== callback);
    }

    public addDecodedDataCallback(callback: (decoded: DeviceDecodedData) => void): void {
        if (!this._decodedDataCallbacks.includes(callback)) {
            this._decodedDataCallbacks.push(callback);
        }
    }

    public removeDecodedDataCallback(callback: (decoded: DeviceDecodedData) => void): void {
        this._decodedDataCallbacks = this._decodedDataCallbacks.filter((cb) => cb !== callback);
    }

    ////////////////////////////////////////////////////////////////////////////
    // Set the friendly name for the device
    ////////////////////////////////////////////////////////////////////////////

    public async setFriendlyName(friendlyName: string): Promise<void> {
        // Set using utils
        await this._systemUtils?.setRaftName(friendlyName);
    }

    ////////////////////////////////////////////////////////////////////////////
    // Handle device message binary
    ////////////////////////////////////////////////////////////////////////////

    public async handleClientMsgBinary(rxMsg: Uint8Array) {
        // console.log(`DeviceManager client1 msg ${RaftUtils.bufferToHex(rxMsg)}`);

        // Example messages
        // 0080  0015 81 0000006a 0004 53b7 feff00000100081857079314  0011 80 00000000 0011 53b2 075106e400d60054  0010 80 00000000 0012 5231 000d0000010e01
        // 0080  0011 80 00000000 0002 4ae1 0787052606240007  000e 80 00000000 0003 0006 030001af01
        // 0080  0011 80 00000000 0002 e46e 061e05a206830433  0010 80000000000003e4760006030001c701
        // 0080  0010 81 00000015 0004 e4a2 0650fe00305002    0011 80000000000002e4a8061f059f06850438   001080000000000003e4aa0006030001c701
        
        // 0080  0011 80 00000000 0002 31e4 05ea05a506660137  000e 80 00000000 0003 0007 030001d901

        // 0080  0011 80 00000000 0002 4d63 0792053e06500061  000e 80 00000000 0003 0005 030001de01

        // First two bytes of each message are the message type (0080)
        // There are then a series of sections each of which is the data for a device
        //   First two bytes of each section is the section length (big endian) not including the section length bytes themselves
        //   Next byte is the connection mode (0 for direct connect, 1+ for bus number) and the MSB of this byte is 1 if the device is online
        //   Next is the device address (4 bytes big endian)
        //   Next is the device type index (2 bytes big endian)
        //   Finally the device data which can be one or more groups of attributes defined by the schema

        // Debug
        // const debugMsgTime = Date.now();
        const debugMsgIndex = this._debugMsgIndex++;

        // Message layout
        const msgTypeLen = 2; // Length of the message type (first two bytes)
        const sectionLengthLen = 2; // Length of the inclusive section length (first two bytes of each section)
        const sectionConnectionModeLen = 1; // Length of the connection mode (next byte after section length)
        const sectionDeviceAddrLen = 4; // Length of the device address (next 4 bytes after connection mode)
        const sectionDeviceTypeIdxLen = 2; // Length of the device type index (next 2 bytes after device address)
        const sectionHeaderLen = sectionConnectionModeLen + sectionDeviceAddrLen + sectionDeviceTypeIdxLen;

        // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} rxMsg.length ${rxMsg.length} rxMsg ${RaftUtils.bufferToHex(rxMsg)}`);

        // Start after the message type
        let msgPos = msgTypeLen;

        // Iterate through sections
        while (msgPos < rxMsg.length) {

            // Check length
            const remainingLen = rxMsg.length - msgPos;
            if (remainingLen < sectionLengthLen + sectionHeaderLen) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid length ${rxMsg.length} < ${sectionLengthLen + sectionHeaderLen + msgPos}`);
                return;
            }

            // Get the length of the section
            const sectionLen = (rxMsg[msgPos] << 8) + rxMsg[msgPos + 1];
            if (sectionLen > remainingLen + sectionLengthLen) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid msgPos ${msgPos} msgLen ${sectionLen} remainingLenAfterLenBytes ${remainingLen-sectionLengthLen}`);
                return;
            }

            // Extract message elements
            let sectionPos = msgPos + sectionLengthLen;
            const busNum = rxMsg[sectionPos] & 0x7f;
            const isOnline = (rxMsg[sectionPos] & 0x80) !== 0;
            sectionPos += sectionConnectionModeLen;
            // Get the device address and type index
            const devAddr = (rxMsg[sectionPos] << 24) + (rxMsg[sectionPos + 1] << 16) + (rxMsg[sectionPos + 2] << 8) + rxMsg[sectionPos + 3];
            sectionPos += sectionDeviceAddrLen;
            const devTypeIdx = (rxMsg[sectionPos] << 8) + rxMsg[sectionPos + 1];
            let attrGroupPos = sectionPos + sectionDeviceTypeIdxLen;

            // Debug
            // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} overallLen ${rxMsg.length} sectionPos ${msgPos} sectionLen ${sectionLen} ${attrGroupPos} ${RaftUtils.bufferToHex(rxMsg.slice(msgPos, msgPos + sectionLen))}`);
            // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} connMode ${busNum} isOnline ${isOnline} devAddr ${devAddr} devTypeIdx ${devTypeIdx} attrGroupDataLen ${sectionLen - sectionHeaderLen}`);

            // Device key
            const deviceKey = getDeviceKey(busNum.toString(), devAddr.toString(16));

            // Update the last update time
            this._deviceLastUpdateTime[deviceKey] = Date.now();

            // Check if a device state already exists
            if (!(deviceKey in this._devicesState) || (this._devicesState[deviceKey].deviceTypeInfo === undefined)) {

                // Get the device type info
                const deviceTypeInfo = await this.getDeviceTypeInfo(busNum.toString(), devTypeIdx.toString());
                
                // Debug
                // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} attrGroupPos ${attrGroupPos} busNum ${busNum} devAddr ${devAddr} devTypeIdx ${devTypeIdx} deviceTypeInfo ${JSON.stringify(deviceTypeInfo)}`);

                // Handle case where device type info is not available
                if (deviceTypeInfo === undefined) {
                    console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} deviceType ${devTypeIdx} info not available, skipping attribute processing for this section`);
                    // Skip to next section without processing attributes
                    msgPos += sectionLengthLen + sectionLen;
                    continue;
                }

                // Check if device record exists
                if (deviceKey in this._devicesState) {
                    if (deviceTypeInfo !== undefined) {
                        this._devicesState[deviceKey].deviceTypeInfo = deviceTypeInfo;
                        this._devicesState[deviceKey].deviceType = deviceTypeInfo.name || "";
                        this._devicesState[deviceKey].busName = busNum.toString();
                        this._devicesState[deviceKey].deviceAddress = devAddr.toString();
                    }
                } else {
                    // Create device record - device type info may be undefined
                    this._devicesState[deviceKey] = {
                        deviceTypeInfo: deviceTypeInfo,
                        deviceTimeline: {
                            timestampsUs: [],
                            lastReportTimestampUs: 0,
                            reportTimestampOffsetUs: 0
                        },
                        deviceAttributes: {},
                        deviceIsNew: true,
                        stateChanged: false,
                        isOnline: true,
                        deviceAddress: devAddr.toString(),
                        deviceType: deviceTypeInfo?.name || "",
                        busName: busNum.toString()
                    };
                }
            }

            // Get device state
            const deviceState = this._devicesState[deviceKey];
            deviceState.isOnline = isOnline;
            
            // Check if device type info is available and complete
            if (deviceState.deviceTypeInfo && deviceState.deviceTypeInfo.resp) {

                // Iterate over attributes in the group
                const pollRespMetadata = deviceState.deviceTypeInfo!.resp!;

                // Iterate over attribute groups
                const attrGroupDataLen = sectionLen - sectionHeaderLen;
                const attrGroupStartPos = attrGroupPos;
                const attrLengthsBefore = this.snapshotAttrLengths(deviceState.deviceAttributes, pollRespMetadata);
                const timelineLenBefore = deviceState.deviceTimeline.timestampsUs.length;
                while (attrGroupPos < attrGroupStartPos + attrGroupDataLen) {

                    // Add bounds checking
                    if (attrGroupPos >= rxMsg.length) {
                        console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} attrGroupPos ${attrGroupPos} exceeds message length ${rxMsg.length}`);
                        break;
                    }

                    const newMsgBufIdx = this._attributeHandler.processMsgAttrGroup(rxMsg, attrGroupPos,
                        deviceState.deviceTimeline, pollRespMetadata,
                        deviceState.deviceAttributes,
                        this._maxDatapointsToStore);

                    // console.log(`DevMan.handleClientMsgBinary decoded debugIdx ${debugMsgIndex} devType ${deviceState.deviceTypeInfo.name} attrGroupDataLen ${attrGroupDataLen} attrGroupPos ${attrGroupPos} sectionLen ${sectionLen} msgPos ${msgPos} rxMsgLen ${rxMsg.length} remainingLen ${remainingLen} pollRespMetadata ${JSON.stringify(pollRespMetadata)}`);

                    if (newMsgBufIdx < 0)
                    {
                        console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} processMsgAttrGroup failed newMsgBufIdx ${newMsgBufIdx}`);
                        break;
                    }
                    
                    // Prevent infinite loops
                    if (newMsgBufIdx <= attrGroupPos) {
                        console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} processMsgAttrGroup didn't advance position from ${attrGroupPos} to ${newMsgBufIdx}`);
                        break;
                    }

                    attrGroupPos = newMsgBufIdx;
                    deviceState.stateChanged = true;

                    // console.log(`debugMsgTime ${debugMsgTime} newPt debugMsgIdx ${debugMsgIndex} rxMsgLen ${rxMsg.length} devType ${deviceState.deviceTypeInfo!.name} timestampsUs ${deviceState.deviceTimeline.timestampsUs[deviceState.deviceTimeline.timestampsUs.length - 1]} curTimelineLen ${deviceState.deviceTimeline.timestampsUs.length}`);


                    // console.log(`DevMan.handleClientMsgBinary group done debugIdx ${debugMsgIndex} attrGroupPos ${attrGroupPos} sectionLen ${sectionLen} msgPos ${msgPos} rxMsgLen ${rxMsg.length} remainingLen ${remainingLen}`);
                }

                // Inform decoded-data callbacks
                this.emitDecodedData(deviceKey, busNum.toString(), devAddr.toString(), deviceState,
                    pollRespMetadata, attrLengthsBefore, timelineLenBefore);
            } else {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} deviceState incomplete for device ${deviceKey}, skipping attribute processing`);
            }

            // Debug
            // console.log(`DevMan.handleClientMsgBinary section done debugIdx ${debugMsgIndex} attrGroupPos ${attrGroupPos} sectionLen ${sectionLen} msgPos ${msgPos} newMsgPos ${msgPos + sectionLengthLen + sectionLen} rxMsgLen ${rxMsg.length} remainingLen ${remainingLen}`);

            // Move to next message
            msgPos += sectionLengthLen + sectionLen;
        }

        // Check for devices that have not been updated for a while
        if (this._removeDevicesFlag) {
            const nowTime = Date.now();
            Object.entries(this._deviceLastUpdateTime).forEach(([deviceKey, lastUpdateTime]) => {
                if ((nowTime - lastUpdateTime) > this._removeDevicesTimeMs) {
                    delete this._devicesState[deviceKey];
                }
            });
        }
        
        // Process the callback
        this.processStateCallback();
    }

    ////////////////////////////////////////////////////////////////////////////
    // Handle device message JSON
    ////////////////////////////////////////////////////////////////////////////

    public async handleClientMsgJson(jsonMsg: string) {

        const data = JSON.parse(jsonMsg) as DeviceMsgJson;
        // console.log(`DeviceManager client msg ${JSON.stringify(data)}`);

        // Iterate over the buses
        Object.entries(data).forEach(([busName, devices]) => {

            // Check for bus status info
            if (devices && typeof devices === "object" && "_s" in devices) {
                // console.log(`DeviceManager bus status ${JSON.stringify(devices._s)}`);
                return;
            }

            // Iterate over the devices
            Object.entries(devices).forEach(async ([devAddr, attrGroups]) => {

                // Check for non-device info (starts with _)
                if (devAddr.startsWith("_")) {
                    return;
                }

                // Device type name
                let deviceTypeName = "";
                let deviceTypeIdx = -1;
                if (attrGroups && typeof attrGroups === 'object' && "_t" in attrGroups && typeof attrGroups._t === "string") {
                    deviceTypeName = attrGroups._t || "";
                } else if (attrGroups && typeof attrGroups === 'object' && "_i" in attrGroups && typeof attrGroups._i === "number") {
                    deviceTypeIdx = attrGroups._i || -1;
                    deviceTypeName = deviceTypeIdx.toString();
                } else
                {
                    console.warn(`DeviceManager missing device type attrGroups ${JSON.stringify(attrGroups)}`);
                    return;
                }

                // Device key
                const deviceKey = getDeviceKey(busName, devAddr);

                // Update the last update time
                this._deviceLastUpdateTime[deviceKey] = Date.now();

                // Check if a device state already exists
                if (!(deviceKey in this._devicesState) || (this._devicesState[deviceKey].deviceTypeInfo === undefined)) {

                    // Get the device type info
                    const deviceTypeInfo = await this.getDeviceTypeInfo(busName, deviceTypeName);

                    // Check if device record exists
                    if (deviceKey in this._devicesState) {
                        if (deviceTypeInfo !== undefined) {
                            this._devicesState[deviceKey].deviceTypeInfo = deviceTypeInfo;
                            this._devicesState[deviceKey].deviceType = deviceTypeName;
                            this._devicesState[deviceKey].deviceAddress = devAddr;
                            this._devicesState[deviceKey].busName = busName;
                        }
                    } else {
                        // Create device record - device type info may be undefined
                        this._devicesState[deviceKey] = {
                            deviceTypeInfo: deviceTypeInfo,
                            deviceTimeline: {
                                timestampsUs: [],
                                lastReportTimestampUs: 0,
                                reportTimestampOffsetUs: 0
                            },
                            deviceAttributes: {},
                            deviceIsNew: true,
                            stateChanged: false,
                            isOnline: true,
                            deviceAddress: devAddr,
                            deviceType: deviceTypeName,
                            busName: busName
                        };
                    }
                }

                // Get device state
                const deviceState = this._devicesState[deviceKey];

                // Check for online/offline state information
                if (attrGroups && typeof attrGroups === "object" && "_o" in attrGroups) {
                    deviceState.isOnline = ((attrGroups._o === true) || (attrGroups._o === "1") || (attrGroups._o === 1));
                }

                // Check if device type info is available
                if (!deviceState.deviceTypeInfo) {
                    return;
                }

                const markers = this.extractMarkers(attrGroups);

                // Iterate attribute groups
                Object.entries(attrGroups).forEach(([attrGroupName, msgHexStr]) => {

                    // Check valid
                    if (attrGroupName.startsWith("_") || (typeof msgHexStr != 'string')) {
                        return;
                    }

                    // Check the device type info
                    if (!deviceState.deviceTypeInfo!.resp) {
                        return;
                    }

                    // Convert the hex string to an arraybuffer by converting each pair of hex chars to a byte
                    const msgBytes = this.hexToBytes(msgHexStr);

                    // Work through the message which may contain multiple data instances
                    let msgBufIdx = 0;

                    // Iterate over attributes in the group
                    const pollRespMetadata = deviceState.deviceTypeInfo!.resp!;

                    const attrLengthsBefore = this.snapshotAttrLengths(deviceState.deviceAttributes, pollRespMetadata);
                    const timelineLenBefore = deviceState.deviceTimeline.timestampsUs.length;

                    // Loop
                    while (msgBufIdx < msgBytes.length) {

                        const newMsgBufIdx = this._attributeHandler.processMsgAttrGroup(msgBytes, msgBufIdx,
                            deviceState.deviceTimeline, pollRespMetadata,
                            deviceState.deviceAttributes,
                            this._maxDatapointsToStore);
                        if (newMsgBufIdx < 0)
                            break;
                        msgBufIdx = newMsgBufIdx;
                        deviceState.stateChanged = true;
                    }

                    this.emitDecodedData(deviceKey, busName, devAddr, deviceState, pollRespMetadata,
                        attrLengthsBefore, timelineLenBefore, attrGroupName, markers);
                });
            });
        });

        // Check for devices that have not been updated for a while
        if (this._removeDevicesFlag) {
            const nowTime = Date.now();
            Object.entries(this._deviceLastUpdateTime).forEach(([deviceKey, lastUpdateTime]) => {
                if ((nowTime - lastUpdateTime) > this._removeDevicesTimeMs) {
                    delete this._devicesState[deviceKey];
                }
            });
        }
        
        // Process the callback
        this.processStateCallback();
    }

    ////////////////////////////////////////////////////////////////////////////
    // Process state change callback
    ////////////////////////////////////////////////////////////////////////////

    private processStateCallback() {

        // Iterate over the devices
        Object.entries(this._devicesState).forEach(([deviceKey, deviceState]) => {

            // Check if device record is new
            if (deviceState.deviceIsNew) {
                this._newDeviceCallbacks.forEach((cb) => cb(deviceKey, deviceState));
                deviceState.deviceIsNew = false;
            }

            // Iterate over the attributes
            Object.entries(deviceState.deviceAttributes).forEach(([, attrState]): void => {
                if (attrState.newAttribute) {
                    this._newDeviceAttributeCallbacks.forEach((cb) => cb(deviceKey, attrState));
                    attrState.newAttribute = false;
                }
                if (attrState.newData) {
                    this._newAttributeDataCallbacks.forEach((cb) => cb(deviceKey, attrState));
                    attrState.newData = false;
                }
            });
        });
    }

    ////////////////////////////////////////////////////////////////////////////
    // Get device type info
    ////////////////////////////////////////////////////////////////////////////

    private async getDeviceTypeInfo(busName: string, deviceType: string): Promise<DeviceTypeInfo | undefined> {
        // Check if already in cache
        if (deviceType in this._cachedDeviceTypeRecs) {
            return this._cachedDeviceTypeRecs[deviceType];
        }

        // Check if there's already a pending request for this device type
        if (deviceType in this._pendingDeviceTypeRequests) {
            // console.log(`DevMan.getDeviceTypeInfo joining existing request queue for deviceType ${deviceType}`);
            
            // Add this request to the waiting queue
            return new Promise<DeviceTypeInfo | undefined>((resolve, reject) => {
                this._pendingDeviceTypeRequests[deviceType].waitingQueue.push({ resolve, reject });
            });
        }

        // Check rate limiting for new requests
        if (deviceType in this._cachedDeviceTypePreviousAttemptTimes) {
            const timeSinceLastAttempt = Date.now() - this._cachedDeviceTypePreviousAttemptTimes[deviceType];
            if (timeSinceLastAttempt < this._minTimeBetweenDeviceTypeInfoRetrievalMs) {
                console.log(`DevMan.getDeviceTypeInfo rate limited for deviceType ${deviceType}`);
                return undefined;
            }
        }

        // Create and cache the promise with an empty waiting queue
        const requestPromise = this.executeDeviceTypeInfoRequest(busName, deviceType);
        this._pendingDeviceTypeRequests[deviceType] = {
            promise: requestPromise,
            waitingQueue: []
        };

        try {
            const result = await requestPromise;
            
            // Resolve all waiting requests with the same result
            const waitingQueue = this._pendingDeviceTypeRequests[deviceType].waitingQueue;
            waitingQueue.forEach(({ resolve }) => resolve(result));
            
            return result;
        } catch (error) {
            // Reject all waiting requests with the same error
            const waitingQueue = this._pendingDeviceTypeRequests[deviceType].waitingQueue;
            waitingQueue.forEach(({ reject }) => reject(error));
            
            console.warn(`DevMan.getDeviceTypeInfo failed for ${deviceType}: ${error}`);
            return undefined;
        } finally {
            // Clean up the pending request
            delete this._pendingDeviceTypeRequests[deviceType];
        }
    }

    private async executeDeviceTypeInfoRequest(busName: string, deviceType: string): Promise<DeviceTypeInfo | undefined> {
        this._cachedDeviceTypePreviousAttemptTimes[deviceType] = Date.now();
        
        try {
            const cmd = "devman/typeinfo?bus=" + busName + "&type=" + deviceType;
            const msgHandler = this._systemUtils?.getMsgHandler();
            
            if (msgHandler) {
                const msgRslt = await msgHandler.sendRICRESTURL<RaftDevTypeInfoResponse>(cmd);
                if (msgRslt && msgRslt.rslt === "ok") {
                    this._cachedDeviceTypeRecs[deviceType] = msgRslt.devinfo;
                    return msgRslt.devinfo;
                }
            }
            return undefined;
        } catch (error) {
            console.warn(`DeviceManager getDeviceTypeInfo error ${error}`);
            return undefined;
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // Send action to device
    ////////////////////////////////////////////////////////////////////////////

    private toHex(data: Uint8Array): string {
        return Array.from(data)
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("");
    }

    public async sendAction(deviceKey: string, action: DeviceTypeAction, data: number[]): Promise<boolean> {
        // console.log(`DeviceManager sendAction ${deviceKey} action name ${action.n} value ${value} prefix ${action.w}`);

        let writeBytes: Uint8Array;

        // Check for one data item
        if (data.length === 1) {

            let value = data[0];

            // Check for conversion
            if (action.sub !== undefined) {
                value = value - action.sub;
            }
            if (action.mul !== undefined) {
                value = value * action.mul;
            }

            // Form the write bytes
            writeBytes = action.t ? structPack(action.t, [value]) : new Uint8Array(0);

        } else
        {

            // Form the write bytes which may have multiple data items
            writeBytes = action.t ? structPack(action.t, data) : new Uint8Array(0);
        }

        // Convert to hex string
        let writeHexStr = this.toHex(writeBytes);

        // Add prefix and postfix
        writeHexStr = (action.w ? action.w : "") + writeHexStr + (action.wz ? action.wz : "");

        // Separate the bus and address in the deviceKey (_ char)
        const devBus = deviceKey.split("_")[0]
        const devAddr = deviceKey.split("_")[1]

        // Send the action to the server
        const cmd = "devman/cmdraw?bus=" + devBus + "&addr=" + devAddr + "&hexWr=" + writeHexStr;

        console.log(`DeviceManager deviceKey ${deviceKey} action name ${action.n} value ${data} prefix ${action.w} sendAction ${cmd}`);

        // Send the command
        try {

            // Get the msg handler
            const msgHandler = this._systemUtils?.getMsgHandler();
            if (msgHandler) {
                const msgRslt = await msgHandler.sendRICRESTURL<RaftOKFail>(cmd);
                return msgRslt.rslt === "ok";
            }
            return false;
        } catch (error) {
            console.warn(`DeviceManager sendAction error ${error}`);
            return false;
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // Send a compound action to the device
    ////////////////////////////////////////////////////////////////////////////

    public async sendCompoundAction(deviceKey: string, action: DeviceTypeAction, data: number[][]): Promise<boolean> {
        // console.log(`DeviceManager sendAction ${deviceKey} action name ${action.n} value ${value} prefix ${action.w}`);

        // Check if all data to be sent at once
        if (action.concat) {
            // Form a single list by flattening data
            let dataToWrite: number[] = [];
            for (let dataIdx = 0; dataIdx < data.length; dataIdx++) {
                dataToWrite = dataToWrite.concat(data[dataIdx]);
            }

            // Use sendAction to send this
            return await this.sendAction(deviceKey, action, dataToWrite);
        } else {
            // Iterate over the data
            let allOk = true;
            for (let dataIdx = 0; dataIdx < data.length; dataIdx++) {

                // Create the data to write by prepending the index to the data for this index
                const dataToWrite = [dataIdx as number].concat(data[dataIdx]);

                // Use sendAction to send this
                allOk = allOk && await this.sendAction(deviceKey, action, dataToWrite);
            }
        }
        return false;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Convert hex to bytes
    ////////////////////////////////////////////////////////////////////////////

    private hexToBytes(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return bytes;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Helpers for decoded data callbacks
    ////////////////////////////////////////////////////////////////////////////

    private snapshotAttrLengths(deviceAttrs: DeviceAttributesState, pollRespMetadata: DeviceTypeInfo["resp"]): Record<string, number> {
        const lengths: Record<string, number> = {};
        if (!pollRespMetadata) {
            return lengths;
        }
        pollRespMetadata.a.forEach((attr) => {
            lengths[attr.n] = deviceAttrs[attr.n]?.values.length || 0;
        });
        return lengths;
    }

    private emitDecodedData(
        deviceKey: string,
        busName: string,
        devAddr: string,
        deviceState: DeviceState,
        pollRespMetadata: DeviceTypeInfo["resp"],
        attrLengthsBefore: Record<string, number>,
        timelineLenBefore: number,
        attrGroupName = "",
        markers?: Record<string, unknown>,
    ): void {

        if (!pollRespMetadata) {
            return;
        }

        const attrValues: Record<string, number[]> = {};
        let hasValues = false;

        pollRespMetadata.a.forEach((attr) => {
            const attrState = deviceState.deviceAttributes[attr.n];
            if (!attrState) {
                return;
            }
            const prevLen = attrLengthsBefore[attr.n] || 0;
            if (attrState.values.length > prevLen) {
                attrValues[attr.n] = attrState.values.slice(prevLen);
                hasValues = hasValues || attrValues[attr.n].length > 0;
            }
        });

        if (!hasValues) {
            return;
        }

        const timestampsUs = deviceState.deviceTimeline.timestampsUs.slice(timelineLenBefore);

        const decoded: DeviceDecodedData = {
            deviceKey,
            busName,
            deviceAddress: devAddr,
            deviceType: deviceState.deviceType,
            attrGroupName: attrGroupName || undefined,
            attrValues,
            timestampsUs,
        };

        if (markers && Object.keys(markers).length > 0) {
            decoded.markers = markers;
            decoded.fromOfflineBuffer = this.isTruthy(markers["_buf"]);
        }

        this._decodedDataCallbacks.forEach((cb) => cb(decoded));
    }

    private extractMarkers(attrGroups: any): Record<string, unknown> {
        const markers: Record<string, unknown> = {};
        if (!attrGroups || typeof attrGroups !== "object") {
            return markers;
        }
        Object.entries(attrGroups).forEach(([key, value]) => {
            if (key.startsWith("_") && key !== "_t" && key !== "_o") {
                markers[key] = value;
            }
        });
        return markers;
    }

    private isTruthy(val: unknown): boolean {
        return val === true || val === 1 || val === "1";
    }
}
