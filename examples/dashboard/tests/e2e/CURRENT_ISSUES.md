# Current RaftJS 2.2.0 connection issues

## Scope and baseline

This document records issues observed while reviewing and testing RaftJS
`2.2.0`, corresponding to tag `v2.2.0` and commit `aa12055` on `main`.

Evidence labels:

- **Real hardware reproduced:** reproduced through the RaftJS dashboard and a
  physical Marty over Web Bluetooth.
- **Automated fault reproduced:** a real hardware connection combined with a
  deterministic timing gate or injected failure at the relevant asynchronous
  boundary.
- **Code/isolated reproduced:** established through source review and an
  isolated regression probe, but not yet run against Marty over Wi-Fi.
- **Potential gap:** source-level concern requiring a defined product
  expectation and dedicated validation.

The current E2E scenarios are known-issue reproductions. They pass when the
broken behaviour is observed. Their assertions must be inverted after fixes are
implemented.

## 1. Dashboard classifies Marty as Generic and applies 244-byte BLE writes

- **Status:** Fixed (validated on real hardware)
- **Evidence:** Real hardware validated
- **Scenario:** `marty-ble-write-size` (assertions inverted to validate the fix)

### Observed behaviour

Marty returns `SystemName: "RIC"`. The dashboard registers its dedicated Marty
system type under `"Marty"`, not `"RIC"`, so lookup falls back to
`Generic System`.

The generic dashboard type configures `bleMaxWriteSize: 244`, while the
dashboard's dedicated Marty type configures 182. The live Marty connection
therefore uses 244-byte BLE writes.

### Impact

- Marty-specific setup and state handling can be bypassed.
- Marty receives the generic BLE write-size configuration.
- Large transfers may use a write size incompatible with the intended
  conservative Marty limit.

### Likely correction

Register the Marty implementation for the firmware-reported `RIC` name, or
normalize `RIC` to the Marty system type before selecting connector options.

### Resolution

`ConnManager` now registers `SystemTypeMarty` under the firmware-reported `RIC`
name as well as `Marty`, so Marty resolves to its dedicated system type. The
`bleMaxWriteSize` value (182) moved into `capabilities.tuning` and is applied on
connect. Validated on a physical Marty: `SystemName RIC` -> `Robotical Marty`
with a 182-byte effective BLE write size.

## 2. Initial `connect()` continues after explicit disconnect

- **Status:** Fixed (validated on real hardware)
- **Evidence:** Real hardware with deterministic timing gate
- **Scenario:** `marty-connect-disconnect-race` (assertions inverted to validate the fix)

### Observed behaviour

The dashboard connects to the real Marty and pauses immediately after the
system-information request returns. An explicit disconnect completes and clears
the connector's active channel. When the original `connect()` continuation is
released, it continues using `this._raftChannel` and throws:

```text
TypeError: Cannot read properties of null (reading 'requiresSubscription')
```

Depending on the exact point reached, another access such as
`fhFileBlockSize()` could fail instead.

### Cause

`RaftConnector.connect()` does not capture and validate connection ownership or
a connection generation across its awaited stages. `disconnect()` can set
`_raftChannel` to `null` while the older `connect()` operation remains live.

### Impact

- Rejected or unhandled connection promises.
- Late connection work after cancellation or disconnect.
- Risk of stale work acting on a replacement channel if another connection is
  initialized before the older continuation completes.

### Required behaviour

Explicit disconnect must invalidate the pending connection generation. Every
post-await stage of `connect()` should stop quietly when it no longer owns the
active connection and channel.

### Resolution

`RaftConnector.connect()` now pins the channel and retry generation at entry
(`stillOwner()`) and re-checks after every awaited stage (channel connect,
system-type resolution, capability resolution, subscription, time sync),
returning `false` quietly when ownership was lost. This also gates the
`CONN_CONNECTED` emit so a disconnected connection is never reported connected.
Validated on a physical Marty: the gated `connect()` resolved (no `TypeError`)
and the connector remained cleanly disconnected.

## 3. Reconnect emits `ISSUE_RESOLVED` after explicit disconnect begins

- **Status:** Fixed (validated on real hardware)
- **Evidence:** Real hardware with deterministic timing gate
- **Scenario:** `marty-reconnect-disconnect-race` (assertions inverted to validate the fix)

