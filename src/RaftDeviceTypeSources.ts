/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeSources
// Part of RaftJS
//
// DeviceTypeSources.json (RaftCore wiki: Selecting Device Types): named sources of device type records - RaftCore's
// ("bundled"), folders ("path") and git repos ("git") - and the records a build compiles in ("builtin") or puts in a
// device type file ("typeFile"). A TypeScript copy of RaftCore's AssembleDeviceTypes read_selection and assemble
// (without fetching: the caller supplies each source's records), checked against the vectors in RaftCore
// scripts/tests/selection_vectors.json, so a selection resolves here as it does in a build.
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DevTypeJson, DevTypeJsonObject, DevTypeJsonNumber, cloneDevTypeJson, compareCodePoints, isDevTypeJsonObject,
    parseDevTypeJson } from "./RaftDeviceTypeJson";
import { DeviceTypePolicyName } from "./RaftDeviceTypeFile";

export type DeviceTypeSection = "builtin" | "typeFile";
export const DEVICE_TYPE_SECTIONS: DeviceTypeSection[] = ["builtin", "typeFile"];
export const DEVICE_TYPE_PROVENANCE_FORMAT_VERSION = 1;

const POLICY_VALUES: Record<DeviceTypePolicyName, DevTypeJson | undefined> = { enabled: undefined, disabled: true, disabledClaim: "claim" };

export class DeviceTypeSelectionError extends Error {}

export interface DeviceTypeSectionSelection {
    include: string[];
    exclude: string[];
    policy: Map<string, DeviceTypePolicyName>;
    hasInclude: boolean;            // the section has an include list (builtin's default is everything, typeFile's nothing)
    fsImage: boolean;
}

// Selection files merged (Common's first, then the SysType's)
export interface MergedDeviceTypeSources {
    sources: Map<string, DevTypeJsonObject>;        // name -> spec, e.g. {"git": <url>, "ref": <ref>}
    sections: Record<DeviceTypeSection, DeviceTypeSectionSelection>;
    messages: string[];
    acknowledge: string[];      // keys of records whose _warning has been accepted
}

export type DeviceTypeSourceKind = "bundled" | "path" | "git";

export function deviceTypeSourceKind(spec: DevTypeJsonObject): DeviceTypeSourceKind | undefined {
    if (spec.has("git"))
        return "git";
    if (truthy(spec.get("bundled")))
        return "bundled";
    if (spec.has("path"))
        return "path";
    return undefined;
}

// A source's records, as read by the caller (from the published catalogue, a git host or local files)
export interface DeviceTypeSourceRecords {
    records: Map<string, DevTypeJson>;
    commit?: string;            // a git source: the commit its ref resolved to
    raftCore?: string;          // RaftCore's records: its version
    sets?: Map<string, string[]>;   // RaftCore's records: its named sets (devtypes/sets), selected as "<source>:@<set>"
}

export interface DeviceTypeSelectionResult {
    records: Map<string, DevTypeJson>;              // key -> record (policies applied), in key order
    origin: Map<string, string>;                    // key -> source name
    replaced: Map<string, string[]>;                // key -> sources whose record a path source's replaced
    policyOnly: Map<string, DeviceTypePolicyName>;  // typeFile: policies for types not in the file (compiled types)
    messages: string[];
    warnings: string[];                             // "<key>: <text>" - selected, enabled records with a _warning not acknowledged
    provenance: DevTypeJson;                        // what the records came from (a type file's _sources)
    fsImage: boolean;
}

