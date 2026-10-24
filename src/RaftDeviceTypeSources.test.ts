// Resolving DeviceTypeSources.json selections, against the vectors shared with RaftCore
// (scripts/tests/selection_vectors.json, copied into testdata/ - after a change there, copy it again)

import * as fs from "fs";
import * as path from "path";
import { DevTypeJson, devTypeJsonGet, isDevTypeJsonObject, parseDevTypeJson, writeDevTypeJson } from "./RaftDeviceTypeJson";
import { DeviceTypeSection, DeviceTypeSelectionError, DeviceTypeSourceRecords, mergeDeviceTypeSources,
    resolveDeviceTypeSelection } from "./RaftDeviceTypeSources";

const TESTDATA = path.join(__dirname, "..", "testdata");
const RAFTCORE_TESTS = path.join(__dirname, "..", "..", "RaftCore", "scripts", "tests");
const vectorsFile = JSON.parse(fs.readFileSync(path.join(TESTDATA, "selection_vectors.json"), "utf-8"));

function recordsOf(catalogueText: string): Map<string, DevTypeJson> {
    const devTypes = devTypeJsonGet(parseDevTypeJson(catalogueText), "devTypes");
    if (!isDevTypeJsonObject(devTypes))
        throw new Error("no devTypes");
    return devTypes;
}

describe("selection vectors", () => {
    const vectors: any[] = vectorsFile.vectors;

    test("there are vectors", () => {
        expect(vectors.length).toBeGreaterThan(20);
    });

    test.each(vectors.map((v) => [v.name, v]))("%s", (_name, vec) => {
        const resolve = () => {
            const merged = mergeDeviceTypeSources(Object.entries(vec.files).map(([name, content]) => ({ name, content: content as string })));
            const sources = new Map<string, DeviceTypeSourceRecords>();
            for (const [name, source] of Object.entries<any>(vec.sources))
                sources.set(name, { records: recordsOf(source.records), raftCore: source.kind === "bundled" ? vectorsFile.raftCore : undefined });
            return resolveDeviceTypeSelection(merged, vec.section as DeviceTypeSection, sources);
        };
        if (vec.error !== undefined) {
            expect(resolve).toThrow(DeviceTypeSelectionError);
            expect(resolve).toThrow(vec.error);
            return;
        }
        const result = resolve();
        const records: Record<string, { source: string; record: string }> = {};
        result.records.forEach((rec, key) => { records[key] = { source: result.origin.get(key) as string, record: writeDevTypeJson(rec) }; });
        expect(Object.keys(records)).toEqual(Object.keys(vec.records));
        expect(records).toEqual(vec.records);
        expect(Object.fromEntries(result.replaced)).toEqual(vec.replaced);
        expect(Object.fromEntries(result.policyOnly)).toEqual(vec.policyOnly);
        expect(result.messages).toEqual(vec.messages);
        expect(writeDevTypeJson(result.provenance)).toBe(vec.provenance);
    });

    test("a source whose records weren't read", () => {
        const merged = mergeDeviceTypeSources([{ name: "x", content: '{"sources":{"acme":{"git":"https://example.com/a.git","ref":"v1"}}}' }]);
        expect(() => resolveDeviceTypeSelection(merged, "builtin", new Map())).toThrow("haven't been read");
    });

    test("a git source in the provenance has its commit", () => {
        const merged = mergeDeviceTypeSources([{ name: "x", content:
            '{"sources":{"acme":{"git":"https://example.com/a.git","ref":"v1","path":"recs"}},"typeFile":{"include":["acme:*"]}}' }]);
        const result = resolveDeviceTypeSelection(merged, "typeFile",
            new Map([["acme", { records: recordsOf('{"devTypes":{"Gadget":{"addresses":"0x40"}}}'), commit: "abc123" }]]));
        expect(writeDevTypeJson(result.provenance)).toBe('{"formatVersion":1,"sources":{"acme":{"git":"https://example.com/a.git",' +
            '"ref":"v1","path":"recs","commit":"abc123"}},"typeFile":{"include":["acme:*"]}}');
    });
});

describe("vectors are RaftCore's", () => {
    // Only where a RaftCore checkout next to raftjs has them
    const present = fs.existsSync(path.join(RAFTCORE_TESTS, "selection_vectors.json"));
    (present ? test : test.skip)("selection_vectors.json", () => {
        expect(fs.readFileSync(path.join(TESTDATA, "selection_vectors.json"), "utf-8"))
            .toBe(fs.readFileSync(path.join(RAFTCORE_TESTS, "selection_vectors.json"), "utf-8"));
    });
});
