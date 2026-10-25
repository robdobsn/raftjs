/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceTypeCodeCheck
// Part of RaftJS
//
// The decode code check: a record's decode code (resp.c) and init code (initCode) are compiled into the firmware or
// run by its code interpreter, so code from another source may use only the decode language - buf, the record's
// out.<attribute>s (init code: init.<name>), its own variables, the integer type names, if/else/while/next/return and
// operators; no function calls. A TypeScript copy of RaftCore's PseudocodeHandler.check_code and
// AssembleDeviceTypes.check_decode_code, checked against the vectors in RaftCore
// scripts/tests/codecheck_vectors.json (the problems are reported in the same words).
//
// Rob Dobson 2026
// (C) 2026 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { DevTypeJson, devTypeJsonGet, isDevTypeJsonObject } from "./RaftDeviceTypeJson";

// The lexer's tokens, in the order they are tried (as PseudocodeHandler.token_dict)
const TOKENS: Array<[string, string]> = [
    ["INT", "int\\b"], ["FLOAT", "float\\b"], ["RETURN", "return\\b"], ["WHILE", "while\\b"], ["NEXT", "next\\b"],
    ["ID", "[a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)*"],
    ["HEX_NUM", "0x[0-9A-Fa-f]+"], ["NUM_FLOAT", "\\d+\\.\\d*"], ["NUM_INT", "\\d+"],
    ["LOGICAL_AND", "\\&\\&"], ["LOGICAL_OR", "\\|\\|"], ["LOGICAL_NOT", "\\!"], ["SHIFT_LEFT", "\\<\\<"], ["SHIFT_RIGHT", "\\>\\>"],
    ["BITWISE_AND", "\\&"], ["BITWISE_OR", "\\|"], ["BITWISE_XOR", "\\^"], ["BITWISE_NOT", "\\~"],
    ["INC_OP", "\\+\\+"], ["DEC_OP", "\\-\\-"], ["ADD_OP", "\\+"], ["SUB_OP", "\\-"], ["MUL_OP", "\\*"], ["DIV_OP", "/"],
    ["MOD_OP", "%"], ["REL_OP", "==|!=|<=|>=|<|>"], ["ASSIGN", "="], ["SEMI", ";"], ["COMMA", ","],
    ["LPAREN", "\\("], ["RPAREN", "\\)"], ["LBRACE", "\\{"], ["RBRACE", "\\}"], ["LBRACK", "\\["], ["RBRACK", "\\]"],
    ["WHITESPACE", "[ \\t]+"], ["NEWLINE", "\\n"],
];
const TOKEN_RE_SOURCE = TOKENS.map(([, re]) => `(${re})`).join("|");

// Names decode code may use besides its own variables and out.<attribute>
const ALLOWED_NAMES = new Set(["buf", "if", "else"]);
const TYPE_NAMES = new Set(["int8_t", "uint8_t", "int16_t", "uint16_t", "int32_t", "uint32_t"]);

export type DeviceTypeCodeKind = "decode" | "init";

// A string as Python's repr() writes it (the problems quote characters this way)
function pythonRepr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of s) {
        const c = ch.codePointAt(0) as number;
        if (ch === "\\") out += "\\\\";
        else if (ch === quote) out += "\\" + ch;
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
        else if ((c >= 0x80 && c <= 0xa0) || c === 0xad) out += "\\x" + c.toString(16).padStart(2, "0");
        else out += ch;
    }
    return out + quote;
}

// Problems in decode code (resp.c's code) or init code (code kind "init"): characters the lexer doesn't recognise,
// names other than those allowed, and function calls. Empty if none
export function checkDeviceTypeCode(code: string, attrNames: string[], codeKind: DeviceTypeCodeKind = "decode"): string[] {
    const problems: string[] = [];
    const tokens: Array<[string, string]> = [];
    const re = new RegExp(TOKEN_RE_SOURCE, "g");
    let pos = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
        if (m[0].length === 0) {
            re.lastIndex++;
            continue;
        }
        if (m.index > pos)
            problems.push(`unexpected characters ${pythonRepr(code.slice(pos, m.index))} at ${pos}`);
        pos = m.index + m[0].length;
        const group = m.slice(1).findIndex((g) => g !== undefined);
        const kind = TOKENS[group][0];
        if (kind !== "WHITESPACE" && kind !== "NEWLINE")
            tokens.push([kind, m[0]]);
    }
    if (pos < code.length)
        problems.push(`unexpected characters ${pythonRepr(code.slice(pos))} at ${pos}`);
    // The code's own variables: names declared after int, float or an integer type name
    const variables = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
        const [kind, value] = tokens[i];
        if ((kind === "INT" || kind === "FLOAT" || (kind === "ID" && TYPE_NAMES.has(value))) && tokens[i + 1][0] === "ID")
            variables.add(tokens[i + 1][1]);
    }
    const attrs = new Set(attrNames);
    tokens.forEach(([kind, value], i) => {
        if (kind !== "ID")
            return;
        if (codeKind === "init") {
            if (value.startsWith("init.") && value.split(".").length === 2 && value.length > 5)
                return;
            if (value.startsWith("out.")) {
                problems.push(`${value} - init code assigns init.<name> values, not out.<attribute>s`);
                return;
            }
        } else if (value.startsWith("out.")) {
            if (!attrs.has(value.slice(4)))
                problems.push(`out.${value.slice(4)} is not an attribute of the record`);
            return;
        }
        if (value.includes(".")) {
            problems.push(`${value} is not allowed (only ${codeKind === "init" ? "init.<name>" : "out.<attribute>"} has a '.')`);
            return;
        }
        if (!ALLOWED_NAMES.has(value) && !TYPE_NAMES.has(value) && !variables.has(value))
            problems.push(`${value} is not declared in the code`);
        if (i + 1 < tokens.length && tokens[i + 1][0] === "LPAREN" && value !== "if")
            problems.push(`${value}(...) - function calls are not allowed`);
    });
    return problems;
}

// Problems in a record's decode code (resp.c) and init code (initCode), as AssembleDeviceTypes.check_decode_code
// reports them (init code problems start "initCode: ")
export function checkDeviceTypeRecordCode(record: DevTypeJson | undefined): string[] {
    const problems: string[] = [];
    const resp = devTypeJsonGet(record, "devInfoJson", "resp");
    const custom = devTypeJsonGet(resp, "c");
    const customCode = devTypeJsonGet(custom, "c");
    if (isDevTypeJsonObject(custom) && typeof customCode === "string" && customCode) {
        const attrList = devTypeJsonGet(resp, "a");
        const attrs = Array.isArray(attrList) ? attrList.map((a) => {
            const n = devTypeJsonGet(a, "n");
            return typeof n === "string" ? n : "";
        }) : [];
        problems.push(...checkDeviceTypeCode(customCode, attrs));
    }
    const initCode = devTypeJsonGet(record, "initCode");
    const init = isDevTypeJsonObject(initCode) ? devTypeJsonGet(initCode, "c") : initCode;
    if (typeof init === "string" && init)
        problems.push(...checkDeviceTypeCode(init, [], "init").map((p) => "initCode: " + p));
    return problems;
}
