// The app's state and what it does, apart from the views: the catalogue, the sources and the selection (a
// DeviceTypeSources.json), the device and its type file, building, pushing and exporting

import {
    DevManTypeFileCheck, DevManTypeFileStatus, DevTypeJson, DevTypeJsonObject, DeviceTypeCatalogueEntry, DeviceTypeCatalogueIndex,
    DeviceTypeFileManager, DeviceTypePolicyName, DeviceTypeRecordFile, DeviceTypeSelectionResult, DeviceTypeSourceRecords,
    DeviceTypeSourceRecordsWithFiles, DevManTypeTableEntry, MergedDeviceTypeSources, RaftConnEvent, RaftConnector, RaftCoreCatalogue,
    RaftSystemUtils, TYPE_FILE_MAX_BYTES_DEFAULT_PSRAM, TypeFileBuildResult, checkDeviceTypeRecordCode, TypeFilePushResult, TypeFilePushStage, TypeFileResponse, buildTypeFile,
    deviceTypeLockText, deviceTypeSourceKind, devTypeJsonFromPlain, devTypeJsonGet, devTypeJsonToPlain, isDevTypeJsonObject,
    mergeDeviceTypeSources, parseDevTypeJson, readGitHubSource, recordsFromFiles, resolveDeviceTypeSelection, sha256Hex,
    writeDevTypeJson, RAFTCORE_PAGES_CATALOGUE_URL,
} from "../../../src/main";
import SystemTypeDevTypes from "./SystemTypeDevTypes";
import { joinPath, makeZip, parseAddresses, readStore, writeStore } from "./util";

export interface SectionSpec { include?: string[]; exclude?: string[]; policy?: Record<string, DeviceTypePolicyName>; fsImage?: boolean }
export interface SourcesFile { sources: Record<string, Record<string, unknown>>; builtin?: SectionSpec; typeFile: SectionSpec }

// Records the user picked for a path source (kept in the browser)
export interface LocalSourceFiles { files: DeviceTypeRecordFile[]; asFolder: boolean }

export interface DeviceInfo {
    systemName?: string;
    systemVersion?: string;
    status?: TypeFileResponse<DevManTypeFileStatus>;
    table?: DevManTypeTableEntry[];
    devices: Array<{ deviceid: string; displayName?: string; dtIdx?: number; key?: string }>;
    unidentified: Array<{ bus: string; addr: number; slot: number; state: string }>;
    pulled?: { text: string; crc: string; path: string; keys: string[]; sources?: unknown };
    error?: string;
}

export interface BuildState {
    merged?: MergedDeviceTypeSources;
    selection?: DeviceTypeSelectionResult;
    result?: TypeFileBuildResult;
    error?: string;
    offline: boolean;                       // no device: records shown as new
    unknownCompiled: string[];              // keys the device's type file overrides (compiled record unknown)
    maxBytes: number;                       // the device's limit, or (no device) the limit of boards with PSRAM
    codeProblems: Map<string, string[]>;    // records from local files whose code isn't in the decode language
}

export interface PushState {
    stage?: TypeFilePushStage;
    detail?: string;
    check?: TypeFileResponse<DevManTypeFileCheck>;
    awaitingConfirm?: boolean;
    result?: TypeFilePushResult;
}

const DEFAULT_SELECTION: SourcesFile = { sources: { raftcore: { bundled: true } }, typeFile: { include: [] } };
const STORE_SELECTION = "devtypes.selection";
const STORE_LOCAL = "devtypes.localSources";
const STORE_LOCK = "devtypes.lockedCommits";
const STORE_SYSTYPE = "devtypes.sysType";

export type ConnState = "disconnected" | "connecting" | "connected";

function catalogueBaseUrl(): string {
    const param = new URLSearchParams(location.search).get("catalogue");
    if (param)
        return param.replace(/\/+$/, "");
    // Hosted beside the catalogue (RaftCore's Pages site, devtypes/app/): use it from the same origin
    const m = /^(.*\/devtypes)\/app(\/|$)/.exec(location.pathname);
    if (m)
        return location.origin + m[1];
    return RAFTCORE_PAGES_CATALOGUE_URL;
}

