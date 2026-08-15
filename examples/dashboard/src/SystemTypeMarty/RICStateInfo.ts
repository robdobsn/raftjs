import RaftDeviceMgrIF from "../../../../src/RaftDeviceMgrIF";
import { DeviceTypeAction, DeviceTypeInfo, SampleRateResult } from "../../../../src/RaftDeviceInfo";
import { DeviceAttributeState, DeviceAttributesState, DevicesState, DeviceState, DeviceStats, DeviceOnlineState } from '../../../../src/RaftDeviceStates';
import { RICSERIAL_PAYLOAD_POS } from "../../../../src/RaftProtocolDefs";
import RICAddOnManager from "./RICAddOnManager";
import RICCommsStats from "./RICCommsStats";
import {
    RICROSSerial, ROSCameraData, ROSSerialAddOnStatusList, ROSSerialIMU, ROSSerialPowerStatus,
    ROSSerialRobotStatus, ROSSerialSmartServos,
    ROSTOPIC_V2_ACCEL, ROSTOPIC_V2_ADDONS, ROSTOPIC_V2_POWER_STATUS, ROSTOPIC_V2_ROBOT_STATUS, ROSTOPIC_V2_SMART_SERVOS,
} from "./RICROSSerial";

// Marty smart-servo id -> joint name (matches the RIC/roboticaljs joint ordering)
const MARTY_SERVO_NAMES: { [id: number]: string } = {
    0: "LeftHip", 1: "LeftTwist", 2: "LeftKnee",
    3: "RightHip", 4: "RightTwist", 5: "RightKnee",
    6: "LeftArm", 7: "RightArm", 8: "Eyes",
};

// Spec for one attribute sample pushed into a synthetic device frame
interface AttrSample {
    name: string;
    value: number | string;
    units?: string;
    range?: number[];
    format?: string;
    series?: boolean;
    form?: boolean;
}

export class RICStateInfo implements RaftDeviceMgrIF {
    smartServos: ROSSerialSmartServos = new ROSSerialSmartServos();
    smartServosValidMs = 0;
    imuData: ROSSerialIMU = new ROSSerialIMU();
    imuDataValidMs = 0;
    power: ROSSerialPowerStatus = new ROSSerialPowerStatus();
    powerValidMs = 0;
    addOnInfo: ROSSerialAddOnStatusList = new ROSSerialAddOnStatusList();
    addOnInfoValidMs = 0;
    robotStatus: ROSSerialRobotStatus = new ROSSerialRobotStatus();
    robotStatusValidMs = 0;
    cameraData: ROSCameraData = new ROSCameraData();
    cameraDataValidMs = 0;

    // Device state bridge - decoded ROSSerial data surfaced as chartable devices
    private _devicesState: DevicesState = {};
    private _maxDataPoints = 100;
    private _newDeviceCBs: Array<(deviceKey: string, state: DeviceState) => void> = [];
    private _newAttributeCBs: Array<(deviceKey: string, attrState: DeviceAttributeState) => void> = [];
    private _attributeDataCBs: Array<(deviceKey: string, attrState: DeviceAttributeState) => void> = [];
    private _deviceRemovedCBs: Array<(deviceKey: string, state: DeviceState) => void> = [];

    // Per-device stats (sample rate over a sliding window)
    private _stats: { [deviceKey: string]: { totalSamples: number; lastSampleMs: number | null; lastUpdateMs: number | null; windowMs: number; windowEvents: Array<{ t: number; n: number }> } } = {};

    updateFromROSSerialMsg(rxMsg: Uint8Array, commsStats: RICCommsStats,
        addOnManager: RICAddOnManager, frameTimeMs: number): Array<number> {
        const topicIDs = RICROSSerial.decode(
            rxMsg, RICSERIAL_PAYLOAD_POS, commsStats, addOnManager, this, frameTimeMs
        );

        // Surface the freshly decoded data into the device/attribute model so the
        // dashboard charts it the same way as other devices.
        const timeMs = frameTimeMs || Date.now();
        for (const topicID of topicIDs) {
            switch (topicID) {
                case ROSTOPIC_V2_SMART_SERVOS: this._ingestServos(timeMs); break;
                case ROSTOPIC_V2_ACCEL: this._ingestIMU(timeMs); break;
                case ROSTOPIC_V2_POWER_STATUS: this._ingestPower(timeMs); break;
                case ROSTOPIC_V2_ROBOT_STATUS: this._ingestRobotStatus(timeMs); break;
                case ROSTOPIC_V2_ADDONS: this._ingestAddOns(timeMs); break;
                default: break;
            }
        }
        this._dispatchCallbacks();
        return topicIDs;
    }

