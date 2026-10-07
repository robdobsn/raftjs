import { DeviceManager } from "./RaftDeviceManager";
import { DeviceTypeInfo } from "./RaftDeviceInfo";
import RaftSystemUtils from "./RaftSystemUtils";

function makeTypeInfo(name: string, respBytes: number, attrs: Array<{ n: string; t: string; at?: number | number[] }>): DeviceTypeInfo {
    return {
        name,
        desc: name,
        manu: "Robotical",
        type: name,
        resp: {
            b: respBytes,
            a: attrs.map(attr => ({ ...attr, u: "", r: [0, 0] }))
        }
    };
}

async function makeDeviceManager(typeInfos: Record<string, DeviceTypeInfo>): Promise<DeviceManager> {
    const msgHandler = {
        sendRICRESTURL: jest.fn(async (cmd: string) => {
            const deviceType = new URLSearchParams(cmd.split("?")[1]).get("type");
            const devinfo = deviceType ? typeInfos[deviceType] : undefined;
            return devinfo ? { rslt: "ok", devinfo } : { rslt: "fail" };
        })
    };
    const systemUtils = {
        getMsgHandler: () => msgHandler,
        getPublishTopicName: () => "devbin"
    } as unknown as RaftSystemUtils;

    const deviceManager = new DeviceManager();
    await deviceManager.setup(systemUtils);
    return deviceManager;
}


// ===== Long-sample escape: [0x00][lenHi][lenLo][data] for samples over 255 bytes =====

// Big-endian helpers for building frames
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];

// One device record (current envelope payload format) with pre-built samples
function devbinRecord(statusBus: number, addr: number, typeIdx: number, seq: number, samples: number[][]): number[] {
    const body = [statusBus, (addr >>> 24) & 0xff, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff, ...u16(typeIdx), seq];
    for (const sample of samples) {
        if (sample.length <= 255) {
            body.push(sample.length, ...sample);
        } else {
            body.push(0x00, ...u16(sample.length), ...sample);
        }
    }
    return [...u16(body.length), ...body];
}

function devbinFrame(records: number[][]): Uint8Array {
    return Uint8Array.from([0x00, 0x80, 0xDB, 0xFF, 0x00, ...records.flat()]);
}

// 320-byte attribute payload: 2-byte counter then 318 bytes; sample = 2-byte timestamp + payload
const bigInfo = makeTypeInfo("BigSample", 320, [
    { n: "count", t: ">H" },
    { n: "data", t: "B[318]" }
]);
function bigSample(tsTicks: number, count: number): number[] {
    const data = Array.from({ length: 318 }, (_, i) => (i + count) & 0xff);
    return [...u16(tsTicks), ...u16(count), ...data];
}

describe("DeviceManager devbin long-sample escape", () => {
    const smallInfo = makeTypeInfo("Small", 2, [{ n: "v", t: ">H" }]);

    it("decodes a sample over 255 bytes and keeps framing for the next record", async () => {
        const deviceManager = await makeDeviceManager({ "9": bigInfo, "4": smallInfo });
        const rxMsg = devbinFrame([
            devbinRecord(0x81, 0x0129, 9, 1, [bigSample(10, 7)]),
            devbinRecord(0x81, 0x0015, 4, 1, [[0x00, 0x05, 0x12, 0x34]]),
        ]);
        await deviceManager.handleClientMsgBinary(rxMsg);

        const big = deviceManager.getDeviceState("1_129");
        expect(big.deviceTimeline.totalSamplesAdded).toBe(1);
        expect(big.deviceAttributes.count.values).toEqual([7]);
        expect(big.deviceAttributes.data.values.length).toBe(318);
        expect(big.deviceAttributes.data.values.slice(0, 3)).toEqual([7, 8, 9]);
        expect(big.deviceAttributes.data.values[317]).toBe((317 + 7) & 0xff);

        const small = deviceManager.getDeviceState("1_15");
        expect(small.deviceAttributes.v.values).toEqual([0x1234]);
    });

    it("decodes several long samples in one record", async () => {
        const deviceManager = await makeDeviceManager({ "9": bigInfo });
        await deviceManager.handleClientMsgBinary(devbinFrame([
            devbinRecord(0x81, 0x0129, 9, 1, [bigSample(10, 1), bigSample(20, 2), bigSample(30, 3)]),
        ]));
        const big = deviceManager.getDeviceState("1_129");
        expect(big.deviceAttributes.count.values).toEqual([1, 2, 3]);
        expect(big.deviceAttributes.data.values.length).toBe(3 * 318);
    });

    it("appends samples from repeated records for the same device in order", async () => {
        // Firmware splits a long run of samples across records when one would exceed 64 KB
        const deviceManager = await makeDeviceManager({ "9": bigInfo });
        await deviceManager.handleClientMsgBinary(devbinFrame([
            devbinRecord(0x81, 0x0129, 9, 1, [bigSample(10, 1)]),
            devbinRecord(0x81, 0x0129, 9, 2, [bigSample(20, 2)]),
        ]));
        const big = deviceManager.getDeviceState("1_129");
        expect(big.deviceAttributes.count.values).toEqual([1, 2]);
    });

    it("drops a truncated escape without throwing", async () => {
        const deviceManager = await makeDeviceManager({ "9": bigInfo });
        // Escape claims 322 bytes but the record holds only a few
        const body = [0x81, 0x00, 0x00, 0x01, 0x29, ...u16(9), 1, 0x00, ...u16(322), 0x01, 0x02];
        const rxMsg = Uint8Array.from([0x00, 0x80, 0xDB, 0xFF, 0x00, ...u16(body.length), ...body]);
        await expect(deviceManager.handleClientMsgBinary(rxMsg)).resolves.not.toThrow();
        const big = deviceManager.getDeviceState("1_129");
        expect(big?.deviceTimeline?.totalSamplesAdded ?? 0).toBe(0);
    });

    it("decodes an escaped sample in a frame without an envelope (format probe)", async () => {
        const deviceManager = await makeDeviceManager({ "9": bigInfo });
        const rxMsg = Uint8Array.from([0x00, 0x80, ...devbinRecord(0x81, 0x0129, 9, 1, [bigSample(10, 5)])]);
        await deviceManager.handleClientMsgBinary(rxMsg);
        expect(deviceManager.getDeviceState("1_129").deviceAttributes.count.values).toEqual([5]);
    });
});

