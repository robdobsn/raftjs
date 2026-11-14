// HDLC (RICSerial) and OverAscii (serial console) framing against the shared vectors made from the firmware's own
// MiniHDLC and ProtocolOverAscii (RaftCore scripts/tests/hdlc_vectors.json and overascii_vectors.json, copied into
// testdata/ - after a change there, copy them again). raftpy is tested against the same files.

import * as fs from "fs";
import * as path from "path";
import RaftMiniHDLC from "./RaftMiniHDLC";
import RaftChannelWebSerial from "./RaftChannelWebSerial";
import RaftMsgHandler from "./RaftMsgHandler";
import RaftLog from "./RaftLog";

type HdlcVectors = {
    defaultMaxLen: number;
    crc: { desc: string; data: string; crc: string }[];
    encode: { desc: string; payload: string; encoded: string }[];
    decode: { desc: string; stream: string; maxLen?: number; frames: string[] }[];
};
type OverAsciiVectors = {
    encode: { desc: string; data: string; encoded: string }[];
    console: { desc: string; stream: string; text: string; frames: string[] }[];
};

function load<T>(name: string): T {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testdata", name), "utf-8")) as T;
}
const hdlcVectors = load<HdlcVectors>("hdlc_vectors.json");
const overAsciiVectors = load<OverAsciiVectors>("overascii_vectors.json");

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function decodeFrames(stream: Uint8Array, byteAtATime: boolean): string[] {
    const frames: string[] = [];
    const hdlc = new RaftMiniHDLC();
    hdlc.setOnRxFrame((frame) => frames.push(toHex(frame)));
    if (byteAtATime) stream.forEach((b) => hdlc.addRxByte(b));
    else hdlc.addRxBytes(stream);
    return frames;
}

describe("HDLC vectors", () => {
    test.each(hdlcVectors.crc.map((c) => [c.desc, c] as const))("crc: %s", (_desc, c) => {
        expect(RaftMiniHDLC.crc16(fromHex(c.data)).toString(16).padStart(4, "0")).toBe(c.crc);
    });

    test.each(hdlcVectors.encode.map((c) => [c.desc, c] as const))("encode: %s", (_desc, c) => {
        expect(toHex(new RaftMiniHDLC().encode(fromHex(c.payload)))).toBe(c.encoded);
        expect(decodeFrames(fromHex(c.encoded), false)).toEqual([c.payload]);
    });

    // raftjs has no frame length limit, so the cases that test the firmware's limit (maxLen) don't apply
    const decodeCases = hdlcVectors.decode.filter((c) => c.maxLen === undefined);
    test.each(decodeCases.map((c) => [c.desc, c] as const))("decode: %s", (_desc, c) => {
        expect(decodeFrames(fromHex(c.stream), false)).toEqual(c.frames);
        expect(decodeFrames(fromHex(c.stream), true)).toEqual(c.frames);
    });
});

describe("OverAscii vectors (RaftChannelWebSerial)", () => {
    type WebSerialPrivate = {
        _overasciiEncode(data: Uint8Array): Uint8Array;
        _onMsgRx(msg: Uint8Array | null): void;
        _serialBuffer: number[];
    };

    test.each(overAsciiVectors.encode.map((c) => [c.desc, c] as const))("encode: %s", (_desc, c) => {
        const channel = new RaftChannelWebSerial() as unknown as WebSerialPrivate;
        expect(toHex(Uint8Array.from(channel._overasciiEncode(fromHex(c.data))))).toBe(c.encoded);
    });

    test.each(overAsciiVectors.console.map((c) => [c.desc, c] as const))("console: %s", (_desc, c) => {
        const channel = new RaftChannelWebSerial();
        const frames: string[] = [];
        const hdlc = new RaftMiniHDLC();
        hdlc.setOnRxFrame((frame) => frames.push(toHex(frame)));
        channel.setMsgHandler({ handleNewRxMsg: (bytes: Uint8Array) => hdlc.addRxBytes(bytes) } as unknown as RaftMsgHandler);
        const lines: string[] = [];
        const spy = jest.spyOn(RaftLog, "debug").mockImplementation((msg: string) => { lines.push(msg); });
        try {
            // Received in two chunks, split in the middle, to cover state carried between chunks
            const stream = fromHex(c.stream);
            const priv = channel as unknown as WebSerialPrivate;
            const mid = Math.floor(stream.length / 2);
            priv._onMsgRx(stream.slice(0, mid));
            priv._onMsgRx(stream.slice(mid));
            const remaining = new TextDecoder().decode(Uint8Array.from(priv._serialBuffer));
            expect(lines.map((l) => l + "\n").join("") + remaining).toBe(c.text);
        } finally {
            spy.mockRestore();
        }
        expect(frames).toEqual(c.frames);
    });
});
