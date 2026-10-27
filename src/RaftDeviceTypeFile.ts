/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeFile
// Part of RaftJS
//
// Building a device type file (the records a device loads from its file system at startup - RaftCore wiki,
// DeviceManager Settings, "Device type file"): a TypeScript copy of RaftCore's AssembleDeviceTypes.build_type_file,
// which gives the same text (so the device's CRC of the file agrees) and entries. Both are checked against the
// vectors in RaftCore scripts/tests/typefile_vectors.json.
//
// Each selected record is new, an override of a compiled record, or unchanged (identical to the compiled record, so
// left out); policies for compiled types become {"disable": ...} entries. A record with data but no compiled
// decoder is decoded on the device from its attributes (firmware with runtime decoding) unless it has custom decode
// code, which needs the code interpreter. The device's own check (devman/typefile/check) decides what it accepts.
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DevTypeJson, DevTypeJsonNumber, DevTypeJsonObject, cloneDevTypeJson, compareCodePoints, devTypeJsonGet,
    isDevTypeJsonObject, writeDevTypeJson } from "./RaftDeviceTypeJson";
import { compileDeviceTypeCommand } from "./RaftDeviceTypeGrammar";

// The device's default size limit for its type file (more with PSRAM; devman/typefile reports the device's own)
export const TYPE_FILE_MAX_BYTES_DEFAULT = 65536;
export const TYPE_FILE_MAX_BYTES_DEFAULT_PSRAM = 262144;

// Policies for a device type (as typePolicy, DeviceTypeSources.json policy)
export type DeviceTypePolicyName = "enabled" | "disabled" | "disabledClaim";
const POLICY_VALUES: Record<DeviceTypePolicyName, DevTypeJson | undefined> = {
    enabled: undefined,
    disabled: true,
    disabledClaim: "claim",
};

export class DeviceTypeFileError extends Error {}

export interface TypeFileBuildEntry {
    key: string;
    kind: "new" | "override" | "unchanged" | "policy";
    policy?: DeviceTypePolicyName;              // kind "policy"
    // A record with its own initCode: "runtime" (only firmware with the code interpreter runs it) or
    // "runtime or compiled" (firmware without it uses the compiled record's)
    initCode?: "runtime" | "runtime or compiled";
    noDecoder?: boolean;                        // has data but no compiled decoder
    decoder?: "runtime" | "none";               // then: decoded on the device from its attributes, or not (custom code)
}

export interface TypeFileBuildInput {
    records: Map<string, DevTypeJson>;                      // key -> record selected for the file, in key order
    policyOnly?: Map<string, DeviceTypePolicyName>;         // policies for compiled types that aren't in the file
    provenance?: DevTypeJson;                               // written as the file's _sources (ignored by the device)
}

