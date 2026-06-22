# Dashboard Camera Panel — Stills, Live Preview and Video

## Purpose

Add a **Camera Panel** to the RaftJS example dashboard so a developer can exercise the new
`RaftCamera` module (the `CameraSysMod` / `RaftCameraDriver` library added to
`RoboticalAxiom1/raftdevlibs/RaftCamera`). The panel demonstrates the three things a camera
module needs to prove out:

- **Take a still** — trigger a capture on the device and view the resulting JPEG.
- **View images** — download captured JPEGs from the device file system and show them.
- **Stream video** — show a live, continuously-updating preview.

The panel sits alongside the existing `CommandPanel` and datalog panels, renders only when the
connected device reports a working camera, and uses the same `RaftConnector` / `ConnManager`
plumbing every other panel uses.

**No code has been changed yet.** This document records the investigation and describes the
work required to implement the panel.

## Background

### How the firmware exposes the camera

`CameraSysMod` is a standard RaftCore SysMod, so it is reachable over the same RICREST REST
endpoint mechanism that works across BLE, WebSocket and serial. Two surfaces are exposed.

#### 1. REST endpoint `camera`

Registered in
`RoboticalAxiom1/raftdevlibs/RaftCamera/components/CameraSysMod/CameraSysMod.cpp`
(`addRestAPIEndpoints` → `apiCamera`). All responses are JSON containing the usual
`"rslt":"ok"|"fail"` plus a status/result body.

| Endpoint | Purpose | Response body (on success) |
| --- | --- | --- |
| `camera?action=status` | Probe + current state. Use it to decide whether to show the panel. | `enabled`, `ready`, `size`, `quality`, `count`, `imageDir` |
| `camera?action=set&size=<frameSize>&quality=<0-63>` | Change frame size and/or JPEG quality at runtime. Either param optional. | same as `status` |
| `camera?action=capture[&filename=<name>]` | Capture a JPEG to the device file system. If `filename` is omitted a timestamped name is generated in `imageDir`. A bare filename is placed in `imageDir`. | `filename`, `bytes`, `width`, `height`, `quality`, `count` |

Notes from the firmware:

- `imageDir` defaults to `/images` and files are written through the `local` file-system name,
  i.e. a capture lands at `local/images/<filename>` for download purposes (this mirrors the
  `local/logs/<file>` convention `LogFilesPanel` already uses).
- `size` accepts the camera frame-size names the driver maps (e.g. `QVGA`, `VGA`, `SVGA`,
  `HD` …), matching `RaftCameraDriver::frameSizeFromName`.
- `quality` is the esp32-camera JPEG quality (lower = better quality / larger file).
- The handler refuses paths containing `..` (`isFilenameSafe`).

#### 2. Binary publish topic `Camera`

In `postSetup`, the SysMod registers a publish data source on the `Publish` channel with the
topic name from config (`publishTopic`, default **`Camera`**). When the topic is subscribed and
due, `publishGenMsg` captures a frame into PSRAM and emits a self-describing binary payload:

```
offset  size  field
0       1     version (==1)
1       4     image count        (uint32 LE)
5       4     timestamp ms       (uint32 LE)
9       2     width              (uint16 LE)
11      2     height             (uint16 LE)
13      1     pixel format
14      1     jpeg quality
15      4     payload length     (uint32 LE)
19      N     JPEG bytes
```

This is the same publish/subscribe path the device-data topics (`devbin`/`devjson`) use, so the
frame arrives in the dashboard through `rxOtherMsgType` and the `"pub"` event (see below). The
`Camera` topic is a *separate* topic from `devbin`, so the panel must explicitly subscribe to it.

### How RaftJS already supports each operation

Everything the panel needs already exists in the library and is used elsewhere in the dashboard.

**Send a REST command** — `RaftConnector.sendRICRESTMsg` (`src/RaftConnector.ts:469`):

```ts
async sendRICRESTMsg(commandName: string, params: object,
  bridgeID?: number): Promise<RaftOKFail>
```

