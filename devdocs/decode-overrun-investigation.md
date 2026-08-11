# Decode Overrun Error Investigation (RESOLVED)

## Summary

The dashboard connected to newer Cog firmware showed only two devices (the
"Cog Power Status" device was missing) and logged a repeating
`AttributeHandler decode overrun` error against "Cog Light Sensors".

Both symptoms had a **single root cause**: a device-key collision in raftjs.
Two different direct-connect devices were being merged onto the same
`_devicesState` key, so one device disappeared and its samples were decoded
with the wrong schema.

> An earlier version of this document concluded the firmware was sending an
> "extra byte" in the light-sensor payload. That was a misdiagnosis — the
> bytes being analysed were actually a *Power* sample misrouted into the
> Light Sensors decoder because of the key collision described below.

## Root Cause: device-key collision for DevbinV1Framed direct devices

The newer Cog firmware publishes every direct-connect device with
`bus=0, addr=0`, distinguished only by `devTypeIdx` (`BUS_NUM_DIRECT_CONN = 0`
and `genBinaryDataMsg(..., 0 /*addr*/, ...)`). Both `DeviceLightSensors` and
`DevicePower` are published this way.

`RaftDeviceManager.getBinaryDeviceKey()` only disambiguated direct-connect
devices by `devTypeIdx` for the **`DevbinV0Fixed`** payload format:

```ts
if ((payloadFormat === "DevbinV0Fixed") && (busNum === 0) && (devAddrHex === "0")) {
    return `${baseDeviceKey}_${devTypeIdx}`;
}
return baseDeviceKey;   // → "0_0" for ALL DevbinV1Framed direct devices
```

Because the newer firmware is decoded as **`DevbinV1Framed`**, both Light
Sensors and Power resolved to the identical key `"0_0"`:

- Light Sensors registers `_devicesState["0_0"]` first (earlier in the device
  list), so the key holds the Light Sensors schema.
- Power records reuse that same state (it already has `deviceTypeInfo`), so
  **Power never appears as its own device** and its samples are decoded with
  the **Light Sensors** schema.

### Why it presented as an overrun

A Power sample is `[timestamp:2][battV:2][battStatus:1][powerBtn:1][powerBtnLvl:2][onUSB:1]`
= 9 bytes. Decoded against the Light Sensors schema (`timestamp` + 4×`>H` =
needs 10 bytes) it is one byte short, so the final `amb0` read overruns.

Example from the logs, `sampleHex=d9690005030001bc01`, decoded as **Power**:

| bytes  | Power field  | value  |
| ------ | ------------ | ------ |
| `d969` | timestamp    | —      |
| `0005` | battV (÷100) | 0.05 V |
| `03`   | battStatus   | 3      |
| `00`   | powerBtn     | no     |
| `01bc` | powerBtnLvl  | 444    |
| `01`   | onUSB        | yes    |

That matches the Power values shown by the working (older) firmware.

### Why the older (v1.9.5 / `_195release`) firmware was unaffected

It emits the older `DevbinV0Fixed` layout, for which `getBinaryDeviceKey`
already appended `devTypeIdx` (`"0_0_<idx>"`), so the direct devices did not
collide.

## Fix

`getBinaryDeviceKey` now disambiguates direct-connect devices by `devTypeIdx`
for **all** payload formats (both `DevbinV0Fixed` and `DevbinV1Framed`):

```ts
if ((busNum === 0) && (devAddrHex === "0")) {
    return `${baseDeviceKey}_${devTypeIdx}`;
}
```

The per-device `devman/typeinfo?deviceid=0_0_<idx>` query remains safe: the
firmware's `RaftDeviceID::fromString` stops parsing the address at the first
`_`, so it resolves identically to `deviceid=0_0` and the bus/type-index
lookup (`?bus=0&type=<devTypeIdx>`) continues to supply the correct schema.

Regression test: `RaftDeviceManager.test.ts` →
"keeps current length-prefixed direct device records distinct when bus and
address are both zero".

## Related firmware bug (fixed separately)

`DeviceLightSensors::getDeviceTypeRecord()` advertised the wrong payload size:

```cpp
"resp":{"b": String(pollDataSizeBytes*2) ...   // advertised b=16, real payload is 8
```

This is why the logs showed `pollRespMetadata.b=16` for a 4×`>H` (8-byte)
schema. It did not cause the overrun, but it defeated the payload-format
auto-detection (`areDevbinV1FramedSamplesValid` expected sampleLen = `2 + 16`).
Corrected to `String(pollDataSizeBytes)`. `DevicePower` was already correct
(`"b":7`).

## The `system` device role is not involved

The `role`/`isSystemDevice` mechanism in RaftCore's `DeviceManager` does not
filter devices out of `getDevicesDataBinary()` — all devices are still
published. The missing Power device was purely the raftjs key collision.

## Related Code Locations

**raftjs:**
- `src/RaftDeviceManager.ts` — `getBinaryDeviceKey()` (the fix)
- `src/RaftDeviceManager.ts` — `handleClientMsgBinary()` (device-key usage)
- `src/RaftAttributeHandler.ts` — `processMsgAttribute()` (overrun detection)

**Firmware:**
- `RoboticalCogFW/components/DeviceLightSensors/DeviceLightSensors.cpp` —
  `getDeviceTypeRecord()` (`b` size fix)
- `RaftCore/components/core/RaftDevice/RaftDevice.cpp` — `genBinaryDataMsg()`
- `RaftCore/components/core/DeviceManager/DeviceManager.cpp` —
  `getDevicesDataBinary()`
