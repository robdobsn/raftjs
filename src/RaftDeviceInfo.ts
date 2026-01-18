/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftDeviceInfo
// Device information for Raft devices
//
// Rob Dobson (C) 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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

export function decodeAttrUnitsEncoding(unitsEncoding: string): string {
    // Replace instances of HTML encoded chars like &deg; with the actual char
    return unitsEncoding.replace(/&deg;/g, "°");
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
    v?: boolean | number;           // Visibility of the attribute in all locations (mainly used to hide attributes that are not useful to the user)
    vs?: boolean | number;          // Display attribute value in time-series graphs
    vf?: boolean | number;          // Display attribute value in the device info panel
    vft?: string;                   // Attribute validity based on the value of another named attribute
    lut?: Array<LUTRow>;            // Lookup table for the attribute value - each row is a lookup table for a range of values e.g. [{"r":"0x20-0x30","v":0},{"r":"1,2,3","v":42},{r:"","v":1}]
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

export interface DeviceTypeAction {
    n: string;                      // Action name
    t?: string;                     // Action type using python struct module format (e.g. 'H' for unsigned short, 'h' for signed short, 'f' for float etc.)
    w: string;                      // Prefix to write to cmd API
    wz?: string;                    // Postfix to write to cmd API
    r?: number[];                   // Range of valid values for the action
    f?: string;                     // Custom formatting options (e.g. LEDPIX for LED pixel grid)
    NX?: number;                    // Number of X in the LED pixel grid
    NY?: number;                    // Number of Y in the LED pixel grid
    concat?: boolean;               // Concatenate the all values into a single command
    mul?: number;                   // Multiplier to apply
    sub?: number;                   // Value to subtract before multiplying
    d?: number;                     // Default value
}

export interface DeviceTypeInfo {
    name: string;
    desc: string;
    manu: string;
    type: string;
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
    devinfo: DeviceTypeInfo;
  };
