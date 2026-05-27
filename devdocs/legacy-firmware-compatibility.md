# Legacy Firmware (Cog v1.9.5) Compatibility — Final Design

## Summary

RaftJS must support two devbin record body layouts and two `devman/typeinfo`
URL forms in order to interoperate with both current firmware (Axiom and
recent Cog builds) and Cog v1.9.5 in the field. The discriminator on the
binary side is **presence of the devbin envelope at message offset 2**; on
the JSON side it is a small **per-endpoint capability cache** that suppresses
repeated `failUnknownAPI` calls. No `SystemVersion` string parsing is
required for correctness.

The design below is grounded in concrete data captured by a temporary
diagnostic probe (`src/_DevbinCompatProbe.ts`) against both firmwares and in
the actual library history (commit `054125c`, where the `devman/typeinfo`
URL form changed).

## Confirmed Observations

The probe was run twice from `examples/dashboard` against the two firmwares.

### Old firmware (Cog v1.9.5)

```
devbin frames by envelope kind:
  no-envelope  count=203  firstBytes=001180000000000002 ddac07...
json endpoints supported (rslt=ok seen):
  v, subscription, bledisconnect
json endpoints failing:
  pubtopics              :: failUnknownAPI   count=1
  devman/typeinfo        :: failBusMissing   count=2
  datetime               :: failUnknownAPI   count=1
  filelist/local         :: failUnknownAPI   count=1
  datalog                :: failUnknownAPI   count=6
  filelist/local/logs    :: failUnknownAPI   count=1
```

Decoded record header from `firstBytes`:

```
0011        recordLen = 17
80          statusBus (online, bus 0)
00000000    address = 0 (direct)
0002        devTypeIdx = 2
dd ac 07... timestamp(2) + fixed-size payload   <- no deviceSeq, no sampleLen
```

### New firmware

```
devbin frames by envelope kind:
  env=0xdb v=11  count=1701  firstBytes=0057810000076a000e65 4e70...
json endpoints supported (rslt=ok seen):
  v, subscription, devman/typeinfo, datetime, filelist/local,
  datalog, devman/devconfig, bledisconnect
json endpoints failing:
  filelist/local/logs :: nofolder  count=1
```

Decoded record header from `firstBytes` (after the 3-byte envelope):

```
0057        recordLen = 87
81          statusBus (online, bus 1)
0000076a    address = slot 7, I2C 0x6a
000e        devTypeIdx = 14
65          deviceSeq = 0x65        <- present
4e          sampleLen = 78          <- length-prefixed
70 ...      sample data
```

### Conclusions from the data

1. **The magic byte does not change between formats.** Both observed
   firmwares use `0xDB` (the probe's `v=11` is just the literal low nibble of
   `0xDB`). The `0xDB..0xDF` range is reserved space but is not currently
   used as a version counter.
2. **The real discriminator is envelope presence** at byte offset 2 of the
   message (after the 2-byte msgType prefix). Old firmware emits no envelope
   at all; new firmware emits the `0xDB` envelope.
3. **Both body layouts described earlier are confirmed**: legacy raw
   `[timestamp:2][fixed payload]` samples with no per-device sequence byte,
   versus current `[deviceSeq:1][sampleLen:1][sampleData]`.
4. **`devman/typeinfo` is not missing on old firmware** — it just expects a
   different query form. See "typeinfo URL history" below.
5. The `0_0` device-key collision is real and unavoidable on old firmware:
   the captured records show multiple distinct `devTypeIdx` values
   (2, 3, 5 in the earlier log) all on bus 0 / address 0.

## `devman/typeinfo` URL History

Git history on `src/RaftDeviceManager.ts` shows the URL changed in commit
`054125c` ("Added support for 'role':'system' to denote system devices"):

```diff
- const cmd = "devman/typeinfo?bus=" + busName + "&type=" + deviceType;
+ const cmd = "devman/typeinfo?deviceid=" + deviceKey;
```

The pre-`054125c` form took:

- `bus` — numeric bus number as a string
- `type` — numeric `devTypeIdx` as a string

