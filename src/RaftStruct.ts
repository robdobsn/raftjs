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

        // Attribute code
        const code = char;
        idx++;

        // Check for repeat count using [N] syntax
        let repeat = 1;
        if (idx < format.length && format[idx] === "[") {
            const endIdx = format.indexOf("]", idx + 1);
            if (endIdx === -1) {
                throw new Error(`Invalid format string: missing closing ] in "${format}"`);
            }
            const repeatStr = format.slice(idx + 1, endIdx);
            repeat = parseInt(repeatStr, 10);
            if (!Number.isFinite(repeat) || repeat <= 0) {
                throw new Error(`Invalid repeat count "${repeatStr}" in format string "${format}"`);
            }
            idx = endIdx + 1;
        }

        instructions.push({ kind: "spec", code, repeat });
    }

    return instructions;
}

export function structUnpack(format: string, data: Uint8Array): number[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const results: number[] = [];
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
                // case "q": // Signed 64-bit integer
                //     results.push(Number(view.getBigInt64(offset, littleEndian)));
                //     offset += 8;
                //     break;
                // case "Q": // Unsigned 64-bit integer
                //     results.push(Number(view.getBigUint64(offset, littleEndian)));
                //     offset += 8;
                //     break;
                case "f": // 32-bit float
                    results.push(view.getFloat32(offset, littleEndian));
                    offset += 4;
                    break;
                case "d": // 64-bit float
                    results.push(view.getFloat64(offset, littleEndian));
                    offset += 8;
                    break;
                default:
                    throw new Error(`Unknown format character: ${code}`);
            }
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
            // case "q": // Signed 64-bit integer
            // case "Q": // Unsigned 64-bit integer
            //     unitSize = 8;
            //     break;
            case "f": // 32-bit float
                unitSize = 4;
                break;
            case "d": // 64-bit float
                unitSize = 8;
                break;
            default:
                throw new Error(`Unknown format character: ${code}`);
        }

        size += unitSize * repeat;
    }
    return size;
}

export function structPack(format: string, values: number[]): Uint8Array {
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
                    view.setInt8(offset, values[valueIdx++]);
                    offset += 1;
                    break;
                case "B": // Unsigned 8-bit integer
                case "?": // Boolean (uint8)
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setUint8(offset, values[valueIdx++]);
                    offset += 1;
                    break;
                case "h": // Signed 16-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setInt16(offset, values[valueIdx++], littleEndian);
                    offset += 2;
                    break;
                case "H": // Unsigned 16-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setUint16(offset, values[valueIdx++], littleEndian);
                    offset += 2;
                    break;
                case "i": // Signed 32-bit integer
                case "l": // Signed 32-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setInt32(offset, values[valueIdx++], littleEndian);
                    offset += 4;
                    break;
                case "I": // Unsigned 32-bit integer
                case "L": // Unsigned 32-bit integer
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setUint32(offset, values[valueIdx++], littleEndian);
                    offset += 4;
                    break;
                // case "q": // Signed 64-bit integer
                //     view.setBigInt64(offset, BigInt(values[valueIdx++]), littleEndian);
                //     offset += 8;
                //     break;
                // case "Q": // Unsigned 64-bit integer
                //     view.setBigUint64(offset, BigInt(values[valueIdx++]), littleEndian);
                //     offset += 8;
                //     break;
                case "f": // 32-bit float
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setFloat32(offset, values[valueIdx++], littleEndian);
                    offset += 4;
                    break;
                case "d": // 64-bit float
                    if (valueIdx >= values.length) {
                        throw new Error("Insufficient values provided for structPack");
                    }
                    view.setFloat64(offset, values[valueIdx++], littleEndian);
                    offset += 8;
                    break;
                default:
                    throw new Error(`Unknown format character: ${code}`);
            }
        }
    }

    return new Uint8Array(buffer);
}
