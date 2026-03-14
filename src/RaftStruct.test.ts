import { structUnpack, structPack, structSizeOf } from "./RaftStruct";

// Helper to create Uint8Array from byte values
function bytes(...vals: number[]): Uint8Array {
    return new Uint8Array(vals);
}

// ===== Existing functionality (regression tests) =====

describe("structUnpack", () => {
    test("single B", () => {
        expect(structUnpack("B", bytes(0xff))).toEqual([255]);
    });

    test("single b (signed)", () => {
        expect(structUnpack("b", bytes(0xff))).toEqual([-1]);
    });

    test("<H little-endian uint16", () => {
        expect(structUnpack("<H", bytes(0x01, 0x02))).toEqual([0x0201]);
    });

    test(">H big-endian uint16", () => {
        expect(structUnpack(">H", bytes(0x01, 0x02))).toEqual([0x0102]);
    });

    test("BBBB four bytes", () => {
        expect(structUnpack("BBBB", bytes(1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
    });

    test("<I little-endian uint32", () => {
        const buf = bytes(0x78, 0x56, 0x34, 0x12);
        expect(structUnpack("<I", buf)).toEqual([0x12345678]);
    });

    test(">I big-endian uint32", () => {
        const buf = bytes(0x12, 0x34, 0x56, 0x78);
        expect(structUnpack(">I", buf)).toEqual([0x12345678]);
    });

    test("[N] bracket repeat", () => {
        expect(structUnpack("B[3]", bytes(10, 20, 30))).toEqual([10, 20, 30]);
    });

    test("x padding skips byte", () => {
        expect(structUnpack("xB", bytes(0xff, 0x42))).toEqual([0x42]);
    });

    test("<f float32", () => {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setFloat32(0, 3.14, true);
        const result = structUnpack("<f", buf);
        expect(result[0]).toBeCloseTo(3.14, 2);
    });
});

// ===== Prefix digit syntax =====

describe("prefix digit syntax", () => {
    test("3B equivalent to BBB", () => {
        expect(structUnpack("3B", bytes(1, 2, 3))).toEqual([1, 2, 3]);
    });

    test("2H two uint16s", () => {
        expect(structUnpack(">2H", bytes(0, 1, 0, 2))).toEqual([1, 2]);
    });

    test("prefix and bracket multiply", () => {
        // 2B[3] means repeat=6
        expect(structUnpack("2B[3]", bytes(1, 2, 3, 4, 5, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("prefix digits in structSizeOf", () => {
        expect(structSizeOf("3B")).toBe(3);
        expect(structSizeOf(">2H")).toBe(4);
        expect(structSizeOf("2I")).toBe(8);
    });

    test("prefix digits in structPack", () => {
        const packed = structPack("3B", [10, 20, 30]);
        expect(Array.from(packed)).toEqual([10, 20, 30]);
    });

    test("multi-digit prefix count", () => {
        expect(structSizeOf("16s")).toBe(16);
        expect(structSizeOf("10B")).toBe(10);
    });
});

// ===== s format code =====

describe("s format (byte strings)", () => {
    test("unpack 5s reads a string", () => {
        const buf = bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f); // "Hello"
        expect(structUnpack("5s", buf)).toEqual(["Hello"]);
    });

    test("unpack s with trailing nulls trims them", () => {
        const buf = bytes(0x48, 0x69, 0x00, 0x00, 0x00); // "Hi\0\0\0"
        expect(structUnpack("5s", buf)).toEqual(["Hi"]);
    });

    test("unpack s produces one value regardless of count", () => {
        const buf = bytes(0x41, 0x42, 0x43); // "ABC"
        const result = structUnpack("3s", buf);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe("ABC");
    });

    test("s combined with other types", () => {
        // B then 3s then B
        const buf = bytes(0xff, 0x41, 0x42, 0x43, 0x01);
        const result = structUnpack("B3sB", buf);
        expect(result).toEqual([255, "ABC", 1]);
    });

    test("structSizeOf with s", () => {
        expect(structSizeOf("5s")).toBe(5);
        expect(structSizeOf("B5sH")).toBe(8); // 1 + 5 + 2
        expect(structSizeOf(">16s")).toBe(16);
    });

    test("structPack with string value", () => {
        const packed = structPack("5s", ["Hello"]);
        expect(Array.from(packed)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    });

    test("structPack s zero-pads short strings", () => {
        const packed = structPack("5s", ["Hi"]);
        expect(Array.from(packed)).toEqual([0x48, 0x69, 0x00, 0x00, 0x00]);
    });

    test("structPack s with Uint8Array value", () => {
        const packed = structPack("3s", [bytes(0x01, 0x02, 0x03)]);
        expect(Array.from(packed)).toEqual([1, 2, 3]);
    });

    test("structPack s combined with numeric types", () => {
        const packed = structPack("B3sB", [0xff, "ABC", 0x01]);
        expect(Array.from(packed)).toEqual([0xff, 0x41, 0x42, 0x43, 0x01]);
    });

    test("round-trip pack/unpack s", () => {
        const original = "Test";
        const packed = structPack("8s", [original]);
        const [unpacked] = structUnpack("8s", packed);
        expect(unpacked).toBe(original);
    });
});

// ===== q/Q 64-bit integers =====

describe("q/Q 64-bit integers", () => {
    test("unpack >q signed 64-bit", () => {
        // 0x0000000000000001 = 1
        const buf = bytes(0, 0, 0, 0, 0, 0, 0, 1);
        expect(structUnpack(">q", buf)).toEqual([1]);
    });

    test("unpack >Q unsigned 64-bit", () => {
        const buf = bytes(0, 0, 0, 0, 0, 0, 0, 42);
        expect(structUnpack(">Q", buf)).toEqual([42]);
    });

    test("unpack <q little-endian", () => {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigInt64(0, BigInt(-1000), true);
        expect(structUnpack("<q", buf)).toEqual([-1000]);
    });

    test("unpack >q negative", () => {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigInt64(0, BigInt(-1), false);
        expect(structUnpack(">q", buf)).toEqual([-1]);
    });

    test("structSizeOf q and Q", () => {
        expect(structSizeOf("q")).toBe(8);
        expect(structSizeOf("Q")).toBe(8);
        expect(structSizeOf(">qQ")).toBe(16);
    });

    test("structPack >q", () => {
        const packed = structPack(">q", [1]);
        expect(Array.from(packed)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    });

    test("structPack <Q", () => {
        const packed = structPack("<Q", [256]);
        const view = new DataView(packed.buffer);
        expect(Number(view.getBigUint64(0, true))).toBe(256);
    });

    test("round-trip q", () => {
        const packed = structPack(">q", [-123456789]);
        const [unpacked] = structUnpack(">q", packed);
        expect(unpacked).toBe(-123456789);
    });

    test("round-trip Q", () => {
        const packed = structPack(">Q", [123456789]);
        const [unpacked] = structUnpack(">Q", packed);
        expect(unpacked).toBe(123456789);
    });
});

// ===== Error handling =====

describe("error handling", () => {
    test("unknown format code throws", () => {
        expect(() => structUnpack("Z", bytes(0))).toThrow("Unknown format character");
    });

    test("missing ] throws", () => {
        expect(() => structUnpack("B[3", bytes(1, 2, 3))).toThrow("missing closing ]");
    });

    test("digit without format code throws", () => {
        expect(() => structUnpack("3", bytes(1, 2, 3))).toThrow("Expected format code after prefix count");
    });

    test("structPack insufficient values throws", () => {
        expect(() => structPack("HH", [1])).toThrow("Insufficient values");
    });

    test("structPack s with number throws", () => {
        expect(() => structPack("3s", [42])).toThrow("Expected string or Uint8Array");
    });
});