### Observed behaviour

The test creates a real GATT loss, allows RaftJS to reconnect, and pauses while
subscriptions are being re-established. The dashboard's real Disconnect button
then starts teardown and removes the active channel. After the reconnect gate is
released, the older retry operation emits:

```text
ISSUE_DETECTED
ISSUE_RESOLVED
DISCONNECTED
```

In one verified dashboard run, `ISSUE_RESOLVED` occurred more than ten seconds
after explicit disconnect began.

### Cause

The retry loop checks its generation before reconnect restoration. After
`await _reestablishAfterReconnect()`, however, it emits
`CONN_ISSUE_RESOLVED` without revalidating the retry generation, active channel,
or terminal disconnect state.

### Impact

- The UI can report recovery after the user requested disconnect.
- Consumers can temporarily mark a disconnecting connection as connected.
- Lifecycle events arrive in a contradictory order.

### Required behaviour

After every awaited reconnect-restoration step, revalidate the retry generation
and channel ownership before changing state or emitting `ISSUE_RESOLVED`.

### Resolution

The retry loop captures the post-reconnect generation and, after awaiting
`_reestablishAfterReconnect()`, revalidates the generation, channel presence and
connected state before emitting any recovery event; if an explicit disconnect
(or a newer connect) intervened it returns silently. Validated on a physical
Marty: no recovery events after disconnect began and the connector remained
disconnected.

## 4. Subscription restoration failure still reports recovery

- **Status:** Fixed (validated on real hardware)
- **Evidence:** Real hardware with injected reconnect failure
- **Scenario:** `marty-subscribe-failure-resolved` (assertions inverted to validate the fix)

### Observed behaviour

After a real GATT loss and reconnect, the test makes the reconnect subscription
operation reject. RaftJS catches the error, keeps the transport marked
connected, and emits `ISSUE_RESOLVED`.

Dashboard and Robotical system-type implementations also catch subscription
errors internally, so failures may be hidden before RaftConnector can respond.

### Impact

- The application can clear its reconnect warning while telemetry subscriptions
  remain absent.
- Commands may work while live state, sensor, or status updates remain frozen.
- Consumers receive no structured indication of partial recovery.

### Required behaviour

Subscription restoration should return a meaningful result or propagate
failure. RaftConnector should emit `ISSUE_RESOLVED` only after required session
state is restored, or emit a distinct degraded-recovery event.

### Resolution

`_reestablishAfterReconnect()` now returns success/failure. On failure the
connector emits a new `CONN_RECOVERY_DEGRADED` event (name `RECOVERY_DEGRADED`)
instead of `ISSUE_RESOLVED`; the transport stays connected. The event was
appended at the end of `RaftConnEvent` so existing numeric values do not shift.
**Consumer note:** apps that treat `ISSUE_RESOLVED` as full recovery should also
handle `RECOVERY_DEGRADED` (e.g. retry subscriptions, warn, or disconnect).
Validated on a physical Marty with an injected subscription failure.

## 5. An obsolete WebSocket can clear a newer socket's state

- **Status:** Fixed (validated on real hardware over Wi-Fi)
- **Evidence:** Real hardware validated
- **Scenario:** `marty-websocket-stale-close` (assertions inverted to validate the fix)

### Observed behaviour

`RaftChannelWebSocket._wsConnect()` assigns `_webSocket = null` before checking
whether an existing socket should be closed. The close-existing-socket block is
therefore unreachable.

Each socket's `onclose` handler also clears the shared `_webSocket`,
`_isConnected`, and locator state without confirming that the closing socket is
still the active owner. A late close from an older socket can therefore erase a
newer live connection.

### Impact

- Leaked or overlapping WebSocket connections.
- A live replacement socket can be reported as disconnected.
- Reconnect and disconnect events can refer to stale socket ownership.

### Required behaviour

Capture the existing socket before replacement, close it deliberately, and add
socket identity or generation checks to every asynchronous open/close handler.

### Resolution

