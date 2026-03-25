import { tokenize, transpilePseudocodeToJs } from "./PseudocodeTranspiler";
import CustomAttrHandler from "./RaftCustomAttrHandler";
import { DeviceTypePollRespMetadata } from "./RaftDeviceInfo";

// ===== Pseudocode strings from DeviceTypeRecords.json =====

const PSEUDOCODE = {
    max30101_fifo:
        'int N=(buf[0]+32-buf[2])%32;int k=3;int i=0;while(i<N){out.Red=(buf[k]<<16)|(buf[k+1]<<8)|buf[k+2];out.IR=(buf[k+3]<<16)|(buf[k+4]<<8)|buf[k+5];k+=6;i++;next;}',
    lsm6ds_fifo:
        'int W=((buf[1]&0x0F)<<8)|buf[0];int P=((buf[3]&0x03)<<8)|buf[2];int skip=(6-P%6)%6;int N=(W-skip)/6;int maxN=(192-skip*2)/12;if(N>maxN){N=maxN;}if(N>16){N=16;}if(N<1){N=0;}int k=4+skip*2;int i=0;while(i<N){out.gx=(buf[k+1]<<8)|buf[k];out.gy=(buf[k+3]<<8)|buf[k+2];out.gz=(buf[k+5]<<8)|buf[k+4];out.ax=(buf[k+7]<<8)|buf[k+6];out.ay=(buf[k+9]<<8)|buf[k+8];out.az=(buf[k+11]<<8)|buf[k+10];k+=12;i++;next;}',
    scd40_calc:
        'out.CO2 = buf[0]; out.Temp = -45.0 + (175.0 * buf[1] / 65535.0); out.Humidity = (100.0 * buf[2] / 65535.0);',
    gravity_o2_calc:
        'float key = 20.9/120.0; float val = key * (buf[0] + (buf[1]/10.0) + (buf[2]/100.0)); out.oxygen = val;',
};

// Helper to build a minimal DeviceTypePollRespMetadata
function makeMeta(numBytes: number, attrNames: string[], customName: string, pseudocode: string): DeviceTypePollRespMetadata {
    return {
        b: numBytes,
        a: attrNames.map(n => ({ n, t: 'B' })),
        c: { n: customName, c: pseudocode },
    } as DeviceTypePollRespMetadata;
}

// ===== Tokenizer tests =====

describe("tokenize", () => {
    test("handles float literals before integers", () => {
        const tokens = tokenize("20.9/120.0");
        expect(tokens).toEqual([
            { type: "NUM_FLOAT", value: "20.9" },
            { type: "DIV_OP", value: "/" },
            { type: "NUM_FLOAT", value: "120.0" },
        ]);
    });

    test("handles hex literals", () => {
        const tokens = tokenize("buf[1]&0x0F");
        expect(tokens).toEqual([
            { type: "ID", value: "buf" },
            { type: "LBRACK", value: "[" },
            { type: "NUM_INT", value: "1" },
            { type: "RBRACK", value: "]" },
            { type: "BITWISE_AND", value: "&" },
            { type: "HEX_NUM", value: "0x0F" },
        ]);
    });

    test("handles int keyword without matching identifiers containing 'int'", () => {
        const tokens = tokenize("int interval=5;");
        expect(tokens[0]).toEqual({ type: "INT_KW", value: "int" });
        // 'interval' should be a single ID, not "int" + "erval"
        expect(tokens[1]).toEqual({ type: "ID", value: "interval" });
    });

    test("handles multi-char operators before single-char", () => {
        const tokens = tokenize("a<<b&&c||d==e!=f<=g>=h");
        const types = tokens.map(t => t.type);
        expect(types).toContain("LSHIFT");
        expect(types).toContain("LOGICAL_AND");
        expect(types).toContain("LOGICAL_OR");
        expect(types).toContain("REL_OP"); // ==, !=, <=, >=
    });

    test("handles increment and decrement operators", () => {
        const tokens = tokenize("i++;k--;");
        expect(tokens).toEqual([
            { type: "ID", value: "i" },
            { type: "INC_OP", value: "++" },
            { type: "SEMI", value: ";" },
            { type: "ID", value: "k" },
            { type: "DEC_OP", value: "--" },
            { type: "SEMI", value: ";" },
        ]);
    });

    test("handles dotted identifiers (out.X)", () => {
        const tokens = tokenize("out.Red=val;");
        expect(tokens[0]).toEqual({ type: "ID", value: "out.Red" });
    });

    test("'if' falls through to ID token", () => {
        const tokens = tokenize("if(N>16){N=16;}");
        expect(tokens[0]).toEqual({ type: "ID", value: "if" });
    });

    test("'while' is a keyword token", () => {
        const tokens = tokenize("while(i<N){");
        expect(tokens[0]).toEqual({ type: "WHILE", value: "while" });
    });

    test("'next' is a keyword token", () => {
        const tokens = tokenize("next;");
        expect(tokens[0]).toEqual({ type: "NEXT", value: "next" });
    });

    test("negative float literal tokenizes as SUB_OP + NUM_FLOAT", () => {
        const tokens = tokenize("-45.0");
        expect(tokens).toEqual([
            { type: "SUB_OP", value: "-" },
            { type: "NUM_FLOAT", value: "45.0" },
        ]);
    });

    test("tokenizes all four pseudocode strings without errors", () => {
        for (const [, code] of Object.entries(PSEUDOCODE)) {
            const tokens = tokenize(code);
            expect(tokens.length).toBeGreaterThan(0);
            // Verify all characters are consumed by checking no unknown tokens
            for (const t of tokens) {
                expect(t.type).not.toBe("UNKNOWN");
            }
        }
    });
});

