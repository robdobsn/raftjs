/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftAttributeHandler
// Attribute handler for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import CustomAttrHandler from "./RaftCustomAttrHandler";
import { DeviceTypeAttribute, DeviceTypePollRespMetadata, decodeAttrUnitsEncoding, isAttrTypeSigned } from "./RaftDeviceInfo";
import { DeviceAttributesState, DeviceTimeline } from "./RaftDeviceStates";
import { structSizeOf, structUnpack } from "./RaftStruct";
import RaftUtils from "./RaftUtils";

// Optional diagnostic context for attribute decoding. When provided, the
// handler emits a detailed warning if an attribute would read past the
// declared sample boundary or the end of the message buffer. This is used to
// track down firmware/schema mismatches.
export interface AttrDecodeDiagContext {
    deviceKey?: string;
    deviceType?: string;
    debugMsgIndex?: number;
    // Inclusive start (in msgBuffer) of the current sample's bytes (after the
    // 1-byte sampleLen prefix). When provided together with sampleEndIdx, the
    // handler will bound-check attribute reads against this range.
    sampleStartIdx?: number;
    // Exclusive end (in msgBuffer) of the current sample's bytes.
    sampleEndIdx?: number;
}

export default class AttributeHandler {

    // Custom attribute handler
    private _customAttrHandler = new CustomAttrHandler();

    // Message timestamp size
    private POLL_RESULT_TIMESTAMP_SIZE = 2;
    private POLL_RESULT_WRAP_VALUE = this.POLL_RESULT_TIMESTAMP_SIZE === 2 ? 65536 : 4294967296;
    private POLL_RESULT_RESOLUTION_US = 100;
    
