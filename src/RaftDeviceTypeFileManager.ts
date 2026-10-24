/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeFileManager
// Part of RaftJS
//
// A device's device type file (RaftCore wiki: DeviceManager Settings, "Device type file"; DeviceManager REST API,
// devman/typefile): its status, its type table and compiled records, pulling the file, and pushing a new one the
// safe way - upload under another name, the device's check, apply (the device restarts), then verify that the device
// loaded it (as raft devtypes push does).
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { RaftFileDownloadResult, RaftOKFail } from "./RaftTypes";
import { DevManTypeFileCheck, DevManTypeFileEntry, DevManTypeFileStatus, DevManTypePolicy } from "./RaftDeviceManager";
import { DevTypeJson, devTypeJsonFromPlain, devTypeJsonGet, isDevTypeJsonObject, parseDevTypeJson } from "./RaftDeviceTypeJson";
import { typeFileCrc } from "./RaftDeviceTypeFile";

// What a connection needs to offer (RaftConnector has these)
export interface DeviceTypeFileConnection {
    sendRICRESTMsg(commandName: string, params: object): Promise<object>;
    sendFile(fileName: string, fileContents: Uint8Array,
             progressCallback: ((sent: number, total: number, progress: number) => void) | undefined): Promise<boolean>;
    fsGetContents(fileName: string, fileSource: string,
                  progressCallback: ((received: number, total: number) => void) | undefined): Promise<RaftFileDownloadResult>;
}

// An entry of the device's type table (devman/types)
export interface DevManTypeTableEntry {
    dtIdx: number;
    key: string;
    src: "base" | "override" | "extended" | string;
    policy: DevManTypePolicy;
    protected?: boolean;        // a type a system device expects: can't be overridden or disabled (firmware from 2026-10-24)
}

// The staged file: uploaded here (on the local file system, whatever the default file system) and checked before
// it is applied (apply moves or copies it to the device type file's path)
export const TYPE_FILE_STAGED_UPLOAD_NAME = "local/devlib.new.json";
export const TYPE_FILE_STAGED_PATH = "/local/devlib.new.json";

export type TypeFileResponse<T> = RaftOKFail & T & { error?: string };

export interface TypeFilePushOptions {
    // The device's file is expected to be this one (its CRC when it was pulled or last pushed): if it has changed
    // since - e.g. by devman/typepolicy save=1 - the push stops unless force is set
    expectedDeviceCrc?: string;
    force?: boolean;
    dryRun?: boolean;                               // stop after the device's check (and remove the staged file)
    confirm?: (check: TypeFileResponse<DevManTypeFileCheck>) => Promise<boolean>;  // after the check, before applying
    onProgress?: (stage: TypeFilePushStage, detail?: string) => void;
    restartTimeoutMs?: number;                      // how long to wait for the device to come back (default 60 s)
    restartPollMs?: number;                         // how often to ask meanwhile (default 1.5 s)
}

export type TypeFilePushStage = "status" | "upload" | "check" | "confirm" | "apply" | "restart" | "verify" | "done";

