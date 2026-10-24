/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeJson
// Part of RaftJS
//
// JSON for device type records as RaftCore's Python tools read and write it, so a type file built here is byte for
// byte the one AssembleDeviceTypes.py builds (and the device's CRC of it agrees):
// - objects keep their keys in the order written (JSON.parse moves integer-like keys such as "26" ahead of "12.5"),
//   and a repeated key keeps its first place with its last value (as Python's OrderedDict);
// - numbers keep the text they were written with; they are written as Python writes them (an integer as an
//   integer, other numbers as Python's float repr - 16.0, 1.25e-07, 1e+16);
// - strings are written with every character outside printable ASCII escaped (Python's ensure_ascii).
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// A number as written in the JSON text
export class DevTypeJsonNumber {
    constructor(public readonly text: string) {}
    get value(): number {
        return Number(this.text);
    }
    // Python reads a number with no fraction or exponent as an int, any other as a float
    get isInteger(): boolean {
        return /^-?\d+$/.test(this.text);
    }
}

export type DevTypeJson = null | boolean | string | DevTypeJsonNumber | DevTypeJson[] | DevTypeJsonObject;
export type DevTypeJsonObject = Map<string, DevTypeJson>;

export class DevTypeJsonError extends Error {}

export function isDevTypeJsonObject(value: DevTypeJson | undefined): value is DevTypeJsonObject {
    return value instanceof Map;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Parsing
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function parseDevTypeJson(text: string): DevTypeJson {
    let pos = 0;
    const fail = (what: string): never => {
        throw new DevTypeJsonError(`${what} at ${pos}`);
    };
    const skipSpace = () => {
        while (pos < text.length && " \t\n\r".includes(text[pos]))
            pos++;
    };
    const parseString = (): string => {
        const start = pos;
        pos++;
        while (pos < text.length && text[pos] !== '"') {
            if (text[pos] === "\\")
                pos++;
            pos++;
        }
        if (pos >= text.length)
            fail("unterminated string");
        pos++;
        try {
            return JSON.parse(text.slice(start, pos)) as string;
        } catch {
            pos = start;
            return fail("invalid string");
        }
    };
    const parseValue = (): DevTypeJson => {
        skipSpace();
        const c = text[pos];
        if (c === "{") {
            pos++;
            const obj: DevTypeJsonObject = new Map();
            skipSpace();
            if (text[pos] === "}") {
                pos++;
                return obj;
            }
            for (;;) {
                skipSpace();
                if (text[pos] !== '"')
                    fail("expected a key");
                const key = parseString();
                skipSpace();
                if (text[pos] !== ":")
                    fail("expected ':'");
                pos++;
                obj.set(key, parseValue());
                skipSpace();
                if (text[pos] === ",") {
                    pos++;
                    continue;
                }
                if (text[pos] === "}") {
                    pos++;
                    return obj;
                }
                fail("expected ',' or '}'");
            }
        }
        if (c === "[") {
            pos++;
            const arr: DevTypeJson[] = [];
            skipSpace();
            if (text[pos] === "]") {
                pos++;
                return arr;
            }
            for (;;) {
                arr.push(parseValue());
                skipSpace();
                if (text[pos] === ",") {
                    pos++;
                    continue;
                }
                if (text[pos] === "]") {
                    pos++;
                    return arr;
                }
                fail("expected ',' or ']'");
            }
        }
        if (c === '"')
            return parseString();
        const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(text.slice(pos, pos + 400));
        if (!literal)
            return fail("unexpected character");
        pos += literal[0].length;
        if (literal[0] === "true")
            return true;
        if (literal[0] === "false")
            return false;
        if (literal[0] === "null")
            return null;
        return new DevTypeJsonNumber(literal[0]);
    };
    const value = parseValue();
    skipSpace();
    if (pos < text.length)
        fail("unexpected text after the JSON value");
    return value;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Writing (as Python's json.dumps)
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Python's repr of a float: the shortest digits that read back as the same number, in fixed notation for decimal
// exponents from -4 to 15 (with ".0" if there is no fraction), otherwise as d.ddde+XX
export function pythonFloatRepr(value: number): string {
    if (Number.isNaN(value))
        return "NaN";
    if (!Number.isFinite(value))
        return value > 0 ? "Infinity" : "-Infinity";
    if (value === 0)
        return Object.is(value, -0) ? "-0.0" : "0.0";
    const [mantissa, expText] = value.toExponential().split("e");
    const negative = mantissa.startsWith("-");
    const digits = mantissa.replace("-", "").replace(".", "");
    const exp = parseInt(expText, 10);
    let out: string;
    if (exp >= -4 && exp < 16) {
        if (exp >= 0) {
            const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
            out = intPart + "." + (digits.slice(exp + 1) || "0");
        } else {
            out = "0." + "0".repeat(-exp - 1) + digits;
        }
    } else {
        const absExp = Math.abs(exp);
        out = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") +
            (absExp < 10 ? "0" : "") + absExp;
    }
    return (negative ? "-" : "") + out;
}

function numberText(num: DevTypeJsonNumber): string {
    if (num.isInteger) {
        // Python's int: "-0" is 0; leading zeros aren't valid JSON
        return /^-0+$/.test(num.text) ? "0" : num.text;
    }
    return pythonFloatRepr(num.value);
}

// A string as Python's json.dumps writes it with ensure_ascii (the default)
export function pythonJsonString(value: string): string {
    let out = '"';
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 0x22) out += '\\"';
        else if (c === 0x5c) out += "\\\\";
        else if (c === 0x0a) out += "\\n";
        else if (c === 0x0d) out += "\\r";
        else if (c === 0x09) out += "\\t";
        else if (c === 0x08) out += "\\b";
        else if (c === 0x0c) out += "\\f";
        else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
        else out += value[i];
    }
    return out + '"';
}

// Strings in code point order (UTF-8 byte order), as Python sorts them
export function compareCodePoints(a: string, b: string): number {
    const ai = a[Symbol.iterator]();
    const bi = b[Symbol.iterator]();
    for (;;) {
        const an = ai.next();
        const bn = bi.next();
        if (an.done || bn.done)
            return an.done ? (bn.done ? 0 : -1) : 1;
        const diff = (an.value.codePointAt(0) ?? 0) - (bn.value.codePointAt(0) ?? 0);
        if (diff !== 0)
            return diff;
    }
}

export interface DevTypeJsonWriteOptions {
    sortKeys?: boolean;     // as json.dumps(sort_keys=True)
    indent?: number;        // as json.dumps(indent=n) (members on lines of their own, ": " after keys)
}

// The value as Python's json.dumps writes it: by default json.dumps(value, separators=(",", ":"))
export function writeDevTypeJson(value: DevTypeJson, options: DevTypeJsonWriteOptions = {}, level = 0): string {
    if (value === null)
        return "null";
    if (value === true)
        return "true";
    if (value === false)
        return "false";
    if (typeof value === "string")
        return pythonJsonString(value);
    if (value instanceof DevTypeJsonNumber)
        return numberText(value);
    const indent = options.indent;
    const open = indent === undefined ? "" : "\n" + " ".repeat(indent * (level + 1));
    const close = indent === undefined ? "" : "\n" + " ".repeat(indent * level);
    const sep = indent === undefined ? ":" : ": ";
    if (Array.isArray(value)) {
        if (value.length === 0)
            return "[]";
        return "[" + open + value.map((v) => writeDevTypeJson(v, options, level + 1)).join("," + open) + close + "]";
    }
    if (value.size === 0)
        return "{}";
    const keys = Array.from(value.keys());
    if (options.sortKeys)
        keys.sort(compareCodePoints);
    return "{" + open + keys.map((k) => pythonJsonString(k) + sep + writeDevTypeJson(value.get(k) as DevTypeJson, options, level + 1))
        .join("," + open) + close + "}";
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Plain JavaScript values
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// A plain value (e.g. from JSON.parse - a record from a device response). Integers become Python ints
export function devTypeJsonFromPlain(value: unknown): DevTypeJson {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "boolean" || typeof value === "string")
        return value;
    if (typeof value === "number") {
        if (Number.isInteger(value) && Math.abs(value) < 1e21)
            return new DevTypeJsonNumber(value.toFixed(0));
        return new DevTypeJsonNumber(String(value));
    }
    if (value instanceof DevTypeJsonNumber || value instanceof Map)
        return value as DevTypeJson;
    if (Array.isArray(value))
        return value.map(devTypeJsonFromPlain);
    const obj: DevTypeJsonObject = new Map();
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
        obj.set(k, devTypeJsonFromPlain(v));
    return obj;
}

// A plain value for display or for code that reads records as objects (integer-like keys lose their order)
export function devTypeJsonToPlain(value: DevTypeJson): unknown {
    if (value instanceof DevTypeJsonNumber)
        return value.value;
    if (Array.isArray(value))
        return value.map(devTypeJsonToPlain);
    if (value instanceof Map) {
        const out: Record<string, unknown> = {};
        value.forEach((v, k) => { out[k] = devTypeJsonToPlain(v); });
        return out;
    }
    return value;
}

// A deep copy
export function cloneDevTypeJson(value: DevTypeJson): DevTypeJson {
    if (Array.isArray(value))
        return value.map(cloneDevTypeJson);
    if (value instanceof Map) {
        const out: DevTypeJsonObject = new Map();
        value.forEach((v, k) => out.set(k, cloneDevTypeJson(v)));
        return out;
    }
    return value;
}

// The member at a path of object keys, or undefined
export function devTypeJsonGet(value: DevTypeJson | undefined, ...path: string[]): DevTypeJson | undefined {
    let current = value;
    for (const key of path) {
        if (!(current instanceof Map))
            return undefined;
        current = current.get(key);
    }
    return current;
}