    // ---- Ingest helpers (decoded ROSSerial -> device frames) ----

    private _ingestServos(timeMs: number): void {
        const servos = this.smartServos.smartServos;
        if (servos.length === 0) return;
        const jointName = (id: number) => MARTY_SERVO_NAMES[id] ?? `Servo${id}`;
        this._pushDeviceFrame("Servos", "Servos", "sensor", timeMs,
            servos.map((s) => ({ name: jointName(s.id), value: s.pos, units: "°", range: [-135, 135], format: "%.0f" })));
        this._pushDeviceFrame("ServoCurrents", "Servo Currents", "sensor", timeMs,
            servos.map((s) => ({ name: jointName(s.id), value: s.current, units: "mA", range: [0, 2000], format: "%.0f" })));
    }

    private _ingestIMU(timeMs: number): void {
        const a = this.imuData.accel;
        this._pushDeviceFrame("IMU", "IMU", "sensor", timeMs, [
            { name: "ax", value: a.x, units: "g", range: [-2, 2], format: "%.2f" },
            { name: "ay", value: a.y, units: "g", range: [-2, 2], format: "%.2f" },
            { name: "az", value: a.z, units: "g", range: [-2, 2], format: "%.2f" },
        ]);
    }

    private _ingestPower(timeMs: number): void {
        const p = this.power.powerStatus;
        this._pushDeviceFrame("Power", "Power", "system", timeMs, [
            { name: "battPercent", value: p.battRemainCapacityPercent, units: "%", range: [0, 100], format: "%.0f" },
            { name: "battTemp", value: p.battTempDegC, units: "°C", range: [0, 60], format: "%.1f" },
            { name: "battCurrent", value: p.battCurrentMA, units: "mA", range: [-3000, 3000], format: "%.0f" },
            { name: "5VOnTime", value: p.power5VOnTimeSecs, units: "s", range: [0, 3600], format: "%.0f", series: false },
            { name: "5VIsOn", value: p.power5VIsOn ? 1 : 0, range: [0, 1], format: "%b", series: false },
            { name: "USBConnected", value: p.powerUSBIsConnected ? 1 : 0, range: [0, 1], format: "%b", series: false },
        ]);
    }

    private _ingestRobotStatus(timeMs: number): void {
        const r = this.robotStatus.robotStatus;
        this._pushDeviceFrame("RobotStatus", "Robot Status", "system", timeMs, [
            { name: "loopMsAvg", value: r.loopMsAvg, units: "ms", range: [0, 50], format: "%.1f" },
            { name: "loopMsMax", value: r.loopMsMax, units: "ms", range: [0, 100], format: "%.1f" },
            { name: "wifiRSSI", value: r.wifiRSSI, units: "dBm", range: [-100, 0], format: "%d" },
            { name: "bleRSSI", value: r.bleRSSI, units: "dBm", range: [-100, 0], format: "%d" },
            { name: "heapFree", value: r.heapFree, units: "B", range: [0, 300000], format: "%d", series: false },
            { name: "workQCount", value: r.workQCount, range: [0, 50], format: "%d", series: false },
            { name: "isMoving", value: r.isMoving ? 1 : 0, range: [0, 1], format: "%b", series: false },
        ]);
    }

    private _ingestAddOns(timeMs: number): void {
        for (const addon of this.addOnInfo.addons) {
            const attrs: AttrSample[] = [];
            for (const [key, val] of Object.entries(addon.vals)) {
                if (typeof val === "number") {
                    attrs.push({ name: key, value: val, range: [0, 0], format: "%.2f" });
                } else if (typeof val === "boolean") {
                    attrs.push({ name: key, value: val ? 1 : 0, range: [0, 1], format: "%b", series: false });
                } else {
                    attrs.push({ name: key, value: String(val), series: false });
                }
            }
            if (attrs.length === 0) continue;
            const name = addon.name || addon.whoAmI || `AddOn${addon.id}`;
            this._pushDeviceFrame(`addon_${addon.id}`, name, "addon", timeMs, attrs);
        }
    }

