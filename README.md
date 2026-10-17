# raftjs is a typescript/javascript library to support the Raft ESP32 app framework

## Install

```bash
$ npm install @robdobsn/raftjs
```

## Usage

See the dashboard example in the examples folder

to install dependencies: npm install --legacy-peer-deps 

## Connecting

```ts
const connector = new RaftConnector(async (systemUtils) => {
  // Called once the channel is connected - choose a system type from the device's info
  const systemInfo = await systemUtils.getSystemInfo();
  return sysTypeManager.createSystemType(systemInfo.SystemName) || sysTypeManager.createDefaultSystemType();
});
connector.setEventListener((eventType, eventEnum, eventName, data) => { /* see below */ });
await connector.initializeChannel("WebSocket");   // or "WebBLE", "PhoneBLE", "WebSerial", "Simulated"
const connected = await connector.connect("192.168.1.42");
```

`connect()` resolves `false` (and emits `CONN_CONNECTION_FAILED`) if the connection cannot be
made - an application should report this rather than ignore the returned promise.

### WebSocket endpoint

| Locator passed to `connect()` | URL used |
|---|---|
| bare host or IP, e.g. `192.168.1.42` or `axiom.local` | `ws://<host>/ws` |
| complete URL, e.g. `ws://192.168.1.42/ws` or `wss://host/path` | used exactly as given |

The endpoint must be a **RICSerial (binary)** WebSocket - the `"pcol": "RICSerial"` entry in the
firmware's `WebServer.websockets` configuration, which is `ws` in the standard Raft SysTypes.
raftjs frames every message as binary HDLC and ignores text frames, so it cannot use a
RICJSON text WebSocket (`devjson` etc).

The system type, and so its `connectorOptions`, is only resolved *after* the channel is connected.
`connectorOptions.wsSuffix` therefore cannot select the endpoint for a bare-host locator: pass a
complete URL if the firmware serves RICSerial on a path other than `/ws`. Each `connect()` starts
without a system type, and the URL that connected is reused for automatic retries, so the first
connect, later connects and retries all use the same endpoint.

### Connection events

Events arrive on the listener with `eventType === "conn"` and a `RaftConnEvent`:

| Event | Meaning |
|---|---|
| `CONN_CONNECTING` | `connect()` has started |
| `CONN_CONNECTED` | channel up, system type resolved, subscriptions made |
| `CONN_CONNECTION_FAILED` | `connect()` could not connect |
| `CONN_ISSUE_DETECTED` | an established connection was lost - retrying |
| `CONN_ISSUE_RESOLVED` | the retry restored the connection and its subscriptions |
| `CONN_RECOVERY_DEGRADED` | the retry restored the transport but not the subscriptions |
| `CONN_DISCONNECTED` | disconnected (explicitly, or the retry window expired) |

An explicit `disconnect()` reports `CONN_DISCONNECTED` before its promise resolves, so it is safe
to start a new `connect()` as soon as it has.

Retry after a lost connection is enabled by default and is controlled with
`connector.setRetryConnectionIfLost(enable, retryForSecs)`. A retry re-establishes the channel,
the publish subscriptions and the device time - it does not repeat system type setup.

## WiFi scanning

`RaftSystemUtils.wifiScan()` starts a scan on the device, polls until the results are available and
returns them. It works with firmware that reports scan status and with older firmware that does not.

```ts
const outcome = await connector.getRaftSystemUtils().wifiScan({
  resumeWifiIfPaused: true,      // WiFi may be paused while BLE is connected
  onProgress: (p) => console.log(p.elapsedMs, p.scan, p.prevScanWifi.length),
});
if (outcome.ok) outcome.wifi.forEach((ap) => console.log(ap.ssid, ap.rssi, ap.ch1, ap.auth));
else console.warn(outcome.error);
```

Over a WiFi connection the device is generally unresponsive while it scans, so progress callbacks
may not arrive and the results appear when the scan ends. See `RaftWifiScanOptions` and
`RaftWifiScanOutcome` in `src/RaftTypes.ts`, and `WifiScanPanel.tsx` in the dashboard example.

## Devices

`connector.getSystemType()?.deviceMgrIF` / `DeviceManager` keeps the state of every device the firmware publishes
(`getDevicesState()`), decoded from `devbin` or `devjson`. To show a device, use `DeviceState.displayName`. Use
`deviceTypeKey` to tell types apart, and `busNum` for the bus. `DeviceTypeInfo.name`, `DeviceState.deviceType` and
`busName` are deprecated (see [devdocs/device-identity-fields.md](devdocs/device-identity-fields.md)).

Wrappers for the firmware's device management endpoints (each returns the firmware's response):

```ts
const devMan = connector.getSystemType()?.deviceMgrIF as RaftDeviceManager;
await devMan.listDevices();                          // deviceid, name, displayName, role, dtIdx
await devMan.setDeviceName("1_68", "Arm IMU", true); // save=true keeps it over a restart
await devMan.setDevicePolling("1_68", false);        // stop polling (the device stays identified)
await devMan.reInitDevice("1_68");                   // run its initialisation again
await devMan.getIdentInfo("1_68");                   // identification state and candidates
await devMan.reIdentify({ unidentified: true });     // or { all }, { deviceKey }, { type }
await devMan.setTypePolicy("APDS9960", "disabled");  // save=true also writes the device type file
await devMan.getDeviceTypes(0, 50);                  // the device type table
await devMan.getTypeFileStatus(true);                // restartRequired after a type file change; entries
await devMan.checkTypeFile("/local/devlib.new.json"); // what an uploaded type file would do, per entry
await devMan.applyTypeFile("/local/devlib.new.json"); // check, use it as the type file and restart
```

`addDeviceNameChangedCallback()` reports when a device's name or display name changes.

## Testing

| What | How |
|---|---|
| Unit tests | `npx jest` |
| Lint / build | `npm run lint`, `npm run build` |
| Hardware tools over WiFi (connect/reconnect, WiFi scan, device observation) | [tests/e2e/README.md](tests/e2e/README.md) |
| Dashboard browser tests against a real Marty | [examples/dashboard/tests/e2e/README.md](examples/dashboard/tests/e2e/README.md) |

Design notes are in [devdocs](devdocs).
