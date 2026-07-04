# Camera Logging and Live View for the Example Dashboard

Date: 2026-07-03 (updated same day: implemented — see Implementation Status at the end)

## Purpose

RoboticalAxiom1 firmware now includes camera support via the `RaftCamera` library
(Camera SysMod). This document plans dashboard (examples/dashboard) support for:

- Detecting whether the connected device has a camera before showing any camera UI.
- A live camera view driven by subscribing to the `Camera` publish topic.
- Extending the existing data-logging workflow so that starting a logging session
  can also start timed image capture on the device (the most common combined use
  case), and stopping logging stops image capture.
- Browsing/downloading captured images alongside log files.

No code changes yet — this is the implementation plan.

## Firmware Capabilities (as implemented in RaftCamera)

The Camera SysMod on the device provides a single `camera` REST endpoint:

| Command | Purpose |
| --- | --- |
| `camera?action=status` | Enabled/ready state, size/quality, image count, and interval-capture session stats (`capture` object: active, fs, folder, intervalMs, maxImages, images, failures, totalBytes, elapsedMs, lastFilename, lastBytes, lastWidth, lastHeight) |
| `camera?action=capture[&fs=local\|sd][&folder=/images][&filename=..]` | One-shot JPEG capture to file |
| `camera?action=set[&size=VGA][&quality=16]` | Change frame size / JPEG quality at runtime |
| `camera?action=start[&fs=local\|sd][&folder=/images][&intervalMs=..\|fps=..][&maxImages=..][&size=..][&quality=..]` | Start an interval-capture session (runs on a device-side worker task) |
| `camera?action=stop` | Stop the interval-capture session |

It also registers a Raft publish data source (topic name from config, default
`Camera`). Each published message is a compact binary payload — a 19-byte
little-endian header followed by JPEG bytes:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Version (1) |
| 1 | 4 | Image count |
| 5 | 4 | Timestamp (ms) |
| 9 | 2 | Width |
| 11 | 2 | Height |
| 13 | 1 | Pixel format |
| 14 | 1 | JPEG quality |
| 15 | 4 | Payload length (JPEG bytes) |
| 19 | n | JPEG data |

Publication is state-hash driven by the device image count, so frames are only
published when a new image has been captured, subject to the subscription's rate
settings. The device-side capture rate for the publish path is governed by the
`capturefps` camera config (0 = capture on demand at publish time).

Data logging on the device is the existing `datalog?action=start|stop|status`
DataLogger SysMod already used by `LoggingPanel.tsx`.

## Design Overview

```
+---------------------------------------------------------------+
| Dashboard                                                      |
|                                                                 |
|  connect -> getSystemInfo -> camera?action=status               |
|                       |                                         |
|              cameraAvailable? --no--> hide camera UI            |
|                       |yes                                      |
|   +----------------+  +---------------------+                   |
|   | CameraPanel    |  | LogConfigPanel      |                   |
|   | - live view    |  | - existing config   |                   |
|   | - size/quality |  | - [x] capture images|                   |
|   | - snapshot     |  |   interval, fs, size|                   |
|   +----------------+  +---------------------+                   |
|          ^                      |                               |
|   Camera publish topic     LoggingPanel start/stop              |
|   (binary JPEG frames)     -> datalog?action=start              |
|                            -> camera?action=start (if enabled)  |
|                                                                 |
|   LogFilesPanel / ImageFilesPanel: filelist + fsGetContents     |
+---------------------------------------------------------------+
```

## 1. Camera Detection

Gate all camera UI behind a check performed once per connection (and re-checked
on reconnect):

```ts
async function checkCameraAvailable(): Promise<CameraStatus | null> {
  try {
    const resp = await connManager.getConnector().sendRICRESTMsg('camera?action=status', {});
    if ((resp as RaftOKFail)?.rslt === 'ok') return resp as CameraStatus;
  } catch { /* not present */ }
  return null;
}
```

Notes:

- A device without the Camera SysMod returns a non-`ok` result (unknown
  endpoint), and a device with the SysMod disabled returns
  `"camera not available"` — both should hide the camera UI.