const browserFetch = (url: string, init?: { headers?: Record<string, string> }) => fetch(url, init);

export class DevTypesModel {
    // State (views read these and re-render on change)
    catalogueBase = catalogueBaseUrl();
    index?: DeviceTypeCatalogueIndex;
    catalogue?: RaftCoreCatalogue;
    catalogueError?: string;
    selection: SourcesFile = readStore(STORE_SELECTION, DEFAULT_SELECTION);
    localSources: Record<string, LocalSourceFiles> = readStore(STORE_LOCAL, {});
    lockedCommits: Record<string, string> = readStore(STORE_LOCK, {});
    sysType: string = readStore(STORE_SYSTYPE, "Main");
    sourceRecords = new Map<string, DeviceTypeSourceRecords | DeviceTypeSourceRecordsWithFiles>();
    sourceErrors = new Map<string, string>();
    sourcesLoading = false;
    connState: ConnState = "disconnected";
    connError?: string;
    connMethod?: string;
    device?: DeviceInfo;
    compiled = new Map<string, DevTypeJson>();
    build: BuildState = { offline: true, unknownCompiled: [], maxBytes: TYPE_FILE_MAX_BYTES_DEFAULT_PSRAM, codeProblems: new Map() };
    pushState: PushState = {};
    message?: { text: string; error?: boolean };

    private _listeners = new Set<() => void>();
    private _connector?: RaftConnector;
    private _manager?: DeviceTypeFileManager;
    private _confirmResolve?: (ok: boolean) => void;
    private _version = 0;

    get version() {
        return this._version;
    }

    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    private changed() {
        this._version++;
        this._listeners.forEach((l) => l());
    }

    notify(text: string, error = false) {
        this.message = { text, error };
        this.changed();
    }

