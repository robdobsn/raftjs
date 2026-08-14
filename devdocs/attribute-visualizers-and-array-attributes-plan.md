# Specialized Attribute Visualizers, Array Attributes and Chart Improvements

## Status

All five phases implemented and verified on hardware 2026-08-14 (see "Implementation status" below).

## Implementation status (2026-08-14)

- **Phase 1 (raftjs) — done.** `getAttrElemsPerSample()` in [RaftDeviceInfo.ts](../src/RaftDeviceInfo.ts);
  `el`/`eu` schema fields; `elemsPerSample`/`elemLabels`/`elemUnits` on `DeviceAttributeState`;
  sample-count based poll validation and sample-aligned history trimming in
  [RaftAttributeHandler.ts](../src/RaftAttributeHandler.ts); array-aware
  `deviceAttrGetLatestFormatted`; array attributes excluded from
  [DeviceLineChart.tsx](../examples/dashboard/src/DeviceLineChart.tsx). Unit tests in
  [RaftAttributeHandler.test.ts](../src/RaftAttributeHandler.test.ts) (full suite 144 passing).
- **Phase 2 (record migration) — done.** `RoboticalSoundSensor` record in RoboticalAxiom1
  `AxiomDevTypes/RSAOTypeRecords.json` uses `{ "n": "bands", "t": "B[9]", "el": [...], "eu": "Hz" }`.
  Verified end-to-end on hardware: dashboard shows
  `bands [-57, -58, -54, ...] dB` alongside all scalar attributes.
- **RaftCore DecodeGenerator — done** (in RoboticalAxiom1 `raftdevlibs/RaftCore`):
  `parse_attr_type()` handles endian/prefix/`[N]` syntax; array attributes now generate C array
  struct fields (`int16_t bands[9]`, `float temperature[64]` for AMG8833) and per-element
  extraction loops with transforms. `AttrFieldDesc` unchanged (named-value lookup returns element 0).
  Note: this change lives in the raftdevlibs copy and should be upstreamed to the main RaftCore repo.
- **Phase 3 (visualizer registry) — done.** [visualizers/VisualizerRegistry.ts](../examples/dashboard/src/visualizers/VisualizerRegistry.ts)
  with score-based `match()` and `placement: 'actions' | 'charts'`; built-ins registered in
  [visualizers/index.ts](../examples/dashboard/src/visualizers/index.ts). `vt` field added to
  attribute and action schemas (explicit match beats heuristics). LEDPIX special case removed from
  DeviceActionsForm — now served by the registry via `LedGridVisualizer`.
- **Phase 4 (SpectrumChart) — done.** [visualizers/SpectrumChart.tsx](../examples/dashboard/src/visualizers/SpectrumChart.tsx):
  chart.js bar chart of the latest array sample, labels from `el`, axis titles from `eu`/`u`,
  renders in the right-hand chart panel above the timeline charts (`.device-charts-panel` stack).
  Matches on `vt: 'spectrum'` or any labelled array attribute. Verified live with the sound sensor
  at 4 Hz. `vt: "spectrum"` added to the sound sensor record (takes effect on next Axiom1 flash;
  the heuristic already selects it meanwhile).
- **Phase 5 (timeline chart splitting) — done.** `vg` schema field piped through to
  `DeviceAttributeState.visualGroup`; [chartGrouping.ts](../examples/dashboard/src/chartGrouping.ts)
  groups by explicit `vg`, else auto-groups by value units when a device has > 6 traces;
  `DeviceLineChart` takes an `attrNames` filter and DevicePanel renders one chart per group.
  Sound sensor now splits into dB / unitless / Hz charts.
- **Bug fix found during Phase 5:** the `v` (visibility) flag handling in RaftAttributeHandler was
  inverted (`v: false` made attributes visible and `v: true` hid them). Fixed with regression test
  (suite now 145 passing). `reserved16k`/`reserved2` now correctly hidden.

## Hardware test results (2026-08-14)

