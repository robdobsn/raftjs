# Web BLE Reconnect Recovery

Date: 2026-04-29

## Issue

The Axiom offline data logging UI can be refreshed while Web Bluetooth is still
connected. In that path the browser may report `gatt.connect()` success and then
disconnect during `getPrimaryService()`, producing an error like:

```text
GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.
```

Before this change, `RaftChannelBLE.web.ts` treated a failed primary-service
lookup as a terminal failure and returned `false` immediately. That meant a
transient reconnect race could fail the whole app-level connection attempt even
though the device was still running and still advertising.

The harsher path is a browser hard refresh while BLE is still connected. During
page unload, the normal app disconnect path cannot reliably complete because it
sends a graceful BLE command and waits asynchronously. If the page disappears
before that finishes, the browser can keep the GATT connection in a half-closed
state long enough for the next immediate reconnect to fail.

## Solution

`RaftChannelBLE.connect()` now keeps the existing connection retry loop active
for primary-service lookup failures:

- If no supported primary service is found and more connection attempts remain,
  it disconnects any still-open GATT connection.
- It waits briefly before retrying.
- It only returns `false` after the final service lookup attempt fails.

This preserves the previous final failure behavior while allowing transient
Web Bluetooth/GATT cleanup races to recover inside the raftjs channel.

`RaftConnector` also now exposes `disconnectForPageUnload()`. It is deliberately
smaller than the normal `disconnect()` path:

- It disables automatic lost-connection retry.
- It detaches the current channel from the connector immediately.
- It starts the channel-level GATT disconnect without waiting for the normal
  graceful BLE command sequence.

The Axiom app uses this from `beforeunload`/`pagehide` so a browser hard refresh
still starts Web Bluetooth cleanup before the page is replaced. Normal user
disconnects continue to use the existing graceful path.

## Validation

Validation was done from `Axiom-Experiment-App` against real Axiom hardware
(`Axiom009_adcf1e`) with firmware serial logs open on `/dev/cu.usbmodem2101`.

The diagnostic flow was:

1. Connect over Web Bluetooth.
2. Start Axiom offline data logging for LSM6DS at 1 Hz.
3. Hard-refresh the browser without issuing the app-level Disconnect command.
4. Immediately reconnect over Web Bluetooth.
5. Confirm the offline logger is still active and points to the same log file.
6. Stop the session and delete the generated e2e log.

The firmware logs showed no reboot or panic during the refresh/reconnect flow.
The logger stayed active across the browser refresh. The page-unload run showed
the Axiom app calling the immediate GATT disconnect path, the firmware observing
`BLE connection change isConn NO`, and reconnect reporting the same active log
with additional samples.