- As a secondary signal, `RaftSystemUtils.refreshPublishTopicMap()`
  (`pubtopics` command) can confirm a `Camera` topic exists; this is also needed
  anyway for topic-index-to-name mapping of incoming frames.
- Hold the result in `Main.tsx` state (e.g. `cameraStatus`) and pass it down, so
  the check happens once rather than per panel.

## 2. Live View (Subscription to the Camera Topic)

### Subscription

The dashboard's system-type handlers (`SystemTypeGeneric`, `SystemTypeCog`, ...)
send the subscription command in `subscribeForUpdates()` via
`sendRICRESTCmdFrame`. When a camera is detected, add the camera topic:

```json
{"cmdName":"subscription","action":"update","pubRecs":[
  {"name":"devbin","trigger":"timeorchange","rateHz":10},
  {"name":"Camera","trigger":"timeorchange","rateHz":2}
]}
```

Since camera availability is only known after connection, the camera
subscription should be sent as a separate, later `subscription` update rather
than being baked into the initial `subscribeForUpdates()` — e.g. a
`subscribeCameraFeed(rateHz)` helper that the CameraPanel calls when the user
enables live view (and `rateHz:0` / disable when the panel is hidden). This also
keeps bandwidth free when the live view is not on screen.

### Frame routing

Incoming publish frames arrive at `RaftConnector.onRxOtherMsgType()` →
`systemType.rxOtherMsgType()` → `inspectPublishFrame()` (RaftPublish.ts), which
identifies binary frames and maps the topic index to a name using
`RaftSystemUtils.getPublishTopicName()`.

Extend the system-type `rxOtherMsgType()` handling: when
`frameMeta.frameType === "binary"` and `frameMeta.topicName === "Camera"`,
decode the 19-byte header at `frameMeta.binaryPayloadOffset` and emit a publish
event with the decoded metadata and a `Uint8Array` view of the JPEG bytes.

**Verification item (firmware/JS interop) — RESOLVED:** inspection of the
firmware showed the Camera payload was sent bare (first byte = camera header
version 0x01, no envelope), which would have been misrouted into the legacy
devbin path by `SystemTypeGeneric.rxOtherMsgType`. The firmware
(`CameraSysMod::publishGenMsg`) was updated to prepend the standard 3-byte
binary publish envelope (0xDB magic, topic index, wrapping sequence counter),
so `inspectPublishFrame()` reports the topic index and the frame is routed by
topic name.

### Decoding helper in raftjs core

Rather than embedding the header parse in the dashboard, add a small reusable
decoder to `src/` (exported from `main.ts`), e.g. `RaftCameraFrame.ts`:

```ts
export interface RaftCameraFrame {
  version: number;
  imageCount: number;
  timestampMs: number;
  width: number;
  height: number;
  pixelFormat: number;
  jpegQuality: number;
  jpegData: Uint8Array;
}
export function decodeCameraFrame(payload: Uint8Array, offset = 0): RaftCameraFrame | null;
```

This keeps the wire format in one place, is unit-testable against a captured
frame fixture (testdata/), and is reusable by other raftjs applications.

### Rendering

`CameraPanel.tsx` renders the latest frame as an `<img>` using a Blob URL:

```ts
const blob = new Blob([frame.jpegData], { type: 'image/jpeg' });
const url = URL.createObjectURL(blob);
setImageUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
```

- Always revoke the previous object URL to avoid leaking memory at several
  frames per second.
- Overlay/status line: resolution, JPEG quality, image count, measured frame
  rate (from arrival times), and frame age.
- Controls: live view on/off (drives the subscription), frame size and quality
  dropdowns (`camera?action=set`), and a "Snapshot to device" button
  (`camera?action=capture`).

### Event plumbing caveat

`ConnManager.setConnectionEventListener()` supports a single listener owned by
`Main.tsx`. Camera frames should not silently replace that. Options:

1. Route camera frames through the existing single listener in `Main.tsx` and
   fan out via React state/context (simplest, follows current pattern).
2. Add a small multi-listener dispatcher in `ConnManager` (nicer, slightly wider
   change).