`CommandPanel`, `LoggingPanel` and `DevicePanel` all call
`connManager.getConnector().sendRICRESTMsg('<cmd>?<query>', {})` and branch on `rslt === 'ok'`.

**Download a file** — `RaftConnector.fsGetContents` (`src/RaftConnector.ts:713`):

```ts
async fsGetContents(fileName: string, fileSource: string,
  progressCallback?: RaftProgressCBType): Promise<RaftFileDownloadResult>
```

`LogFilesPanel.handleDownload` shows the exact pattern: call with `('local/logs/<file>', 'fs', cb)`,
then wrap `result.fileData` (a `Uint8Array`) in a `Blob` and a `URL.createObjectURL` for the
browser. For the camera this becomes `('local/images/<file>', 'fs', cb)`.

**List files** — `sendRICRESTMsg('filelist/local/images', {})` returns `{ files: [{name,size}], diskSize, diskUsed }`
(identical to `LogFilesPanel.fetchFiles` against `filelist/local/logs`).

**Receive published frames** — the generic system type subscribes to a topic and forwards every
publish frame to the app event listener. In
`examples/dashboard/src/SystemTypeGeneric/SystemTypeGeneric.ts`:

- `subscribeForUpdates` sends a `subscription`/`update` command frame naming a topic and a
  `rateHz`. Today it subscribes to `devbin`; the camera needs the same shape with `name:"Camera"`.
- `rxOtherMsgType` runs each incoming frame through `inspectPublishFrame`
  (`src/RaftPublish.ts`) and then calls the registered event handler:

  ```ts
  this._onEvent("pub", RaftPublishEvent.PUBLISH_EVENT_DATA, ...,
    { topicName, topicIndex, frameType, payload, frameTimeMs, ... });
  ```

`ConnManager.setConnectionEventListener(listener: RaftEventFn)` registers that listener, so a
panel can observe `"pub"` events, match `topicName === "Camera"`, and decode the JPEG out of
`payload` using the header above.

**Connection event type** — `RaftEventFn` is
`(eventType, eventEnum, eventName, eventData?) => void`; the panel filters on
`eventType === "pub"`.

## Proposed implementation

The panel is delivered in three layers of increasing ambition. Layer 1 alone is a complete,
reliable demo using only already-proven APIs; layers 2–3 add live preview/video.

### Layer 1 — Still capture + view (MVP, no new library code)

Flow, all through existing APIs:

1. `sendRICRESTMsg('camera?action=capture', {})` → read `filename` from the response.
2. `fsGetContents('local/' + filename.replace(/^\//,''), 'fs', cb)` → `Uint8Array`.
3. `URL.createObjectURL(new Blob([fileData], { type: 'image/jpeg' }))` → `<img src=…>`.
4. Optional **Download** button reuses the blob to save locally (same as `LogFilesPanel`).
5. A **Gallery** sub-section lists `filelist/local/images` and lets the user view/download/delete
   prior captures (`filedelete/local/images/<file>`), mirroring `LogFilesPanel` one-to-one.

A **Settings** row sends `camera?action=set&size=…&quality=…` and refreshes status.

### Layer 2 — Live preview via the `Camera` publish topic

1. On "Start preview", subscribe to the topic by sending a subscription command frame (same
   shape `SystemTypeGeneric.subscribeForUpdates` uses, but `name:"Camera"`, `rateHz:<fps>`):

   ```ts
   const sub = '{"cmdName":"subscription","action":"update","pubRecs":[' +
     `{"name":"Camera","trigger":"timeorchange","rateHz":${fps},"minMs":50}]}`;
   await connManager.getConnector().getRaftSystemUtils()
     .getMsgHandler().sendRICRESTCmdFrame(sub);
   ```

2. Register a `"pub"` listener via `ConnManager.setConnectionEventListener`. For each event with
   `topicName === "Camera"` (or, if the topic envelope is absent, detect the `version==1` header),
   slice the JPEG (`payload` after the 19-byte camera header, accounting for the 2-byte publish
   prefix that `inspectPublishFrame` reports via `binaryPayloadOffset`) and update the `<img>`
   blob URL. Revoke the previous object URL each frame to avoid leaks.
