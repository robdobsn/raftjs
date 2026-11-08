// Device type record action encoding against the shared vectors (RaftCore scripts/tests/action_encode_vectors.json,
// copied into testdata/ - after a change there, copy it again). RaftCore's DeviceActionEncoder (devman/action) is
// tested against the same vectors, so the firmware and raftjs encode actions the same way.

import * as fs from "fs";
import * as path from "path";
import { DeviceTypeAction, encodeActionWrite, getActionMapHex } from "./RaftDeviceInfo";

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testdata", "action_encode_vectors.json"), "utf-8"));

// The writes for an action as raftjs's sendAction makes them (map: the entry's hex split on '&'; else encodeActionWrite)
function encodeWrites(action: DeviceTypeAction, values: Array<number | string>): string[] | null {
    if (action.map && values.length === 1) {
        const entry = action.map[String(values[0])];
        if (entry === undefined) return null;
        return getActionMapHex(entry).split("&").filter(s => s.length > 0).map(s => s.toLowerCase());
    }
    if (values.some(v => typeof v !== "number")) return null;
    try {
        const hex = encodeActionWrite(action, values as number[]);
        return hex === null ? null : [hex.toLowerCase()];
    } catch {
        return null;
    }
}

describe("action encoding (shared vectors)", () => {
    for (const c of vectors.cases) {
        test(c.desc, () => {
            expect(encodeWrites(c.action, c.values)).toEqual(c.writes);
        });
    }
    for (const e of vectors.errors) {
        test(`error: ${e.desc}`, () => {
            expect(encodeWrites(e.action, e.values)).toBeNull();
        });
    }
});
