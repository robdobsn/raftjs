/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceManager
// Device manager for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DeviceAttributeState, DeviceAttributesState, DevicesState, DeviceState, DeviceStats, DeviceOnlineState, formatDeviceAddrHex, getDeviceKey, parseDeviceKey } from "./RaftDeviceStates";
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

interface DeviceStatsInternal extends DeviceStats {
    windowEvents: Array<{ timeMs: number; samples: number }>;
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
    private _deviceRemovedCallbacks: Array<(deviceKey: string, state: DeviceState) => void> = [];

    // Debug message index (to help debug with async messages)
    private _debugMsgIndex = 0;

    // Device stats (sample counts, rates)
    private _statsWindowMs = 5000;
    private _deviceStats: { [deviceKey: string]: DeviceStatsInternal } = {};

    public getDevicesState(): DevicesState {
        return this._devicesState;
    }

    public getDeviceState(deviceKey: string): DeviceState {
        return this._devicesState[deviceKey];
    }

    public getDeviceStats(deviceKey: string): DeviceStats {
        return this.cloneDeviceStats(this.getOrCreateDeviceStats(deviceKey));
    }

    public resetDeviceStats(deviceKey: string): void {
        this._deviceStats[deviceKey] = this.createEmptyStats();
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

    public addDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        if (!this._deviceRemovedCallbacks.includes(callback)) {
            this._deviceRemovedCallbacks.push(callback);
        }
    }

    public removeDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        this._deviceRemovedCallbacks = this._deviceRemovedCallbacks.filter((cb) => cb !== callback);
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

        // DevBIN message format
        //
        // The rxMsg passed to this function has a 2-byte message type prefix (e.g. 0x0080)
        // added by the transport layer. After that prefix comes a devbin frame:
        //
        // Devbin envelope (2 bytes):
        //   Byte 0: magic+version  0xDB = devbin v1 (valid range 0xDB–0xDF for v1–v5)
        //   Byte 1: topicIndex     0x00–0xFE = topic index; 0xFF = no topic
        //
        // Then zero or more per-device records, concatenated back-to-back:
        //   Bytes 0-1:  recordLen    uint16 big-endian — number of body bytes that follow (min 7)
        //   Byte  2:    statusBus    bit 7 = online flag, bit 6 = pending deletion, bits 5:4 = reserved, bits 3:0 = bus number (0-15)
        //   Bytes 3-6:  address      uint32 big-endian — device address on the bus
        //   Bytes 7-8:  devTypeIdx   uint16 big-endian — device type table index
        //   Bytes 9+:   pollData     variable length (recordLen − 7 bytes) — device data
        //
        // Example message (with transport prefix):
        //   0080 DB01 0015 81 0000076a 000b bff10000ffffffff7a07d1f1221c 000e 80 00000000 001f bc340000030001
        //   ^^^^ ^^^^                                                     ^^^^
        //   |    |  |  ||   |          |    |                              Record 2 ...
        //   |    |  |  ||   |          |    pollData (14 bytes)
        //   |    |  |  ||   |          devTypeIdx = 0x000b (11)
        //   |    |  |  ||   address = 0x0000076a (slot 7, I2C addr 0x6a)
        //   |    |  |  |busInfo = 0x81 (bus 1, online)
        //   |    |  |  recordLen = 0x0015 (21 bytes)
        //   |    |  topicIndex = 0x01
        //   |    magic+version = 0xDB (devbin v1)
        //   msgType prefix (transport layer)

        // Debug
        // const debugMsgTime = Date.now();
        const debugMsgIndex = this._debugMsgIndex++;

        // Message layout constants
        const msgTypeLen = 2; // Transport-layer message type prefix (first two bytes, e.g. 0x0080)
        const devbinEnvelopeLen = 2; // Devbin envelope: magic+version (1 byte) + topicIndex (1 byte)
        const devbinMagicMin = 0xDB;
        const devbinMagicMax = 0xDF;
        const recordLenLen = 2; // Per-record length prefix (uint16 big-endian)
        const busInfoLen = 1; // statusBus byte: bit 7 = online, bit 6 = pending deletion, bits 3:0 = bus number
        const deviceAddrLen = 4; // Device address (uint32 big-endian)
        const devTypeIdxLen = 2; // Device type index (uint16 big-endian)
        const recordHeaderLen = busInfoLen + deviceAddrLen + devTypeIdxLen; // = 7, minimum record body

        // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} rxMsg.length ${rxMsg.length} rxMsg ${RaftUtils.bufferToHex(rxMsg)}`);

        // Start after the message type
        let msgPos = msgTypeLen;