function truthy(value: DevTypeJson | undefined): boolean {
    if (value === undefined || value === null || value === false || value === "")
        return false;
    if (value instanceof DevTypeJsonNumber)
        return value.value !== 0;
    if (Array.isArray(value))
        return value.length > 0;
    if (value instanceof Map)
        return value.size > 0;
    return true;
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

const emptySection = (): DeviceTypeSectionSelection => ({ include: [], exclude: [], policy: new Map(), hasInclude: false, fsImage: false });

// Merge DeviceTypeSources.json files (Common's first, then the SysType's): sources are added (or replaced by name),
// include and exclude lists joined, policies merged (the later file's win). name is used in error messages
export function mergeDeviceTypeSources(files: Array<{ name: string; content: string | DevTypeJson }>): MergedDeviceTypeSources {
    const merged: MergedDeviceTypeSources = { sources: new Map(), messages: [], acknowledge: [], sections: { builtin: emptySection(), typeFile: emptySection() } };
    for (const file of files) {
        const fail = (message: string): never => { throw new DeviceTypeSelectionError(`${file.name}: ${message}`); };
        let content: DevTypeJson;
        try {
            content = typeof file.content === "string" ? parseDevTypeJson(file.content) : file.content;
        } catch (err) {
            return fail(`not valid JSON (${err instanceof Error ? err.message : err})`);
        }
        if (!isDevTypeJsonObject(content))
            fail("expected a JSON object");
        const obj = content as DevTypeJsonObject;
        for (const key of obj.keys()) {
            if (!["sources", "_notes", "acknowledge", ...DEVICE_TYPE_SECTIONS].includes(key))
                fail(`unknown key "${key}"`);
        }
        let acknowledge = obj.get("acknowledge") ?? [];
        if (typeof acknowledge === "string")
            acknowledge = [acknowledge];
        if (!Array.isArray(acknowledge) || !acknowledge.every((k) => typeof k === "string"))
            fail("acknowledge must be a list of record keys");
        merged.acknowledge.push(...(acknowledge as string[]));
        const sources = obj.get("sources");
        if (isDevTypeJsonObject(sources)) {
            for (const [name, spec] of sources) {
                if (!isDevTypeJsonObject(spec))
                    fail(`source "${name}" must be an object`);
                if (name.includes(":") || name === "*")
                    fail(`source name "${name}" can't contain ':' or be '*'`);
                let sourceSpec = spec as DevTypeJsonObject;
                if (sourceSpec.has("builtin") && !sourceSpec.has("bundled")) {
                    // The older name for "bundled"
                    const renamed: DevTypeJsonObject = new Map();
                    sourceSpec.forEach((v, k) => renamed.set(k === "builtin" ? "bundled" : k, v));
                    sourceSpec = renamed;
                    merged.messages.push(`${basename(file.name)}: source "${name}": "builtin": true is now "bundled": true`);
                }
                merged.sources.set(name, sourceSpec);
            }
        }
        for (const section of DEVICE_TYPE_SECTIONS) {
            const spec = obj.get(section);
            if (spec === undefined)
                continue;
            if (!isDevTypeJsonObject(spec))
                fail(`"${section}" must be an object`);
            const sectionSpec = spec as DevTypeJsonObject;
            const target = merged.sections[section];
            for (const listName of ["include", "exclude"] as const) {
                let value = sectionSpec.get(listName) ?? [];
                if (typeof value === "string")
                    value = [value];
                if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
                    fail(`${section}.${listName} must be a list of strings`);
                target[listName].push(...(value as string[]));
            }
            if (sectionSpec.has("include"))
                target.hasInclude = true;
            const policy = sectionSpec.get("policy");
            if (isDevTypeJsonObject(policy)) {
                for (const [key, name] of policy) {
                    if (typeof name !== "string" || !(name in POLICY_VALUES))
                        fail(`${section}.policy "${key}" must be one of ${Object.keys(POLICY_VALUES).join(", ")}`);
                    target.policy.set(key, name as DeviceTypePolicyName);
                }
            }
            if (sectionSpec.has("fsImage")) {
                if (section !== "typeFile")
                    fail("fsImage belongs in the typeFile section");
                target.fsImage = truthy(sectionSpec.get("fsImage"));
            }
        }
    }
    return merged;
}

function parsePattern(pattern: string, sourceNames: string[]): [string | undefined, string] {
    const colon = pattern.indexOf(":");
    if (colon >= 0) {
        const source = pattern.slice(0, colon);
        if (!sourceNames.includes(source))
            throw new DeviceTypeSelectionError(`"${pattern}": no source called "${source}"`);
        return [source, pattern.slice(colon + 1)];
    }
    return [undefined, pattern];
}

// Resolve a section of a selection into records (sorted by key), given the records of each source
export function resolveDeviceTypeSelection(merged: MergedDeviceTypeSources, section: DeviceTypeSection,
                                           sourceRecords: Map<string, DeviceTypeSourceRecords>): DeviceTypeSelectionResult {
    const result: DeviceTypeSelectionResult = { records: new Map(), origin: new Map(), replaced: new Map(), policyOnly: new Map(),
        messages: [...merged.messages], warnings: [], provenance: null, fsImage: merged.sections[section].fsImage };
    const sources = new Map<string, { records: Map<string, DevTypeJson>; isLocal: boolean }>();
    for (const [name, spec] of merged.sources) {
        const kind = deviceTypeSourceKind(spec);
        if (kind === undefined)
            throw new DeviceTypeSelectionError(`source "${name}": needs "bundled", "path" or "git"`);
        const loaded = sourceRecords.get(name);
        if (!loaded)
            throw new DeviceTypeSelectionError(`source "${name}": its records haven't been read`);
        sources.set(name, { records: loaded.records, isLocal: kind === "path" });
    }
    const names = Array.from(sources.keys());
    const bundled = names.filter((n) => deviceTypeSourceKind(merged.sources.get(n) as DevTypeJsonObject) === "bundled");
    const chosen = merged.sections[section];

    // The keys of a named set ("<source>:@<set>", RaftCore's records only)
    const setKeys = (pattern: string, source: string | undefined, key: string, listName: string): string[] => {
        if (source === undefined || !bundled.includes(source))
            throw new DeviceTypeSelectionError(`${section}.${listName} "${pattern}": named sets (@...) are only in RaftCore's records - ` +
                `use "<the bundled source>:${key}"`);
        const sets = sourceRecords.get(source)?.sets ?? new Map<string, string[]>();
        const keys = sets.get(key.slice(1));
        if (keys === undefined)
            throw new DeviceTypeSelectionError(`${section}.${listName} "${pattern}": no set "${key.slice(1)}" in RaftCore's records ` +
                `(sets: ${Array.from(sets.keys()).sort().join(", ") || "none"})`);
        const records = (sources.get(source) as { records: Map<string, DevTypeJson> }).records;
        const missing = keys.filter((k) => !records.has(k));
        if (missing.length > 0)
            throw new DeviceTypeSelectionError(`set "${key.slice(1)}" names ${missing.join(", ")}, not in RaftCore's records`);
        return keys;
    };
    // builtin includes everything unless it says otherwise; a type file includes nothing unless it says otherwise
    const includes = chosen.hasInclude ? chosen.include : (section === "builtin" ? ["*"] : []);

    // Candidates for each key: the sources it was selected from, and whether a source was named for it
    const candidates = new Map<string, { named: string[]; any: string[] }>();
    const skipped = new Map<string, string>();
    const addTo = (list: string[], name: string) => { if (!list.includes(name)) list.push(name); };
    for (const pattern of includes) {
        const [source, key] = parsePattern(pattern, names);
        let matched = false;
        for (const name of source ? [source] : names) {
            const records = (sources.get(name) as { records: Map<string, DevTypeJson> }).records;
            let keys = key.startsWith("@") ? setKeys(pattern, source, key, "include") :
                (key === "*" ? Array.from(records.keys()) : (records.has(key) ? [key] : []));
            if (key === "*") {
                // A wildcard doesn't select a record with a _warning (what selecting it entails): it's selected by
                // naming it, or by acknowledging its warning
                keys = keys.filter((k) => {
                    const skip = deviceTypeRecordWarning(k, records.get(k) as DevTypeJson) !== undefined &&
                        !merged.acknowledge.includes(k);
                    if (skip && !skipped.has(k))
                        skipped.set(k, name);
                    return !skip;
                });
            }
            for (const k of keys) {
                if (!candidates.has(k))
                    candidates.set(k, { named: [], any: [] });
                const entry = candidates.get(k) as { named: string[]; any: string[] };
                addTo(source && key !== "*" && !key.startsWith("@") ? entry.named : entry.any, name);
                matched = true;
            }
        }
        if (!matched && key !== "*" && !key.startsWith("@")) {
            const where = source ? `source "${source}"` : "any source";
            throw new DeviceTypeSelectionError(`${section}.include "${pattern}": no record "${key}" in ${where}`);
        }
    }
    for (const pattern of chosen.exclude) {
        const [source, key] = parsePattern(pattern, names);
        const excluded = key.startsWith("@") ? new Set(setKeys(pattern, source, key, "exclude")) : undefined;
        for (const k of Array.from(candidates.keys())) {
            if (key === "*" || k === key || (excluded !== undefined && excluded.has(k))) {
                const entry = candidates.get(k) as { named: string[]; any: string[] };
                if (source === undefined) {
                    entry.named = [];
                    entry.any = [];
                } else {
                    entry.named = entry.named.filter((n) => n !== source);
                    entry.any = entry.any.filter((n) => n !== source);
                }
                if (entry.named.length === 0 && entry.any.length === 0)
                    candidates.delete(k);
            }
        }
    }

    for (const [key, name] of skipped) {
        if (!candidates.has(key))
            result.messages.push(`"${key}" (in ${name}) has a warning, so "*" doesn't select it - include it by name, or add it ` +
                `to "acknowledge", to select it`);
    }

    // One source for each key
    for (const key of Array.from(candidates.keys()).sort(compareCodePoints)) {
        const { named, any } = candidates.get(key) as { named: string[]; any: string[] };
        let source: string;
        if (named.length > 1)
            throw new DeviceTypeSelectionError(`"${key}" is named from more than one source: ${named.join(", ")}`);
        if (named.length === 1) {
            source = named[0];
        } else {
            const options = names.filter((n) => any.includes(n));
            const local = options.filter((n) => (sources.get(n) as { isLocal: boolean }).isLocal);
            if (local.length > 0) {
                source = local[local.length - 1];
                const replaced = options.filter((n) => n !== source);
                if (replaced.length > 0) {
                    result.messages.push(`"${key}" from ${source} replaces the record from ${replaced.join(", ")}`);
                    result.replaced.set(key, replaced);
                }
            } else if (options.length > 1) {
                throw new DeviceTypeSelectionError(`"${key}" is in sources ${options.join(", ")} - name the source to use in ` +
                    `${section}.include (e.g. "${options[0]}:${key}")`);
            } else {
                source = options[0];
            }
        }
        result.records.set(key, cloneDevTypeJson((sources.get(source) as { records: Map<string, DevTypeJson> }).records.get(key) as DevTypeJson));
        result.origin.set(key, source);
    }

    // Policies
    for (const [key, policy] of chosen.policy) {
        const record = result.records.get(key);
        if (record === undefined) {
            // In a type file, a policy for a type that isn't in the file applies to a compiled record
            if (section === "typeFile") {
                result.policyOnly.set(key, policy);
                continue;
            }
            throw new DeviceTypeSelectionError(`${section}.policy "${key}": not a selected record`);
        }
        if (isDevTypeJsonObject(record)) {
            const value = POLICY_VALUES[policy];
            if (value === undefined)
                record.delete("disable");
            else
                record.set("disable", value);
        }
    }
    // Warnings of the selected, enabled records that aren't acknowledged
    for (const [key, record] of result.records) {
        const text = deviceTypeRecordWarning(key, record);
        const disable = isDevTypeJsonObject(record) ? record.get("disable") : undefined;
        if (text !== undefined && (disable === undefined || disable === false) && !merged.acknowledge.includes(key))
            result.warnings.push(`${key}: ${text} (to accept it, add "${key}" to "acknowledge" in DeviceTypeSources.json)`);
    }
    result.provenance = deviceTypeProvenance(merged, section, result.origin, sourceRecords);
    return result;
}

// A record's "_warning" (what selecting it, and so enabling it, entails - e.g. a general call sent on the bus), or
// undefined. Not a non-empty string: an error
export function deviceTypeRecordWarning(key: string, record: DevTypeJson): string | undefined {
    if (!isDevTypeJsonObject(record) || !record.has("_warning"))
        return undefined;
    const value = record.get("_warning");
    if (typeof value !== "string" || value.trim() === "")
        throw new DeviceTypeSelectionError(`"${key}": _warning must be a non-empty string`);
    return value.trim();
}

// What a selection's records came from (a type file's _sources): the sources that supplied a record - a git source
// with the commit its ref resolved to, RaftCore's records with RaftCore's version, a path source with its path - and
// the section's selection
export function deviceTypeProvenance(merged: MergedDeviceTypeSources, section: DeviceTypeSection, origin: Map<string, string>,
                                     sourceRecords: Map<string, DeviceTypeSourceRecords>): DevTypeJson {
    const used = new Set(origin.values());
    const sources: DevTypeJsonObject = new Map();
    for (const [name, spec] of merged.sources) {
        if (!used.has(name))
            continue;
        const entry: DevTypeJsonObject = new Map();
        const kind = deviceTypeSourceKind(spec);
        if (kind === "git") {
            entry.set("git", spec.get("git") as DevTypeJson);
            for (const field of ["ref", "path"]) {
                if (spec.has(field))
                    entry.set(field, spec.get(field) as DevTypeJson);
            }
            const commit = sourceRecords.get(name)?.commit;
            if (commit)
                entry.set("commit", commit);
        } else if (kind === "bundled") {
            entry.set("bundled", true);
            const version = sourceRecords.get(name)?.raftCore;
            if (version)
                entry.set("raftCore", version);
        } else {
            entry.set("path", spec.get("path") ?? "");
        }
        sources.set(name, entry);
    }
    const chosen = merged.sections[section];
    const chosenOut: DevTypeJsonObject = new Map();
    if (chosen.hasInclude)
        chosenOut.set("include", [...chosen.include]);
    if (chosen.exclude.length > 0)
        chosenOut.set("exclude", [...chosen.exclude]);
    if (chosen.policy.size > 0)
        chosenOut.set("policy", new Map<string, DevTypeJson>(chosen.policy));
    return new Map<string, DevTypeJson>([["formatVersion", new DevTypeJsonNumber(String(DEVICE_TYPE_PROVENANCE_FORMAT_VERSION))],
        ["sources", sources], [section, chosenOut]]);
}
