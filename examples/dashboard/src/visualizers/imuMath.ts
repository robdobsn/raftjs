/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// imuMath
// Pure maths for the IMU visualizer: attribute discovery, tilt from an accelerometer, quaternions (gyro
// integration), heading from a magnetometer and a simple perspective projection for drawing 3D arrows on a 2D
// canvas. No DOM or React here so it can be unit tested.
//
// Frames: right-handed. The world frame has Z up; with yaw 0 the world X axis is the sensor's X axis projected
// onto the horizontal. Quaternions are [w, x, y, z] and rotate sensor (body) vectors into the world frame.
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

import { decodeAttrUnitsEncoding } from '../../../../src/RaftDeviceInfo';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const DEG = Math.PI / 180;

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Attribute discovery
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type ImuSensorKind = 'accel' | 'gyro' | 'mag';
export const IMU_SENSOR_KINDS: ImuSensorKind[] = ['accel', 'gyro', 'mag'];

export interface ImuAttrInfo {
    n: string;
    u?: string;
    vt?: string;
    vo?: unknown;
}

export interface ImuAxes {
    accel?: [string, string, string];
    gyro?: [string, string, string];
    mag?: [string, string, string];
    // The attribute the visualizer is placed on (the vt "imu" one, else the first attribute of any sensor found)
    anchor?: string;
}

const DEFAULT_NAMES: Record<ImuSensorKind, [string, string, string]> = {
    accel: ['ax', 'ay', 'az'],
    gyro: ['gx', 'gy', 'gz'],
    mag: ['mx', 'my', 'mz'],
};

// Units, decoded and normalised for comparison (e.g. "&micro;T" -> "ut", "&deg;/s" -> "°/s")
export function normaliseUnits(u: string | undefined): string {
    if (!u) return '';
    return decodeAttrUnitsEncoding(u).replace(/[µμ]/g, 'u').replace(/\s+/g, '').toLowerCase();
}

// Which sensor a plain x/y/z attribute triple belongs to, from its units. Case matters for "G" (gauss) and "mG"
// (milligauss) against "g" and "mg" (acceleration).
export function sensorKindFromUnits(u: string | undefined): ImuSensorKind | undefined {
    if (!u) return undefined;
    const raw = decodeAttrUnitsEncoding(u).replace(/\s+/g, '');
    const nu = normaliseUnits(u);
    if (raw === 'G' || raw === 'mG' || ['ut', 'nt', 'mt', 't', 'gauss', 'mgauss', 'milligauss'].includes(nu)) return 'mag';
    if (raw === 'g' || raw === 'mg' || ['m/s²', 'm/s^2', 'm/s2'].includes(nu)) return 'accel';
    if (['°/s', 'deg/s', 'dps', 'rad/s'].includes(nu)) return 'gyro';
    return undefined;
}

// Multiplier from a gyro attribute's units to degrees per second
export function gyroUnitsToDegS(u: string | undefined): number {
    return normaliseUnits(u) === 'rad/s' ? 1 / DEG : 1;
}

function isTriple(v: unknown): v is [string, string, string] {
    return Array.isArray(v) && v.length === 3 && v.every(s => typeof s === 'string');
}

