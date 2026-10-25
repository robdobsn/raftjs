/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeCatalogue
// Part of RaftJS
//
// Reading the records of DeviceTypeSources.json sources in a browser (or Node, or React Native - fetch is passed
// in): RaftCore's records from the catalogue published on RaftCore's GitHub Pages site, git sources on GitHub (read
// through its API at the commit a ref resolves to - a browser can't run git), and record files the user picks. And
// the lock file (DeviceTypeSources.lock) of a resolved selection, as a build writes it.
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DevTypeJson, DevTypeJsonNumber, DevTypeJsonObject, compareCodePoints, devTypeJsonGet, isDevTypeJsonObject, parseDevTypeJson,
    writeDevTypeJson } from "./RaftDeviceTypeJson";
import { checkDeviceTypeRecordCode } from "./RaftDeviceTypeCodeCheck";
import { DeviceTypeSelectionResult, DeviceTypeSourceRecords, MergedDeviceTypeSources, deviceTypeSourceKind } from "./RaftDeviceTypeSources";

export const RAFTCORE_PAGES_CATALOGUE_URL = "https://robdobsn.github.io/RaftCore/devtypes";
export const DEVICE_TYPE_SOURCE_MANIFEST = "raftdevtypes.json";
export const DEVICE_TYPE_SOURCE_FORMAT_VERSION = 1;
export const DEVICE_TYPE_LOCK_FORMAT_VERSION = 1;

export class DeviceTypeSourceError extends Error {}

