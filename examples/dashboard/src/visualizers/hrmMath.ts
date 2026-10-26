/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// hrmMath
// Heart rate, SpO2, perfusion index and heart-rate variability from reflectance photoplethysmography (PPG)
// samples, e.g. the red / IR / green channels of a MAX30101. Pure functions so they can be unit tested.
//
// Method (run on the samples since the finger was placed, or since the last gap in the data):
//   1. Pulse channel: the first of IR, green, red whose level shows a finger (fingerThreshold)
//   2. Band-pass 0.5 Hz - 4 Hz (biquad high-pass and low-pass, run forward and back so there's no phase lag),
//      after removing the linear trend; inverted, since more blood in the tissue reflects less light, so each
//      beat is a peak
//   3. Autocorrelation over the last windowS seconds gives the beat period (and how periodic the signal is)
//   4. Peaks above an adaptive threshold, at least 0.6 of that period apart, are the beats (peak times refined
//      by parabolic interpolation); inter-beat intervals (IBIs) far from the median are rejected
//   5. Heart rate from the IBIs in the window when they agree with the autocorrelation, otherwise from the
//      autocorrelation alone when it is strongly periodic
//   6. SpO2 from the ratio of ratios R = (AC/DC red) / (AC/DC IR), AC the RMS of the band-passed signal, using
//      SpO2 = a R^2 + b R + c (default coefficients from Maxim's MAX3010x reference algorithm - uncalibrated)
//   7. Perfusion index (AC/DC of the pulse channel, AC peak to peak), and HRV (RMSSD, SDNN) from all the
//      accepted IBIs since the finger was placed
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface HrmOptions {
    fingerThreshold?: number;   // pulse channel level (raw counts) meaning a finger is present (default 50000)
    minDc?: number;             // level a channel needs to count as lit, for SpO2 (default 10000)
    fullScale?: number;         // raw full scale, for the saturation warning (default 262143, 18 bits)
    windowS?: number;           // seconds of signal for heart rate and SpO2 (default 8)
    minBpm?: number;            // default 40
    maxBpm?: number;            // default 200
    spo2Coeffs?: [number, number, number];  // SpO2 = a R^2 + b R + c
}

export interface HrmInput {
    timesS: number[];           // sample times (seconds, any origin), ascending
    red?: number[];
    ir?: number[];
    green?: number[];
}

export type HrmChannel = 'ir' | 'green' | 'red';
export type HrmStatus = 'nodata' | 'nofinger' | 'settling' | 'nopulse' | 'ok';

export interface HrmResult {
    status: HrmStatus;
    sampleRateHz: number;
    pulseChannel?: HrmChannel;
    segmentS: number;           // seconds of usable signal (since finger placed / last gap)
    bpm?: number;
    bpmAutocorr?: number;
    periodicity: number;        // autocorrelation at the beat period (0..1)
    confidence: number;         // 0..1
    spo2?: number;
    ratioR?: number;
    perfusionIndex?: number;    // %
    rmssdMs?: number;
    sdnnMs?: number;
    numIbis: number;            // accepted IBIs the HRV is from
    saturated: boolean;
    wave: { timesS: number[]; values: number[] };   // filtered pulse waveform over the window, for display
    beatsS: number[];           // beat times in the window
}

const DEFAULTS = {
    fingerThreshold: 50000,
    minDc: 10000,
    fullScale: 262143,
    windowS: 8,
    minBpm: 40,
    maxBpm: 200,
    spo2Coeffs: [-45.060, 30.354, 94.845] as [number, number, number],
};

const MIN_SEGMENT_S = 4;        // signal needed before reporting
const SETTLE_S = 1;             // skipped after the finger is placed (pressure settling)
const BAND_LO_HZ = 0.5;
const BAND_HI_HZ = 4;
const IBI_TOLERANCE = 0.25;     // accepted IBIs are within this fraction of the median
const AGREE_TOLERANCE = 0.15;   // peak and autocorrelation rates agree within this fraction
const MIN_PERIODICITY = 0.5;    // autocorrelation alone gives the rate when at least this periodic

