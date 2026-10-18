import { encodeActionWrite, sensirionCrc8, DeviceTypeAction } from "./RaftDeviceInfo";

describe("sensirionCrc8", () => {
    test("datasheet example: 0xBEEF -> 0x92", () => {
        expect(sensirionCrc8(0xbe, 0xef)).toBe(0x92);
    });
    test("SGP40 default compensation words", () => {
        expect(sensirionCrc8(0x80, 0x00)).toBe(0xa2);
        expect(sensirionCrc8(0x66, 0x66)).toBe(0x93);
    });
});

describe("encodeActionWrite", () => {
    test("prefix, packed value and suffix (no crc)", () => {
        const action: DeviceTypeAction = { n: "a", t: ">H", w: "0001", wz: "0064" };
        expect(encodeActionWrite(action, [0x1234])).toBe("000112340064");
    });
    test("sub and mul applied to a single value", () => {
        const action: DeviceTypeAction = { n: "a", t: "B", w: "10", sub: 1, mul: 10 };
        expect(encodeActionWrite(action, [5])).toBe("1028");
    });
    test("no type writes the prefix only", () => {
        expect(encodeActionWrite({ n: "off", w: "78" }, [])).toBe("78");
    });
    test("crc8w adds a CRC after each word", () => {
        const action: DeviceTypeAction = { n: "p", t: ">H", w: "e000", crc: "crc8w" };
        // 0x03F5 (1013 hPa)
        expect(encodeActionWrite(action, [1013])).toBe("e00003f5" + sensirionCrc8(0x03, 0xf5).toString(16).padStart(2, "0"));
        const two: DeviceTypeAction = { n: "b", t: ">HH", w: "201e", crc: "crc8w" };
        expect(encodeActionWrite(two, [0xbeef, 0x8000])).toBe("201ebeef928000a2");
    });
    test("crc8w with a value that isn't whole words can't be encoded", () => {
        expect(encodeActionWrite({ n: "x", t: "B", w: "20", crc: "crc8w" }, [1])).toBeNull();
    });
    test("an unknown crc kind can't be encoded", () => {
        expect(encodeActionWrite({ n: "x", t: ">H", w: "20", crc: "crc16" }, [1])).toBeNull();
    });
});
