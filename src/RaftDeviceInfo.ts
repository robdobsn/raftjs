/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceInfo
// Device information for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { structPack } from "./RaftStruct";

const attrTypeBits: { [key: string]: number } = {
    "c": 8, "b": 8, "B": 8, "?": 8,
    "h": 16, "H": 16, ">h": 16, "<h": 16, ">H": 16, "<H": 16,
    "i": 32, "I": 32, ">i": 32, "<i": 32, ">I": 32, "<I": 32, "l": 32, "L": 32, ">l": 32, "<l": 32, ">L": 32, "<L": 32,
    "q": 64, "Q": 64, ">q": 64, "<q": 64, ">Q": 64, "<Q": 64,
    "f": 32, ">f": 32, "<f": 32,
    "d": 64, ">d": 64, "<d": 64,
    };

export function getAttrTypeBits(attrType: string): number {
    let repeat = 1;
    let baseAttrType = attrType;

    const repeatStartIdx = attrType.indexOf("[");
    if (repeatStartIdx >= 0) {
        const repeatEndIdx = attrType.indexOf("]", repeatStartIdx + 1);
        if (repeatEndIdx > repeatStartIdx) {
            const repeatStr = attrType.slice(repeatStartIdx + 1, repeatEndIdx);
            const parsedRepeat = parseInt(repeatStr, 10);
            if (Number.isFinite(parsedRepeat) && parsedRepeat > 0) {
                repeat = parsedRepeat;
            }
            baseAttrType = attrType.slice(0, repeatStartIdx);
        }
    }

    if (baseAttrType in attrTypeBits) {
        return attrTypeBits[baseAttrType] * repeat;
    }
    return 8 * repeat;
}

export function isAttrTypeSigned(attrType: string): boolean {
    const attrStr = attrType.charAt(0) === ">" || attrType.charAt(0) === "<" ? attrType.slice(1).charAt(0) : attrType.charAt(0);
    return attrStr === "b" || attrStr === "h" || attrStr === "i" || attrStr === "l" || attrStr === "q";
}

// Number of values a single sample of this attribute decodes to (array attributes
// like "B[9]" or "3H" decode to multiple values per sample; "16s" strings decode to one)
export function getAttrElemsPerSample(attrType: string): number {
    let idx = 0;
    if (attrType.charAt(0) === "<" || attrType.charAt(0) === ">") idx = 1;
    let numStr = "";
    while (idx < attrType.length && /\d/.test(attrType[idx])) {
        numStr += attrType[idx];
        idx++;
    }
    const prefix = numStr ? parseInt(numStr, 10) : 1;
    const code = attrType.charAt(idx);
    idx++;
    let bracket = 1;
    if (attrType.charAt(idx) === "[") {
        const endIdx = attrType.indexOf("]", idx + 1);
        if (endIdx > idx) {
            const n = parseInt(attrType.slice(idx + 1, endIdx), 10);
            if (Number.isFinite(n) && n > 0) bracket = n;
        }
    }
    // 's' consumes its repeat as byte length and yields one string; 'x' is padding
    if (code === "s" || code === "x") return 1;
    const total = (Number.isFinite(prefix) && prefix > 0 ? prefix : 1) * bracket;
    return total > 0 ? total : 1;
}

const UNITS_NAMED_ENTITIES: Record<string, string> = {
    deg: "°", micro: "µ", ohm: "Ω", Omega: "Ω", omega: "ω",
    Alpha: "Α", alpha: "α", Beta: "Β", beta: "β", Gamma: "Γ", gamma: "γ",
    Delta: "Δ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ",
    pi: "π", rho: "ρ", Sigma: "Σ", sigma: "σ", tau: "τ", phi: "φ", Phi: "Φ",
    plusmn: "±", times: "×", divide: "÷", middot: "·", permil: "‰",
    sup1: "¹", sup2: "²", sup3: "³", frac12: "½", frac14: "¼", frac34: "¾",
    percnt: "%", sol: "/", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
};

export function decodeAttrUnitsEncoding(unitsEncoding: string): string {
    // Replace HTML encoded chars like &deg;, &Omega;, &#937; or &#x3A9; with the actual char
    return unitsEncoding.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, ent: string) => {
        if (ent[0] === "#") {
            const code = (ent[1] === "x" || ent[1] === "X") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
        }
        return UNITS_NAMED_ENTITIES[ent] ?? match;
    });
}