// ===== Transpiler output tests =====

describe("transpilePseudocodeToJs", () => {
    test("replaces int with let and wraps in Math.trunc", () => {
        const js = transpilePseudocodeToJs("int x=1;");
        expect(js).toContain("let x=Math.trunc(1);");
        expect(js).not.toContain("int ");
    });

    test("replaces float with let without Math.trunc", () => {
        const js = transpilePseudocodeToJs("float y=2.0;");
        expect(js).toContain("let y=2.0;");
        expect(js).not.toContain("float ");
        expect(js).not.toMatch(/Math\.trunc/);
    });

    test("Math.trunc wraps division in int declaration", () => {
        const js = transpilePseudocodeToJs("int N=(W-skip)/6;");
        expect(js).toContain("let N=Math.trunc((W-skip)/6);");
    });

    test("removes next keyword", () => {
        const js = transpilePseudocodeToJs("i++;next;");
        expect(js).toContain("i++;");
        // 'next' should be removed entirely; only the semicolons after i++ and after next remain
        expect(js).not.toMatch(/\bnext\b/);
    });

    test("includes Proxy preamble", () => {
        const js = transpilePseudocodeToJs("out.x=1;");
        expect(js).toContain("new Proxy");
        expect(js).toContain("attrValues[p]");
    });

    test("includes toInt16 helper", () => {
        const js = transpilePseudocodeToJs("");
        expect(js).toContain("function toInt16");
    });

    test("preserves out.X assignments verbatim", () => {
        const js = transpilePseudocodeToJs("out.Red=(buf[k]<<16);");
        expect(js).toContain("out.Red=(buf[k]<<16);");
    });

    test("preserves hex literals", () => {
        const js = transpilePseudocodeToJs("int W=((buf[1]&0x0F)<<8)|buf[0];");
        expect(js).toContain("0x0F");
    });

    test("gravity_o2_calc transpiles correctly (float, no Math.trunc)", () => {
        const js = transpilePseudocodeToJs(PSEUDOCODE.gravity_o2_calc);
        expect(js).toContain("let key=20.9/120.0;");
        expect(js).toContain("let val=key");
        expect(js).toContain("out.oxygen=val;");
        // float declarations should NOT be wrapped in Math.trunc
        expect(js).not.toMatch(/Math\.trunc/);
    });

    test("lsm6ds_fifo transpiles with Math.trunc for int divisions", () => {
        const js = transpilePseudocodeToJs(PSEUDOCODE.lsm6ds_fifo);
        expect(js).toContain("Math.trunc((W-skip)/6)");
        expect(js).toContain("Math.trunc((192-skip*2)/12)");
    });
});

// ===== End-to-end execution tests via CustomAttrHandler =====

