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

- **Status:** Open
- **Evidence:** Real hardware reproduced
- **Scenario:** `marty-ble-write-size`

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

## 2. Initial `connect()` continues after explicit disconnect

- **Status:** Open
- **Evidence:** Real hardware with deterministic timing gate
- **Scenario:** `marty-connect-disconnect-race`

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

## 3. Reconnect emits `ISSUE_RESOLVED` after explicit disconnect begins

- **Status:** Open
- **Evidence:** Real hardware with deterministic timing gate
- **Scenario:** `marty-reconnect-disconnect-race`

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

## 4. Subscription restoration failure still reports recovery

- **Status:** Open
- **Evidence:** Real hardware with injected reconnect failure
- **Scenario:** `marty-subscribe-failure-resolved`

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

## 5. An obsolete WebSocket can clear a newer socket's state

- **Status:** Open; real Marty Wi-Fi verification pending
- **Evidence:** Code/isolated reproduced
- **Scenario:** `marty-websocket-stale-close`

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

### Verification still needed

Run `marty-websocket-stale-close` against a reachable Marty Wi-Fi locator.

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

- **Status:** Potential gap
- **Evidence:** Source review

The channel-only reconnect path calls `_reestablishAfterReconnect()`, which
currently restores publish subscriptions. It does not repeat other connect-time
session setup such as optional device date/time synchronization.

This may matter when transport loss was caused by a device reboot that also
cleared device-side session state. The expected reconnect contract should be
defined before deciding which setup operations need to be replayed.

## Current automated coverage

| Scenario | Transport | Hardware | Current result |
|---|---|---|---|
| `marty-ble-write-size` | WebBLE | Physical Marty | Reproduced |
| `marty-connect-disconnect-race` | WebBLE | Physical Marty | Reproduced |
| `marty-reconnect-disconnect-race` | WebBLE | Physical Marty | Reproduced |
| `marty-subscribe-failure-resolved` | WebBLE | Physical Marty | Reproduced |
| `marty-websocket-stale-close` | WebSocket | Reachable Marty required | Implemented, not run on hardware |

## Verification baseline

After adding the E2E suite:

- RaftJS Jest: 8 suites and 111 tests passed.
- RaftJS ESLint passed.
- RaftJS web and React Native builds passed.
- Dashboard Parcel production build passed.
- Real-Marty default BLE E2E suite: 4 passed, 0 failed.

The dashboard also has pre-existing direct `tsc --noEmit` errors in chart,
latency, settings, WebSocket typing, and platform-specific BLE module
resolution. Parcel builds successfully; none of those errors originate in the
E2E runner or dashboard E2E hook.