describe("DeviceManager binary devbin parsing", () => {
    const accelInfo = makeTypeInfo("MXC400xXC", 7, [
        { n: "x", t: ">h" },
        { n: "y", t: ">h" },
        { n: "z", t: ">h" },
        { n: "status", t: "B" }
    ]);

    it("decodes current length-prefixed records", async () => {
        const deviceManager = await makeDeviceManager({ "4": accelInfo });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0xDB, 0xFF, 0x00,
            0x00, 0x12,
            0x81,
            0x00, 0x00, 0x00, 0x15,
            0x00, 0x04,
            0x05,
            0x09,
            0x00, 0x01,
            0x00, 0x01,
            0x00, 0x02,
            0x00, 0x03,
            0x04
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const deviceState = deviceManager.getDeviceState("1_15");
        expect(deviceState.deviceType).toBe("MXC400xXC");
        expect(deviceState.deviceTimeline.totalSamplesAdded).toBe(1);
        expect(deviceState.deviceAttributes.x.values).toEqual([1]);
        expect(deviceState.deviceAttributes.y.values).toEqual([2]);
        expect(deviceState.deviceAttributes.z.values).toEqual([3]);
        expect(deviceState.deviceAttributes.status.values).toEqual([4]);
    });

    it("decodes current length-prefixed records with sparse absolute attribute offsets", async () => {
        const scd30Info = makeTypeInfo("SCD30", 24, [
            { n: "CO2", t: ">f", at: [6, 7, 9, 10] },
            { n: "temperature", t: ">f", at: [12, 13, 15, 16] },
            { n: "humidity", t: ">f", at: [18, 19, 21, 22] }
        ]);
        const deviceManager = await makeDeviceManager({ "42": scd30Info });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0xDB, 0xFF, 0x00,
            0x00, 0x23,
            0x81,
            0x00, 0x00, 0x02, 0x61,
            0x00, 0x2a,
            0x07,
            0x1a,
            0x00, 0x01,
            0x00, 0x01, 0xb0,
            0x00, 0x01, 0xb0,
            0x43, 0xfa, 0x00, 0x00, 0x00, 0x00,
            0x41, 0xc8, 0x00, 0x00, 0x00, 0x00,
            0x42, 0x5e, 0x00, 0x00, 0x00, 0x00
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const deviceState = deviceManager.getDeviceState("1_261");
        expect(deviceState.deviceType).toBe("SCD30");
        expect(deviceState.deviceTimeline.totalSamplesAdded).toBe(1);
        expect(deviceState.deviceAttributes.CO2.values).toEqual([500]);
        expect(deviceState.deviceAttributes.temperature.values).toEqual([25]);
        expect(deviceState.deviceAttributes.humidity.values).toEqual([55.5]);
    });

    it("prefers declared legacy fixed sample size when it matches the record", async () => {
        const paddedInfo = makeTypeInfo("PaddedFixed", 10, [
            { n: "first", t: ">H" },
            { n: "second", t: ">H" }
        ]);
        const deviceManager = await makeDeviceManager({ "7": paddedInfo });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0x00, 0x13,
            0x80,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x07,
            0x00, 0x01,
            0x00, 0x07,
            0x00, 0x08,
            0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const deviceState = deviceManager.getDeviceState("0_0_7");
        expect(deviceState.deviceType).toBe("PaddedFixed");
        expect(deviceState.deviceTimeline.totalSamplesAdded).toBe(1);
        expect(deviceState.deviceAttributes.first.values).toEqual([7]);
        expect(deviceState.deviceAttributes.second.values).toEqual([8]);
    });

    it("decodes Cog v1.9.5 legacy raw accelerometer records", async () => {
        const deviceManager = await makeDeviceManager({ "4": accelInfo });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0x00, 0x10,
            0x81,
            0x00, 0x00, 0x00, 0x15,
            0x00, 0x04,
            0x00, 0x01,
            0x00, 0x01,
            0x00, 0x02,
            0x00, 0x03,
            0x04
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const deviceState = deviceManager.getDeviceState("1_15");
        expect(deviceState.deviceType).toBe("MXC400xXC");
        expect(deviceState.deviceTimeline.totalSamplesAdded).toBe(1);
        expect(deviceState.deviceAttributes.x.values).toEqual([1]);
        expect(deviceState.deviceAttributes.y.values).toEqual([2]);
        expect(deviceState.deviceAttributes.z.values).toEqual([3]);
        expect(deviceState.deviceAttributes.status.values).toEqual([4]);
    });

    it("decodes Cog v1.9.5 legacy raw records inside a devbin envelope", async () => {
        const deviceManager = await makeDeviceManager({ "4": accelInfo });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0xDB, 0xFF, 0x00,
            0x00, 0x10,
            0x81,
            0x00, 0x00, 0x00, 0x15,
            0x00, 0x04,
            0x00, 0x01,
            0x00, 0x01,
            0x00, 0x02,
            0x00, 0x03,
            0x04
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const deviceState = deviceManager.getDeviceState("1_15");
        expect(deviceState.deviceType).toBe("MXC400xXC");
        expect(deviceState.deviceTimeline.totalSamplesAdded).toBe(1);
        expect(deviceState.deviceAttributes.x.values).toEqual([1]);
        expect(deviceState.deviceAttributes.y.values).toEqual([2]);
        expect(deviceState.deviceAttributes.z.values).toEqual([3]);
        expect(deviceState.deviceAttributes.status.values).toEqual([4]);
    });

    it("keeps Cog v1.9.5 direct device records distinct when bus and address are both zero", async () => {
        const lightInfo = makeTypeInfo("LightSensors", 16, [
            { n: "ch0", t: ">H" },
            { n: "ch1", t: ">H" },
            { n: "ch2", t: ">H" },
            { n: "ch3", t: ">H" }
        ]);
        const powerInfo = makeTypeInfo("Power", 1, [
            { n: "battery", t: "B" }
        ]);
        const deviceManager = await makeDeviceManager({ "2": lightInfo, "3": powerInfo });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0x00, 0x11,
            0x80,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x02,
            0x00, 0x01,
            0x00, 0x0a,
            0x00, 0x0b,
            0x00, 0x0c,
            0x00, 0x0d,
            0x00, 0x0a,
            0x80,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x03,
            0x00, 0x02,
            0x63
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const devicesState = deviceManager.getDevicesState();
        expect(devicesState["0_0_2"].deviceType).toBe("LightSensors");
        expect(devicesState["0_0_2"].deviceAttributes.ch0.values).toEqual([10]);
        expect(devicesState["0_0_3"].deviceType).toBe("Power");
        expect(devicesState["0_0_3"].deviceAttributes.battery.values).toEqual([99]);
    });

    it("keeps current length-prefixed direct device records distinct when bus and address are both zero", async () => {
        const lightInfo = makeTypeInfo("LightSensors", 8, [
            { n: "ch0", t: ">H" },
            { n: "ch1", t: ">H" },
            { n: "ch2", t: ">H" },
            { n: "ch3", t: ">H" }
        ]);
        const powerInfo = makeTypeInfo("Power", 1, [
            { n: "battery", t: "B" }
        ]);
        const deviceManager = await makeDeviceManager({ "2": lightInfo, "3": powerInfo });
        const rxMsg = Uint8Array.from([
            0x00, 0x80,
            0xDB, 0xFF, 0x00,
            0x00, 0x13,
            0x80,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x02,
            0x01,
            0x0a,
            0x00, 0x01,
            0x00, 0x0a,
            0x00, 0x0b,
            0x00, 0x0c,
            0x00, 0x0d,
            0x00, 0x0c,
            0x80,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x03,
            0x02,
            0x03,
            0x00, 0x02,
            0x63
        ]);

        await deviceManager.handleClientMsgBinary(rxMsg);

        const devicesState = deviceManager.getDevicesState();
        expect(devicesState["0_0_2"].deviceType).toBe("LightSensors");
        expect(devicesState["0_0_2"].deviceAttributes.ch0.values).toEqual([10]);
        expect(devicesState["0_0_3"].deviceType).toBe("Power");
        expect(devicesState["0_0_3"].deviceAttributes.battery.values).toEqual([99]);
    });
});