export interface TypeFilePushResult {
    outcome: "applied" | "unchangedOnDevice" | "deviceFileChanged" | "uploadFailed" | "checkFailed" | "invalid" |
        "dryRun" | "notConfirmed" | "applyFailed" | "restartTimeout" | "verifyFailed";
    message: string;
    crc: string;                                    // of the file pushed
    check?: TypeFileResponse<DevManTypeFileCheck>;
    status?: TypeFileResponse<DevManTypeFileStatus>;    // after the restart
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DeviceTypeFileManager {
    // Compiled records fetched (typeinfo full=1), for the table generation they were fetched in
    private _compiledCache = new Map<string, DevTypeJson | null>();
    private _compiledGeneration: number | undefined = undefined;

    constructor(private _conn: DeviceTypeFileConnection) {}

    private async cmd<T>(command: string): Promise<TypeFileResponse<T> | undefined> {
        try {
            return await this._conn.sendRICRESTMsg(command, {}) as TypeFileResponse<T>;
        } catch {
            return undefined;
        }
    }

    // devman/typefile (entries: what happened to each entry at startup)
    async status(entries = false): Promise<TypeFileResponse<DevManTypeFileStatus> | undefined> {
        return this.cmd<DevManTypeFileStatus>(`devman/typefile${entries ? "?entries=1" : ""}`);
    }

    // The whole device type table (devman/types, every page). Clears the compiled record cache if the table changed
    async table(): Promise<DevManTypeTableEntry[] | undefined> {
        const out: DevManTypeTableEntry[] = [];
        for (let offset = 0; ; ) {
            const page = await this.cmd<{ total?: number; generation?: number; types?: DevManTypeTableEntry[] }>(
                `devman/types?offset=${offset}&count=50`);
            if (page?.rslt !== "ok")
                return undefined;
            if (page.generation !== this._compiledGeneration) {
                this._compiledCache.clear();
                this._compiledGeneration = page.generation;
            }
            const types = page.types ?? [];
            out.push(...types);
            offset += 50;
            if (types.length === 0 || offset >= (page.total ?? 0))
                return out;
        }
    }

    // A record the device has, as devman/typeinfo full=1 gives it (in the type file format); undefined if it has none
    async deviceRecord(key: string): Promise<DevTypeJson | undefined> {
        if (this._compiledCache.has(key))
            return this._compiledCache.get(key) ?? undefined;
        const resp = await this.cmd<{ record?: Record<string, unknown> }>(
            `devman/typeinfo?deviceTypeKey=${encodeURIComponent(key)}&full=1`);
        if (resp === undefined)
            return undefined;
        const record = resp.rslt === "ok" && resp.record ? resp.record[key] : undefined;
        const value = record !== undefined ? devTypeJsonFromPlain(record) : null;
        this._compiledCache.set(key, value);
        return value ?? undefined;
    }

    // The device's type file (undefined if it can't be read - e.g. there is none)
    async pull(onProgress?: (received: number, total: number) => void): Promise<{ text: string; crc: string; path: string } | undefined> {
        const status = await this.status();
        const path = status?.file;
        if (!path)
            return undefined;
        const result = await this._conn.fsGetContents(path.replace(/^\//, ""), "fs", onProgress);
        if (!result.downloadedOk || !result.fileData)
            return undefined;
        return { text: new TextDecoder().decode(result.fileData), crc: typeFileCrc(result.fileData), path };
    }

    // The records and policies a type file holds, and its _sources if it has one
    static parseTypeFile(text: string): { devTypes: Map<string, DevTypeJson>; sources?: DevTypeJson } {
        const content = parseDevTypeJson(text);
        const devTypes = devTypeJsonGet(content, "devTypes");
        if (!isDevTypeJsonObject(devTypes))
            throw new Error("not a device type file (no devTypes object)");
        return { devTypes, sources: devTypeJsonGet(content, "_sources") };
    }

    // The CRC of the device's own file as it is now (from a check of it - the status's CRC is of the file loaded at
    // startup); undefined if there is no file
    async deviceFileCrc(): Promise<string | undefined> {
        const check = await this.cmd<DevManTypeFileCheck>("devman/typefile/check");
        return check?.rslt === "ok" ? check.crc : undefined;
    }

    // Upload a file as the staged file
    async upload(text: string, onProgress?: (sent: number, total: number) => void): Promise<boolean> {
        return this._conn.sendFile(TYPE_FILE_STAGED_UPLOAD_NAME, new TextEncoder().encode(text),
            onProgress ? (s, t) => onProgress(s, t) : undefined);
    }

    // Upload a file as the staged file and have the device check it (undefined if the upload failed)
    async stage(text: string, onProgress?: (sent: number, total: number) => void): Promise<TypeFileResponse<DevManTypeFileCheck> | undefined> {
        if (!(await this.upload(text, onProgress)))
            return undefined;
        return (await this.check(TYPE_FILE_STAGED_PATH)) ?? { rslt: "fail", error: "noResponse" };
    }

    // What a file on the device would do at the next startup, entry by entry (default: the device type file)
    async check(file?: string): Promise<TypeFileResponse<DevManTypeFileCheck> | undefined> {
        return this.cmd<DevManTypeFileCheck>(`devman/typefile/check${file ? `?file=${encodeURIComponent(file)}` : ""}`);
    }

    // Make the staged file the device type file and restart (refused by the device if anything in it is rejected)
    async apply(file: string = TYPE_FILE_STAGED_PATH): Promise<TypeFileResponse<DevManTypeFileCheck & { restarting?: boolean }> | undefined> {
        return this.cmd<DevManTypeFileCheck & { restarting?: boolean }>(`devman/typefile/apply?file=${encodeURIComponent(file)}`);
    }

    // Remove the staged file
    async removeStaged(): Promise<void> {
        await this.cmd<object>(`filedelete/${TYPE_FILE_STAGED_UPLOAD_NAME}`);
    }

    // Wait for the device to answer with a file of this CRC loaded (after apply restarts it)
    async waitForLoaded(crc: string, timeoutMs = 60000, pollMs = 1500): Promise<TypeFileResponse<DevManTypeFileStatus> | undefined> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await sleep(pollMs);
            const status = await this.status(true);
            if (status?.rslt === "ok" && status.crc === crc && status.state !== "loading")
                return status;
        }
        return undefined;
    }

    // The device's status after a push: the file is loaded, with what the check said of each entry
    static verify(status: TypeFileResponse<DevManTypeFileStatus>, check: DevManTypeFileCheck | undefined, crc: string): string | undefined {
        if (status.crc !== crc)
            return `the device's file has CRC ${status.crc}, not ${crc}`;
        if (status.state !== "applied" && status.state !== "none")
            return `the device's type file state is ${status.state}${status.firstError ? ` (${status.firstError})` : ""}`;
        if ((status.rejected ?? 0) > 0)
            return `${status.rejected} entr${status.rejected === 1 ? "y was" : "ies were"} rejected: ${status.firstError}`;
        const outcome = (entries: DevManTypeFileEntry[] | undefined) => new Map((entries ?? []).map((e) => [e.key, e.outcome]));
        const loaded = outcome(status.entries);
        for (const [key, expected] of outcome(check?.entries)) {
            if (status.entries && loaded.get(key) !== expected)
                return `"${key}" was ${loaded.get(key) ?? "not loaded"}, the check said ${expected}`;
        }
        return undefined;
    }

    // Push a type file: stop if the device already has it, or if its file isn't the expected one; upload, check, confirm,
    // apply, wait for the restart and verify
    async push(text: string, options: TypeFilePushOptions = {}): Promise<TypeFilePushResult> {
        const crc = typeFileCrc(text);
        const progress = options.onProgress ?? (() => undefined);
        progress("status");
        const deviceCrc = await this.deviceFileCrc();
        if (deviceCrc === crc && !options.force)
            return { outcome: "unchangedOnDevice", message: "The device already has this type file", crc };
        if (options.expectedDeviceCrc !== undefined && deviceCrc !== undefined && deviceCrc !== options.expectedDeviceCrc && !options.force)
            return { outcome: "deviceFileChanged", crc,
                message: `The device's type file (CRC ${deviceCrc}) has changed since it was read (CRC ${options.expectedDeviceCrc})` };
        progress("upload");
        if (!(await this.upload(text, (s, t) => progress("upload", `${s} / ${t} bytes`))))
            return { outcome: "uploadFailed", message: "The upload failed", crc };
        progress("check");
        const check = (await this.check(TYPE_FILE_STAGED_PATH)) ?? { rslt: "fail" as const, error: "noResponse" };
        if (check.rslt !== "ok")
            return { outcome: "checkFailed", message: `The device's check failed: ${check.error ?? "no response"}`, crc, check };
        if (check.crc !== undefined && check.crc !== crc) {
            await this.removeStaged();
            return { outcome: "checkFailed", message: `The uploaded file has CRC ${check.crc}, not ${crc}`, crc, check };
        }
        if (!check.valid)
            return { outcome: "invalid", crc, check,
                message: `The device rejects ${check.rejected} entr${check.rejected === 1 ? "y" : "ies"}: ${check.firstError}` };
        if (options.dryRun) {
            await this.removeStaged();
            return { outcome: "dryRun", message: "Checked by the device; not applied", crc, check };
        }
        if (options.confirm) {
            progress("confirm");
            if (!(await options.confirm(check))) {
                await this.removeStaged();
                return { outcome: "notConfirmed", message: "Not applied", crc, check };
            }
        }
        progress("apply");
        const applied = await this.apply(TYPE_FILE_STAGED_PATH);
        if (applied?.rslt !== "ok")
            return { outcome: "applyFailed", crc, check,
                message: `Not applied: ${applied?.error ?? "no response"}${applied?.firstError ? ` - ${applied.firstError}` : ""}` };
        progress("restart");
        const status = await this.waitForLoaded(crc, options.restartTimeoutMs ?? 60000, options.restartPollMs ?? 1500);
        if (!status)
            return { outcome: "restartTimeout", crc, check,
                message: "Applied - the device is restarting. Reconnect to it to check it loaded the file" };
        progress("verify");
        const problem = DeviceTypeFileManager.verify(status, check, crc);
        if (problem)
            return { outcome: "verifyFailed", message: problem, crc, check, status };
        progress("done");
        return { outcome: "applied", message: "Applied and loaded by the device", crc, check, status };
    }
}
