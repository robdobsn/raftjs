/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftCustomAttrHandler
// Custom attribute handler for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { CustomFunctionDefinition, DeviceTypePollRespMetadata } from "./RaftDeviceInfo";

type CustomAttrJsFn = (
    buf: Uint8Array,
    attrValues: Record<string, number[]>,
    attrValueVecs: number[][],
    pollRespMetadata: DeviceTypePollRespMetadata,
    msgBuffer: Uint8Array,
    msgBufIdx: number,
    numMsgBytes: number
) => void;

export default class CustomAttrHandler {

    private _jsFunctionCache = new Map<string, CustomAttrJsFn>();

    private toInt16(lo: number, hi: number): number {
        const u16 = (hi << 8) | lo;
        return (u16 & 0x8000) ? (u16 - 0x10000) : u16;
    }
    
    public handleAttr(pollRespMetadata: DeviceTypePollRespMetadata, msgBuffer: Uint8Array, msgBufIdx: number): number[][] {

        // Number of bytes in each message
        const numMsgBytes = pollRespMetadata.b;

        // Create a vector for each attribute in the metadata
        const attrValueVecs: number[][] = [];

        // Reference to each vector by attribute name
        const attrValues: Record<string, number[]> = {};

        // Add attributes to the vector
        for (let attrIdx = 0; attrIdx < pollRespMetadata.a.length; attrIdx++) {
            attrValueVecs.push([]);
            attrValues[pollRespMetadata.a[attrIdx].n] = attrValueVecs[attrIdx];
        }

        const customFnDef = pollRespMetadata.c;
        if (!customFnDef) {
            return attrValueVecs;
        }

        // Provide only this poll block (bounded by pollRespMetadata.b) to avoid
        // decoding bytes that belong to subsequent records in the same frame.
        const buf = msgBuffer.slice(msgBufIdx, msgBufIdx + numMsgBytes);
        if (buf.length < numMsgBytes) {
            return [];
        }

        // Execute supplied JS implementation if provided
        if (customFnDef.j && customFnDef.j.trim().length > 0) {
            const jsFn = this.getOrCompileJsFunction(customFnDef);
            if (!jsFn) {
                return attrValueVecs;
            }
            try {
                jsFn(buf, attrValues, attrValueVecs, pollRespMetadata, msgBuffer, msgBufIdx, numMsgBytes);
            } catch (err) {
                console.error(`CustomAttrHandler JS function ${customFnDef.n} execution failed`, err);
            }
            return attrValueVecs;
        }

        // Custom code for each device type handled natively
        if (customFnDef.n === "max30101_fifo") {
            // Generated code ...
            const N = (buf[0] + 32 - buf[2]) % 32;
            let k = 3;
            let i = 0;
            while (i < N) {
                attrValues["Red"].push(0);
                attrValues["Red"][attrValues["Red"].length - 1] = (buf[k] << 16) | (buf[k + 1] << 8) | buf[k + 2];
                attrValues["IR"].push(0);
                attrValues["IR"][attrValues["IR"].length - 1] = (buf[k + 3] << 16) | (buf[k + 4] << 8) | buf[k + 5];
                k += 6;
                i++;
            }
        } else if (customFnDef.n === "lsm6ds_fifo") {
            // FIFO_STATUS1 (buf[0]) = DIFF_FIFO[7:0], FIFO_STATUS2 (buf[1]):
            //   bit7=WTM, bit6=OVER_RUN, bit5=FIFO_FULL, bit4=FIFO_EMPTY, bits3:0=DIFF_FIFO[11:8]
            const wordCount = ((buf[1] & 0x0f) << 8) | buf[0];
            const fifoFull = (buf[1] & 0x60) !== 0; // OVER_RUN or FIFO_FULL

            // Max samples that fit in the payload after the 2-byte FIFO status
            const maxSamplesFromBuf = Math.floor(Math.max(0, buf.length - 2) / 12);

            let sampleCount: number;
            if (wordCount > 0) {
                sampleCount = Math.min(Math.floor(wordCount / 6), 16, maxSamplesFromBuf);
            } else if (fifoFull) {
                // LSM6DS3 quirk: DIFF_FIFO wraps to 0 when FIFO is full (4096 words, 12-bit counter)
                sampleCount = Math.min(16, maxSamplesFromBuf);
            } else {
                // Genuinely empty
                return attrValueVecs;
            }

            // Debug: log what the decoder sees
            console.log(`lsm6ds_fifo: bufLen=${buf.length} status=[0x${buf[0].toString(16).padStart(2,'0')},0x${buf[1].toString(16).padStart(2,'0')}] wc=${wordCount} full=${fifoFull} samples=${sampleCount}`);

            let k = 2;
            for (let i = 0; i < sampleCount; i++) {
                if (attrValues["gx"]) attrValues["gx"].push(this.toInt16(buf[k], buf[k + 1]));
                if (attrValues["gy"]) attrValues["gy"].push(this.toInt16(buf[k + 2], buf[k + 3]));
                if (attrValues["gz"]) attrValues["gz"].push(this.toInt16(buf[k + 4], buf[k + 5]));
                if (attrValues["ax"]) attrValues["ax"].push(this.toInt16(buf[k + 6], buf[k + 7]));
                if (attrValues["ay"]) attrValues["ay"].push(this.toInt16(buf[k + 8], buf[k + 9]));
                if (attrValues["az"]) attrValues["az"].push(this.toInt16(buf[k + 10], buf[k + 11]));
                k += 12;
            }
        } else if (customFnDef.n === "gravity_o2_calc") {
            const key = 20.9 / 120.0;
            const val = key * (buf[0] + buf[1] / 10.0 + buf[2] / 100.0);
            attrValues["oxygen"].push(val);
        }
        return attrValueVecs;
    }

    private getOrCompileJsFunction(customFnDef: CustomFunctionDefinition): CustomAttrJsFn | null {
        if (!customFnDef.j) {
            return null;
        }
        const cacheKey = `${customFnDef.n}::${customFnDef.j}`;
        const cachedFn = this._jsFunctionCache.get(cacheKey);
        if (cachedFn) {
            return cachedFn;
        }
        try {
            const compiledFn = new Function(
                "buf",
                "attrValues",
                "attrValueVecs",
                "pollRespMetadata",
                "msgBuffer",
                "msgBufIdx",
                "numMsgBytes",
                customFnDef.j
            ) as CustomAttrJsFn;
            this._jsFunctionCache.set(cacheKey, compiledFn);
            return compiledFn;
        } catch (err) {
            console.error(`CustomAttrHandler failed to compile JS function ${customFnDef.n}`, err);
            return null;
        }
    }
}
