import AttributeHandler from "./RaftAttributeHandler";
import RaftChannelSimulated from "./RaftChannelSimulated";
import { DeviceAttributesState, DeviceTimeline } from "./RaftDeviceStates";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let idx = 0; idx < bytes.length; idx++) {
    bytes[idx] = parseInt(hex.slice(idx * 2, idx * 2 + 2), 16);
  }
  return bytes;
}

function createTimeline(): DeviceTimeline {
  return {
    timestampsUs: [],
    lastReportTimestampUs: 0,
    reportTimestampOffsetUs: 0,
    totalSamplesAdded: 0,
    emaLastSampleTimeUs: 0,
    emaIntervalUs: 0,
    emaPrevPollTimeUs: 0,
    emaCalibrated: false,
    emaCalibrationPolls: 0,
  };
}

describe("RaftChannelSimulated", () => {
  test("generates decodable SCD30 CO2, temperature and humidity data", () => {
    const channel = new RaftChannelSimulated() as any;
    const deviceTypeInfo = channel._deviceTypeInfo.SCD30;
    expect(deviceTypeInfo).toBeDefined();

    const msg = channel._createSimulatedDeviceInfoMsg(1000, "SCD30", deviceTypeInfo, 2500) as Uint8Array;
    const publishedJson = JSON.parse(new TextDecoder().decode(msg.slice(2)));
    const payload = hexToBytes(publishedJson["1"].SCD30.pub);

    const attrs: DeviceAttributesState = {};
    const timeline = createTimeline();
    const handler = new AttributeHandler();

    const nextIdx = handler.processMsgAttrGroup(payload, 0, timeline, deviceTypeInfo.resp, attrs, 100);
    expect(nextIdx).toBe(26);

    expect(attrs.CO2.values).toHaveLength(1);
    expect(attrs.temperature.values).toHaveLength(1);
    expect(attrs.humidity.values).toHaveLength(1);

    const co2 = attrs.CO2.values[0] as number;
    const temperature = attrs.temperature.values[0] as number;
    const humidity = attrs.humidity.values[0] as number;

    expect(Number.isFinite(co2)).toBe(true);
    expect(Number.isFinite(temperature)).toBe(true);
    expect(Number.isFinite(humidity)).toBe(true);
    expect(co2).toBeGreaterThanOrEqual(400);
    expect(co2).toBeLessThanOrEqual(2000);
    expect(temperature).toBeGreaterThanOrEqual(-40);
    expect(temperature).toBeLessThanOrEqual(125);
    expect(humidity).toBeGreaterThanOrEqual(0);
    expect(humidity).toBeLessThanOrEqual(100);
  });
});
