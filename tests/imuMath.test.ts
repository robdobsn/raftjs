// IMU visualizer maths: attribute discovery, tilt, quaternions, gyro integration, heading and projection
import {
    discoverImuAxes, imuMatchScore, sensorKindFromUnits, gyroUnitsToDegS,
    quatFromAxisAngle, quatRotate, quatMultiply, quatFromEuler, quatToEuler, QUAT_IDENTITY, Quat, Vec3,
    tiltFromAccel, quatFromAccel, integrateGyro, integrateGyroSamples,
    headingFromMag, tiltCompensatedHeading, projectPoint, ImuView,
} from '../examples/dashboard/src/visualizers/imuMath';

const DEG = Math.PI / 180;

function expectVec(actual: Vec3, expected: Vec3, digits = 6) {
    actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
}

describe('discoverImuAxes', () => {
    test('LSM6DS3: gyro and accel by default names, placed on the first (gx)', () => {
        const axes = discoverImuAxes(['gx', 'gy', 'gz', 'ax', 'ay', 'az'].map(n => ({ n })));
        expect(axes.accel).toEqual(['ax', 'ay', 'az']);
        expect(axes.gyro).toEqual(['gx', 'gy', 'gz']);
        expect(axes.mag).toBeUndefined();
        expect(axes.anchor).toBe('gx');
    });

    test('accelerometer only, with another attribute first', () => {
        const axes = discoverImuAxes([{ n: 'temperature' }, { n: 'ax' }, { n: 'ay' }, { n: 'az' }]);
        expect(axes.accel).toEqual(['ax', 'ay', 'az']);
        expect(axes.anchor).toBe('ax');
    });

    test('MMC5603: x/y/z in µT is a magnetometer', () => {
        const axes = discoverImuAxes(['x', 'y', 'z'].map(n => ({ n, u: '&micro;T' })));
        expect(axes.mag).toEqual(['x', 'y', 'z']);
        expect(axes.accel).toBeUndefined();
        expect(axes.anchor).toBe('x');
    });

    test('x/y/z with no recognised units is not an IMU', () => {
        const axes = discoverImuAxes(['x', 'y', 'z'].map(n => ({ n, u: 'mm' })));
        expect(axes.anchor).toBeUndefined();
    });

    test('vt imu with vo names the axes and places the view', () => {
        const attrs = [
            { n: 'accX' }, { n: 'accY' }, { n: 'accZ' },
            { n: 'status', vt: 'imu', vo: { accel: ['accX', 'accY', 'accZ'] } },
        ];
        const axes = discoverImuAxes(attrs);
        expect(axes.accel).toEqual(['accX', 'accY', 'accZ']);
        expect(axes.anchor).toBe('status');
    });

    test('match score: one attribute per device', () => {
        const lsm = ['gx', 'gy', 'gz', 'ax', 'ay', 'az'].map(n => ({ n }));
        expect(lsm.map(a => imuMatchScore(a.n, lsm))).toEqual([30, 0, 0, 0, 0, 0]);
        const explicit = [{ n: 'ax' }, { n: 'ay', vt: 'imu' }, { n: 'az', vt: 'imu' }];
        expect(explicit.map(a => imuMatchScore(a.n, explicit))).toEqual([0, 100, 0]);
        expect(imuMatchScore('temperature', [{ n: 'temperature' }])).toBe(0);
    });

    test('units classification', () => {
        expect(sensorKindFromUnits('&micro;T')).toBe('mag');
        expect(sensorKindFromUnits('uT')).toBe('mag');
        expect(sensorKindFromUnits('gauss')).toBe('mag');
        expect(sensorKindFromUnits('G')).toBe('mag');
        expect(sensorKindFromUnits('g')).toBe('accel');
        expect(sensorKindFromUnits('m/s&sup2;')).toBe('accel');
        expect(sensorKindFromUnits('&deg;/s')).toBe('gyro');
        expect(sensorKindFromUnits('mm')).toBeUndefined();
        expect(gyroUnitsToDegS('rad/s')).toBeCloseTo(57.2958, 3);
        expect(gyroUnitsToDegS('&deg;/s')).toBe(1);
    });
});

describe('quaternions', () => {
    test('rotation about Z by 90 degrees turns X into Y', () => {
        expectVec(quatRotate(quatFromAxisAngle([0, 0, 1], 90 * DEG), [1, 0, 0]), [0, 1, 0]);
    });

    test('Euler round trip', () => {
        const q = quatFromEuler(20 * DEG, -35 * DEG, 110 * DEG);
        const e = quatToEuler(q);
        expect(e.roll / DEG).toBeCloseTo(20, 6);
        expect(e.pitch / DEG).toBeCloseTo(-35, 6);
        expect(e.yaw / DEG).toBeCloseTo(110, 6);
    });

    test('multiply composes rotations (b then a)', () => {
        const a = quatFromAxisAngle([0, 0, 1], 90 * DEG);
        const b = quatFromAxisAngle([1, 0, 0], 90 * DEG);
        // b takes Y to Z; a leaves Z alone
        expectVec(quatRotate(quatMultiply(a, b), [0, 1, 0]), [0, 0, 1]);
    });
});

