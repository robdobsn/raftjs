// Device type file building, the grammar and the JSON it is written with, against the vectors shared with RaftCore
// (scripts/tests/typefile_vectors.json and grammar_vectors.json, copied into testdata/ - after a change there, copy
// them again; the last test fails if a RaftCore checkout next to raftjs has different ones)

import * as fs from "fs";
import * as path from "path";
import { DevTypeJson, DevTypeJsonNumber, devTypeJsonFromPlain, devTypeJsonGet, devTypeJsonToPlain, isDevTypeJsonObject,
    parseDevTypeJson, pythonFloatRepr, writeDevTypeJson } from "./RaftDeviceTypeJson";
import { compileDeviceTypeCommand, deviceTypeCrc8, deviceTypeDetectionStrength, DeviceTypeGrammarField,
    isDeviceTypeGrammarError } from "./RaftDeviceTypeGrammar";
import { buildTypeFile, crc16Ccitt, DeviceTypeFileError, DeviceTypePolicyName, typeFileCrc } from "./RaftDeviceTypeFile";

const TESTDATA = path.join(__dirname, "..", "testdata");
const RAFTCORE_TESTS = path.join(__dirname, "..", "..", "RaftCore", "scripts", "tests");

function readVectors(name: string): any[] {
    return JSON.parse(fs.readFileSync(path.join(TESTDATA, name), "utf-8")).vectors;
}

function recordsOf(catalogueText: string): Map<string, DevTypeJson> {
    const devTypes = devTypeJsonGet(parseDevTypeJson(catalogueText), "devTypes");
    if (!isDevTypeJsonObject(devTypes))
        throw new Error("no devTypes");
    return devTypes;
}

describe("type file build vectors", () => {
    const vectors = readVectors("typefile_vectors.json");

    test("there are vectors", () => {
        expect(vectors.length).toBeGreaterThan(10);
    });

    test.each(vectors.map((v) => [v.name, v]))("%s", (_name, vec) => {
        const input = {
            records: recordsOf(vec.records),
            policyOnly: new Map<string, DeviceTypePolicyName>(Object.entries(vec.policyOnly)),
            provenance: vec.provenance ? parseDevTypeJson(vec.provenance) : undefined,
        };
        const build = () => buildTypeFile(input, recordsOf(vec.compiled), { maxBytes: vec.maxBytes });
        if (vec.error !== undefined) {
            expect(build).toThrow(DeviceTypeFileError);
            expect(build).toThrow(vec.error);
            return;
        }
        const result = build();
        expect(result.text).toBe(vec.text);
        expect(result.crc).toBe(vec.crc);
        expect(result.bytes).toBe(vec.text.length);
        expect(result.entries).toEqual(vec.entries);
    });
});

describe("grammar vectors", () => {
    const vectors = readVectors("grammar_vectors.json");
    const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

    test.each(vectors.map((v) => [v.name, v]))("%s", (_name, vec) => {
        const result = compileDeviceTypeCommand(vec.str, vec.field as DeviceTypeGrammarField);
        expect(result.issues.map((i) => i.code)).toEqual(vec.issues);
        const expected = vec.steps.map((s: any) => ({ write: s.write, read: s.read, pause: s.pause, checks: s.checks ?? [],
            crc8w: s.crc8w ?? false, expr: s.expr ?? false, slots: s.slots ?? [], guard: s.guard ?? "" }));
        const got = result.steps.map((s) => ({ write: hex(s.write), read: s.read, pause: s.pause,
            checks: s.checks.map((c) => hex(c.mask) + ":" + hex(c.value)), crc8w: s.crc8w, expr: s.expr,
            slots: s.slots.map((slot) => `${slot.offset}:${slot.name}`), guard: s.guard }));
        expect(got).toEqual(expected);
    });

    test("RaftCore's records have no grammar errors", () => {
        const records = recordsOf(readVectors("typefile_vectors.json")[0].records);
        expect(records.size).toBeGreaterThan(40);
        const errors: string[] = [];
        records.forEach((rec, key) => {
            const fields: Array<[DeviceTypeGrammarField, DevTypeJson | undefined]> = [
                ["detection", devTypeJsonGet(rec, "detectionValues")], ["init", devTypeJsonGet(rec, "initValues")],
                ["poll", devTypeJsonGet(rec, "pollInfo", "c")]];
            for (const [field, value] of fields) {
                const result = compileDeviceTypeCommand(typeof value === "string" ? value : "", field);
                result.issues.filter((i) => isDeviceTypeGrammarError(i.code)).forEach((i) => errors.push(`${key} ${field} ${i.code}@${i.pos}`));
            }
        });
        expect(errors).toEqual([]);
    });

    test("detection strength and CRC-8", () => {
        expect(deviceTypeDetectionStrength(compileDeviceTypeCommand("0x0f=0x69", "detection"))).toBe(8);
        expect(deviceTypeDetectionStrength(compileDeviceTypeCommand("0x0c=0b100001100000XXXX", "detection"))).toBe(12);
        expect(deviceTypeDetectionStrength(compileDeviceTypeCommand("0x86=A005", "detection"))).toBe(-1);
        expect(deviceTypeCrc8([0xbe, 0xef])).toBe(0x92);
    });
});

