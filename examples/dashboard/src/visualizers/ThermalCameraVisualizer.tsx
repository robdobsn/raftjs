/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// ThermalCameraVisualizer
// Thermal image for an infrared array (thermal camera) such as the MLX90640 (32x24) or AMG8833 (8x8): an array
// attribute holding one temperature per pixel, row by row. Drawn on a canvas in a false-colour palette scaled to
// the frame's coldest and hottest pixels, with a colour bar and the minimum, maximum, centre (and ambient)
// temperatures. Renders in the chart panel; updates with the panel's chart timer.
//
// The grid size comes from the attribute's "resolution" ("<columns>x<rows>", e.g. "32x24"), else it is taken as
// square. Options come from the attribute's "vo" (visualizer options) object in the device type record:
//   ambientAttr  name of a scalar attribute with the sensor's own (ambient) temperature, shown with the others
//   flipX/flipY  initial mirroring (whether the image is seen from the sensor or towards it depends on the optics)
//
// Values below -100 (e.g. a pixel the device couldn't work out) are treated as missing and drawn black.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo, useEffect, useRef, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { DeviceVisualizerProps } from './VisualizerRegistry';

const connManager = ConnManager.getInstance();

interface ThermalOptions {
    ambientAttr?: string;
    flipX?: boolean;
    flipY?: boolean;
}

// Latest complete sample of an attribute (all its elements)
function latestSample(attrState: DeviceAttributeState | undefined): number[] {
    if (!attrState) return [];
    const elems = attrState.elemsPerSample ?? 1;
    if (attrState.values.length < elems) return [];
    return attrState.values.slice(-elems).map(v => typeof v === 'number' ? v : NaN);
}

// Columns and rows from a "resolution" such as "32x24", else a square grid
export function thermalGridSize(resolution: string | undefined, numPixels: number): { cols: number; rows: number } {
    const match = typeof resolution === 'string' ? /^(\d+)x(\d+)$/.exec(resolution) : null;
    if (match) {
        const cols = parseInt(match[1], 10);
        const rows = parseInt(match[2], 10);
        if (cols > 0 && rows > 0 && cols * rows <= numPixels) return { cols, rows };
    }
    const side = Math.max(1, Math.floor(Math.sqrt(numPixels)));
    return { cols: side, rows: side };
}

// False-colour palette (dark blue through purple, red and orange to pale yellow): a position 0-1 to RGB
const PALETTE_STOPS: Array<[number, number, number, number]> = [
    [0.00, 0, 0, 20],
    [0.15, 40, 0, 110],
    [0.35, 140, 10, 140],
    [0.55, 220, 50, 60],
    [0.75, 250, 140, 10],
    [0.90, 255, 215, 60],
    [1.00, 255, 255, 220],
];

export function thermalColour(pos: number): [number, number, number] {
    const p = Math.min(1, Math.max(0, Number.isFinite(pos) ? pos : 0));
    for (let i = 1; i < PALETTE_STOPS.length; i++) {
        const [p1, r1, g1, b1] = PALETTE_STOPS[i];
        if (p <= p1) {
            const [p0, r0, g0, b0] = PALETTE_STOPS[i - 1];
            const f = (p - p0) / (p1 - p0);
            return [Math.round(r0 + f * (r1 - r0)), Math.round(g0 + f * (g1 - g0)), Math.round(b0 + f * (b1 - b0))];
        }
    }
    const last = PALETTE_STOPS[PALETTE_STOPS.length - 1];
    return [last[1], last[2], last[3]];
}

const MISSING_BELOW_C = -100;
const DISPLAY_W = 480;

const ThermalCameraVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const opts: ThermalOptions = ((attribute as any)?.vo ?? {}) as ThermalOptions;
    const [flipX, setFlipX] = useState<boolean>(!!opts.flipX);
    const [flipY, setFlipY] = useState<boolean>(!!opts.flipY);
    const [smooth, setSmooth] = useState<boolean>(true);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrState = attribute ? deviceState?.deviceAttributes[attribute.n] : undefined;
    const pixels = latestSample(attrState);
    const { cols, rows } = thermalGridSize((attribute as any)?.resolution, pixels.length);
    const valid = pixels.slice(0, cols * rows).filter(v => Number.isFinite(v) && v >= MISSING_BELOW_C);
    const minC = valid.length ? Math.min(...valid) : NaN;
    const maxC = valid.length ? Math.max(...valid) : NaN;
    const span = maxC - minC > 0.1 ? maxC - minC : 0.1;

    // Centre: the middle pixel (the mean of the middle four for an even grid)
    const centreCells: number[] = [];
    for (const r of rows % 2 ? [(rows - 1) / 2] : [rows / 2 - 1, rows / 2])
        for (const c of cols % 2 ? [(cols - 1) / 2] : [cols / 2 - 1, cols / 2])
            centreCells.push(pixels[r * cols + c]);
    const centreValid = centreCells.filter(v => Number.isFinite(v) && v >= MISSING_BELOW_C);
    const centreC = centreValid.length ? centreValid.reduce((a, b) => a + b, 0) / centreValid.length : NaN;
    const ambientC = opts.ambientAttr ? latestSample(deviceState?.deviceAttributes[opts.ambientAttr])[0] : undefined;

    // Draw: the grid at one canvas pixel per sensor pixel, scaled up by the browser (smoothly or as blocks)
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || pixels.length < cols * rows) return;
        const off = document.createElement('canvas');
        off.width = cols;
        off.height = rows;
        const offCtx = off.getContext('2d');
        const ctx = canvas.getContext('2d');
        if (!offCtx || !ctx) return;
        const image = offCtx.createImageData(cols, rows);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const v = pixels[r * cols + c];
                const x = flipX ? cols - 1 - c : c;
                const y = flipY ? rows - 1 - r : r;
                const idx = (y * cols + x) * 4;
                const [cr, cg, cb] = Number.isFinite(v) && v >= MISSING_BELOW_C ? thermalColour((v - minC) / span) : [0, 0, 0];
                image.data[idx] = cr;
                image.data[idx + 1] = cg;
                image.data[idx + 2] = cb;
                image.data[idx + 3] = 255;
            }
        }
        offCtx.putImageData(image, 0, 0);
        ctx.imageSmoothingEnabled = smooth;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    });

    if (!attribute || !deviceState || !attrState || pixels.length === 0) {
        return null;
    }
    const fmt = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? `${v.toFixed(1)} °C` : '-');
    const barStops = PALETTE_STOPS.map(([p, r, g, b]) => `rgb(${r},${g},${b}) ${p * 100}%`).join(', ');

    return (
        <div className="device-thermal">
            <div className="zonegrid-header">
                <span className="zonegrid-title">{attribute.n} ({cols}x{rows})</span>
                <span>min {fmt(minC)}</span>
                <span>max {fmt(maxC)}</span>
                <span>centre {fmt(centreC)}</span>
                {ambientC !== undefined && <span>sensor {fmt(ambientC)}</span>}
                <label><input type="checkbox" checked={smooth} onChange={e => setSmooth(e.target.checked)} />smooth</label>
                <label><input type="checkbox" checked={flipX} onChange={e => setFlipX(e.target.checked)} />flip X</label>
                <label><input type="checkbox" checked={flipY} onChange={e => setFlipY(e.target.checked)} />flip Y</label>
            </div>
            <div className="thermal-body">
                <canvas ref={canvasRef} className="thermal-canvas" width={DISPLAY_W} height={Math.round((DISPLAY_W * rows) / cols)} />
                <div className="thermal-scale">
                    <span>{fmt(maxC)}</span>
                    <div className="thermal-scale-bar" style={{ background: `linear-gradient(to top, ${barStops})` }} />
                    <span>{fmt(minC)}</span>
                </div>
            </div>
        </div>
    );
});

export default ThermalCameraVisualizer;
