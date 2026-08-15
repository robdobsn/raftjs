// Regression vectors from the 2026-08-14/15 bench calibration of the reworked VCP hardware.
import { computeNewChannelCal, packCalBlock, VCP_DEFAULT_CAL } from '../examples/dashboard/src/visualizers/vcpCalMath';

describe('vcpCalMath', () => {
    // Pre-rework defaults that were active when the bench fits were measured
    const oldVoltage = { zero: 16384, num: 15571, den: 10000, unit: 0 };
    const oldCurrent = { zero: 16384, num: 4262, den: 10000, unit: 1 };

    test('voltage fit y = 0.9645x - 0.0054 -> zero 16381, num 16144', () => {
        const cal = computeNewChannelCal(oldVoltage, { k: 0.9645, c: -0.0054 });
        expect(cal).toEqual({ zero: 16381, num: 16144, den: 10000, unit: 0 });
    });

    test('current fit y = 0.6135x - 0.0029 -> zero 16377, num 6947', () => {
        const cal = computeNewChannelCal(oldCurrent, { k: 0.6135, c: -0.0029 });
        expect(cal).toEqual({ zero: 16377, num: 6947, den: 10000, unit: 1 });
    });

    test('identity fit leaves constants unchanged', () => {
        const cal = computeNewChannelCal(oldVoltage, { k: 1, c: 0 });
        expect(cal).toEqual(oldVoltage);
    });

    test('invalid fits rejected', () => {
        expect(computeNewChannelCal(oldVoltage, { k: 0, c: 0 })).toBeNull();
        expect(computeNewChannelCal(oldVoltage, { k: NaN, c: 0 })).toBeNull();
        expect(computeNewChannelCal(oldVoltage, { k: 0.0001, c: 0 })).toBeNull();  // num overflow
    });

    test('packCalBlock layout matches VcpDeviceConfigPacked', () => {
        const block = packCalBlock(VCP_DEFAULT_CAL);
        expect(block.length).toBe(36);
        expect(Array.from(block.slice(0, 4))).toEqual([0xC1, 0x01, 0x01, 0x00]);
        // ch0: zero 16381 = 0x3FFD, num 16144 = 0x3F10, den 10000 = 0x2710, mV
        expect(Array.from(block.slice(4, 12))).toEqual([0x3F, 0xFD, 0x3F, 0x10, 0x27, 0x10, 0x00, 0x00]);
        // ch3: zero 16377 = 0x3FF9, num 6947 = 0x1B23, den 10000 = 0x2710, mA
        expect(Array.from(block.slice(28, 36))).toEqual([0x3F, 0xF9, 0x1B, 0x23, 0x27, 0x10, 0x01, 0x00]);
    });

    test('negative zero code packs as two\'s complement', () => {
        const block = packCalBlock([{ zero: -1, num: -2, den: 3, unit: 0 },
            ...VCP_DEFAULT_CAL.slice(1)]);
        expect(Array.from(block.slice(4, 10))).toEqual([0xFF, 0xFF, 0xFF, 0xFE, 0x00, 0x03]);
    });
});
