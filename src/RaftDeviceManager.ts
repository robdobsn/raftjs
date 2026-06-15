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
import { DeviceTypeInfo, DeviceTypeAction, DeviceTypeInfoRecs, DeviceTypePollRespMetadata, RaftDevTypeInfoResponse, SampleRateResult, getActionMapHex } from "./RaftDeviceInfo";
import AttributeHandler from "./RaftAttributeHandler";
import RaftSystemUtils from "./RaftSystemUtils";
import RaftDeviceMgrIF from "./RaftDeviceMgrIF";
import { structPack, structSizeOf } from "./RaftStruct";
// import RaftUtils from "./RaftUtils";

// Devbin record payload formats. See devdocs/devbin-protocol-versioning.md
// for the full naming scheme and how this axis relates to the (orthogonal)
// envelope axis.
//   DevbinV1Framed - current firmware: per-record body is
//                    [deviceSeq:1] [sampleLen:1][sample]...
//   DevbinV0Fixed  - Cog v1.9.5 firmware: per-record body is
//                    [sample][sample]... with each sample sized from typeinfo
//                    (no deviceSeq, no per-sample length prefix).
type DevbinPayloadFormat = "DevbinV1Framed" | "DevbinV0Fixed";

export interface DeviceDecodedData {
    deviceKey: string;
    busName: string;
    deviceAddress: string;
    deviceType: string;
    attrGroupName?: string;
    attrValues: Record<string, (number | string)[]>;
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

    // Rate-limit map for malformed-sample warnings (used by both devbin
    // payload formats).
    private _malformedSampleWarnLastMs: { [warningKey: string]: number } = {};

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
        // Current devbin envelope (3 bytes):
        //   Byte 0: magic+version   0xDB (valid range 0xDB–0xDF)
        //   Byte 1: topicIndex      0x00–0xFE = topic index; 0xFF = no topic
        //   Byte 2: envelopeSeqNum  uint8, wrapping — detects whole-frame drops
        //
        // Then zero or more per-device records, concatenated back-to-back:
        //   Bytes 0-1:  recordLen     uint16 big-endian — number of body bytes that follow (min 8)
        //   Byte  2:    statusBus     bit 7 = online flag, bit 6 = pending deletion, bits 3:0 = bus number
        //   Bytes 3-6:  address       uint32 big-endian — device address on the bus
        //   Bytes 7-8:  devTypeIdx    uint16 big-endian — device type table index
        //   Byte  9:    deviceSeqNum  uint8, wrapping — per-device drop detection
        //   Bytes 10+:  samples       length-prefixed: [sampleLen(1B)][sampleData(sampleLen B)] × N
        //
        // Backwards compatibility:
        //   Cog v1.9.5 is already in production and sends the older RaftCore devbin layout:
        //   no 3-byte envelope, no deviceSeqNum byte, and raw fixed-size samples
        //   [timestamp(2B)][payload] × N. Keep that path separate so current Axiom/Cog
        //   frames continue to use the length-prefixed parser above.
        //
        // Example message (two device records; first record has two samples):
        //   0080 DB 01 07 0018 81 0000076a 000b 2a 07feff0000010008 07185707931400 01 000e 80 00000000 001f 05 05030001af01
        //   ^^^^                                                                       ^^^^
        //   |    ^^ ^^ ^^                                                              Record 2 ...
        //   |    |  |  envelopeSeqNum = 0x07                                           (same layout as Record 1)
        //   |    |  topicIndex = 0x01
        //   |    magic+version = 0xDB (devbin v1)
        //   msgType prefix (transport layer)
        //
        //   Record 1 breakdown:
        //     0018               recordLen = 24 body bytes follow
        //     81                 statusBus: online=1, pendDel=0, bus=1
        //     0000076a           address = 0x0000076A (slot 7, I2C addr 0x6A)
        //     000b               devTypeIdx = 11
        //     2a                 deviceSeqNum = 42
        //     07 feff0000010008  sample 1: sampleLen=7, 7 bytes of attribute data
        //     07 18570793140001  sample 2: sampleLen=7, 7 bytes of attribute data
        //
        //   Record 2 breakdown:
        //     000e               recordLen = 14 body bytes follow
        //     80                 statusBus: online=1, pendDel=0, bus=0
        //     00000000           address = 0x00000000 (direct-connect)
        //     001f               devTypeIdx = 31
        //     05                 deviceSeqNum = 5
        //     05 030001af01      sample 1: sampleLen=5, 5 bytes of attribute data

        // Debug
        // const debugMsgTime = Date.now();
        const debugMsgIndex = this._debugMsgIndex++;