// ===== Client messages are processed in arrival order =====

describe("DeviceManager client message ordering", () => {
    const fastInfo = makeTypeInfo("Fast", 2, [{ n: "v", t: ">H" }]);
    const slowInfo = makeTypeInfo("Slow", 2, [{ n: "v", t: ">H" }]);

    // Device manager whose type info for type index 9 answers after delayMs (never if < 0)
    async function makeSlowTypeInfoManager(delayMs: number): Promise<DeviceManager> {
        const msgHandler = {
            sendRICRESTURL: jest.fn(async (cmd: string) => {
                const deviceType = new URLSearchParams(cmd.split("?")[1]).get("type");
                if (deviceType === "9") {
                    if (delayMs < 0) return new Promise(() => {});
                    await new Promise((r) => setTimeout(r, delayMs));
                    return { rslt: "ok", devinfo: slowInfo };
                }
                return deviceType === "4" ? { rslt: "ok", devinfo: fastInfo } : { rslt: "fail" };
            })
        };
        const systemUtils = {
            getMsgHandler: () => msgHandler,
            getPublishTopicName: () => "devbin"
        } as unknown as RaftSystemUtils;
        const deviceManager = new DeviceManager();
        await deviceManager.setup(systemUtils);
        return deviceManager;
    }

    const sampleV = (ts: number, v: number) => [...u16(ts), ...u16(v)];

    it("keeps a device's samples in order while an earlier record waits for type info", async () => {
        const deviceManager = await makeSlowTypeInfoManager(50);
        // Frame 1: slow device first, then the fast device's sample 1; frame 2: fast sample 2
        const frame1 = devbinFrame([
            devbinRecord(0x81, 0x0129, 9, 1, [sampleV(10, 100)]),
            devbinRecord(0x81, 0x0015, 4, 1, [sampleV(10, 1)]),
        ]);
        const frame2 = devbinFrame([devbinRecord(0x81, 0x0015, 4, 2, [sampleV(20, 2)])]);

        // Delivered as a transport callback would - without awaiting between messages
        const p1 = deviceManager.handleClientMsgBinary(frame1);
        const p2 = deviceManager.handleClientMsgBinary(frame2);
        await Promise.all([p1, p2]);

        expect(deviceManager.getDeviceState("1_15").deviceAttributes.v.values).toEqual([1, 2]);
        expect(deviceManager.getDeviceState("1_129").deviceAttributes.v.values).toEqual([100]);
    });

    it("does not hold up later messages for long when a type info request never answers", async () => {
        const deviceManager = await makeSlowTypeInfoManager(-1);
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const startMs = Date.now();
        await deviceManager.handleClientMsgBinary(devbinFrame([
            devbinRecord(0x81, 0x0129, 9, 1, [sampleV(10, 100)]),
            devbinRecord(0x81, 0x0015, 4, 1, [sampleV(10, 1)]),
        ]));
        // Later message: the slow request is already over the wait limit, so no further wait
        const secondStartMs = Date.now();
        await deviceManager.handleClientMsgBinary(devbinFrame([
            devbinRecord(0x81, 0x0129, 9, 2, [sampleV(20, 101)]),
            devbinRecord(0x81, 0x0015, 4, 2, [sampleV(20, 2)]),
        ]));
        warn.mockRestore();

        expect(secondStartMs - startMs).toBeLessThan(2500);
        expect(Date.now() - secondStartMs).toBeLessThan(200);
        expect(deviceManager.getDeviceState("1_15").deviceAttributes.v.values).toEqual([1, 2]);
    }, 10000);
});
