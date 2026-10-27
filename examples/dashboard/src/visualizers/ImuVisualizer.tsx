/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// ImuVisualizer
// 3D orientation views for an inertial / motion sensor: accelerometer, gyroscope and magnetometer, each shown only
// when the device has that sensor's attributes (e.g. LSM6DS3: gyro + accelerometer; ADXL313, MXC400xXC:
// accelerometer; MMC5603: magnetometer). Each view draws the sensor's X/Y/Z axes as red/green/blue arrows in a
// perspective view (drag a view to turn it), with the readings below. Renders in the chart panel; updates (and
// draws) with the panel's chart timer, not per sample.
//
//   Accelerometer  orientation from gravity: roll and pitch from the latest reading (yaw can't be known, so is 0).
//                  The sensor's axes are drawn tilted accordingly, with the measured acceleration (yellow) - at
//                  rest it points straight up, its length the magnitude in g. Movement adds to gravity and so
//                  disturbs the tilt.
//   Gyroscope      orientation from integrating the angular rates (°/s, right-hand rule, sensor frame) of every
//                  new sample since the last update, timed by the device timeline's sample timestamps (wall clock
//                  if there are none). Starts (and resets) at the accelerometer's tilt if there is one, else level.
//                  It drifts: "zero" takes the mean rate of the recent samples (held still) as the bias to remove.
//   Magnetometer   the sensor's axes fixed, with the direction of the measured field (magenta, normalised) and its
//                  horizontal part (dashed); heading = the angle of the field's XY part from X (sensor level, Z up),
//                  and tilt-compensated using the accelerometer when there is one. No hard/soft-iron calibration.
//
// Placement: the visualizer goes on one attribute per device - the one with "vt": "imu", else the first attribute
// of any sensor found. Sensors are found by attribute name: ax/ay/az, gx/gy/gz, mx/my/mz, or a plain x/y/z whose
// units say what it is (µT or gauss: magnetometer, g: accelerometer, °/s: gyro). Options come from the "vo"
// (visualizer options) object of the "vt": "imu" attribute - each an array of three attribute names:
//   accel  accelerometer X, Y, Z    e.g. {"accel":["ax","ay","az"],"gyro":["gx","gy","gz"],"mag":["mx","my","mz"]}
//   gyro   gyroscope X, Y, Z (°/s; rad/s is converted)
//   mag    magnetometer X, Y, Z
// The axes are taken as right-handed as the record gives them.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import React, { memo, useEffect, useRef, useState } from 'react';
import ConnManager from '../ConnManager';
import { DeviceState, DeviceAttributeState } from '../../../../src/RaftDeviceStates';
import { decodeAttrUnitsEncoding } from '../../../../src/RaftDeviceInfo';
import { DeviceVisualizerProps } from './VisualizerRegistry';
import {
    Vec3, Quat, QUAT_IDENTITY, ImuView, GyroSample,
    discoverImuAxes, gyroUnitsToDegS, quatFromAccel, quatRotate, quatToEuler, tiltFromAccel,
    integrateGyroSamples, headingFromMag, tiltCompensatedHeading, projectPoint, vecLength, vecNormalise,
} from './imuMath';

const connManager = ConnManager.getInstance();

const VIEW_SIZE = 200;
const GYRO_BAR_RANGE_DEGS = 250;
const GYRO_BIAS_SAMPLES = 100;
const AXIS_COLOURS = ['#ef5350', '#66bb6a', '#42a5f5'];
const AXIS_LABELS = ['X', 'Y', 'Z'];
const ACCEL_COLOUR = '#ffd54f';
const MAG_COLOUR = '#e040fb';
const REF_COLOUR = 'rgba(255, 255, 255, 0.25)';
const RAD = 180 / Math.PI;

// Latest value of an attribute (NaN if there is none)
function latestValue(attrState: DeviceAttributeState | undefined): number {
    if (!attrState || attrState.values.length === 0) return NaN;
    const v = attrState.values[attrState.values.length - 1];
    return typeof v === 'number' ? v : NaN;
}

function latestVec(attrs: Record<string, DeviceAttributeState>, names: string[] | undefined): Vec3 | undefined {
    if (!names) return undefined;
    const v = names.map(n => latestValue(attrs[n])) as Vec3;
    return v.every(Number.isFinite) ? v : undefined;
}

interface Arrow {
    v: Vec3;
    colour: string;
    label?: string;
    width: number;
    dashed?: boolean;
}

