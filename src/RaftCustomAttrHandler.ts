/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftCustomAttrHandler
// Custom attribute handler for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { CustomFunctionDefinition, DeviceTypePollRespMetadata } from "./RaftDeviceInfo";
import { transpilePseudocodeToJs } from "./PseudocodeTranspiler";

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

        // Provide only this poll block (bounded by pollRespMetadata.b) to avoid
        // decoding bytes that belong to subsequent records in the same frame.
        const buf = msgBuffer.slice(msgBufIdx, msgBufIdx + numMsgBytes);
        if (buf.length < numMsgBytes) {
            return [];
        }

        const fn = this.getOrCompileFunction(customFnDef);
        if (!fn) {
            return attrValueVecs;
        }

        try {
            fn(buf, attrValues, attrValueVecs, pollRespMetadata, msgBuffer, msgBufIdx, numMsgBytes);
        } catch (err) {
            console.error(`CustomAttrHandler function ${customFnDef.n} execution failed`, err);
        }
        return attrValueVecs;
    }

    private getOrCompileFunction(customFnDef: CustomFunctionDefinition): CustomAttrJsFn | null {
        // Prefer explicit JS if provided, otherwise transpile from pseudocode
        let jsSource = customFnDef.j?.trim();
        if (!jsSource && customFnDef.c) {
            jsSource = transpilePseudocodeToJs(customFnDef.c);
        }
        if (!jsSource) {
            return null;
        }

        const cacheKey = `${customFnDef.n}::${jsSource}`;
        const cached = this._jsFunctionCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const fn = new Function(
                "buf",
                "attrValues",
                "attrValueVecs",
                "pollRespMetadata",
                "msgBuffer",
                "msgBufIdx",
                "numMsgBytes",
                jsSource
            ) as CustomAttrJsFn;
            this._jsFunctionCache.set(cacheKey, fn);
            return fn;
        } catch (err) {
            console.error(`CustomAttrHandler failed to compile function ${customFnDef.n}`, err);
            return null;
        }
    }
}
