/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// ZoneGridVisualizer
// Square-grid visualizer for array attributes holding one value per zone/pixel, e.g. a multizone
// ToF sensor (VL53L5CX distances, 4x4 or 8x8) or a thermal camera (AMG8833, 8x8).
// Renders in the chart panel; updates with the panel's chart timer.
//
// Options come from the attribute's "vo" (visualizer options) object in the device type record:
//   gridAttr     name of a scalar attribute giving the grid side length (else "resolution": "8x8",
//                else the square root of the element count)
//   statusAttr   name of a parallel array attribute with a per-zone status
//   validStatus  status values that mean the zone's value is valid (others are greyed out)
//   invert       true to colour LOW values hot (e.g. near distances red)
//   flipX/flipY  initial mirroring (the optics may mirror the zone order)
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

interface ZoneGridOptions {
    gridAttr?: string;
    statusAttr?: string;
    validStatus?: number[];
    invert?: boolean;
    flipX?: boolean;
    flipY?: boolean;
}

type DisplayMode = 'value' | 'status';

// Latest complete sample of an attribute (all its elements)
function latestSample(attrState: DeviceAttributeState | undefined): number[] {
    if (!attrState) return [];
    const elems = attrState.elemsPerSample ?? 1;
    if (attrState.values.length < elems) return [];
    return attrState.values.slice(-elems).map(v => typeof v === 'number' ? v : NaN);
}

// Grid side length from options, a "resolution" field (e.g. "8x8") or the element count
function gridSide(deviceState: DeviceState, attribute: any, opts: ZoneGridOptions, numElems: number): number {
    if (opts.gridAttr) {
        const side = latestSample(deviceState.deviceAttributes[opts.gridAttr])[0];
        if (Number.isFinite(side) && side > 0) return side;
    }
    if (typeof attribute.resolution === 'string') {
        const side = parseInt(attribute.resolution, 10);
        if (Number.isFinite(side) && side > 0) return side;
    }
    return Math.max(1, Math.floor(Math.sqrt(numElems)));
}

// Blue (cold) -> red (hot) for a 0..1 fraction
function heatColour(frac: number): string {
    const f = Math.min(1, Math.max(0, frac));
    return `hsl(${Math.round(240 * (1 - f))}, 75%, 45%)`;
}

const ZoneGridVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: ZoneGridOptions = ((attribute as any)?.vo ?? {}) as ZoneGridOptions;
    const [mode, setMode] = useState<DisplayMode>('value');
    const [autoRange, setAutoRange] = useState<boolean>(true);
    const [showNumbers, setShowNumbers] = useState<boolean>(true);
    const [flipX, setFlipX] = useState<boolean>(!!opts.flipX);
    const [flipY, setFlipY] = useState<boolean>(!!opts.flipY);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;
    if (!attribute || !deviceState || !attrState) {
        return null;
    }

    const sample = latestSample(attrState);
    if (sample.length === 0) {
        return null;
    }
    const side = gridSide(deviceState, attribute, opts, sample.length);
    const numZones = Math.min(side * side, sample.length);
    const values = sample.slice(0, numZones);

    // Per-zone validity from the status attribute (if any)
    const statusSample = opts.statusAttr ? latestSample(deviceState.deviceAttributes[opts.statusAttr]).slice(0, numZones) : [];
    const validSet = new Set(opts.validStatus ?? []);
    const isValid = (i: number) => statusSample.length === 0 || validSet.size === 0 || validSet.has(statusSample[i]);

    // Colour range - the frame's own min/max (valid zones) or the attribute's declared range
    let lo = attribute.r?.[0] ?? 0;
    let hi = attribute.r?.[1] ?? 1;
    if (autoRange) {
        const validVals = values.filter((v, i) => isValid(i) && Number.isFinite(v));
        if (validVals.length > 0) {
            lo = Math.min(...validVals);
            hi = Math.max(...validVals);
        }
    }
    const span = hi - lo || 1;
    const units = attrState.units || '';

    // Cells in display order (row-major, optionally mirrored)
    const cells: JSX.Element[] = [];
    for (let row = 0; row < side; row++) {
        for (let col = 0; col < side; col++) {
            const srcRow = flipY ? side - 1 - row : row;
            const srcCol = flipX ? side - 1 - col : col;
            const i = srcRow * side + srcCol;
            if (i >= numZones) continue;
            const v = values[i];
            const valid = isValid(i);
            let bg = '#444';
            let text = '';
            if (mode === 'status') {
                const st = statusSample[i];
                bg = valid ? '#2e7d32' : (st === 255 ? '#444' : '#b26a00');
                text = Number.isFinite(st) ? String(st) : '';
            } else if (valid && Number.isFinite(v)) {
                const frac = (v - lo) / span;
                bg = heatColour(opts.invert ? 1 - frac : frac);
                text = String(Math.round(v));
            } else {
                text = '–';
            }
            cells.push(
                <div key={`${row}_${col}`} className="zonegrid-cell" style={{ backgroundColor: bg }}
                    title={`zone ${i}: ${Number.isFinite(v) ? v : '?'}${units ? ' ' + units : ''}` +
                        (statusSample.length ? ` status ${statusSample[i]}` : '')}>
                    {showNumbers ? text : ''}
                </div>
            );
        }
    }

    return (
        <div className="device-zonegrid">
            <div className="zonegrid-header">
                <span className="zonegrid-title">{attribute.n}{units ? ` (${units})` : ''} {side}x{side}</span>
                {opts.statusAttr && (
                    <select value={mode} onChange={(e) => setMode(e.target.value as DisplayMode)}>
                        <option value="value">{attribute.n}</option>
                        <option value="status">{opts.statusAttr}</option>
                    </select>
                )}
                <label><input type="checkbox" checked={autoRange} onChange={(e) => setAutoRange(e.target.checked)} />auto range</label>
                <label><input type="checkbox" checked={showNumbers} onChange={(e) => setShowNumbers(e.target.checked)} />values</label>
                <label><input type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)} />flip X</label>
                <label><input type="checkbox" checked={flipY} onChange={(e) => setFlipY(e.target.checked)} />flip Y</label>
                {mode === 'value' && (
                    <span className="zonegrid-range">{Math.round(lo)} – {Math.round(hi)}{units ? ` ${units}` : ''}</span>
                )}
            </div>
            <div className="zonegrid-grid" style={{ gridTemplateColumns: `repeat(${side}, 1fr)`, gridTemplateRows: `repeat(${side}, 1fr)` }}>
                {cells}
            </div>
        </div>
    );
});

export default ZoneGridVisualizer;