// What fetch must offer (the browser's fetch, Node's, or a test's)
export type DeviceTypeFetch = (url: string, init?: { headers?: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// A record's file as read (its text is what the lock's SHA-256 is of)
export interface DeviceTypeRecordFile {
    path: string;
    text: string;
}

// Source records with the file each came from
export interface DeviceTypeSourceRecordsWithFiles extends DeviceTypeSourceRecords {
    files: Map<string, DeviceTypeRecordFile>;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Helpers
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function sha256Hex(text: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function versionTuple(version: string | undefined): number[] {
    return (version ?? "").match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
}

// a < b as Python compares version tuples
export function versionLessThan(a: string, b: string): boolean {
    const ta = versionTuple(a);
    const tb = versionTuple(b);
    for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
        if (i >= ta.length)
            return true;
        if (i >= tb.length)
            return false;
        if (ta[i] !== tb[i])
            return ta[i] < tb[i];
    }
    return false;
}

async function fetchText(fetchFn: DeviceTypeFetch, url: string, what: string, headers?: Record<string, string>): Promise<string> {
    let resp;
    try {
        resp = await fetchFn(url, headers ? { headers } : undefined);
    } catch (err) {
        throw new DeviceTypeSourceError(`${what}: couldn't fetch ${url} (${err instanceof Error ? err.message : err})`);
    }
    if (!resp.ok)
        throw new DeviceTypeSourceError(`${what}: ${url} gave HTTP ${resp.status}`);
    return resp.text();
}

function parse(text: string, where: string): DevTypeJson {
    try {
        return parseDevTypeJson(text);
    } catch (err) {
        throw new DeviceTypeSourceError(`${where}: not valid JSON (${err instanceof Error ? err.message : err})`);
    }
}

function recordFromFile(file: DeviceTypeRecordFile, key: string): DevTypeJson {
    const record = parse(file.text, file.path);
    if (!isDevTypeJsonObject(record))
        throw new DeviceTypeSourceError(`${file.path}: a record file holds one record (a JSON object)`);
    if (record.has("devTypes"))
        throw new DeviceTypeSourceError(`${file.path}: a catalogue file (with "devTypes") in a folder of records`);
    const deviceType = record.get("deviceType");
    if (deviceType !== undefined && deviceType !== key)
        throw new DeviceTypeSourceError(`${file.path}: deviceType "${deviceType}" differs from the file name "${key}"`);
    return record;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const keyOf = (path: string) => baseName(path).replace(/\.json$/, "");

// Records from files, as a build reads a source's path: a folder of record files (<Key>.json, in key order), one
// record file, or a catalogue file ({"devTypes": {...}})
export function recordsFromFiles(files: DeviceTypeRecordFile[], asFolder: boolean): DeviceTypeSourceRecordsWithFiles {
    const records = new Map<string, DevTypeJson>();
    const fileMap = new Map<string, DeviceTypeRecordFile>();
    if (asFolder) {
        const jsonFiles = files.filter((f) => f.path.endsWith(".json"));
        jsonFiles.sort((a, b) => compareCodePoints(keyOf(a.path), keyOf(b.path)));
        for (const file of jsonFiles) {
            const key = keyOf(file.path);
            records.set(key, recordFromFile(file, key));
            fileMap.set(key, file);
        }
        return { records, files: fileMap };
    }
    if (files.length !== 1)
        throw new DeviceTypeSourceError("expected one file");
    const file = files[0];
    const content = parse(file.text, file.path);
    const devTypes = devTypeJsonGet(content, "devTypes");
    if (isDevTypeJsonObject(devTypes)) {
        devTypes.forEach((rec, key) => { records.set(key, rec); fileMap.set(key, file); });
        return { records, files: fileMap };
    }
    const key = keyOf(file.path);
    records.set(key, recordFromFile(file, key));
    fileMap.set(key, file);
    return { records, files: fileMap };
}

// A source's raftdevtypes.json manifest: its format, and the RaftCore it needs
export function checkSourceManifest(name: string, text: string | undefined, raftCore: string | undefined) {
    if (text === undefined)
        return;
    const manifest = parse(text, `source "${name}": ${DEVICE_TYPE_SOURCE_MANIFEST}`);
    const fmt = devTypeJsonGet(manifest, "formatVersion");
    const fmtValue = fmt === undefined ? 1 : (fmt instanceof DevTypeJsonNumber ? fmt.value : fmt);
    if (fmtValue !== DEVICE_TYPE_SOURCE_FORMAT_VERSION)
        throw new DeviceTypeSourceError(`source "${name}": ${DEVICE_TYPE_SOURCE_MANIFEST} formatVersion ${fmtValue} isn't supported ` +
            `(supports ${DEVICE_TYPE_SOURCE_FORMAT_VERSION})`);
    const needed = devTypeJsonGet(manifest, "minRaftCore");
    if (typeof needed === "string" && needed && raftCore && versionLessThan(raftCore, needed))
        throw new DeviceTypeSourceError(`source "${name}" needs RaftCore ${needed} or later (the device has ${raftCore})`);
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// RaftCore's records: the catalogue on RaftCore's GitHub Pages site
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface DeviceTypeCatalogueSummary {
    name?: string;
    manu?: string;
    type?: string;
    clas?: string[] | string;
    addresses?: string;
    hwTypeId?: string;
    hasData: boolean;
    customCode: boolean;
    initCode: boolean;
}

export interface DeviceTypeCatalogueEntry {
    key: string;
    file: string;
    sha256: string;
    summary: DeviceTypeCatalogueSummary;
}

export interface DeviceTypeCatalogueIndex {
    formatVersion: number;
    latest: string | null;
    versions: Array<{ label: string; raftCore?: string; count?: number }>;
}

export interface DeviceTypeCatalogueInfo {
    formatVersion: number;
    label: string;
    raftCore?: string;
    recordFormat?: number;
    count: number;
    records: DeviceTypeCatalogueEntry[];
}

export class RaftCoreCatalogue {
    private _records: Map<string, DevTypeJson> | undefined = undefined;

    private constructor(public readonly baseUrl: string, public readonly info: DeviceTypeCatalogueInfo,
                        private _fetch: DeviceTypeFetch) {}

    get label(): string {
        return this.info.label;
    }

    get raftCore(): string | undefined {
        return this.info.raftCore;
    }

    // The versions published
    static async index(fetchFn: DeviceTypeFetch, baseUrl = RAFTCORE_PAGES_CATALOGUE_URL): Promise<DeviceTypeCatalogueIndex> {
        return JSON.parse(await fetchText(fetchFn, `${baseUrl}/index.json`, "RaftCore catalogue")) as DeviceTypeCatalogueIndex;
    }

    // The version to use for a device of a RaftCore version: that release if published, else the newest release not
    // newer than it, else the latest
    static chooseVersion(index: DeviceTypeCatalogueIndex, raftCore: string | undefined): string | undefined {
        const releases = index.versions.filter((v) => /^v?\d+\.\d+\.\d+$/.test(v.label));
        if (raftCore) {
            const exact = releases.find((v) => v.label.replace(/^v/, "") === raftCore.replace(/^v/, ""));
            if (exact)
                return exact.label;
            const older = releases.find((v) => !versionLessThan(raftCore, v.label));
            if (older)
                return older.label;
        }
        return index.latest ?? index.versions[0]?.label;
    }

    static async open(fetchFn: DeviceTypeFetch, label: string, baseUrl = RAFTCORE_PAGES_CATALOGUE_URL): Promise<RaftCoreCatalogue> {
        const info = JSON.parse(await fetchText(fetchFn, `${baseUrl}/${label}/catalogue.json`, "RaftCore catalogue")) as DeviceTypeCatalogueInfo;
        return new RaftCoreCatalogue(baseUrl, info, fetchFn);
    }

    entries(): DeviceTypeCatalogueEntry[] {
        return this.info.records;
    }

    // Every record (one fetch of the version's DeviceTypeRecords.json)
    async records(): Promise<DeviceTypeSourceRecords> {
        if (!this._records) {
            const text = await fetchText(this._fetch, `${this.baseUrl}/${this.label}/DeviceTypeRecords.json`, "RaftCore catalogue");
            const devTypes = devTypeJsonGet(parse(text, "DeviceTypeRecords.json"), "devTypes");
            if (!isDevTypeJsonObject(devTypes))
                throw new DeviceTypeSourceError("RaftCore catalogue: DeviceTypeRecords.json has no devTypes");
            this._records = devTypes;
        }
        return { records: this._records, raftCore: this.raftCore };
    }

    // One record's file, as it is in RaftCore
    async recordFile(key: string): Promise<DeviceTypeRecordFile> {
        const entry = this.info.records.find((r) => r.key === key);
        if (!entry)
            throw new DeviceTypeSourceError(`RaftCore catalogue ${this.label}: no record "${key}"`);
        return { path: entry.file, text: await fetchText(this._fetch, `${this.baseUrl}/${this.label}/${entry.file}`, "RaftCore catalogue") };
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Git sources on GitHub
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// owner and repo of a GitHub URL (https://github.com/o/r(.git), git@github.com:o/r.git), or undefined
export function parseGitHubUrl(url: string): { owner: string; repo: string } | undefined {
    const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    return m ? { owner: m[1], repo: m[2] } : undefined;
}

export interface GitHubSourceOptions {
    fetch: DeviceTypeFetch;
    apiUrl?: string;            // default https://api.github.com
    rawUrl?: string;            // default https://raw.githubusercontent.com
    token?: string;             // for the API's rate limit (kept by the caller)
    raftCore?: string;          // the RaftCore the records are for (checked against the source's minRaftCore)
}

// Files read at a commit never change, so they are kept for the session
const gitHubCache = new Map<string, Promise<string>>();

// A git source's records from GitHub: ref resolved to a commit (or the locked commit), the manifest checked, the
// files at path read (a folder of record files, one record file or a catalogue file; default path "records")
export async function readGitHubSource(name: string, spec: DevTypeJsonObject, options: GitHubSourceOptions,
                                       lockedCommit?: string): Promise<DeviceTypeSourceRecordsWithFiles> {
    const url = spec.get("git");
    const ref = spec.get("ref");
    if (typeof url !== "string")
        throw new DeviceTypeSourceError(`source "${name}": "git" must be a URL`);
    if (typeof ref !== "string" || !ref)
        throw new DeviceTypeSourceError(`source "${name}": "ref" (a tag, branch or commit) is needed`);
    const pathSpec = spec.get("path");
    const subpath = (typeof pathSpec === "string" ? pathSpec : "records").replace(/^\/+|\/+$/g, "");
    const repo = parseGitHubUrl(url);
    if (!repo)
        throw new DeviceTypeSourceError(`source "${name}": only GitHub repos can be read here (${url})`);
    const api = options.apiUrl ?? "https://api.github.com";
    const raw = options.rawUrl ?? "https://raw.githubusercontent.com";
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (options.token)
        headers.Authorization = `Bearer ${options.token}`;
    const cached = (key: string, get: () => Promise<string>) => {
        if (!gitHubCache.has(key))
            gitHubCache.set(key, get().catch((err) => { gitHubCache.delete(key); throw err; }));
        return gitHubCache.get(key) as Promise<string>;
    };
    const what = `source "${name}"`;

    // The commit
    let commit = lockedCommit;
    if (!commit)
        commit = /^[0-9a-f]{40}$/i.test(ref) ? ref.toLowerCase() : undefined;
    if (!commit) {
        const resp = JSON.parse(await fetchText(options.fetch, `${api}/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`,
            what, headers)) as { sha?: string };
        if (!resp.sha)
            throw new DeviceTypeSourceError(`${what}: ${ref} not found in ${url}`);
        commit = resp.sha;
    }
    const base = `${repo.owner}/${repo.repo}/${commit}`;

    // The tree at the commit
    const treeText = await cached(`tree:${base}`, () =>
        fetchText(options.fetch, `${api}/repos/${repo.owner}/${repo.repo}/git/trees/${commit}?recursive=1`, what, headers));
    const tree = JSON.parse(treeText) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
    const entries = tree.tree ?? [];
    const readFile = (path: string) => cached(`file:${base}/${path}`, () =>
        fetchText(options.fetch, `${raw}/${base}/${path.split("/").map(encodeURIComponent).join("/")}`, what));

    if (entries.some((e) => e.path === DEVICE_TYPE_SOURCE_MANIFEST && e.type === "blob"))
        checkSourceManifest(name, await readFile(DEVICE_TYPE_SOURCE_MANIFEST), options.raftCore);

    const asFile = entries.find((e) => e.path === subpath && e.type === "blob");
    const inFolder = entries.filter((e) => e.type === "blob" && e.path.startsWith(subpath + "/") &&
        !e.path.slice(subpath.length + 1).includes("/") && e.path.endsWith(".json"));
    if (!asFile && !entries.some((e) => e.path === subpath && e.type === "tree"))
        throw new DeviceTypeSourceError(`${what}: ${subpath} not found in the repo`);
    const files = await Promise.all((asFile ? [asFile] : inFolder).map(async (e) => ({ path: e.path, text: await readFile(e.path) })));
    const result = recordsFromFiles(files, !asFile);
    // Code from another source may use only the decode language (as a build checks a git source)
    result.records.forEach((record, key) => {
        const problems = checkDeviceTypeRecordCode(record);
        if (problems.length > 0)
            throw new DeviceTypeSourceError(`"${key}" from source "${name}": its decode code (resp.c) isn't allowed: ${problems.join("; ")}`);
    });
    return { ...result, commit };
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// The lock file
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// DeviceTypeSources.lock for a resolved selection, as a build writes it: the commit each git source resolved to,
// and the SHA-256 of each record from a git source
export async function deviceTypeLockText(merged: MergedDeviceTypeSources, result: DeviceTypeSelectionResult,
                                         sourceRecords: Map<string, DeviceTypeSourceRecords | DeviceTypeSourceRecordsWithFiles>): Promise<string> {
    const sources: DevTypeJsonObject = new Map();
    for (const [name, spec] of merged.sources) {
        const commit = sourceRecords.get(name)?.commit;
        if (deviceTypeSourceKind(spec) !== "git" || !commit)
            continue;
        sources.set(name, new Map<string, DevTypeJson>([["git", spec.get("git") as DevTypeJson], ["ref", spec.get("ref") as DevTypeJson],
            ["commit", commit]]));
    }
    const records: DevTypeJsonObject = new Map();
    for (const [key, source] of result.origin) {
        if (!sources.has(source))
            continue;
        const loaded = sourceRecords.get(source) as DeviceTypeSourceRecordsWithFiles;
        const file = loaded.files?.get(key);
        if (!file)
            throw new DeviceTypeSourceError(`"${key}" from source "${source}": its file wasn't kept, so it can't be hashed`);
        records.set(key, new Map<string, DevTypeJson>([["source", source], ["commit", loaded.commit as string],
            ["sha256", await sha256Hex(file.text)]]));
    }
    return writeDevTypeJson(new Map<string, DevTypeJson>([["formatVersion", new DevTypeJsonNumber(String(DEVICE_TYPE_LOCK_FORMAT_VERSION))],
        ["sources", sources], ["records", records]]), { indent: 1 }) + "\n";
}