3. On "Stop preview" / unmount, send the same subscription frame with `rateHz:0` and clear the
   listener.

> **Verify before relying on layer 2:** the camera topic is registered separately from `devbin`,
> so confirm against the firmware publish layer whether incoming camera frames carry the devbin
> topic envelope (so `inspectPublishFrame` resolves `topicName === "Camera"`) or arrive as
> "legacy" enveloped-less binary (`binaryHasEnvelope === false`). The decode offset depends on
> this. If the dashboard's single event-listener slot is already taken, prefer wiring the camera
> subscription into a dedicated system type (see "Where the code goes") rather than competing for
> `setConnectionEventListener`.

### Layer 3 — "Video" fallback via capture loop

If publish-based preview is not desired, a simple `setInterval` loop that repeats the Layer 1
capture+download at a chosen rate gives a low-frame-rate live view that depends on nothing beyond
the REST + file-download APIs. Use this as a guaranteed fallback and to validate end-to-end image
quality/latency over each transport (BLE vs WebSocket).

### Where the code goes

- **`examples/dashboard/src/CameraPanel.tsx`** — new component, structured like `LoggingPanel` +
  `LogFilesPanel`: `const connManager = ConnManager.getInstance();`, local React state, async
  handlers that call `connManager.getConnector()…`, and `lastError`/`isBusy` UI feedback.
- **`examples/dashboard/src/Main.tsx`** — add a capability probe and conditional render next to the
  existing datalog probe (around the `connected-panel` block, ~lines 207–225):

  ```tsx
  const [cameraSupported, setCameraSupported] = useState<boolean | null>(null);

  useEffect(() => {
    if (connectionStatus !== RaftConnEvent.CONN_CONNECTED) { setCameraSupported(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await connManager.getConnector().sendRICRESTMsg('camera?action=status', {}) as any;
        if (!cancelled) setCameraSupported(r?.rslt === 'ok' && r?.ready === true);
      } catch { if (!cancelled) setCameraSupported(false); }
    })();
    return () => { cancelled = true; };
  }, [connectionStatus]);
  ```

  ```tsx
  {cameraSupported && <CameraPanel />}
  ```

- **Optional**: if live preview is implemented, the cleanest home for the `Camera` subscription is
  a system type (e.g. extend `SystemTypeGeneric` or add a product-specific type) so the topic is
  subscribed alongside `devbin` and routed through `rxOtherMsgType`, instead of the panel managing
  a raw subscription. The panel then only reads decoded frames.

### Styling

Reuse the existing dashboard CSS classes — wrap the panel in `info-box`, use `action-button` for
controls, `info`/`info-line`/`info-label`/`info-value` for the status read-out, and the same
file-row layout as `LogFilesPanel` for the gallery. Add only a couple of new rules to
`styles.css`:

```css
.camera-image { max-width: 100%; border-radius: 8px; background: #000; }
.camera-image-container { display: flex; justify-content: center; }
```

## Implementation checklist

1. `CameraPanel.tsx`: status read-out + Settings (size/quality) via `camera?action=set`.
2. Still capture (`camera?action=capture`) → download (`fsGetContents`) → `<img>` blob view.
3. Gallery: `filelist/local/images`, per-file view/download/delete (`filedelete/local/images/<file>`).
4. `Main.tsx`: `camera?action=status` capability probe + conditional `<CameraPanel />`.
5. (Optional) Live preview: subscribe to `Camera` topic, decode the 19-byte-header JPEG frames,
   render at N fps; unsubscribe on stop/unmount.
6. (Optional) Capture-loop video fallback.
7. `styles.css`: minimal camera image rules.

## Open questions / things to confirm on hardware

- Whether camera publish frames arrive with the devbin topic envelope (affects the Layer 2 decode
  offset and `topicName` matching).
- Practical frame size/quality/rate over BLE vs WebSocket (BLE throughput will bound any "video").
- Whether the dashboard's single `setConnectionEventListener` slot needs to be shared, or whether
  the subscription should live in a system type.
- File-system capacity / rotation policy for `imageDir` when capturing many stills.
