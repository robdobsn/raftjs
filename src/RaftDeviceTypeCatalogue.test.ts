// Reading device type sources: RaftCore's published catalogue, GitHub git sources and record files; the lock file

import { DeviceTypeFetch, DeviceTypeSourceError, RaftCoreCatalogue, deviceTypeLockText, parseGitHubUrl, readGitHubSource,
    recordsFromFiles, sha256Hex, versionLessThan } from "./RaftDeviceTypeCatalogue";
import { DevTypeJsonObject, parseDevTypeJson, writeDevTypeJson } from "./RaftDeviceTypeJson";
import { DeviceTypeSourceRecords, mergeDeviceTypeSources, resolveDeviceTypeSelection } from "./RaftDeviceTypeSources";

function fakeFetch(files: Record<string, string>, log: string[] = []): DeviceTypeFetch {
    return async (url: string) => {
        log.push(url);
        const text = files[url];
        return { ok: text !== undefined, status: text !== undefined ? 200 : 404, text: async () => text ?? "" };
    };
}

const SITE = "https://example.com/devtypes";
const site = {
    [`${SITE}/index.json`]: JSON.stringify({ formatVersion: 1, latest: "v1.61.0", versions: [
        { label: "main", raftCore: "1.62.0", count: 2 }, { label: "v1.61.0", raftCore: "1.61.0", count: 2 },
        { label: "v1.59.0", raftCore: "1.59.0", count: 1 }] }),
    [`${SITE}/v1.61.0/catalogue.json`]: JSON.stringify({ formatVersion: 1, label: "v1.61.0", raftCore: "1.61.0", recordFormat: 1, count: 2,
        sets: { common: ["MCP9808"] },
        records: [{ key: "LSM6DS3", file: "records/LSM6DS3.json", sha256: "x", summary: { name: "IMU", hasData: true, customCode: false, initCode: false } },
                  { key: "MCP9808", file: "records/MCP9808.json", sha256: "y", summary: { name: "Temp", hasData: true, customCode: false, initCode: false } }] }),
    [`${SITE}/v1.61.0/DeviceTypeRecords.json`]: '{"devTypes":{"LSM6DS3":{"addresses":"0x6a","m":{"12.5":1,"26":2}},"MCP9808":{"addresses":"0x18"}}}',
    [`${SITE}/v1.61.0/records/MCP9808.json`]: '{\n    "addresses": "0x18"\n}\n',
};

describe("RaftCore's published catalogue", () => {
    test("index, version choice, entries, records and a record file", async () => {
        const fetchFn = fakeFetch(site);
        const index = await RaftCoreCatalogue.index(fetchFn, SITE);
        expect(RaftCoreCatalogue.chooseVersion(index, "1.61.0")).toBe("v1.61.0");
        expect(RaftCoreCatalogue.chooseVersion(index, "1.60.2")).toBe("v1.59.0");
        expect(RaftCoreCatalogue.chooseVersion(index, "1.70.0")).toBe("v1.61.0");
        expect(RaftCoreCatalogue.chooseVersion(index, undefined)).toBe("v1.61.0");
        const catalogue = await RaftCoreCatalogue.open(fetchFn, "v1.61.0", SITE);
        expect(catalogue.raftCore).toBe("1.61.0");
        expect(catalogue.entries().map((e) => e.key)).toEqual(["LSM6DS3", "MCP9808"]);
        const records = await catalogue.records();
        expect(writeDevTypeJson(records.records.get("LSM6DS3") ?? null)).toBe('{"addresses":"0x6a","m":{"12.5":1,"26":2}}');
        expect(records.raftCore).toBe("1.61.0");
        expect(Array.from(records.sets?.entries() ?? [])).toEqual([["common", ["MCP9808"]]]);
        expect((await catalogue.recordFile("MCP9808")).text).toContain("0x18");
        await expect(catalogue.recordFile("Nope")).rejects.toThrow("no record");
        await expect(RaftCoreCatalogue.open(fetchFn, "v9.9.9", SITE)).rejects.toThrow("HTTP 404");
    });
});

describe("record files", () => {
    test("a folder, a record file and a catalogue file", () => {
        const folder = recordsFromFiles([{ path: "devtypes/Zeta.json", text: '{"addresses":"0x30"}' },
            { path: "devtypes/Alpha.json", text: '{"addresses":"0x31","deviceType":"Alpha"}' }, { path: "devtypes/notes.txt", text: "" }], true);
        expect(Array.from(folder.records.keys())).toEqual(["Alpha", "Zeta"]);
        expect(folder.files.get("Zeta")?.path).toBe("devtypes/Zeta.json");
        expect(Array.from(recordsFromFiles([{ path: "x/Gadget.json", text: '{"addresses":"0x40"}' }], false).records.keys())).toEqual(["Gadget"]);
        expect(Array.from(recordsFromFiles([{ path: "cat.json", text: '{"devTypes":{"B":{},"A":{}}}' }], false).records.keys())).toEqual(["B", "A"]);
        expect(() => recordsFromFiles([{ path: "d/Alpha.json", text: '{"deviceType":"Beta"}' }], true)).toThrow("differs from the file name");
        expect(() => recordsFromFiles([{ path: "d/Cat.json", text: '{"devTypes":{}}' }], true)).toThrow("catalogue file");
        expect(() => recordsFromFiles([{ path: "d/Bad.json", text: "{" }], true)).toThrow(DeviceTypeSourceError);
    });
});