`_wsConnect()` now captures the existing socket before nulling the shared
field, detaches its handlers, and closes it deliberately. `onmessage`/`onclose`
carry a socket-identity check so an obsolete socket's late close cannot clear
the replacement socket's state or emit a spurious `CONN_DISCONNECTED`. Connected
state is assigned only when a socket takes ownership in `_wsConnect`, not in
`onopen`. Validated against a physical Marty over Wi-Fi: the stale close was
ignored and the replacement socket stayed connected.

## 6. Consumer BLE write-size configuration remains inconsistent

- **Status:** Consumer integration gap
- **Evidence:** Source review and live consumer observations

RaftJS 2.2.0 supports `connectorOptions.bleMaxWriteSize`, but each system type
must opt into the correct value.

- The RaftJS dashboard declares Marty as 182 and Cog/Generic as 244, although
  issue 1 prevents the Marty declaration from being selected when firmware
  reports `RIC`.
- RoboticalJS Marty and Cog system types inspected during the marty-web-app
  review did not declare `bleMaxWriteSize`; both retained RaftJS's 182-byte
  WebBLE default.

RaftJS support alone therefore does not guarantee the intended per-device
configuration. Each consumer must register the correct system type and value.

## 7. Reconnect restores subscriptions but not all connect-time session state

- **Status:** Implemented (datetime replay on reconnect)
- **Evidence:** Source review; exercised by the reconnect e2e scenarios

The channel-only reconnect path calls `_reestablishAfterReconnect()`, which
restores publish subscriptions. It did not repeat other connect-time session
setup such as optional device date/time synchronization.

### Resolution

The reconnect contract now replays the device time sync:
`_reestablishAfterReconnect()` re-sends `datetime` (best-effort) after
re-subscribing, gated on the same `syncTimeOnConnect` option and capability
check as the connect-time sync - covering the case where the transport loss was
a device reboot that cleared the device clock. Other connect-time setup
(system-type `setup()`, capability resolution) is intentionally not repeated on
a channel-only reconnect.

## 8. Second WebSocket connect and every retry use a different endpoint from the first connect

- **Status:** Fixed (validated on real hardware over Wi-Fi)
- **Evidence:** Real hardware reproduced (dashboard and a physical Axiom); real hardware validated
- **Scenario:** `tests/e2e/ws-reconnect.mjs` in the RaftJS root (Node, no browser), plus
  `RaftConnector WebSocket endpoint selection` in `src/RaftConnector.test.ts`

### Observed behaviour

Connect over WebSocket, disconnect, then connect again: the second connect fails at once
(`WebSocket connection to 'ws://<host>/wsjson' failed`, close code 1006) and the dashboard shows
nothing at all. A third attempt succeeds, and the pattern alternates.

### Cause

`connect()` resolves the system type only after the channel is up, so the first connect passes
empty `connectorOptions` and `RaftChannelWebSocket` falls back to the `ws` suffix. `disconnect()`
left `_systemType` set, so the next `connect()` - and every `_retryConnectionLoop()` attempt after
a lost link - passed the previous session's options. The dashboard's Generic and Cog system types
declared `wsSuffix: "wsjson"`, a path the firmware does not serve (its WebSocket handler matches
the path exactly). The failure branch of `connect()` nulls `_systemType`, hence the alternation.

`wsjson` only ever existed in early Cog firmware, as a RICJSON *text* socket. raftjs frames every
message as binary RICSerial and ignores text frames, so it could not have used that endpoint even
where it was served.

### Impact

- An explicit reconnect silently fails every other attempt.
- Automatic retry after a real Wi-Fi drop can never succeed for a system type whose `wsSuffix`
  differs from `ws`; the retry window simply expires.
- The dashboard ignored `CONN_CONNECTION_FAILED` and discarded the `connect()` promise, so the
  user saw no sign that Connect had been pressed.

### Resolution

- `connect()` clears `_systemType` before connecting, so every explicit connect starts without a
  system type exactly as the first one does.
- After a successful WebSocket connect the connector pins the channel's resolved URL as its
  locator. A complete `ws://` URL is authoritative in `RaftChannelWebSocket.connect()`, so retries
  return to exactly the endpoint that connected whatever the system type declares.
- The dashboard system types and the `tests/e2e` scripts declare `wsSuffix: "ws"`; `wsjson` no
  longer appears in RaftJS. `ConnectorOptions.wsSuffix` documents that it cannot select the
  endpoint for a bare-host locator - pass a complete URL instead.
