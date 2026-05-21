# Devbin Backwards Compatibility

## Context

RaftJS is used by both Axiom and Cog. Axiom was already using the current devbin payload layout, but Cog firmware v1.9.5 is already in production and publishes device data using an older RaftCore record body layout. The app therefore has to keep supporting the newer Axiom/Cog format while remaining compatible with Cog v1.9.5 devices in the field.

The failure mode seen in Axiom Experiment App was:

- Cog connected successfully over BLE.
- The live preview received binary device messages.
- Accelerometer data did not appear.
- The browser logged malformed sample warnings and previously could surface errors such as `RangeError: Offset is outside the bounds of the DataView`.

The root cause was a format mismatch. RaftJS assumed that devbin records contained a device sequence byte followed by length-prefixed samples. Cog v1.9.5 sends fixed-size raw samples without the device sequence byte. When parsed as the newer format, the first timestamp byte was interpreted as a sample length, so the parser read the wrong boundaries and eventually tried to decode attributes past the end of a sample.

## Supported Record Layouts

### Current Format

Current devbin frames use:

```text
[msgType:2]
[devbin envelope: magic/version, topicIndex, envelopeSeq]
[recordLen:2]
[statusBus:1]
[address:4]
[devTypeIdx:2]
[deviceSeq:1]
[sampleLen:1][sampleData:sampleLen]...
```

`sampleData` contains the poll-result timestamp followed by the device payload. This is the format used by current Axiom builds and newer Raft firmware.

### Cog v1.9.5 Legacy Format

Cog v1.9.5 uses the older record body:

```text
[msgType:2]
optional [devbin envelope]
[recordLen:2]
[statusBus:1]
[address:4]
[devTypeIdx:2]
[timestamp:2][payload:fixedSize]...
```

There is no per-device sequence byte and no per-sample length byte. Samples are decoded using the fixed payload size derived from the device type metadata.

In testing, Cog v1.9.5 was observed sending a hybrid shape: the newer `DB` devbin envelope was present, but each record still used the legacy raw sample body. The parser must therefore not infer the record body format from the envelope alone.

## RaftJS Parser Behavior

`DeviceManager.handleClientMsgBinary` now supports two record payload modes:

- `lengthPrefixed`: current records with `deviceSeq` and `[sampleLen][sampleData]`.
- `legacyRaw`: Cog v1.9.5 records with fixed-size `[timestamp][payload]` samples and no `deviceSeq`.

The parser first locates the record stream using the message prefix and optional devbin envelope. After it has the `devTypeIdx`, it fetches the device type info and validates the actual sample layout against the metadata. This lets it correctly identify the Cog v1.9.5 hybrid case where the frame has the current envelope but the record body is legacy raw.

Malformed samples are bounded to their record/sample range before decoding. If a sample cannot be decoded, RaftJS skips that sample and emits a throttled warning rather than throwing from `DataView`.

## Legacy Sample Size

For legacy raw records, the fixed sample size is:

```text
2-byte timestamp + payload size
```

The payload size is normally derived from the sum of the attribute struct sizes in `resp.a`. If a custom response handler is used, or if the schema cannot be sized safely, RaftJS falls back to `resp.b`.

This schema-derived sizing is required for Cog v1.9.5 light sensor records because that firmware reports a doubled light payload size in metadata while the actual raw record contains one fixed payload matching the attribute schema.

## Direct Device Key Compatibility

Cog v1.9.5 publishes multiple direct-connected devices on bus `0`, address `0`. In the current key scheme this collapses to a single `0_0` device and causes metadata collisions, for example LightSensors and Power sharing the same key.

For legacy raw records only, RaftJS appends the device type index to direct bus/address zero records:

```text
0_0_<devTypeIdx>
```

This keeps legacy Cog direct devices distinct while preserving the existing key behavior for Axiom and newer length-prefixed records.

Command paths should use the stored `DeviceState.busName` and `DeviceState.deviceAddress`, not only parse the displayed device key. This avoids sending commands to an address such as `0_2` when the compatibility key is `0_0_2`.

## Verification

The compatibility behavior is covered by `src/RaftDeviceManager.test.ts`:

- current length-prefixed records decode correctly
- Cog v1.9.5 raw accelerometer records decode correctly
- Cog v1.9.5 raw records inside a devbin envelope decode correctly
- legacy direct devices with bus/address `0_0` stay distinct by device type index

The real-device validation used Axiom Experiment App:

- Cog v1.9.5 connected over BLE as `Robotical Cog`
- live `MXC400xXC` `ax`, `ay`, and `az` samples appeared in simple mode
- no page errors were observed during the live-preview watch
- an Axiom real-device connection still decoded live LSM6DS data, confirming the current length-prefixed path remained intact

