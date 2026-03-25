# Pseudocode-to-JS Transpiler for Custom Attribute Decoding

## Problem

When new Raft devices are added, their poll-response decoding logic is defined in DeviceTypeRecords.json via a compact pseudocode in the `resp.c.c` field. Today, `RaftCustomAttrHandler` handles these by:

1. **Hard-coded native handlers** — a chain of `if/else if` blocks keyed on `customFnDef.n` (e.g. `"max30101_fifo"`, `"lsm6ds_fifo"`, `"gravity_o2_calc"`). Every new device with custom decoding requires a raftjs code change and release.

2. **Pre-supplied JS via `customFnDef.j`** — an optional JavaScript string that is compiled with `new Function()` and cached. This works but requires the server or device-type record author to hand-write the JS in addition to the pseudocode.

The goal is to **automatically transpile the pseudocode (`customFnDef.c`) to JavaScript at runtime**, compile it via `new Function()`, and cache it — eliminating the need to update raftjs when new devices are added, and removing the need for authors to maintain a separate `j` field.

## Relationship to the Existing Python Tooling

The firmware build pipeline already contains two Python scripts in `RaftCore/scripts/`:

- **`PseudocodeHandler.py`** — a regex-based lexer and multi-target code generator (C++, Python, TypeScript) for the pseudocode language.
- **`DecodeGenerator.py`** — uses `PseudocodeHandler` to generate C++ decode functions (structs, extraction loops, timestamp handling) that are compiled into the firmware.

**These Python scripts remain as-is.** They are part of the firmware (ESP-IDF / C++) build and requiring Node.js on the firmware build platform would be an unnecessary dependency. The raftjs runtime transpiler described in this document is a separate, independent implementation targeting the same pseudocode language, but producing JavaScript instead of C++.

## Runtime Data Flow

The full `DeviceTypeRecords.json` is **not** available to raftjs at build time. Only the `devInfoJson` contents are delivered at runtime when a new device is detected by the firmware. The pseudocode lives inside `devInfoJson.resp.c.c`, so it is available to raftjs at the point a device is first seen:

```
Firmware detects device
    → sends devInfoJson to raftjs over BLE/WebSocket/Serial
        → raftjs parses into DeviceTypePollRespMetadata
            → resp.c.c contains the pseudocode string
                → transpile once → compile via new Function() → cache
                    → all subsequent poll decodes use cached JIT'd function
```

The transpilation + compilation cost is a one-time operation per device type. Subsequent poll responses use the cached function directly.

## Pseudocode Language Specification

The pseudocode is a minimal C-like language. Its grammar is defined by the tokenizer in `PseudocodeHandler.py` (in `RaftCore/scripts/`). The full token set:

| Token | Pattern | Notes |
|-------|---------|-------|
| `int` | keyword | Integer variable declaration |
| `float` | keyword | Float variable declaration |
| `return` | keyword | Return statement |
| `while` | keyword | While loop |
| `next` | keyword | Advance to next output record (loop iteration boundary) |
| `if` | — | Parsed as an `ID` token; passes through verbatim (valid JS keyword) |
| Identifiers | `[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*` | Includes dotted access like `out.gx`, `buf` |
| Integer literals | `\d+` | |
| Float literals | `\d+\.\d*` | e.g. `20.9`, `120.0` |
| Operators | `&&` `\|\|` `!` `<<` `>>` `&` `\|` `^` `~` `++` `--` `+` `-` `*` `/` `%` `==` `!=` `<=` `>=` `<` `>` `=` | Standard C operators |
| Delimiters | `;` `,` `(` `)` `{` `}` `[` `]` | |

### Semantic Conventions

- **`buf`** — the input byte array (a `Uint8Array` slice of the poll response)
- **`out.<name>`** — write an output attribute value. e.g. `out.gx = ...` pushes a value to the `gx` attribute vector
- **`next`** — marks the end of one output record in a multi-sample loop (e.g. FIFO reads). In JS this is a no-op since we just push to arrays.
- **`int` / `float`** — type declarations. In JS these become `let`.

