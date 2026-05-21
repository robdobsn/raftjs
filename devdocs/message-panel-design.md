# Dashboard Message Panel — Cog-to-Cog IR Comms

## Purpose

Add a **Message Panel** to the RaftJS example dashboard so a developer can exercise the
cog-to-cog IR communications feature described in the Cog firmware design document
(`RoboticalCogFW/devdocs/cog-to-cog-ir-comms-design.md`).

The panel sits alongside the existing Command Panel and provides:

- A text box to enter an ASCII message.
- A drop-down list of destinations to send the message to. Initially the only entry is the
  IR channel of a Cog (side 2, the validated comms axis).
- A button to send the message.
- A scrolling log of messages received over the same IR channel by the connected device.

**No code has been changed yet.** This document records the investigation and describes the
work required to implement the panel.

## Background

### How the firmware exposes IR comms

The Cog firmware feature is implemented by the `CogIRComms` SysMod and exposed through the
standard RaftCore REST endpoint mechanism, so the same endpoints work over BLE RICREST,
WebSocket, and serial. The relevant endpoints (from the firmware design doc, "Useful REST
commands" and the 2026-05-15 validation section) are:

| Endpoint | Purpose |
| --- | --- |
| `ircomms/status` | Returns state plus rx/tx counters and config. Use it to confirm the feature is built/enabled. |
| `ircomms/tx?side=2&type=<0-15>&seq=<0-15>&payload=<0-255>` | Send a tiny diagnostic packet (single payload byte). |
| `ircomms/send?side=2&type=<0-15>&seq=<0-15>&hex=<even-length hex, up to 160 chars>` | Send a framed datagram with an arbitrary payload (up to 80 bytes). **This is the endpoint the Message Panel should use.** |
| `ircomms/rx?pop=1` | Pop the oldest received tiny packet. |
| `ircomms/rx?popFrame=1` | Pop the oldest received framed datagram. |
| `ircomms/rx?clear=1` | Clear the receive queue. |
| `ircomms/cfg?frameMarkUs=<us>&frameSpaceUs=<us>` | Runtime frame-timing tweak (not needed for v1). |

The framed payload is the right fit for an ASCII message: `frameMaxPayloadBytes` is 80, i.e.
160 hex characters, validated on hardware up to 48 bytes with overhead headroom.

Side 2 (`IRTX2`/`IRRX2`, mux channel 2) is the only validated bidirectional axis; side 1 did
not couple in the tested orientations. The destination drop-down should therefore default to
side 2.

### How the firmware notifies of received messages

When `rxReportEnable` is true (it is in the default `Cog1` systype config), each CRC-valid
received message also produces a **RICREST report frame** sent through `SysManager`. For the
tiny-packet diagnostic the report looks like:

```json
{"msgType":"ircomms","msgName":"rx","rxMs":11134,"type":7,"seq":8,"payload":55,"crc":55883}
```

The firmware design doc's "Receive Notification Recommendation" section proposes a richer
report for framed messages with `source`, `type`, and a `payload` field. The exact shape of
the report emitted for **framed** `ircomms/send` datagrams is not pinned down in the firmware
doc — see [Open questions](#open-questions-firmware-coordination).

### How RaftJS sends and receives

The dashboard talks to one device at a time through a single `RaftConnector` instance
(`ConnManager.getInstance().getConnector()`).

**Sending** — `CommandPanel.tsx` already shows the pattern:

```ts
connManager.getConnector().sendRICRESTMsg(commandName, params)
```

`sendRICRESTMsg(commandName, params)` (in `src/RaftConnector.ts:412`) builds a query string
from `params`, URL-encodes each value, appends it to `commandName`, sends it as a RICREST URL
message, and resolves to the parsed JSON response (typed `RaftOKFail`, but the full JSON of
the device response is returned). So a framed send is simply:

```ts
const resp = await connManager.getConnector().sendRICRESTMsg('ircomms/send', {
  side: 2, type: 1, seq: seqNo, hex: asciiToHex(messageText),
});
// resp e.g. { rslt: "ok", seq: 42, queued: 1 }
```

Polling the receive queue uses the same call:

```ts
const resp = await connManager.getConnector().sendRICRESTMsg('ircomms/rx', { popFrame: 1 });
```

**Receiving reports** — `RaftMsgHandler` decodes `MSG_TYPE_REPORT` frames, parses the JSON,
and dispatches it to every callback registered via `reportMsgCallbacksSet`
(`src/RaftMsgHandler.ts:144`). The connector exposes the handler publicly:

```ts
const handler = connManager.getConnector().getRaftMsgHandler();   // RaftConnector.ts:220
handler.reportMsgCallbacksSet('messagePanel', async (report) => { ... });
// on unmount:
handler.reportMsgCallbacksDelete('messagePanel');
```

The callback receives a `RaftReportMsg` object (exported from `src/main.ts` via
`export * from './RaftTypes'`). Note `RaftReportMsg` only declares a fixed set of fields;
the `ircomms` report carries extra fields (`type`, `seq`, `payload`, `crc`, `rxMs`, …) that
must be read by extending/casting the type.

The connector already registers an internal `"eventHandler"` report callback for `sysevent`
shutdown handling — adding a second `"messagePanel"` callback is independent and supported.

## Proposed design

### New component: `MessagePanel.tsx`

Add `examples/dashboard/src/MessagePanel.tsx`, structured like `CommandPanel.tsx`:

- A two-column `info-box` (reuse the existing `info-boxes` / `info-box` / `info-columns`
  layout classes).
- **Left column** — message composer: ASCII text input, destination `<select>`, Send button.
- **Right column** — received-message log: a scrollable list, newest last (or newest first),
  with a Clear button.

Suggested layout:

```text
+-------------------------- Message Panel ---------------------------+
| Compose                          | Received (IR side 2)           |
| [ Enter ASCII message_________ ]  | 12:01:03  src? "hello"         |
| Destination: [ Cog IR side 2 v ]  | 12:01:09  src? "ping back"     |
| [   Send Message   ]              | ...                            |
| status: queued seq 42             | [ Clear log ]                  |
+--------------------------------------------------------------------+
```

### Destination drop-down (data-driven)

Make the destination list a small array so future destinations are easy to add:

```ts
interface IRDestination {
  label: string;        // shown in the drop-down
  endpoint: string;     // e.g. 'ircomms/send'
  baseParams: object;   // e.g. { side: 2, type: 1 }
}

const destinations: IRDestination[] = [
  { label: 'Cog IR (side 2)', endpoint: 'ircomms/send', baseParams: { side: 2, type: 1 } },
];
```

The `seq` and `hex` parameters are added per-send. Future entries could target side 1, the
tiny-packet `ircomms/tx` endpoint, or other transports without changing the panel logic.

### Send path

1. Read the ASCII text from the input.
2. Validate: non-empty, and ≤ 80 characters (160 hex chars — the `ircomms/send` limit). Show
   an inline error otherwise.
3. Convert ASCII → hex (see [helpers](#asciihex-helpers)).
4. Maintain a rolling `seq` counter. The validated diagnostic commands use `seq` in the
   `0-15` range, so wrap with `seq = (seq + 1) & 0x0f`.
5. Call `sendRICRESTMsg(dest.endpoint, { ...dest.baseParams, seq, hex })`.
6. Show the result (`resp.rslt`, `resp.seq`, `resp.queued`) as a small status line, and warn
   on `rslt !== 'ok'`. Keep a local sent-message history (optional, mirrors CommandPanel's
   command history / arrow-key recall).

### Receive path

The connected device receives IR messages from *another* Cog automatically via its wake-probe
path and queues them. The dashboard surfaces them in the log. Two mechanisms are available:

**A. Polling `ircomms/rx?popFrame=1` (recommended primary mechanism for v1).**

- On a timer (e.g. every 750 ms) while connected, call `sendRICRESTMsg('ircomms/rx', { popFrame: 1 })`.
- If the response contains a frame, decode its payload hex → ASCII and append a log entry,
  then poll again immediately to drain the queue; stop when empty.
- This reliably returns the full payload regardless of report-frame shape, which is why it is
  preferred for the first implementation.

**B. Report subscription (low-latency enhancement).**

- Register a `messagePanel` report callback and filter for
  `report.msgType?.toLowerCase() === 'ircomms' && report.msgName?.toLowerCase() === 'rx'`.
- Use it either to display the message directly (if the report includes the payload) or
  simply to trigger an immediate drain of `ircomms/rx?popFrame=1` instead of waiting for the
  next poll tick.

**Recommendation:** implement (A) first for a working, reliable panel. Add (B) as a latency
improvement once the firmware report shape for framed messages is confirmed. Both can run
together — the report callback just triggers an early poll.

A "Clear log" button should clear the local log; optionally also call `ircomms/rx?clear=1` to
clear the device-side queue so stale messages are not re-polled.

### ASCII/hex helpers

`ConnManager` already has `hexStringToBytes()`. Two more small pure functions are needed —
put them in `MessagePanel.tsx` or a shared `examples/dashboard/src/utils.ts`:

```ts
// 'hi' -> '6869'
function asciiToHex(text: string): string {
  return Array.from(text, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

// '6869' -> 'hi'  (non-printable bytes shown as '.', or escaped)
function hexToAscii(hex: string): string {
  const out = (hex.match(/.{1,2}/g) ?? []).map(b => parseInt(b, 16));
  return out.map(c => (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.').join('');
}
```

Restrict the input to the ASCII printable range (0x20–0x7e) on send, or document that
non-ASCII characters are encoded as their lower byte only.

### CSS

Reuse `command-input` and `send-command-button` for the input and button. Add a few classes
to `examples/dashboard/src/styles.css` for the new elements, following the existing dark
theme (`#333`/`#444` backgrounds, `#666` borders):

- `.message-destination-select` — the drop-down.
- `.message-log` — scrollable container (`max-height`, `overflow-y: auto`).
- `.message-log-entry` — one received message (timestamp + text).
- `.message-status` — the send-result status line.

### Integration into `Main.tsx`

Render `<MessagePanel />` immediately after `<CommandPanel />` inside the
`connected-panel` block (`examples/dashboard/src/Main.tsx:178`). It only makes sense when
connected, which that block already guarantees.

Optionally gate the panel so it only appears for Cog devices: on mount, call
`ircomms/status` once and only enable the panel (or show a "not available on this device"
note) if it returns `rslt: "ok"`. This avoids a confusing dead panel when connected to a
Marty or generic device. For a first cut the panel can always render and simply report
failures from `sendRICRESTMsg`.

## Open questions / firmware coordination

These should be confirmed against the actual firmware build before or during implementation:

1. **Framed receive report shape.** The firmware doc shows the tiny-packet report
   (`payload` as a single number). It does not pin down the report emitted for framed
   `ircomms/send` datagrams. For mechanism (B) to display message text directly, the
   `ircomms`/`rx` report should include the payload as `payloadHex` (or an escaped ASCII
   string). If it does not, the panel must rely on polling (mechanism A). **Recommended
   firmware change:** include `payloadHex` and `len` in the framed-receive report.
2. **`ircomms/rx?popFrame=1` response fields.** Confirm the exact JSON field names returned
   (the firmware doc variously mentions `frameHex`, `payloadHex`, `rxnext`/`rxpeek`,
   `rx?popFrame`). The panel's decode step depends on the actual field name, and on what is
   returned when the queue is empty (`rslt: "ok"` with no frame vs `rslt: "fail"`).
3. **`text=` parameter.** Some diagnostic examples use `ircomms/send?...&text=hi` directly.
   If `text=` is reliably supported, the dashboard could skip hex conversion. The validated
   command list uses `hex=`, so `hex=` is the safer default.
4. **Device prerequisites.** The connected Cog must be running a build with `CogIRComms`
   compiled in and `CogIRComms.enable = 1` (and `rxReportEnable = 1` for mechanism B) in its
   systype config. The dashboard cannot set these — they are firmware build/config
   preconditions. Surface `ircomms/status` so the user can see whether the feature is live.
5. **Two devices needed for a real test.** The dashboard connects to one Cog. Sends leave
   that Cog over IR; the receive log shows what that Cog received over IR from a *second*
   Cog. A meaningful round-trip test needs two Cogs physically aligned on side 2, and
   typically two dashboard instances (one per Cog) — or the second Cog echoing messages.
6. **`seq` range.** The framed envelope carries a 1-byte sequence number, but the validated
   diagnostic commands constrain `seq` to `0-15`. Wrap the rolling counter at 16 unless
   firmware confirms the full byte range is accepted by `ircomms/send`.

## Implementation steps

1. Add `asciiToHex` / `hexToAscii` helpers (in `MessagePanel.tsx` or a shared util).
2. Create `examples/dashboard/src/MessagePanel.tsx`:
   - State: message text, selected destination, rolling `seq`, send-status, received log.
   - Send handler → `sendRICRESTMsg('ircomms/send', {...})`.
   - Receive: poll `ircomms/rx?popFrame=1` on an interval via `useEffect`/`setInterval`
     (clean up on unmount); decode hex payload → ASCII; append to log.
   - Optional: register/deregister a `messagePanel` report callback for low-latency
     notification.
3. Add the destination array (one entry: Cog IR side 2).
4. Add CSS classes to `styles.css`.
5. Wire `<MessagePanel />` into `Main.tsx` after `<CommandPanel />`.
6. (Optional) Gate the panel on an `ircomms/status` probe.

## Related: feature-gating panels on capability probes

The Message Panel will probe `ircomms/status` once on connect to decide whether to render
(see step 6 above). The same pattern should be applied to the existing **datalog** panels
(`LogConfigPanel`, `LoggingPanel`, `LogFilesPanel`), because some firmwares do not support
that API and the dashboard currently produces noisy console errors against them:

```text
_handleResponseMessages RICREST rslt fail msgNum 115
  resp {"req":"datalog?action=status","rslt":"fail","error":"failUnknownAPI"}
```

Proposed work (separate from but parallel to the Message Panel):

1. On (re)connect, issue a single `datalog?action=status` (or equivalent capability) call.
2. Cache the result as a "datalog supported" boolean on `ConnManager` or a small capability
   context, keyed off the current connection.
3. Conditionally render `LogConfigPanel` / `LoggingPanel` / `LogFilesPanel` and suppress any
   periodic datalog polling when the capability is absent.
4. Reset the cached capability on disconnect so reconnecting to a different device re-probes.

A small shared helper — e.g. `useFeatureSupported(probeApi: string): boolean | undefined` —
would let both the Message Panel and the datalog panels use the same gating pattern, and
keep `failUnknownAPI` errors out of the console for any feature that is not built into the
connected firmware.

## Testing

- **Single device, no peer:** connect to one Cog, send a message, confirm `sendRICRESTMsg`
  resolves with `rslt: "ok"` and the status line updates. The receive log stays empty.
- **Two devices:** align two Cogs side-2-to-side-2 (~10 mm gap, per the firmware validation
  setup). Connect a dashboard to each. Send from one and confirm the message appears in the
  other's receive log with the correct decoded ASCII text.
- **Round-trip:** send in both directions; confirm sequence numbers advance and no messages
  are dropped.
- **Edge cases:** empty message rejected; over-length message (>80 chars) rejected with a
  clear error; non-printable received bytes rendered safely; panel behaves correctly across
  disconnect/reconnect (timers and report callbacks cleaned up).
- **Regression:** confirm the existing Command Panel and other panels are unaffected by the
  added report callback and polling.
