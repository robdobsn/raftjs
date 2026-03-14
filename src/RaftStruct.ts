/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftStruct
// Part of RaftJS
//
// Rob Dobson 2024
// (C) 2024 All rights reserved
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

type FormatInstruction = 
    | { kind: "endian"; littleEndian: boolean }
    | { kind: "spec"; code: string; repeat: number };

function parseFormatInstructions(format: string): FormatInstruction[] {
    const instructions: FormatInstruction[] = [];
    let idx = 0;

    while (idx < format.length) {

        const char = format[idx];

        // Endianness specifiers
        if (char === "<" || char === ">") {
            instructions.push({ kind: "endian", littleEndian: char === "<" });
            idx++;
            continue;
        }

        // Ignore whitespace
        if (/\s/.test(char)) {
            idx++;
            continue;
        }

        // Check for prefix digit count (e.g. 3H, 16s)
        let repeat = 1;
        if (/\d/.test(char)) {
            let numStr = char;
            idx++;
            while (idx < format.length && /\d/.test(format[idx])) {
                numStr += format[idx];
                idx++;
            }
            repeat = parseInt(numStr, 10);
            if (!Number.isFinite(repeat) || repeat <= 0) {
                throw new Error(`Invalid prefix count "${numStr}" in format string "${format}"`);
            }
            if (idx >= format.length || /[\s<>\d]/.test(format[idx])) {
                throw new Error(`Expected format code after prefix count "${numStr}" in format string "${format}"`);
            }
        }

        // Attribute code
        const code = /\d/.test(char) ? format[idx] : char;
        if (/\d/.test(char)) idx++; else idx++;

        // Check for [N] suffix count (e.g. B[3]) — multiplied with any prefix count
        if (idx < format.length && format[idx] === "[") {
            const endIdx = format.indexOf("]", idx + 1);
            if (endIdx === -1) {
                throw new Error(`Invalid format string: missing closing ] in "${format}"`);
            }
            const repeatStr = format.slice(idx + 1, endIdx);
            const bracketRepeat = parseInt(repeatStr, 10);
            if (!Number.isFinite(bracketRepeat) || bracketRepeat <= 0) {
                throw new Error(`Invalid repeat count "${repeatStr}" in format string "${format}"`);
            }
            repeat *= bracketRepeat;
            idx = endIdx + 1;
        }

        instructions.push({ kind: "spec", code, repeat });
    }

    return instructions;
}

export function structUnpack(format: string, data: Uint8Array): (number | string)[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const results: (number | string)[] = [];
    let offset = 0;
    let littleEndian = false;

    const instructions = parseFormatInstructions(format);

    for (const instruction of instructions) {
        if (instruction.kind === "endian") {
            littleEndian = instruction.littleEndian;
            continue;
        }

        const { code, repeat } = instruction;

        for (let count = 0; count < repeat; count++) {
            switch (code) {
                case "x": // Padding byte
                    offset += 1;
                    break;
                case "c": // Char
                case "B": // Unsigned 8-bit integer
                case "?": // Boolean (stored as uint8)
                    results.push(view.getUint8(offset));
                    offset += 1;
                    break;
                case "b": // Signed 8-bit integer
                    results.push(view.getInt8(offset));
                    offset += 1;
                    break;
                case "h": // Signed 16-bit integer
                    results.push(view.getInt16(offset, littleEndian));
                    offset += 2;
                    break;
                case "H": // Unsigned 16-bit integer
                    results.push(view.getUint16(offset, littleEndian));
                    offset += 2;
                    break;
                case "i": // Signed 32-bit integer
                case "l": // Signed 32-bit integer
                    results.push(view.getInt32(offset, littleEndian));
                    offset += 4;
                    break;
                case "I": // Unsigned 32-bit integer
                case "L": // Unsigned 32-bit integer
                    results.push(view.getUint32(offset, littleEndian));
                    offset += 4;
                    break;
                case "q": // Signed 64-bit integer
                    results.push(Number(view.getBigInt64(offset, littleEndian)));
                    offset += 8;
                    break;
                case "Q": // Unsigned 64-bit integer
                    results.push(Number(view.getBigUint64(offset, littleEndian)));
                    offset += 8;
                    break;
                case "f": // 32-bit float
                    results.push(view.getFloat32(offset, littleEndian));
                    offset += 4;
                    break;
                case "d": // 64-bit float
                    results.push(view.getFloat64(offset, littleEndian));
                    offset += 8;
                    break;
                case "s": { // Byte string (repeat = byte length, produces one string value)
                    const bytes = data.slice(offset, offset + repeat);
                    // Trim trailing null bytes for C-string compatibility
                    let end = bytes.length;
                    while (end > 0 && bytes[end - 1] === 0) end--;
                    results.push(new TextDecoder().decode(bytes.subarray(0, end)));
                    offset += repeat;
                    break;
                }
                default:
                    throw new Error(`Unknown format character: ${code}`);
            }
            // For 's', the repeat is consumed as byte-length in one go
            if (code === "s") break;
        }
    }

    return results;
}

