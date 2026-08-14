import AttributeHandler from "./RaftAttributeHandler";
import { getAttrElemsPerSample, DeviceTypePollRespMetadata } from "./RaftDeviceInfo";
import { DeviceAttributesState, DeviceTimeline, deviceAttrGetLatestFormatted } from "./RaftDeviceStates";

function newTimeline(): DeviceTimeline {
    return {
        timestampsUs: [],
        lastReportTimestampUs: 0,
        reportTimestampOffsetUs: 0,
        totalSamplesAdded: 0,
        emaLastSampleTimeUs: 0,
        emaIntervalUs: 0,
        emaPrevPollTimeUs: 0,
        emaCalibrated: false,
        emaCalibrationPolls: 0
    };
}

// Sound-sensor-like schema: scalar, array of 9 offset-coded bytes, trailing scalar
const pollRespMetadata: DeviceTypePollRespMetadata = {
    b: 12,
    a: [
        { n: "leq", t: ">h", u: "dB", r: [-120, 130], d: 100, f: ".2f", o: "float" },
        { n: "bands", t: "B[9]", u: "dB", eu: "Hz", el: ["31.5", "63", "125", "250", "500", "1k", "2k", "4k", "8k"], r: [-100, 155], a: -100, f: "d", o: "int16", vs: false },
        { n: "clipCount", t: "B", r: [0, 255], f: "d", o: "uint8" }
    ]
};

// Build a poll msg: 2-byte BE timestamp then 12 data bytes
function buildMsg(timestampTicks: number, leqCentiDb: number, bandsRaw: number[], clipCount: number): Uint8Array {
    const buf = new Uint8Array(2 + 12);
    buf[0] = (timestampTicks >> 8) & 0xff;
    buf[1] = timestampTicks & 0xff;
    buf[2] = (leqCentiDb >> 8) & 0xff;
    buf[3] = leqCentiDb & 0xff;
    bandsRaw.forEach((v, i) => { buf[4 + i] = v; });
    buf[13] = clipCount;
    return buf;
}

describe("getAttrElemsPerSample", () => {
    test("scalar types", () => {
        expect(getAttrElemsPerSample("B")).toBe(1);
        expect(getAttrElemsPerSample(">h")).toBe(1);
        expect(getAttrElemsPerSample("<f")).toBe(1);
    });
    test("bracket repeat", () => {
        expect(getAttrElemsPerSample("B[9]")).toBe(9);
        expect(getAttrElemsPerSample("<h[64]")).toBe(64);
    });
    test("prefix repeat", () => {
        expect(getAttrElemsPerSample("3H")).toBe(3);
        expect(getAttrElemsPerSample(">4B")).toBe(4);
    });
    test("combined prefix and bracket", () => {
        expect(getAttrElemsPerSample("4B[8]")).toBe(32);
    });
    test("string type yields one value", () => {
        expect(getAttrElemsPerSample("16s")).toBe(1);
    });
});