        // Message layout constants. Envelope variants and payload formats are
        // defined in devdocs/devbin-protocol-versioning.md.
        const msgTypeLen = 2; // Transport-layer message type prefix (first two bytes, e.g. 0x0080)
        const envelopeV2Len = 3; // EnvelopeV2: magic+version (1B) + topicIndex (1B) + envelopeSeqNum (1B)
        const envelopeV1Len = 2; // EnvelopeV1: magic+version (1B) + topicIndex (1B)
        const devbinMagicMin = 0xDB;
        const devbinMagicMax = 0xDF;
        const recordLenLen = 2; // Per-record length prefix (uint16 big-endian)
        const busInfoLen = 1; // statusBus byte: bit 7 = online, bit 6 = pending deletion, bits 3:0 = bus number
        const deviceAddrLen = 4; // Device address (uint32 big-endian)
        const devTypeIdxLen = 2; // Device type index (uint16 big-endian)
        const deviceSeqNumLen = 1; // Per-device sequence counter (DevbinV1Framed only)
        const devbinV1FramedHeaderLen = busInfoLen + deviceAddrLen + devTypeIdxLen + deviceSeqNumLen; // = 8, min DevbinV1Framed record body
        const devbinV0FixedHeaderLen = busInfoLen + deviceAddrLen + devTypeIdxLen; // = 7, DevbinV0Fixed record body header (Cog v1.9.5)

        // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} rxMsg.length ${rxMsg.length} rxMsg ${RaftUtils.bufferToHex(rxMsg)}`);

        // Default to EnvelopeNone + DevbinV0Fixed (no envelope, payload starts
        // right after the transport msgType), which is what Cog v1.9.5 firmware
        // emits. If an EnvelopeV1/V2 prefix is detected the payload format is
        // re-resolved below.
        let msgPos = msgTypeLen;
        let payloadFormat: DevbinPayloadFormat = "DevbinV0Fixed";

        // Check for a devbin envelope (EnvelopeV1: magic+topic; EnvelopeV2: magic+topic+seq)
        if (rxMsg.length >= msgTypeLen + envelopeV1Len) {
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

                // Try EnvelopeV2 (3 bytes) first, then fall back to EnvelopeV1
                // (2 bytes, intermediate firmware between Cog v1.9.5 and current).
                const envelopeV2RecordPos = msgTypeLen + envelopeV2Len;
                const envelopeV1RecordPos = msgTypeLen + envelopeV1Len;
                if (this.hasValidRecordAt(rxMsg, envelopeV2RecordPos, recordLenLen, devbinV1FramedHeaderLen)) {
                    msgPos = envelopeV2RecordPos;
                    payloadFormat = "DevbinV1Framed";
                } else if (this.hasValidRecordAt(rxMsg, envelopeV1RecordPos, recordLenLen, devbinV0FixedHeaderLen)) {
                    msgPos = envelopeV1RecordPos;
                    payloadFormat = "DevbinV0Fixed";
                } else {
                    console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid devbin envelope payload`);
                    return;
                }
            } else if (this.hasValidRecordAt(rxMsg, msgPos, recordLenLen, devbinV1FramedHeaderLen)) {
                // EnvelopeNone, but the first record validates as DevbinV1Framed
                payloadFormat = "DevbinV1Framed";
            }
        }

        // Iterate through device records
        while (msgPos < rxMsg.length) {

            // Check minimum length for record length prefix + record header.
            // Use the DevbinV0Fixed (smaller) header here as the floor; the
            // per-record payload-format resolution below validates the larger
            // DevbinV1Framed header when applicable.
            const remainingLen = rxMsg.length - msgPos;
            if (remainingLen < recordLenLen + devbinV0FixedHeaderLen) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid length ${rxMsg.length} < ${recordLenLen + devbinV0FixedHeaderLen + msgPos}`);
                return;
            }