export function structSizeOf(format: string): number {
    let size = 0;
    const instructions = parseFormatInstructions(format);

    for (const instruction of instructions) {
        if (instruction.kind === "endian") {
            continue;
        }

        const { code, repeat } = instruction;
        let unitSize: number;

        switch (code) {
            case "x": // Padding byte
            case "c": // Char
            case "b": // Signed 8-bit integer
            case "B": // Unsigned 8-bit integer
            case "?": // Boolean (uint8)
                unitSize = 1;
                break;
            case "h": // Signed 16-bit integer
            case "H": // Unsigned 16-bit integer
                unitSize = 2;
                break;
            case "i": // Signed 32-bit integer
            case "I": // Unsigned 32-bit integer
            case "l": // Signed 32-bit integer
            case "L": // Unsigned 32-bit integer
                unitSize = 4;
                break;
            case "q": // Signed 64-bit integer
            case "Q": // Unsigned 64-bit integer
                unitSize = 8;
                break;
            case "f": // 32-bit float
                unitSize = 4;
                break;
            case "d": // 64-bit float
                unitSize = 8;
                break;
            case "s": // Byte string (repeat = byte length)
                size += repeat;
                continue;
            default:
                throw new Error(`Unknown format character: ${code}`);
        }

        size += unitSize * repeat;
    }
    return size;
}

export function structPack(format: string, values: (number | string | Uint8Array)[]): Uint8Array {
    const size = structSizeOf(format);
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    let offset = 0;
    let littleEndian = false;

    const instructions = parseFormatInstructions(format);
    let valueIdx = 0;

    for (const instruction of instructions) {
        if (instruction.kind === "endian") {
            littleEndian = instruction.littleEndian;
            continue;
        }

        const { code, repeat } = instruction;

        for (let count = 0; count < repeat; count++) {
            switch (code) {
                case "x": // Padding byte
                    offset += 1;
                    break;
                case "c": // Char
                case "b": // Signed 8-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setInt8(offset, values[valueIdx++] as number);
                    offset += 1;
                    break;
                case "B": // Unsigned 8-bit integer
                case "?": // Boolean (uint8)
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setUint8(offset, values[valueIdx++] as number);
                    offset += 1;
                    break;
                case "h": // Signed 16-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setInt16(offset, values[valueIdx++] as number, littleEndian);
                    offset += 2;
                    break;
                case "H": // Unsigned 16-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setUint16(offset, values[valueIdx++] as number, littleEndian);
                    offset += 2;
                    break;
                case "i": // Signed 32-bit integer
                case "l": // Signed 32-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setInt32(offset, values[valueIdx++] as number, littleEndian);
                    offset += 4;
                    break;
                case "I": // Unsigned 32-bit integer
                case "L": // Unsigned 32-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setUint32(offset, values[valueIdx++] as number, littleEndian);
                    offset += 4;
                    break;
                case "q": // Signed 64-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setBigInt64(offset, BigInt(values[valueIdx++] as number), littleEndian);
                    offset += 8;
                    break;
                case "Q": // Unsigned 64-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setBigUint64(offset, BigInt(values[valueIdx++] as number), littleEndian);
                    offset += 8;
                    break;
                case "f": // 32-bit float
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setFloat32(offset, values[valueIdx++] as number, littleEndian);
                    offset += 4;
                    break;
                case "d": // 64-bit float
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setFloat64(offset, values[valueIdx++] as number, littleEndian);
                    offset += 8;
                    break;
                case "s": { // Byte string (repeat = byte length, consumes one value)
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    const val = values[valueIdx++];
                    let bytes: Uint8Array;
                    if (val instanceof Uint8Array) {
                        bytes = val;
                    } else if (typeof val === "string") {
                        bytes = new TextEncoder().encode(val);
                    } else {
                        throw new Error(`Expected string or Uint8Array for 's' format, got number`);
                    }
                    // Copy bytes, zero-pad if shorter than repeat
                    const copyLen = Math.min(bytes.length, repeat);
                    for (let j = 0; j < copyLen; j++) {
                        view.setUint8(offset + j, bytes[j]);
                    }
                    for (let j = copyLen; j < repeat; j++) {
                        view.setUint8(offset + j, 0);
                    }
                    offset += repeat;
                    break;
                }
                default:
                    throw new Error(`Unknown format character: ${code}`);
            }
            // For 's', the repeat is consumed as byte-length in one go
            if (code === "s") break;
        }
    }

    return new Uint8Array(buffer);
}