    public processMsgAttrGroup(msgBuffer: Uint8Array, msgBufIdx: number, deviceTimeline: DeviceTimeline, pollRespMetadata: DeviceTypePollRespMetadata, 
                        devAttrsState: DeviceAttributesState, maxDataPoints: number,
                        diagCtx?: AttrDecodeDiagContext): number {
        
        // console.log(`processMsgAttrGroup msg ${msgHexStr} timestamp ${timestamp} origTimestamp ${origTimestamp} msgBufIdx ${msgBufIdx}`)

        // Per-sample decode boundary. The caller (DeviceManager) supplies a
        // sampleEndIdx when walking a multi-sample frame; without it we fall
        // back to the whole buffer. Clamp so it can't escape the buffer or
        // sit before the current read cursor.
        const rawSampleEnd = diagCtx?.sampleEndIdx ?? msgBuffer.length;
        const msgEndIdx = Math.min(Math.max(rawSampleEnd, msgBufIdx), msgBuffer.length);

        // Extract msg timestamp
        const { newBufIdx, timestampUs } = this.extractTimestampAndAdvanceIdx(msgBuffer, msgBufIdx, deviceTimeline, msgEndIdx);
        if (newBufIdx < 0)
            return -1;
        msgBufIdx = newBufIdx;

        // Start of message data
        const msgDataStartIdx = msgBufIdx;

        // New attribute values (in order as they appear in the attributes JSON)
        let newAttrValues: (number | string)[][] = [];
        // Tracks whether any individual attribute decode failed in the non-custom path.
        // When true, the detailed per-attribute overrun warning has already been emitted
        // by processMsgAttribute, so we suppress the redundant downstream length/empty
        // warnings that would otherwise fire every poll.
        let attrDecodeFailed = false;
        if ("c" in pollRespMetadata) {

            // Extract attribute values using custom handler
            newAttrValues = this._customAttrHandler.handleAttr(pollRespMetadata, msgBuffer, msgBufIdx, msgEndIdx);

            // Apply per-attribute transforms that the custom handler doesn't handle
            for (let attrIdx = 0; attrIdx < pollRespMetadata.a.length && attrIdx < newAttrValues.length; attrIdx++) {
                const attrDef = pollRespMetadata.a[attrIdx];
                if (newAttrValues[attrIdx].length === 0) continue;

                // Sign-extend values for signed types — the pseudocode produces unsigned
                // values from bitwise operations, but the attribute type declares signedness
                if (attrDef.t && isAttrTypeSigned(attrDef.t)) {
                    const byteWidth = structSizeOf(attrDef.t);
                    const signBit = 1 << (byteWidth * 8 - 1);
                    const range = signBit * 2;
                    newAttrValues[attrIdx] = newAttrValues[attrIdx].map(v => {
                        const n = v as number;
                        return (n & signBit) ? n - range : n;
                    });
                }

                if ("d" in attrDef && attrDef.d) {
                    const divisor = attrDef.d as number;
                    newAttrValues[attrIdx] = newAttrValues[attrIdx].map(v => (v as number) / divisor);
                }
                if ("a" in attrDef && attrDef.a !== undefined) {
                    const addend = attrDef.a as number;
                    newAttrValues[attrIdx] = newAttrValues[attrIdx].map(v => (v as number) + addend);
                }
            }

        } else {

            // console.log(`RaftAttrHdlr.processMsgAttrGroup ${JSON.stringify(pollRespMetadata)} msgBufIdx ${msgBufIdx} timestampUs ${timestampUs}`);

            // Iterate over attributes
            for (let attrIdx = 0; attrIdx < pollRespMetadata.a.length; attrIdx++) {

                // Get the attribute definition
                const attrDef: DeviceTypeAttribute = pollRespMetadata.a[attrIdx];
                if (!("t" in attrDef)) {
                    console.warn(`DeviceManager msg unknown msgBuffer ${msgBuffer} tsUs ${timestampUs} attrDef ${JSON.stringify(attrDef)}`);
                    newAttrValues.push([]);
                    attrDecodeFailed = true;
                    continue;
                }

                // console.log(`RaftAttrHdlr.processMsgAttrGroup attr ${attrDef.n} msgBufIdx ${msgBufIdx} timestampUs ${timestampUs} attrDef ${JSON.stringify(attrDef)}`);

                // Process the attribute
                const { values, newMsgBufIdx } = this.processMsgAttribute(attrDef, msgBuffer, msgBufIdx, msgDataStartIdx, msgEndIdx, pollRespMetadata, diagCtx);
                if (newMsgBufIdx < 0) {
                    newAttrValues.push([]);
                    attrDecodeFailed = true;
                    continue;
                }
                msgBufIdx = newMsgBufIdx;
                newAttrValues.push(values);
            }
        }
        
        // Number of bytes in group
        let pollRespSizeBytes = msgBufIdx - msgDataStartIdx;
        if (pollRespSizeBytes < pollRespMetadata.b) {
            pollRespSizeBytes = pollRespMetadata.b;
        }

        // Check if any attributes were added (in addition to timestamp)
        if (newAttrValues.length === 0) {
            if (!attrDecodeFailed) {
                console.warn(`DeviceManager msg attrGroup ${JSON.stringify(pollRespMetadata)} newAttrValues is empty`);
            }
            return msgDataStartIdx+pollRespSizeBytes;
        }

        // All attributes must have the same number of new values
        const numNewDataPoints = newAttrValues[0].length;
        for (let i = 1; i < newAttrValues.length; i++) {
            if (newAttrValues[i].length !== numNewDataPoints) {
                if (!attrDecodeFailed) {
                    console.warn(`DeviceManager msg attrGroup ${JSON.stringify(pollRespMetadata)} attrName ${pollRespMetadata.a[i].n} newAttrValues lengths ${newAttrValues.map(v => v.length).join(",")} do not match`);
                }
                return msgDataStartIdx+pollRespSizeBytes;
            }
        }

        // All attributes in the schema should have values
        if (newAttrValues.length !== pollRespMetadata.a.length) {
            if (!attrDecodeFailed) {
                console.warn(`DeviceManager msg attrGroup ${JSON.stringify(pollRespMetadata)} newAttrValues length ${newAttrValues.length} does not match attrGroup.a length ${pollRespMetadata.a.length}`);
            }
            return msgDataStartIdx+pollRespSizeBytes;
        }

        // Add the new attribute values to the device state
        for (let attrIdx = 0; attrIdx < pollRespMetadata.a.length; attrIdx++) {
            // Check if attribute already exists in the device state
            const attrDef: DeviceTypeAttribute = pollRespMetadata.a[attrIdx];
            if (!(attrDef.n in devAttrsState)) {
                devAttrsState[attrDef.n] = {
                    name: attrDef.n,
                    newAttribute: true,
                    newData: false,
                    numNewValues: 0,
                    values: [],
                    units: decodeAttrUnitsEncoding(attrDef.u || ""),
                    range: attrDef.r || [0, 0],
                    format: ("f" in attrDef && typeof attrDef.f == "string") ? attrDef.f : "",
                    visibleSeries: "v" in attrDef ? attrDef.v === 0 || attrDef.v === false : ("vs" in attrDef ? (attrDef.vs === 0 || attrDef.vs === false ? false : !!attrDef.vs) : true),
                    visibleForm: "v" in attrDef ? attrDef.v === 0 || attrDef.v === false : ("vf" in attrDef ? (attrDef.vf === 0 || attrDef.vf === false ? false : !!attrDef.vf) : true),
                };
            }

            // Check if any data points need to be discarded
            const discardCount = Math.max(0, devAttrsState[attrDef.n].values.length + newAttrValues[attrIdx].length - maxDataPoints);
            if (discardCount > 0) {
                devAttrsState[attrDef.n].values.splice(0, discardCount);
            }

            // Add the new values
            devAttrsState[attrDef.n].values.push(...newAttrValues[attrIdx]);
            devAttrsState[attrDef.n].newData = newAttrValues[attrIdx].length > 0;
            devAttrsState[attrDef.n].numNewValues = newAttrValues[attrIdx].length;
        }

        // --- Piecewise EMA timestamp reconstruction ---
        // Track the last assigned sample timestamp and step forward by emaIntervalUs
        // per sample. No T0 recomputation — avoids amplified batch-boundary jitter.
        const timeIncUs: number = pollRespMetadata.us ? pollRespMetadata.us : 1000;

        if (!deviceTimeline.emaCalibrated) {
            // Cold start: anchor so that sample 0 gets the poll timestamp
            deviceTimeline.emaIntervalUs = timeIncUs;
            deviceTimeline.emaLastSampleTimeUs = timestampUs - deviceTimeline.emaIntervalUs;
            deviceTimeline.emaPrevPollTimeUs = timestampUs;
            deviceTimeline.emaCalibrated = true;
            deviceTimeline.emaCalibrationPolls = 1;
        } else {
            // EMA interval update from poll-to-poll gap.
            // For multi-sample bursts the instant interval is the per-sample
            // period; for single-sample polls it's the poll-to-poll period
            // (which on 1-sample-per-poll devices is the only credible cadence
            // we have). Both feed the same smoothed EMA so a single anomalous
            // gap can't yank the model.
            let instantIntervalUs = NaN;
            if (numNewDataPoints > 1) {
                instantIntervalUs = (timestampUs - deviceTimeline.emaPrevPollTimeUs) / numNewDataPoints;
            } else if (numNewDataPoints === 1) {
                instantIntervalUs = timestampUs - deviceTimeline.emaPrevPollTimeUs;
            }
            if (Number.isFinite(instantIntervalUs) && instantIntervalUs > 0) {
                const alpha = deviceTimeline.emaCalibrationPolls < 20 ? 0.3 : 0.05;
                deviceTimeline.emaIntervalUs = alpha * instantIntervalUs
                                              + (1.0 - alpha) * deviceTimeline.emaIntervalUs;
            }
            deviceTimeline.emaPrevPollTimeUs = timestampUs;
            deviceTimeline.emaCalibrationPolls++;
        }

        // Assign timestamps: each sample steps forward by emaIntervalUs.
        // Single-sample polls use the live poll timestamp directly - there's
        // only one credible time for that sample and predicting from the model
        // just adds error.
        const timestampsUs = Array(numNewDataPoints).fill(0);
        const lastTimeUs = deviceTimeline.timestampsUs.length > 0
            ? deviceTimeline.timestampsUs[deviceTimeline.timestampsUs.length - 1]
            : -Infinity;
        for (let i = 0; i < numNewDataPoints; i++) {
            timestampsUs[i] = numNewDataPoints === 1
                ? timestampUs
                : deviceTimeline.emaLastSampleTimeUs + (i + 1) * deviceTimeline.emaIntervalUs;
            // Ensure monotonically increasing timestamps
            if (i === 0 && timestampsUs[0] <= lastTimeUs) {
                timestampsUs[0] = lastTimeUs + 1;
            } else if (i > 0 && timestampsUs[i] <= timestampsUs[i - 1]) {
                timestampsUs[i] = timestampsUs[i - 1] + 1;
            }
        }
        // Re-sync the model cursor to the last emitted timestamp so that any
        // monotonicity clamp or single-sample substitution above is reflected
        // in the next batch's predictions.
        if (deviceTimeline.emaCalibrated && numNewDataPoints > 0) {
            deviceTimeline.emaLastSampleTimeUs = timestampsUs[timestampsUs.length - 1];
        }

        // Check if timeline points need to be discarded
        const discardCount = Math.max(0, deviceTimeline.timestampsUs.length + timestampsUs.length - maxDataPoints);
        if (discardCount > 0) {
            deviceTimeline.timestampsUs.splice(0, discardCount);
        }

        // Add the new timestamps
        deviceTimeline.timestampsUs.push(...timestampsUs);
        deviceTimeline.totalSamplesAdded += numNewDataPoints;

        // Validate attributes based on the vft field
        this.validateAttributes(pollRespMetadata, devAttrsState, numNewDataPoints);

        // Return the next message buffer index
        return msgDataStartIdx+pollRespSizeBytes;
    }