### Real-World Examples

**max30101_fifo** (heart-rate sensor FIFO):
```
int N=(buf[0]+32-buf[2])%32;int k=3;int i=0;while(i<N){out.Red=(buf[k]<<16)|(buf[k+1]<<8)|buf[k+2];out.IR=(buf[k+3]<<16)|(buf[k+4]<<8)|buf[k+5];k+=6;i++;next;}
```

**lsm6ds_fifo** (6-axis IMU FIFO):
```
int W=((buf[1]&0x0F)<<8)|buf[0];int P=((buf[3]&0x03)<<8)|buf[2];int skip=(6-P%6)%6;int N=(W-skip)/6;int maxN=(192-skip*2)/12;if(N>maxN){N=maxN;}if(N>16){N=16;}if(N<1){N=0;}int k=4+skip*2;int i=0;while(i<N){out.gx=(buf[k+1]<<8)|buf[k];out.gy=(buf[k+3]<<8)|buf[k+2];out.gz=(buf[k+5]<<8)|buf[k+4];out.ax=(buf[k+7]<<8)|buf[k+6];out.ay=(buf[k+9]<<8)|buf[k+8];out.az=(buf[k+11]<<8)|buf[k+10];k+=12;i++;next;}
```

**scd40_calc** (CO2 sensor):
```
out.CO2 = buf[0]; out.Temp = -45.0 + (175.0 * buf[1] / 65535.0); out.Humidity = (100.0 * buf[2] / 65535.0);
```

**gravity_o2_calc** (oxygen sensor):
```
float key = 20.9/120.0; float val = key * (buf[0] + (buf[1]/10.0) + (buf[2]/100.0)); out.oxygen = val;
```

## Proposed Design

### Architecture Overview

```
DeviceTypeRecords.json
  resp.c.c  (pseudocode string)
       │
       ▼
┌──────────────────────┐
│ PseudocodeTranspiler │  (new class in raftjs)
│                      │
│  1. Tokenize         │  ─── regex-based lexer (port of PseudocodeHandler.py)
│  2. Transform tokens │  ─── apply JS-specific substitutions
│  3. Emit JS string   │  ─── generate valid JS function body
└──────┬───────────────┘
       │  JS source string
       ▼
┌──────────────────────┐
│   new Function(...)  │  ─── V8/JSC/Hermes compiles & JITs
└──────┬───────────────┘
       │  CustomAttrJsFn
       ▼
┌──────────────────────┐
│ CustomAttrHandler    │  ─── caches compiled function, calls it for each poll
└──────────────────────┘
```

### Step 1: Port the Lexer to TypeScript

Port the `PseudocodeHandler.lexer()` method. This is a simple regex-based tokenizer. The TypeScript version corrects the token ordering issues found in the Python original (see Appendix A):

```typescript
// PseudocodeTranspiler.ts

interface Token {
    type: string;
    value: string | number;
}

const TOKEN_SPEC: [string, RegExp][] = [
    ['FLOAT_KW',  /float\b/],
    ['INT_KW',    /int\b/],
    ['RETURN',    /return\b/],
    ['WHILE',     /while\b/],
    ['NEXT',      /next\b/],
    ['HEX_NUM',   /0x[0-9A-Fa-f]+/],
    ['NUM_FLOAT', /\d+\.\d*/],
    ['NUM_INT',   /\d+/],
    ['ID',        /[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/],
    ['LSHIFT',    /<</],
    ['RSHIFT',    />>/],
    ['LOGICAL_AND', /&&/],
    ['LOGICAL_OR',  /\|\|/],
    ['REL_OP',    /==|!=|<=|>=|<|>/],
    ['INC_OP',    /\+\+/],
    ['DEC_OP',    /--/],
    ['ASSIGN',    /=/],
    ['ADD_OP',    /\+/],
    ['SUB_OP',    /-/],
    ['MUL_OP',    /\*/],
    ['DIV_OP',    /\//],
    ['MOD_OP',    /%/],
    ['BITWISE_AND', /&/],
    ['BITWISE_OR',  /\|/],
    ['BITWISE_XOR', /\^/],
    ['BITWISE_NOT', /~/],
    ['LOGICAL_NOT', /!/],
    ['SEMI',      /;/],
    ['COMMA',     /,/],
    ['LPAREN',    /\(/],
    ['RPAREN',    /\)/],
    ['LBRACE',    /\{/],
    ['RBRACE',    /\}/],
    ['LBRACK',    /\[/],
    ['RBRACK',    /\]/],
    ['WS',        /[ \t\n]+/],
];

function tokenize(code: string): Token[] {
    const combined = new RegExp(
        TOKEN_SPEC.map(([name, re]) => `(?<${name}>${re.source})`).join('|'),
        'g'
    );
    const tokens: Token[] = [];
    let match: RegExpExecArray | null;
    while ((match = combined.exec(code)) !== null) {
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
```

