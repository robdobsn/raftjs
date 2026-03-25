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

const PREAMBLE =
    'const out = new Proxy({}, { set(_, p, v) { if (attrValues[p]) attrValues[p].push(v); return true; } });\n' +
    'function toInt16(lo, hi) { const u = (hi << 8) | lo; return u & 0x8000 ? u - 0x10000 : u; }\n' +
    'function toInt32(b0, b1, b2, b3) { return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0; }\n';

export function transpilePseudocodeToJs(pseudocode: string): string {
    const tokens = tokenize(pseudocode);
    let js = PREAMBLE;

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
            case 'NEXT':
                // no-op in JS — samples are pushed to arrays via the out Proxy
                break;
            default:
                js += token.value;
                break;
        }
    }

    return js;
}
