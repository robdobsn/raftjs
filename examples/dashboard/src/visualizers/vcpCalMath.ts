/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// vcpCalMath
// Pure helpers for the VCP calibration visualizer: invert an Excel-style straight-line
// fit (reading = k*true + c, measured with the CURRENT calibration active) into new
// per-channel calibration constants, and pack the firmware's 36-byte cal block.
//
// Firmware conversion (VcpCalibration): value_mUnits = (code - zero) * num / den
// Fit inversion: true = (reading - c)/k  =>  num' = num/k, zero' = zero + c_mUnits*den/num
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface VcpChannelCal {
    zero: number;       // raw signed ADC code at zero input
    num: number;        // slope numerator (signed)
    den: number;        // slope denominator (unsigned, non-zero)
    unit: number;       // 0 = mV, 1 = mA
}

export interface VcpChannelFit {
    k: number;          // Excel fit slope (reading = k*true + c)
    c: number;          // Excel fit intercept in engineering units (V or A)
}

export const VCP_NUM_CHANNELS = 4;
export const VCP_CHANNEL_NAMES = ['V1', 'V2', 'V3', 'I'];

// Compiled-in firmware defaults (MultiFirmware VcpCalibration::loadDefaults, 2026-08 hardware)
export const VCP_DEFAULT_CAL: VcpChannelCal[] = [
    { zero: 16381, num: 16144, den: 10000, unit: 0 },
    { zero: 16381, num: 16144, den: 10000, unit: 0 },
    { zero: 16381, num: 16144, den: 10000, unit: 0 },
    { zero: 16377, num: 6947, den: 10000, unit: 1 },
];

// Apply a fit to one channel's current constants; returns null if invalid
export function computeNewChannelCal(current: VcpChannelCal, fit: VcpChannelFit): VcpChannelCal | null {
    if (!isFinite(fit.k) || !isFinite(fit.c) || fit.k === 0 || current.num === 0 || current.den === 0) {
        return null;
    }
    const num = Math.round(current.num / fit.k);
    // c is in V or A; firmware units are mV/mA
    const zero = Math.round(current.zero + (fit.c * 1000 * current.den) / current.num);
    if (num === 0 || num < -32768 || num > 32767) return null;
    if (zero < -32768 || zero > 32767) return null;
    return { zero, num, den: current.den, unit: current.unit };
}

// Pack the full 36-byte VcpDeviceConfigPacked block (big-endian, calStatus=1)
export function packCalBlock(cals: VcpChannelCal[]): Uint8Array {
    const block = new Uint8Array(4 + VCP_NUM_CHANNELS * 8);
    block[0] = 0xC1;    // VCP_CAL_MAGIC
    block[1] = 0x01;    // VCP_CAL_VERSION
    block[2] = 0x01;    // calStatus = calibrated
    block[3] = 0x00;    // reserved
    for (let ch = 0; ch < VCP_NUM_CHANNELS; ch++) {
        const cal = cals[ch];
        const off = 4 + ch * 8;
        const zeroU16 = cal.zero & 0xFFFF;
        const numU16 = cal.num & 0xFFFF;
        const denU16 = cal.den & 0xFFFF;
        block[off] = (zeroU16 >> 8) & 0xFF;
        block[off + 1] = zeroU16 & 0xFF;
        block[off + 2] = (numU16 >> 8) & 0xFF;
        block[off + 3] = numU16 & 0xFF;
        block[off + 4] = (denU16 >> 8) & 0xFF;
        block[off + 5] = denU16 & 0xFF;
        block[off + 6] = cal.unit & 0xFF;
        block[off + 7] = 0;
    }
    return block;
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Unpack a 36-byte block read back from the board. Returns null if malformed;
// calibrated=false means the board is running its compiled-in defaults.
export function unpackCalBlock(block: Uint8Array): { cals: VcpChannelCal[]; calibrated: boolean } | null {
    if (block.length < 4 + VCP_NUM_CHANNELS * 8) return null;
    if (block[0] !== 0xC1 || block[1] !== 0x01) return null;
    const s16 = (hi: number, lo: number) => ((hi << 8) | lo) << 16 >> 16;
    const cals: VcpChannelCal[] = [];
    for (let ch = 0; ch < VCP_NUM_CHANNELS; ch++) {
        const off = 4 + ch * 8;
        cals.push({
            zero: s16(block[off], block[off + 1]),
            num: s16(block[off + 2], block[off + 3]),
            den: (block[off + 4] << 8) | block[off + 5],
            unit: block[off + 6],
        });
    }
    return { cals, calibrated: block[2] !== 0 };
}