    private validateAttributes(pollRespMetadata: DeviceTypePollRespMetadata, devAttrsState: DeviceAttributesState, numNewDataPoints: number): void {
        // Iterate through all attributes to find those with a vft field
        for (let attrIdx = 0; attrIdx < pollRespMetadata.a.length; attrIdx++) {
            const attrDef: DeviceTypeAttribute = pollRespMetadata.a[attrIdx];
            
            // Check if this attribute has a vft field
            if (!("vft" in attrDef) || !attrDef.vft) {
                continue;
            }

            // Get the name of the validating attribute
            const validatingAttrName = attrDef.vft;

            // Check if the validating attribute exists in the state
            if (!(validatingAttrName in devAttrsState)) {
                console.debug(`Cannot validate attribute ${attrDef.n} as validating attribute ${validatingAttrName} doesn't exist`);
                continue;
            }

            // Get the current attribute state
            const currentAttr = devAttrsState[attrDef.n];
            const validatingAttr = devAttrsState[validatingAttrName];

            // Check if both attributes have values
            if (!currentAttr.values.length || !validatingAttr.values.length) {
                continue;
            }

            // Get the most recent values from both attributes
            const numValues = currentAttr.values.length;
            const startIdx = numValues - numNewDataPoints;
            
            // Process each of the new values
            for (let i = 0; i < numNewDataPoints; i++) {
                const valueIdx = startIdx + i;
                if (valueIdx >= 0 && valueIdx < numValues) {
                    // Check if the validating attribute's value is 0/false at the same index
                    const validatingValueIdx = validatingAttr.values.length - numNewDataPoints + i;
                    if (validatingValueIdx >= 0 && validatingValueIdx < validatingAttr.values.length) {
                        // If the validating attribute's value is 0 or false, mark the current value as invalid
                        if (!validatingAttr.values[validatingValueIdx]) {
                            currentAttr.values[valueIdx] = NaN; // Using NaN to represent invalid values
                        }
                    }
                }
            }
        }
    }