Key differences from the Python version (see Appendix A for details on the Python issues):
- `HEX_NUM` token added (matched before `NUM_INT`) so `0x0F` doesn't get split into `0` + `x0F` (Appendix A.2).
- `NUM_FLOAT` ordered before `NUM_INT` so float literals like `20.9` tokenize correctly (Appendix A.1).
- `if` is not a separate keyword — it falls through to `ID` and passes through verbatim, which is valid JS. Same as in the Python version.
- Token ordering is critical: multi-character operators (`<<`, `>>`, `&&`, `||`, `++`, `--`, `==`, etc.) must appear before their single-character counterparts.
- `INT_KW` / `FLOAT_KW` are handled as token types (not via regex substitution on values), avoiding the accidental matching of identifiers containing "int" or "float" (Appendix A.7).

### Step 2: Token Transformation & JS Code Generation

The key transformation is converting pseudocode semantics to the `CustomAttrJsFn` calling convention used by `handleAttr()`. The function receives these parameters:

```typescript
(buf: Uint8Array, attrValues: Record<string, number[]>, attrValueVecs: number[][],
 pollRespMetadata: DeviceTypePollRespMetadata, msgBuffer: Uint8Array, msgBufIdx: number, numMsgBytes: number)
```

The transformations needed:

| Pseudocode | JS Output | Rationale |
|------------|-----------|-----------|
| `int x = ...` | `let x = ...` | JS `let` for local variables |
| `float x = ...` | `let x = ...` | JS `let` for local variables |
| `out.attrName = expr` | `attrValues["attrName"].push(expr)` | Push decoded value to the named attribute array |
| `next` | (empty / no-op) | In JS we just push to arrays; no struct pointer advancement needed |
| `buf[i]` | `buf[i]` | Direct — `buf` is already the sliced `Uint8Array` |

The `out.<name>` transformation is the most important. The Python `PseudocodeHandler.__main__` block already demonstrates this substitution for TypeScript mode:

```python
substitutions["out\.(.*)"] = "attrValues['\\1'].push(0); attrValues['\\1'][attrValues['\\1'].length-1] "
```

However, the push-then-overwrite pattern (`push(0)` then assign `[length-1]`) is awkward. A cleaner approach in the transpiler:

**Option A — Detect `out.X = expr;` as a complete statement and emit `attrValues["X"].push(expr);`**

This requires looking ahead from an `out.X` token to find the `=` and the expression up to the `;`, then wrapping it. This is more correct and avoids the double-write.

**Option B — Use a Proxy object** that intercepts property sets:

```javascript
const out = new Proxy({}, {
    set(_, prop, value) {
        attrValues[prop].push(value);
        return true;
    }
});
```

Then `out.gx = expr` naturally becomes `attrValues["gx"].push(expr)`. The pseudocode passes through almost verbatim — only `int`/`float` → `let` and `next` → `` substitutions are needed.

**Option B is strongly recommended** because:
- It avoids complex expression boundary detection
- The pseudocode passes through with minimal transformation
- The Proxy overhead is negligible since decoding runs per-poll (not in a tight inner loop of millions of iterations)
- It's significantly simpler to implement and maintain

