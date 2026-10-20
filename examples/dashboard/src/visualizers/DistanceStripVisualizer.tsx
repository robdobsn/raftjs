/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// DistanceStripVisualizer
// Board-layout view for an array attribute holding one distance per single-zone sensor placed
// around a board (e.g. the Robotical distance strip: nine VL53L0X in two rows). Each sensor is a
// cell at its place on the board, coloured by distance (near = hot) with a closeness bar.
// Renders in the chart panel; updates with the panel's chart timer.
//
// Options come from the attribute's "vo" (visualizer options) object in the device type record:
//   layout     rows of sensor numbers (1-based element index), 0 = no sensor at that place;
//              default one row in element order
//   noValue    raw value meaning "no valid reading" (e.g. 65535)
//   maxValue   distance shown as the far end of the colour scale (default the attribute range)
//   validAttr  name of a scalar attribute whose bit n-1 says sensor n is valid
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

interface DistanceStripOptions {
    layout?: number[][];
    noValue?: number;
    maxValue?: number;
    validAttr?: string;
}

// Latest complete sample of an attribute (all its elements)
function latestSample(attrState: DeviceAttributeState | undefined): number[] {
    if (!attrState) return [];
    const elems = attrState.elemsPerSample ?? 1;
    if (attrState.values.length < elems) return [];
    return attrState.values.slice(-elems).map(v => typeof v === 'number' ? v : NaN);
}

// Red (near) -> blue (far) for a 0..1 fraction of the range
function distColour(frac: number): string {
    const f = Math.min(1, Math.max(0, frac));
    return `hsl(${Math.round(240 * f)}, 75%, 40%)`;
}

const DistanceStripVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: DistanceStripOptions = ((attribute as any)?.vo ?? {}) as DistanceStripOptions;
    const [showLabels, setShowLabels] = useState<boolean>(true);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;
    if (!attribute || !deviceState || !attrState) {
        return null;
    }
    const values = latestSample(attrState);
    if (values.length === 0) {
        return null;
    }

    const layout: number[][] = opts.layout ?? [values.map((_, i) => i + 1)];
    const numCols = Math.max(...layout.map(row => row.length));
    const maxValue = opts.maxValue ?? attribute.r?.[1] ?? 2000;
    const units = attrState.units || '';
    const validBits = opts.validAttr ? latestSample(deviceState.deviceAttributes[opts.validAttr])[0] : NaN;

    const isValid = (n: number): boolean => {
        const v = values[n - 1];
        if (!Number.isFinite(v) || (opts.noValue !== undefined && v === opts.noValue)) return false;
        if (Number.isFinite(validBits)) return ((validBits >> (n - 1)) & 1) === 1;
        return true;
    };
    const numValid = values.reduce((acc, _, i) => acc + (isValid(i + 1) ? 1 : 0), 0);

    const cells: JSX.Element[] = [];
    layout.forEach((row, r) => {
        for (let c = 0; c < numCols; c++) {
            const n = row[c] ?? 0;
            if (n < 1 || n > values.length) {
                cells.push(<div key={`${r}_${c}`} className="diststrip-cell diststrip-empty" />);
                continue;
            }
            const label = attribute.el?.[n - 1] ?? String(n);
            const valid = isValid(n);
            const v = values[n - 1];
            const frac = valid ? Math.min(1, v / maxValue) : 1;
            cells.push(
                <div key={`${r}_${c}`} className="diststrip-cell"
                    style={{ backgroundColor: valid ? distColour(frac) : '#444' }}
                    title={`${label}: ${valid ? `${v}${units ? ' ' + units : ''}` : 'no valid reading'}`}>
                    {showLabels && <span className="diststrip-label">{label}</span>}
                    <span className="diststrip-value">{valid ? Math.round(v) : '–'}</span>
                    <div className="diststrip-bar">
                        <div style={{ width: `${valid ? Math.round((1 - frac) * 100) : 0}%` }} />
                    </div>
                </div>
            );
        }
    });

    return (
        <div className="device-diststrip">
            <div className="zonegrid-header">
                <span className="zonegrid-title">{attribute.n}{units ? ` (${units})` : ''}</span>
                <span>{numValid} of {values.length} valid</span>
                <label><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />labels</label>
                <span className="zonegrid-range">near 0 – far {maxValue}{units ? ` ${units}` : ''}</span>
            </div>
            <div className="diststrip-grid" style={{ gridTemplateColumns: `repeat(${numCols}, 1fr)` }}>
                {cells}
            </div>
        </div>
    );
});

export default DistanceStripVisualizer;
