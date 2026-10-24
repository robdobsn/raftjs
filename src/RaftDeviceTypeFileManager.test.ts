// The device type file workflow (push: upload, check, confirm, apply, restart, verify; pull; the type table and
// records) against a fake device that keeps files and answers devman/typefile as the firmware does

import { RaftFileDownloadResult } from "./RaftTypes";
import { DeviceTypeFileConnection, DeviceTypeFileManager, TYPE_FILE_STAGED_PATH } from "./RaftDeviceTypeFileManager";
import { typeFileCrc } from "./RaftDeviceTypeFile";
import { writeDevTypeJson } from "./RaftDeviceTypeJson";

const TYPE_FILE = "/local/devlib.json";

class FakeDevice implements DeviceTypeFileConnection {
    files = new Map<string, string>();
    loadedCrc = "0000";                 // of the file loaded at startup
    loadedEntries: Array<{ key: string; outcome: string }> = [];
    rejectKeys = new Set<string>();     // entries the device's check rejects
    restartingFor = 0;                  // requests that fail while restarting
    commands: string[] = [];
    records: Record<string, unknown> = { MCP9808: { addresses: "0x18-0x1f", pollInfo: { c: "0x05=r2", i: 5000, s: 1 } } };

    private checkOf(path: string) {
        const text = this.files.get(path);
        if (text === undefined)
            return { rslt: "fail", error: "failFileNotFound" };
        const keys = Object.keys(JSON.parse(text).devTypes);
        const entries = keys.map((key) => ({ key, outcome: this.rejectKeys.has(key) ? "rejected" : "added" }));
        const rejected = entries.filter((e) => e.outcome === "rejected").length;
        return { rslt: "ok", file: path, crc: typeFileCrc(text), valid: rejected === 0, added: keys.length - rejected,
            rejected, firstError: rejected ? `${entries.find((e) => e.outcome === "rejected")?.key}: bad` : "", entries };
    }

    restart() {
        const text = this.files.get(TYPE_FILE);
        this.loadedCrc = text === undefined ? "0000" : typeFileCrc(text);
        this.loadedEntries = text === undefined ? [] : (this.checkOf(TYPE_FILE).entries ?? []);
        this.restartingFor = 2;
    }

    async sendRICRESTMsg(command: string): Promise<object> {
        this.commands.push(command);
        if (this.restartingFor > 0) {
            this.restartingFor--;
            throw new Error("no connection");
        }
        const [base, query] = command.split("?");
        const params = new URLSearchParams(query ?? "");
        if (base === "devman/typefile")
            return { rslt: "ok", file: TYPE_FILE, state: this.files.has(TYPE_FILE) ? "applied" : "none", crc: this.loadedCrc,
                rejected: 0, entries: params.get("entries") ? this.loadedEntries : undefined };
        if (base === "devman/typefile/check")
            return this.checkOf(params.get("file") ?? TYPE_FILE);
        if (base === "devman/typefile/apply") {
            const file = params.get("file") ?? TYPE_FILE;
            const check = this.checkOf(file);
            if (!check.valid)
                return { ...check, rslt: "fail", error: "failCheck" };
            this.files.set(TYPE_FILE, this.files.get(file) as string);
            this.files.delete(file);
            this.restart();
            return { rslt: "ok", restarting: true };
        }
        if (base.startsWith("filedelete/")) {
            this.files.delete("/" + base.slice("filedelete/".length));
            return { rslt: "ok" };
        }
        if (base === "devman/types") {
            const types = [{ dtIdx: 0, key: "MCP9808", src: "base", policy: "enabled" },
                           { dtIdx: 1, key: "MAX17048", src: "base", policy: "enabled", protected: true }];
            const offset = Number(params.get("offset"));
            return { rslt: "ok", total: types.length, generation: 1, types: types.slice(offset, offset + 50) };
        }
        if (base === "devman/typeinfo") {
            const key = params.get("deviceTypeKey") as string;
            return key in this.records ? { rslt: "ok", record: { [key]: this.records[key] } } : { rslt: "fail", error: "failTypeNotFound" };
        }
        return { rslt: "fail", error: "failUnknownAPI" };
    }

    async sendFile(fileName: string, contents: Uint8Array): Promise<boolean> {
        this.files.set("/" + fileName, new TextDecoder().decode(contents));
        return true;
    }

    async fsGetContents(fileName: string): Promise<RaftFileDownloadResult> {
        const text = this.files.get("/" + fileName);
        return text === undefined ? new RaftFileDownloadResult() : new RaftFileDownloadResult(new TextEncoder().encode(text));
    }
}

const fileText = (keys: string[]) => JSON.stringify({ devTypes: Object.fromEntries(keys.map((k) => [k, { addresses: "0x40" }])) });