    private processMsgAttribute(attrDef: DeviceTypeAttribute, msgBuffer: Uint8Array, msgBufIdx: number, msgDataStartIdx: number,
                                msgEndIdx: number,
                                pollRespMetadata?: DeviceTypePollRespMetadata, diagCtx?: AttrDecodeDiagContext): { values: (number | string)[], newMsgBufIdx: number} {

        // Current field message string index
        let curFieldBufIdx = msgBufIdx;
        let attrUsesAbsPos = false;

        // Check for "at" field which means absolute position in the buffer
        if (attrDef.at !== undefined) {
            // Handle both single value and array of byte positions
            if (Array.isArray(attrDef.at)) {
                // Create a new buffer for non-contiguous data extraction
                const elemSize = structSizeOf(attrDef.t);
                const bytesForType = new Uint8Array(elemSize);
                
                // Zero out the buffer
                bytesForType.fill(0);
                
                // Copy bytes from the specified positions
                for (let i = 0; i < attrDef.at.length && i < elemSize; i++) {
                    const sourceIdx = msgDataStartIdx + attrDef.at[i];
                    if (sourceIdx < msgBuffer.length) {
                        bytesForType[i] = msgBuffer[sourceIdx];
                    }
                }
                
                // Use this buffer for attribute extraction
                msgBuffer = bytesForType;
                curFieldBufIdx = 0;
            } else {
                // Standard absolute position in the buffer
                curFieldBufIdx = msgDataStartIdx + attrDef.at;
            }
            attrUsesAbsPos = true;
        }

        // Attribute type
        const attrTypesOnly = attrDef.t;

        // Get number of bytes required to decode this attribute
        const attrTypeSize = structSizeOf(attrTypesOnly);

        // Bound-check: against the message buffer, and against the declared
        // sample boundary. A failure here means the device's emitted bytes are
        // shorter than the registered device-type schema expects, or the
        // schema uses an absolute position (`at`) outside the sample.
        // Absolute-position reads (`at`) are bounded only by the buffer,
        // because `at` is intentionally a fixed offset relative to the sample
        // start and may legitimately fall outside the current decode cursor
        // window.
        const overrunsBuffer = curFieldBufIdx < 0 || curFieldBufIdx + attrTypeSize > msgBuffer.length;
        const overrunsSample = !attrUsesAbsPos && curFieldBufIdx + attrTypeSize > msgEndIdx;
        if (overrunsBuffer || overrunsSample) {
            this.warnAttrOverrun(attrDef, msgBuffer, curFieldBufIdx, attrTypeSize, msgDataStartIdx,
                                 attrUsesAbsPos, pollRespMetadata, diagCtx,
                                 overrunsBuffer ? "msgBuffer" : "sample");
            return { values: [], newMsgBufIdx: -1 };
        }

        // Slice into buffer
        const attrBuf = msgBuffer.slice(curFieldBufIdx);
 
        // Check if a mask is used and the value is signed
        const maskOnSignedValue = "m" in attrDef && isAttrTypeSigned(attrTypesOnly);

        // Extract the value using python-struct
        const unpackValues = structUnpack(maskOnSignedValue ? attrTypesOnly.toUpperCase() : attrTypesOnly, attrBuf);
        let attrValues = unpackValues as (number | string)[];

        // Number of bytes consumed equals the type size computed above
        const numBytesConsumed = attrTypeSize;

        // Check if any values are strings (from 's' format) — skip numeric transforms for those
        const hasStringValues = attrValues.some(v => typeof v === 'string');

        // // Check if sign extendable mask specified on signed value
        // if (mmSpecifiedOnSignedValue) {
        //     const signBitMask = 1 << (signExtendableMaskSignPos - 1);
        //     const valueOnlyMask = signBitMask - 1;
        //     if (value & signBitMask) {
        //         value = (value & valueOnlyMask) - signBitMask;
        //     } else {
        //         value = value & valueOnlyMask;
        //     }
        // }

        // Check for XOR mask
        if (!hasStringValues && "x" in attrDef) {
            const mask = typeof attrDef.x === "string" ? parseInt(attrDef.x, 16) : attrDef.x as number;
            attrValues = attrValues.map((value) => ((value as number) >>> 0) ^ mask);
        }
        
        // Check for AND mask
        if (!hasStringValues && "m" in attrDef) {
            const mask = typeof attrDef.m === "string" ? parseInt(attrDef.m, 16) : attrDef.m as number;
            attrValues = attrValues.map((value) => (maskOnSignedValue ? this.signExtend(value as number, mask) : ((value as number) >>> 0) & mask));
        }

        // Check for a sign-bit
        if (!hasStringValues && "sb" in attrDef) {
            const signBitPos = attrDef.sb as number;
            const signBitMask = 1 << signBitPos;
            if ("ss" in attrDef) {
                const signBitSubtract = attrDef.ss as number;
                attrValues = attrValues.map((value) => ((value as number) & signBitMask) ? signBitSubtract - (value as number) : value);
            } else {
                attrValues = attrValues.map((value) => ((value as number) & signBitMask) ? (value as number) - (signBitMask << 1) : value);
            }
        }

        // Check for bit shift required
        if (!hasStringValues && "s" in attrDef && attrDef.s) {
            const bitshift = attrDef.s as number;
            if (bitshift > 0) {
                attrValues = attrValues.map((value) => ((value as number) >>> 0) >>> bitshift);
            } else if (bitshift < 0) {
                attrValues = attrValues.map((value) => ((value as number) >>> 0) << -bitshift);
            }
        }

        // Check for divisor
        if (!hasStringValues && "d" in attrDef && attrDef.d) {
            const divisor = attrDef.d as number;
            attrValues = attrValues.map((value) => (value as number) / divisor);
        }

        // Check for value to add
        if (!hasStringValues && "a" in attrDef && attrDef.a !== undefined) {
            const addValue = attrDef.a as number;
            attrValues = attrValues.map((value) => (value as number) + addValue);
        }

        // Apply lookup table if defined
        if (!hasStringValues && "lut" in attrDef && attrDef.lut !== undefined) {
            attrValues = attrValues.map((value): number => {
                // Skip NaN values
                if (isNaN(value as number)) {
                    return value as number;
                }

                // Search through the lookup table rows for a match
                let defaultValue: number | null = null;
                
                for (const row of attrDef.lut || []) {
                    // Empty string means default for unmatched values
                    if (row.r === "") {
                        defaultValue = row.v;
                        continue;
                    }
                    
                    // Parse the range string
                    if (this.isValueInRangeString(value as number, row.r)) {
                        return row.v;
                    }
                }
                
                // If no match found but we have a default, use it
                if (defaultValue !== null) {
                    return defaultValue;
                }
                
                // Otherwise keep the original value
                return value as number;
            });
        }

        // const msgBufIdxIn = msgBufIdx;

        // Move buffer position if using relative positioning
        msgBufIdx += attrUsesAbsPos ? 0 : numBytesConsumed;

        // console.log(`RaftAttrHdlr.processMsgAttr attr ${attrDef.n} msgBufIdx ${msgBufIdxIn} msgBufIdx ${msgBufIdx} attrUsesAbsPos ${attrUsesAbsPos} numBytesConsumed ${numBytesConsumed} attrValues ${attrValues}`);

        // if (attrDef.n === "amb0") {
        //     console.log(`${new Date().toISOString()} ${attrDef.n} ${attrValues}`);
        // }

        // Return the value
        return { values: attrValues, newMsgBufIdx: msgBufIdx };
    }
    
