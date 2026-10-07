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

// Scalar writes (out.x = v) push straight onto attrValues. Array element writes
// (out.x[i] = v) are staged per sample and flushed by __endSample() (from `next`, or
// once at the end for decodes without `next`): each array attribute then contributes
// exactly its element count, with unwritten elements 0 and out-of-range indices ignored.
// __arrayElems (attribute name -> elements per sample) is passed in by the caller.
const PREAMBLE =
    'let __sampleOpen = false;\n' +
    'let __stage = null;\n' +
    'const __arr = (typeof __arrayElems !== "undefined" && __arrayElems) ? __arrayElems : {};\n' +
    'const out = new Proxy({}, { set(_, p, v) { if (attrValues[p]) { attrValues[p].push(v); __sampleOpen = true; } return true; } });\n' +
    'function __setElem(n, i, v) { const len = __arr[n]; if (!len || !attrValues[n] || !Number.isFinite(i)) return; i = i | 0; ' +
        'if (!(i >= 0 && i < len)) return; if (!__stage) __stage = {}; if (!__stage[n]) __stage[n] = new Array(len).fill(0); ' +
        '__stage[n][i] = v; __sampleOpen = true; }\n' +
    'function __endSample() { for (const n of Object.keys(__arr)) { if (!attrValues[n]) continue; ' +
        'const s = (__stage && __stage[n]) ? __stage[n] : new Array(__arr[n]).fill(0); attrValues[n].push(...s); } ' +
        '__stage = null; __sampleOpen = false; }\n' +
    'function toInt16(lo, hi) { const u = (hi << 8) | lo; return u & 0x8000 ? u - 0x10000 : u; }\n' +
    'function toInt32(b0, b1, b2, b3) { return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0; }\n';

// Run the decode body in its own function so an early `return` still reaches the final
// flush; close a sample left open by a decode that never calls `next`
const BODY_START = '(function () {\n';
const BODY_END = '\n})();\nif (__sampleOpen && Object.keys(__arr).length > 0) __endSample();\n';

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
        const idxJs = tokens.slice(i + 2, closeIdx).map(t => t.value).join('');
        const valJs = valTokens.map(t => t.value).join('');
        result.push({ type: 'RAW', value: `__setElem(${JSON.stringify(name)},(${idxJs}),(${valJs}))` });
        i = j;
    }
    return result;
}

export function transpilePseudocodeToJs(pseudocode: string): string {
    const tokens = rewriteArrayWrites(tokenize(pseudocode));
    let js = PREAMBLE + BODY_START;

    // Track int declarations so we can wrap the init expression in Math.trunc()
    // to emulate C integer division semantics
    let afterIntKw = false;
    let wrappedInTrunc = false;

    for (const token of tokens) {
        switch (token.type) {
            case 'INT_KW':
                js += 'let ';
                afterIntKw = true;
                break;
            case 'FLOAT_KW':
                js += 'let ';
                afterIntKw = false;
                break;
            case 'ASSIGN':
                js += '=';
                if (afterIntKw) {
                    js += 'Math.trunc(';
                    wrappedInTrunc = true;
                }
                break;
            case 'SEMI':
                if (wrappedInTrunc) {
                    js += ')';
                    wrappedInTrunc = false;
                }
                js += ';';
                afterIntKw = false;
                break;
            case 'RETURN':
                // Tokens are concatenated without spaces - keep "return x" from becoming "returnx"
                js += 'return ';
                break;
            case 'NEXT':
                // Scalars are pushed as they are written (out Proxy); this closes the
                // sample for array attributes
                js += '__endSample()';
                break;
            default:
                js += token.value;
                break;
        }
    }

    return js + BODY_END;
}
