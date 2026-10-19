import AttributeHandler from "./RaftAttributeHandler";
import { getAttrElemsPerSample, DeviceTypePollRespMetadata } from "./RaftDeviceInfo";
import { DeviceAttributesState, DeviceAttributeState, DeviceTimeline, deviceAttrGetLatestFormatted, deviceAttrValueLabel } from "./RaftDeviceStates";

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

describe("custom decode with signed array attribute", () => {
    test("sign-extends each element using the element width", () => {
        const meta: DeviceTypePollRespMetadata = {
            b: 4,
            a: [{ n: "f", t: "<h[2]", r: [-32768, 32767], f: "d", o: "int16" }],
            c: { n: "signed_arr", c: "out.f[0]=(buf[1]<<8)|buf[0];out.f[1]=(buf[3]<<8)|buf[2];" }
        } as DeviceTypePollRespMetadata;
        const handler = new AttributeHandler();
        const devAttrsState: DeviceAttributesState = {};
        const msg = new Uint8Array([0x00, 0x10, 0xFF, 0xFF, 0x02, 0x00]);
        handler.processMsgAttrGroup(msg, 0, newTimeline(), meta, devAttrsState, 100);
        expect(devAttrsState["f"].values).toEqual([-1, 2]);
        expect(devAttrsState["f"].elemsPerSample).toBe(2);
    });
});

// SCD30 (RaftCore devtypes/records/SCD30.json resp): a sample only when the second data-ready word is 1, with the
// big-endian floats built from their bits - a poll before data is ready reads 0xFFFF words, which mustn't give NaN
describe("SCD30 custom decode", () => {
    const meta = {"b": 24, "a": [{"n": "CO2", "t": "<f", "u": "ppm", "r": [0, 40000], "f": ".1f", "o": "float"}, {"n": "temperature", "t": "<f", "u": "&deg;C", "r": [-40, 125], "f": ".2f", "o": "float"}, {"n": "humidity", "t": "<f", "u": "%", "r": [0, 100], "f": ".2f", "o": "float"}], "c": {"n": "scd30_ready_floats", "c": "int ready=(buf[3]<<8)|buf[4];if(ready==1){int co2h=(buf[6]<<8)|buf[7];int co2l=(buf[9]<<8)|buf[10];int co2e=(co2h>>7)&255;float co2=0.0;if(co2e>0){if(co2e<255){co2=1.0+(((co2h&127)*65536)+co2l)/8388608.0;int co2k=co2e-127;while(co2k>0){co2=co2*2.0;co2k=co2k-1;}while(co2k<0){co2=co2/2.0;co2k=co2k+1;}}}if(co2h>32767){co2=0.0-co2;}out.CO2=co2;int tmph=(buf[12]<<8)|buf[13];int tmpl=(buf[15]<<8)|buf[16];int tmpe=(tmph>>7)&255;float tmp=0.0;if(tmpe>0){if(tmpe<255){tmp=1.0+(((tmph&127)*65536)+tmpl)/8388608.0;int tmpk=tmpe-127;while(tmpk>0){tmp=tmp*2.0;tmpk=tmpk-1;}while(tmpk<0){tmp=tmp/2.0;tmpk=tmpk+1;}}}if(tmph>32767){tmp=0.0-tmp;}out.temperature=tmp;int humh=(buf[18]<<8)|buf[19];int huml=(buf[21]<<8)|buf[22];int hume=(humh>>7)&255;float hum=0.0;if(hume>0){if(hume<255){hum=1.0+(((humh&127)*65536)+huml)/8388608.0;int humk=hume-127;while(humk>0){hum=hum*2.0;humk=humk-1;}while(humk<0){hum=hum/2.0;humk=humk+1;}}}if(humh>32767){hum=0.0-hum;}out.humidity=hum;next;}"}} as DeviceTypePollRespMetadata;
    function crc8(b0: number, b1: number): number {
        let crc = 0xff;
        for (const b of [b0, b1]) {
            crc ^= b;
            for (let i = 0; i < 8; i++)
                crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
        }
        return crc;
    }
    function scd30Msg(ready: number, values: number[] | null): Uint8Array {
        const bytes: number[] = [0x00, 0x10];
        const word = (w: number) => { bytes.push(w >> 8, w & 0xff, crc8(w >> 8, w & 0xff)); };
        word(ready);
        word(ready);
        for (let i = 0; i < 3; i++) {
            let bits = 0xffffffff;
            if (values) {
                const view = new DataView(new ArrayBuffer(4));
                view.setFloat32(0, values[i]);
                bits = view.getUint32(0);
            }
            word(bits >>> 16);
            word(bits & 0xffff);
        }
        return new Uint8Array(bytes);
    }
    test("data ready: exact values", () => {
        const handler = new AttributeHandler();
        const devAttrsState: DeviceAttributesState = {};
        handler.processMsgAttrGroup(scd30Msg(1, [1151.5, -10.25, 52.875]), 0, newTimeline(), meta, devAttrsState, 100);
        expect(devAttrsState["CO2"].values).toEqual([1151.5]);
        expect(devAttrsState["temperature"].values).toEqual([-10.25]);
        expect(devAttrsState["humidity"].values).toEqual([52.875]);
    });
    test("data not ready: no sample", () => {
        const handler = new AttributeHandler();
        const devAttrsState: DeviceAttributesState = {};
        handler.processMsgAttrGroup(scd30Msg(0, null), 0, newTimeline(), meta, devAttrsState, 100);
        expect(devAttrsState["CO2"]?.values ?? []).toEqual([]);
    });
});