export interface LUTRow {
    r: string;
    v: number;
}
export interface DeviceTypeAttribute {
    n: string;                      // Name
    t: string;                      // Type in python struct module format (e.g. 'H' uint16, 'h' int16, 'f' float etc.)
    at?: number | number[];         // Start pos in buffer (after timestamp) if present (otherwise use relative position) or array of byte positions for non-contiguous data
    u?: string;                     // Units (e.g. mm)
    r?: number[];                   // Range (either min, max or min, max, step or discrete values)
    x?: number | string;            // XOR bit mask to invert bits in the attribute value
    m?: number | string;            // AND bit mask to extract the attribute value from the message
    s?: number;                     // Shift value to shift the attribute value to the right (or left if negative)
    sb?: number;                    // Sign-bit position (0-based)
    ss?: number;                    // Sign-bit subtraction value
    d?: number;                     // Divisor to convert the raw attribute value (after operations above) to the actual value
    a?: number;                     // Value to add after division
    f?: string;                     // Format string similar to C printf format string (e.g. %d, %x, %f, %04d, %08x, %08.2f etc.), %b = boolean (0 iff 0, else 1)
    o?: string;                     // Type of output value (e.g. 'bool', 'uint8', 'float')
    el?: string[];                  // Element labels for array attributes (e.g. FFT band centre frequencies)
    eu?: string;                    // Element-axis units for array attributes (e.g. 'Hz'); u remains the value units
    vt?: string;                    // Visual type - names a specialized visualizer (e.g. 'spectrum', 'heatmap')
    vg?: string;                    // Visual group - attributes sharing a group render on the same timeline chart
    v?: boolean | number;           // Visibility of the attribute in all locations (mainly used to hide attributes that are not useful to the user)
    vs?: boolean | number;          // Display attribute value in time-series graphs
    vf?: boolean | number;          // Display attribute value in the device info panel
    vft?: string;                   // Attribute validity based on the value of another named attribute
    lut?: Array<LUTRow>;            // Lookup table for the attribute value - each row is a lookup table for a range of values e.g. [{"r":"0x20-0x30","v":0},{"r":"1,2,3","v":42},{r:"","v":1}]
    vl?: Record<string, string>;    // Value labels - display text for enumerated values, keyed by the decoded value e.g. {"1":"OK","2":"low"}
    bl?: Record<string, string>;    // Bit labels - display text for flag bits, keyed by bit mask e.g. {"0x04":"VL","0x10":"HD"}; "0" labels a value of 0
    resolution?: string;            
}

export interface CustomFunctionDefinition {
    n: string;                      // Function name
    c: string;                      // Function pseudo-code
    j?: string;                     // Optional JavaScript implementation
}

export interface DeviceTypePollRespMetadata {
    b: number;                      // Size of polled response data block in bytes (excluding timestamp)
    a: DeviceTypeAttribute[];       // Attributes in the polled response
    c?: CustomFunctionDefinition;   // Custom function definition
    us?: number;                    // Time between consecutive samples in microseconds 
}

export interface SampleRateResult {
    ok: boolean;
    requestedRateHz: number;
    actualRateHz: number;           // Closest supported rate from _conf.rate map
    intervalUs: number;             // Polling interval set
    numSamples: number;             // Buffer depth set
    error?: string;
}

export interface ActionMapEntry {
    w?: string;                     // Hex bytes to write (may contain &-separated multi-writes). A _conf.rate entry
                                    // may omit it: the rate then only sets the polling (i, s)
    i?: number;                     // Recommended polling interval in microseconds
    s?: number;                     // Recommended number of poll result samples (buffer depth)
}

export type ActionMapValue = string | ActionMapEntry;

export function getActionMapHex(entry: ActionMapValue): string {
    return typeof entry === 'string' ? entry : (entry.w ?? "");
}

export function getActionMapEntry(entry: ActionMapValue): ActionMapEntry | null {
    return typeof entry === 'object' ? entry : null;
}