### Step 3: JS Code Generation Function

```typescript
function transpilePseudocodeToJs(pseudocode: string): string {
    const tokens = tokenize(pseudocode);
    let js = '';

    // Preamble: create the out proxy
    js += 'const out = new Proxy({}, { set(_, p, v) { if (attrValues[p]) attrValues[p].push(v); return true; } });\n';

    for (const token of tokens) {
        switch (token.type) {
            case 'INT_KW':
            case 'FLOAT_KW':
                js += 'let ';
                break;
            case 'NEXT':
                // no-op in JS — samples are pushed to arrays
                break;
            case 'SEMI':
                js += ';\n';
                break;
            case 'LBRACE':
                js += ' {\n';
                break;
            case 'RBRACE':
                js += '}\n';
                break;
            default:
                js += token.value;
                break;
        }
    }

    return js;
}
```

### Step 4: Compilation and Caching in CustomAttrHandler

The compiled function is created with `new Function()` and cached, exactly as the existing `j` field handler does:

```typescript
private getOrCompileFunction(customFnDef: CustomFunctionDefinition): CustomAttrJsFn | null {
    // Prefer explicit JS if provided
    let jsSource = customFnDef.j?.trim();

    // Otherwise, transpile from pseudocode
    if (!jsSource && customFnDef.c) {
        jsSource = transpilePseudocodeToJs(customFnDef.c);
    }

    if (!jsSource) return null;

    const cacheKey = `${customFnDef.n}::${jsSource}`;
    const cached = this._jsFunctionCache.get(cacheKey);
    if (cached) return cached;

    try {
        const fn = new Function(
            'buf', 'attrValues', 'attrValueVecs',
            'pollRespMetadata', 'msgBuffer', 'msgBufIdx', 'numMsgBytes',
            jsSource
        ) as CustomAttrJsFn;
        this._jsFunctionCache.set(cacheKey, fn);
        return fn;
    } catch (err) {
        console.error(`Failed to compile function ${customFnDef.n}:`, err);
        return null;
    }
}
```

