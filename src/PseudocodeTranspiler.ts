/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// PseudocodeTranspiler
// Transpiles Raft device pseudocode (from devInfoJson resp.c.c) to JavaScript function bodies
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface Token {
    type: string;
    value: string;
}

const TOKEN_SPEC: [string, RegExp][] = [
    ['FLOAT_KW',    /float\b/],
    ['INT_KW',      /int\b/],
    ['RETURN',      /return\b/],
    ['WHILE',       /while\b/],
    ['NEXT',        /next\b/],
    ['HEX_NUM',     /0x[0-9A-Fa-f]+/],
    ['NUM_FLOAT',   /\d+\.\d*/],
    ['NUM_INT',     /\d+/],
    ['ID',          /[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/],
    ['LSHIFT',      /<</],
    ['RSHIFT',      />>/],
    ['LOGICAL_AND', /&&/],
    ['LOGICAL_OR',  /\|\|/],
    ['REL_OP',      /==|!=|<=|>=|<|>/],
    ['INC_OP',      /\+\+/],
    ['DEC_OP',      /--/],
    ['ASSIGN',      /=/],
    ['ADD_OP',      /\+/],
    ['SUB_OP',      /-/],
    ['MUL_OP',      /\*/],
    ['DIV_OP',      /\//],
    ['MOD_OP',      /%/],
    ['BITWISE_AND', /&/],
    ['BITWISE_OR',  /\|/],
    ['BITWISE_XOR', /\^/],
    ['BITWISE_NOT', /~/],
    ['LOGICAL_NOT', /!/],
    ['SEMI',        /;/],
    ['COMMA',       /,/],
    ['LPAREN',      /\(/],
    ['RPAREN',      /\)/],
    ['LBRACE',      /\{/],
    ['RBRACE',      /\}/],
    ['LBRACK',      /\[/],
    ['RBRACK',      /\]/],
    ['WS',          /[ \t\n]+/],
];

// Build the combined regex once at module load
const COMBINED_RE = new RegExp(
    TOKEN_SPEC.map(([name, re]) => `(?<${name}>${re.source})`).join('|'),
    'g'
);

export function tokenize(code: string): Token[] {
    // Reset lastIndex since we reuse the global regex
    COMBINED_RE.lastIndex = 0;
    const tokens: Token[] = [];
    let match: RegExpExecArray | null;
    while ((match = COMBINED_RE.exec(code)) !== null) {
        for (const [name] of TOKEN_SPEC) {
            if (match.groups![name] !== undefined) {
                if (name !== 'WS') {
                    tokens.push({ type: name, value: match[0] });
                }
                break;
            }
        }
    }
    return tokens;
}

// Writes are staged per sample and flushed by __endSample() (from `next`, or once at the end
// for decodes without `next`), as the firmware's compiled decode writes a sample's output
// record and moves on at `next`. Scalar writes (out.x = v): the last value written in the
// sample is the attribute's value, so a decode may set a default and then overwrite it; an
// attribute the sample doesn't write gets no value. Array element writes (out.x[i] = v):
// each array attribute contributes exactly its element count, with unwritten elements 0 and
// out-of-range indices ignored.
// __arrayElems (attribute name -> elements per sample) is passed in by the caller.
const PREAMBLE =
    'let __sampleOpen = false;\n' +
    'let __stage = null;\n' +
    'let __scalars = null;\n' +
    'const __arr = (typeof __arrayElems !== "undefined" && __arrayElems) ? __arrayElems : {};\n' +
    'const out = new Proxy({}, { set(_, p, v) { if (attrValues[p] && !__arr[p]) { if (!__scalars) __scalars = {}; ' +
        '__scalars[p] = v; __sampleOpen = true; } return true; }, ' +
        'get(_, p) { return (__scalars && p in __scalars) ? __scalars[p] : NaN; } });\n' +
    'function __cast(v, bits, signed) { v = Number(v); if (!Number.isFinite(v)) return 0; v = v < 0 ? Math.ceil(v) : Math.floor(v); ' +
        'if (bits === 32) return signed ? v | 0 : v >>> 0; const sh = 32 - bits; ' +
        'return signed ? (v << sh) >> sh : (v >>> 0) & ((1 << bits) - 1); }\n' +
    'function __setElem(n, i, v) { const len = __arr[n]; if (!len || !attrValues[n] || !Number.isFinite(i)) return; i = i | 0; ' +
        'if (!(i >= 0 && i < len)) return; if (!__stage) __stage = {}; if (!__stage[n]) __stage[n] = new Array(len).fill(0); ' +
        '__stage[n][i] = v; __sampleOpen = true; }\n' +
    'function __endSample() { if (__scalars) { for (const n of Object.keys(__scalars)) attrValues[n].push(__scalars[n]); } ' +
        'for (const n of Object.keys(__arr)) { if (!attrValues[n]) continue; ' +
        'const s = (__stage && __stage[n]) ? __stage[n] : new Array(__arr[n]).fill(0); attrValues[n].push(...s); } ' +
        '__scalars = null; __stage = null; __sampleOpen = false; }\n' +
    'function toInt16(lo, hi) { const u = (hi << 8) | lo; return u & 0x8000 ? u - 0x10000 : u; }\n' +
    'function toInt32(b0, b1, b2, b3) { return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0; }\n';

// C integer types usable in declarations and casts, as the firmware's interpreter: [bits, signed]
const INT_TYPES: Record<string, [number, boolean]> = {
    int8_t: [8, true], uint8_t: [8, false], int16_t: [16, true], uint16_t: [16, false],
    int32_t: [32, true], uint32_t: [32, false],
};

function isTypeName(tok: Token | undefined): boolean {
    return !!tok && (tok.type === 'INT_KW' || tok.type === 'FLOAT_KW' || (tok.type === 'ID' && tok.value in INT_TYPES));
}

// JS for converting the value of jsExpr to a type: integer types truncate and wrap to their width
// (int is int32_t); float leaves it as a number
function castJs(typeTok: Token, jsExpr: string): string {
    if (typeTok.type === 'FLOAT_KW') return `(+(${jsExpr}))`;
    const [bits, signed] = typeTok.type === 'INT_KW' ? [32, true] : INT_TYPES[typeTok.value];
    return `__cast(${jsExpr},${bits},${signed})`;
}

// Index after the bracketed group (LPAREN or LBRACK) opening at startIdx (-1 if unmatched)
function groupEnd(tokens: Token[], startIdx: number): number {
    const open = tokens[startIdx].type;
    const close = open === 'LPAREN' ? 'RPAREN' : 'RBRACK';
    let depth = 0;
    for (let i = startIdx; i < tokens.length; i++) {
        if (tokens[i].type === open) depth++;
        else if (tokens[i].type === close && --depth === 0) return i + 1;
    }
    return -1;
}

// Index after the unary expression starting at idx (a cast's operand): prefix operators and casts, then a
// number, name or parenthesised expression, then any indexes or call arguments
function unaryEnd(tokens: Token[], idx: number): number {
    let i = idx;
    for (;;) {
        const t = tokens[i];
        if (!t) return -1;
        if (['SUB_OP', 'ADD_OP', 'BITWISE_NOT', 'LOGICAL_NOT'].includes(t.type)) { i++; continue; }
        if (t.type === 'LPAREN' && isTypeName(tokens[i + 1]) && tokens[i + 2]?.type === 'RPAREN') { i += 3; continue; }
        break;
    }
    const t = tokens[i];
    if (t.type === 'LPAREN') {
        i = groupEnd(tokens, i);
    } else if (['NUM_INT', 'NUM_FLOAT', 'HEX_NUM', 'ID', 'RAW'].includes(t.type)) {
        i++;
    } else {
        return -1;
    }
    while (i > 0 && i < tokens.length && (tokens[i].type === 'LBRACK' || tokens[i].type === 'LPAREN')) {
        i = groupEnd(tokens, i);
    }
    return i;
}

// Rewrite casts, (type)expr, as one RAW token converting the operand (as the firmware's interpreter)
function rewriteCasts(tokens: Token[]): Token[] {
    const result: Token[] = [];
    let i = 0;
    while (i < tokens.length) {
        const tok = tokens[i];
        if (!(tok.type === 'LPAREN' && isTypeName(tokens[i + 1]) && tokens[i + 2]?.type === 'RPAREN')) {
            result.push(tok);
            i++;
            continue;
        }
        const end = unaryEnd(tokens, i + 3);
        if (end < 0) {
            throw new Error(`pseudocode cast (${tokens[i + 1].value}) has no operand`);
        }
        const operandJs = rewriteCasts(tokens.slice(i + 3, end)).map(t => t.value).join('');
        result.push({ type: 'RAW', value: castJs(tokens[i + 1], operandJs) });
        i = end;
    }
    return result;
}

// Run the decode body in its own function so an early `return` still reaches the final
// flush; close a sample left open by a decode that never calls `next`
const BODY_START = '(function () {\n';
const BODY_END = '\n})();\nif (__sampleOpen) __endSample();\n';

// Index of the RBRACK matching the LBRACK at startIdx (-1 if unmatched)
function findMatchingBracket(tokens: Token[], startIdx: number): number {
    let depth = 0;
    for (let i = startIdx; i < tokens.length; i++) {
        if (tokens[i].type === 'LBRACK') depth++;
        else if (tokens[i].type === 'RBRACK') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// Rewrite `out.<name>[<idx>] = <val>;` as one RAW token calling __setElem. Only simple
// assignment is supported - reads and compound operators on out.<name>[...] throw.
function rewriteArrayWrites(tokens: Token[]): Token[] {
    const result: Token[] = [];
    let i = 0;
    while (i < tokens.length) {
        const tok = tokens[i];
        const isIndexedOut = tok.type === 'ID' && tok.value.startsWith('out.') &&
                             i + 1 < tokens.length && tokens[i + 1].type === 'LBRACK';
        if (!isIndexedOut) {
            result.push(tok);
            i++;
            continue;
        }
        const name = tok.value.slice(4);
        const closeIdx = findMatchingBracket(tokens, i + 1);
        if (closeIdx < 0 || closeIdx === i + 2) {
            throw new Error(`pseudocode has a malformed index on ${tok.value}`);
        }
        if (closeIdx + 1 >= tokens.length || tokens[closeIdx + 1].type !== 'ASSIGN') {
            throw new Error(`pseudocode ${tok.value}[...] must be a simple assignment (out.${name}[i] = value;)`);
        }
        let j = closeIdx + 2;
        const valTokens: Token[] = [];
        while (j < tokens.length && tokens[j].type !== 'SEMI') {
            valTokens.push(tokens[j]);
            j++;
        }
        if (valTokens.length === 0) {
            throw new Error(`pseudocode ${tok.value}[...] = has no value`);
        }
        const idxJs = rewriteCasts(tokens.slice(i + 2, closeIdx)).map(t => t.value).join('');
        const valJs = rewriteCasts(valTokens).map(t => t.value).join('');
        result.push({ type: 'RAW', value: `__setElem(${JSON.stringify(name)},(${idxJs}),(${valJs}))` });
        i = j;
    }
    return result;
}

export function transpilePseudocodeToJs(pseudocode: string): string {
    const tokens = rewriteCasts(rewriteArrayWrites(tokenize(pseudocode)));
    let js = PREAMBLE + BODY_START;

    // A declaration's values are converted to its type (int: Math.trunc, to emulate C integer division;
    // int8_t..uint32_t: truncated and wrapped); float values are left as they are. declType is the type of the
    // declaration being transpiled, and convertOpen whether a value's conversion has been opened (closed at the
    // declarator's end: a comma or semicolon outside brackets)
    let declType: Token | null = null;
    let convertOpen = false;
    let depth = 0;
    const closeConversion = () => {
        if (convertOpen && declType) {
            js += declType.type === 'INT_KW' ? ')' : `,${INT_TYPES[declType.value][0]},${INT_TYPES[declType.value][1]})`;
        }
        convertOpen = false;
    };

    for (let idx = 0; idx < tokens.length; idx++) {
        const token = tokens[idx];
        // A type name followed by a variable name starts a declaration
        if (declType === null && isTypeName(token) && tokens[idx + 1]?.type === 'ID') {
            js += 'let ';
            declType = token.type === 'FLOAT_KW' ? null : token;
            continue;
        }
        switch (token.type) {
            case 'LPAREN': case 'LBRACK':
                depth++;
                js += token.value;
                break;
            case 'RPAREN': case 'RBRACK':
                depth--;
                js += token.value;
                break;
            case 'ASSIGN':
                js += '=';
                if (declType && depth === 0 && !convertOpen) {
                    js += declType.type === 'INT_KW' ? 'Math.trunc(' : '__cast(';
                    convertOpen = true;
                }
                break;
            case 'COMMA':
                if (depth === 0) closeConversion();
                js += ',';
                break;
            case 'SEMI':
                closeConversion();
                declType = null;
                js += ';';
                break;
            case 'RETURN':
                // Tokens are concatenated without spaces - keep "return x" from becoming "returnx"
                js += 'return ';
                break;
            case 'NEXT':
                // Closes the sample: its scalars and array attributes are pushed
                js += '__endSample()';
                break;
            default:
                js += token.value;
                break;
        }
    }

    return js + BODY_END;
}
