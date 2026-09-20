# Diode characterisation with a USB PSU, Axiom-1 and the VCP board

> Status: **plan** — 2026-09-16 (revised same day: FNIRSI DPS-150 only, diodes only).
> Nothing in the dashboard has been changed yet.
> Bench facts in §2 come from the VCP firmware docs (MultiFirmware `docs/app-vcp.md`,
> `devdocs/vcp-adc-fifo-sampling.md`), the Axiom device record
> (`RoboticalAxiom1/AxiomDevTypes/RSAOTypeRecords.json`) and the community
> reverse-engineering of the DPS-150 (§9). Items marked **VERIFY** are assumptions to be
> checked on the bench before the code that depends on them is written.

## 0. Goal

Plot I–V characteristics of two-terminal semiconductors (signal and power diodes, Zeners,
LEDs) from the dashboard, with:

- **Stimulus** from a FNIRSI DPS-150 programmable USB power supply (USB CDC serial,
  driven from the browser over Web Serial). It is a single-quadrant source: 0..+30 V,
  0..5 A, source only.
- **Measurement** by the Robotical VCP board (3 × voltage-to-ground + 1 × current, 16-bit
  ADS1120) in an Axiom-1 slot, polled over I²C by the Axiom and streamed to the dashboard
  over the existing Raft WebSocket/BLE connection.
- **Orchestration, recording and plotting** in `examples/dashboard`: a sweep engine steps
  the PSU, waits for settling, averages VCP samples, derives diode voltage and current from
  a declared circuit, plots the curve and exports the data.

Three-terminal devices (BJTs, FETs) need a second supply and are deferred; the instrument
and sweep layers are written so that a second PSU slot and family sweeps can be added
without rework, but no such code is in scope now.

## 1. System overview

```
   PC / Chrome (examples/dashboard)
   ├── Raft connection (WebSocket to Axiom, or BLE)   ── existing ConnManager
   │       Axiom-1 ──I²C slot (isolated)──► VCP board ──► V1 V2 V3 I samples (RoboticalVCP device)
   └── PSU  (Web Serial: DPS-150)                     ── NEW InstrumentManager

   PSU(+) ──[Rs]──┬──►|──┐             V1 = PSU side of Rs,  V2 = anode
                  V1    V2             Vd = V2      Id = (V1 − V2) / Rs
   PSU(−) ── VCP GND ────┘             (measurement ground = PSU(−) only)
```

The VCP is the measurement of record. PSU read-back is used only for sanity checks and for
the settle gate.

## 2. What the hardware gives us (constraints that shape the design)

### 2.1 VCP board (`RoboticalVCP`, DTID 0x0111)

| Item | Value | Consequence |
|---|---|---|
| Voltage channels V1, V2, V3 | single-ended to VCP GND, usable ~±26 V, 1.61 mV/LSB (default cal num/den = 16144/10000) | Node voltages only; differences are computed on the host. **Cap every PSU setpoint at 24 V in software** so no node can exceed the input range. |
| Current channel I | INA240 + shunt, ~±11.4 A, 0.69 mA/LSB | Too coarse for diode curves below ~50 mA. Use it only for the high-current regime (power diodes, LEDs at rated current). Small currents come from a sense resistor and two V channels. |
| Isolation | The VCP's measurement side is isolated from the Axiom / I²C side | VCP GND is a free reference: tie it to PSU(−) and nothing else. Axiom, PC and USB grounds do not enter the measurement. |
| Output rate | 10–250 SPS/ch in scan mode; ADC free-runs (~440 SPS/ch) and averages into each output sample | Lower `_conf.rate` = more averaging = lower noise. 100 SPS/ch (default, 125 ms poll) is a good sweep rate; 10–25 SPS for the lowest-current ranges. |
| Poll model | host receives one FIFO burst per poll (125 ms at 100 SPS); `ovf` attribute counts dropped frames | The sweep engine must gate on **device timestamps**, not wall clock, and must reject any step whose window has `ovf > 0`. |
| Attributes seen by raftjs | `V1`, `V2`, `V3` (V), `I` (A), `ovf` | Names to bind in the circuit definition. |
| Actions | `mode`, `channel`, `_conf.rate`, `flush`, `start`, `stop`, `isenseEn`, `calibrate` (vt `vcpcal`) | `_conf.rate` via `deviceMgrIF.setSampleRate()` moves the poll interval with it. `calibrate` already has a dashboard visualizer. |
| Input impedance of the V dividers | **VERIFY** (not in the docs) | Divider current flows to VCP GND and *not* through the DUT, so I_DUT = (V1−V2)/Rs − V2/R_in. Must be measured (§6, phase 0) and put into the circuit maths if R_in is under ~1 MΩ. |
| Noise floor per rate | **VERIFY** | Sets the smallest resolvable current per Rs value (§4.1). |