Both values are already present on the wire in every devbin record, so no
extra metadata is needed to construct the legacy request. The post-`054125c`
form uses `deviceid=<bus>_<addrHex>`, which old firmware rejects with
`failBusMissing`.

This means there is **no need for a bundled static typeinfo table** — old
firmware can answer typeinfo queries, we just have to ask in the old format.

## Final Design

### A. Binary discriminator: envelope presence

The single rule the parser uses to choose a record body layout:

```
let envByte = rxMsg[2];                  // first byte after msgType prefix
let hasEnvelope = (envByte & 0xF0) === 0xD0;
if (hasEnvelope) {
    // current format
    msgPos = 2 + 3;                      // skip 3-byte envelope
    bodyMode = lengthPrefixed;
} else {
    // legacy format
    msgPos = 2;
    bodyMode = legacyRaw;
}
```

Notes:

- Magic-byte values `0xDB..0xDF` are all accepted and mapped to the current
  body layout. A future format change would have to land both a new envelope
  value and matching parser code; until then the low nibble is ignored.
- A top-nibble-only check is safe because legacy record `recordLen` is
  `uint16 big-endian`, which means the first byte of any legacy frame is the
  high byte of `recordLen`. Real-world legacy records have `recordLen <
  0x1000` (the captured example shows `0x0011`), so the high byte is `0x00`
  and cannot be confused with `0xD?`.

### B. JSON-API capability cache

Located in a small object owned by `RaftMsgHandler` (or `RaftSystemUtils`):

```
endpointCapability: Map<endpoint, "ok" | "unsupported">
```

Rules:

1. On every JSON response, key the cache by the request endpoint with the
   query string stripped (`pubtopics`, `datetime`, `filelist/local`,
   `filelist/local/logs`, `datalog`, `devman/typeinfo`, ...).
2. `rslt=ok` → record `ok`. `rslt=fail` with `error=failUnknownAPI` →
   record `unsupported`. Other failures are not capability signals (e.g.
   `nofolder`, `failBusMissing`).
3. Before sending an optional API call, consult the cache. If
   `unsupported`, skip the call entirely. If unknown, send once.
4. Once an endpoint is marked `unsupported`, demote its `failUnknownAPI`
   log line to debug for the duration of the connection.
5. Reset the cache on disconnect, since a different device may be the
   peer next time.

Targets to gate on connect: `pubtopics`, `datetime?UTC=...`,
`filelist/local`, `filelist/local/logs`, `datalog?action=status`. These are
the calls the probe showed firing unconditionally on old firmware.

Specifically address the **`datalog` count=6**: somewhere a retry loop is
running. Once the capability is cached as `unsupported`, that loop must
short-circuit instead of retrying.

### C. Dual-layout devbin parser

Refactor `DeviceManager.handleClientMsgBinary` to support two record body
modes, selected by `bodyMode` from (A):

- `lengthPrefixed`: `[deviceSeq:1][sampleLen:1][sampleData:sampleLen]...`
- `legacyRaw`:      fixed-size `[timestamp:2][payload:fixedSize]...`

Decoder rules:

1. After reading `statusBus`/`address`/`devTypeIdx`, fetch
   `DeviceTypeInfo`. For `legacyRaw`, compute the sample stride as
   `2 (timestamp) + sum(struct sizes from resp.a)`, falling back to
   `resp.b` only if the schema cannot be sized.
2. Bound every sample to its own `[start, end]` range when calling the
   attribute decoder, so malformed data cannot walk past the record.
   Replace any throw-on-overrun with a throttled warning + skip. This
   protects against the `RangeError: Offset is outside the bounds of the
   DataView` symptom regardless of which layout is in use.
3. Specifically for Cog v1.9.5 light sensor: trust the schema-derived
   size, not `resp.b`, because that firmware double-reports the payload
   size in metadata. (Carried over from the sibling implementation; needs
   one verification capture in this codebase.)

### D. Device key disambiguation for legacy direct devices

Old firmware publishes multiple direct-connected devices on bus 0 /
address 0. To keep them distinct without breaking the existing `bus_addr`
key scheme everywhere:

