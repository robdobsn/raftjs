// Heart rate / SpO2 / HRV from synthetic PPG (shaped like the 2026-10-24 bench: fingertip IR about 196000 with a
// pulse of about 1700 peak to peak; nothing in front about 2400 IR, 1500 red)
import { analyseHrm, spo2FromRatio, acceptIbis, hrvStats, HrmInput } from '../examples/dashboard/src/visualizers/hrmMath';

// Deterministic noise
function makeRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296 - 0.5;
    };
}

// Pulse shape: systolic peak at each beat, smaller diastolic peak after it (0..about 1)
function pulseShape(t: number, beatsS: number[]): number {
    let v = 0;
    for (let i = 0; i < beatsS.length; i++) {
        const tb = beatsS[i];
        const period = (beatsS[i + 1] ?? tb + 0.8) - tb;
        const ds = t - tb;
        if (ds < -0.5 || ds > 1.5) continue;
        v += Math.exp(-(ds * ds) / (2 * 0.08 * 0.08));
        const dd = ds - 0.35 * period;
        v += 0.35 * Math.exp(-(dd * dd) / (2 * 0.1 * 0.1));
    }
    return v;
}

interface SynthOpts {
    fs: number;
    durationS: number;
    ibisS: number[];            // cycled
    irDc?: number; irAc?: number;
    redDc?: number; redAc?: number;
    noise?: number;             // peak to peak, counts
    drift?: number;             // 0.1 Hz baseline wander amplitude, counts
    fingerFromS?: number;       // finger off (ambient levels) before this
}

function synth(o: SynthOpts): { input: HrmInput; beatsS: number[] } {
    const rnd = makeRandom(1234);
    const beatsS: number[] = [];
    for (let t = 0.3, k = 0; t < o.durationS + 2; k++) {
        beatsS.push(t);
        t += o.ibisS[k % o.ibisS.length];
    }
    const timesS: number[] = [], ir: number[] = [], red: number[] = [];
    const irDc = o.irDc ?? 196000, irAc = o.irAc ?? 1700;
    const redDc = o.redDc ?? 120000, redAc = o.redAc ?? 0;
    for (let i = 0; i < o.durationS * o.fs; i++) {
        const t = i / o.fs;
        const on = t >= (o.fingerFromS ?? 0);
        const p = pulseShape(t, beatsS);
        const wander = (o.drift ?? 0) * Math.sin(2 * Math.PI * 0.1 * t);
        timesS.push(100 + t);
        ir.push(on ? irDc - irAc * p + wander + (o.noise ?? 0) * rnd() : 2400);
        red.push(on ? redDc - redAc * p + wander * redDc / irDc + (o.noise ?? 0) * rnd() * 0.5 : 1500);
    }
    return { input: { timesS, ir, red }, beatsS };
}