export interface TypeFileBuildResult {
    text: string;
    bytes: number;
    crc: string;                                // as devman/typefile and filehash report it
    entries: TypeFileBuildEntry[];
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CRC
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// CRC16-CCITT as the firmware's devman/typefile and filehash report it (DeviceTypeFileLoader::crc16)
export function crc16Ccitt(data: ArrayLike<number>): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 8;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

// A file's CRC as the device reports it ("%04x" of the CRC16-CCITT of its UTF-8 bytes)
export function typeFileCrc(text: string | Uint8Array): string {
    const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
    return crc16Ccitt(bytes).toString(16).padStart(4, "0");
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Record comparisons (as the Python)
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function withoutTopLevel(record: DevTypeJson, ...keys: string[]): DevTypeJson {
    const copy = cloneDevTypeJson(record);
    if (isDevTypeJsonObject(copy))
        keys.forEach((k) => copy.delete(k));
    return copy;
}

function comparable(record: DevTypeJson): string {
    return writeDevTypeJson(withoutTopLevel(record, "_notes", "_warning", "deviceType"), { sortKeys: true });
}

// The response layout as the firmware compares it (DeviceTypeRecords::sameResponseLayout): resp as compact JSON
function responseLayout(record: DevTypeJson): string | null {
    const resp = devTypeJsonGet(record, "devInfoJson", "resp");
    return resp === undefined ? null : writeDevTypeJson(resp);
}

function stringMember(record: DevTypeJson | undefined, key: string): string {
    const value = devTypeJsonGet(record, key);
    return typeof value === "string" ? value : "";
}

// [names a record's initCode computes, value slot and guard names its initValues uses]
export function deviceTypeInitValueNames(record: DevTypeJson | undefined): [Set<string>, Set<string>] {
    const initCode = devTypeJsonGet(record, "initCode");
    const code = isDevTypeJsonObject(initCode) ? stringMember(initCode, "c") : (typeof initCode === "string" ? initCode : "");
    const computed = new Set<string>();
    const computedRe = /\binit\.([A-Za-z_][A-Za-z0-9_]*)/g;
    for (let m = computedRe.exec(code); m !== null; m = computedRe.exec(code))
        computed.add(m[1]);
    const slots = new Set<string>();
    for (const step of compileDeviceTypeCommand(stringMember(record, "initValues"), "init").steps) {
        step.slots.forEach((slot) => slots.add(slot.name));
        if (step.guard)
            slots.add(step.guard);
    }
    return [computed, slots];
}

const sortedNames = (names: Iterable<string>) => Array.from(names).sort(compareCodePoints);

function hasInitCode(record: DevTypeJson): boolean {
    const initCode = devTypeJsonGet(record, "initCode");
    // Python's truth value: an empty string, object or array is false
    if (initCode === undefined || initCode === null || initCode === false || initCode === "")
        return false;
    if (isDevTypeJsonObject(initCode))
        return initCode.size > 0;
    if (Array.isArray(initCode))
        return initCode.length > 0;
    if (initCode instanceof DevTypeJsonNumber)
        return initCode.value !== 0;
    return true;
}

function hasData(record: DevTypeJson): boolean {
    const b = devTypeJsonGet(record, "devInfoJson", "resp", "b");
    return b instanceof DevTypeJsonNumber && b.value > 0;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Build
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// A device type file from the records selected for it, against the records compiled into the firmware
export function buildTypeFile(input: TypeFileBuildInput, compiled: Map<string, DevTypeJson>,
                              options: { maxBytes?: number } = {}): TypeFileBuildResult {
    const maxBytes = options.maxBytes ?? TYPE_FILE_MAX_BYTES_DEFAULT;
    const entries: TypeFileBuildEntry[] = [];
    const devTypes: DevTypeJsonObject = new Map();
    for (const [key, record] of input.records) {
        const compiledRecord = compiled.get(key);
        // Init values ({name} value slots, {?name} guards) need init code: the record's own initCode (run by the
        // code interpreter in firmware built with RAFT_RUNTIME_DECODE_CODE), or a compiled record of the same key
        // whose initCode computes them (firmware without the interpreter uses that)
        const [ownComputes, slots] = deviceTypeInitValueNames(record);
        const hasOwnCode = hasInitCode(record);
        const compiledComputes = compiledRecord !== undefined ? deviceTypeInitValueNames(compiledRecord)[0] : new Set<string>();
        if (hasOwnCode) {
            const missing = sortedNames(Array.from(slots).filter((s) => !ownComputes.has(s)));
            if (missing.length > 0)
                throw new DeviceTypeFileError(`typeFile "${key}": initValues uses ${missing.join(", ")}, which its initCode doesn't compute`);
        } else if (slots.size > 0) {
            const missing = sortedNames(Array.from(slots).filter((s) => !compiledComputes.has(s)));
            if (missing.length > 0 || compiledComputes.size === 0)
                throw new DeviceTypeFileError(`typeFile "${key}": init values ({name} value slots, {?name} guards) need init code - ` +
                    `initCode in the record (needs firmware with RAFT_RUNTIME_DECODE_CODE) or a compiled ${key} ` +
                    `whose initCode computes ${missing.length > 0 ? missing.join(", ") : "them"}`);
        }
        const compiledCoversSlots = compiledComputes.size > 0 && Array.from(slots).every((s) => compiledComputes.has(s));
        const initCodeRuntime = hasOwnCode && !compiledCoversSlots;
        const withData = hasData(record);
        if (compiledRecord !== undefined && comparable(record) === comparable(compiledRecord)) {
            entries.push({ key, kind: "unchanged" });
            continue;
        }
        let noDecoder: boolean;
        let kind: TypeFileBuildEntry["kind"];
        if (compiledRecord !== undefined) {
            noDecoder = withData && responseLayout(record) !== responseLayout(compiledRecord);
            kind = "override";
        } else {
            noDecoder = withData;
            kind = "new";
        }
        const entry: TypeFileBuildEntry = { key, kind };
        if (hasOwnCode)
            entry.initCode = initCodeRuntime ? "runtime" : "runtime or compiled";
        if (noDecoder) {
            entry.noDecoder = true;
            const resp = devTypeJsonGet(record, "devInfoJson", "resp");
            entry.decoder = isDevTypeJsonObject(resp) && resp.has("c") ? "none" : "runtime";
        }
        entries.push(entry);
        devTypes.set(key, withoutTopLevel(record, "_notes", "_warning"));
    }
    for (const [key, policy] of input.policyOnly ?? new Map<string, DeviceTypePolicyName>()) {
        if (!compiled.has(key))
            throw new DeviceTypeFileError(`typeFile.policy "${key}": not a selected record or a compiled one`);
        const value = POLICY_VALUES[policy];
        if (value === undefined)
            throw new DeviceTypeFileError(`typeFile.policy "${key}": a type file can't enable a compiled type (only disable it)`);
        devTypes.set(key, new Map<string, DevTypeJson>([["disable", value]]));
        entries.push({ key, kind: "policy", policy });
    }
    const content: DevTypeJsonObject = new Map();
    const sortedDevTypes: DevTypeJsonObject = new Map();
    Array.from(devTypes.keys()).sort(compareCodePoints).forEach((k) => sortedDevTypes.set(k, devTypes.get(k) as DevTypeJson));
    content.set("devTypes", sortedDevTypes);
    if (input.provenance !== undefined && input.provenance !== null)
        content.set("_sources", input.provenance);
    const text = writeDevTypeJson(content);
    if (text.length > maxBytes)
        throw new DeviceTypeFileError(`the type file is ${text.length} bytes, more than the ${maxBytes} byte limit`);
    return { text, bytes: text.length, crc: typeFileCrc(text), entries };
}