Recommendation: option 1 for V1, with the frame stored outside React state churn
(e.g. a ref + `useSyncExternalStore` or a simple emitter) since frames can
arrive faster than React renders comfortably.

### Bandwidth expectations

- QVGA JPEG frames are roughly 5–15 KB. WebSocket (WiFi) comfortably supports a
  few frames/sec; WebSerial is workable at low rates; BLE will be slow
  (likely < 1 fps) — the panel should default to a low `rateHz` (e.g. 1–2) and
  surface the measured achieved rate rather than promising fluid video.
- Consider disabling live view automatically when connected over BLE, or
  defaulting to on only for WebSocket connections
  (`connManager.getConnector().getConnMethod()`).

## 3. Combined Logging + Image Capture

This is the primary workflow: one button starts both data logging and timed
image capture; one button stops both.

### LogConfigPanel additions (shown only when camera available)

| Setting | Maps to | Default |
| --- | --- | --- |
| Capture images during logging (checkbox) | whether `camera?action=start` is sent | on when camera present |
| Image interval | `intervalMs` (or `fps`) | 60000 ms |
| Max images | `maxImages` | 0 (unlimited) |
| Storage | `fs=local\|sd` | `sd` when available, else `local` |
| Folder | `folder` | `/images/<label>` |
| Frame size / quality | `size`, `quality` | device current |

Using the log session label in the folder name groups images with their logging
session (e.g. `/images/growth-test-1`). Folder names should be sanitised the
same way the datalog label is.

### LoggingPanel changes

- Start: after a successful `datalog?action=start...`, send
  `camera?action=start&fs=..&folder=..&intervalMs=..&maxImages=..[&size=..][&quality=..]`
  when image capture is enabled. If the camera start fails, keep logging running
  but show a warning (partial success state).
- Stop: send `datalog?action=stop` and `camera?action=stop`.
- Status polling (existing 2 s poll): also call `camera?action=status` and merge
  the `capture` session object into the status display — images captured,
  failures, total bytes, last filename, last image dimensions. The
  interval-capture worker on the device keeps captures off its main loop, so
  polling stays cheap.
- On reconnect, status polling naturally re-syncs UI state with a session that
  is still running on the device (same behaviour as datalog today).

Live view and interval capture can run concurrently — device-side camera access
is mutex-serialised — but publish-frame latency may spike around SD writes;
worth observing during testing.

### Image browsing/download

Extend `LogFilesPanel.tsx` (or add a sibling `ImageFilesPanel.tsx`):

- List: `filelist/sd/images/<folder>` (or `filelist/local/images/...`) — same
  command pattern as the existing `filelist/local/logs`.
- Download: `fsGetContents('sd/images/<folder>/<name>', 'fs', progressCb)`
  exactly as log files are downloaded today; save via Blob with
  `type: 'image/jpeg'`.
- Optional preview: show the downloaded image inline before/instead of saving.
- Optional "Download all" for a session folder (sequential `fsGetContents`
  calls with an aggregate progress bar). Note file transfer over BLE is slow;
  show per-file and total progress.
- Delete support mirrors the existing log-file delete behaviour.

## 4. New/Changed Files

| File | Change |
| --- | --- |
| `src/RaftCameraFrame.ts` (new, raftjs core) | 19-byte header decoder + types, exported from `main.ts` |
| `src/RaftCameraFrame.test.ts` (new) | Decoder unit tests with a fixture frame |
| `examples/dashboard/src/CameraPanel.tsx` (new) | Live view, size/quality controls, snapshot button |
| `examples/dashboard/src/Main.tsx` | Camera detection state, mount CameraPanel, route camera publish events |
| `examples/dashboard/src/SystemTypeGeneric/*` (and Cog/Marty as applicable) | Handle `Camera` topic in `rxOtherMsgType`; `subscribeCameraFeed()` helper |
| `examples/dashboard/src/LogConfigPanel.tsx` | Image-capture settings section (gated on camera) |
| `examples/dashboard/src/LoggingPanel.tsx` | Combined start/stop, merged status incl. capture session stats |
| `examples/dashboard/src/LogFilesPanel.tsx` or new `ImageFilesPanel.tsx` | Image listing, preview, download |

