/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeGrammar
// Part of RaftJS
//
// Device type record command grammar: a TypeScript copy of RaftCore's DeviceTypeGrammar.cpp (and its Python copy,
// scripts/DeviceTypeGrammar.py), checked against the same vectors (scripts/tests/grammar_vectors.json).
//
// detectionValues, initValues and pollInfo.c share one syntax, with a different meaning for the value side of a
// step in each. A string is steps separated by "&" or ";"; each step is "write[=value]". compile() gives the steps
// and the issues (errors and warnings) the firmware finds.
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type DeviceTypeGrammarField = "detection" | "init" | "poll";

export const DEVICE_TYPE_GRAMMAR_ERRORS = ["NotHex", "MultipleEquals", "BadCheck", "BadReadExpr", "ReadExprNotAllowed",
    "BadReadLength", "BadValue", "CrcLength", "BadPause", "BadPlaceholder"] as const;
export const DEVICE_TYPE_GRAMMAR_WARNINGS = ["OddHex", "BarePause", "InitValueNotWritten", "InitBinaryIsReadCount",
    "InitValueIgnored", "MixedCheckLengths", "BinaryNotWholeBytes"] as const;
export const DEVICE_TYPE_GRAMMAR_FIELD_NAMES: Record<DeviceTypeGrammarField, string> =
    { detection: "detectionValues", init: "initValues", poll: "pollInfo.c" };

export function isDeviceTypeGrammarError(code: string): boolean {
    return (DEVICE_TYPE_GRAMMAR_ERRORS as readonly string[]).includes(code);
}

const HEX_DIGITS = "0123456789abcdefABCDEF";
const WHITESPACE = " \t\n\v\f\r";

export class DeviceTypeGrammarStep {
    write: number[] = [];
    read = 0;
    pause = 0;
    hasValue = false;
    checks: Array<{ mask: number[]; value: number[] }> = [];
    crc8w = false;
    expr = false;               // read length is an r{...} expression
    slots: Array<{ offset: number; name: string }> = [];    // init: {name} value slots in the write data
    guard = "";                 // init: {?name} - the step is only done if that computed value isn't 0
}

export interface DeviceTypeGrammarIssue {
    code: string;
    pos: number;
}

export class DeviceTypeGrammarResult {
    steps: DeviceTypeGrammarStep[] = [];
    issues: DeviceTypeGrammarIssue[] = [];
    hasErrors(): boolean {
        return this.issues.some((issue) => isDeviceTypeGrammarError(issue.code));
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// C library behaviour the C++ relies on
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isSpace = (c: string | undefined) => c !== undefined && c !== "" && WHITESPACE.includes(c);
const isAsciiAlpha = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);
const isAsciiAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);

// strtol/strtoul: skip whitespace, optional sign, digits (base 16 allows 0x). Returns [value, end]; end is pos if
// there are no digits
function strtol(s: string, pos = 0, base = 10): [number, number] {
    let i = pos;
    while (i < s.length && isSpace(s[i]))
        i++;
    let sign = 1;
    if (i < s.length && (s[i] === "+" || s[i] === "-")) {
        sign = s[i] === "-" ? -1 : 1;
        i++;
    }
    if (base === 16 && s.slice(i, i + 2).toLowerCase() === "0x" && i + 2 < s.length && HEX_DIGITS.includes(s[i + 2]))
        i += 2;
    const digits = base === 10 ? "0123456789" : HEX_DIGITS;
    const start = i;
    while (i < s.length && digits.includes(s[i]))
        i++;
    if (i === start)
        return [0, pos];
    return [sign * parseInt(s.slice(start, i), base), i];
}

function firstPauseMs(lc: string): number {
    const pos = lc.indexOf("p");
    if (pos < 0)
        return 0;
    return Math.max(strtol(lc, pos + 1)[0], 0);
}

function isPauseToken(s: string): boolean {
    return s.length >= 2 && (s[0] === "p" || s[0] === "P") && /^[0-9]+$/.test(s.slice(1));
}

function hexToBytes(digits: string): number[] {
    const out = new Array<number>(Math.floor((digits.length + 1) / 2)).fill(0);
    for (let i = 0; i < digits.length - 1; i += 2)
        out[i / 2] = parseInt(digits.slice(i, i + 2), 16);
    return out;
}