describe("CustomAttrHandler with transpiled pseudocode", () => {

    test("max30101_fifo: decodes 2 samples", () => {
        // buf[0] = write pointer = 5, buf[2] = read pointer = 3 → N = (5+32-3)%32 = 2
        // Samples start at buf[3], 6 bytes each (3 for Red, 3 for IR)
        const bufData = new Uint8Array([
            5, 0, 3,  // write ptr, unused, read ptr
            0x01, 0x02, 0x03,  // Red sample 0: (1<<16)|(2<<8)|3 = 66051
            0x04, 0x05, 0x06,  // IR  sample 0: (4<<16)|(5<<8)|6 = 263430
            0x10, 0x20, 0x30,  // Red sample 1: (16<<16)|(32<<8)|48 = 1056816
            0x40, 0x50, 0x60,  // IR  sample 1: (64<<16)|(80<<8)|96 = 4214880
        ]);

        const meta = makeMeta(bufData.length, ["Red", "IR"], "max30101_fifo", PSEUDOCODE.max30101_fifo);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        expect(result.length).toBe(2); // 2 attributes
        expect(result[0]).toEqual([66051, 1056816]);       // Red
        expect(result[1]).toEqual([263430, 4214880]);       // IR
    });

    test("max30101_fifo: N=0 produces empty arrays", () => {
        // write ptr = read ptr → N = 0
        const bufData = new Uint8Array([3, 0, 3]);
        const meta = makeMeta(bufData.length, ["Red", "IR"], "max30101_fifo", PSEUDOCODE.max30101_fifo);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        expect(result[0]).toEqual([]); // Red
        expect(result[1]).toEqual([]); // IR
    });

    test("lsm6ds_fifo: decodes 1 aligned sample (unsigned values)", () => {
        // W = 6 words, P = 0 (aligned) → skip = 0, N = 1
        // 4 bytes header + 12 bytes data = 16 bytes
        const header = [6, 0, 0, 0]; // W=6, P=0
        // gx=0x0100(256), gy=0x0200(512), gz=0x0300(768), ax=0x0400(1024), ay=0x0500(1280), az=0x0600(1536)
        const sample = [0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06];
        const bufData = new Uint8Array([...header, ...sample]);

        const meta = makeMeta(bufData.length, ["gx", "gy", "gz", "ax", "ay", "az"], "lsm6ds_fifo", PSEUDOCODE.lsm6ds_fifo);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        // Custom handler produces unsigned values; sign conversion happens in RaftAttributeHandler
        expect(result[0]).toEqual([256]);   // gx
        expect(result[1]).toEqual([512]);   // gy
        expect(result[2]).toEqual([768]);   // gz
        expect(result[3]).toEqual([1024]);  // ax
        expect(result[4]).toEqual([1280]);  // ay
        expect(result[5]).toEqual([1536]);  // az
    });

    test("lsm6ds_fifo: integer division truncates (non-multiple word count)", () => {
        // W = 7 words (not a multiple of 6), P = 0 → skip = 0, N = Math.trunc(7/6) = 1
        // Without Math.trunc, N=1.166... would cause 2 iterations reading garbage
        const header = [7, 0, 0, 0]; // W=7, P=0
        const sample = [0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00];
        // Only provide 4 header + 12 data bytes (enough for 1 sample, not 2)
        const bufData = new Uint8Array([...header, ...sample]);

        const meta = makeMeta(bufData.length, ["gx", "gy", "gz", "ax", "ay", "az"], "lsm6ds_fifo", PSEUDOCODE.lsm6ds_fifo);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        // Should decode exactly 1 sample (truncated division), not 2
        expect(result[0]).toEqual([1]);   // gx
        expect(result[0].length).toBe(1);
    });

    test("lsm6ds_fifo: clamps N to 16", () => {
        // W = 200 words, P = 0 → N = 200/6 = 33, clamped to 16
        // Need 4 header + 16*12 = 196 data bytes
        const bufArr = new Array(200).fill(0);
        bufArr[0] = 200; // W low byte
        bufArr[1] = 0;   // W high nibble
        bufArr[2] = 0;   // P low byte
        bufArr[3] = 0;   // P high byte
        // Fill with recognizable data: each sample's gx low byte = sample index
        for (let i = 0; i < 16; i++) {
            bufArr[4 + i * 12] = i; // gx low byte
        }
        const bufData = new Uint8Array(bufArr);

        const meta = makeMeta(bufData.length, ["gx", "gy", "gz", "ax", "ay", "az"], "lsm6ds_fifo", PSEUDOCODE.lsm6ds_fifo);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        expect(result[0].length).toBe(16); // gx has exactly 16 samples
    });

    test("scd40_calc: decodes CO2, Temp, Humidity", () => {
        // buf[0] = CO2 raw, buf[1] = Temp raw, buf[2] = Humidity raw
        // Using buf[0]=400 won't fit in single byte; the pseudocode treats buf values as numbers
        // In real usage these would be pre-decoded multi-byte values packed into the buf
        const bufData = new Uint8Array([100, 128, 200]);

        const meta = makeMeta(bufData.length, ["CO2", "Temp", "Humidity"], "scd40_calc", PSEUDOCODE.scd40_calc);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        expect(result[0]).toEqual([100]); // CO2
        expect(result[1][0]).toBeCloseTo(-45.0 + (175.0 * 128 / 65535.0), 5); // Temp
        expect(result[2][0]).toBeCloseTo(100.0 * 200 / 65535.0, 5); // Humidity
    });

    test("gravity_o2_calc: decodes oxygen", () => {
        // buf[0]=10, buf[1]=5, buf[2]=25 → val = (20.9/120) * (10 + 0.5 + 0.25) = 0.174166... * 10.75
        const bufData = new Uint8Array([10, 5, 25]);

        const meta = makeMeta(bufData.length, ["oxygen"], "gravity_o2_calc", PSEUDOCODE.gravity_o2_calc);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        const expected = (20.9 / 120.0) * (10 + 5 / 10.0 + 25 / 100.0);
        expect(result[0][0]).toBeCloseTo(expected, 10);
    });

    test("explicit j field takes priority over c field", () => {
        const meta: DeviceTypePollRespMetadata = {
            b: 1,
            a: [{ n: "val", t: "B" }],
            c: {
                n: "test_fn",
                c: "out.val = buf[0] * 2;",     // pseudocode would multiply by 2
                j: "attrValues['val'].push(buf[0] * 10);", // explicit JS multiplies by 10
            },
        } as DeviceTypePollRespMetadata;

        const bufData = new Uint8Array([7]);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        expect(result[0]).toEqual([70]); // j field used → 7 * 10
    });

    test("no custom function returns empty attribute vectors", () => {
        const meta: DeviceTypePollRespMetadata = {
            b: 1,
            a: [{ n: "val", t: "B" }],
        } as DeviceTypePollRespMetadata;

        const bufData = new Uint8Array([42]);
        const handler = new CustomAttrHandler();
        const result = handler.handleAttr(meta, bufData, 0);

        expect(result.length).toBe(1);
        expect(result[0]).toEqual([]); // No function, so no values pushed
    });

    test("caches compiled functions", () => {
        const meta = makeMeta(1, ["val"], "cache_test", "out.val = buf[0];");
        const handler = new CustomAttrHandler();

        const buf1 = new Uint8Array([5]);
        const buf2 = new Uint8Array([10]);

        handler.handleAttr(meta, buf1, 0);
        handler.handleAttr(meta, buf2, 0);

        // Both calls should work correctly (second uses cached function)
        const result = handler.handleAttr(meta, new Uint8Array([15]), 0);
        expect(result[0]).toEqual([15]);
    });

    test("returns empty array when buffer too short", () => {
        const meta = makeMeta(10, ["val"], "test_short", "out.val = buf[0];");
        const handler = new CustomAttrHandler();
        const bufData = new Uint8Array([1, 2, 3]); // only 3 bytes, need 10

        const result = handler.handleAttr(meta, bufData, 0);
        expect(result).toEqual([]);
    });

    test("msgBufIdx offsets into the message buffer", () => {
        // The handler slices from msgBufIdx, so buf[0] should be the byte at that offset
        const meta = makeMeta(3, ["oxygen"], "gravity_o2_calc", PSEUDOCODE.gravity_o2_calc);
        const handler = new CustomAttrHandler();

        const fullBuf = new Uint8Array([0xFF, 0xFF, 10, 5, 25, 0xFF]); // data at offset 2
        const result = handler.handleAttr(meta, fullBuf, 2);

        const expected = (20.9 / 120.0) * (10 + 5 / 10.0 + 25 / 100.0);
        expect(result[0][0]).toBeCloseTo(expected, 10);
    });
});