            // Get the record body length (bytes that follow the 2-byte length prefix)
            const recordLen = (rxMsg[msgPos] << 8) + rxMsg[msgPos + 1];
            if ((recordLen < devbinV0FixedHeaderLen) || (recordLen > remainingLen - recordLenLen)) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid msgPos ${msgPos} recordLen ${recordLen} remainingAfterLenBytes ${remainingLen - recordLenLen}`);
                return;
            }

            // Extract record header fields
            let recordPos = msgPos + recordLenLen;

            // statusBus byte: bit 7 = online, bit 6 = pending deletion, bits 3:0 = bus number
            const statusByte = rxMsg[recordPos];
            const busNum = statusByte & 0x0f;
            const isOnline = (statusByte & 0x80) !== 0;
            recordPos += busInfoLen;

            // Device address (uint32 big-endian)
            const devAddr = (rxMsg[recordPos] << 24) + (rxMsg[recordPos + 1] << 16) + (rxMsg[recordPos + 2] << 8) + rxMsg[recordPos + 3];
            recordPos += deviceAddrLen;

            // Device type index (uint16 big-endian)
            const devTypeIdx = (rxMsg[recordPos] << 8) + rxMsg[recordPos + 1];
            recordPos += devTypeIdxLen;

            // Common record header ends here. The deviceSeqNum byte is only
            // present in DevbinV1Framed records.
            const commonRecordHeaderEndPos = recordPos;
            const samplesEndPos = msgPos + recordLenLen + recordLen;

            // Resolve per-record payload format using the type schema (if
            // already cached). DevbinV0Fixed firmware reports bus=0 addr=0 for
            // all direct devices, so we briefly look up by bus/devTypeIdx to
            // find the schema before settling on the device key.
            let recordPayloadFormat = payloadFormat;
            let recordHeaderLen = recordPayloadFormat === "DevbinV1Framed" ? devbinV1FramedHeaderLen : devbinV0FixedHeaderLen;
            const resolvedDeviceTypeInfo = await this.getDeviceTypeInfo(busNum.toString(), devTypeIdx.toString());
            if (resolvedDeviceTypeInfo?.resp) {
                recordPayloadFormat = this.resolveRecordPayloadFormat(rxMsg, commonRecordHeaderEndPos,
                    samplesEndPos, resolvedDeviceTypeInfo.resp, recordPayloadFormat, deviceSeqNumLen);
                recordHeaderLen = recordPayloadFormat === "DevbinV1Framed" ? devbinV1FramedHeaderLen : devbinV0FixedHeaderLen;
            }
            if (recordLen < recordHeaderLen) {
                console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid msgPos ${msgPos} recordLen ${recordLen} recordHeaderLen ${recordHeaderLen}`);
                return;
            }

            // Pending-deletion is only meaningful for DevbinV1Framed records;
            // DevbinV0Fixed firmware reuses that bit for other status info.
            const isPendingDeletion = (recordPayloadFormat === "DevbinV1Framed") && ((statusByte & 0x40) !== 0);
            recordPos = commonRecordHeaderEndPos;
            if (recordPayloadFormat === "DevbinV1Framed") {
                // Per-device sequence counter (reserved for future drop detection)
                // const deviceSeqNum = rxMsg[recordPos];
                recordPos += deviceSeqNumLen;
            }

            let pollDataPos = recordPos;

            // Debug
            // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} overallLen ${rxMsg.length} recordStart ${msgPos} recordLen ${recordLen} ${pollDataPos} ${RaftUtils.bufferToHex(rxMsg.slice(msgPos, msgPos + recordLenLen + recordLen))}`);
            // console.log(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} bus ${busNum} isOnline ${isOnline} devAddr 0x${devAddr.toString(16)} devTypeIdx ${devTypeIdx} pollDataLen ${recordLen - recordHeaderLen}`);

            // Format device address as canonical hex and build device key.
            // For DevbinV0Fixed direct devices (bus=0 addr=0) different
            // devTypeIdx values would collide on the same "0_0" key, so
            // DevbinV0Fixed records disambiguate by appending the devTypeIdx.
            const devAddrHex = formatDeviceAddrHex(devAddr);
            const deviceKey = this.getBinaryDeviceKey(busNum, devAddrHex, devTypeIdx, recordPayloadFormat);

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

                // For DevbinV1Framed (current firmware) try the richer
                // per-device endpoint first (gives per-instance name/role),
                // then fall back to the bus/type schema. DevbinV0Fixed firmware
                // doesn't support the per-device endpoint (returns
                // failBusMissing) so we skip it entirely for DevbinV0Fixed
                // records to avoid noisy requests.
                const deviceTypeInfo = recordPayloadFormat === "DevbinV1Framed"
                    ? (await this.getDeviceTypeInfo(deviceKey)
                        ?? resolvedDeviceTypeInfo
                        ?? await this.getDeviceTypeInfo(busNum.toString(), devTypeIdx.toString()))
                    : (resolvedDeviceTypeInfo
                        ?? await this.getDeviceTypeInfo(busNum.toString(), devTypeIdx.toString()));
                
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
                            reportTimestampOffsetUs: 0,
                            totalSamplesAdded: 0,
                            emaLastSampleTimeUs: 0,
                            emaIntervalUs: 0,
                            emaPrevPollTimeUs: 0,
                            emaCalibrated: false,
                            emaCalibrationPolls: 0
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

                // Process samples within this record
                const attrLengthsBefore = this.snapshotAttrLengths(deviceState.deviceAttributes, pollRespMetadata);
                const timelineLenBefore = deviceState.deviceTimeline.timestampsUs.length;
                const totalSamplesBefore = deviceState.deviceTimeline.totalSamplesAdded;
                if (recordPayloadFormat === "DevbinV1Framed") {
                    while (pollDataPos < samplesEndPos) {

                        // Read sample length prefix
                        if (pollDataPos >= rxMsg.length) {
                            console.warn(`DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} pollDataPos ${pollDataPos} exceeds message length ${rxMsg.length}`);
                            break;
                        }
                        const sampleLen = rxMsg[pollDataPos];
                        pollDataPos += 1;

                        if (sampleLen === 0 || pollDataPos + sampleLen > samplesEndPos) {
                            break;
                        }

                        const sampleStartPos = pollDataPos;
                        const sampleEndPos = pollDataPos + sampleLen;
                        const newMsgBufIdx = this._attributeHandler.processMsgAttrGroup(rxMsg, sampleStartPos,
                            deviceState.deviceTimeline, pollRespMetadata,
                            deviceState.deviceAttributes,
                            this._maxDatapointsToStore,
                            {
                                deviceKey,
                                deviceType: deviceState.deviceType,
                                debugMsgIndex,
                                sampleStartIdx: sampleStartPos,
                                sampleEndIdx: sampleEndPos,
                            });

                        if (newMsgBufIdx < 0)
                        {
                            this.warnMalformedSample(
                                `${deviceKey}:${devTypeIdx}:DevbinV1Framed`,
                                `DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} skipped malformed sample ` +
                                `device=${deviceKey} devTypeIdx=${devTypeIdx} sampleLen=${sampleLen} respBytes=${pollRespMetadata.b}`
                            );
                            pollDataPos += sampleLen;
                            continue;
                        }

                        // Advance by sampleLen regardless of how much processMsgAttrGroup consumed
                        pollDataPos += sampleLen;
                        deviceState.stateChanged = true;
                    }
                } else {
                    const fixedSampleLen = this.getDevbinV0FixedSampleLen(pollRespMetadata, pollDataPos, samplesEndPos);
                    if (fixedSampleLen <= 0) {
                        this.warnMalformedSample(
                            `${deviceKey}:${devTypeIdx}:DevbinV0FixedLen`,
                            `DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} invalid DevbinV0Fixed sample length ` +
                            `device=${deviceKey} devTypeIdx=${devTypeIdx} respBytes=${pollRespMetadata.b}`
                        );
                    } else {
                        while (pollDataPos + fixedSampleLen <= samplesEndPos) {
                            const sampleStartPos = pollDataPos;
                            const sampleEndPos = pollDataPos + fixedSampleLen;
                            // DevbinV0Fixed records are not length-prefixed, but
                            // the fixed sample span gives the same bound.
                            const newMsgBufIdx = this._attributeHandler.processMsgAttrGroup(rxMsg, sampleStartPos,
                                deviceState.deviceTimeline, pollRespMetadata,
                                deviceState.deviceAttributes,
                                this._maxDatapointsToStore,
                                {
                                    deviceKey,
                                    deviceType: deviceState.deviceType,
                                    debugMsgIndex,
                                    sampleStartIdx: sampleStartPos,
                                    sampleEndIdx: sampleEndPos,
                                });

                            if (newMsgBufIdx < 0)
                            {
                                this.warnMalformedSample(
                                    `${deviceKey}:${devTypeIdx}:DevbinV0Fixed`,
                                    `DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} skipped malformed DevbinV0Fixed sample ` +
                                    `device=${deviceKey} devTypeIdx=${devTypeIdx} sampleLen=${fixedSampleLen} respBytes=${pollRespMetadata.b}`
                                );
                                pollDataPos += fixedSampleLen;
                                continue;
                            }

                            pollDataPos += fixedSampleLen;
                            deviceState.stateChanged = true;
                        }

                        if (pollDataPos < samplesEndPos) {
                            this.warnMalformedSample(
                                `${deviceKey}:${devTypeIdx}:DevbinV0FixedRemainder`,
                                `DevMan.handleClientMsgBinary debugIdx ${debugMsgIndex} skipped trailing DevbinV0Fixed sample bytes ` +
                                `device=${deviceKey} devTypeIdx=${devTypeIdx} remaining=${samplesEndPos - pollDataPos} sampleLen=${fixedSampleLen} respBytes=${pollRespMetadata.b}`
                            );
                        }
                    }
                }

                // Inform decoded-data callbacks
                this.emitDecodedData(deviceKey, busNum.toString(), devAddrHex, deviceState,
                    pollRespMetadata, attrLengthsBefore, timelineLenBefore);

                const newSamples = deviceState.deviceTimeline.totalSamplesAdded - totalSamplesBefore;
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

                    // Try the per-device endpoint first (current firmware) and
                    // fall back to the bus/type endpoint used by legacy
                    // firmware and the simulator.
                    const deviceTypeInfo = await this.getDeviceTypeInfo(deviceKey)
                        ?? await this.getDeviceTypeInfo(busName, deviceTypeName);

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
                                reportTimestampOffsetUs: 0,
                                totalSamplesAdded: 0,
                                emaLastSampleTimeUs: 0,
                                emaIntervalUs: 0,
                                emaPrevPollTimeUs: 0,
                                emaCalibrated: false,
                                emaCalibrationPolls: 0
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
                    const totalSamplesBefore = deviceState.deviceTimeline.totalSamplesAdded;

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

                    const newSamples = deviceState.deviceTimeline.totalSamplesAdded - totalSamplesBefore;
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

    private async getDeviceTypeInfo(deviceKey: string): Promise<DeviceTypeInfo | undefined>;
    private async getDeviceTypeInfo(busName: string, deviceType: string): Promise<DeviceTypeInfo | undefined>;
    private async getDeviceTypeInfo(deviceKeyOrBusName: string, deviceType?: string): Promise<DeviceTypeInfo | undefined> {
        // Two-form lookup:
        //   - single arg: ?deviceid=<deviceKey>  (current firmware)
        //   - two args:   ?bus=<busName>&type=<deviceType>  (Cog v1.9.5 firmware)
        // The two requests are tracked under independent cache keys so a
        // failed lookup on one form doesn't poison the other.
        const cacheKey = deviceType === undefined
            ? deviceKeyOrBusName
            : `bustype:${deviceKeyOrBusName}:${deviceType}`;
        const requestLabel = deviceType === undefined
            ? `deviceKey ${deviceKeyOrBusName}`
            : `bus ${deviceKeyOrBusName} type ${deviceType}`;

        // Check if already in cache
        if (cacheKey in this._cachedDeviceTypeRecs) {
            return this._cachedDeviceTypeRecs[cacheKey];
        }

        // Check if there's already a pending request for this device
        if (cacheKey in this._pendingDeviceTypeRequests) {
            // Add this request to the waiting queue
            return new Promise<DeviceTypeInfo | undefined>((resolve, reject) => {
                this._pendingDeviceTypeRequests[cacheKey].waitingQueue.push({ resolve, reject });
            });
        }

        // Check rate limiting for new requests
        if (cacheKey in this._cachedDeviceTypePreviousAttemptTimes) {
            const timeSinceLastAttempt = Date.now() - this._cachedDeviceTypePreviousAttemptTimes[cacheKey];
            if (timeSinceLastAttempt < this._minTimeBetweenDeviceTypeInfoRetrievalMs) {
                console.log(`DevMan.getDeviceTypeInfo rate limited for ${requestLabel}`);
                return undefined;
            }
        }

        // Create and cache the promise with an empty waiting queue
        const requestPromise = this.executeDeviceTypeInfoRequest(deviceKeyOrBusName, deviceType, cacheKey);
        this._pendingDeviceTypeRequests[cacheKey] = {
            promise: requestPromise,
            waitingQueue: []
        };

        try {
            const result = await requestPromise;

            // Resolve all waiting requests with the same result
            const waitingQueue = this._pendingDeviceTypeRequests[cacheKey].waitingQueue;
            waitingQueue.forEach(({ resolve }) => resolve(result));

            return result;
        } catch (error) {
            // Reject all waiting requests with the same error
            const waitingQueue = this._pendingDeviceTypeRequests[cacheKey].waitingQueue;
            waitingQueue.forEach(({ reject }) => reject(error));

            console.warn(`DevMan.getDeviceTypeInfo failed for ${requestLabel}: ${error}`);
            return undefined;
        } finally {
            // Clean up the pending request
            delete this._pendingDeviceTypeRequests[cacheKey];
        }
    }

    private async executeDeviceTypeInfoRequest(deviceKeyOrBusName: string, deviceType: string | undefined, cacheKey: string): Promise<DeviceTypeInfo | undefined> {
        this._cachedDeviceTypePreviousAttemptTimes[cacheKey] = Date.now();

        try {
            // Current firmware accepts the richer deviceid query with
            // per-instance name/role overrides; legacy (Cog v1.9.5) firmware
            // only knows bus/type.
            const cmd = deviceType === undefined
                ? "devman/typeinfo?deviceid=" + deviceKeyOrBusName
                : "devman/typeinfo?bus=" + deviceKeyOrBusName + "&type=" + deviceType;
            const msgHandler = this._systemUtils?.getMsgHandler();

            if (msgHandler) {
                const msgRslt = await msgHandler.sendRICRESTURL<RaftDevTypeInfoResponse>(cmd);
                if (msgRslt && msgRslt.rslt === "ok") {
                    // Merge devinfo (type-level) with top-level per-instance overrides (name, role)
                    const base: DeviceTypeInfo = msgRslt.devinfo
                        ? { ...msgRslt.devinfo }
                        : { name: "", desc: "", manu: "", type: "" };
                    if (msgRslt.name !== undefined) base.name = msgRslt.name;
                    if (msgRslt.role !== undefined) base.role = msgRslt.role;
                    this._cachedDeviceTypeRecs[cacheKey] = base;
                    return base;
                }
            }
            return undefined;
        } catch (error) {
            console.warn(`DeviceManager getDeviceTypeInfo error ${error}`);
            return undefined;
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // Devbin payload-format helpers. See devdocs/devbin-protocol-versioning.md.
    ////////////////////////////////////////////////////////////////////////////

    private hasValidRecordAt(rxMsg: Uint8Array, msgPos: number, recordLenLen: number, recordHeaderLen: number): boolean {
        if (msgPos === rxMsg.length) {
            return true;
        }
        if (msgPos < 0 || msgPos > rxMsg.length) {
            return false;
        }
        const remainingLen = rxMsg.length - msgPos;
        if (remainingLen < recordLenLen + recordHeaderLen) {
            return false;
        }
        const recordLen = (rxMsg[msgPos] << 8) + rxMsg[msgPos + 1];
        return (recordLen >= recordHeaderLen) && (recordLen <= remainingLen - recordLenLen);
    }

    private resolveRecordPayloadFormat(rxMsg: Uint8Array, commonRecordHeaderEndPos: number, samplesEndPos: number,
                pollRespMetadata: DeviceTypePollRespMetadata, preferredFormat: DevbinPayloadFormat,
                deviceSeqNumLen: number): DevbinPayloadFormat {
        const framedStartPos = commonRecordHeaderEndPos + deviceSeqNumLen;
        const framedValid = this.areDevbinV1FramedSamplesValid(rxMsg, framedStartPos, samplesEndPos, pollRespMetadata);
        const fixedSampleLen = this.getDevbinV0FixedSampleLen(pollRespMetadata, commonRecordHeaderEndPos, samplesEndPos);
        const fixedValid = this.areDevbinV0FixedSamplesValid(commonRecordHeaderEndPos, samplesEndPos, fixedSampleLen);

        if (fixedValid && !framedValid) {
            return "DevbinV0Fixed";
        }
        if (framedValid && !fixedValid) {
            return "DevbinV1Framed";
        }
        return preferredFormat;
    }

    private areDevbinV1FramedSamplesValid(rxMsg: Uint8Array, pollDataPos: number, samplesEndPos: number,
                pollRespMetadata: DeviceTypePollRespMetadata): boolean {
        if ((pollDataPos < 0) || (pollDataPos > samplesEndPos) || (samplesEndPos > rxMsg.length)) {
            return false;
        }
        if (pollDataPos === samplesEndPos) {
            return true;
        }
        const fixedSampleLen = this.getDevbinV1FramedSampleLen(pollRespMetadata);
        let sampleCount = 0;
        while (pollDataPos < samplesEndPos) {
            const sampleLen = rxMsg[pollDataPos];
            pollDataPos += 1;
            if ((sampleLen === 0) || (pollDataPos + sampleLen > samplesEndPos)) {
                return false;
            }
            if ((fixedSampleLen > 0) && (sampleLen !== fixedSampleLen)) {
                return false;
            }
            pollDataPos += sampleLen;
            sampleCount++;
        }
        return sampleCount > 0;
    }

    private areDevbinV0FixedSamplesValid(pollDataPos: number, samplesEndPos: number, fixedSampleLen: number): boolean {
        if ((fixedSampleLen <= 0) || (pollDataPos < 0) || (pollDataPos > samplesEndPos)) {
            return false;
        }
        const payloadLen = samplesEndPos - pollDataPos;
        return this.isDevbinV0FixedSampleLenValid(payloadLen, fixedSampleLen);
    }

    private isDevbinV0FixedSampleLenValid(payloadLen: number, fixedSampleLen: number): boolean {
        return (fixedSampleLen > 0) && (payloadLen > 0) && (payloadLen % fixedSampleLen === 0);
    }

    private getBinaryDeviceKey(busNum: number, devAddrHex: string, devTypeIdx: number, payloadFormat: DevbinPayloadFormat): string {
        const baseDeviceKey = getDeviceKey(busNum.toString(), devAddrHex);
        // DevbinV0Fixed direct devices all report bus=0 addr=0, so distinct
        // device types would otherwise collide on the same "0_0" key.
        if ((payloadFormat === "DevbinV0Fixed") && (busNum === 0) && (devAddrHex === "0")) {
            return `${baseDeviceKey}_${devTypeIdx}`;
        }
        return baseDeviceKey;
    }

    private getDevbinV0FixedSampleLen(pollRespMetadata: DeviceTypePollRespMetadata, pollDataPos: number, samplesEndPos: number): number {
        const timestampLen = 2;
        const payloadLen = samplesEndPos - pollDataPos;
        const declaredPayloadLen = pollRespMetadata.b;
        const declaredSampleLen = declaredPayloadLen > 0 ? timestampLen + declaredPayloadLen : 0;
        if (this.isDevbinV0FixedSampleLenValid(payloadLen, declaredSampleLen)) {
            return declaredSampleLen;
        }

        // DevbinV0Fixed records have no sampleLen prefix, so old firmware
        // sometimes needs a schema-derived fallback. Prefer .b whenever it
        // fits the actual record and only fall back when the record length
        // proves the declared size cannot be the fixed stride.
        const attrPayloadLen = this.getDevbinV0FixedAttrPayloadSize(pollRespMetadata);
        const attrSampleLen = attrPayloadLen !== undefined ? timestampLen + attrPayloadLen : 0;
        if ((attrPayloadLen !== undefined) &&
                (attrPayloadLen !== declaredPayloadLen) &&
                this.isDevbinV0FixedSampleLenValid(payloadLen, attrSampleLen)) {
            return attrSampleLen;
        }

        return declaredSampleLen;
    }

    private getDevbinV1FramedSampleLen(pollRespMetadata: DeviceTypePollRespMetadata): number {
        if (pollRespMetadata.c || pollRespMetadata.b <= 0) {
            return 0;
        }
        const timestampLen = 2;
        return timestampLen + pollRespMetadata.b;
    }

    private getDevbinV0FixedAttrPayloadSize(pollRespMetadata: DeviceTypePollRespMetadata): number | undefined {
        if (pollRespMetadata.c) {
            return undefined;
        }
        let attrPayloadLen = 0;
        for (const attrDef of pollRespMetadata.a) {
            if (!attrDef.t) {
                return undefined;
            }
            if (attrDef.at !== undefined) {
                return undefined;
            }
            try {
                attrPayloadLen += structSizeOf(attrDef.t);
            } catch {
                return undefined;
            }
        }
        return attrPayloadLen > 0 ? attrPayloadLen : undefined;
    }

    private warnMalformedSample(warningKey: string, message: string): void {
        const nowMs = Date.now();
        const lastWarnMs = this._malformedSampleWarnLastMs[warningKey] ?? 0;
        if (nowMs - lastWarnMs < 5000) {
            return;
        }
        this._malformedSampleWarnLastMs[warningKey] = nowMs;
        console.warn(message);
    }

    // Recover the firmware-side bus name and device address for a deviceKey
    // when issuing devman commands. Legacy direct-device keys synthesised by
    // getBinaryDeviceKey (e.g. "0_0_2") don't round-trip through parseDeviceKey,
    // so consult the live device state first and only fall back to parsing.
    private parseDeviceKeyForCommand(deviceKey: string): { bus: string; addr: string } {
        const deviceState = this._devicesState[deviceKey];
        if (deviceState) {
            return { bus: deviceState.busName, addr: deviceState.deviceAddress };
        }
        return parseDeviceKey(deviceKey);
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
        console.log(`DeviceManager sendAction ${deviceKey} action ${action.n} data ${data} map ${JSON.stringify(action.map)} keys ${action.map ? Object.keys(action.map) : 'none'}`);

        // For _conf.* actions, delegate to setSampleRate() which coordinates polling params
        if (action.n.startsWith('_conf.') && action.map && data.length === 1) {
            const result = await this.setSampleRate(deviceKey, data[0]);
            return result.ok;
        }

        let writeHexStr: string;

        // Check if action has a map - use mapped hex value directly
        if (action.map && data.length === 1) {
            const mapKey = String(data[0]);
            const mapEntry = action.map[mapKey];
            if (!mapEntry) {
                console.warn(`DeviceManager sendAction: no map entry for value ${mapKey} in action ${action.n}`);
                return false;
            }
            const mappedHex = getActionMapHex(mapEntry);
            // Map values may contain &-separated multi-writes (e.g. "1048&114C&0a26")
            const writes = mappedHex.split('&');
            const { bus: devBus, addr: devAddr } = this.parseDeviceKeyForCommand(deviceKey);
            try {
                const msgHandler = this._systemUtils?.getMsgHandler();
                if (!msgHandler) return false;
                for (const hexWr of writes) {
                    const cmd = "devman/cmdraw?bus=" + devBus + "&addr=" + devAddr + "&hexWr=" + hexWr;
                    console.log(`DeviceManager sendAction ${action.n} ${cmd}`);
                    const msgRslt = await msgHandler.sendRICRESTURL<RaftOKFail>(cmd);
                    if (msgRslt.rslt !== "ok") return false;
                }
                return true;
            } catch (error) {
                console.warn(`DeviceManager sendAction error ${error}`);
                return false;
            }
        } else {
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
            writeHexStr = this.toHex(writeBytes);
        }

        // Add prefix and postfix
        writeHexStr = (action.w ? action.w : "") + writeHexStr + (action.wz ? action.wz : "");

        // Parse the device key into bus and address components
        const { bus: devBus, addr: devAddr } = this.parseDeviceKeyForCommand(deviceKey);

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
    // Set sample rate with coordinated polling parameters
    // Finds the closest supported rate from the device's _conf.rate action,
    // calculates optimal intervalUs and numSamples, and sends a single
    // /devman/devconfig call to set all parameters atomically.
    ////////////////////////////////////////////////////////////////////////////

    public async setSampleRate(deviceKey: string, sampleRateHz: number, options?: {
        numSamples?: number;
        intervalUs?: number;
        maxNumSamples?: number;
    }): Promise<SampleRateResult> {
        // Look up device state and type info
        const deviceState = this._devicesState[deviceKey];
        if (!deviceState?.deviceTypeInfo) {
            return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: 0, intervalUs: 0, numSamples: 0, error: 'Device not found or type info not loaded' };
        }
        const typeInfo = deviceState.deviceTypeInfo;

        // Find the _conf.rate action
        const confRateAction = typeInfo.actions?.find(a => a.n === '_conf.rate');
        if (!confRateAction?.map) {
            // No _conf.rate action — use generic sample rate setting
            // Non-FIFO devices: poll once per sample period, 1 sample per read
            const samplePeriodUs = Math.round(1000000 / sampleRateHz);
            const numSamples = options?.numSamples ?? 1;
            const intervalUs = options?.intervalUs ?? Math.max(5000, samplePeriodUs);

            const { bus: devBus, addr: devAddr } = this.parseDeviceKeyForCommand(deviceKey);
            const cmd = `devman/devconfig?bus=${devBus}&addr=${devAddr}&intervalUs=${intervalUs}&numSamples=${numSamples}`;

            try {
                const msgHandler = this._systemUtils?.getMsgHandler();
                if (!msgHandler) {
                    return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: sampleRateHz, intervalUs, numSamples, error: 'No message handler available' };
                }
                const msgRslt = await msgHandler.sendRICRESTURL<RaftOKFail>(cmd);
                const ok = msgRslt.rslt === 'ok';
                return { ok, requestedRateHz: sampleRateHz, actualRateHz: sampleRateHz, intervalUs, numSamples, error: ok ? undefined : `Firmware returned: ${msgRslt.rslt}` };
            } catch (error) {
                return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: sampleRateHz, intervalUs, numSamples, error: `${error}` };
            }
        }

        // Find the closest supported rate from the map keys
        const supportedRates = Object.keys(confRateAction.map).map(Number).filter(r => !isNaN(r)).sort((a, b) => a - b);
        if (supportedRates.length === 0) {
            return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: 0, intervalUs: 0, numSamples: 0, error: 'No valid rates in _conf.rate map' };
        }

        let actualRate = supportedRates[0];
        let minDist = Math.abs(sampleRateHz - actualRate);
        for (const rate of supportedRates) {
            const dist = Math.abs(sampleRateHz - rate);
            if (dist < minDist) {
                minDist = dist;
                actualRate = rate;
            }
        }

        // Look up map entry for the matched rate — may be object with recommended polling params
        const mapEntry = confRateAction.map[String(actualRate)];
        const mapObj = typeof mapEntry === 'object' ? mapEntry : null;
        const recommendedIntervalUs = mapObj?.i;
        const recommendedNumSamples = mapObj?.s;

        // Calculate inter-sample period
        const samplePeriodUs = Math.round(1000000 / actualRate);

        // Calculate optimal numSamples and intervalUs
        // Priority: explicit options > map entry recommendations > auto-calculation
        const maxNumSamples = options?.maxNumSamples ?? 20;
        let numSamples: number;
        let intervalUs: number;

        if (options?.numSamples !== undefined && options?.intervalUs !== undefined) {
            // Both explicitly specified — use as-is
            numSamples = options.numSamples;
            intervalUs = options.intervalUs;
        } else if (options?.intervalUs !== undefined) {
            // intervalUs specified, derive numSamples from it
            intervalUs = options.intervalUs;
            numSamples = options?.numSamples ?? recommendedNumSamples ??
                Math.max(1, Math.min(maxNumSamples, Math.floor(intervalUs / samplePeriodUs)));
        } else if (options?.numSamples !== undefined) {
            // numSamples specified, derive intervalUs from it
            numSamples = options.numSamples;
            intervalUs = recommendedIntervalUs ??
                Math.round(numSamples * samplePeriodUs * 0.8);
        } else if (recommendedIntervalUs !== undefined && recommendedNumSamples !== undefined) {
            // Use map entry recommendations
            intervalUs = recommendedIntervalUs;
            numSamples = recommendedNumSamples;
        } else {
            // Auto-calculate: target ~50ms poll interval, bounded by sample rate
            const targetPollIntervalUs = 50000;
            numSamples = recommendedNumSamples ??
                Math.max(1, Math.min(maxNumSamples, Math.floor(targetPollIntervalUs / samplePeriodUs)));
            intervalUs = recommendedIntervalUs ??
                Math.max(5000, Math.min(1000000, Math.round(numSamples * samplePeriodUs * 0.8)));
        }

        // Send single devconfig call with all parameters
        const { bus: devBus, addr: devAddr } = this.parseDeviceKeyForCommand(deviceKey);
        const cmd = `devman/devconfig?bus=${devBus}&addr=${devAddr}&sampleRateHz=${actualRate}&intervalUs=${intervalUs}&numSamples=${numSamples}`;

        try {
            const msgHandler = this._systemUtils?.getMsgHandler();
            if (!msgHandler) {
                return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: actualRate, intervalUs, numSamples, error: 'No message handler available' };
            }
            const msgRslt = await msgHandler.sendRICRESTURL<RaftOKFail>(cmd);
            const ok = msgRslt.rslt === 'ok';
            return { ok, requestedRateHz: sampleRateHz, actualRateHz: actualRate, intervalUs, numSamples, error: ok ? undefined : `Firmware returned: ${msgRslt.rslt}` };
        } catch (error) {
            return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: actualRate, intervalUs, numSamples, error: `${error}` };
        }
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

        const attrValues: Record<string, (number | string)[]> = {};
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