describe("JSON as Python writes it", () => {
    test("float repr", () => {
        const cases: Array<[number, string]> = [[16, "16.0"], [1.5, "1.5"], [0.000000125, "1.25e-07"], [1e16, "1e+16"],
            [1.5e16, "1.5e+16"], [1234567890123456, "1234567890123456.0"], [0.0001, "0.0001"], [0.00001, "1e-05"],
            [-0, "-0.0"], [0, "0.0"], [-2.5e-300, "-2.5e-300"], [1.7976931348623157e308, "1.7976931348623157e+308"],
            [182.04444444444444, "182.04444444444445"], [Infinity, "Infinity"]];
        for (const [value, text] of cases)
            expect(pythonFloatRepr(value)).toBe(text);
    });

    test("key order, numbers and repeated keys kept", () => {
        const value = parseDevTypeJson('{"12.5":1,"26":2.50,"a":{"x":1,"y":2,"x":3},"n":-0,"e":1E3}');
        expect(writeDevTypeJson(value)).toBe('{"12.5":1,"26":2.5,"a":{"x":3,"y":2},"n":0,"e":1000.0}');
        expect(writeDevTypeJson(value, { sortKeys: true })).toBe('{"12.5":1,"26":2.5,"a":{"x":3,"y":2},"e":1000.0,"n":0}');
    });

    test("indented as json.dumps(indent=n)", () => {
        const value = parseDevTypeJson('{"a":[1,{"b":[]}],"c":{},"d":"x"}');
        expect(writeDevTypeJson(value, { indent: 1 })).toBe('{\n "a": [\n  1,\n  {\n   "b": []\n  }\n ],\n "c": {},\n "d": "x"\n}');
    });

    test("strings escaped as with ensure_ascii", () => {
        expect(writeDevTypeJson("°C \u007f\t\"\\/ 😀")).toBe('"\\u00b0C \\u007f\\t\\"\\\\/ \\ud83d\\ude00"');
    });

    test("parse errors", () => {
        for (const bad of ["{", '{"a":}', "[1,]", "01", '{"a":1} x', "'a'", "NaN"])
            expect(() => parseDevTypeJson(bad)).toThrow();
    });

    test("plain values", () => {
        const value = devTypeJsonFromPlain({ a: [1, 2.5, "x", null, true], b: { c: 1e21 } });
        expect(writeDevTypeJson(value)).toBe('{"a":[1,2.5,"x",null,true],"b":{"c":1e+21}}');
        expect(devTypeJsonToPlain(value)).toEqual({ a: [1, 2.5, "x", null, true], b: { c: 1e21 } });
        expect((devTypeJsonGet(value, "a") as DevTypeJson[])[0]).toBeInstanceOf(DevTypeJsonNumber);
    });
});

describe("CRC", () => {
    test("CRC16-CCITT as the firmware", () => {
        expect(crc16Ccitt(new TextEncoder().encode("123456789"))).toBe(0x29b1);
        expect(typeFileCrc('{"devTypes":{}}')).toBe("bfcb");
    });
});

describe("vectors are RaftCore's", () => {
    // Only where a RaftCore checkout next to raftjs has them
    const names = ["typefile_vectors.json", "grammar_vectors.json"].filter((n) => fs.existsSync(path.join(RAFTCORE_TESTS, n)));
    (names.length > 0 ? test.each(names) : test.skip.each(["(no RaftCore checkout with the vectors)"]))("%s", (name) => {
        expect(fs.readFileSync(path.join(TESTDATA, name), "utf-8")).toBe(fs.readFileSync(path.join(RAFTCORE_TESTS, name), "utf-8"));
    });
});