describe('tilt from accelerometer', () => {
    test('level sensor has no tilt', () => {
        const t = tiltFromAccel([0, 0, 1])!;
        expect(t.roll).toBeCloseTo(0);
        expect(t.pitch).toBeCloseTo(0);
    });

    test('Y up is a roll of 90; X up is a pitch of -90', () => {
        expect(tiltFromAccel([0, 1, 0])!.roll / DEG).toBeCloseTo(90);
        expect(tiltFromAccel([1, 0, 0])!.pitch / DEG).toBeCloseTo(-90);
    });

    test('the orientation rotates any reading onto world up', () => {
        const readings: Vec3[] = [[0.3, -0.5, 0.8], [-0.9, 0.2, -0.1], [0.1, 0.1, -1], [0.7, 0.7, 0]];
        for (const a of readings) {
            const len = Math.hypot(...a);
            expectVec(quatRotate(quatFromAccel(a)!, a), [0, 0, len]);
        }
    });

    test('zero or invalid reading gives no tilt', () => {
        expect(tiltFromAccel([0, 0, 0])).toBeUndefined();
        expect(tiltFromAccel([NaN, 0, 1])).toBeUndefined();
    });
});

describe('gyro integration', () => {
    test('90 deg/s about Z for 1 s in 100 steps turns X into Y', () => {
        let q: Quat = [...QUAT_IDENTITY] as Quat;
        for (let i = 0; i < 100; i++) q = integrateGyro(q, [0, 0, 90], 0.01);
        expectVec(quatRotate(q, [1, 0, 0]), [0, 1, 0], 5);
    });

    test('rates are in the body frame: after a roll of 90, a body Z rate turns about world -Y', () => {
        let q = quatFromAxisAngle([1, 0, 0], 90 * DEG);
        q = integrateGyro(q, [0, 0, 90], 1);
        // body X: rotated about body Z (now world -Y) by 90 -> world +Z? body X -> body Y -> world Z
        expectVec(quatRotate(q, [1, 0, 0]), [0, 0, 1], 5);
    });

    test('timestamped samples use their intervals, first from the previous time', () => {
        const samples = Array.from({ length: 50 }, (_, i) => ({ rate: [0, 0, 45] as Vec3, timeUs: 1_000_000 + (i + 1) * 20_000 }));
        const res = integrateGyroSamples([...QUAT_IDENTITY] as Quat, samples, 1_000_000, 0);
        expect(quatToEuler(res.q).yaw / DEG).toBeCloseTo(45, 4);
        expect(res.lastTimeUs).toBe(2_000_000);
    });

    test('without a previous time the first timestamped sample only starts the clock', () => {
        const samples = [0, 1, 2].map(i => ({ rate: [0, 0, 100] as Vec3, timeUs: i * 100_000 }));
        const res = integrateGyroSamples([...QUAT_IDENTITY] as Quat, samples, undefined, 0);
        expect(quatToEuler(res.q).yaw / DEG).toBeCloseTo(20, 4);
    });

    test('untimed samples use the fallback interval; long gaps are clamped', () => {
        const untimed = integrateGyroSamples([...QUAT_IDENTITY] as Quat, [{ rate: [0, 0, 10] }, { rate: [0, 0, 10] }], undefined, 0.5);
        expect(quatToEuler(untimed.q).yaw / DEG).toBeCloseTo(10, 4);
        const gap = integrateGyroSamples([...QUAT_IDENTITY] as Quat, [{ rate: [0, 0, 10], timeUs: 10_000_000 }], 0, 0);
        expect(quatToEuler(gap.q).yaw / DEG).toBeCloseTo(5, 4);
    });
});

describe('magnetometer heading', () => {
    test('level sensor: heading is the angle of the field from X', () => {
        expect(headingFromMag([30, 0, -40])).toBeCloseTo(0);
        expect(headingFromMag([0, 30, -40])).toBeCloseTo(90);
        expect(headingFromMag([0, -30, -40])).toBeCloseTo(270);
        expect(headingFromMag([0, 0, -40])).toBeNaN();
    });

    test('tilt compensation recovers the level heading', () => {
        // Field with north 60 degrees anticlockwise of X and a downward dip, as seen by a level sensor
        const fieldLevel: Vec3 = [20 * Math.cos(60 * DEG), 20 * Math.sin(60 * DEG), -40];
        // Tilt the sensor (roll 25, pitch -15): body readings are the world vectors rotated by the inverse
        const q = quatFromEuler(25 * DEG, -15 * DEG, 0);
        const qInv: Quat = [q[0], -q[1], -q[2], -q[3]];
        const m = quatRotate(qInv, fieldLevel);
        const a = quatRotate(qInv, [0, 0, 1]);
        expect(tiltCompensatedHeading(m, a)).toBeCloseTo(60, 6);
        expect(Math.abs(headingFromMag(m) - 60)).toBeGreaterThan(1);
    });
});

describe('projection', () => {
    const view: ImuView = { azimuthDeg: 0, elevationDeg: 0, scale: 100, cx: 200, cy: 150, distance: 1e9 };

    test('front view: X right, Z up, Y into the screen', () => {
        const x = projectPoint([1, 0, 0], view);
        expect(x.x).toBeCloseTo(300);
        expect(x.y).toBeCloseTo(150);
        const z = projectPoint([0, 0, 1], view);
        expect(z.x).toBeCloseTo(200);
        expect(z.y).toBeCloseTo(50);
        const y = projectPoint([0, 1, 0], view);
        expect(y.x).toBeCloseTo(200);
        expect(y.depth).toBeCloseTo(1);
    });

    test('looking down from above, further points appear higher', () => {
        const p = projectPoint([0, 1, 0], { ...view, elevationDeg: 30 });
        expect(p.y).toBeLessThan(150);
    });

    test('perspective makes nearer things larger', () => {
        const persp = { ...view, distance: 4 };
        const near = projectPoint([1, -1, 0], persp);
        const far = projectPoint([1, 1, 0], persp);
        expect(near.x - 200).toBeGreaterThan(far.x - 200);
    });
});