- The dashboard disables the Connect buttons and shows "Connecting…" during an attempt, reports a
  failed attempt, and shows "Connection lost - retrying…" / "Reconnected - updates not restored"
  for `CONN_ISSUE_DETECTED` / `CONN_RECOVERY_DEGRADED`.

Validated against a physical Axiom over Wi-Fi: three connect/disconnect cycles and a retry after a
dropped socket all connected to `ws://<host>/ws`. The two unit tests fail on the previous code.

## 9. An explicit WebSocket disconnect is reported late, against the next connection

- **Status:** Fixed (validated on real hardware over Wi-Fi)
- **Evidence:** Real hardware reproduced (found while validating issue 8); real hardware validated
- **Scenario:** `tests/e2e/ws-reconnect.mjs` (event-ordering checks), plus
  `src/RaftChannelWebSocket.test.ts`

### Observed behaviour

`RaftChannelWebSocket.disconnect()` called `close()` and returned, leaving the socket's `onclose`
handler attached and still the owner of the channel. The close event is asynchronous, so
`CONN_DISCONNECTED` was delivered some tens of milliseconds *after* `disconnect()` had resolved.
In back-to-back connect cycles it arrived inside the following `connect()`: the log shows
`_wsConnect - closed code 1000` and `RaftSystemUtils information invalidated` between the new
connect starting and its system info being read.

### Impact

- An application is told the connection it is currently establishing has disconnected.
- `RaftSystemUtils.invalidate()` and the system type's `stateIsInvalid()` run against the new
  session. Whether that discards freshly cached system info depends purely on timing.
- A person pressing Disconnect then Connect is far too slow to hit this; a script, a test or an
  application that reconnects programmatically is not.

Issue 5's ownership check did not cover it: that guards a socket *replaced* within one channel,
whereas here a new channel object is created and the old channel still owns its closing socket.

### Resolution

`disconnect()` now releases ownership (`_webSocket = null`) and detaches `onmessage` / `onclose`
before closing the socket, then emits `CONN_DISCONNECTED` itself before returning - as the
Simulated, WebSerial and native BLE channels already do. The late close event finds no handler.
A close that was not requested (link lost, device reboot) is unchanged and still drives the retry
path. `disconnect()` without an open socket reports nothing.

Validated against a physical Axiom over Wi-Fi: each connect saw only `CONNECTING, CONNECTED`, and
`DISCONNECTED` had been reported by the time `disconnect()` returned. The unit test for this fails
on the previous code.

## Current automated coverage

| Scenario | Transport | Hardware | Current result |
|---|---|---|---|
| `tests/e2e/ws-reconnect.mjs` (RaftJS root) - issues 8 and 9 | WebSocket | Physical Axiom (Wi-Fi) | Fixed - validated |
| `marty-ble-write-size` | WebBLE | Physical Marty | Fixed - validated |
| `marty-connect-disconnect-race` | WebBLE | Physical Marty | Fixed - validated |
| `marty-reconnect-disconnect-race` | WebBLE | Physical Marty | Fixed - validated |
| `marty-subscribe-failure-resolved` | WebBLE | Physical Marty | Fixed - validated |
| `marty-websocket-stale-close` | WebSocket | Physical Marty (Wi-Fi) | Fixed - validated |

## Verification baseline

After adding the E2E suite:

- RaftJS Jest: 8 suites and 111 tests passed.
- RaftJS ESLint passed.
- RaftJS web and React Native builds passed.
- Dashboard Parcel production build passed.
- Real-Marty default BLE E2E suite: 4 passed, 0 failed.

After the issue 8 and 9 fixes (2026-09-21, RaftJS 2.4.1 working tree):

- RaftJS Jest: 13 suites and 178 tests passed.
- RaftJS ESLint and web build passed.
- `tests/e2e/ws-reconnect.mjs` passed against a physical Axiom over Wi-Fi.
- The real-Marty browser suite was not re-run for this change.

The dashboard also has pre-existing direct `tsc --noEmit` errors in chart,
latency, settings, WebSocket typing, and platform-specific BLE module
resolution. Parcel builds successfully; none of those errors originate in the
E2E runner or dashboard E2E hook.
