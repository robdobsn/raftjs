/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// AngleVisualizer
// Dial for an angle sensor such as a magnetic rotary encoder (AS5600, MT6701): a needle at the latest angle, a fading
// trail of the readings before it (so rotation can be seen), the angle in degrees and the total rotation since the
// view opened or was reset (turns counted through the 0/360 wrap). Renders in the chart panel; updates with the
// panel's chart timer.
//
// The visualizer goes on the angle attribute ("vt": "angle"). Options come from its "vo" (visualizer options) object
// in the device type record - each the name of another attribute of the device:
//   magnet     magnet detected (a flag)
//   tooWeak    magnet too far away (a flag)
//   tooStrong  magnet too close (a flag)
// With the flags, the dial is greyed out with the reason when the angle isn't valid (no magnet, too far, too close).
// The angle's range is the attribute's "r" (default 0 to 360); 0 is at the top and angles increase clockwise.
//
// Turn counting takes each step between readings the shorter way round, so rotation faster than half a turn
// between samples counts the wrong way.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo, useEffect, useRef, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';
import { ANGLE_UNWRAP_START, AngleUnwrap, MAGNET_STATUS_TEXT, magnetStatus, turnsOf, unwrapAngles } from './angleMath';

const connManager = ConnManager.getInstance();

interface AngleOptions {
    magnet?: string;
    tooWeak?: string;
    tooStrong?: string;
}

const DIAL_SIZE = 220;
const TRAIL_LENGTH = 24;

// Latest value of an attribute as a flag (undefined if the device has no such attribute or no value yet)
function latestFlag(attrState: DeviceAttributeState | undefined): boolean | undefined {
    if (!attrState || attrState.values.length === 0) return undefined;
    const v = attrState.values[attrState.values.length - 1];
    return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : undefined;
}

const AngleVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: AngleOptions = ((attribute as any)?.vo ?? {}) as AngleOptions;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const unwrapRef = useRef<AngleUnwrap>(ANGLE_UNWRAP_START);
    const samplesSeenRef = useRef<number | undefined>(undefined);
    const [, setResetCount] = useState(0);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;
    const values = (attrState?.values ?? []).map(v => (typeof v === 'number' ? v : NaN));
    const range: [number, number] = Array.isArray(attribute?.r) && attribute!.r.length >= 2
        ? [Number(attribute!.r[0]), Number(attribute!.r[1])] : [0, 360];
    const span = range[1] - range[0] > 0 ? range[1] - range[0] : 360;
    const angle = values.length ? values[values.length - 1] : NaN;
    const trail = values.slice(-TRAIL_LENGTH);

    const attrs = deviceState?.deviceAttributes;
    const status = magnetStatus(opts.magnet ? latestFlag(attrs?.[opts.magnet]) : undefined,
        opts.tooWeak ? latestFlag(attrs?.[opts.tooWeak]) : undefined,
        opts.tooStrong ? latestFlag(attrs?.[opts.tooStrong]) : undefined);
    const valid = Number.isFinite(angle) && (status === 'ok' || status === 'unknown');

    // Turn counting: add the samples that arrived since the last render (the device's sample count says how many)
    const totalAdded = deviceState?.deviceTimeline.totalSamplesAdded;
    if (totalAdded !== undefined && samplesSeenRef.current !== totalAdded) {
        const fresh = samplesSeenRef.current === undefined ? 1 : Math.max(0, totalAdded - samplesSeenRef.current);
        if (fresh > 0 && valid)
            unwrapRef.current = unwrapAngles(unwrapRef.current, values.slice(-Math.min(fresh, values.length)), span);
        samplesSeenRef.current = totalAdded;
    }
    const rotation = unwrapRef.current.lastRaw === undefined ? 0 : unwrapRef.current.total;
    const { turns, remainder } = turnsOf(rotation, span);

    // Draw the dial
    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== DIAL_SIZE * dpr) {
            canvas.width = DIAL_SIZE * dpr;
            canvas.height = DIAL_SIZE * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, DIAL_SIZE, DIAL_SIZE);
        const c = DIAL_SIZE / 2;
        const r = c - 14;
        const toRad = (a: number) => ((a - range[0]) / span) * 2 * Math.PI - Math.PI / 2;

        // Face and ticks (every 1/12 of the range, labelled every quarter)
        ctx.globalAlpha = valid ? 1 : 0.45;
        ctx.fillStyle = '#1e2229';
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c, c, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#bbb';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * 2 * Math.PI - Math.PI / 2;
            const inner = i % 3 === 0 ? r - 12 : r - 7;
            ctx.beginPath();
            ctx.moveTo(c + inner * Math.cos(a), c + inner * Math.sin(a));
            ctx.lineTo(c + r * Math.cos(a), c + r * Math.sin(a));
            ctx.stroke();
            if (i % 3 === 0)
                ctx.fillText(String(Math.round(range[0] + (i / 12) * span)), c + (r - 24) * Math.cos(a), c + (r - 24) * Math.sin(a));
        }

        // Trail of the earlier readings, fading with age
        trail.forEach((v, i) => {
            if (!Number.isFinite(v) || i === trail.length - 1) return;
            const a = toRad(v);
            ctx.globalAlpha = (valid ? 0.6 : 0.25) * ((i + 1) / trail.length);
            ctx.fillStyle = '#4fc3f7';
            ctx.beginPath();
            ctx.arc(c + (r - 4) * Math.cos(a), c + (r - 4) * Math.sin(a), 3, 0, 2 * Math.PI);
            ctx.fill();
        });

        // Needle
        ctx.globalAlpha = valid ? 1 : 0.45;
        if (Number.isFinite(angle)) {
            const a = toRad(angle);
            ctx.strokeStyle = valid ? '#ff7043' : '#888';
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(c - 14 * Math.cos(a), c - 14 * Math.sin(a));
            ctx.lineTo(c + (r - 16) * Math.cos(a), c + (r - 16) * Math.sin(a));
            ctx.stroke();
        }
        ctx.fillStyle = '#ddd';
        ctx.beginPath();
        ctx.arc(c, c, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
    });

    if (!attribute || !deviceState || !attrState || values.length === 0) {
        return null;
    }
    const units = attrState.units || '°';
    const unitText = units === 'degrees' || units === '&deg;' ? '°' : ` ${units}`;
    const reset = () => {
        unwrapRef.current = Number.isFinite(angle) ? { total: angle, lastRaw: angle } : ANGLE_UNWRAP_START;
        setResetCount(n => n + 1);
    };

    return (
        <div className="device-angle">
            <div className="zonegrid-header">
                <span className="zonegrid-title">{attribute.n}</span>
                <span>{Number.isFinite(angle) ? `${angle.toFixed(1)}${unitText}` : '-'}</span>
                {status !== 'unknown' && (
                    <span className={`angle-status angle-status-${status}`}>{MAGNET_STATUS_TEXT[status]}</span>
                )}
            </div>
            <div className="angle-body">
                <canvas ref={canvasRef} className="angle-dial" style={{ width: DIAL_SIZE, height: DIAL_SIZE }} />
                <div className="angle-readout">
                    <div>rotation {rotation.toFixed(1)}{unitText}</div>
                    <div>{turns} turn{Math.abs(turns) === 1 ? '' : 's'} + {remainder.toFixed(1)}{unitText}</div>
                    {!valid && Number.isFinite(angle) && <div className="angle-invalid">angle not valid</div>}
                    <button className="angle-reset" onClick={reset}>reset turns</button>
                </div>
            </div>
        </div>
    );
});

export default AngleVisualizer;