### 2.2 FNIRSI DPS-150

| Item | Value |
|---|---|
| USB class | CDC serial, 115200 8N1, hardware flow control (as used by the cho45 Web Serial driver); USB VID/PID **VERIFY** on the bench |
| Browser API | Web Serial (`navigator.serial.requestPort`) — Chromium, secure context (parcel's `localhost` qualifies) |
| Range | 0–30 V, 0–5 A, up to 150 W depending on the USB-PD source (**VERIFY** the unit's actual V limit with the PD supply on the bench) |
| Frame | out `F1 cmd type len data.. cksum`, in `F0 cmd type len data.. cksum`; checksum = (type + len + Σdata) mod 256 |
| Commands | GET 0xA1, SET 0xB1, BAUD 0xB0, SESSION 0xC1 |
| Types (float32 LE unless noted) | 193 V set, 194 I set, 209–213 OVP/OCP/OPP/OTP/LVP, 216 metering enable (byte), 219 output enable (byte), 220 protection state (byte), 221 CC/CV (byte), 255 "all values" |
| Connect sequence | SESSION `C1 00 01`; BAUD `B0 00 05`; query model/hw/fw (222–224); GET 255 |
| "All values" (type 255) layout | 0 vin, 4 vset, 8 iset, 12 vout, 16 iout, 20 pout, 24 temp (floats); 107 output enabled, 108 protection state, 109 CC/CV (bytes) — offsets from the cho45 parser, **VERIFY** against the unit's firmware |
| Setpoint persistence | **VERIFY** whether SET writes non-volatile memory (the unit remembers its last setpoint across power cycles). If it does, a 100-step sweep is 100 flash writes; mitigate with coarser sweeps or by sweeping current in CC mode where fewer steps are needed |
| Isolation | Not isolated from USB — irrelevant here because the VCP is (§2.3) |

The PSU stays in CV mode while the load draws less than the current setpoint and drops into
CC otherwise. That is usable on purpose: with V set to a compliance value and I swept, the
PSU is a current source, handy for LEDs and power diodes (§4.3).

### 2.3 Grounding

- The VCP's measurement side is isolated from the Axiom, so the measurement reference is
  simply PSU(−). Wire VCP GND to PSU(−) with its own lead and connect nothing else to it.
- The PSU's output negative is common with USB ground, so PSU(−) is also PC ground. That
  does not matter: nothing on the measurement side connects to the PC except through the
  isolated VCP.
- Load current must return through the dedicated PSU(−) lead, never through a USB shield.
- Keep the Axiom on Wi-Fi with its own supply (bench Axiom at `http://192.168.86.136`);
  opening its COM port resets it, which would abort a sweep.

## 3. Dashboard additions

Everything new is additive; nothing in the existing Raft connection path changes.

### 3.1 Instrument layer — `src/instruments/`

```
src/instruments/
  PsuInstrument.ts          interface + shared types (PsuInfo, PsuReadback, PsuLimits, events)
  PsuDps150WebSerial.ts     DPS-150 driver (Web Serial, 0xF1/0xF0 frames, sum checksum)
  PsuSimulated.ts           in-memory PSU with a pluggable DUT model (Shockley diode) for dev,
                            unit and e2e tests
  psuCodecs.ts              pure encode/decode + checksum helpers (unit-tested, no I/O)
  InstrumentManager.ts      singleton (mirrors ConnManager): one PSU slot now (an array so a
                            second can be added later), connect/disconnect, readback polling,
                            watchdog, "output off" panic, disconnect events
```

`PsuInstrument` interface (minimum):

```ts
interface PsuInstrument {
  readonly kind: 'dps150' | 'sim';
  readonly limits: { vMax: number; iMax: number; vStep: number; iStep: number };
  connect(): Promise<PsuInfo>;                 // opens the chooser (must be called from a user gesture)
  disconnect(): Promise<void>;
  setOutput(v: number, i: number): Promise<void>;   // clamps to limits and to the experiment cap
  setEnabled(on: boolean): Promise<void>;
  readback(): Promise<PsuReadback>;            // { vin, vout, iout, mode:'CV'|'CC'|'off', tempC?, enabled }
  onEvent(cb: (ev: 'readback'|'disconnected'|'error', data?: unknown) => void): void;
}
```

Design notes:

- The driver owns its serial port; it does **not** go through `RaftChannelWebSerial`
  (different protocol) but copies its reader-loop and disconnect-listener pattern.
- The port chooser is filtered by the DPS-150's VID (**VERIFY** the value) so the user cannot
  accidentally pick the Axiom's own CDC port.
- Type declarations: add `@types/w3c-web-serial` (or a local `declare` block as
  `RaftChannelWebSerial.ts` does) so `tsconfig` stays strict.
- `InstrumentManager` polls read-back at ~4 Hz while connected (GET 255) and raises
  `disconnected` if a poll fails twice; the sweep engine treats that as an abort.

### 3.2 Measurement source — `src/experiments/VcpSource.ts`

- Finds the VCP device in `deviceMgrIF.getDevicesState()` by `deviceTypeInfo.type ===
  'RoboticalVCP'` (fallback: `clas` includes `POWR`). Exposes its `deviceKey`, online state
  and calibration status (STATUS bit 0 via `cmdRawWriteRead`, same read the vcpcal
  visualizer does).
- Subscribes with `addAttributeDataCallback` and reads `deviceTimeline.timestampsUs` and
  `deviceAttributes[V1|V2|V3|I|ovf].values`.
- `window(fromUs, toUs)` → per-channel `{ mean, std, n }` plus `ovfSeen`. `latestUs()` gives
  the settle-gate reference (§3.3).
- Raises `maxDatapointsToStore` for the session if the stored history is shorter than
  one dwell window (default 1000 points is enough at 100 SPS for ~10 s, so usually no change).
- `setRate(hz)` → `deviceMgrIF.setSampleRate(deviceKey, hz)`.

### 3.3 Sweep engine — `src/experiments/SweepEngine.ts` (pure TS, no React)

Inputs: a `CircuitDefinition` (§3.4), a `SweepPlan`, the PSU, a `VcpSource`.
Output: an `ExperimentRun` (metadata + points) and progress events.

Per step:

1. Clamp the setpoint to the circuit's caps (never above 24 V on any node; I cap from the
   circuit) and apply it to the PSU.
2. Settle gate: note `t0 = vcp.latestUs()`; wait until PSU read-back is within tolerance of
   the setpoint **and** `vcp.latestUs() > t0 + settleUs` (default settle 150 ms, longer when
   stepping *down* — PSU output capacitors discharge slowly into a high-impedance DUT, so
   sweeps default to ascending order).
3. Dwell: collect `[t0 + settleUs, t0 + settleUs + dwellUs]` (default dwell 300 ms → ~30
   samples at 100 SPS). Reject the step if `ovf > 0` or the window has fewer than 5 samples;
   retry once, then abort.
4. Derive DUT quantities from the means via the circuit formulas; attach stds.
5. Limits: abort (and switch the PSU off) if any derived quantity exceeds the circuit limit
   (I_max, P_max), the PSU reports CC when CV was expected (or vice versa), the PSU
   disconnects, or the VCP goes offline.
6. Emit the point.

Sweep shapes: linear or log-spaced setpoints in V or I; optional reverse pass to expose
hysteresis/self-heating. Every run ends with the PSU output off, including on abort and on
page unload (`pagehide`, as `Main.tsx` already does for the Raft connection).

### 3.4 Circuit definitions — `src/experiments/circuits.ts`

Declarative, so a new topology is data, not code:

```ts
{
  id: 'diode-forward',
  title: 'Diode forward characteristic',
  wiring: '...ASCII diagram from §4.2...',
  nodes: { V1: 'psu_plus', V2: 'anode' },        // which VCP channel is on which node
  parts: { Rs: { ohms: 100, between: ['V1', 'V2'], powerW: 0.25 } },
  derived: {                                     // evaluated on channel means
    Vd: 'V2',
    Id: '(V1 - V2) / Rs - V2 / Rin',            // Rin from the instrument profile (§6)
    Pd: 'Vd * Id',
  },
  sweep: { psu: { quantity: 'voltage', from: 0, to: 3, points: 60, spacing: 'linear' },
           iLimitA: 0.05 },
  limits: { Id: 0.05, Pd: 0.3 },
  plot: { x: 'Vd', y: 'Id', yLog: true },
}
```

Presets to ship (details in §4): instrument check, diode forward, Zener/LED, diode
high-current (I channel). Formulas are simple arithmetic; a per-preset TS function is
enough — do not pull in an expression library.

### 3.5 UI — `src/experiments/*.tsx`

Added to the connected column in `Main.tsx` alongside `CameraPanel`, rendered only when a
`RoboticalVCP` device is present:

| Component | Content |
|---|---|
| `ExperimentPanel` | Container with a collapsible header, like the other panels |
| `PsuPanel` | Connect DPS-150 / Simulated; live read-back (Vout, Iout, mode, temp); manual V/I set; output on/off; **Output OFF** button that is always enabled |
| `CircuitSetupPanel` | Preset picker; editable Rs value and DUT limits; the wiring diagram; a **Check wiring** action (apply 0.5 V, confirm V1 and V2 move and V3/I do not) |
| `SweepPanel` | Sweep parameters, rate selector (calls `setRate`), Start / Abort, progress, last-step readout, abort reason |
| `ResultsChart` | `react-chartjs-2` scatter, log-y option, hover shows raw channel means and stds |
| Export | Copy TSV (reuse the pattern in `DevicePanel.handleCopyToClipboard`), download JSON with full metadata (§7) |

Settings additions (`SettingsManager`): remember last PSU kind and last circuit preset. No
new global settings otherwise.

## 4. Experimental setups

Common rules: all nodes referenced to VCP GND, which is wired to PSU(−) and nothing else;
the sense resistor is the current-limiting element so a shorted DUT is bounded by V/Rs; no
node may exceed 24 V; choose Rs so its dissipation stays under its rating (0.6 W at 250 mA
through 10 Ω is already a 1 W part).

### 4.1 Current ranging with a sense resistor

Resolution of (V1 − V2) is 1.6 mV/LSB before averaging (noise **VERIFY**, expect a few LSB
rms at 100 SPS, less at 10 SPS).

| Rs | I per LSB | Max I at 3 V across Rs | Use |
|---|---|---|---|
| 10 kΩ | 0.16 µA | 0.3 mA | Low-current region (loading by R_in matters, §6) |
| 1 kΩ | 1.6 µA | 3 mA | Small-signal diodes, Zener knee |
| 100 Ω | 16 µA | 30 mA | Default for signal diodes |
| 10 Ω | 160 µA | 300 mA | Power diodes, LEDs (1 W resistor) |
| VCP I channel, Rs ≈ 0 | 0.69 mA | 5 A (PSU limit) | Power diodes at rated current; PSU in CC mode |

Ranges overlap by a decade, so a full curve is several runs with different Rs stitched by
the export (each run records its Rs).

### 4.2 Diode forward

```
PSU(+) ──[Rs]──┬──►|── VCP GND ── PSU(−)      V1: PSU side of Rs     V2: anode
               V1  V2                          Vd = V2      Id = (V1−V2)/Rs
```
Sweep PSU voltage 0 → 3 V (60–100 points, ascending), I limit 50 mA. Plot Id vs Vd, log-y.
Fitting log(Id) vs Vd over the exponential region gives the ideality factor and saturation
current; that fit can be a later addition to `ResultsChart`.

Zener: reverse the diode (cathode to Rs) so breakdown sits at positive node voltages; sweep
up to ≤ 24 V with Rs = 1 kΩ. LED: as forward, top of sweep ~4 V, Rs = 100 Ω or 10 Ω.

### 4.3 Diode / power device, high current (I channel)

DUT in series with the VCP current path and no Rs (or 0.5 Ω as a fuse substitute); PSU in
CC mode: V set to compliance (e.g. 5 V), I swept 10 mA → 3 A log-spaced with short dwell.
V2 on the anode. Watch DUT power; abort at the preset P_max.

### 4.4 Instrument check (phase 0)

PSU(+) straight to V1 (and V2, V3 in turn), sweep 0 → 24 V, compare each channel's mean
with the PSU read-back. Then PSU(+) → [Rknown 10 kΩ] → V1 with nothing else on V1: the drop
across Rknown gives R_in. Fit k/c per channel and, if worthwhile, feed them to the existing
`calibrate` visualizer (a DMM is a better reference than the PSU read-back; the plan treats
this as a sanity check, not a calibration).

## 5. Phases

| Phase | Deliverable | Depends on |
|---|---|---|
| 0 Bench prerequisites | VCP in a slot, adopted (`/api/devman/listdevs`), dashboard connected over WebSocket; DPS-150 enumerated in Chrome (`chrome://device-log`, VID/PID recorded); setpoint-persistence test done; instrument check (§4.4) run by hand with the device panel | hardware |
| 1 PSU driver + panel | `psuCodecs.ts` with unit tests; DPS-150 driver; `InstrumentManager`; `PsuPanel` with manual control and Output OFF; simulated PSU | 0 |
| 2 Diode experiments | `VcpSource`, `SweepEngine`, `circuits.ts` with instrument-check and diode presets, `CircuitSetupPanel`, `SweepPanel`, `ResultsChart`, export | 1 |
| 3 High current | I-channel preset, CC-mode sweeps, short-dwell option, thermal guard (abort if a point drifts > x % during dwell) | 2 |
| 4 Hardening | e2e scenario with the simulated PSU; opt-in hardware e2e (chooser is manual, as in the real-Marty suite); this document updated with measured R_in, noise per rate and PSU quirks | 1–3 |

Phase 1 alone is useful (a bench PSU control panel next to the device view). Phase 2 is the
first real experiment and the point at which the settle/dwell gating gets validated.

Later, out of scope now: a second PSU slot and outer-loop family sweeps for BJTs and
MOSFETs. The `InstrumentManager` slot array and the `SweepPlan` shape should not preclude
them.

## 6. Instrument profile (filled in during phase 0)

Stored as a small JSON the circuit maths reads (`src/experiments/instrumentProfile.ts`,
overridable in the UI):

| Field | Value | Measured how |
|---|---|---|
| `vcp.rinOhms[V1..V3]` | **TBD** | §4.4 |
| `vcp.noiseLsbRms[rate]` | **TBD** | Shorted input, 10 s at each rate |
| `vcp.calStatus` | read at connect | STATUS byte 7 bit 0 |
| `psu.dps150.vid/pid`, `vMaxActual` | **TBD** | `navigator.serial.getPorts()`, bench |
| `psu.dps150.setpointPersists` | **TBD** | SET, power-cycle, read back |
| `psu.dps150.settleMs` (up-step / down-step into 10 kΩ) | **TBD** | Read-back vs time after a step |

## 7. Data format

One JSON per run:

```json
{
  "schema": "raftjs-dashboard-experiment/1",
  "startedAt": "2026-09-16T10:00:00Z",
  "dut": { "label": "1N4148 #3", "notes": "" },
  "circuit": { "id": "diode-forward", "parts": { "Rs": 100 }, "nodes": { "V1": "psu_plus", "V2": "anode" } },
  "instruments": { "psu": { "kind": "dps150", "info": {} }, "vcp": { "deviceKey": "1_121", "calStatus": "calibrated", "rateHz": 100 } },
  "profile": { "rinOhms": [0, 0, 0] },
  "sweep": { "settleMs": 150, "dwellMs": 300, "order": "ascending" },
  "points": [ { "set": { "psu_v": 0.5 }, "psu": { "vout": 0.501, "iout": 0.000, "mode": "CV" },
               "raw": { "V1": [0.5008, 0.0009, 30], "V2": [0.4997, 0.0010, 30] },
               "derived": { "Vd": 0.4997, "Id": 0.000011 } } ],
  "ended": { "reason": "complete" }
}
```

`raw` entries are `[mean, std, n]`. TSV export flattens `set`, `derived` and the raw means.

## 8. Risks and open questions

1. **VCP input divider loading** (§2.1). If R_in is ~100 kΩ the 10 kΩ range is unusable
   without the correction term; if it is ~1 MΩ it is a 1 % effect at 10 kΩ. Measure first.
2. **DPS-150 setpoint persistence and flash wear** (§2.2). Determines how fine a sweep is
   acceptable.
3. **Protocol offsets** (§2.2) are from a community parser and may differ by firmware
   version; the driver should validate the model/version reply and the "all values" record
   length before trusting the offsets.
4. **Settling into high-impedance loads**: output capacitance makes downward steps slow.
   Ascending sweeps plus the read-back-converged gate handle it; a descending pass is opt-in.
5. **Self-heating** during long dwells at high power distorts curves; the thermal guard in
   phase 3 and short dwells mitigate, not solve.
6. **Web Serial chooser collisions**: the existing "WebSerial" Raft connect button and the
   DPS-150 driver both open serial ports; the VID filter on the PSU side prevents one
   direction of the mistake, the Raft chooser is left as-is.
7. **Timestamps**: the settle gate uses VCP device timestamps (`timestampsUs`); PSU read-back
   is host-time. The gate only needs "later than t0", so no clock alignment is required.

## 9. References

- MultiFirmware `docs/app-vcp.md`, `devdocs/vcp-adc-fifo-sampling.md` (channels, ranges,
  rates, INA240 front end, calibration block).
- RoboticalAxiom1 `AxiomDevTypes/RSAOTypeRecords.json` (`RoboticalVCP` record),
  `docs/sample-rate-and-polling.md`.
- Dashboard code the plan builds on: `src/ConnManager.ts`, `src/DevicePanel.tsx`,
  `src/visualizers/VcpCalVisualizer.tsx`, `src/visualizers/vcpCalMath.ts`,
  raftjs `src/RaftChannelWebSerial.ts`, `src/RaftDeviceMgrIF.ts`.
- DPS-150 protocol: <https://github.com/cho45/fnirsi-dps-150> (Web Serial implementation; the
  type-byte table and record offsets in §2.2 come from its `dps-150.js`),
  <https://github.com/KochC/DPS-150-python-library>, <https://github.com/svenk123/dps150tool>,
  <https://github.com/nasheed-x/dps150_api>.
