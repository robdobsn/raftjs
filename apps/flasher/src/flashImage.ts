// What a Raft build flashes and where: flasher_args.json (as raft flash reads it), the partition table, the app's
// description, and which image is which (bootloader, partition table, app, file system) - and the same from an ESP
// Web Tools manifest for builds published on the web

export type ImageRole = "bootloader" | "partitionTable" | "app" | "fs" | "other";

export interface FlashImage {
    path: string;
    offset: number;
    data: Uint8Array;
    role: ImageRole;
    partition?: Partition;          // the partition it is written to (app and fs)
}

export interface Partition {
    name: string;
    type: number;                   // 0 app, 1 data
    subtype: number;
    offset: number;
    size: number;
}

export interface AppDescription {
    projectName: string;
    version: string;
    idfVersion: string;
    date: string;
    time: string;
}

export interface FlashSettings {
    flashMode?: string;
    flashSize?: string;
    flashFreq?: string;
}

export interface FlashBuild {
    name: string;                   // the build (SysType) name
    chip?: string;                  // e.g. "esp32s3"
    settings: FlashSettings;
    images: FlashImage[];
    partitions: Partition[];
    app?: AppDescription;
    problems: string[];             // e.g. an image larger than its partition
}

// A file the user picked (relative path within the picked folder, or its name) or one fetched
export interface PickedFile {
    path: string;
    data: Uint8Array;
}

export const PARTITION_TYPE_NAMES: Record<number, string> = { 0: "app", 1: "data" };
const APP_SUBTYPES: Record<number, string> = { 0x00: "factory", 0x20: "test" };
const DATA_SUBTYPES: Record<number, string> = { 0x00: "ota", 0x01: "phy", 0x02: "nvs", 0x03: "coredump", 0x04: "nvs_keys",
    0x05: "efuse", 0x06: "undefined", 0x80: "esphttpd", 0x81: "fat", 0x82: "spiffs", 0x83: "littlefs" };
const FS_SUBTYPES = new Set([0x81, 0x82, 0x83]);

export function partitionSubtypeName(p: Partition): string {
    if (p.type === 0)
        return p.subtype >= 0x10 && p.subtype < 0x20 ? `ota_${p.subtype - 0x10}` : APP_SUBTYPES[p.subtype] ?? `0x${p.subtype.toString(16)}`;
    return DATA_SUBTYPES[p.subtype] ?? `0x${p.subtype.toString(16)}`;
}

export function isFileSystemPartition(p: Partition): boolean {
    return p.type === 1 && FS_SUBTYPES.has(p.subtype);
}

// The partition table (partition-table.bin): 32-byte entries starting 0xAA 0x50, ended by 0xFF bytes or the MD5 entry
export function parsePartitionTable(data: Uint8Array): Partition[] {
    const out: Partition[] = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let pos = 0; pos + 32 <= data.length; pos += 32) {
        if (data[pos] !== 0xaa || data[pos + 1] !== 0x50)
            break;
        const nameBytes = data.subarray(pos + 12, pos + 28);
        const end = nameBytes.indexOf(0);
        out.push({
            type: data[pos + 2],
            subtype: data[pos + 3],
            offset: view.getUint32(pos + 4, true),
            size: view.getUint32(pos + 8, true),
            name: new TextDecoder().decode(end >= 0 ? nameBytes.subarray(0, end) : nameBytes),
        });
    }
    return out;
}

function cString(data: Uint8Array, start: number, len: number): string {
    const bytes = data.subarray(start, start + len);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
}

// The app's description (esp_app_desc_t) from an app image: the image header (24 bytes) and first segment header
// (8 bytes), then the description, starting with its magic word
export function parseAppDescription(data: Uint8Array): AppDescription | undefined {
    if (data.length < 32 + 256 || data[0] !== 0xe9)
        return undefined;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const d = 32;
    if (view.getUint32(d, true) !== 0xabcd5432)
        return undefined;
    return {
        version: cString(data, d + 16, 32),
        projectName: cString(data, d + 48, 32),
        time: cString(data, d + 80, 16),
        date: cString(data, d + 96, 16),
        idfVersion: cString(data, d + 112, 32),
    };
}

export function parseOffset(value: string | number): number {
    const n = typeof value === "number" ? value : value.trim().toLowerCase().startsWith("0x") ? parseInt(value, 16) : parseInt(value, 10);
    if (!Number.isFinite(n) || n < 0)
        throw new Error(`bad offset "${value}"`);
    return n;
}

export function hex(n: number): string {
    return "0x" + n.toString(16);
}

// The file a build refers to, among the files picked: by its path (relative to the build folder) or else its name
function findFile(files: PickedFile[], rel: string): PickedFile | undefined {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const target = norm(rel);
    const byPath = files.find((f) => norm(f.path) === target || norm(f.path).endsWith("/" + target));
    if (byPath)
        return byPath;
    const base = target.slice(target.lastIndexOf("/") + 1);
    const byName = files.filter((f) => norm(f.path).slice(norm(f.path).lastIndexOf("/") + 1) === base);
    return byName.length === 1 ? byName[0] : undefined;
}