describe("GitHub sources", () => {
    const commit = "a".repeat(40);
    const api = "https://api.github.com/repos/acme/devtypes";
    const raw = `https://raw.githubusercontent.com/acme/devtypes/${commit}`;
    const gadget = '{\n    "addresses": "0x40"\n}\n';
    const github = {
        [`${api}/commits/v1.0.0`]: JSON.stringify({ sha: commit }),
        [`${api}/git/trees/${commit}?recursive=1`]: JSON.stringify({ tree: [
            { path: "raftdevtypes.json", type: "blob" }, { path: "records", type: "tree" },
            { path: "records/Gadget.json", type: "blob" }, { path: "records/sub", type: "tree" }, { path: "records/sub/Other.json", type: "blob" },
            { path: "one/Widget.json", type: "blob" }] }),
        [`${raw}/raftdevtypes.json`]: '{"name":"acme","formatVersion":1,"minRaftCore":"1.60.0"}',
        [`${raw}/records/Gadget.json`]: gadget,
        [`${raw}/one/Widget.json`]: '{"addresses":"0x41"}',
    };
    const spec = (extra = {}) => parseDevTypeJson(JSON.stringify({ git: "https://github.com/acme/devtypes.git", ref: "v1.0.0", ...extra })) as DevTypeJsonObject;

    test("URLs", () => {
        expect(parseGitHubUrl("https://github.com/acme/devtypes.git")).toEqual({ owner: "acme", repo: "devtypes" });
        expect(parseGitHubUrl("git@github.com:acme/devtypes.git")).toEqual({ owner: "acme", repo: "devtypes" });
        expect(parseGitHubUrl("https://github.com/acme/devtypes")).toEqual({ owner: "acme", repo: "devtypes" });
        expect(parseGitHubUrl("https://gitlab.com/acme/devtypes.git")).toBeUndefined();
    });

    test("a folder at a tag, a record file, the manifest, cached by commit", async () => {
        const log: string[] = [];
        const fetchFn = fakeFetch(github, log);
        const source = await readGitHubSource("acme", spec(), { fetch: fetchFn, raftCore: "1.62.0" });
        expect(source.commit).toBe(commit);
        expect(Array.from(source.records.keys())).toEqual(["Gadget"]);
        expect(source.files.get("Gadget")?.text).toBe(gadget);
        const widget = await readGitHubSource("acme", spec({ path: "one/Widget.json" }), { fetch: fetchFn }, commit);
        expect(Array.from(widget.records.keys())).toEqual(["Widget"]);
        expect(log.filter((u) => u.includes("/git/trees/")).length).toBe(1);
        await expect(readGitHubSource("acme", spec(), { fetch: fetchFn, raftCore: "1.59.0" })).rejects.toThrow("needs RaftCore 1.60.0");
        await expect(readGitHubSource("acme", spec({ path: "nope" }), { fetch: fetchFn })).rejects.toThrow("not found in the repo");
        await expect(readGitHubSource("acme", spec({ ref: "v9" }), { fetch: fetchFn })).rejects.toThrow("HTTP 404");
        // Code outside the decode language is refused, as a build refuses it
        const badCommit = "b".repeat(40);
        const bad = fakeFetch({
            [`https://api.github.com/repos/acme/bad/git/trees/${badCommit}?recursive=1`]: JSON.stringify({ tree: [{ path: "Widget.json", type: "blob" }] }),
            [`https://raw.githubusercontent.com/acme/bad/${badCommit}/Widget.json`]:
                '{"addresses":"0x41","devInfoJson":{"resp":{"b":1,"a":[{"n":"v"}],"c":{"n":"f","c":"out.v=buf[0];abort();"}}}}',
        });
        await expect(readGitHubSource("bad", parseDevTypeJson('{"git":"https://github.com/acme/bad","ref":"main","path":"Widget.json"}') as DevTypeJsonObject,
            { fetch: bad }, badCommit)).rejects.toThrow('"Widget" from source "bad": its decode code (resp.c) isn\'t allowed: ' +
            "abort is not declared in the code; abort(...) - function calls are not allowed");
        await expect(readGitHubSource("acme", parseDevTypeJson('{"git":"https://gitlab.com/a/b.git","ref":"v1"}') as DevTypeJsonObject,
            { fetch: fetchFn })).rejects.toThrow("only GitHub");
    });

    test("the lock file, as a build writes it", async () => {
        const source = await readGitHubSource("acme", spec(), { fetch: fakeFetch(github) });
        const merged = mergeDeviceTypeSources([{ name: "x", content: JSON.stringify({
            sources: { raftcore: { bundled: true }, acme: { git: "https://github.com/acme/devtypes.git", ref: "v1.0.0" } },
            typeFile: { include: ["acme:Gadget", "raftcore:MCP9808"] } }) }]);
        const sources = new Map<string, DeviceTypeSourceRecords>([["acme", source], ["raftcore", { records: new Map([["MCP9808", parseDevTypeJson("{}")]]) }]]);
        const result = resolveDeviceTypeSelection(merged, "typeFile", sources);
        expect(await deviceTypeLockText(merged, result, sources)).toBe(
            '{\n "formatVersion": 1,\n "sources": {\n  "acme": {\n   "git": "https://github.com/acme/devtypes.git",\n   "ref": "v1.0.0",\n' +
            '   "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n  }\n },\n "records": {\n  "Gadget": {\n   "source": "acme",\n' +
            '   "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n   "sha256": "b7df4af80eff5bd2b72a31dbb8854b4ce8188891adf0f62f4f37da6c43f9cae2"\n' +
            '  }\n }\n}\n');
    });
});

describe("helpers", () => {
    test("SHA-256 and versions", async () => {
        expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(versionLessThan("1.59.0", "1.60.0")).toBe(true);
        expect(versionLessThan("1.60.0", "1.60.0")).toBe(false);
        expect(versionLessThan("v1.61.2", "1.61.10")).toBe(true);
    });
});