// Value labels (vl) and bit labels (bl): display text only - the stored values stay numeric
describe("value and bit labels", () => {
    const meta: DeviceTypePollRespMetadata = {
        b: 2,
        a: [
            { n: "pmState", t: "B", r: [0, 4], f: "d", o: "uint8", vl: { "0": "unknown", "1": "OK", "2": "low", "3": "critical" } },
            { n: "status", t: "B", r: [0, 255], f: "02x", o: "uint8", bl: { "0x04": "VL", "0x08": "VR", "0x10": "HD", "0x40": "EnVr" } },
        ]
    } as DeviceTypePollRespMetadata;
    function decode(pm: number, status: number): DeviceAttributesState {
        const st: DeviceAttributesState = {};
        new AttributeHandler().processMsgAttrGroup(new Uint8Array([0x00, 0x10, pm, status]), 0, newTimeline(), meta, st, 100);
        return st;
    }
    test("vl labels a value; values stay numeric", () => {
        const st = decode(3, 0);
        expect(st["pmState"].values).toEqual([3]);
        expect(deviceAttrGetLatestFormatted(st["pmState"])).toBe("critical");
    });
    test("vl: an unlisted value shows the formatted number and (?)", () => {
        expect(deviceAttrGetLatestFormatted(decode(7, 0)["pmState"])).toBe("7 (?)");
    });
    test("bl: set bits' labels in mask order, unlabelled bits as hex", () => {
        const st = decode(1, 0x5c);
        expect(st["status"].values).toEqual([0x5c]);
        expect(deviceAttrGetLatestFormatted(st["status"])).toBe("VL VR HD EnVr");
        expect(deviceAttrGetLatestFormatted(decode(1, 0x85)["status"])).toBe("VL +0x81");
    });
    test("bl: zero shows - or the 0 entry", () => {
        expect(deviceAttrGetLatestFormatted(decode(1, 0)["status"])).toBe("-");
        const withZero = { ...decode(1, 0)["status"], bitLabels: { "0": "OK", "0x01": "A" } } as DeviceAttributeState;
        expect(deviceAttrGetLatestFormatted(withZero)).toBe("OK");
    });
    test("bl: an empty label ignores its bits", () => {
        const st = { ...decode(1, 0)["status"], bitLabels: { "0x04": "VL", "0x40": "" } } as DeviceAttributeState;
        expect(deviceAttrValueLabel(0x40, st)).toBe("-");
        expect(deviceAttrValueLabel(0x44, st)).toBe("VL");
        const withZero = { ...st, bitLabels: { "0": "OK", "0x40": "" } } as DeviceAttributeState;
        expect(deviceAttrValueLabel(0x40, withZero)).toBe("OK");
    });
    test("bl: a 16-bit mask", () => {
        const st = { ...decode(1, 0)["status"], bitLabels: { "0x0040": "testing mode" } } as DeviceAttributeState;
        expect(deviceAttrValueLabel(0x0140, st)).toBe("testing mode +0x100");
    });
    test("vl takes precedence over bl; no labels gives null", () => {
        const both = { ...decode(2, 0)["pmState"], bitLabels: { "0x02": "B1" } } as DeviceAttributeState;
        expect(deviceAttrValueLabel(2, both)).toBe("low");
        const plain = { ...decode(2, 0)["pmState"], valueLabels: undefined } as DeviceAttributeState;
        expect(deviceAttrValueLabel(2, plain)).toBeNull();
        expect(deviceAttrGetLatestFormatted(plain)).toBe("2");
    });
});