function median(values: number[]): number {
    if (values.length === 0) return NaN;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(values: number[]): number {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return NaN;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

function rms(values: number[]): number {
    return values.length ? Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length) : NaN;
}

// Biquad coefficients [b0, b1, b2, a1, a2] (RBJ cookbook, Butterworth Q)
function biquadCoeffs(kind: 'lp' | 'hp', fcHz: number, fsHz: number): number[] {
    const w0 = 2 * Math.PI * fcHz / fsHz;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = kind === 'lp' ? (1 - cosW) / 2 : (1 + cosW) / 2;
    const b1 = kind === 'lp' ? 1 - cosW : -(1 + cosW);
    return [b0 / a0, b1 / a0, b0 / a0, -2 * cosW / a0, (1 - alpha) / a0];
}

function runBiquad(c: number[], x: number[]): number[] {
    const y = new Array<number>(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const out = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = out;
        y[i] = out;
    }
    return y;
}

// Zero-phase band-pass: detrend, pad each end with its odd reflection, filter forward and back
export function bandPass(x: number[], fsHz: number, loHz = BAND_LO_HZ, hiHz = BAND_HI_HZ): number[] {
    const n = x.length;
    if (n < 3) return x.map(() => 0);
    // Linear trend removal
    const tMean = (n - 1) / 2;
    const xMean = mean(x);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - tMean) * (x[i] - xMean);
        den += (i - tMean) * (i - tMean);
    }
    const slope = num / den;
    const d = x.map((v, i) => v - xMean - slope * (i - tMean));
    const pad = Math.min(n - 1, Math.round(3 * fsHz));
    const padded: number[] = [];
    for (let i = pad; i > 0; i--) padded.push(2 * d[0] - d[i]);
    padded.push(...d);
    for (let i = 1; i <= pad; i++) padded.push(2 * d[n - 1] - d[n - 1 - i]);
    const stages = [biquadCoeffs('hp', loHz, fsHz)];
    // The low-pass only where it is below the Nyquist frequency (low sample rates)
    const hi = Math.min(hiHz, 0.45 * fsHz);
    if (hi > loHz) stages.push(biquadCoeffs('lp', hi, fsHz));
    let y = padded;
    for (const c of stages) y = runBiquad(c, y);
    y.reverse();
    for (const c of stages) y = runBiquad(c, y);
    y.reverse();
    return y.slice(pad, pad + n);
}

// Beat period (samples, fractional) from the normalised autocorrelation, and its value there
export function autocorrPeriod(y: number[], minLag: number, maxLag: number): { lag: number; r: number } {
    const n = y.length;
    maxLag = Math.min(maxLag, Math.floor(n / 2));
    minLag = Math.max(1, Math.floor(minLag));
    if (maxLag <= minLag + 1) return { lag: NaN, r: 0 };
    const energy = y.reduce((a, v) => a + v * v, 0) / n;
    if (energy <= 0) return { lag: NaN, r: 0 };
    const r: number[] = [];
    for (let k = 0; k <= maxLag + 1; k++) {
        let s = 0;
        for (let i = 0; i + k < n; i++) s += y[i] * y[i + k];
        r.push(s / (n - k) / energy);
    }
    // Local maxima in the lag range; the shortest one near the strongest wins (not a multiple of the period)
    const peaks: number[] = [];
    for (let k = minLag; k <= maxLag; k++) {
        if (r[k] > r[k - 1] && r[k] >= r[k + 1] && r[k] > 0) peaks.push(k);
    }
    if (peaks.length === 0) return { lag: NaN, r: 0 };
    const best = Math.max(...peaks.map(k => r[k]));
    const k = peaks.find(p => r[p] >= 0.85 * best)!;
    const denom = r[k - 1] - 2 * r[k] + r[k + 1];
    const frac = denom !== 0 ? 0.5 * (r[k - 1] - r[k + 1]) / denom : 0;
    return { lag: k + Math.max(-0.5, Math.min(0.5, frac)), r: Math.min(1, r[k]) };
}