// Roles and partitions of the images, and the checks: each image within its partition, nothing overlapping
function finishBuild(build: FlashBuild, knownOffsets: Partial<Record<ImageRole, number>>) {
    const table = build.images.find((i) => i.role === "partitionTable" || i.offset === 0x8000);
    if (table) {
        table.role = "partitionTable";
        try {
            build.partitions = parsePartitionTable(table.data);
        } catch {
            build.problems.push("The partition table couldn't be read");
        }
    }
    for (const image of build.images) {
        const partition = build.partitions.find((p) => p.offset === image.offset);
        if (image.role === "other") {
            if (image.offset === knownOffsets.bootloader || (image.offset < 0x8000 && image.path.includes("bootloader")))
                image.role = "bootloader";
            else if (image.offset === knownOffsets.app || (partition && partition.type === 0))
                image.role = "app";
            else if (partition && isFileSystemPartition(partition))
                image.role = "fs";
            else if (!partition && /(^|\/)(fs|spiffs|littlefs|fatfs|storage|fs_image)[^/]*\.bin$/i.test(image.path))
                image.role = "fs";
        }
        if (partition) {
            image.partition = partition;
            if (image.data.length > partition.size)
                build.problems.push(`${image.path} (${image.data.length} bytes) is larger than its partition ${partition.name} (${partition.size} bytes)`);
        }
    }
    const sorted = [...build.images].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1].offset + sorted[i - 1].data.length > sorted[i].offset)
            build.problems.push(`${sorted[i - 1].path} overlaps ${sorted[i].path}`);
    }
    const app = build.images.find((i) => i.role === "app");
    if (app)
        build.app = parseAppDescription(app.data);
}

// A Raft (ESP-IDF) build from its folder: flasher_args.json says what goes where, as raft flash reads it
export function buildFromFolder(files: PickedFile[]): FlashBuild {
    const argsFile = findFile(files, "flasher_args.json");
    if (!argsFile)
        throw new Error("No flasher_args.json - pick the build folder (build/<SysType>), or its flasher_args.json and the .bin files");
    const args = JSON.parse(new TextDecoder().decode(argsFile.data)) as {
        flash_settings?: { flash_mode?: string; flash_size?: string; flash_freq?: string };
        flash_files?: Record<string, string>;
        extra_esptool_args?: { chip?: string };
        bootloader?: { offset?: string }; app?: { offset?: string; file?: string };
    };
    const argsDir = argsFile.path.includes("/") ? argsFile.path.slice(0, argsFile.path.lastIndexOf("/")) : "";
    const build: FlashBuild = {
        name: argsDir.slice(argsDir.lastIndexOf("/") + 1) || "build",
        chip: args.extra_esptool_args?.chip,
        settings: { flashMode: args.flash_settings?.flash_mode, flashSize: args.flash_settings?.flash_size, flashFreq: args.flash_settings?.flash_freq },
        images: [], partitions: [], problems: [],
    };
    const missing: string[] = [];
    for (const [offset, rel] of Object.entries(args.flash_files ?? {})) {
        const file = findFile(files, argsDir ? `${argsDir}/${rel}` : rel) ?? findFile(files, rel);
        if (!file) {
            missing.push(rel);
            continue;
        }
        build.images.push({ path: rel, offset: parseOffset(offset), data: file.data, role: "other" });
    }
    if (missing.length)
        build.problems.push(`Not found among the files picked: ${missing.join(", ")}`);
    finishBuild(build, {
        bootloader: args.bootloader?.offset !== undefined ? parseOffset(args.bootloader.offset) : undefined,
        app: args.app?.offset !== undefined ? parseOffset(args.app.offset) : undefined,
    });
    // Files picked without their folder: the app's project name (the SysType's, in a Raft build)
    if (!argsDir && build.app?.projectName)
        build.name = build.app.projectName;
    return build;
}

// An ESP Web Tools manifest ({"name", "version", "builds": [{"chipFamily", "parts": [{"path", "offset"}]}]}): the
// build for a chip, its parts fetched relative to the manifest
export interface WebToolsManifest {
    name?: string;
    version?: string;
    builds?: Array<{ chipFamily: string; parts: Array<{ path: string; offset: number | string }> }>;
}

export function chipFamilyName(chip: string): string {
    // "esp32s3" / "ESP32-S3" -> "ESP32-S3"
    const m = /^esp32[-_]?([a-z]\d+)?/i.exec(chip.trim());
    return m ? "ESP32" + (m[1] ? "-" + m[1].toUpperCase() : "") : chip.toUpperCase();
}

export async function buildFromManifest(manifestUrl: string, chipFamily: string | undefined,
                                        fetchFn: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<FlashBuild> {
    const resp = await fetchFn(manifestUrl);
    if (!resp.ok)
        throw new Error(`${manifestUrl} gave HTTP ${resp.status}`);
    const manifest = await resp.json() as WebToolsManifest;
    const builds = manifest.builds ?? [];
    const chosen = chipFamily ? builds.find((b) => chipFamilyName(b.chipFamily) === chipFamilyName(chipFamily)) : builds[0];
    if (!chosen)
        throw new Error(`The manifest has no build for ${chipFamily ?? "any chip"} (it has ${builds.map((b) => b.chipFamily).join(", ") || "none"})`);
    const build: FlashBuild = { name: [manifest.name, manifest.version].filter(Boolean).join(" ") || "manifest",
        chip: chosen.chipFamily, settings: {}, images: [], partitions: [], problems: [] };
    for (const part of chosen.parts) {
        const url = new URL(part.path, new URL(manifestUrl, location.href)).toString();
        const partResp = await fetchFn(url);
        if (!partResp.ok)
            throw new Error(`${url} gave HTTP ${partResp.status}`);
        build.images.push({ path: part.path, offset: parseOffset(part.offset), data: new Uint8Array(await partResp.arrayBuffer()), role: "other" });
    }
    finishBuild(build, {});
    return build;
}

export type FlashMode = "all" | "firmware" | "fs";

// The images a mode writes: everything; the firmware only (keeping the file system, as raft flash --no-fs); or the
// file system only
export function imagesForMode(build: FlashBuild, mode: FlashMode): FlashImage[] {
    if (mode === "firmware")
        return build.images.filter((i) => i.role !== "fs");
    if (mode === "fs")
        return build.images.filter((i) => i.role === "fs");
    return build.images;
}