        // Check for devbin envelope (magic+version + topicIndex)
        if (rxMsg.length >= msgTypeLen + devbinEnvelopeLen) {
            const envelopeMagicVer = rxMsg[msgTypeLen];
            if ((envelopeMagicVer & 0xF0) === 0xD0) {
                if ((envelopeMagicVer < devbinMagicMin) || (envelopeMagicVer > devbinMagicMax)) {
                    console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid devbin envelope magic/version ${envelopeMagicVer}`);
                    return;
                }

                const topicIndex = rxMsg[msgTypeLen + 1];
                if (topicIndex !== 0xFF) {
                    const topicName = this._systemUtils?.getPublishTopicName(topicIndex);
                    if (topicName && topicName !== "devbin") {
                        return;
                    }
                }

                msgPos += devbinEnvelopeLen;
            }
        }

        // Iterate through device records
        while (msgPos < rxMsg.length) {

            // Check minimum length for record length prefix + record header
            const remainingLen = rxMsg.length - msgPos;
            if (remainingLen < recordLenLen + recordHeaderLen) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid length ${rxMsg.length} < ${recordLenLen + recordHeaderLen + msgPos}`);
                return;
            }

            // Get the record body length (bytes that follow the 2-byte length prefix)
            const recordLen = (rxMsg[msgPos] << 8) + rxMsg[msgPos + 1];
            if (recordLen > remainingLen - recordLenLen) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid msgPos ${msgPos} recordLen ${recordLen} remainingAfterLenBytes ${remainingLen - recordLenLen}`);
                return;
            }

            // Extract record header fields
            let recordPos = msgPos + recordLenLen;

            // statusBus byte: bit 7 = online, bit 6 = pending deletion, bits 3:0 = bus number
            const statusByte = rxMsg[recordPos];
            const busNum = statusByte & 0x0f;
            const isOnline = (statusByte & 0x80) !== 0;
            const isPendingDeletion = (statusByte & 0x40) !== 0;
            recordPos += busInfoLen;

            // Device address (uint32 big-endian)
            const devAddr = (rxMsg[recordPos] << 24) + (rxMsg[recordPos + 1] << 16) + (rxMsg[recordPos + 2] << 8) + rxMsg[recordPos + 3];
            recordPos += deviceAddrLen;

            // Device type index (uint16 big-endian)
            const devTypeIdx = (rxMsg[recordPos] << 8) + rxMsg[recordPos + 1];
            let pollDataPos = recordPos + devTypeIdxLen;

            // Debug
            // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} overallLen ${rxMsg.length} recordStart ${msgPos} recordLen ${recordLen} ${pollDataPos} ${RaftUtils.bufferToHex(rxMsg.slice(msgPos, msgPos + recordLenLen + recordLen))}`);
            // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} bus ${busNum} isOnline ${isOnline} devAddr 0x${devAddr.toString(16)} devTypeIdx ${devTypeIdx} pollDataLen ${recordLen - recordHeaderLen}`);

            // Format device address as canonical hex and build device key
            const devAddrHex = formatDeviceAddrHex(devAddr);
            const deviceKey = getDeviceKey(busNum.toString(), devAddrHex);

            // Update the last update time
            this._deviceLastUpdateTime[deviceKey] = Date.now();

            // Handle pending deletion - remove device and skip further processing
            if (isPendingDeletion) {
                this.removeDevice(deviceKey);
                msgPos += recordLenLen + recordLen;
                continue;
            }