/** Sensirion CRC-8 (polynomial 0x31, initial value 0xFF) of a 2-byte word */
export function sensirionCrc8(msb: number, lsb: number): number {
    let crc = 0xff;
    for (const byte of [msb, lsb]) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

/** Whether an action type is a single integer value (e.g. "B", ">H", "<i") */
export function isIntegerActionType(actionType: string): boolean {
    return /^[<>!=@]?[bBhHiIlLqQ]$/.test(actionType);
}

/**
 * The step for entering an action's value: the resolution the device takes. An integer type with mul (e.g. a
 * temperature offset in units of 0.01 degrees, mul 100) takes steps of 1/mul; without mul, whole numbers.
 * Other types (e.g. a float) take any value: "any"
 */
export function getActionInputStep(action: DeviceTypeAction): number | "any" {
    if (!action.t || !isIntegerActionType(action.t)) {
        return "any";
    }
    const mul = action.mul !== undefined && action.mul > 0 ? action.mul : 1;
    return 1 / mul;
}

/**
 * The hex bytes an action writes for the given data (an action without a map): the value(s) after sub and mul,
 * packed with t, then crc check bytes if the action has them, between the w prefix and the wz suffix.
 * Returns null if the data can't be encoded (crc8w needs whole 2-byte words)
 */
export function encodeActionWrite(action: DeviceTypeAction, data: number[]): string | null {
    let writeBytes: Uint8Array;
    if (data.length === 1) {
        let value = data[0];
        if (action.sub !== undefined) {
            value = value - action.sub;
        }
        if (action.mul !== undefined) {
            value = value * action.mul;
        }
        // Round for an integer type: packing truncates, and e.g. 0.29 * 100 is 28.999999999999996
        if (action.t && isIntegerActionType(action.t)) {
            value = Math.round(value);
        }
        writeBytes = action.t ? structPack(action.t, [value]) : new Uint8Array(0);
    } else {
        writeBytes = action.t ? structPack(action.t, data) : new Uint8Array(0);
    }
    if (action.crc === "crc8w") {
        if (writeBytes.length % 2 !== 0) {
            return null;
        }
        const withCrc: number[] = [];
        for (let i = 0; i < writeBytes.length; i += 2) {
            withCrc.push(writeBytes[i], writeBytes[i + 1], sensirionCrc8(writeBytes[i], writeBytes[i + 1]));
        }
        writeBytes = new Uint8Array(withCrc);
    } else if (action.crc !== undefined) {
        return null;
    }
    const hex = Array.from(writeBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return (action.w ? action.w : "") + hex + (action.wz ? action.wz : "");
}

export interface DeviceTypeAction {
    n: string;                      // Action name
    t?: string;                     // Action type using python struct module format (e.g. 'H' for unsigned short, 'h' for signed short, 'f' for float etc.)
    w: string;                      // Prefix to write to cmd API
    wz?: string;                    // Postfix to write to cmd API
    crc?: string;                   // Check bytes added to the encoded value: "crc8w" - a Sensirion CRC-8 after each 2-byte word
    r?: number[];                   // Range of valid values for the action
    f?: string;                     // Custom formatting options (e.g. LEDPIX for LED pixel grid)
    NX?: number;                    // Number of X in the LED pixel grid
    NY?: number;                    // Number of Y in the LED pixel grid
    concat?: boolean;               // Concatenate the all values into a single command
    mul?: number;                   // Multiplier to apply
    sub?: number;                   // Value to subtract before multiplying
    d?: number;                     // Default value
    map?: Record<string, ActionMapValue>; // Discrete value mapping (display value -> hex string or {w, i, s} object)
    desc?: string;                  // Human-readable description
    vt?: string;                    // Visual type - names a specialized visualizer (e.g. 'ledgrid')
}

export interface DeviceTypeInfo {
    /**
     * @deprecated The type display name, or the device name if one is assigned (it overwrites it) - use
     * typeDisplayName, or DeviceState.displayName / deviceName. Kept with its current meaning until a major version
     */
    name: string;
    /** The type display name (devInfoJson.name), never replaced by the device name */
    typeDisplayName?: string;
    /** The device type key (from the firmware's deviceTypeKey, or devInfoJson.type for older firmware) */
    deviceTypeKey?: string;
    desc: string;
    manu: string;
    type: string;
    role?: string;
    resp?: DeviceTypePollRespMetadata;
    clas?: Array<string>;
    actions?: DeviceTypeAction[];
}

export interface DeviceTypeInfoRecs {
    [devType: string]: DeviceTypeInfo;
}

export type RaftDevTypeInfoResponse = {
    req: string;
    rslt: string;
    devinfo?: DeviceTypeInfo;
    dtIdx?: number;
    deviceTypeKey?: string;     // device type key of the record (firmware from 2026-10-15)
    displayName?: string;       // name to show for the device (per-device lookup, firmware from 2026-10-16)
    name?: string;
    role?: string;
  };