Priority order:
1. `customFnDef.j` — explicit JS (existing mechanism, kept for backwards compat and for cases where the transpiler can't handle something)
2. `customFnDef.c` — pseudocode, transpiled to JS
3. Hard-coded native handlers — **deprecated**, kept temporarily as fallback

### Step 5: Simplify handleAttr()

Once the transpiler is in place, `handleAttr()` becomes:

```typescript
public handleAttr(pollRespMetadata: DeviceTypePollRespMetadata, msgBuffer: Uint8Array, msgBufIdx: number): number[][] {
    const numMsgBytes = pollRespMetadata.b;
    const attrValueVecs: number[][] = [];
    const attrValues: Record<string, number[]> = {};

    for (let attrIdx = 0; attrIdx < pollRespMetadata.a.length; attrIdx++) {
        attrValueVecs.push([]);
        attrValues[pollRespMetadata.a[attrIdx].n] = attrValueVecs[attrIdx];
    }

    const customFnDef = pollRespMetadata.c;
    if (!customFnDef) return attrValueVecs;

    const buf = msgBuffer.slice(msgBufIdx, msgBufIdx + numMsgBytes);
    if (buf.length < numMsgBytes) return [];

    const fn = this.getOrCompileFunction(customFnDef);
    if (!fn) return attrValueVecs;

    try {
        fn(buf, attrValues, attrValueVecs, pollRespMetadata, msgBuffer, msgBufIdx, numMsgBytes);
    } catch (err) {
        console.error(`CustomAttrHandler function ${customFnDef.n} execution failed`, err);
    }
    return attrValueVecs;
}
```

The entire `if/else if` chain for `max30101_fifo`, `lsm6ds_fifo`, `gravity_o2_calc` is removed.

## Signed Integer Handling

The pseudocode uses expressions like `(buf[k+1]<<8)|buf[k]` to reconstruct 16-bit values. In the current hard-coded `lsm6ds_fifo` handler, the `toInt16()` helper converts to signed. But the pseudocode itself doesn't encode signedness.

Options:
1. **Add a `toInt16()` / `toInt32()` helper to the function scope.** The transpiler preamble could inject it:
   ```javascript
   function toInt16(lo, hi) { const u = (hi << 8) | lo; return u & 0x8000 ? u - 0x10000 : u; }
   ```
   Then update the pseudocode to use `out.gx = toInt16(buf[k], buf[k+1])` instead of raw bit manipulation.

2. **Rely on the attribute `t` field.** The attribute metadata already declares signedness (e.g. `"t": "<h"` = signed little-endian int16). The caller of `handleAttr()` could apply sign extension post-hoc based on the type and bit width. This keeps the pseudocode simple but may need changes in `RaftAttributeHandler`.

3. **Accept that the current pseudocode produces unsigned values** and note that if sign-extension is needed, the pseudocode should use an explicit expression like `out.gx=((buf[k+1]<<8)|buf[k])<<16>>16;` (arithmetic right-shift sign-extends in JS).

**Recommendation:** Option 1 — inject a small set of helper functions into the transpiled function scope. This is the cleanest approach and requires no pseudocode changes. The transpiler preamble becomes:

```javascript
const out = new Proxy({}, { set(_, p, v) { if (attrValues[p]) attrValues[p].push(v); return true; } });
function toInt16(lo, hi) { const u = (hi << 8) | lo; return u & 0x8000 ? u - 0x10000 : u; }
function toInt32(b0, b1, b2, b3) { return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0; }
```

For existing pseudocode that doesn't call `toInt16()`, values remain unsigned — which is the same as what the pseudocode literally says. If signedness matters, the pseudocode can be updated to use the helper, or new pseudocode for new devices can use it from day one.

## Security Considerations

`new Function()` is essentially `eval()`. Mitigations:

1. **Input is trusted** — the pseudocode comes from DeviceTypeRecords.json which is authored by device developers and delivered from the Raft device firmware or a trusted server. It is not user-supplied input from an untrusted source.

2. **Lexer whitelisting** — the tokenizer only recognizes a fixed set of tokens (identifiers, numbers, operators, keywords). Arbitrary strings like `fetch(...)`, `import(...)`, `require(...)`, or template literals cannot be constructed from these tokens. The lexer acts as a whitelist filter.

3. **No string literals** — the pseudocode language has no string literal token type. This prevents injection of arbitrary code via string concatenation.

4. **Scope isolation** — `new Function()` does not have access to the enclosing lexical scope (unlike `eval()`). The function only sees its explicit parameters plus globals.

5. **Cache key includes source** — if the pseudocode changes, a new function is compiled. Stale functions are not reused.

The existing `j` field mechanism already uses `new Function()` with the same trust model, so the transpiler does not introduce any new attack surface.

## Implementation Plan

### New File: `src/PseudocodeTranspiler.ts`

Contains:
- `Token` interface
- `tokenize(code: string): Token[]` — lexer
- `transpilePseudocodeToJs(pseudocode: string): string` — token transform + code generation

### Modified File: `src/RaftCustomAttrHandler.ts`

Changes:
- Import `transpilePseudocodeToJs`
- Modify `getOrCompileJsFunction()` → `getOrCompileFunction()` to try `customFnDef.c` transpilation when `customFnDef.j` is absent
- Remove the hard-coded `if/else if` chain from `handleAttr()` (or keep as a last-resort fallback behind a flag during migration)
- Simplify `handleAttr()` to always use the compiled function path

### New File: `src/PseudocodeTranspiler.test.ts`

Unit tests covering:
- Tokenizer output for each pseudocode example
- Transpiled JS output for each pseudocode example
- End-to-end: transpile → compile → execute with mock `buf` data and verify `attrValues` output
- All four known pseudocode strings (`max30101_fifo`, `lsm6ds_fifo`, `scd40_calc`, `gravity_o2_calc`)

### Migration Strategy

1. Implement transpiler and integrate into `getOrCompileFunction()`
2. Keep hard-coded handlers as fallback initially (try transpiled function first, fall back to hard-coded if transpilation fails)
3. Validate numeric equivalence for all four known custom functions using test data
4. Once validated, remove the hard-coded handlers entirely
5. The `j` field remains supported for edge cases where hand-written JS is preferable

## Transpiler Output Examples

### max30101_fifo

Input pseudocode:
```
int N=(buf[0]+32-buf[2])%32;int k=3;int i=0;while(i<N){out.Red=(buf[k]<<16)|(buf[k+1]<<8)|buf[k+2];out.IR=(buf[k+3]<<16)|(buf[k+4]<<8)|buf[k+5];k+=6;i++;next;}
```

Transpiled JS function body:
```javascript
const out = new Proxy({}, { set(_, p, v) { if (attrValues[p]) attrValues[p].push(v); return true; } });
let N=(buf[0]+32-buf[2])%32;
let k=3;
let i=0;
while (i<N) {
out.Red=(buf[k]<<16)|(buf[k+1]<<8)|buf[k+2];
out.IR=(buf[k+3]<<16)|(buf[k+4]<<8)|buf[k+5];
k+=6;
i++;
}
```

### gravity_o2_calc

Input pseudocode:
```
float key = 20.9/120.0; float val = key * (buf[0] + (buf[1]/10.0) + (buf[2]/100.0)); out.oxygen = val;
```

Transpiled JS function body:
```javascript
const out = new Proxy({}, { set(_, p, v) { if (attrValues[p]) attrValues[p].push(v); return true; } });
let key=20.9/120.0;
let val=key*(buf[0]+(buf[1]/10.0)+(buf[2]/100.0));
out.oxygen=val;
```

## Summary

| Aspect | Current | Proposed |
|--------|---------|----------|
| New device support | Requires raftjs code change | Automatic from `devInfoJson` at runtime |
| Decoding definition | Pseudocode (`c` field) + optional hand-written JS (`j` field) + hard-coded TS | Pseudocode auto-transpiled to JS at runtime; `j` field still supported as override |
| Performance | Native TS (hard-coded) or `new Function` (j field) | `new Function` (transpiled) — equivalent JIT performance |
| Maintenance | Three parallel implementations (pseudocode, C++ codegen, TS hard-code) | Two: pseudocode + auto-generated JS (C++ codegen remains for firmware) |
| Complexity | ~100 lines of hard-coded handlers growing with each device | ~80-line transpiler, stable regardless of device count |
| Build-time dependency | None (hard-coded) | None — transpilation happens at runtime when `devInfoJson` arrives |
| Python tooling | `PseudocodeHandler.py` + `DecodeGenerator.py` for firmware C++ codegen | Unchanged — firmware build pipeline is unaffected |

## Appendix A: Observations on the Python PseudocodeHandler / DecodeGenerator

The Python scripts work correctly for the current set of device types, but there are some issues and potential improvements worth noting. These are suggestions only — none are blocking for the raftjs transpiler work.

### A.1 Token Ordering Bug: `NUM_FLOAT` after `NUM_INT`

In `PseudocodeHandler.py`, the token list has:

```python
('NUM_INT',   r'\d+'),          # Integer number
('NUM_FLOAT', r'\d+\.\d*'),     # Float number
```

Because Python's `re.finditer` with alternation tries each alternative left-to-right and takes the first match, `NUM_INT` will always match the integer part of a float before `NUM_FLOAT` gets a chance. For example, `20.9` is tokenized as `NUM_INT(20)`, then `.` fails to match any token (silently skipped), then `NUM_INT(9)`.

This happens to work for the current pseudocode expressions like `20.9/120.0` because `20 / 120` in integer arithmetic followed by further operations still produces reasonable results in C++ codegen (where `int` division truncates). But it means the lexer never actually produces `NUM_FLOAT` tokens.

**Fix:** Move `NUM_FLOAT` before `NUM_INT` in the token list:

```python
('NUM_FLOAT', r'\d+\.\d*'),     # Float number — must precede NUM_INT
('NUM_INT',   r'\d+'),          # Integer number
```

### A.2 Hex Literal Handling

The pseudocode uses hex literals like `0x0F`, `0x03`, `0x60`. The lexer has no `HEX_NUM` token, so `0x0F` is tokenized as `NUM_INT(0)` + `ID(x0F)`. This works by accident in C++ output (it reconstructs `0x0F` from the concatenated tokens), but is fragile and would break if identifiers were processed differently.

**Fix:** Add a hex literal token before `NUM_INT`:

```python
('HEX_NUM',  r'0x[0-9A-Fa-f]+'),  # Hex number — must precede NUM_INT
```

### A.3 Missing `if` / `else` Keywords

The pseudocode for `lsm6ds_fifo` uses `if` statements: `if(N>maxN){N=maxN;}`. There is no `IF` token in the lexer — `if` is matched as an `ID`. This works because all three code generators (C++, Python, TypeScript) pass `ID` tokens through verbatim, and `if` is a valid keyword in all three languages.

However, this means `if` doesn't get a trailing space in the generated C++/TypeScript like `while` does. The output is `if(N>maxN)` (no space — cosmetically fine but inconsistent). If readability of generated code matters, adding `IF` and `ELSE` keyword tokens would allow consistent formatting.

### A.4 `generate_python_code` — Potential Index Out of Range

In `generate_python_code()`, line:

```python
elif token_type == "ID" and tokens[i + 1][0] == "ASSIGN":
```

This accesses `tokens[i + 1]` without checking that `i + 1 < len(tokens)`. If an `ID` token is the last token, this will raise an `IndexError`. Not a problem with current pseudocode strings, but could bite if new pseudocode is added.

### A.5 `is_attr_type_signed` Operator Precedence

In `DecodeGenerator.py`:

```python
attrStr = attrType[1] if attrType[0] == ">" or attrType[0] == "<" and len(attrType) > 1 else attrType[0]
```

Due to Python's operator precedence, `or` binds less tightly than `and`, so this is parsed as:

```python
attrStr = attrType[1] if (attrType[0] == ">" or (attrType[0] == "<" and len(attrType) > 1)) else attrType[0]
```

This means for `">"` (length 1), it will try `attrType[1]` and raise an `IndexError`. In practice this never happens because endianness-prefixed types are always 2+ chars (e.g. `">h"`) and single-char types like `"B"` or `"b"` don't start with `>` or `<`. But the logic doesn't match the intent. **Fix:**

```python
attrStr = attrType[1] if (attrType[0] == ">" or attrType[0] == "<") and len(attrType) > 1 else attrType[0]
```

### A.6 Swapped Comments in `pystruct_map`

In `DecodeGenerator.py`:

```python
'b': ['int8_t', 'getUInt8AndInc'],          # Signed byte
'B': ['uint8_t', 'getInt8AndInc'],          # Unsigned byte
```

The extraction function names are swapped: `'b'` (signed) maps to `getUInt8AndInc` and `'B'` (unsigned) maps to `getInt8AndInc`. The comments are correct about the types, but the function names suggest the wrong signedness. This may be intentional (extract unsigned, then sign-extend later) or may be a subtle bug depending on how `getUInt8AndInc` / `getInt8AndInc` are implemented in the firmware.

### A.7 `generate_typescript_code` Doesn't Handle `INT`/`FLOAT` Keywords

The TypeScript code generator in `PseudocodeHandler.py` doesn't have cases for `INT` or `FLOAT` token types (unlike the C++ generator which outputs them as-is, or the Python generator which skips them). When run via the `__main__` block with `--lang typescript`, the substitutions dict maps `"int"` and `"float"` to `"let "`, but these are applied as regex substitutions on token *values* in the `else` branch — meaning they'd also match identifiers containing "int" or "float" (e.g. a variable named `interval` would become `letval`).

This is not a problem for the raftjs transpiler (which will have its own implementation), but the Python TypeScript generator should use token-type checks rather than value-based regex substitutions for keyword handling.