    // Push one frame (one timestamp + one value per attribute) into a synthetic
    // device, creating the device/attributes on first sight and keeping the
    // per-attribute value arrays aligned with the shared timeline.
    private _pushDeviceFrame(deviceKey: string, typeName: string, role: string, timeMs: number, attrs: AttrSample[]): void {
        const ds = this._ensureDevice(deviceKey, typeName, role);
        const timeline = ds.deviceTimeline;
        const tsUs = Math.round(timeMs * 1000);

        if (timeline.timestampsUs.length + 1 > this._maxDataPoints) {
            timeline.timestampsUs.splice(0, timeline.timestampsUs.length + 1 - this._maxDataPoints);
        }
        timeline.timestampsUs.push(tsUs);
        timeline.lastReportTimestampUs = tsUs;
        timeline.totalSamplesAdded += 1;
        const timelineLen = timeline.timestampsUs.length;

        for (const a of attrs) {
            let at = ds.deviceAttributes[a.name];
            if (!at) {
                at = {
                    name: a.name,
                    newAttribute: true,
                    newData: false,
                    numNewValues: 0,
                    values: new Array(Math.max(0, timelineLen - 1)).fill(NaN),
                    units: a.units ?? "",
                    range: a.range ?? [0, 0],
                    format: a.format ?? "",
                    visibleSeries: a.series ?? true,
                    visibleForm: a.form ?? true,
                };
                ds.deviceAttributes[a.name] = at;
            }
            at.values.push(a.value);
            at.newData = true;
            at.numNewValues = 1;
        }

        // Keep every attribute aligned with the timeline length (pad any not
        // present this frame, trim any that ran ahead).
        for (const name in ds.deviceAttributes) {
            const at = ds.deviceAttributes[name];
            if (at.values.length > timelineLen) {
                at.values.splice(0, at.values.length - timelineLen);
            } else if (at.values.length < timelineLen) {
                const last = at.values.length > 0 ? at.values[at.values.length - 1] : NaN;
                while (at.values.length < timelineLen) at.values.push(last);
            }
        }

        ds.stateChanged = true;
        ds.onlineState = DeviceOnlineState.Online;
        this._recordStats(deviceKey, 1, Date.now());
    }

    private _ensureDevice(deviceKey: string, typeName: string, role: string): DeviceState {
        let ds = this._devicesState[deviceKey];
        if (!ds) {
            const deviceTypeInfo: DeviceTypeInfo = { name: typeName, desc: typeName, manu: "Robotical", type: typeName, role };
            ds = {
                deviceTypeInfo,
                deviceTimeline: {
                    timestampsUs: [], lastReportTimestampUs: 0, reportTimestampOffsetUs: 0, totalSamplesAdded: 0,
                    emaLastSampleTimeUs: 0, emaIntervalUs: 0, emaPrevPollTimeUs: 0, emaCalibrated: false, emaCalibrationPolls: 0,
                },
                deviceAttributes: {} as DeviceAttributesState,
                deviceIsNew: true,
                stateChanged: false,
                onlineState: DeviceOnlineState.Online,
                deviceAddress: "",   // empty + busName "0" => not treated as a bus device (no devconfig query)
                deviceType: typeName,
                busName: "0",
            };
            this._devicesState[deviceKey] = ds;
        }
        return ds;
    }

    private _dispatchCallbacks(): void {
        for (const deviceKey in this._devicesState) {
            const ds = this._devicesState[deviceKey];
            if (ds.deviceIsNew) {
                this._newDeviceCBs.forEach((cb) => cb(deviceKey, ds));
                ds.deviceIsNew = false;
            }
            for (const attrName in ds.deviceAttributes) {
                const at = ds.deviceAttributes[attrName];
                if (at.newAttribute) {
                    this._newAttributeCBs.forEach((cb) => cb(deviceKey, at));
                    at.newAttribute = false;
                }
                if (at.newData) {
                    this._attributeDataCBs.forEach((cb) => cb(deviceKey, at));
                    at.newData = false;
                }
            }
        }
    }

