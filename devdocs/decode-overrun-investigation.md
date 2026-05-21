# Decode Overrun Error Investigation

## Summary

The raftjs example dashboard is receiving an `AttributeHandler decode overrun` error when processing light sensor data from a Cog device. The firmware is sending 9 bytes of sensor data, but the registered schema expects only 8 bytes.

## Error Details

**Error Message:**
```
AttributeHandler decode overrun (msgBuffer):
  deviceKey=0_0
  deviceType=Cog Light Sensors
  debugMsgIndex=1
  attr.n=amb0
  attr.t=>H
  attrTypeSize=2
  curFieldBufIdx=45
  msgBuffer.length=46
  sampleStartIdx=37
  sampleEndIdx=46
  availableInSample=1
  availableInBuffer=1
```

**Key Facts:**
- Message buffer total length: 46 bytes
- Sample data location: bytes 37-46 (9 bytes)
- Declared sample size in schema: 8 bytes (`pollRespMetadata.b=8`)
- **Mismatch: Firmware sends 9 bytes, schema expects 8 bytes**

## Message Structure Analysis

### Binary Message Format
The firmware sends a binary message with this structure:
1. **Timestamp** (2 bytes, big-endian) - handled separately before attribute decoding
2. **Sample length** (1 byte) - value is 9, meaning 9 bytes of sensor data follow
3. **Sensor data** (9 bytes) - the actual data being decoded
   - IR sensor 0 (ir0): `5c 60` (0x5c60)
   - IR sensor 1 (ir1): `00 05` (0x0005)
   - IR sensor 2 (ir2): `03 00` (0x0300)
   - Ambient sensor 0 (amb0): `02 57` (0x0257)
   - **Extra byte**: `01` (unknown origin)

### Expected vs Actual Schema

**Schema Definition (from firmware):**
```json
{
  "name": "Cog Light Sensors",
  "desc": "Light Sensors",
  "type": "RoboCogLightV1",
  "resp": {
    "b": 8,
    "a": [
      {"n": "ir0", "t": ">H", "u": "", "r": [0, 4095], "d": 1, "f": ".0f"},
      {"n": "ir1", "t": ">H", "u": "", "r": [0, 4095], "d": 1, "f": ".0f"},
      {"n": "ir2", "t": ">H", "u": "", "r": [918, 2259], "d": 1, "f": ".0f"},
      {"n": "amb0", "t": ">H", "u": "L", "r": [0, 4095], "d": 1, "f": ".0f"}
    ]
  }
}
```

**Expected data (based on schema):**
- ir0: 2 bytes
- ir1: 2 bytes
- ir2: 2 bytes
- amb0: 2 bytes
- **Total: 8 bytes**

**Actual data received:**
- All 4 fields as expected (8 bytes)
- **Plus 1 extra byte** = 9 bytes total

## Root Cause

The firmware's `DeviceLightSensors::formDeviceDataResponse()` function in `components/DeviceLightSensors/DeviceLightSensors.cpp` is generating sensor data, and there is a mismatch between:

1. **What the firmware sends**: 9 bytes of sensor data (timestamp + data in the binary message)
2. **What the schema declares**: 8 bytes of sensor data (`"b": 8`)

The schema is generated dynamically by the firmware in `getDeviceTypeRecord()` based on the number of configured sensors:
- 3 IR sensors × 2 bytes = 6 bytes
- 1 ambient sensor × 2 bytes = 2 bytes
- **Total: 8 bytes** (correct calculation)

But the actual `formDeviceDataResponse()` is sending 9 bytes.

## Investigation Points

### 1. Extra Byte Origin
The mysterious `01` byte at the end needs to be identified:
- Is it padding?
- Is it a sample count or indicator?
- Is it an uninitialized buffer value?
- Was it added in a recent firmware change?

**Check:**
- `git log -p components/DeviceLightSensors/DeviceLightSensors.cpp` around `formDeviceDataResponse()`
- Look for recent changes that add bytes (new sensor data, flags, etc.)
- Compare the byte count calculation in `getDeviceTypeRecord()` with actual `formDeviceDataResponse()` logic

### 2. Binary Message Encoding
The binary message encoding happens in `RaftDevice::genBinaryDataMsg()` (in RaftCore). Verify:
- Is the framework adding extra metadata or padding?
- Are sample boundaries being correctly calculated?
- Is there a mismatch between the sample length byte and actual data written?

**Check:**
- `RaftDevice::genBinaryDataMsg()` implementation
- Recent changes to binary message encoding
- Sample length byte calculation

### 3. Configuration/Build State
- Check if the firmware was built with debug flags that add extra bytes
- Verify that sensor configuration hasn't changed (more sensors added?)
- Check if conditional compilation (#ifdef) is affecting byte counts

## raftjs Side

The raftjs library correctly detects the mismatch through the diagnostic context added in recent commits:
- `AttrDecodeDiagContext` interface tracks sample boundaries
- `RaftAttributeHandler.processMsgAttribute()` bounds-checks against these boundaries
- `RaftDeviceManager` passes diagnostic context with `sampleStartIdx` and `sampleEndIdx`

This is working as intended—the error indicates a real firmware/schema mismatch, not a bug in raftjs.

## Recommended Fixes

### Short Term (Workaround)
Update the schema to match reality:
```json
"resp": {
  "b": 9,  // Changed from 8 to 9
  ...
}
```
This will suppress the error but doesn't fix the root cause.

### Long Term (Proper Fix)
1. **Identify the source** of the extra byte in `formDeviceDataResponse()`
2. **Either:**
   - Remove the extra byte if it's unintended
   - Properly account for it in the schema and sensor processing if it's intentional
3. **Update documentation** if there's a reason for the extra byte
4. **Add unit tests** to prevent this mismatch in future changes

## Related Code Locations

**Firmware:**
- Schema definition: `RoboticalCogFW/components/DeviceLightSensors/DeviceLightSensors.cpp` - `getDeviceTypeRecord()`
- Data encoding: `RoboticalCogFW/components/DeviceLightSensors/DeviceLightSensors.cpp` - `formDeviceDataResponse()`
- Binary message: `RoboticalCogFW/raftdevlibs/RaftCore/components/core/RaftDevice/RaftDevice.cpp` - `genBinaryDataMsg()`

**raftjs:**
- Attribute handler: `raftjs/src/RaftAttributeHandler.ts` - `processMsgAttribute()`
- Device manager: `raftjs/src/RaftDeviceManager.ts` - `handleClientMsgBinary()`
- Diagnostic logging: Added in recent commit with `AttrDecodeDiagContext`

## Next Steps

1. Run `git log -p` on DeviceLightSensors to find when the extra byte was introduced
2. Check the firmware build/compile to ensure no debug additions
3. Examine `formDeviceDataResponse()` line-by-line against sensor configuration
4. Test with a debugger to verify what bytes are actually being transmitted
5. Once identified, decide whether to remove the byte or update the schema
