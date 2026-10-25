// The decode code check, against the vectors shared with RaftCore (scripts/tests/codecheck_vectors.json, copied into
// testdata/ - after a change there, copy it again)

import * as fs from "fs";
import * as path from "path";
import { checkDeviceTypeCode, checkDeviceTypeRecordCode, DeviceTypeCodeKind } from "./RaftDeviceTypeCodeCheck";
import { parseDevTypeJson } from "./RaftDeviceTypeJson";

const TESTDATA = path.join(__dirname, "..", "testdata");
const RAFTCORE_TESTS = path.join(__dirname, "..", "..", "RaftCore", "scripts", "tests");
const vectors: any[] = JSON.parse(fs.readFileSync(path.join(TESTDATA, "codecheck_vectors.json"), "utf-8")).vectors;

describe("decode code check vectors", () => {
    test("there are vectors, RaftCore's records among them", () => {
        expect(vectors.length).toBeGreaterThan(20);
        expect(vectors.some((v) => v.name.endsWith("decode code"))).toBe(true);
    });

    test.each(vectors.map((v) => [v.name, v]))("%s", (_name, vec) => {
        expect(checkDeviceTypeCode(vec.code, vec.attrs, vec.kind as DeviceTypeCodeKind)).toEqual(vec.problems);
    });

    test("a record's decode and init code", () => {
        const record = parseDevTypeJson(JSON.stringify({ initCode: { c: "init.a = f(1);" },
            devInfoJson: { resp: { b: 1, a: [{ n: "v" }], c: { n: "x", c: "out.v = buf[0]; out.w = 1;" } } } }));
        expect(checkDeviceTypeRecordCode(record)).toEqual(["out.w is not an attribute of the record",
            "initCode: f is not declared in the code", "initCode: f(...) - function calls are not allowed"]);
        expect(checkDeviceTypeRecordCode(parseDevTypeJson('{"initCode":"init.a = 1;"}'))).toEqual([]);
        expect(checkDeviceTypeRecordCode(parseDevTypeJson("{}"))).toEqual([]);
    });
});

describe("vectors are RaftCore's", () => {
    const present = fs.existsSync(path.join(RAFTCORE_TESTS, "codecheck_vectors.json"));
    (present ? test : test.skip)("codecheck_vectors.json", () => {
        expect(fs.readFileSync(path.join(TESTDATA, "codecheck_vectors.json"), "utf-8"))
            .toBe(fs.readFileSync(path.join(RAFTCORE_TESTS, "codecheck_vectors.json"), "utf-8"));
    });
});
