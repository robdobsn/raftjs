/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// TouchStripVisualizer
// Strip view for a 1D multi-touch sensor (e.g. Bela Trill Flex): an array attribute holding the touch positions
// and another holding their sizes. Each touch is a mark at its position along the strip, as big as its size.
// Renders in the chart panel; updates with the panel's chart timer.
//
// Options come from the position attribute's "vo" (visualizer options) object in the device type record:
//   sizeAttr     name of the array attribute holding the touch sizes (same element order)
//   noValue      raw position meaning "no touch" (e.g. 65535)
//   posMax       position at the far end of the strip (default the attribute range)
//   sizeMax      size drawn as the largest mark (default the largest size seen)
//   numChannels  sensing channels, drawn as ticks along the strip (default none)
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

interface TouchStripOptions {
    sizeAttr?: string;
    noValue?: number;
    posMax?: number;
    sizeMax?: number;
    numChannels?: number;
}

// Latest complete sample of an attribute (all its elements)
function latestSample(attrState: DeviceAttributeState | undefined): number[] {
    if (!attrState) return [];
    const elems = attrState.elemsPerSample ?? 1;
    if (attrState.values.length < elems) return [];
    return attrState.values.slice(-elems).map(v => typeof v === 'number' ? v : NaN);
}

// A colour per touch (by its element index)
const TOUCH_COLOURS = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8'];

const VIEW_W = 1000;
const VIEW_H = 120;
const STRIP_Y = 40;
const STRIP_H = 40;
const MARK_MIN_R = 6;
const MARK_MAX_R = 34;

const TouchStripVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: TouchStripOptions = ((attribute as any)?.vo ?? {}) as TouchStripOptions;

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;
    if (!attribute || !deviceState || !attrState) {
        return null;
    }
    const positions = latestSample(attrState);
    if (positions.length === 0) {
        return null;
    }
    const sizes = opts.sizeAttr ? latestSample(deviceState.deviceAttributes[opts.sizeAttr]) : [];

    const posMax = opts.posMax ?? attribute.r?.[1] ?? 65535;
    const touches = positions
        .map((pos, i) => ({ i, pos, size: sizes[i] ?? NaN }))
        .filter(t => Number.isFinite(t.pos) && (opts.noValue === undefined || t.pos !== opts.noValue));
    const sizeMax = opts.sizeMax ?? Math.max(1, ...touches.map(t => Number.isFinite(t.size) ? t.size : 0));

    const ticks: JSX.Element[] = [];
    const numChannels = opts.numChannels ?? 0;
    for (let c = 0; c < numChannels; c++) {
        const x = numChannels > 1 ? (c / (numChannels - 1)) * VIEW_W : VIEW_W / 2;
        ticks.push(<line key={c} x1={x} x2={x} y1={STRIP_Y + STRIP_H - 6} y2={STRIP_Y + STRIP_H} stroke="#888" strokeWidth={2} />);
    }

    return (
        <div className="device-touchstrip">
            <div className="zonegrid-header">
                <span className="zonegrid-title">{attribute.n}{opts.sizeAttr ? ` / ${opts.sizeAttr}` : ''}</span>
                <span>{touches.length === 0 ? 'no touch' : `${touches.length} touch${touches.length > 1 ? 'es' : ''}`}</span>
                <span className="zonegrid-range">0 – {posMax}</span>
            </div>
            <svg className="touchstrip-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none">
                <rect x={0} y={STRIP_Y} width={VIEW_W} height={STRIP_H} rx={8} fill="#3a3f4b" stroke="#666" />
                {ticks}
                {touches.map(t => {
                    const x = Math.min(1, Math.max(0, t.pos / posMax)) * VIEW_W;
                    const frac = Number.isFinite(t.size) ? Math.min(1, Math.max(0, t.size / sizeMax)) : 0;
                    const r = MARK_MIN_R + frac * (MARK_MAX_R - MARK_MIN_R);
                    const colour = TOUCH_COLOURS[t.i % TOUCH_COLOURS.length];
                    return (
                        <g key={t.i}>
                            <ellipse cx={x} cy={STRIP_Y + STRIP_H / 2} rx={r} ry={Math.min(r, STRIP_H)} fill={colour} fillOpacity={0.75} stroke="#fff" strokeWidth={2} />
                            <text x={x} y={STRIP_Y - 8} textAnchor="middle" fill={colour} fontSize={18}>{t.i + 1}</text>
                        </g>
                    );
                })}
            </svg>
            <div className="touchstrip-list">
                {touches.map(t => (
                    <span key={t.i} style={{ color: TOUCH_COLOURS[t.i % TOUCH_COLOURS.length] }}>
                        {t.i + 1}: {Math.round(t.pos)}{Number.isFinite(t.size) ? ` (size ${Math.round(t.size)})` : ''}
                    </span>
                ))}
            </div>
        </div>
    );
});

export default TouchStripVisualizer;
