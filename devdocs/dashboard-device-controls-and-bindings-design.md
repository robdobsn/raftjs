# Dashboard: devices controlling other devices (controls and bindings)

Date: 2026-11-07.

**Status:** phases 1-2 implemented and tested on the CogPro (2026-11-08); phases 3-7 to do.

**Motivation:** play the CogPro synth from a touch sensor:
- a Trill Flex style strip (the CogPro's CY8CMBR3116, record `CogProMBR3`) as a keyboard or stylophone;
- a strip or an Adafruit NeoSlider to bend notes;
- a Trill Square (2D) for an XY effect.

More generally: when a device appears that one visualizer's device can be driven by, the visualizer finds out and
offers the modes that make sense.

## 1. Principles

- **Metadata, not device names.** The registry chooses visualizers from the record (`vt`, `vo`, `clas`). Control
  sources are found the same way, so the Trill Bar, the Trill Ring and the CogPro strip all work without code that
  names them.
- **Normalised controls in the middle.** Inputs become a few control kinds, and outputs consume control kinds. N
  inputs × M outputs then needs N adapters + M mode sets, not N×M special cases.
- **Bindings are data:** source, target, mode and parameters as JSON. That makes them easy to save, show and edit,
  and later to **export to the device** as a RaftMicroPy or RaftScript script, so a binding prototyped in the
  dashboard can run on the CogPro without a laptop (`cogpro-synth-device-plan.md` §7). They use only attributes and
  actions, the same publish and action model on-device scripts use.
- **Bindings live outside React components.** A binding keeps running when a panel re-renders, collapses or scrolls
  away. Visualizers only show and edit bindings.
- **Explicit, predictable behaviour** (education and SEND): a compatible device is *offered* ("Play with the touch
  strip?"), never connected automatically. The active binding is always visible, and one control stops it.

## 2. Layers

```
 raftjs DeviceManager            (new device / removed / attribute data callbacks - exist today)
        │
        ▼
 ControlAdapterRegistry  ── adapters turn a device's attributes into ControlSources (by metadata)
        │
        ▼
 ControlDirectory        ── live list of sources (and sinks); "sources changed" events; useControls() hook
        │
        ▼
 BindingManager          ── active bindings: source events → mode → actions (sendAction), rate control
        ▲
        │ create / edit / stop
 Visualizers (e.g. KeyboardVisualizer) - offer modes for the compatible sources they see
```

### 2.1 Control kinds (normalised)

Values are normalised to 0-1 so modes don't need to know the device:

| Kind | Event data | From |
|-|-|-|
| `pos1d` | `touches: {id, pos 0-1, size 0-1}[]`, `channels` (pad count, for snapping) | Trill Flex/Bar/Ring/Craft, CogProMBR3 |
| `pos2d` | `touches: {id, x, y 0-1, size}[]` | Trill Square, Trill Hex |
| `scalar` | `value 0-1` | NeoSlider pot; later IR distance, IMU tilt, mic level |
| `buttons` | `pressed: boolean[]` | CogProMBR3 `buttons`, Trill Ring `btn`, seesaw buttons |

- **Touch ids:** the adapter keeps them stable across samples by nearest-position matching, so modes see
  `start` / `move` / `end` per touch, not raw arrays. A `pos1d` with up to 5 touches (Trill) and one with 1 (CogPro)
  look the same to a mode.
- **Rate:** sources run at the device's publish rate (CogProMBR3 20 Hz, Trill 20 Hz).

### 2.2 Control adapters (sources)

Like `VisualizerRegistry`: each adapter has `match(deviceState) → score` and `create(deviceKey) → ControlSource`. It
subscribes to `addAttributeDataCallback` for its device and attributes, and emits normalised events.

**Matching, in order:**
1. **An explicit `ctl` descriptor** on an attribute in the record (§3).
2. **The visualizer hint `vt: "touchstrip"`** gives `pos1d`. Its `vo` has everything needed: `sizeAttr`,
   `noValue`, `posMax`, `numChannels`, `sizeMax`. This covers CogProMBR3 and four Trill records **with no record
   changes**.
3. **Heuristics:** none at first. They would be guesses.

### 2.3 Sinks (what a target accepts)

The **first version** keeps the modes in the target's visualizer (the keyboard knows about notes, glide and bend
for its own device).

The **general version** has actions declare what they consume, as `ctl` on actions (§3), e.g.:
- `noteOn`/`noteOff` as `{"ctl":"notes"}`;
- `glide` as `{"ctl":"glide"}`;
- `bend` as `{"ctl":"bend","range":[-200,200]}`.

Generic modes (§4) can then drive any device with those sinks, such as another synth, or an LED device whose
`colour` is `{"ctl":"scalar"}`. Bindings then need no target visualizer at all, which suits Scratch and raftpy as
well.

### 2.4 ControlDirectory

- Listens to new, removed and online/offline events.
- Runs the adapters, and keeps `sources` (and later `sinks`) by device key.
- Emits `changed`.
- Hook: `useControls({ kinds: ['pos1d','pos2d','scalar'] })` returns the current compatible sources, and re-renders
  when they change.
- When a source device goes offline, its bindings **pause**, and resume when it comes back (same device key, or same
  type if there's only one).

### 2.5 BindingManager

```ts
interface Binding {
    id: string;
    source: { deviceKey: string; control: string };    // control = adapter's control id, e.g. "loc"
    target: { deviceKey: string };
    mode: string;                                       // e.g. "keys", "stylophone", "bend", "xy"
    params: Record<string, number | string | boolean>;  // e.g. { lowNote: 48, scale: "major", span: 14 }
    enabled: boolean;
}
```

- **Modes:** `{id, label, sourceKinds, sinks, params schema, createRunner(binding, send)}`. A runner gets
  normalised events and calls `send(actionName, value)`.
- **Sending** goes through `deviceManager.sendAction`, with two queue policies:
  - **ordered:** note on and off; they must not reorder or be dropped;
  - **latest-wins:** glide, bend, volume. At most one in flight; a newer value replaces a waiting one.

  This keeps a 20 Hz stream from building a backlog over BLE.
- **Persistence:** `SettingsManager`, keyed by **device type** (and name if set), so a binding comes back when the
  same kind of device appears. It's offered, not auto-enabled, unless the user ticks "always".
- **Export (later):** `binding → MicroPython script` (`device.on_data(...)` → `device.action(...)`), uploaded to the
  device's FS. That needs RaftMicroPy's `device.action()` (synth plan phase 6).

## 3. Record additions (RaftCore record format; raftjs types)

An optional `ctl` object on attributes (sources) and actions (sinks):

```jsonc
// Trill Square: 2D source (no vt today)
{ "n": "hloc", ..., "ctl": { "kind": "pos2d", "y": "vloc", "size": "hsize", "noValue": 65535, "max": 1792 } }
// NeoSlider pot: scalar source
{ "n": "pot", "t": ">H", ..., "ctl": { "kind": "scalar", "r": [0, 1023] } }
// Synth actions: sinks
{ "n": "glide", ..., "ctl": { "sink": "glide" } }
{ "n": "bend", "t": "<h", ..., "ctl": { "sink": "bend", "range": [-200, 200] } }   // cents
```

`ctl` is ignored by firmware: it's display and orchestration metadata, like `vt`. It goes in the wiki's record
format, the generator's allowed keys, and raftjs's `DeviceTypeAttribute`/`DeviceTypeAction` types.

## 4. Modes for the synth

| Mode | Source | Behaviour | Synth actions |
|-|-|-|-|
| **Keys** | `pos1d` | The strip is split into `span` keys of a scale from `lowNote`. Touch start → note on; moving to another key → note off and on; end → note off. Multi-touch on Trill gives chords | `noteOn`, `noteOff` |
| **Stylophone** | `pos1d` | Touch start → note on at the position's note. Move → **glide** to the scale-quantised note (smooth, always in tune). End → note off | `noteOn`, `glide`, `noteOff` |
| **Bend** | `pos1d` (relative to touch-down), `scalar` (centre = 0) | Bends the sounding notes ±range cents; returns to 0 on release (`pos1d`) or follows the slider (`scalar`) | `bend` (new) |
| **XY** | `pos2d` | x → note (quantised glide), y → volume or vibrato depth; size → velocity | `glide`, `volume` / `vibrato` (new) |
| **Expression** | `scalar` | Slider → volume, vibrato depth or glide time | `volume`, `vibrato`, `glideMs` |
| **Pads** (later) | `buttons` / strip zones | Each zone triggers a drum sound | `drum` (synth plan phase 7) |

**UI in KeyboardVisualizer:** when compatible sources exist, a row appears:
`Play with: [CogPro Touch ▾]  Mode: [Stylophone ▾]  Scale: [Major ▾]  [● On]`. Touches on the source light the
on-screen keys, so the mapping is visible: a child sees where the strip's notes are.

## 5. Synth firmware additions this needs

- **`bend`** (`t` `<h`, cents −1200…1200): an offset applied to the sounding voices' frequency (the engine's
  `setFrequency` on each sounding voice from its base note).
- **`vibrato`** (depth 0-100): the engine's `setVibrato` on sounding and new voices.
- **`ctl` sink descriptors** on the actions (§3).

## 6. Latency (dashboard bindings)

Touch → poll (CogProMBR3 50 ms, Trill ~50 ms) → publish → transport → browser → action → transport → synth.
- **Estimated:** WebSerial ~60-120 ms end to end, BLE more.
- **Good enough for:** experimenting, teaching and slow gestures (bend, XY).
- **Too slow for:** tight rhythm. That's the case for exporting bindings to the device (§2.5), and for faster
  touch polling.

**Measure it** with a binding that logs source sample time against the synth's published note change.

## 7. Phases

| # | Work | Done when |
|-|-|-|
| 1 ✅ | `ControlDirectory` with adapters (touchstrip→`pos1d`: touch ids, start/move/end), `useControls` hooks | CogProMBR3 shows as a `pos1d` source (Trill Flex: same adapter, not yet on hardware) |
| 2 ✅ | `BindingManager` (queues, pause/resume) + Keys and Stylophone modes; Play-with row in `KeyboardVisualizer` | The strip plays the synth from the dashboard in both modes |
| 3 | Synth `bend`/`vibrato` actions; Bend and Expression modes | Bend works from the strip (relative) |
| 4 | `ctl` in the record format (RaftCore wiki, generator, raftjs types); `pos2d` adapter; TrillSquare/Hex records gain `ctl`; XY mode | Trill Square XY drives pitch and volume |
| 5 | NeoSlider record (seesaw, I2C 0x30-0x33: pot ADC and 4 NeoPixels as an action) with `ctl` scalar; `scalar` adapter | Slider bends notes; its LEDs show the bend |
| 6 | Persistence (offer on reappear); sink-based generic modes (§2.3) | Bindings come back after reconnect; a non-synth sink works |
| 7 | Export a binding to RaftMicroPy (needs `device.action()`) | Stylophone runs on the CogPro with no dashboard |

## 8. Open questions

- **Where `ctl` lives:** in the record (above), or in a dashboard-side table by device type? A table would avoid
  record changes but brings back device names in code. Recommendation: the record, with the touchstrip `vt`
  fallback, so existing records work now.
- **Multi-touch on the synth:** voices are allocated by note, and `glide` moves the newest voice. For Trill
  multi-touch stylophone, each touch needs its own voice. Add a voice-addressed glide, or a `glideFrom` note, when
  it's needed.
- **NeoSlider details:** seesaw ADC channel and register addresses, and how its 4 NeoPixels are driven. Check
  against Adafruit's seesaw documentation when writing the record.

## 9. Implementation notes (phases 1-2, 2026-11-08)

- **Code:** `examples/dashboard/src/controls/`:
  - `ControlTypes`;
  - `ControlDirectory` (adapter list, `TouchStripSource`, directory);
  - `BindingManager`;
  - `synthModes` (Keys, Stylophone, scales);
  - `useControls`;
  - `PlayWithRow`, used by `KeyboardVisualizer`;
  - `controls.test.ts`: touch tracking, scale, both modes.
- **Adapters are currently a fixed list in `ControlDirectory`** (`registerAdapter` adds more). There's no separate
  `ControlAdapterRegistry` module yet.
- **Data comes from `addDecodedDataCallback`** (one call per message, all attributes and timestamps). It's now an
  optional method on `RaftDeviceMgrIF`, so `RICStateInfo` still compiles.
- **The directory re-attaches** whenever the connection's device manager instance changes (a new one per
  connection).
- **Keys mode** sends note-off before note-on when a touch moves to a new key, so the synth never holds both.
- **Stylophone** follows the first touch only (the synth's `glide` moves its newest voice). See §8 for multi-touch.
- **Bindings aren't saved yet** (phase 6). They last for the page session.