describe('hrmMath', () => {
    test('72 bpm at 25 samples/s with noise and baseline wander', () => {
        const { input } = synth({ fs: 25, durationS: 20, ibisS: [60 / 72], noise: 200, drift: 2000 });
        const r = analyseHrm(input);
        expect(r.status).toBe('ok');
        expect(r.pulseChannel).toBe('ir');
        expect(r.sampleRateHz).toBeCloseTo(25, 3);
        expect(r.bpm!).toBeGreaterThan(70);
        expect(r.bpm!).toBeLessThan(74);
        expect(r.confidence).toBeGreaterThan(0.7);
        expect(r.perfusionIndex!).toBeGreaterThan(0.6);
        expect(r.perfusionIndex!).toBeLessThan(1.2);
    });

    test.each([6.25, 12.5, 50, 100])('rates from 45 to 150 bpm at %p samples/s', (fs) => {
        for (const bpm of [45, 90, 150]) {
            // At least 3 samples a beat
            if (bpm / 60 > fs / 3) continue;
            const { input } = synth({ fs, durationS: 20, ibisS: [60 / bpm], noise: 100 });
            const r = analyseHrm(input);
            expect(r.status).toBe('ok');
            expect(Math.abs(r.bpm! - bpm)).toBeLessThan(0.04 * bpm);
        }
    });

    test('SpO2 from the ratio of ratios', () => {
        // Red AC/DC half the IR AC/DC: R = 0.5
        const redAc = 0.5 * (1700 / 196000) * 120000;
        const { input } = synth({ fs: 25, durationS: 15, ibisS: [0.8], redAc, noise: 50 });
        const r = analyseHrm(input);
        expect(r.ratioR!).toBeCloseTo(0.5, 1);
        expect(r.spo2!).toBeCloseTo(spo2FromRatio(0.5)!, 0);
        expect(spo2FromRatio(0.5)!).toBeCloseTo(98.76, 1);
    });

    test('no SpO2 with the red LED off; red alone gives the heart rate', () => {
        const { input } = synth({ fs: 25, durationS: 15, ibisS: [0.75], redAc: 400 });
        const redOff = analyseHrm({ ...input, red: input.red!.map(() => 30) });
        expect(redOff.status).toBe('ok');
        expect(redOff.spo2).toBeUndefined();
        const redOnly = analyseHrm({ timesS: input.timesS, red: input.red, ir: input.ir!.map(() => 20) });
        expect(redOnly.pulseChannel).toBe('red');
        expect(Math.abs(redOnly.bpm! - 80)).toBeLessThan(2);
    });

    test('HRV from alternating intervals', () => {
        // IBIs 0.8, 0.9, 0.8 ...: RMSSD 100 ms, SDNN about 50 ms
        const { input } = synth({ fs: 25, durationS: 30, ibisS: [0.8, 0.9], noise: 50 });
        const r = analyseHrm(input);
        expect(r.numIbis).toBeGreaterThan(25);
        expect(Math.abs(r.rmssdMs! - 100)).toBeLessThan(15);
        expect(Math.abs(r.sdnnMs! - 50)).toBeLessThan(10);
    });

    test('no finger, then settling after the finger is placed', () => {
        const off = synth({ fs: 25, durationS: 10, ibisS: [0.8], fingerFromS: 20 });
        expect(analyseHrm(off.input).status).toBe('nofinger');
        const placed = synth({ fs: 25, durationS: 10, ibisS: [0.8], fingerFromS: 7 });
        const r = analyseHrm(placed.input);
        expect(r.status).toBe('settling');
        expect(r.pulseChannel).toBe('ir');
        // Once placed long enough, the step in level doesn't upset the rate
        const later = analyseHrm(synth({ fs: 25, durationS: 20, ibisS: [0.8], fingerFromS: 7 }).input);
        expect(later.status).toBe('ok');
        expect(Math.abs(later.bpm! - 75)).toBeLessThan(2);
    });

    test('no pulse from a finger-level signal of noise', () => {
        const { input } = synth({ fs: 25, durationS: 15, ibisS: [0.8], irAc: 0, noise: 2000 });
        const r = analyseHrm(input);
        expect(r.status === 'nopulse' || r.confidence < 0.3).toBe(true);
    });

    test('a gap in the data restarts the segment', () => {
        const { input } = synth({ fs: 25, durationS: 20, ibisS: [0.8] });
        const timesS = input.timesS.map((t, i) => i >= 420 ? t + 5 : t);
        const r = analyseHrm({ ...input, timesS });
        expect(r.status).toBe('settling');
        expect(r.segmentS).toBeCloseTo(3.2, 1);
    });

    test('IBI rejection and HRV need enough intervals', () => {
        const ibis = acceptIbis([0, 0.8, 1.6, 3.2, 4.0, 4.1, 4.8], 0.3, 1.5);
        expect(ibis.map(v => v === null ? null : Math.round(v * 1000))).toEqual([800, 800, null, 800, null, 700]);
        expect(hrvStats(ibis).rmssdMs).toBeUndefined();
    });
});