describe("processMsgAttrGroup with array attribute", () => {
    test("decodes array elements with transforms and groups per sample", () => {
        const handler = new AttributeHandler();
        const timeline = newTimeline();
        const devAttrsState: DeviceAttributesState = {};

        const bandsRaw = [100, 90, 110, 60, 130, 100, 80, 70, 50]; // offset-coded (raw - 100 = dB)
        const msg = buildMsg(1000, 4321, bandsRaw, 3);
        const endIdx = handler.processMsgAttrGroup(msg, 0, timeline, pollRespMetadata, devAttrsState, 100);

        expect(endIdx).toBe(msg.length);

        // Scalar attributes: one value per sample
        expect(devAttrsState["leq"].values).toEqual([43.21]);
        expect(devAttrsState["clipCount"].values).toEqual([3]);

        // Array attribute: 9 values per sample with the "a" offset applied
        expect(devAttrsState["bands"].values).toEqual([0, -10, 10, -40, 30, 0, -20, -30, -50]);
        expect(devAttrsState["bands"].elemsPerSample).toBe(9);
        expect(devAttrsState["bands"].elemLabels).toEqual(["31.5", "63", "125", "250", "500", "1k", "2k", "4k", "8k"]);
        expect(devAttrsState["bands"].elemUnits).toBe("Hz");

        // Timeline: one sample added (not nine)
        expect(timeline.timestampsUs.length).toBe(1);
        expect(timeline.totalSamplesAdded).toBe(1);
    });

    test("multiple polls append sample-aligned values", () => {
        const handler = new AttributeHandler();
        const timeline = newTimeline();
        const devAttrsState: DeviceAttributesState = {};

        handler.processMsgAttrGroup(buildMsg(1000, 100, [100, 101, 102, 103, 104, 105, 106, 107, 108], 0), 0, timeline, pollRespMetadata, devAttrsState, 100);
        handler.processMsgAttrGroup(buildMsg(2000, 200, [110, 111, 112, 113, 114, 115, 116, 117, 118], 1), 0, timeline, pollRespMetadata, devAttrsState, 100);

        expect(devAttrsState["leq"].values.length).toBe(2);
        expect(devAttrsState["bands"].values.length).toBe(18);
        expect(devAttrsState["bands"].values.slice(9)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
        expect(timeline.timestampsUs.length).toBe(2);
    });

    test("history trimming preserves sample alignment for array attributes", () => {
        const handler = new AttributeHandler();
        const timeline = newTimeline();
        const devAttrsState: DeviceAttributesState = {};
        const maxDataPoints = 3;

        for (let poll = 0; poll < 5; poll++) {
            const bandsRaw = Array(9).fill(100 + poll);
            handler.processMsgAttrGroup(buildMsg(1000 * (poll + 1), poll, bandsRaw, poll), 0, timeline, pollRespMetadata, devAttrsState, maxDataPoints);
        }

        // Scalars limited to maxDataPoints samples; array to maxDataPoints * 9 values
        expect(devAttrsState["leq"].values.length).toBe(maxDataPoints);
        expect(devAttrsState["bands"].values.length).toBe(maxDataPoints * 9);
        // Oldest remaining sample must be a complete group (poll 2 onwards)
        expect(devAttrsState["bands"].values.slice(0, 9)).toEqual(Array(9).fill(2));
        expect(devAttrsState["bands"].values.slice(-9)).toEqual(Array(9).fill(4));
    });
});

describe("attribute visibility flags", () => {
    test("v:false hides from series and form; vs:false hides series only", () => {
        const handler = new AttributeHandler();
        const timeline = newTimeline();
        const devAttrsState: DeviceAttributesState = {};
        const meta: DeviceTypePollRespMetadata = {
            b: 3,
            a: [
                { n: "normal", t: "B", f: "d" },
                { n: "hiddenAll", t: "B", f: "d", v: false },
                { n: "noSeries", t: "B", f: "d", vs: false }
            ]
        };
        const msg = new Uint8Array([0x00, 0x64, 1, 2, 3]); // 2-byte timestamp + 3 data bytes
        handler.processMsgAttrGroup(msg, 0, timeline, meta, devAttrsState, 100);

        expect(devAttrsState["normal"].visibleSeries).toBe(true);
        expect(devAttrsState["normal"].visibleForm).toBe(true);
        expect(devAttrsState["hiddenAll"].visibleSeries).toBe(false);
        expect(devAttrsState["hiddenAll"].visibleForm).toBe(false);
        expect(devAttrsState["noSeries"].visibleSeries).toBe(false);
        expect(devAttrsState["noSeries"].visibleForm).toBe(true);
    });
});

describe("deviceAttrGetLatestFormatted with array attribute", () => {
    test("formats the latest full sample", () => {
        const attrState = {
            name: "bands",
            newAttribute: false,
            newData: true,
            numNewValues: 9,
            values: [0, -10, 10, -40, 30, 0, -20, -30, -50],
            units: "dB",
            range: [-100, 155],
            format: "d",
            visibleSeries: false,
            visibleForm: true,
            elemsPerSample: 9,
        };
        expect(deviceAttrGetLatestFormatted(attrState)).toBe("[0, -10, 10, -40, 30, 0, -20, -30, -50]");
    });
});
