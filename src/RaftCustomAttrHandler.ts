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

        // Provide the message buffer sliced to the data portion
        const buf = msgBuffer.slice(msgBufIdx);
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