// PollReadLenExpr::parse: the :max value, or null if the expression doesn't parse or has no max
function readLenExprMax(expr: string): number | null {
    let maxValue = 0xFFFFFFFF;
    let p = 0;
    const end = expr.length;
    if (p >= end || expr[p] !== "$")
        return null;
    p++;
    p = strtol(expr, p)[1];
    if (p < end && expr[p] === "[") {
        p++;
        p = strtol(expr, p)[1];
        if (p < end && expr[p] === "]")
            p++;
        else
            return null;
    }
    if (p < end && expr[p] === ".") {
        p++;
        if (p < end && (expr[p] === "w" || expr[p] === "W")) {
            p++;
            p = strtol(expr, p)[1];
        } else {
            return null;
        }
    }
    while (p < end) {
        const c = expr[p];
        if (c === ":") {
            p++;
            if (expr.startsWith("mask", p)) {
                p = strtol(expr, p + 4, 16)[1];
            } else if (expr.startsWith("max", p)) {
                const [value, next] = strtol(expr, p + 3);
                maxValue = value >>> 0;
                p = next;
            } else if (expr.startsWith("min", p)) {
                p = strtol(expr, p + 3)[1];
            } else if (expr.startsWith("align", p)) {
                p = strtol(expr, p + 5)[1];
            } else {
                return null;
            }
        } else if ("*/+-".includes(c)) {
            p = strtol(expr, p + 1)[1];
        } else if (c === "&" || c === "|") {
            p = strtol(expr, p + 1, 16)[1];
        } else if ((c === ">" || c === "<") && p + 1 < end && expr[p + 1] === c) {
            p = strtol(expr, p + 2)[1];
        } else {
            return null;
        }
    }
    return maxValue === 0xFFFFFFFF ? null : maxValue;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Compile
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Ctx {
    constructor(public result: DeviceTypeGrammarResult, public stepPos: number) {}
    issue(code: string, posInStep: number) {
        this.result.issues.push({ code, pos: this.stepPos + posInStep });
    }
}

function setPause(step: DeviceTypeGrammarStep, ms: number, ctx: Ctx, pos: number): boolean {
    if (ms > 65535) {
        ctx.issue("BadPause", pos);
        return false;
    }
    step.pause = ms;
    return true;
}

function isSlotName(name: string): boolean {
    return name.length > 0 && (isAsciiAlpha(name[0]) || name[0] === "_") &&
        Array.from(name).every((c) => isAsciiAlnum(c) || c === "_");
}

// [bytes, slots], or null if they aren't hex. In an init string the hex may contain {name} placeholders: each is one
// byte, written with the value the record's initCode computes
function parseWrite(name: string, ctx: Ctx, field: DeviceTypeGrammarField): [number[], Array<{ offset: number; name: string }>] | null {
    const start = name.length >= 2 && name[0] === "0" && (name[1] === "x" || name[1] === "X") ? 2 : 0;
    const digits = name.slice(start);
    if (start === 2 && digits === "") {
        ctx.issue("NotHex", 2);
        return null;
    }
    const out: number[] = [];
    const slots: Array<{ offset: number; name: string }> = [];
    let hexRun = "";
    let i = 0;
    while (i < digits.length) {
        const c = digits[i];
        if (c === "{") {
            const end = digits.indexOf("}", i + 1);
            const slotName = end > 0 ? digits.slice(i + 1, end) : "";
            // A placeholder: only in init strings, a name, and at a byte boundary
            if (field !== "init" || end < 0 || !isSlotName(slotName) || hexRun.length % 2 !== 0) {
                ctx.issue("BadPlaceholder", start + i);
                return null;
            }
            out.push(...hexToBytes(hexRun));
            hexRun = "";
            slots.push({ offset: out.length, name: slotName });
            out.push(0);
            i = end + 1;
            continue;
        }
        if (!HEX_DIGITS.includes(c)) {
            ctx.issue("NotHex", start + i);
            return null;
        }
        hexRun += c;
        i++;
    }
    if (hexRun.length % 2 !== 0)
        ctx.issue("OddHex", 0);
    out.push(...hexToBytes(hexRun));
    return [out, slots];
}

type CheckKind = "read" | "hex" | "binary" | "pause" | null;

function parseCheckValue(lc: string, ctx: Ctx, pos: number): [CheckKind, number[], number[], number] {
    const rPos = lc.indexOf("r");
    if (rPos >= 0) {
        const length = strtol(lc, rPos + 1)[0];
        if (length <= 0 || length > 65535) {
            ctx.issue("BadReadLength", pos + rPos);
            return [null, [], [], 0];
        }
        const zeros = new Array<number>(length).fill(0);
        return ["read", zeros, zeros.slice(), length];
    }
    let idx = 0;
    while (idx < lc.length && isSpace(lc[idx]))
        idx++;
    if (idx < lc.length && lc[idx] === "p") {
        idx++;
        while (idx < lc.length && isDigit(lc[idx]))
            idx++;
        while (idx < lc.length && isSpace(lc[idx]))
            idx++;
    }
    if (lc.startsWith("0x", idx)) {
        const digits = lc.slice(idx + 2);
        for (let i = 0; i < digits.length; i++) {
            if (!HEX_DIGITS.includes(digits[i])) {
                ctx.issue("BadCheck", pos + idx + 2 + i);
                return [null, [], [], 0];
            }
        }
        if (digits.length % 2 !== 0)
            ctx.issue("OddHex", pos + idx);
        const value = hexToBytes(digits);
        return ["hex", new Array<number>(value.length).fill(0xff), value, value.length];
    }
    if (lc.startsWith("0b", idx)) {
        const bits = lc.slice(idx + 2);
        for (let i = 0; i < bits.length; i++) {
            if (!"01x".includes(bits[i])) {
                ctx.issue("BadCheck", pos + idx + 2 + i);
                return [null, [], [], 0];
            }
        }
        if (bits.length % 8 !== 0)
            ctx.issue("BinaryNotWholeBytes", pos + idx);
        const numBytes = Math.floor((bits.length + 7) / 8);
        const mask = new Array<number>(numBytes).fill(0xff);
        const value = new Array<number>(numBytes).fill(0);
        for (let i = 0; i < bits.length; i++) {
            const bit = 0x80 >> (i % 8);
            if (bits[i] === "x")
                mask[Math.floor(i / 8)] &= ~bit & 0xff;
            else if (bits[i] === "1")
                value[Math.floor(i / 8)] |= bit;
        }
        return ["binary", mask, value, numBytes];
    }
    let i = 0;
    while (i < lc.length) {
        if (lc[i] === "p") {
            while (i + 1 < lc.length && isDigit(lc[i + 1]))
                i++;
            i++;
            continue;
        }
        if (!isSpace(lc[i])) {
            ctx.issue("BadCheck", pos + i);
            return [null, [], [], 0];
        }
        i++;
    }
    return ["pause", [], [], 0];
}

function parseDetectionValue(value: string, valuePos: number, step: DeviceTypeGrammarStep, ctx: Ctx): boolean {
    let lc = value.toLowerCase();
    const suffix = ":crc8w";
    if (lc.endsWith(suffix)) {
        step.crc8w = true;
        lc = lc.slice(0, -suffix.length);
    }
    if (!setPause(step, firstPauseMs(lc), ctx, valuePos))
        return false;
    let start = 0;
    while (start < lc.length) {
        let comma = lc.indexOf(",", start);
        if (comma < 0)
            comma = lc.length;
        const [kind, mask, val] = parseCheckValue(lc.slice(start, comma), ctx, valuePos + start);
        if (kind === null)
            return false;
        if (step.checks.length > 0 && val.length !== step.checks[0].value.length)
            ctx.issue("MixedCheckLengths", valuePos + start);
        step.checks.push({ mask, value: val });
        start = comma + 1;
    }
    step.read = step.checks.length > 0 ? step.checks[0].value.length : 0;
    if (step.crc8w && (step.read === 0 || step.read % 3 !== 0)) {
        ctx.issue("CrcLength", valuePos);
        return false;
    }
    return true;
}

function parseInitValue(value: string, valuePos: number, step: DeviceTypeGrammarStep, ctx: Ctx): boolean {
    const lc = value.toLowerCase();
    if (!setPause(step, firstPauseMs(lc), ctx, valuePos))
        return false;
    if (lc === "")
        return true;
    if (lc[0] === "r") {
        step.read = Math.max(strtol(lc, 1)[0], 0) & 0xffff;
    } else if (lc.startsWith("0b")) {
        step.read = Math.floor((lc.length - 2 + 7) / 8);
        ctx.issue("InitBinaryIsReadCount", valuePos);
        return true;
    } else if (lc.startsWith("0x")) {
        ctx.issue("InitValueNotWritten", valuePos);
        return true;
    }
    let i = 0;
    let valid = true;
    if (i < lc.length && lc[i] === "r") {
        i++;
        const digitsStart = i;
        while (i < lc.length && isDigit(lc[i]))
            i++;
        valid = i > digitsStart;
    }
    if (valid && i < lc.length)
        valid = isPauseToken(lc.slice(i));
    if (!valid)
        ctx.issue("InitValueIgnored", valuePos);
    return true;
}

function parsePollValue(value: string, valuePos: number, step: DeviceTypeGrammarStep, ctx: Ctx): boolean {
    const dynStart = value.indexOf("r{");
    if (dynStart >= 0) {
        const dynEnd = value.indexOf("}", dynStart + 2);
        if (dynEnd < 0) {
            ctx.issue("BadReadExpr", valuePos + dynStart);
            return false;
        }
        const maxValue = readLenExprMax(value.slice(dynStart + 2, dynEnd));
        if (maxValue === null) {
            ctx.issue("BadReadExpr", valuePos + dynStart);
            return false;
        }
        step.expr = true;
        step.read = maxValue & 0xffff;
        return setPause(step, firstPauseMs(value.toLowerCase()), ctx, valuePos);
    }
    const lc = value.toLowerCase();
    const issuesBefore = ctx.result.issues.length;
    const [kind, , , readLen] = parseCheckValue(lc, ctx, valuePos);
    if (kind === null) {
        for (let i = issuesBefore; i < ctx.result.issues.length; i++) {
            if (ctx.result.issues[i].code === "BadCheck")
                ctx.result.issues[i] = { code: "BadValue", pos: ctx.result.issues[i].pos };
        }
        return false;
    }
    step.read = readLen & 0xffff;
    return setPause(step, firstPauseMs(lc), ctx, valuePos);
}

const STRIP_CHARS = " \t\r\n";
const lstrip = (s: string) => {
    let i = 0;
    while (i < s.length && STRIP_CHARS.includes(s[i]))
        i++;
    return s.slice(i);
};
const strip = (s: string) => {
    let end = s.length;
    while (end > 0 && STRIP_CHARS.includes(s[end - 1]))
        end--;
    return lstrip(s.slice(0, end));
};

// Compile a command string
export function compileDeviceTypeCommand(commandStr: string | undefined | null, field: DeviceTypeGrammarField): DeviceTypeGrammarResult {
    const result = new DeviceTypeGrammarResult();
    const s = commandStr ?? "";
    let startPos = 0;
    let detectionInvalid = false;
    while (startPos < s.length) {
        const sep = s.slice(startPos).search(/[&;]/);
        const endPos = sep >= 0 ? startPos + sep : s.length;
        const stepStr = s.slice(startPos, endPos);
        const ctx = new Ctx(result, startPos);
        const eqPos = stepStr.indexOf("=");
        let name = eqPos < 0 ? stepStr : stepStr.slice(0, eqPos);
        const stripped = strip(name);
        let namePos = stripped ? name.length - lstrip(name).length : 0;
        name = stripped;
        const step = new DeviceTypeGrammarStep();
        let stepValid = true;
        // Guard {?name} at the start of an init step
        if (name.startsWith("{?")) {
            const end = name.indexOf("}");
            const guardName = end >= 0 ? name.slice(2, end) : "";
            if (field !== "init" || !isSlotName(guardName)) {
                ctx.issue("BadPlaceholder", namePos);
                stepValid = false;
            } else {
                step.guard = guardName;
                const rest = name.slice(end + 1);
                const strippedRest = lstrip(rest);
                namePos += strippedRest ? end + 1 + rest.length - strippedRest.length : name.length;
                name = strippedRest;
            }
        }
        if (!stepValid) {
            // bad guard (reported above)
        } else if (eqPos < 0 && isPauseToken(name)) {
            ctx.issue("BarePause", namePos);
            stepValid = setPause(step, strtol(name, 1)[0], ctx, namePos);
        } else {
            const write = parseWrite(name, new Ctx(result, startPos + namePos), field);
            if (write === null) {
                stepValid = false;
            } else {
                [step.write, step.slots] = write;
                if (eqPos >= 0) {
                    step.hasValue = true;
                    const value = stepStr.slice(eqPos + 1);
                    const valuePos = eqPos + 1;
                    if (value.includes("=")) {
                        ctx.issue("MultipleEquals", valuePos + value.indexOf("="));
                        stepValid = false;
                    } else if (field === "detection") {
                        stepValid = parseDetectionValue(value, valuePos, step, ctx);
                    } else if (field === "init") {
                        if (value.includes("r{")) {
                            ctx.issue("ReadExprNotAllowed", valuePos + value.indexOf("r{"));
                            stepValid = false;
                        } else {
                            stepValid = parseInitValue(value, valuePos, step, ctx);
                        }
                    } else {
                        stepValid = parsePollValue(value, valuePos, step, ctx);
                    }
                }
            }
        }
        if (stepValid)
            result.steps.push(step);
        else
            detectionInvalid = true;
        startPos = endPos + 1;
    }
    if (field === "detection" && detectionInvalid)
        result.steps = [];
    return result;
}

// Strength of a compiled detection string: the bits it compares (for each step, the fewest bits any of its
// alternatives compares, plus 8 for each CRC byte checked by :crc8w); -1 if it has errors (it never matches)
export function deviceTypeDetectionStrength(result: DeviceTypeGrammarResult): number {
    if (result.hasErrors())
        return -1;
    let strength = 0;
    const popcount = (b: number) => { let n = 0; for (; b; b >>= 1) n += b & 1; return n; };
    for (const step of result.steps) {
        const bits = step.checks.map((c) => c.mask.reduce((sum, b) => sum + popcount(b), 0));
        if (bits.length > 0 && Math.min(...bits) > 0)
            strength += Math.min(...bits);
        if (step.crc8w)
            strength += 8 * Math.floor(step.read / 3);
    }
    return strength;
}

// Sensirion CRC-8 (poly 0x31, init 0xff)
export function deviceTypeCrc8(data: ArrayLike<number>): number {
    let crc = 0xff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
}
