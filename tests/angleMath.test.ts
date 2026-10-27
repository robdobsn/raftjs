// Angle visualizer maths: unwrapping into total rotation, turns, and magnet status
import {
    ANGLE_UNWRAP_START, magnetStatus, turnsOf, unwrapAngles, wrappedDelta,
} from '../examples/dashboard/src/visualizers/angleMath';

describe('wrappedDelta', () => {
    test('the shorter way round', () => {
        expect(wrappedDelta(10, 20)).toBe(10);
        expect(wrappedDelta(350, 10)).toBe(20);
        expect(wrappedDelta(10, 350)).toBe(-20);
        expect(wrappedDelta(0, 180)).toBe(180);
        expect(wrappedDelta(180, 0)).toBe(180);
    });
});

describe('unwrapAngles', () => {
    test('starts at the first reading', () => {
        expect(unwrapAngles(ANGLE_UNWRAP_START, [42])).toEqual({ total: 42, lastRaw: 42 });
    });

    test('counts turns forward and back through the wrap', () => {
        let s = unwrapAngles(ANGLE_UNWRAP_START, [0, 90, 180, 270, 359, 10, 100]);
        expect(s.total).toBe(460);
        s = unwrapAngles(s, [10, 350, 260]);
        expect(s.total).toBe(260);
        s = unwrapAngles(s, [170, 80, 350, 260]);
        expect(s.total).toBe(-100);
    });

    test('skips readings that aren\'t finite', () => {
        const s = unwrapAngles(ANGLE_UNWRAP_START, [NaN, 20, Infinity, 30]);
        expect(s).toEqual({ total: 30, lastRaw: 30 });
    });

    test('carries on from a saved state', () => {
        const a = unwrapAngles(ANGLE_UNWRAP_START, [300, 340]);
        const b = unwrapAngles(a, [20, 60]);
        expect(b.total).toBe(420);
    });
});

describe('turnsOf', () => {
    test('whole turns toward zero', () => {
        expect(turnsOf(725)).toEqual({ turns: 2, remainder: 5 });
        expect(turnsOf(-370)).toEqual({ turns: -1, remainder: -10 });
        expect(turnsOf(90)).toEqual({ turns: 0, remainder: 90 });
    });
});

describe('magnetStatus', () => {
    test('from the flags', () => {
        expect(magnetStatus()).toBe('unknown');
        expect(magnetStatus(true, false, false)).toBe('ok');
        expect(magnetStatus(false, false, false)).toBe('none');
        expect(magnetStatus(false, true, false)).toBe('weak');
        expect(magnetStatus(true, false, true)).toBe('strong');
        expect(magnetStatus(undefined, true)).toBe('weak');
    });
});