    dismissMessage() {
        this.message = undefined;
        this.changed();
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Catalogue
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////

    async start() {
        try {
            this.index = await RaftCoreCatalogue.index(browserFetch, this.catalogueBase);
            await this.openCatalogue(RaftCoreCatalogue.chooseVersion(this.index, undefined) ?? "main");
        } catch (err) {
            this.catalogueError = `The catalogue couldn't be read from ${this.catalogueBase}: ${errText(err)}`;
            this.changed();
        }
        await this.loadSources();
    }

    async openCatalogue(label: string) {
        try {
            this.catalogue = await RaftCoreCatalogue.open(browserFetch, label, this.catalogueBase);
            this.catalogueError = undefined;
        } catch (err) {
            this.catalogueError = errText(err);
        }
        this.sourceRecords.forEach((_, name) => {
            if (this.sourceKind(name) === "bundled")
                this.sourceRecords.delete(name);
        });
        this.changed();
        await this.loadSources();
    }

    catalogueEntry(key: string): DeviceTypeCatalogueEntry | undefined {
        return this.catalogue?.entries().find((e) => e.key === key);
    }

    // Catalogue records that can be at an I2C address
    recordsForAddress(addr: number): DeviceTypeCatalogueEntry[] {
        return (this.catalogue?.entries() ?? []).filter((e) => parseAddresses(e.summary.addresses).includes(addr));
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Sources and the selection
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////

    sourceKind(name: string) {
        const spec = this.selection.sources[name];
        return spec ? deviceTypeSourceKind(devTypeJsonFromPlain(spec) as DevTypeJsonObject) : undefined;
    }

    private saveSelection() {
        writeStore(STORE_SELECTION, this.selection);
        writeStore(STORE_LOCAL, this.localSources);
        writeStore(STORE_LOCK, this.lockedCommits);
        writeStore(STORE_SYSTYPE, this.sysType);
    }

    setSysType(name: string) {
        this.sysType = name.replace(/[^A-Za-z0-9_-]/g, "") || "Main";
        this.saveSelection();
        this.changed();
    }

    // Read every source's records that aren't read yet
    async loadSources() {
        this.sourcesLoading = true;
        this.changed();
        for (const [name, spec] of Object.entries(this.selection.sources)) {
            if (this.sourceRecords.has(name))
                continue;
            this.sourceErrors.delete(name);
            try {
                const kind = this.sourceKind(name);
                if (kind === "bundled") {
                    if (!this.catalogue)
                        throw new Error("RaftCore's catalogue isn't available");
                    this.sourceRecords.set(name, await this.catalogue.records());
                } else if (kind === "git") {
                    const raftCore = this.device?.status?.raftCore;
                    this.sourceRecords.set(name, await readGitHubSource(name, devTypeJsonFromPlain(spec) as DevTypeJsonObject,
                        { fetch: browserFetch, raftCore }, this.lockedCommits[name]));
                } else if (kind === "path") {
                    const local = this.localSources[name];
                    if (!local)
                        throw new Error("pick its record files (a path source's records are only on your computer)");
                    this.sourceRecords.set(name, recordsFromFiles(local.files, local.asFolder));
                } else {
                    throw new Error('needs "bundled", "path" or "git"');
                }
            } catch (err) {
                this.sourceErrors.set(name, errText(err));
            }
        }
        this.sourcesLoading = false;
        await this.rebuild();
    }

    async addBundledSource() {
        const name = this.selection.sources.raftcore ? "raftcore2" : "raftcore";
        this.selection.sources = { [name]: { bundled: true }, ...this.selection.sources };
        this.saveSelection();
        await this.loadSources();
    }

    async addGitSource(name: string, url: string, ref: string, path: string) {
        const spec: Record<string, unknown> = { git: url.trim(), ref: ref.trim() };
        if (path.trim())
            spec.path = path.trim();
        this.selection.sources[name] = spec;
        delete this.lockedCommits[name];
        this.sourceRecords.delete(name);
        this.saveSelection();
        await this.loadSources();
    }

    async addLocalSource(name: string, path: string, files: DeviceTypeRecordFile[], asFolder: boolean) {
        this.selection.sources[name] = { path: path.trim() || `../../${name}` };
        this.localSources[name] = { files, asFolder };
        this.sourceRecords.delete(name);
        this.saveSelection();
        await this.loadSources();
    }

    async setLocalFiles(name: string, files: DeviceTypeRecordFile[], asFolder: boolean) {
        this.localSources[name] = { files, asFolder };
        this.sourceRecords.delete(name);
        this.saveSelection();
        await this.loadSources();
    }

    // A git source: resolve its ref again (take new commits on a branch)
    async updateGitSource(name: string) {
        delete this.lockedCommits[name];
        this.sourceRecords.delete(name);
        this.saveSelection();
        await this.loadSources();
    }

    async removeSource(name: string) {
        delete this.selection.sources[name];
        delete this.localSources[name];
        delete this.lockedCommits[name];
        this.sourceRecords.delete(name);
        this.sourceErrors.delete(name);
        const tf = this.selection.typeFile;
        tf.include = (tf.include ?? []).filter((p) => !p.startsWith(name + ":"));
        tf.exclude = (tf.exclude ?? []).filter((p) => !p.startsWith(name + ":"));
        this.saveSelection();
        await this.rebuild();
    }

    includes(pattern: string): boolean {
        return (this.selection.typeFile.include ?? []).includes(pattern);
    }

    async toggleInclude(pattern: string, on: boolean) {
        const tf = this.selection.typeFile;
        tf.include = (tf.include ?? []).filter((p) => p !== pattern);
        if (on)
            tf.include.push(pattern);
        this.saveSelection();
        await this.rebuild();
    }

    policyOf(key: string): DeviceTypePolicyName | undefined {
        return this.selection.typeFile.policy?.[key];
    }

    async setPolicy(key: string, policy: DeviceTypePolicyName | undefined) {
        const tf = this.selection.typeFile;
        tf.policy = { ...(tf.policy ?? {}) };
        if (policy)
            tf.policy[key] = policy;
        else
            delete tf.policy[key];
        this.saveSelection();
        await this.rebuild();
    }

    async clearSelection() {
        this.selection.typeFile = { include: [] };
        this.saveSelection();
        await this.rebuild();
    }

    // A project's DeviceTypeSources.json files (Common's, then the SysType's) and lock: merged into the app's selection
    async importProject(files: Array<{ name: string; text: string }>, lockText?: string) {
        try {
            const merged = mergeDeviceTypeSources(files.map((f) => ({ name: f.name, content: f.text })));
            const sources: SourcesFile["sources"] = {};
            merged.sources.forEach((spec, name) => { sources[name] = devTypeJsonToPlain(spec) as Record<string, unknown>; });
            const section = (s: MergedDeviceTypeSources["sections"]["builtin"]): SectionSpec => {
                const out: SectionSpec = {};
                if (s.hasInclude)
                    out.include = [...s.include];
                if (s.exclude.length)
                    out.exclude = [...s.exclude];
                if (s.policy.size)
                    out.policy = Object.fromEntries(s.policy);
                if (s.fsImage)
                    out.fsImage = true;
                return out;
            };
            this.selection = { sources, builtin: section(merged.sections.builtin), typeFile: section(merged.sections.typeFile) };
            if (!this.selection.typeFile.include)
                this.selection.typeFile.include = [];
            this.lockedCommits = {};
            if (lockText) {
                const lock = JSON.parse(lockText) as { sources?: Record<string, { git?: string; ref?: string; commit?: string }> };
                for (const [name, entry] of Object.entries(lock.sources ?? {})) {
                    const spec = sources[name];
                    if (spec && entry.commit && spec.git === entry.git && spec.ref === entry.ref)
                        this.lockedCommits[name] = entry.commit;
                }
            }
            const sysTypeMatch = /systypes\/([^/]+)\/DeviceTypeSources\.json$/.exec(files[files.length - 1]?.name ?? "");
            if (sysTypeMatch && sysTypeMatch[1] !== "Common")
                this.sysType = sysTypeMatch[1];
            this.sourceRecords.clear();
            this.sourceErrors.clear();
            this.saveSelection();
            this.notify(`Imported ${files.map((f) => f.name).join(" and ")}${lockText ? " with its lock" : ""}`);
            await this.loadSources();
        } catch (err) {
            this.notify(`Not imported: ${errText(err)}`, true);
        }
    }

    // The device's pulled type file into the selection: its _sources if it has them, otherwise its records as a
    // local source and its "disable" entries as policies
    async usePulledFile() {
        const pulled = this.device?.pulled;
        if (!pulled)
            return;
        const parsed = DeviceTypeFileManager.parseTypeFile(pulled.text);
        const prov = parsed.sources !== undefined ? devTypeJsonToPlain(parsed.sources) as Record<string, any> : undefined;
        if (prov && prov.sources && prov.typeFile) {
            const sources: SourcesFile["sources"] = {};
            for (const [name, s] of Object.entries<any>(prov.sources)) {
                if (s.git) {
                    sources[name] = { git: s.git, ...(s.ref ? { ref: s.ref } : {}), ...(s.path ? { path: s.path } : {}) };
                    if (s.commit)
                        this.lockedCommits[name] = s.commit;
                } else if (s.bundled) {
                    sources[name] = { bundled: true };
                } else {
                    sources[name] = { path: s.path ?? "" };
                }
            }
            // Path sources' records are in the file itself
            const files: DeviceTypeRecordFile[] = [];
            parsed.devTypes.forEach((rec, key) => files.push({ path: `${key}.json`, text: writeDevTypeJson(rec, { indent: 4 }) + "\n" }));
            for (const name of Object.keys(sources)) {
                if (!sources[name].git && !sources[name].bundled)
                    this.localSources[name] = { files, asFolder: true };
            }
            this.selection = { sources, typeFile: { include: prov.typeFile.include ?? [], exclude: prov.typeFile.exclude, policy: prov.typeFile.policy } };
            this.notify("The selection the device's file was made from (its _sources) is loaded");
        } else {
            const files: DeviceTypeRecordFile[] = [];
            const policy: Record<string, DeviceTypePolicyName> = {};
            parsed.devTypes.forEach((rec, key) => {
                const disable = devTypeJsonGet(rec, "disable");
                if (isDevTypeJsonObject(rec) && rec.size === 1 && disable !== undefined)
                    policy[key] = disable === "claim" ? "disabledClaim" : "disabled";
                else
                    files.push({ path: `${key}.json`, text: writeDevTypeJson(rec, { indent: 4 }) + "\n" });
            });
            this.selection = { sources: { ...this.selection.sources, device: { path: "../../devtypes" } },
                typeFile: { include: files.length ? ["device:*"] : [], policy } };
            this.localSources.device = { files, asFolder: true };
            this.notify("The device's file has no _sources: its records are loaded as the local source \"device\"");
        }
        this.sourceRecords.clear();
        this.saveSelection();
        await this.loadSources();
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Building the type file
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////

    async rebuild() {
        const build: BuildState = { offline: !this.device?.table, unknownCompiled: [], codeProblems: new Map(),
            maxBytes: this.device?.status?.maxFileBytes ?? TYPE_FILE_MAX_BYTES_DEFAULT_PSRAM };
        try {
            const sources = new Map<string, DeviceTypeSourceRecords>();
            for (const name of Object.keys(this.selection.sources)) {
                const loaded = this.sourceRecords.get(name);
                if (!loaded)
                    throw new Error(`source "${name}": ${this.sourceErrors.get(name) ?? "not read yet"}`);
                sources.set(name, loaded);
            }
            build.merged = mergeDeviceTypeSources([{ name: "selection", content: JSON.stringify(this.selection) }]);
            build.selection = resolveDeviceTypeSelection(build.merged, "typeFile", sources);
            // Code from local files (a git source with such code isn't read at all, and RaftCore's records pass)
            build.selection.records.forEach((rec, key) => {
                if (this.sourceKind(build.selection?.origin.get(key) ?? "") !== "path")
                    return;
                const problems = checkDeviceTypeRecordCode(rec);
                if (problems.length > 0)
                    build.codeProblems.set(key, problems);
            });
            // The records the device has compiled in (from the device), for new / override / unchanged
            const compiled = new Map<string, DevTypeJson>();
            const table = this.device?.table;
            if (table && this._manager) {
                for (const key of [...build.selection.records.keys(), ...build.selection.policyOnly.keys()]) {
                    const entry = table.find((t) => t.key === key);
                    if (!entry)
                        continue;
                    if (entry.src === "base") {
                        if (!this.compiled.has(key)) {
                            const rec = await this._manager.deviceRecord(key);
                            if (rec !== undefined)
                                this.compiled.set(key, rec);
                        }
                        const rec = this.compiled.get(key);
                        if (rec !== undefined)
                            compiled.set(key, rec);
                    } else if (entry.src === "override") {
                        // Overridden by the device's type file: its compiled record can't be read, so the record is kept
                        compiled.set(key, parseDevTypeJson('{"_compiledRecordUnknown":true}'));
                        build.unknownCompiled.push(key);
                    }
                }
            } else {
                // No device: policies are taken as being for compiled types
                build.selection.policyOnly.forEach((_, key) => compiled.set(key, parseDevTypeJson("{}")));
            }
            build.result = buildTypeFile({ records: build.selection.records, policyOnly: build.selection.policyOnly,
                provenance: build.selection.provenance }, compiled, { maxBytes: build.maxBytes });
        } catch (err) {
            build.error = errText(err);
        }
        this.build = build;
        this.changed();
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // The device
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////

    get connector(): RaftConnector | undefined {
        return this._connector;
    }

    async connect(method: "WebBLE" | "WebSerial" | "WebSocket", locator = "") {
        this.connState = "connecting";
        this.connError = undefined;
        this.changed();
        try {
            const sysType = new SystemTypeDevTypes();
            const connector = new RaftConnector(async (_utils: RaftSystemUtils) => sysType);
            connector.setEventListener((type, evt) => {
                if (type === "conn" && evt === RaftConnEvent.CONN_DISCONNECTED && this.connState === "connected" && !this.pushState.stage) {
                    this.connState = "disconnected";
                    this.changed();
                }
            });
            await connector.initializeChannel(method);
            let ok: boolean;
            if (method === "WebBLE") {
                const dev = await navigator.bluetooth.requestDevice({ filters: sysType.BLEServiceUUIDs.map((uuid) => ({ services: [uuid] })) });
                ok = await connector.connect(dev as unknown as object);
            } else {
                ok = await connector.connect(locator);
            }
            if (!ok)
                throw new Error("the connection failed");
            this._connector = connector;
            this._manager = new DeviceTypeFileManager(connector);
            this.connMethod = method;
            this.connState = "connected";
            this.compiled.clear();
            this.changed();
            await this.refreshDevice();
        } catch (err) {
            this.connState = "disconnected";
            this.connError = errText(err);
            this.changed();
        }
    }

    async disconnect() {
        await this._connector?.disconnect();
        this._connector = undefined;
        this._manager = undefined;
        this.connState = "disconnected";
        this.device = undefined;
        this.compiled.clear();
        await this.rebuild();
    }

    async refreshDevice() {
        const conn = this._connector;
        const manager = this._manager;
        if (!conn || !manager)
            return;
        const info: DeviceInfo = { devices: [], unidentified: [], pulled: this.device?.pulled };
        try {
            const v = await conn.sendRICRESTMsg("v", {}) as { SystemName?: string; SystemVersion?: string };
            info.systemName = v.SystemName;
            info.systemVersion = v.SystemVersion;
            info.status = await manager.status(true);
            if (info.status?.rslt !== "ok")
                info.error = "This firmware has no device type file support (devman/typefile)";
            info.table = await manager.table();
            const list = await conn.sendRICRESTMsg("devman/listdevs", {}) as { devices?: DeviceInfo["devices"] };
            info.devices = (list.devices ?? []).map((d) => ({ ...d, key: info.table?.find((t) => t.dtIdx === d.dtIdx)?.key }));
            const bus = await conn.sendRICRESTMsg("devman/busstatus", {}) as { buses?: Record<string, { identTiming?: Array<{ addr: string; state: string }> }> };
            for (const [busName, b] of Object.entries(bus.buses ?? {})) {
                for (const t of b.identTiming ?? []) {
                    if (t.state !== "noMatch")
                        continue;
                    const raw = parseInt(t.addr, 16);
                    info.unidentified.push({ bus: busName, addr: raw & 0xff, slot: (raw >> 8) & 0x3f, state: t.state });
                }
            }
        } catch (err) {
            info.error = errText(err);
        }
        this.device = info;
        // The catalogue of the device's RaftCore version
        const raftCore = info.status?.raftCore;
        if (raftCore && this.index) {
            const label = RaftCoreCatalogue.chooseVersion(this.index, raftCore);
            if (label && label !== this.catalogue?.label) {
                await this.openCatalogue(label);
                return;
            }
        }
        await this.rebuild();
    }

    async pull() {
        if (!this._manager || !this.device)
            return;
        const pulled = await this._manager.pull();
        if (!pulled) {
            this.notify("The device has no type file to read", true);
            return;
        }
        try {
            const parsed = DeviceTypeFileManager.parseTypeFile(pulled.text);
            this.device.pulled = { ...pulled, keys: Array.from(parsed.devTypes.keys()),
                sources: parsed.sources !== undefined ? devTypeJsonToPlain(parsed.sources) : undefined };
            this.changed();
        } catch (err) {
            this.notify(`The device's type file isn't valid: ${errText(err)}`, true);
        }
    }

    async push(dryRun: boolean) {
        const text = this.build.result?.text;
        if (!this._manager || !text)
            return;
        this.pushState = { stage: "status" };
        this.changed();
        const result = await this._manager.push(text, {
            expectedDeviceCrc: this.device?.pulled?.crc,
            dryRun,
            onProgress: (stage, detail) => {
                this.pushState = { ...this.pushState, stage, detail };
                this.changed();
            },
            confirm: (check) => new Promise<boolean>((resolve) => {
                this._confirmResolve = resolve;
                this.pushState = { ...this.pushState, check, awaitingConfirm: true };
                this.changed();
            }),
        });
        this.pushState = { check: result.check ?? this.pushState.check, result };
        this.changed();
        if (result.outcome === "applied") {
            this.device = { ...(this.device as DeviceInfo), pulled: undefined };
            await this.refreshDevice();
        }
    }

    confirmPush(ok: boolean) {
        this.pushState = { ...this.pushState, awaitingConfirm: false };
        this._confirmResolve?.(ok);
        this._confirmResolve = undefined;
        this.changed();
    }

    async reidentify() {
        await this._connector?.sendRICRESTMsg("devman/reident?unidentified=1", {});
        setTimeout(() => void this.refreshDevice(), 1500);
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Export
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////

    sourcesFileText(asBuiltin = false): string {
        const out: Record<string, unknown> = { sources: this.selection.sources };
        if (asBuiltin) {
            out.builtin = { ...this.selection.typeFile, fsImage: undefined };
        } else {
            if (this.selection.builtin && Object.keys(this.selection.builtin).length)
                out.builtin = this.selection.builtin;
            out.typeFile = this.selection.typeFile;
        }
        return JSON.stringify(out, null, 4) + "\n";
    }

    async lockText(): Promise<string | undefined> {
        const { merged, selection } = this.build;
        if (!merged || !selection)
            return undefined;
        const hasGit = Object.keys(this.selection.sources).some((n) => this.sourceKind(n) === "git");
        return hasGit ? deviceTypeLockText(merged, selection, this.sourceRecords) : undefined;
    }

    async manifestText(): Promise<string> {
        const records: Record<string, unknown> = {};
        for (const [key, source] of this.build.selection?.origin ?? []) {
            const loaded = this.sourceRecords.get(source) as DeviceTypeSourceRecordsWithFiles | undefined;
            const file = loaded?.files?.get(key);
            records[key] = { source, ...(file ? { file: file.path, sha256: await sha256Hex(file.text) } : {}),
                ...(loaded?.commit ? { commit: loaded.commit } : {}), ...(loaded?.raftCore ? { raftCore: loaded.raftCore } : {}) };
        }
        return JSON.stringify({ formatVersion: 1, section: "typeFile", records }, null, 1) + "\n";
    }

    // Everything, laid out as in a project
    async exportZip(asBuiltin: boolean): Promise<Uint8Array> {
        const sysDir = `systypes/${this.sysType}`;
        const files: Array<{ path: string; text: string }> = [{ path: `${sysDir}/DeviceTypeSources.json`, text: this.sourcesFileText(asBuiltin) }];
        const lock = await this.lockText();
        if (lock)
            files.push({ path: `${sysDir}/DeviceTypeSources.lock`, text: lock });
        for (const [name, spec] of Object.entries(this.selection.sources)) {
            const local = this.localSources[name];
            if (this.sourceKind(name) !== "path" || !local)
                continue;
            const dir = joinPath(sysDir, String(spec.path ?? name));
            for (const file of local.files) {
                if (local.asFolder)
                    files.push({ path: `${dir}/${file.path.slice(file.path.lastIndexOf("/") + 1)}`, text: file.text });
                else
                    files.push({ path: dir.endsWith(".json") ? dir : `${dir}/${file.path.slice(file.path.lastIndexOf("/") + 1)}`, text: file.text });
            }
        }
        if (this.build.result)
            files.push({ path: "devlib.json", text: this.build.result.text });
        files.push({ path: "DeviceTypeSources.manifest.json", text: await this.manifestText() });
        return makeZip(files);
    }
}

export function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