    private _recordStats(deviceKey: string, newSamples: number, nowMs: number): void {
        let s = this._stats[deviceKey];
        if (!s) {
            s = { totalSamples: 0, lastSampleMs: null, lastUpdateMs: null, windowMs: 3000, windowEvents: [] };
            this._stats[deviceKey] = s;
        }
        s.lastUpdateMs = nowMs;
        if (newSamples > 0) {
            s.totalSamples += newSamples;
            s.lastSampleMs = nowMs;
            s.windowEvents.push({ t: nowMs, n: newSamples });
        }
        const windowStart = nowMs - s.windowMs;
        while (s.windowEvents.length > 0 && s.windowEvents[0].t < windowStart) {
            s.windowEvents.shift();
        }
    }

    // ---- RaftDeviceMgrIF ----

    getDevicesState(): DevicesState {
        return this._devicesState;
    }

    getDeviceState(deviceKey: string): DeviceState {
        return this._devicesState[deviceKey];
    }

    getDeviceStats(deviceKey: string): DeviceStats {
        const s = this._stats[deviceKey];
        if (!s) {
            return { totalSamples: 0, windowMs: 3000, windowSamples: 0, sampleRateHz: 0, lastSampleTimeMs: null, lastUpdateTimeMs: null };
        }
        const windowSamples = s.windowEvents.reduce((sum, e) => sum + e.n, 0);
        const spanMs = s.windowEvents.length > 0 ? Math.max(1, Date.now() - s.windowEvents[0].t) : 1;
        return {
            totalSamples: s.totalSamples,
            windowMs: s.windowMs,
            windowSamples,
            sampleRateHz: (windowSamples * 1000) / spanMs,
            lastSampleTimeMs: s.lastSampleMs,
            lastUpdateTimeMs: s.lastUpdateMs,
        };
    }

    resetDeviceStats(deviceKey: string): void {
        delete this._stats[deviceKey];
    }

    setMaxDataPointsToStore(maxDataPointsToStore: number): void {
        if (maxDataPointsToStore > 0) {
            this._maxDataPoints = maxDataPointsToStore;
        }
    }

    addNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        if (!this._newDeviceCBs.includes(callback)) this._newDeviceCBs.push(callback);
    }
    removeNewDeviceCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        this._newDeviceCBs = this._newDeviceCBs.filter((cb) => cb !== callback);
    }
    addNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        if (!this._newAttributeCBs.includes(callback)) this._newAttributeCBs.push(callback);
    }
    removeNewAttributeCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        this._newAttributeCBs = this._newAttributeCBs.filter((cb) => cb !== callback);
    }
    addAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        if (!this._attributeDataCBs.includes(callback)) this._attributeDataCBs.push(callback);
    }
    removeAttributeDataCallback(callback: (deviceKey: string, attrState: DeviceAttributeState) => void): void {
        this._attributeDataCBs = this._attributeDataCBs.filter((cb) => cb !== callback);
    }
    addDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        if (!this._deviceRemovedCBs.includes(callback)) this._deviceRemovedCBs.push(callback);
    }
    removeDeviceRemovedCallback(callback: (deviceKey: string, state: DeviceState) => void): void {
        this._deviceRemovedCBs = this._deviceRemovedCBs.filter((cb) => cb !== callback);
    }

    // Marty ROSSerial devices are read-only in this view
    async sendAction(_deviceKey: string, _action: DeviceTypeAction, _data: number[]): Promise<boolean> {
        // Not supported for ROSSerial-derived devices
        return false;
    }
    async sendCompoundAction(_deviceKey: string, _action: DeviceTypeAction, _data: number[][]): Promise<boolean> {
        // Not supported for ROSSerial-derived devices
        return false;
    }
    async cmdRawWriteRead(_deviceKey: string, _hexWr: string, _numToRd: number, _timeoutMs?: number): Promise<Uint8Array | null> {
        // Not supported for ROSSerial-derived devices
        return null;
    }
    async setSampleRate(_deviceKey: string, sampleRateHz: number): Promise<SampleRateResult> {
        return { ok: false, requestedRateHz: sampleRateHz, actualRateHz: 0, intervalUs: 0, numSamples: 0, error: "Not supported" };
    }
}