The sound sensor record was trialled with `band31`…`band8k` replaced by a single
`{ "n": "bands", "t": "B[9]", "a": -100, "el": [...], "eu": "Hz", "vs": false }` attribute
(no sound sensor firmware change — same 9 bytes at the same offsets). Axiom1 rebuilt
(`raft b` in WSL + Docker), flashed to COM10, dashboard connected via WebSocket to
192.168.86.136. Findings:

1. **Axiom1/RaftCore build & runtime: OK.** Build succeeds; sensor detected
   (`identifyDevice handler claimed address 10f as RoboticalSoundSensor`); REST
   `devman/typeinfo?bus=I2CA&type=RoboticalSoundSensor` serves the array attribute verbatim,
   including the new `el`/`eu` fields.
2. **DecodeGenerator.py skips array types** (RaftCore scripts): logs
   `get_c_eqv_type unknown type: B[9]` (and pre-existing `<h[64]` for AMG8833) and omits the
   field from the generated C poll struct. Harmless for publish/decode-in-client, but means
   firmware-side consumers (datalogger CSV decode etc.) don't see array attributes — noted as
   RaftCore future work.
3. **raftjs decode works, but state ingestion rejects the poll.** `structUnpack` decodes 9
   values, then `processMsgAttrGroup` ([RaftAttributeHandler.ts](../src/RaftAttributeHandler.ts)
   ~line 148) enforces equal value-counts across attributes per poll and **drops the whole poll
   record** on mismatch, logging
   `attrName bands newAttrValues lengths 1,1,1,1,1,1,1,1,1,1,1,1,1,9,1,1,1 do not match`.
   With the array record installed the device shows **no data at all** — this equal-count check
   is the first thing Phase 1 must fix (compare `values.length / elemsPerSample`, i.e. samples,
   not raw value counts).

Conclusion: Phase 2's record change is proven safe on the firmware side; Phase 1 (raftjs
`elemsPerSample` support) is a hard prerequisite before the record migration can be kept.

## Problem

The examples/dashboard app renders every device generically:

- **Special displays are hardcoded.** The only specialized visualizer, `DispLedGrid`, is wired in via
  `if (action.f === "LEDPIX")` inside
  [DeviceActionsForm.tsx](../examples/dashboard/src/DeviceActionsForm.tsx) (~line 188). Adding a new
  specialized display (e.g. an FFT/octave-band spectrum for the Robotical Sound Sensor) means more
  special-case code in the actions form, and there is no way to place a visualizer in the chart area.
- **Array data is modelled as many scalar attributes.** The sound sensor exposes its 9 octave bands as
  `band31`, `band63` … `band8k` — nine separate attributes. The struct decoder
  ([RaftStruct.ts](../src/RaftStruct.ts)) already supports repeat counts (`"3H"`, `"B[9]"`, `"<h[64]"` —
  the AMG8833 thermal camera already uses `"<h[64]"`), but:
  - `DeviceAttributeState.values` concatenates all decoded elements into one flat array with no
    per-sample grouping, so consumers cannot tell "9 elements per sample" apart from "9 samples".
  - There is no metadata for element labels (e.g. band centre frequencies) or an element axis.
- **The timeline chart is a single chart with all traces.**
  [DeviceLineChart.tsx](../examples/dashboard/src/DeviceLineChart.tsx) plots every attribute with
  `visibleSeries !== false` on one chart. The sound sensor has ~20 visible attributes spanning dB,
  Hz, ratios and counts, producing an unreadable tangle. Y-axes are already grouped by
  `(min, max, units)` but all traces still share one canvas, and there is no way to split attributes
  across multiple charts or show non-timeline charts (spectrum, spectrogram) in the chart panel.

## Goals

1. **Visualizer factory/registry** — specialized display components self-register with match rules;
   selection is driven by device-type metadata (attribute/action fields), not hardcoded conditionals.
2. **First-class array attributes** — per-sample element grouping in device state, element labels/axis
   metadata in device type records, and migration of the sound sensor bands to a single array attribute.
3. **FFT spectrum visualizer** — real-time bar/line spectrum of the octave bands rendered in the
   right-hand chart panel (not the left actions panel).