            // Check if a device state already exists
            if (!(deviceKey in this._devicesState) || (this._devicesState[deviceKey].deviceTypeInfo === undefined)) {

                // Get the device type info
                const deviceTypeInfo = await this.getDeviceTypeInfo(busNum.toString(), devTypeIdx.toString());
                
                // Debug
                // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} pollDataPos ${pollDataPos} busNum ${busNum} devAddr 0x${devAddr.toString(16)} devTypeIdx ${devTypeIdx} deviceTypeInfo ${JSON.stringify(deviceTypeInfo)}`);

                // Handle case where device type info is not available
                if (deviceTypeInfo === undefined) {
                    console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} deviceType ${devTypeIdx} info not available, skipping attribute processing for this record`);
                    // Skip to next record without processing attributes
                    msgPos += recordLenLen + recordLen;
                    continue;
                }

                // Check if device record exists
                if (deviceKey in this._devicesState) {
                    if (deviceTypeInfo !== undefined) {
                        this._devicesState[deviceKey].deviceTypeInfo = deviceTypeInfo;
                        this._devicesState[deviceKey].deviceType = deviceTypeInfo.name || "";
                        this._devicesState[deviceKey].busName = busNum.toString();
                        this._devicesState[deviceKey].deviceAddress = devAddrHex;
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
                        onlineState: DeviceOnlineState.Online,
                        deviceAddress: devAddrHex,
                        deviceType: deviceTypeInfo?.name || "",
                        busName: busNum.toString()
                    };
                }
            }

            // Get device state
            const deviceState = this._devicesState[deviceKey];
            deviceState.onlineState = isOnline ? DeviceOnlineState.Online : DeviceOnlineState.Offline;
            
            // Check if device type info is available and complete
            if (deviceState.deviceTypeInfo && deviceState.deviceTypeInfo.resp) {

                // Iterate over attributes in the group
                const pollRespMetadata = deviceState.deviceTypeInfo!.resp!;

                // Process poll data (recordLen - recordHeaderLen bytes)
                const pollDataLen = recordLen - recordHeaderLen;
                const pollDataStartPos = pollDataPos;
                const attrLengthsBefore = this.snapshotAttrLengths(deviceState.deviceAttributes, pollRespMetadata);
                const timelineLenBefore = deviceState.deviceTimeline.timestampsUs.length;
                while (pollDataPos < pollDataStartPos + pollDataLen) {

                    // Add bounds checking
                    if (pollDataPos >= rxMsg.length) {
                        console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} pollDataPos ${pollDataPos} exceeds message length ${rxMsg.length}`);
                        break;
                    }

                    const newMsgBufIdx = this._attributeHandler.processMsgAttrGroup(rxMsg, pollDataPos,
                        deviceState.deviceTimeline, pollRespMetadata,
                        deviceState.deviceAttributes,
                        this._maxDatapointsToStore);

                    // console.log(`DevMan.handleClientMsgBinary decoded debugIdx ${debugMsgIndex} devType ${deviceState.deviceTypeInfo.name} pollDataLen ${pollDataLen} pollDataPos ${pollDataPos} recordLen ${recordLen} msgPos ${msgPos} rxMsgLen ${rxMsg.length} remainingLen ${remainingLen} pollRespMetadata ${JSON.stringify(pollRespMetadata)}`);

                    if (newMsgBufIdx < 0)
                    {
                        console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} processMsgAttrGroup failed newMsgBufIdx ${newMsgBufIdx}`);
                        break;
                    }
                    
                    // Prevent infinite loops
                    if (newMsgBufIdx <= pollDataPos) {
                        console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} processMsgAttrGroup didn't advance position from ${pollDataPos} to ${newMsgBufIdx}`);
                        break;
                    }

                    pollDataPos = newMsgBufIdx;
                    deviceState.stateChanged = true;

                    // console.log(`debugMsgTime ${debugMsgTime} newPt debugMsgIdx ${debugMsgIndex} rxMsgLen ${rxMsg.length} devType ${deviceState.deviceTypeInfo!.name} timestampsUs ${deviceState.deviceTimeline.timestampsUs[deviceState.deviceTimeline.timestampsUs.length - 1]} curTimelineLen ${deviceState.deviceTimeline.timestampsUs.length}`);

                    // console.log(`DevMan.handleClientMsgBinary group done debugIdx ${debugMsgIndex} pollDataPos ${pollDataPos} recordLen ${recordLen} msgPos ${msgPos} rxMsgLen ${rxMsg.length} remainingLen ${remainingLen}`);
                }

                // Inform decoded-data callbacks
                this.emitDecodedData(deviceKey, busNum.toString(), devAddrHex, deviceState,
                    pollRespMetadata, attrLengthsBefore, timelineLenBefore);

                const newSamples = deviceState.deviceTimeline.timestampsUs.length - timelineLenBefore;
                this.updateDeviceStats(deviceKey, newSamples, Date.now());
            } else {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} deviceState incomplete for device ${deviceKey}, skipping attribute processing`);
            }

            // Debug
            // console.log(`DevMan.handleClientMsgBinary record done debugIdx ${debugMsgIndex} pollDataPos ${pollDataPos} recordLen ${recordLen} msgPos ${msgPos} newMsgPos ${msgPos + recordLenLen + recordLen} rxMsgLen ${rxMsg.length} remainingLen ${remainingLen}`);

            // Advance past this record (recordLenLen + recordLen bytes)
            msgPos += recordLenLen + recordLen;
        }

        // Check for devices that have not been updated for a while
        if (this._removeDevicesFlag) {
            const nowTime = Date.now();
            Object.entries(this._deviceLastUpdateTime).forEach(([deviceKey, lastUpdateTime]) => {
                if ((nowTime - lastUpdateTime) > this._removeDevicesTimeMs) {
                    delete this._devicesState[deviceKey];
                    delete this._deviceStats[deviceKey];
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

            // Check the bus name doesn't start with _ which is reserved for non-device information such as topic name
            if (busName.startsWith("_")) {
                return;
            }

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
                    deviceTypeIdx = attrGroups._i ?? -1;
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
                            onlineState: DeviceOnlineState.Online,
                            deviceAddress: devAddr,
                            deviceType: deviceTypeName,
                            busName: busName
                        };
                    }
                }

                // Get device state
                const deviceState = this._devicesState[deviceKey];

                // Check for online/offline/pending-deletion state information
                if (attrGroups && typeof attrGroups === "object" && "_o" in attrGroups) {
                    const onlineStateVal = typeof attrGroups._o === 'number' ? attrGroups._o : parseInt(String(attrGroups._o), 10);
                    if (onlineStateVal === 2) {
                        // Pending deletion - remove device and skip further processing
                        this.removeDevice(deviceKey);
                        return;
                    }
                    deviceState.onlineState = onlineStateVal === 1 ? DeviceOnlineState.Online : DeviceOnlineState.Offline;
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

                    const newSamples = deviceState.deviceTimeline.timestampsUs.length - timelineLenBefore;
                    this.updateDeviceStats(deviceKey, newSamples, Date.now());
                });
            });
        });

        // Check for devices that have not been updated for a while
        if (this._removeDevicesFlag) {
            const nowTime = Date.now();
            Object.entries(this._deviceLastUpdateTime).forEach(([deviceKey, lastUpdateTime]) => {
                if ((nowTime - lastUpdateTime) > this._removeDevicesTimeMs) {
                    delete this._devicesState[deviceKey];
                    delete this._deviceStats[deviceKey];
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
    // Remove a device (e.g. on pending deletion)
    ////////////////////////////////////////////////////////////////////////////

    private removeDevice(deviceKey: string): void {
        // Snapshot the state before removal for callbacks
        const deviceState = this._devicesState[deviceKey];
        if (deviceState) {
            deviceState.onlineState = DeviceOnlineState.PendingDeletion;
            this._deviceRemovedCallbacks.forEach((cb) => cb(deviceKey, deviceState));
        }
        delete this._devicesState[deviceKey];
        delete this._deviceLastUpdateTime[deviceKey];
        delete this._deviceStats[deviceKey];
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

        // Parse the device key into bus and address components
        const { bus: devBus, addr: devAddr } = parseDeviceKey(deviceKey);

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
    // Helpers for device stats
    ////////////////////////////////////////////////////////////////////////////

    private createEmptyStats(): DeviceStatsInternal {
        return {
            totalSamples: 0,
            windowMs: this._statsWindowMs,
            windowSamples: 0,
            sampleRateHz: 0,
            lastSampleTimeMs: null,
            lastUpdateTimeMs: null,
            windowEvents: []
        };
    }

    private getOrCreateDeviceStats(deviceKey: string): DeviceStatsInternal {
        if (!this._deviceStats[deviceKey]) {
            this._deviceStats[deviceKey] = this.createEmptyStats();
        }
        return this._deviceStats[deviceKey];
    }

    private cloneDeviceStats(stats: DeviceStatsInternal): DeviceStats {
        return {
            totalSamples: stats.totalSamples,
            windowMs: stats.windowMs,
            windowSamples: stats.windowSamples,
            sampleRateHz: stats.sampleRateHz,
            lastSampleTimeMs: stats.lastSampleTimeMs,
            lastUpdateTimeMs: stats.lastUpdateTimeMs
        };
    }

    private updateDeviceStats(deviceKey: string, newSamples: number, nowMs: number): void {
        const stats = this.getOrCreateDeviceStats(deviceKey);
        stats.lastUpdateTimeMs = nowMs;

        if (newSamples > 0) {
            stats.totalSamples += newSamples;
            stats.lastSampleTimeMs = nowMs;
            stats.windowEvents.push({ timeMs: nowMs, samples: newSamples });
        }

        const windowStartMs = nowMs - stats.windowMs;
        while (stats.windowEvents.length > 0 && stats.windowEvents[0].timeMs < windowStartMs) {
            stats.windowEvents.shift();
        }

        const windowSamples = stats.windowEvents.reduce((sum, entry) => sum + entry.samples, 0);
        stats.windowSamples = windowSamples;
        if (stats.windowEvents.length === 0) {
            stats.sampleRateHz = 0;
            return;
        }

        const actualWindowMs = Math.max(1, nowMs - stats.windowEvents[0].timeMs);
        stats.sampleRateHz = (windowSamples * 1000) / actualWindowMs;
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
            lengths[attr.n] = deviceAttrs[attr.n]?.values.length ?? 0;
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
            const prevLen = attrLengthsBefore[attr.n] ?? 0;
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