// Beat times: peaks above an adaptive threshold, at least minSepS apart (the larger kept)
export function detectBeats(y: number[], timesS: number[], minSepS: number): number[] {
    const n = y.length;
    if (n < 3) return [];
    const threshold = 0.3 * percentile(y, 0.95);
    const beats: { t: number; v: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
        if (!(y[i] > y[i - 1] && y[i] >= y[i + 1] && y[i] > threshold)) continue;
        const denom = y[i - 1] - 2 * y[i] + y[i + 1];
        const frac = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y[i - 1] - y[i + 1]) / denom)) : 0;
        const t = timesS[i] + frac * (frac > 0 ? timesS[i + 1] - timesS[i] : timesS[i] - timesS[i - 1]);
        const last = beats[beats.length - 1];
        if (last && t - last.t < minSepS) {
            if (y[i] > last.v) beats[beats.length - 1] = { t, v: y[i] };
        } else {
            beats.push({ t, v: y[i] });
        }
    }
    return beats.map(b => b.t);
}

// Inter-beat intervals (s) of consecutive beats, null where rejected (out of range or far from the median)
export function acceptIbis(beatsS: number[], minIbiS: number, maxIbiS: number): (number | null)[] {
    const ibis = beatsS.slice(1).map((t, i) => t - beatsS[i]);
    const inRange = ibis.filter(v => v >= minIbiS && v <= maxIbiS);
    const med = median(inRange);
    return ibis.map(v => (v >= minIbiS && v <= maxIbiS && Math.abs(v - med) <= IBI_TOLERANCE * med) ? v : null);
}

// HRV: RMSSD from successive accepted pairs and SDNN of the accepted IBIs (ms)
export function hrvStats(ibis: (number | null)[]): { rmssdMs?: number; sdnnMs?: number; numIbis: number } {
    const accepted = ibis.filter((v): v is number => v !== null);
    const diffs: number[] = [];
    for (let i = 1; i < ibis.length; i++) {
        const a = ibis[i - 1], b = ibis[i];
        if (a !== null && b !== null) diffs.push((b - a) * 1000);
    }
    if (accepted.length < 5 || diffs.length < 4) return { numIbis: accepted.length };
    const m = mean(accepted);
    const sdnn = Math.sqrt(accepted.reduce((s, v) => s + (v - m) * (v - m), 0) / (accepted.length - 1)) * 1000;
    return { rmssdMs: rms(diffs), sdnnMs: sdnn, numIbis: accepted.length };
}

export function spo2FromRatio(ratioR: number, coeffs = DEFAULTS.spo2Coeffs): number | undefined {
    // Outside this the ratio is not a plausible blood reading (motion, ambient light, poor contact)
    if (!(ratioR >= 0.3 && ratioR <= 1.6)) return undefined;
    const [a, b, c] = coeffs;
    return Math.min(100, Math.max(0, a * ratioR * ratioR + b * ratioR + c));
}