    // One-shot detailed warning when an attribute decode would overrun the
    // sample/message bounds. Includes the exact bytes and schema so the
    // firmware vs. registered device-type schema can be reconciled.
    private _overrunWarnSeen: Set<string> = new Set();
    private warnAttrOverrun(attrDef: DeviceTypeAttribute, msgBuffer: Uint8Array, curFieldBufIdx: number,
                            attrTypeSize: number, msgDataStartIdx: number, attrUsesAbsPos: boolean,
                            pollRespMetadata: DeviceTypePollRespMetadata | undefined,
                            diagCtx: AttrDecodeDiagContext | undefined, overrunOf: "msgBuffer" | "sample"): void {
        const sampleStart = diagCtx?.sampleStartIdx ?? msgDataStartIdx;
        const sampleEnd = diagCtx?.sampleEndIdx;
        const dedupeKey = `${diagCtx?.deviceKey ?? "?"}|${diagCtx?.deviceType ?? "?"}|${attrDef.n}|${attrDef.t}|${attrUsesAbsPos ? attrDef.at : "rel"}`;
        if (this._overrunWarnSeen.has(dedupeKey)) {
            return;
        }
        this._overrunWarnSeen.add(dedupeKey);
        const sampleHex = sampleEnd !== undefined
            ? RaftUtils.bufferToHex(msgBuffer.slice(sampleStart, sampleEnd))
            : "<unknown sample bounds>";
        const availableInSample = sampleEnd !== undefined ? Math.max(0, sampleEnd - curFieldBufIdx) : -1;
        const availableInBuffer = Math.max(0, msgBuffer.length - curFieldBufIdx);
        console.warn(
            `AttributeHandler decode overrun (${overrunOf}): ` +
            `deviceKey=${diagCtx?.deviceKey ?? "?"} deviceType=${diagCtx?.deviceType ?? "?"} ` +
            `debugMsgIndex=${diagCtx?.debugMsgIndex ?? "?"} attr.n=${attrDef.n} attr.t=${attrDef.t} ` +
            `attrTypeSize=${attrTypeSize} attrUsesAbsPos=${attrUsesAbsPos} attr.at=${JSON.stringify(attrDef.at)} ` +
            `curFieldBufIdx=${curFieldBufIdx} msgBuffer.length=${msgBuffer.length} ` +
            `sampleStartIdx=${sampleStart} sampleEndIdx=${sampleEnd ?? "?"} ` +
            `availableInSample=${availableInSample} availableInBuffer=${availableInBuffer} ` +
            `sampleHex=${sampleHex} ` +
            `pollRespMetadata.b=${pollRespMetadata?.b} ` +
            `schema=${JSON.stringify(pollRespMetadata?.a)}`
        );
    }