describe("DeviceTypeFileManager", () => {
    test("push: upload, check, apply, restart and verify", async () => {
        const device = new FakeDevice();
        const manager = new DeviceTypeFileManager(device);
        const stages: string[] = [];
        const text = fileText(["Gadget", "Widget"]);
        const result = await manager.push(text, { onProgress: (s) => { if (stages[stages.length - 1] !== s) stages.push(s); },
            restartTimeoutMs: 10000, restartPollMs: 50 });
        expect(result.outcome).toBe("applied");
        expect(result.crc).toBe(typeFileCrc(text));
        expect(device.files.get(TYPE_FILE)).toBe(text);
        expect(device.files.has(TYPE_FILE_STAGED_PATH)).toBe(false);
        expect(stages).toEqual(["status", "upload", "check", "apply", "restart", "verify", "done"]);
        // Pushed again: the device has it
        expect((await manager.push(text)).outcome).toBe("unchangedOnDevice");
    }, 20000);

    test("push: a rejected entry stops it; a dry run and an unconfirmed push remove the staged file", async () => {
        const device = new FakeDevice();
        const manager = new DeviceTypeFileManager(device);
        device.rejectKeys.add("Bad");
        const invalid = await manager.push(fileText(["Bad", "Good"]));
        expect(invalid.outcome).toBe("invalid");
        expect(invalid.message).toContain("Bad: bad");
        expect(device.files.has(TYPE_FILE)).toBe(false);
        const dry = await manager.push(fileText(["Good"]), { dryRun: true });
        expect(dry.outcome).toBe("dryRun");
        expect(dry.check?.entries).toEqual([{ key: "Good", outcome: "added" }]);
        expect(device.files.has(TYPE_FILE_STAGED_PATH)).toBe(false);
        const unconfirmed = await manager.push(fileText(["Good"]), { confirm: async () => false });
        expect(unconfirmed.outcome).toBe("notConfirmed");
        expect(device.files.size).toBe(0);
    });

    test("push: stops if the device's file changed since it was read", async () => {
        const device = new FakeDevice();
        device.files.set(TYPE_FILE, fileText(["Old"]));
        const manager = new DeviceTypeFileManager(device);
        const pulled = await manager.pull();
        expect(pulled?.crc).toBe(typeFileCrc(fileText(["Old"])));
        device.files.set(TYPE_FILE, fileText(["Old", "Changed"]));
        const result = await manager.push(fileText(["New"]), { expectedDeviceCrc: pulled?.crc });
        expect(result.outcome).toBe("deviceFileChanged");
        expect((await manager.push(fileText(["New"]), { expectedDeviceCrc: pulled?.crc, force: true, restartTimeoutMs: 10000, restartPollMs: 50 })).outcome)
            .toBe("applied");
    }, 20000);

    test("push: the device not back in time", async () => {
        const device = new FakeDevice();
        device.restart = function () { this.restartingFor = 1000; };
        const manager = new DeviceTypeFileManager(device);
        const result = await manager.push(fileText(["Gadget"]), { restartTimeoutMs: 500, restartPollMs: 50 });
        expect(result.outcome).toBe("restartTimeout");
    }, 10000);

    test("verify: what the device loaded against the check", () => {
        const check = { entries: [{ key: "A", outcome: "added" as const }] };
        expect(DeviceTypeFileManager.verify({ rslt: "ok", crc: "1234", state: "applied", entries: [{ key: "A", outcome: "added" }] }, check, "1234"))
            .toBeUndefined();
        expect(DeviceTypeFileManager.verify({ rslt: "ok", crc: "1234", state: "applied", entries: [{ key: "A", outcome: "rejected" }] }, check, "1234"))
            .toContain("the check said added");
        expect(DeviceTypeFileManager.verify({ rslt: "ok", crc: "9999", state: "applied" }, check, "1234")).toContain("CRC 9999");
        expect(DeviceTypeFileManager.verify({ rslt: "ok", crc: "1234", state: "applied", rejected: 1, firstError: "A: bad" }, check, "1234"))
            .toContain("A: bad");
    });

    test("table, device records and the type file's _sources", async () => {
        const device = new FakeDevice();
        const manager = new DeviceTypeFileManager(device);
        const table = await manager.table();
        expect(table?.map((t) => [t.key, t.protected ?? false])).toEqual([["MCP9808", false], ["MAX17048", true]]);
        const record = await manager.deviceRecord("MCP9808");
        expect(writeDevTypeJson(record ?? null)).toBe('{"addresses":"0x18-0x1f","pollInfo":{"c":"0x05=r2","i":5000,"s":1}}');
        expect(await manager.deviceRecord("Nope")).toBeUndefined();
        const typeinfoCalls = device.commands.filter((c) => c.startsWith("devman/typeinfo")).length;
        await manager.deviceRecord("MCP9808");
        expect(device.commands.filter((c) => c.startsWith("devman/typeinfo")).length).toBe(typeinfoCalls);
        const parsed = DeviceTypeFileManager.parseTypeFile('{"devTypes":{"A":{"disable":true}},"_sources":{"formatVersion":1}}');
        expect(Array.from(parsed.devTypes.keys())).toEqual(["A"]);
        expect(writeDevTypeJson(parsed.sources ?? null)).toBe('{"formatVersion":1}');
        expect(() => DeviceTypeFileManager.parseTypeFile("{}")).toThrow("no devTypes");
    });
});
