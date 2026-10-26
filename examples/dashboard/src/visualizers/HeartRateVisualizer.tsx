/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// HeartRateVisualizer
// Heart-rate monitor view for a PPG sensor (device class HRM, e.g. MAX30101): heart rate, SpO2, perfusion index,
// HRV and signal quality worked out from the red / IR / green attributes (see hrmMath), the filtered pulse
// waveform with the detected beats, and a heart-rate trend. One view per device, placed on its first attribute.
// Renders in the chart panel; updates with the panel's chart timer.
//
// Options come from the attribute's "vo" (visualizer options) object in the device type record:
//   redAttr, irAttr, greenAttr   attribute names of the channels (default Red, IR, Green - any case)
//   fingerThreshold              pulse channel level meaning a finger is present (default 50000)
//   minDc                        level a channel needs to count as lit, for SpO2 (default 10000)
//   windowS                      seconds of signal for heart rate and SpO2 (default 8)
//   spo2Coeffs                   [a, b, c] for SpO2 = a R^2 + b R + c (default Maxim's reference algorithm)
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo, useRef, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';
import { analyseHrm, HrmOptions, HrmResult, HrmStatus } from './hrmMath';

const connManager = ConnManager.getInstance();

interface HeartRateOptions extends HrmOptions {
    redAttr?: string;
    irAttr?: string;
    greenAttr?: string;
}

const STATUS_TEXT: Record<HrmStatus, string> = {
    nodata: 'waiting for data',
    nofinger: 'no finger',
    settling: 'hold still…',
    nopulse: 'no pulse found',
    ok: 'measuring',
};

const CHANNEL_NAMES = { ir: 'IR', red: 'red', green: 'green' };

const WAVE_W = 1000;
const WAVE_H = 140;
const TREND_W = 1000;
const TREND_H = 60;
const TREND_LEN = 240;          // trend points kept (up to 2 a second: 2 minutes)
const LOW_RATE_HZ = 12.5;

// Values of a single-valued attribute, numbers only
function attrValues(attrState: DeviceAttributeState | undefined): number[] | undefined {
    if (!attrState || (attrState.elemsPerSample ?? 1) !== 1) return undefined;
    return attrState.values.map(v => typeof v === 'number' ? v : NaN);
}

function findAttr(deviceState: DeviceState, name: string | undefined, fallback: string): DeviceAttributeState | undefined {
    if (name) return deviceState.deviceAttributes[name];
    const key = Object.keys(deviceState.deviceAttributes).find(k => k.toLowerCase() === fallback);
    return key ? deviceState.deviceAttributes[key] : undefined;
}

function quality(r: HrmResult): { label: string; colour: string } {
    if (r.status !== 'ok') return { label: '–', colour: '#888' };
    if (r.confidence >= 0.7) return { label: 'good', colour: '#81c784' };
    if (r.confidence >= 0.4) return { label: 'fair', colour: '#ffb74d' };
    return { label: 'poor', colour: '#e57373' };
}

const Tile: React.FC<{ label: string; value?: string; units?: string; sub?: string; title?: string; children?: React.ReactNode }> =
    ({ label, value, units, sub, title, children }) => (
        <div className="hrm-tile" title={title}>
            <div className="hrm-tile-label">{label}</div>
            <div className="hrm-tile-value">
                {children}{value ?? '–'}{value !== undefined && units ? <span className="hrm-tile-units">{units}</span> : null}
            </div>
            {sub && <div className="hrm-tile-sub">{sub}</div>}
        </div>
    );

const HeartRateVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: HeartRateOptions = ((attribute as any)?.vo ?? {}) as HeartRateOptions;
    const trendRef = useRef<{ tMs: number; bpm: number }[]>([]);
    const [hoverFrac, setHoverFrac] = useState<number | null>(null);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    if (!attribute || !deviceState) {
        return null;
    }
    const red = attrValues(findAttr(deviceState, opts.redAttr, 'red'));
    const ir = attrValues(findAttr(deviceState, opts.irAttr, 'ir'));
    const green = attrValues(findAttr(deviceState, opts.greenAttr, 'green'));
    const timesS = deviceState.deviceTimeline.timestampsUs.map(t => t / 1e6);
    const fullScale = attribute.r?.[1];
    const r = analyseHrm({ timesS, red, ir, green }, { ...opts, ...(fullScale ? { fullScale } : {}) });

    // Heart rate trend (kept across renders)
    const nowMs = Date.now();
    const trend = trendRef.current;
    // (hover re-renders too, so at most one point a chart update)
    const lastTrend = trend[trend.length - 1];
    if (r.status === 'ok' && r.bpm !== undefined && r.confidence >= 0.4 && (!lastTrend || nowMs - lastTrend.tMs >= 450)) {
        trend.push({ tMs: nowMs, bpm: r.bpm });
        if (trend.length > TREND_LEN) trend.splice(0, trend.length - TREND_LEN);
    }

    const q = quality(r);
    const bpmText = r.status === 'ok' && r.bpm !== undefined ? String(Math.round(r.bpm)) : undefined;
    const beatS = r.bpm ? 60 / r.bpm : 1;

    // Pulse waveform, scaled to its own range, with the beats marked
    const wave = r.wave;
    let wavePath = '';
    const beatMarks: JSX.Element[] = [];
    if (wave.values.length > 1) {
        const t0 = wave.timesS[0];
        const span = Math.max(1e-6, wave.timesS[wave.timesS.length - 1] - t0);
        const lo = Math.min(...wave.values), hi = Math.max(...wave.values);
        const yOf = (v: number) => WAVE_H - 8 - ((v - lo) / Math.max(1e-9, hi - lo)) * (WAVE_H - 24);
        wavePath = wave.values.map((v, i) =>
            `${i ? 'L' : 'M'}${(((wave.timesS[i] - t0) / span) * WAVE_W).toFixed(1)},${yOf(v).toFixed(1)}`).join('');
        r.beatsS.forEach((tb, i) => {
            const x = ((tb - t0) / span) * WAVE_W;
            const ibiMs = i > 0 ? Math.round((tb - r.beatsS[i - 1]) * 1000) : undefined;
            beatMarks.push(
                <g key={i}>
                    <line x1={x} x2={x} y1={2} y2={12} stroke="#ddd" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    <rect x={x - 12} y={0} width={24} height={WAVE_H} fill="transparent">
                        <title>{`beat ${(tb - wave.timesS[wave.timesS.length - 1]).toFixed(1)} s${ibiMs ? `, ${ibiMs} ms after the last` : ''}`}</title>
                    </rect>
                </g>
            );
        });
    }

    // Trend: last 2 minutes on a fixed time axis
    const trendSpanMs = TREND_LEN * 500;
    const trendLo = trend.length ? Math.floor(Math.min(...trend.map(p => p.bpm)) / 10) * 10 - 5 : 50;
    const trendHi = trend.length ? Math.ceil(Math.max(...trend.map(p => p.bpm)) / 10) * 10 + 5 : 100;
    const trendX = (tMs: number) => (1 - (nowMs - tMs) / trendSpanMs) * TREND_W;
    const trendY = (bpm: number) => TREND_H - 4 - ((bpm - trendLo) / (trendHi - trendLo)) * (TREND_H - 8);
    const trendPath = trend.filter(p => nowMs - p.tMs <= trendSpanMs)
        .map((p, i) => `${i ? 'L' : 'M'}${trendX(p.tMs).toFixed(1)},${trendY(p.bpm).toFixed(1)}`).join('');
    let hoverPoint: { tMs: number; bpm: number } | undefined;
    if (hoverFrac !== null && trend.length) {
        const tMs = nowMs - (1 - hoverFrac) * trendSpanMs;
        hoverPoint = trend.reduce((best, p) => Math.abs(p.tMs - tMs) < Math.abs(best.tMs - tMs) ? p : best, trend[0]);
        if (Math.abs(hoverPoint.tMs - tMs) > 2000) hoverPoint = undefined;
    }

    const warnings: string[] = [];
    if (r.saturated) warnings.push('saturated - lower the LED current');
    if (r.sampleRateHz > 0 && r.sampleRateHz < LOW_RATE_HZ) warnings.push(`${r.sampleRateHz.toFixed(1)} samples/s - raise the rate for fast rates and HRV`);

    return (
        <div className="device-hrm">
            <div className="zonegrid-header">
                <span className="zonegrid-title">Heart rate</span>
                <span className="hrm-status"><span className="hrm-dot" style={{ backgroundColor: q.colour }} />{STATUS_TEXT[r.status]}</span>
                {r.pulseChannel && <span>pulse from {CHANNEL_NAMES[r.pulseChannel]}</span>}
                {warnings.map(w => <span key={w} className="hrm-warning">⚠ {w}</span>)}
                <span className="zonegrid-range">{r.sampleRateHz ? `${r.sampleRateHz.toFixed(1)} samples/s` : ''}</span>
            </div>
            <div className="hrm-tiles">
                <Tile label="Heart rate" value={bpmText} units="bpm"
                    sub={r.bpmAutocorr && r.status === 'ok' ? `periodicity ${Math.round(r.periodicity * 100)}%` : undefined}>
                    <svg className={`hrm-heart${bpmText ? ' hrm-heart-beating' : ''}`} viewBox="0 0 24 24"
                        style={{ animationDuration: `${beatS.toFixed(2)}s` }} aria-hidden="true">
                        <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.5 3 5 6.4 5c2 0 3.6 1.1 4.6 2.6l1 1.4 1-1.4C14 6.1 15.6 5 17.6 5 21 5 23.1 8.5 21.6 11.8 19.5 16.4 12 21 12 21z" />
                    </svg>
                </Tile>
                <Tile label="SpO₂" value={r.spo2 !== undefined ? String(Math.round(r.spo2)) : undefined} units="%"
                    sub={r.ratioR !== undefined ? `R ${r.ratioR.toFixed(2)} · uncalibrated` : (r.status === 'ok' ? 'needs red and IR LEDs' : undefined)}
                    title="Estimate from the red/IR ratio of ratios with generic coefficients - not for medical use" />
                <Tile label="Perfusion" value={r.status === 'ok' && r.perfusionIndex !== undefined ? r.perfusionIndex.toFixed(2) : undefined} units="%"
                    title="Pulse amplitude as a percentage of the steady level (perfusion index)" />
                <Tile label="HRV (RMSSD)" value={r.rmssdMs !== undefined ? String(Math.round(r.rmssdMs)) : undefined} units="ms"
                    sub={r.sdnnMs !== undefined ? `SDNN ${Math.round(r.sdnnMs)} ms · ${r.numIbis} beats` : (r.status === 'ok' ? 'collecting beats…' : undefined)}
                    title="Beat-to-beat variability since the finger was placed - needs a steady finger for 30 s or more to mean much" />
                <Tile label="Signal" value={q.label}
                    sub={r.status === 'ok' ? `confidence ${Math.round(r.confidence * 100)}%` : undefined} />
            </div>
            <svg className="hrm-wave" viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none" role="img"
                aria-label={`Pulse waveform, last ${Math.round(wave.timesS.length > 1 ? wave.timesS[wave.timesS.length - 1] - wave.timesS[0] : 0)} seconds`}>
                <line x1={0} x2={WAVE_W} y1={WAVE_H - 1} y2={WAVE_H - 1} stroke="#555" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {wavePath && <path d={wavePath} fill="none" stroke="#e57373" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
                {beatMarks}
            </svg>
            <div className="hrm-axis"><span>{wave.timesS.length > 1 ? `-${(wave.timesS[wave.timesS.length - 1] - wave.timesS[0]).toFixed(0)} s` : ''}</span><span>now</span></div>
            <div className="hrm-trend-label">
                <span>Heart rate, last 2 min</span>
                <span>{hoverPoint ? `${Math.round(hoverPoint.bpm)} bpm, ${Math.round((nowMs - hoverPoint.tMs) / 1000)} s ago`
                    : trend.length ? `${trendLo + 5}–${trendHi - 5} bpm` : ''}</span>
            </div>
            <svg className="hrm-trend" viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none"
                onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); setHoverFrac((e.clientX - b.left) / b.width); }}
                onMouseLeave={() => setHoverFrac(null)}>
                <line x1={0} x2={TREND_W} y1={TREND_H - 1} y2={TREND_H - 1} stroke="#555" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {trendPath && <path d={trendPath} fill="none" stroke="#e57373" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
                {hoverPoint && <line x1={trendX(hoverPoint.tMs)} x2={trendX(hoverPoint.tMs)} y1={0} y2={TREND_H} stroke="#aaa" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
            </svg>
        </div>
    );
});

export default HeartRateVisualizer;