4. **Chart panel improvements** — the right panel becomes a stack of chart "slots": one or more
   timeline charts (attributes groupable/splittable) plus specialized charts from the registry.

## Non-goals

- Audio recording/streaming from the sound sensor (stats only).
- Changing the devbin binary format or poll layout of the sound sensor (32-byte block stays; only the
  device type record's attribute descriptions change).
- Spectrogram/waterfall display (noted as future work; the design should not preclude it).

## Current architecture (reference)

- **Panel layout** ([DevicePanel.tsx](../examples/dashboard/src/DevicePanel.tsx)):
  `device-block-data` is a flex row → left `device-attrs-and-actions` (DeviceAttrsForm +
  DeviceActionsForm), right `DeviceLineChart`.
- **Data flow**: publish msg → `RaftDeviceManager` → `RaftAttributeHandler.processMsgAttrGroup()` →
  values appended to `deviceState.deviceAttributes[attr].values` and timestamps to
  `deviceState.deviceTimeline.timestampsUs` → throttled React refresh (150 ms) via
  `addAttributeDataCallback`.
- **Attribute schema** ([RaftDeviceInfo.ts](../src/RaftDeviceInfo.ts)): `n, t, at, u, r, x, m, s, sb,
  ss, d, a, f, o, v, vs, vf, vft, lut`.
- **Decoder** ([RaftAttributeHandler.ts](../src/RaftAttributeHandler.ts)): `structUnpack(attrDef.t, …)`
  returns an array; transforms (`x`, `m`, `d`, `a`, …) are mapped over all elements; the result is
  pushed flat into `DeviceAttributeState.values`.
- **Sound sensor record**
  ([RSAOTypeRecords.json](../../..//Robotical/RoboticalAxiom1/AxiomDevTypes/RSAOTypeRecords.json),
  `RoboticalSoundSensor`, type id 0x0120): 32-byte poll block at 250 ms; bands are 9 × `"t": "B"`
  with `"a": -100` offset (dB, range −100…155).

## Approach

### Phase 1 — Array attribute support in raftjs core

1. **Fix the per-poll equal-count check** in `processMsgAttrGroup`
   ([RaftAttributeHandler.ts](../src/RaftAttributeHandler.ts) ~line 148): it currently requires all
   attributes to decode to the same number of values and drops the whole poll otherwise (confirmed on
   hardware — see test results above). Compare per-sample counts (`values.length / elemsPerSample`)
   instead.
2. **Element count in device state.** Extend `DeviceAttributeState`
   ([RaftDeviceStates.ts](../src/RaftDeviceStates.ts)) with:
   - `elemsPerSample: number` (default 1) — derived once from the type string repeat count
     (`parseFormatInstructions` in [RaftStruct.ts](../src/RaftStruct.ts) already computes this).
   - Consumers can then view `values` as `values[sampleIdx * elemsPerSample + elemIdx]`, and
     `latestSample(): (number|string)[]` helper returns the last full sample.
3. **Element metadata in the schema.** Add optional fields to `DeviceTypeAttribute`
   ([RaftDeviceInfo.ts](../src/RaftDeviceInfo.ts)):
   - `el?: string[]` — element labels (e.g. `["31.5", "63", "125", … "8k"]`).
   - `eu?: string` — element-axis unit (e.g. `"Hz"`), distinct from `u` which stays the value unit
     (e.g. `"dB"`).
   - (Optional, later) `ex?: { start: number, step: number, log?: boolean }` — computed axis as an
     alternative to explicit labels, useful for dense FFT bins.
4. **Timeline handling of array attributes.** In `DeviceLineChart`, an attribute with
   `elemsPerSample > 1` must not be plotted as a flat trace (it currently would be, mangling the time
   axis). Default behaviour: exclude from the timeline chart (it will be served by a specialized
   visualizer); optionally allow plotting a reduction (e.g. per-sample max or a selected element) as
   future work.
5. **Formatting.** `deviceAttrGetLatestFormatted` should format the latest *sample* (array) sensibly,
   e.g. `"[-42, -38, …]"` truncated, or `el`-labelled pairs in the attrs form.
6. **Unit tests.** Extend the RaftStruct/attribute-handler tests: decode `"B[9]"` with `a: -100`,
   verify `elemsPerSample`, per-sample grouping across multiple polls, and timeline exclusion.

**Firmware-side check (RaftCore/Axiom1): done — see "Hardware test results" above.** The record
change is safe; the only firmware-side gap is DecodeGenerator.py omitting array fields from the
generated C struct (RaftCore future work, not blocking).

### Phase 2 — Migrate the sound sensor bands to an array attribute

In `RSAOTypeRecords.json` (RoboticalAxiom1 repo — regenerate/flash Axiom1 afterwards):

```json
{ "n": "bands", "t": "B[9]", "u": "dB", "eu": "Hz",
  "el": ["31.5", "63", "125", "250", "500", "1k", "2k", "4k", "8k"],
  "r": [-100, 155], "a": -100, "f": "d", "o": "int16",
  "vs": false, "vt": "spectrum" }
```

- Replaces the nine `band31`…`band8k` entries (same 9 bytes at the same offsets — no firmware change).
- `vs: false` keeps it off the timeline chart; `vt` (see Phase 3) selects the spectrum visualizer.
- `reserved16k` stays a separate hidden byte (or the array becomes `B[10]` later when the 16 kHz band
  is populated).
- No change needed in RoboticalAxiomSoundSensorFW — `encodeDevbin()` layout is unchanged.

### Phase 3 — Visualizer registry (factory pattern)

New dashboard module `src/visualizers/`:

```typescript
export interface DeviceVisualizerProps {
    deviceKey: string;
    attribute?: DeviceTypeAttribute;   // for attribute-driven visualizers
    action?: DeviceTypeAction;         // for action-driven visualizers (LEDPIX)
}

export interface DeviceVisualizerEntry {
    id: string;                        // e.g. "spectrum", "ledgrid"
    placement: "actions" | "charts";  // left panel vs right chart panel
    // Return a score > 0 if this visualizer wants to render the attr/action; highest wins
    match(deviceState: DeviceState, item: DeviceTypeAttribute | DeviceTypeAction): number;
    component: React.ComponentType<DeviceVisualizerProps>;
}

VisualizerRegistry.register(entry);
VisualizerRegistry.select(deviceState): PlacedVisualizer[];
```

Match rules, in priority order:

1. **Explicit metadata** — new optional schema field `vt?: string` ("visual type") on attributes and
   actions naming a visualizer id (`"spectrum"`, `"ledgrid"`, `"heatmap"`, …). This is the preferred,
   declarative mechanism and lives in the device type record.
2. **Legacy/heuristic** — `action.f === "LEDPIX"` maps to `ledgrid` (back-compat); an array attribute
   with `el`/`eu` and no `vt` defaults to `spectrum`.

Refactor:

- `DeviceActionsForm` drops the LEDPIX special case and instead renders any
  `placement === "actions"` visualizers selected for the device.
- `DevicePanel`'s right side becomes a `DeviceChartsPanel` that stacks `placement === "charts"`
  visualizers above/below the timeline chart(s).

### Phase 4 — FFT spectrum visualizer

`SpectrumChart` (`placement: "charts"`), registered as `"spectrum"`:

- Chart.js bar chart (reuse existing chart.js dependency), x categories from `el` (+ `eu` axis title),
  y range from `r` (−100…155 dB, but default the view to a useful window e.g. −90…40 dB with
  autoscale toggle), `animation: false`.
- Data: latest sample of the array attribute via `elemsPerSample`; refresh on the existing throttled
  attribute-data callback (sensor updates at 4 Hz, well within budget).
- Optional niceties: peak-hold trace (decaying max per band), value labels on hover.
- Works for any device with an array attribute + `el` labels — not sound-sensor-specific.

### Phase 5 — Timeline chart splitting

Reduce trace clutter by splitting the single timeline chart into groups:

1. **Grouping metadata** — new optional attribute field `vg?: string` ("visual group"): attributes
   sharing a `vg` value render on the same timeline chart; ungrouped attributes fall back to automatic
   grouping.
2. **Automatic grouping** — reuse the existing y-axis grouping key `(min, max, units)`: each distinct
   key becomes its own chart when the number of traces exceeds a threshold (e.g. > 6), otherwise the
   current single-chart behaviour is kept. For the sound sensor this naturally yields: dB levels
   (rms/peak/leq/crest), Hz (centroid/spread/rolloff85/f0), ratios (zcr/flatness), counts
   (flux/clipCount).
3. **UI** — `DeviceChartsPanel` stacks the charts vertically with shared time window; per-chart
   legend click to hide traces (chart.js built-in); a per-device "combine/split" toggle stored in
   SettingsManager.
4. **Performance** — multiple chart.js instances per device multiply render cost; keep the existing
   150 ms throttle + 500 ms staggered chart timer, and cap total charts per device (e.g. 4).

Suggested sound sensor grouping via `vg` in the device record: `"levels"` (rms, peak, leq, crest),
`"spectral"` (centroid, spread, rolloff85, f0), `"character"` (zcr, flatness, flux), `"status"`
(clipCount).

## Sequencing and effort

| Phase | Repo(s) touched | Depends on | Size |
|-------|-----------------|------------|------|
| 1. Array attrs in core (`elemsPerSample`, `el`/`eu`, chart exclusion, tests) | raftjs | — | M |
| 2. Sound sensor record migration to `B[9]` | RoboticalAxiom1 (+ Axiom1 reflash) | 1 | S |
| 3. Visualizer registry + LEDPIX migration + `vt` field | raftjs | — (parallel with 1) | M |
| 4. SpectrumChart | raftjs | 1, 2, 3 | S–M |
| 5. Timeline chart splitting + `vg` field | raftjs (+ records later) | 3 | M |

## Test plan

- **Unit (raftjs)**: RaftStruct repeat-count decode; attribute handler grouping (`elemsPerSample`,
  transforms applied per element); registry match/priority selection; formatting of array attributes.
- **Integration (dashboard)**: mock device state with the new `bands` attribute → SpectrumChart
  renders 9 bars with correct labels/dB values; LEDPIX still renders via registry.
- **Hardware-in-loop**: Axiom1 on 192.168.86.136 (WebSocket), sound sensor on the RSAO bus
  (FW on COM8 via PlatformIO, Axiom1 flash/monitor on COM10). Verify: device detected (0x0120),
  bands array decodes end-to-end, spectrum updates at 4 Hz, timeline charts split as configured,
  existing e2e script (`test:e2e:real-marty`) still passes for non-array devices.

## Risks / open questions

- ~~**RaftCore array-attribute parity**~~ — resolved by the hardware test: build, detection, polling
  and REST typeinfo all work with `B[9]`; unknown schema fields (`el`, `eu`) pass through untouched.
  Remaining gap: DecodeGenerator.py omits array fields from the firmware-side C decode struct
  (affects on-device datalog decode only; RaftCore future work).
- **DeviceAttrsForm rendering** of a 9-element array needs a compact representation (labelled row or
  small inline sparkline) — decide during Phase 1.
- **Values buffer growth**: array attributes multiply the `values` array growth rate ×N; check the
  existing history-trimming logic honours sample boundaries once `elemsPerSample > 1`.
- Whether `reserved16k` should be folded into a `B[10]` array now (display would show an empty band)
  or kept reserved until the firmware populates it.

## Future work

- Spectrogram/waterfall visualizer fed from the same array-attribute history.
- Dense FFT bin export from the sound sensor (larger devbin block or chunked reads) using `ex`
  computed axes instead of explicit labels.
- User-arranged chart layout (drag to combine/split traces) persisted in SettingsManager.
- Thermal camera (AMG8833) heatmap visualizer via the same registry (`vt: "heatmap"`, NX/NY-style
  grid metadata).