export function analyseHrm(input: HrmInput, options: HrmOptions = {}): HrmResult {
    const opts = { ...DEFAULTS, ...options };
    const empty: HrmResult = {
        status: 'nodata', sampleRateHz: 0, segmentS: 0, periodicity: 0, confidence: 0, numIbis: 0,
        saturated: false, wave: { timesS: [], values: [] }, beatsS: [],
    };

    // Channels present with as many samples as the times (aligned at the newest)
    const channels: Partial<Record<HrmChannel, number[]>> = {};
    let n = input.timesS.length;
    for (const ch of ['ir', 'green', 'red'] as HrmChannel[]) {
        const v = input[ch];
        if (v && v.length > 0) { channels[ch] = v; n = Math.min(n, v.length); }
    }
    if (n < 3) return empty;
    const times = input.timesS.slice(-n);
    for (const ch of Object.keys(channels) as HrmChannel[]) channels[ch] = channels[ch]!.slice(-n);

    // Sample rate and the last gap in the data
    const dts = times.slice(1).map((t, i) => t - times[i]);
    const dt = median(dts.filter(d => d > 0));
    if (!(dt > 0)) return empty;
    const fs = 1 / dt;
    let start = 0;
    dts.forEach((d, i) => { if (d <= 0 || d > Math.max(3 * dt, 0.5)) start = i + 1; });
    empty.sampleRateHz = fs;

    // Pulse channel: the first showing a finger over the last second
    const recent = Math.max(1, Math.round(fs));
    const pulseChannel = (['ir', 'green', 'red'] as HrmChannel[]).find(ch =>
        channels[ch] && mean(channels[ch]!.slice(-recent)) >= opts.fingerThreshold);
    if (!pulseChannel) return { ...empty, status: n - start >= 2 * fs ? 'nofinger' : 'nodata' };
    const raw = channels[pulseChannel]!;

    // Start after the finger was last placed (plus settling)
    for (let i = n - 1; i >= start; i--) {
        if (raw[i] < opts.fingerThreshold) { start = i + 1 + Math.round(SETTLE_S * fs); break; }
    }
    const segmentS = Math.max(0, (n - start) * dt);
    const base = { ...empty, pulseChannel, segmentS };
    if (segmentS < MIN_SEGMENT_S) return { ...base, status: 'settling' };

    const segTimes = times.slice(start);
    const filtered: Partial<Record<HrmChannel, number[]>> = {};
    const pulse = bandPass(raw.slice(start), fs).map(v => -v);
    const winLen = Math.min(pulse.length, Math.round(opts.windowS * fs));
    const winStart = pulse.length - winLen;
    const win = pulse.slice(winStart);
    const winTimes = segTimes.slice(winStart);
    const saturated = Math.max(...raw.slice(start)) >= 0.98 * opts.fullScale;

    // Beat period from the autocorrelation over the window
    const minIbiS = 60 / opts.maxBpm;
    const maxIbiS = 60 / opts.minBpm;
    const ac = autocorrPeriod(win, minIbiS * fs, maxIbiS * fs);
    const bpmAutocorr = ac.lag > 0 ? 60 / (ac.lag * dt) : undefined;

    // Beats over the whole segment (for HRV), then those in the window
    const minSepS = Math.max(minIbiS, bpmAutocorr ? 0.6 * 60 / bpmAutocorr : minIbiS);
    const beats = detectBeats(pulse, segTimes, minSepS);
    const ibis = acceptIbis(beats, minIbiS, maxIbiS);
    const winT0 = winTimes[0];
    const winIbis = ibis.filter((v, i): v is number => v !== null && beats[i] >= winT0);
    const winIbisAll = ibis.filter((_, i) => beats[i] >= winT0).length;
    const bpmPeaks = winIbis.length >= 3 ? 60 / mean(winIbis) : undefined;

    let bpm: number | undefined;
    let confidence = 0;
    const agree = bpmPeaks !== undefined && bpmAutocorr !== undefined &&
        Math.abs(bpmPeaks - bpmAutocorr) <= AGREE_TOLERANCE * bpmAutocorr;
    if (agree) {
        bpm = bpmPeaks;
        confidence = ac.r * (winIbis.length / Math.max(1, winIbisAll));
    } else if (bpmAutocorr !== undefined && ac.r >= MIN_PERIODICITY) {
        bpm = bpmAutocorr;
        confidence = 0.5 * ac.r;
    }

    // Perfusion index on the pulse channel
    const dcPulse = mean(raw.slice(-winLen));
    const perfusionIndex = 100 * (percentile(win, 0.95) - percentile(win, 0.05)) / dcPulse;

    // SpO2 from red and IR, both lit
    let ratioR: number | undefined;
    let spo2: number | undefined;
    if (bpm !== undefined && channels.red && channels.ir) {
        const dcRed = mean(channels.red.slice(-winLen));
        const dcIr = mean(channels.ir.slice(-winLen));
        if (dcRed >= opts.minDc && dcIr >= opts.minDc) {
            for (const ch of ['red', 'ir'] as HrmChannel[]) {
                filtered[ch] = ch === pulseChannel ? win : bandPass(channels[ch]!.slice(start), fs).slice(winStart);
            }
            ratioR = (rms(filtered.red!) / dcRed) / (rms(filtered.ir!) / dcIr);
            spo2 = spo2FromRatio(ratioR, opts.spo2Coeffs);
        }
    }

    const hrv = hrvStats(ibis);
    return {
        ...base,
        status: bpm !== undefined ? 'ok' : 'nopulse',
        bpm, bpmAutocorr, periodicity: ac.r, confidence,
        spo2, ratioR, perfusionIndex,
        rmssdMs: hrv.rmssdMs, sdnnMs: hrv.sdnnMs, numIbis: hrv.numIbis,
        saturated,
        wave: { timesS: winTimes, values: win },
        beatsS: beats.filter(t => t >= winT0),
    };
}
