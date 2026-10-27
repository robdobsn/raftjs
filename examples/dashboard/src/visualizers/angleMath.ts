/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// angleMath
// Pure helpers for the angle visualizer: unwrapping a 0-360 angle into total rotation (turn counting), and the magnet
// status of a magnetic angle sensor (e.g. AS5600) from its status flags. No DOM or React.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Rotation state: the total angle turned (degrees, unwrapped) and the last raw reading it came from
export interface AngleUnwrap {
    total: number;
    lastRaw: number | undefined;
}

export const ANGLE_UNWRAP_START: AngleUnwrap = { total: 0, lastRaw: undefined };

// The change from one reading to the next, taken as the shorter way round a circle of span degrees
export function wrappedDelta(from: number, to: number, span = 360): number {
    let d = (to - from) % span;
    if (d > span / 2) d -= span;
    if (d <= -span / 2) d += span;
    return d;
}

// Add readings (in order) to the rotation: each step is the shorter way round, so turning faster than half a turn
// between samples counts the wrong way. Readings that aren't finite are skipped
export function unwrapAngles(state: AngleUnwrap, readings: number[], span = 360): AngleUnwrap {
    let { total, lastRaw } = state;
    for (const raw of readings) {
        if (!Number.isFinite(raw)) continue;
        if (lastRaw === undefined) {
            total = raw;
        } else {
            total += wrappedDelta(lastRaw, raw, span);
        }
        lastRaw = raw;
    }
    return { total, lastRaw };
}

// Whole turns and the remaining angle of a total rotation (turns toward zero, so -370 is -1 turn and -10)
export function turnsOf(total: number, span = 360): { turns: number; remainder: number } {
    const turns = Math.trunc(total / span);
    return { turns, remainder: total - turns * span };
}

// The magnet status of a magnetic angle sensor from its flags (undefined where the device doesn't report one)
export type MagnetStatus = 'ok' | 'none' | 'weak' | 'strong' | 'unknown';

export function magnetStatus(detected?: boolean, tooWeak?: boolean, tooStrong?: boolean): MagnetStatus {
    if (detected === undefined && tooWeak === undefined && tooStrong === undefined) return 'unknown';
    if (tooWeak) return 'weak';
    if (tooStrong) return 'strong';
    if (detected === false) return 'none';
    return 'ok';
}

export const MAGNET_STATUS_TEXT: Record<MagnetStatus, string> = {
    ok: 'magnet OK',
    none: 'no magnet',
    weak: 'magnet too far (weak)',
    strong: 'magnet too close (strong)',
    unknown: '',
};