// Find the accelerometer, gyro and magnetometer axis attributes of a device. An attribute with vt "imu" may name
// them in its vo, e.g. {"accel":["ax","ay","az"],"gyro":["gx","gy","gz"],"mag":["mx","my","mz"]}; otherwise
// (and for any sensor the vo doesn't name) the defaults ax/ay/az, gx/gy/gz, mx/my/mz are used, and a plain
// x/y/z triple is taken as the sensor its units indicate (µT or gauss: magnetometer, g: accelerometer, °/s: gyro).
export function discoverImuAxes(attrs: ImuAttrInfo[]): ImuAxes {
    const byName = new Map(attrs.map(a => [a.n, a]));
    const has = (t: [string, string, string]) => t.every(n => byName.has(n));
    const result: ImuAxes = {};
    const vtAttr = attrs.find(a => a.vt === 'imu');
    const vo = (vtAttr?.vo && typeof vtAttr.vo === 'object') ? vtAttr.vo as Record<string, unknown> : {};

    for (const kind of IMU_SENSOR_KINDS) {
        const named = vo[kind];
        if (isTriple(named) && has(named)) {
            result[kind] = named;
        } else if (has(DEFAULT_NAMES[kind])) {
            result[kind] = DEFAULT_NAMES[kind];
        }
    }
    const xyz: [string, string, string] = ['x', 'y', 'z'];
    if (has(xyz)) {
        const kind = sensorKindFromUnits(byName.get('x')?.u);
        if (kind && !result[kind]) result[kind] = xyz;
    }

    const used = new Set<string>(IMU_SENSOR_KINDS.flatMap(k => result[k] ?? []));
    if (vtAttr) {
        result.anchor = vtAttr.n;
    } else {
        result.anchor = attrs.find(a => used.has(a.n))?.n;
    }
    return result;
}

// Registry match score for an attribute: the visualizer goes on one attribute per device only (the anchor) -
// 100 for an explicit vt "imu" (the first such attribute), 30 when found by the naming/units heuristics
export function imuMatchScore(attrName: string, attrs: ImuAttrInfo[]): number {
    const axes = discoverImuAxes(attrs);
    if (axes.anchor !== attrName) return 0;
    return attrs.some(a => a.vt === 'imu') ? 100 : 30;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Vectors and quaternions
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function vecLength(v: Vec3): number {
    return Math.hypot(v[0], v[1], v[2]);
}

export function vecNormalise(v: Vec3): Vec3 {
    const len = vecLength(v);
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

export const QUAT_IDENTITY: Quat = [1, 0, 0, 0];

export function quatMultiply(a: Quat, b: Quat): Quat {
    const [aw, ax, ay, az] = a;
    const [bw, bx, by, bz] = b;
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ];
}

export function quatNormalise(q: Quat): Quat {
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    return len > 0 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [...QUAT_IDENTITY] as Quat;
}

// Rotation by angleRad about an axis (need not be unit length)
export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
    const n = vecNormalise(axis);
    const s = Math.sin(angleRad / 2);
    return [Math.cos(angleRad / 2), n[0] * s, n[1] * s, n[2] * s];
}

// Rotate a vector by a unit quaternion
export function quatRotate(q: Quat, v: Vec3): Vec3 {
    const [w, x, y, z] = q;
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ];
}

// From roll (about X), pitch (about Y), yaw (about Z), radians, applied roll then pitch then yaw (ZYX)
export function quatFromEuler(rollRad: number, pitchRad: number, yawRad: number): Quat {
    const qx = quatFromAxisAngle([1, 0, 0], rollRad);
    const qy = quatFromAxisAngle([0, 1, 0], pitchRad);
    const qz = quatFromAxisAngle([0, 0, 1], yawRad);
    return quatMultiply(qz, quatMultiply(qy, qx));
}

