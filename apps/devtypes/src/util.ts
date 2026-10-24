// Small helpers: a zip file (stored, not compressed - the files are small JSON), I2C address ranges, downloads

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++)
        crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// A zip of text files (paths with "/" for folders)
export function makeZip(files: Array<{ path: string; text: string }>): Uint8Array {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
        const name = encoder.encode(file.path);
        const data = encoder.encode(file.text);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);           // UTF-8 names
        local.setUint16(8, 0, true);                // stored
        local.setUint16(10, dosTime, true);
        local.setUint16(12, dosDate, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        chunks.push(new Uint8Array(local.buffer), name, data);
        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);
        entry.setUint16(4, 20, true);
        entry.setUint16(6, 20, true);
        entry.setUint16(8, 0x0800, true);
        entry.setUint16(10, 0, true);
        entry.setUint16(12, dosTime, true);
        entry.setUint16(14, dosDate, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, data.length, true);
        entry.setUint32(24, data.length, true);
        entry.setUint16(28, name.length, true);
        entry.setUint32(42, offset, true);
        central.push(new Uint8Array(entry.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let pos = 0;
    for (const c of all) {
        out.set(c, pos);
        pos += c.length;
    }
    return out;
}

// The I2C addresses of a record's "addresses" ("0x18-0x1f,0x53")
export function parseAddresses(spec: string | undefined): number[] {
    const out: number[] = [];
    for (const part of (spec ?? "").split(",")) {
        const m = /^\s*0x([0-9a-f]+)\s*(?:-\s*0x([0-9a-f]+))?\s*$/i.exec(part);
        if (!m)
            continue;
        const from = parseInt(m[1], 16);
        const to = m[2] ? parseInt(m[2], 16) : from;
        for (let a = from; a <= to && a - from < 256; a++)
            out.push(a);
    }
    return out;
}

export function hex2(n: number): string {
    return "0x" + n.toString(16).padStart(2, "0");
}

export function download(name: string, data: string | Uint8Array, type = "application/json") {
    const blob = new Blob([data as BlobPart], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "systypes/Main" + "../../devtypes" -> "devtypes"
export function joinPath(base: string, rel: string): string {
    const parts = rel.startsWith("/") ? [] : base.split("/").filter(Boolean);
    for (const p of rel.split("/")) {
        if (p === "" || p === ".")
            continue;
        if (p === "..")
            parts.pop();
        else
            parts.push(p);
    }
    return parts.join("/");
}

export function readStore<T>(key: string, fallback: T): T {
    try {
        const text = localStorage.getItem(key);
        return text ? (JSON.parse(text) as T) : fallback;
    } catch {
        return fallback;
    }
}

export function writeStore(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // storage unavailable (private window) - the app works without it
    }
}