// One 3D view: a faint horizontal reference circle and world up, an outline of the sensor board in its XY plane,
// then the arrows, furthest first
function drawScene(canvas: HTMLCanvasElement | null, azimuthDeg: number, elevationDeg: number, boardQ: Quat | undefined, arrows: Arrow[]) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = canvas.width / VIEW_SIZE;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VIEW_SIZE, VIEW_SIZE);
    const view: ImuView = { azimuthDeg, elevationDeg, scale: VIEW_SIZE * 0.34, cx: VIEW_SIZE / 2, cy: VIEW_SIZE / 2 + 6, distance: 5 };
    const origin = projectPoint([0, 0, 0], view);

    // Reference: horizontal unit circle and world up
    ctx.strokeStyle = REF_COLOUR;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * 2 * Math.PI;
        const p = projectPoint([Math.cos(a), Math.sin(a), 0], view);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    const up = projectPoint([0, 0, 1.2], view);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(up.x, up.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sensor board outline in the sensor's XY plane
    if (boardQ) {
        const corners: Vec3[] = [[0.55, 0.4, 0], [-0.55, 0.4, 0], [-0.55, -0.4, 0], [0.55, -0.4, 0]];
        ctx.beginPath();
        corners.forEach((c, i) => {
            const p = projectPoint(quatRotate(boardQ, c), view);
            if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.stroke();
    }

    // Arrows, furthest first
    const projected = arrows.map(a => ({ a, tip: projectPoint(a.v, view) }));
    projected.sort((p, q) => q.tip.depth - p.tip.depth);
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const { a, tip } of projected) {
        const len = vecLength(a.v);
        if (len < 1e-6) continue;
        const neck = projectPoint([a.v[0] * 0.8, a.v[1] * 0.8, a.v[2] * 0.8], view);
        ctx.strokeStyle = a.colour;
        ctx.fillStyle = a.colour;
        ctx.lineWidth = a.width;
        ctx.setLineDash(a.dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
        ctx.setLineDash([]);
        // Arrowhead in screen space (pointing along the projected shaft; shrinks as the arrow points at the viewer)
        const dx = tip.x - neck.x;
        const dy = tip.y - neck.y;
        const headLen = Math.min(10, Math.hypot(dx, dy) * 1.5);
        if (!a.dashed && headLen > 1) {
            const ang = Math.atan2(dy, dx);
            ctx.beginPath();
            ctx.moveTo(tip.x, tip.y);
            ctx.lineTo(tip.x - headLen * Math.cos(ang - 0.45), tip.y - headLen * Math.sin(ang - 0.45));
            ctx.lineTo(tip.x - headLen * Math.cos(ang + 0.45), tip.y - headLen * Math.sin(ang + 0.45));
            ctx.closePath();
            ctx.fill();
        }
        if (a.label) {
            const lp = projectPoint([a.v[0] * (1 + 0.18 / len), a.v[1] * (1 + 0.18 / len), a.v[2] * (1 + 0.18 / len)], view);
            ctx.fillText(a.label, lp.x, lp.y);
        }
    }
}

function axisArrows(q: Quat): Arrow[] {
    const unit: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return unit.map((u, i) => ({ v: quatRotate(q, u), colour: AXIS_COLOURS[i], label: AXIS_LABELS[i], width: 3 }));
}

const fmt = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '-');
const fmtDeg = (rad: number) => (Number.isFinite(rad) ? `${(rad * RAD).toFixed(1)}°` : '-');

function unitsOf(deviceState: DeviceState, name: string | undefined): string {
    const u = deviceState.deviceTypeInfo?.resp?.a?.find(a => a.n === name)?.u;
    return u ? decodeAttrUnitsEncoding(u) : '';
}

function Readout({ names, values, units }: { names: string[]; values: Vec3; units: string }) {
    return (
        <div className="imu-readout">
            {values.map((v, i) => (
                <span key={i} style={{ color: AXIS_COLOURS[i] }}>{names[i]} {fmt(v)}</span>
            ))}
            {units && <span className="imu-units">{units}</span>}
        </div>
    );
}

const ImuVisualizer: React.FC<DeviceVisualizerProps> = memo(({ deviceKey, attribute }) => {
    const [azimuthDeg, setAzimuthDeg] = useState<number>(-30);
    const [elevationDeg, setElevationDeg] = useState<number>(25);
    const [gyroBias, setGyroBias] = useState<Vec3>([0, 0, 0]);
    const accelCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const gyroCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const dragRef = useRef<{ x: number; y: number } | null>(null);

    // Gyro integration state (kept across renders; advanced once per render by the samples added since)
    const gyroQRef = useRef<Quat | null>(null);
    const lastTotalRef = useRef<number | null>(null);
    const lastTimeUsRef = useRef<number | undefined>(undefined);
    const lastWallMsRef = useRef<number>(0);

    const deviceManager = connManager.getConnector().getSystemType()?.deviceMgrIF;
    const deviceState: DeviceState | undefined = deviceManager?.getDeviceState(deviceKey);
    const attrDefs = deviceState?.deviceTypeInfo?.resp?.a ?? [];
    const axes = discoverImuAxes(attrDefs);
    const attrs = deviceState?.deviceAttributes ?? {};

    const accel = latestVec(attrs, axes.accel);
    const mag = latestVec(attrs, axes.mag);
    const gyroScale = gyroUnitsToDegS(axes.gyro ? attrDefs.find(a => a.n === axes.gyro![0])?.u : undefined);
    const gyroRaw = latestVec(attrs, axes.gyro);
    const gyroRate: Vec3 | undefined = gyroRaw &&
        [gyroRaw[0] * gyroScale - gyroBias[0], gyroRaw[1] * gyroScale - gyroBias[1], gyroRaw[2] * gyroScale - gyroBias[2]];
    const accelQ = accel ? quatFromAccel(accel) : undefined;

    // Integrate the gyro samples added since the last render (idempotent: a repeat render finds none new)
    if (deviceState && axes.gyro && gyroRaw) {
        const timeline = deviceState.deviceTimeline;
        const total = timeline.totalSamplesAdded;
        const nowMs = Date.now();
        const gyroStates = axes.gyro.map(n => attrs[n]);
        if (gyroQRef.current === null || lastTotalRef.current === null) {
            gyroQRef.current = accelQ ?? ([...QUAT_IDENTITY] as Quat);
            const ts = timeline.timestampsUs;
            lastTimeUsRef.current = ts.length ? ts[ts.length - 1] : undefined;
        } else if (total > lastTotalRef.current) {
            const available = Math.min(...gyroStates.map(s => s.values.length));
            const numNew = Math.min(total - lastTotalRef.current, available);
            const ts = timeline.timestampsUs;
            const timed = ts.length >= numNew;
            const samples: GyroSample[] = [];
            for (let i = 0; i < numNew; i++) {
                const rate = gyroStates.map((s, axis) => {
                    const v = s.values[s.values.length - numNew + i];
                    return (typeof v === 'number' ? v : 0) * gyroScale - gyroBias[axis];
                }) as Vec3;
                samples.push({ rate, timeUs: timed ? ts[ts.length - numNew + i] : undefined });
            }
            const fallbackDtS = numNew > 0 ? (nowMs - lastWallMsRef.current) / 1000 / numNew : 0;
            const res = integrateGyroSamples(gyroQRef.current, samples, lastTimeUsRef.current, fallbackDtS);
            gyroQRef.current = res.q;
            lastTimeUsRef.current = res.lastTimeUs;
        }
        lastTotalRef.current = total;
        lastWallMsRef.current = nowMs;
    }
    const gyroQ = gyroQRef.current ?? undefined;

    // Draw all views after each render (the chart timer re-renders this)
    useEffect(() => {
        if (accel && accelQ) {
            const g = vecLength(accel);
            drawScene(accelCanvasRef.current, azimuthDeg, elevationDeg, accelQ, [
                ...axisArrows(accelQ),
                { v: [0, 0, Math.min(1.6, g)], colour: ACCEL_COLOUR, label: 'a', width: 2 },
            ]);
        }
        if (gyroQ) {
            drawScene(gyroCanvasRef.current, azimuthDeg, elevationDeg, gyroQ, axisArrows(gyroQ));
        }
        if (mag) {
            const b = vecNormalise(mag);
            drawScene(magCanvasRef.current, azimuthDeg, elevationDeg, QUAT_IDENTITY, [
                ...axisArrows(QUAT_IDENTITY),
                { v: [b[0], b[1], 0], colour: MAG_COLOUR, width: 1, dashed: true },
                { v: b, colour: MAG_COLOUR, label: 'B', width: 2.5 },
            ]);
        }
    });

    if (!attribute || !deviceState || (!accel && !gyroRaw && !mag)) {
        return null;
    }

    // Drag on a view to turn it (shared by all views)
    const dragHandlers = {
        onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
            dragRef.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
            const start = dragRef.current;
            if (!start) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            dragRef.current = { x: e.clientX, y: e.clientY };
            setAzimuthDeg(a => a + dx * 0.6);
            setElevationDeg(el => Math.max(-89, Math.min(89, el + dy * 0.6)));
        },
        onPointerUp: () => { dragRef.current = null; },
        onPointerCancel: () => { dragRef.current = null; },
    };
    const dpr = typeof window !== 'undefined' ? Math.max(1, Math.round(window.devicePixelRatio || 1)) : 1;
    const canvasProps = {
        className: 'imu-canvas',
        width: VIEW_SIZE * dpr,
        height: VIEW_SIZE * dpr,
        style: { width: VIEW_SIZE, height: VIEW_SIZE },
        title: 'drag to turn the view',
        ...dragHandlers,
    };

    const resetGyro = () => {
        gyroQRef.current = accelQ ?? ([...QUAT_IDENTITY] as Quat);
    };
    const zeroGyroBias = () => {
        if (!axes.gyro) return;
        const bias = axes.gyro.map(n => {
            const vals = (attrs[n]?.values ?? []).slice(-GYRO_BIAS_SAMPLES).filter((v): v is number => typeof v === 'number');
            return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length) * gyroScale : 0;
        }) as Vec3;
        setGyroBias(bias);
        resetGyro();
    };

    const tilt = accel ? tiltFromAccel(accel) : undefined;
    const gyroEuler = gyroQ ? quatToEuler(gyroQ) : undefined;
    const heading = mag ? headingFromMag(mag) : NaN;
    const headingTc = mag && accel ? tiltCompensatedHeading(mag, accel) : NaN;
    const biasSet = gyroBias.some(b => b !== 0);

    return (
        <div className="device-imu">
            <div className="zonegrid-header">
                <span className="zonegrid-title">orientation</span>
                <span><span style={{ color: AXIS_COLOURS[0] }}>X</span> <span style={{ color: AXIS_COLOURS[1] }}>Y</span> <span style={{ color: AXIS_COLOURS[2] }}>Z</span> sensor axes</span>
                <button onClick={() => { setAzimuthDeg(-30); setElevationDeg(25); }}>reset view</button>
            </div>
            <div className="imu-body">
                {accel && axes.accel && (
                    <div className="imu-section">
                        <div className="imu-section-title">accelerometer</div>
                        <canvas ref={accelCanvasRef} {...canvasProps} />
                        <Readout names={axes.accel} values={accel} units={unitsOf(deviceState, axes.accel[0])} />
                        <div className="imu-readout">
                            <span>|a| {fmt(vecLength(accel))}</span>
                            <span>roll {fmtDeg(tilt?.roll ?? NaN)}</span>
                            <span>pitch {fmtDeg(tilt?.pitch ?? NaN)}</span>
                        </div>
                    </div>
                )}
                {gyroRate && axes.gyro && (
                    <div className="imu-section">
                        <div className="imu-section-title">
                            gyroscope
                            <button onClick={resetGyro} title="restart the integrated orientation (from the accelerometer tilt if there is one)">reset</button>
                            <button onClick={zeroGyroBias} title={`hold the sensor still, then take the mean of the last ${GYRO_BIAS_SAMPLES} samples as the bias`}>zero</button>
                            {biasSet && <button onClick={() => setGyroBias([0, 0, 0])} title="clear the bias">clear bias</button>}
                        </div>
                        <canvas ref={gyroCanvasRef} {...canvasProps} />
                        <div className="imu-rates">
                            {gyroRate.map((r, i) => {
                                const frac = Math.max(-1, Math.min(1, r / GYRO_BAR_RANGE_DEGS));
                                return (
                                    <div key={i} className="imu-rate" title={`${axes.gyro![i]} ${fmt(r)} °/s (bar ±${GYRO_BAR_RANGE_DEGS})`}>
                                        <span style={{ color: AXIS_COLOURS[i] }}>{axes.gyro![i]}</span>
                                        <div className="imu-rate-bar">
                                            <div style={{
                                                left: `${50 + Math.min(0, frac) * 50}%`, width: `${Math.abs(frac) * 50}%`,
                                                backgroundColor: AXIS_COLOURS[i],
                                            }} />
                                        </div>
                                        <span className="imu-rate-value">{fmt(r, 1)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="imu-readout">
                            <span>°/s{biasSet ? ' (bias removed)' : ''}</span>
                            <span>roll {fmtDeg(gyroEuler?.roll ?? NaN)}</span>
                            <span>pitch {fmtDeg(gyroEuler?.pitch ?? NaN)}</span>
                            <span>yaw {fmtDeg(gyroEuler?.yaw ?? NaN)}</span>
                        </div>
                    </div>
                )}
                {mag && axes.mag && (
                    <div className="imu-section">
                        <div className="imu-section-title">magnetometer</div>
                        <canvas ref={magCanvasRef} {...canvasProps} />
                        <Readout names={axes.mag} values={mag} units={unitsOf(deviceState, axes.mag[0])} />
                        <div className="imu-readout">
                            <span>|B| {fmt(vecLength(mag))}</span>
                            <span>heading {Number.isFinite(heading) ? `${heading.toFixed(0)}°` : '-'}</span>
                            {accel && <span>tilt-comp. {Number.isFinite(headingTc) ? `${headingTc.toFixed(0)}°` : '-'}</span>}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
});

export default ImuVisualizer;