## 5. Implementation Stages

1. **Interop verification (hardware in hand):** subscribe to the `Camera` topic
   from the CommandPanel / a scratch script; confirm envelope format, topic
   index mapping via `pubtopics`, and capture a sample frame as a test fixture.
2. **Core decoder:** `RaftCameraFrame.ts` + unit tests against the fixture.
3. **Detection + CameraPanel live view** over WebSocket first; then assess BLE
   and WebSerial behaviour and set per-transport defaults.
4. **Combined logging:** LogConfigPanel settings + LoggingPanel start/stop/status
   integration.
5. **Image files:** listing, preview, download (and delete).
6. **Polish:** frame-rate display, partial-failure states, reconnect re-sync,
   README update for the dashboard example.

## Open Questions

- **Subscription rate semantics — RESOLVED:** `StatePublisher` publishes a
  heartbeat at `rateHz` for `timeorchange` triggers even when the state hash is
  unchanged, and with `capturefps=0` the capture happens at publish time — so
  the subscription `rateHz` sets the live-view frame rate. The CameraPanel
  defaults to 2 Hz on WebSocket and 1 Hz otherwise, user-selectable 0.5–5 Hz.
- **Which system types get camera handling — RESOLVED:** no system-type change
  was needed; `SystemTypeGeneric` already emits all publish frames as events
  with the topic name, and `Main.tsx` forwards `Camera` frames to a
  `CameraFeedStore` singleton.
- **Timestamp correlation:** camera header timestamps are device `millis()`;
  log records use UTC set at `datalog?action=start`. V1 relies on timestamped
  image filenames (RTC-based when time is set) for image/log correlation.
- **Multiple listeners:** deferred — V1 routes camera frames via the single
  `Main.tsx` listener into `CameraFeedStore` (outside React state churn).
- **SD presence detection:** the ImageFilesPanel surfaces a "is an SD card
  inserted?" hint when listing the `sd` filesystem fails; storage remains
  user-selectable (default `sd`) rather than auto-detected.

## Implementation Status

Implemented (2026-07-03):

- **Firmware** (`RoboticalAxiom1/raftdevlibs/RaftCamera`): `publishGenMsg` now
  wraps camera frames in the standard 3-byte binary publish envelope with a
  wrapping sequence counter. Verified with a clean `raft b -s AxiomPlantGrowth`
  build; RaftCamera README payload table updated.
- **raftjs core**: `src/RaftCameraFrame.ts` — `RaftCameraFrame` type,
  `decodeCameraFrame()` and `decodeCameraFramePublishMsg()` (handles transport
  prefix + optional envelope), exported from `main.ts`, with unit tests in
  `src/RaftCameraFrame.test.ts` (fixture-built frames, truncation/version/
  devbin-confusion cases).
- **Dashboard**:
  - `CameraFeedStore.ts` — singleton latest-frame store with listener
    subscription and measured-fps stats.
  - `CameraPanel.tsx` — live view (blob URLs with revocation), rate selection,
    on-demand topic subscription/unsubscription, size/quality controls,
    snapshot-to-device.
  - `Main.tsx` — per-connection `camera?action=status` capability probe gating
    all camera UI; forwards `Camera` publish events to the store.
  - `LogConfigPanel.tsx` — "Capture images during logging" section (interval,
    storage fs, size, quality) added to `LogConfig` as a `camera` field.
  - `LoggingPanel.tsx` — start/stop also starts/stops the camera interval
    capture (per-session folder `/images/<label>`, `maxImages` bounded by the
    log duration); status poll merges capture-session stats; camera capture is
    stopped when a timed log session ends; camera-start failure is a non-fatal
    warning.
  - `ImageFilesPanel.tsx` — fs selector (sd/local), breadcrumb folder
    navigation using `filelist` `isDir`, inline JPEG preview, download, delete.
  - `styles.css` — styles for the new panels.

Remaining (needs hardware):

- End-to-end test of live view and combined logging+capture against a real
  AxiomPlantGrowth board over WebSocket, then BLE/WebSerial rate tuning.