    private signExtend(value: number, mask: number): number {
        const signBitMask = (mask + 1) >> 1;
        const signBit = value & signBitMask;
    
        if (signBit !== 0) {  // If sign bit is set
            const highBitsMask = ~mask & ~((mask + 1) >> 1);
            value |= highBitsMask;  // Apply the sign extension
        }
    
        return value;
    }

    private extractTimestampAndAdvanceIdx(msgBuffer: Uint8Array, msgBufIdx: number, timestampWrapHandler: DeviceTimeline,
                                          msgEndIdx: number = msgBuffer.length):
                    { newBufIdx: number, timestampUs: number } {

        // Check there are enough bytes for the timestamp (within the sample
        // window, not just the message buffer).
        const boundedEnd = Math.min(Math.max(msgEndIdx, msgBufIdx), msgBuffer.length);
        if (msgBufIdx + this.POLL_RESULT_TIMESTAMP_SIZE > boundedEnd) {
            return { newBufIdx: -1, timestampUs: 0 };
        }

        // Use struct to extract the timestamp
        const tsBuffer = msgBuffer.slice(msgBufIdx, msgBufIdx + this.POLL_RESULT_TIMESTAMP_SIZE);
        let timestampUs: number;
        if (this.POLL_RESULT_TIMESTAMP_SIZE === 2) { 
            timestampUs = structUnpack(">H", tsBuffer)[0] as number * this.POLL_RESULT_RESOLUTION_US;
        } else {
            timestampUs = structUnpack(">I", tsBuffer)[0] as number * this.POLL_RESULT_RESOLUTION_US;
        }

        // Check if time is before lastReportTimeMs by more than 100ms - in which case a wrap around occurred to add on the max value
        if (timestampUs + 10000 < timestampWrapHandler.lastReportTimestampUs ) {
            timestampWrapHandler.reportTimestampOffsetUs += this.POLL_RESULT_WRAP_VALUE * this.POLL_RESULT_RESOLUTION_US;
        }
        timestampWrapHandler.lastReportTimestampUs = timestampUs;

        // Offset timestamp
        timestampUs += timestampWrapHandler.reportTimestampOffsetUs;

        // Advance the index
        msgBufIdx += this.POLL_RESULT_TIMESTAMP_SIZE;

        // Return the timestamp
        return { newBufIdx: msgBufIdx, timestampUs: timestampUs };
    }

    // Helper method to check if a value is in a range string like "42,43,44-45,47"
    private isValueInRangeString(value: number, rangeStr: string): boolean {
        // Round to integer for comparison
        const roundedValue = Math.round(value);
        
        // Split the range string by commas
        const parts = rangeStr.split(',');
        
        for (const part of parts) {
            // Check if it's a range (contains a hyphen)
            if (part.includes('-')) {
                const [startStr, endStr] = part.split('-');
                
                // Handle hex values
                const start = startStr.toLowerCase().startsWith('0x') ? 
                    parseInt(startStr, 16) : parseInt(startStr, 10);
                const end = endStr.toLowerCase().startsWith('0x') ? 
                    parseInt(endStr, 16) : parseInt(endStr, 10);
                
                if (!isNaN(start) && !isNaN(end) && roundedValue >= start && roundedValue <= end) {
                    return true;
                }
            } 
            // Check if it's a single value
            else {
                // Handle hex values
                const partValue = part.toLowerCase().startsWith('0x') ? 
                    parseInt(part, 16) : parseInt(part, 10);
                
                if (!isNaN(partValue) && roundedValue === partValue) {
                    return true;
                }
            }
        }
        
        return false;
    }

}