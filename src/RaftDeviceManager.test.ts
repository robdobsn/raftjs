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
});