// Roll, pitch, yaw (radians, ZYX as quatFromEuler)
export function quatToEuler(q: Quat): { roll: number; pitch: number; yaw: number } {
    const [w, x, y, z] = q;
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    const sinp = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
    const pitch = Math.asin(sinp);
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    return { roll, pitch, yaw };
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Accelerometer: tilt from gravity
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Roll and pitch (radians) from an accelerometer reading at rest (it measures the reaction to gravity, so a level
// sensor reads +1 g on Z). Yaw can't be known from gravity. Returns undefined for a zero/invalid vector.
export function tiltFromAccel(a: Vec3): { roll: number; pitch: number } | undefined {
    if (!a.every(Number.isFinite) || vecLength(a) === 0) return undefined;
    const roll = Math.atan2(a[1], a[2]);
    const pitch = Math.atan2(-a[0], Math.hypot(a[1], a[2]));
    return { roll, pitch };
}

// Sensor-to-world orientation from an accelerometer reading (yaw 0): rotates the reading onto world +Z
export function quatFromAccel(a: Vec3): Quat | undefined {
    const tilt = tiltFromAccel(a);
    return tilt ? quatFromEuler(tilt.roll, tilt.pitch, 0) : undefined;
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Gyro: integration of angular rates
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Advance a sensor-to-world orientation by body-frame angular rates (degrees per second) over dtS seconds
export function integrateGyro(q: Quat, rateDegS: Vec3, dtS: number): Quat {
    if (!(dtS > 0) || !rateDegS.every(Number.isFinite)) return q;
    const rateRad: Vec3 = [rateDegS[0] * DEG, rateDegS[1] * DEG, rateDegS[2] * DEG];
    const angle = vecLength(rateRad) * dtS;
    if (angle === 0) return q;
    return quatNormalise(quatMultiply(q, quatFromAxisAngle(rateRad, angle)));
}

export interface GyroSample {
    rate: Vec3;             // deg/s
    timeUs?: number;        // sample timestamp if known
}

// Integrate a run of samples. Each sample's rate applies over the interval since the previous sample (rectangle
// rule); the first sample is timed from prevTimeUs (if given). Samples without timestamps share fallbackDtS each.
// Intervals are clamped to maxDtS so a pause in the data doesn't spin the view. Returns the new orientation and
// the time of the last sample used.
export function integrateGyroSamples(q: Quat, samples: GyroSample[], prevTimeUs: number | undefined,
        fallbackDtS: number, maxDtS = 0.5): { q: Quat; lastTimeUs: number | undefined } {
    let lastTimeUs = prevTimeUs;
    for (const s of samples) {
        let dtS: number;
        if (s.timeUs !== undefined && Number.isFinite(s.timeUs)) {
            dtS = lastTimeUs !== undefined ? (s.timeUs - lastTimeUs) / 1e6 : 0;
            lastTimeUs = s.timeUs;
        } else {
            dtS = fallbackDtS;
        }
        q = integrateGyro(q, s.rate, Math.min(Math.max(dtS, 0), maxDtS));
    }
    return { q, lastTimeUs };
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Magnetometer: heading
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function wrapDeg360(deg: number): number {
    const d = deg % 360;
    return d < 0 ? d + 360 : d;
}

// Heading in degrees (0-360, clockwise from magnetic north looking down) of the sensor's X axis, for a sensor
// lying level with Z up: the angle of the field's horizontal part from X
export function headingFromMag(m: Vec3): number {
    if (!m.every(Number.isFinite) || (m[0] === 0 && m[1] === 0)) return NaN;
    return wrapDeg360(Math.atan2(m[1], m[0]) / DEG);
}

// Tilt-compensated heading: the field is first rotated into the level frame using the tilt from an accelerometer
export function tiltCompensatedHeading(m: Vec3, a: Vec3): number {
    const q = quatFromAccel(a);
    if (!q) return NaN;
    return headingFromMag(quatRotate(q, m));
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Projection
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface ImuView {
    azimuthDeg: number;     // rotation of the world about Z before viewing (positive turns the scene anticlockwise)
    elevationDeg: number;   // how far above the horizontal the camera looks down from
    scale: number;          // pixels per unit length (at the centre depth)
    cx: number;             // screen centre
    cy: number;
    distance: number;       // camera distance in units (perspective strength; larger is flatter)
}

// World point to screen: X right, Z up and Y into the screen at azimuth 0, elevation 0. depth > 0 is further away.
export function projectPoint(p: Vec3, view: ImuView): { x: number; y: number; depth: number } {
    const az = view.azimuthDeg * DEG;
    const el = view.elevationDeg * DEG;
    const x1 = p[0] * Math.cos(az) - p[1] * Math.sin(az);
    const y1 = p[0] * Math.sin(az) + p[1] * Math.cos(az);
    const z1 = p[2];
    const up = z1 * Math.cos(el) + y1 * Math.sin(el);
    const depth = y1 * Math.cos(el) - z1 * Math.sin(el);
    const f = view.distance / Math.max(0.1, view.distance + depth);
    return { x: view.cx + x1 * f * view.scale, y: view.cy - up * f * view.scale, depth };
}