- For `legacyRaw` records where `busNum == 0 && devAddr == 0`, build the
  key as `0_0_<devTypeIdx>`.
- Continue to use `bus_addr` for all `lengthPrefixed` records and for any
  legacy record where bus or address is non-zero.
- When sending commands, always use the stored `DeviceState.busName` and
  `DeviceState.deviceAddress` rather than re-parsing the displayed key,
  so a command for compatibility key `0_0_2` is correctly sent to bus 0 /
  address 0.
- The rate-limit cache in `getDeviceTypeInfo` keys off `deviceKey`. With
  the disambiguated key the rate limiter naturally avoids the "one
  failure poisons three devices" symptom seen in the original log.

### E. `devman/typeinfo` URL fallback

Two-form request strategy in `executeDeviceTypeInfoRequest`:

1. If `bodyMode == legacyRaw` for the originating record, send the legacy
   URL directly:
   ```
   devman/typeinfo?bus=<busNum>&type=<devTypeIdx>
   ```
2. Otherwise send the current URL:
   ```
   devman/typeinfo?deviceid=<bus>_<addrHex>
   ```
3. On `rslt=fail` with `error=failBusMissing` against the current URL,
   transparently retry once with the legacy URL form. Cache the chosen
   form per connection so we don't pay the failed first request more than
   once.

Because every callsite that needs typeinfo already knows `busNum` and
`devTypeIdx` from the record header, no extra state needs to be threaded
through. The existing `getDeviceTypeInfo(deviceKey)` signature can stay
if the chosen URL form is selected from a small per-key context map
populated when the record header is parsed.

### F. Tests

Add to `src/RaftDeviceManager.test.ts`:

- current length-prefixed records decode correctly (envelope present)
- legacy raw records decode correctly (no envelope)
- legacy direct-device records with bus/addr `0_0` and distinct
  `devTypeIdx` stay distinct (key disambiguation)
- malformed sample data inside a record is bounded and skipped (no throw)
- capability cache marks `pubtopics` unsupported on first
  `failUnknownAPI` and skips the second call

Use the captured `firstBytes` previews (above) as the basis for the
binary fixtures.

## Out of Scope

- Changes to firmware. Cog v1.9.5 stays in the field as-is.
- Changes to the dashboard UI. Once the library decodes legacy frames,
  the existing panels populate without modification.
- Removing the temporary `_DevbinCompatProbe.ts` instrumentation. That
  stays in place until the implementation in this design is verified
  against both firmwares, then is removed by deleting the file and the
  `[COMPAT-PROBE]` tagged call sites.

## Files To Change

- `src/RaftDeviceManager.ts`
  - envelope-presence discriminator and dual-layout sample loop
  - `0_0_<devTypeIdx>` key disambiguation for legacy direct devices
  - `executeDeviceTypeInfoRequest` two-form URL strategy
- `src/RaftAttributeHandler.ts` / `src/RaftCustomAttrHandler.ts`
  - bounded sample decoding, replace overrun throws with skip+warn
- `src/RaftMsgHandler.ts` (or `src/RaftSystemUtils.ts`)
  - per-endpoint capability cache; suppress repeated `failUnknownAPI`
- `src/RaftSystemUtils.ts` / `src/RaftConnector.ts`
  - gate `pubtopics`, `datetime`, `filelist/local`, `filelist/local/logs`,
    `datalog?action=status` on the capability cache; fix the `datalog`
    retry loop so it honours `unsupported`
- `src/RaftDeviceManager.test.ts`
  - new fixtures and assertions per section F

## Cross-Reference

A working implementation of the dual-layout parser and `0_0_<devTypeIdx>`
disambiguation exists locally at
`C:\Users\rob\Documents\rdev\1\SortRaftJsIssues\raftjs-robotical-main\`
(see `devdocs/devbin-backwards-compatibility.md` in that repo). Use it as
a reference when porting; the design above supersedes its envelope
selection rule (presence-based, not version-nibble-based) and its
typeinfo fallback (use the legacy URL form, not a bundled static table).
