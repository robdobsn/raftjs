// The flasher's reading of a Raft build: flasher_args.json, the partition table, the app's description, which image
// is which and the modes; and its MD5

import { createHash } from "crypto";
import { buildFromFolder, chipFamilyName, imagesForMode, parseAppDescription, parsePartitionTable, partitionSubtypeName, PickedFile } from "./flashImage";
import { md5Hex } from "./md5";

function partitionEntry(name: string, type: number, subtype: number, offset: number, size: number): number[] {
    const e = new Uint8Array(32);
    const v = new DataView(e.buffer);
    e[0] = 0xaa; e[1] = 0x50; e[2] = type; e[3] = subtype;
    v.setUint32(4, offset, true);
    v.setUint32(8, size, true);
    e.set(new TextEncoder().encode(name), 12);
    return Array.from(e);
}

const table = new Uint8Array([...partitionEntry("nvs", 1, 2, 0x9000, 0x6000), ...partitionEntry("otadata", 1, 0, 0xf000, 0x2000),
    ...partitionEntry("app0", 0, 0x10, 0x20000, 0x100000), ...partitionEntry("fs", 1, 0x83, 0x120000, 0x10000), ...new Array(32).fill(0xff)]);

function appImage(project: string, version: string, size = 1024): Uint8Array {
    const img = new Uint8Array(size);
    const v = new DataView(img.buffer);
    img[0] = 0xe9;
    v.setUint32(32, 0xabcd5432, true);
    img.set(new TextEncoder().encode(version), 32 + 16);
    img.set(new TextEncoder().encode(project), 32 + 48);
    img.set(new TextEncoder().encode("12:00:00"), 32 + 80);
    img.set(new TextEncoder().encode("Oct 25 2026"), 32 + 96);
    img.set(new TextEncoder().encode("v5.5.2"), 32 + 112);
    return img;
}

const flasherArgs = (extra: Record<string, string> = {}) => new TextEncoder().encode(JSON.stringify({
    flash_settings: { flash_mode: "dio", flash_size: "16MB", flash_freq: "80m" },
    flash_files: { "0x0": "bootloader/bootloader.bin", "0x8000": "partition_table/partition-table.bin", "0x20000": "Main.bin", "0x120000": "fs.bin", ...extra },
    bootloader: { offset: "0x0" }, app: { offset: "0x20000" }, extra_esptool_args: { chip: "esp32s3" },
}));

function files(fsSize = 0x8000): PickedFile[] {
    return [
        { path: "Main/flasher_args.json", data: flasherArgs() },
        { path: "Main/bootloader/bootloader.bin", data: new Uint8Array(100) },
        { path: "Main/partition_table/partition-table.bin", data: table },
        { path: "Main/Main.bin", data: appImage("myapp", "1.2.3") },
        { path: "Main/fs.bin", data: new Uint8Array(fsSize) },
    ];
}

describe("reading a Raft build", () => {
    test("partition table and app description", () => {
        const parts = parsePartitionTable(table);
        expect(parts.map((p) => [p.name, partitionSubtypeName(p), p.offset, p.size])).toEqual([
            ["nvs", "nvs", 0x9000, 0x6000], ["otadata", "ota", 0xf000, 0x2000], ["app0", "ota_0", 0x20000, 0x100000], ["fs", "littlefs", 0x120000, 0x10000]]);
        expect(parseAppDescription(appImage("myapp", "1.2.3"))).toEqual({ projectName: "myapp", version: "1.2.3", time: "12:00:00", date: "Oct 25 2026", idfVersion: "v5.5.2" });
        expect(parseAppDescription(new Uint8Array(400))).toBeUndefined();
    });

    test("a build folder: roles, partitions, modes", () => {
        const build = buildFromFolder(files());
        expect(build.name).toBe("Main");
        expect(build.chip).toBe("esp32s3");
        expect(build.settings).toEqual({ flashMode: "dio", flashSize: "16MB", flashFreq: "80m" });
        expect(build.images.map((i) => [i.path, i.role, i.partition?.name])).toEqual([
            ["bootloader/bootloader.bin", "bootloader", undefined], ["partition_table/partition-table.bin", "partitionTable", undefined],
            ["Main.bin", "app", "app0"], ["fs.bin", "fs", "fs"]]);
        expect(build.app?.projectName).toBe("myapp");
        expect(build.problems).toEqual([]);
        expect(imagesForMode(build, "firmware").map((i) => i.role)).toEqual(["bootloader", "partitionTable", "app"]);
        expect(imagesForMode(build, "fs").map((i) => i.role)).toEqual(["fs"]);
        expect(imagesForMode(build, "all").length).toBe(4);
    });

    test("files picked by name, an image too big for its partition, a missing file", () => {
        const byName = files(0x20000).map((f) => ({ ...f, path: f.path.slice(f.path.lastIndexOf("/") + 1) }));
        const build = buildFromFolder(byName);
        expect(build.images.length).toBe(4);
        expect(build.name).toBe("myapp");
        expect(build.problems).toEqual(["fs.bin (131072 bytes) is larger than its partition fs (65536 bytes)"]);
        const missing = buildFromFolder(files().filter((f) => !f.path.endsWith("fs.bin")));
        expect(missing.problems).toEqual(["Not found among the files picked: fs.bin"]);
        expect(() => buildFromFolder([])).toThrow("No flasher_args.json");
    });

    test("chip names", () => {
        expect(chipFamilyName("esp32s3")).toBe("ESP32-S3");
        expect(chipFamilyName("ESP32-S3")).toBe("ESP32-S3");
        expect(chipFamilyName("esp32")).toBe("ESP32");
        expect(chipFamilyName("ESP32-C6 (QFN40) (revision v0.1)")).toBe("ESP32-C6");
    });
});

describe("MD5", () => {
    test.each([0, 1, 55, 56, 63, 64, 65, 1000, 100000])("%d bytes", (n) => {
        const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
        expect(md5Hex(data)).toBe(createHash("md5").update(data).digest("hex"));
    });
});
