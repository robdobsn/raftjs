# RaftJS dashboard real-Marty E2E tests

## Purpose

This opt-in suite runs the RaftJS example dashboard against a physical Marty.
The BLE scenarios drive the dashboard's visible WebBLE control, connect to the
real device, and exercise the RaftJS source in this repository.

These are **known-issue reproduction tests**. A scenario currently passes when
it proves that the corresponding defect is present. When a defect is fixed, its
assertions should be changed to validate the corrected behaviour.

The tests are excluded from normal unit-test and CI runs because they require
powered hardware, an interactive browser, and operating-system BLE access.

See [CURRENT_ISSUES.md](./CURRENT_ISSUES.md) for current findings and evidence.

## Location

Run all commands from:

```text
raftjs/examples/dashboard
```

The runner is:

```text
tests/e2e/raftjs-real-marty.e2e.mjs
```

## Requirements

- Node.js and npm.
- A powered Marty advertising over Bluetooth.
- The exact name displayed in Chrome's Bluetooth chooser.
- A headful Chrome or Chromium build with Web Bluetooth support.
- Bluetooth permission for the browser at the operating-system level.
- No other application actively connected to the same Marty.

The WebSocket scenario additionally requires Marty to be on the same network
and reachable by hostname, IP address, or complete WebSocket URL.

## Install dependencies

Let Puppeteer download a compatible Chrome build:

```sh
npm install
```

If a suitable browser is already installed and its executable path or remote
debugging address will be provided, the download can be skipped.

Shell:

```sh
PUPPETEER_SKIP_DOWNLOAD=1 npm install
```

PowerShell:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "1"
npm install
Remove-Item Env:PUPPETEER_SKIP_DOWNLOAD
```

## Browser selection

The runner uses this order:

1. Attach to `RAFT_DASHBOARD_E2E_BROWSER_URL`, when set.
2. On macOS, use `RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE`, or the default
   Bluetooth-enabled Chrome app described below.
3. On Windows and Linux, launch `RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE`, when
   set.
4. Otherwise, let Puppeteer launch its installed compatible Chrome.

The browser is always headful. The native chooser and operating-system BLE
stack are required.

### Windows

Chrome normally supports Web Bluetooth when Windows has a working Bluetooth
adapter and Chrome has permission. Select an installed browser in PowerShell:

```powershell
$env:RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE = `
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Adjust the path for Chrome for Testing, Chromium, or a per-user installation.

### Linux

Chrome/Chromium must have access to the system Bluetooth stack. Select a browser
when necessary:

```sh
export RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE=/usr/bin/google-chrome
```

The executable and any required BlueZ configuration depend on the distribution.

### macOS

macOS requires Bluetooth usage text in the application bundle. The runner
defaults to:

```text
~/Applications/Google Chrome for Testing BLE.app/Contents/MacOS/Google Chrome for Testing
```

Override it when necessary:

```sh
export RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE="/path/to/Chrome"
```

### Attach to an existing browser

Start Chrome with a dedicated profile and remote debugging enabled, then set:

```text
RAFT_DASHBOARD_E2E_BROWSER_URL=http://127.0.0.1:9222
```

When attached, the runner disconnects from Chrome at completion instead of
closing it. Use a dedicated test profile so saved BLE grants and ordinary
browsing sessions do not interfere.

## Run the default BLE suite

These examples use a Marty named `_B6`. Replace it with the exact name of the
device under test.

Shell:

```sh
RAFT_DASHBOARD_E2E_MARTY_NAME='_B6' npm run test:e2e:real-marty
```

Windows PowerShell:

```powershell
$env:RAFT_DASHBOARD_E2E_MARTY_NAME = "_B6"
npm run test:e2e:real-marty
Remove-Item Env:RAFT_DASHBOARD_E2E_MARTY_NAME
```

The default suite runs in this order:

1. `marty-ble-write-size`
2. `marty-connect-disconnect-race`
3. `marty-reconnect-disconnect-race`
4. `marty-subscribe-failure-resolved`

The first BLE scenario opens the native chooser. Later scenarios reuse the same
browser-granted `BluetoothDevice`, avoiding repeated chooser discovery problems
while still reconnecting through the dashboard's real WebBLE path.

## Run selected scenarios

Set `RAFT_DASHBOARD_E2E_SCENARIOS` to a comma-separated list.

Shell:

```sh
RAFT_DASHBOARD_E2E_MARTY_NAME='_B6' \
RAFT_DASHBOARD_E2E_SCENARIOS='marty-connect-disconnect-race' \
npm run test:e2e:real-marty
```

PowerShell:

```powershell
$env:RAFT_DASHBOARD_E2E_MARTY_NAME = "_B6"
$env:RAFT_DASHBOARD_E2E_SCENARIOS = `
  "marty-reconnect-disconnect-race,marty-subscribe-failure-resolved"
npm run test:e2e:real-marty
Remove-Item Env:RAFT_DASHBOARD_E2E_MARTY_NAME
Remove-Item Env:RAFT_DASHBOARD_E2E_SCENARIOS
```

Available scenarios:

- `marty-ble-write-size`
- `marty-connect-disconnect-race`
- `marty-reconnect-disconnect-race`
- `marty-subscribe-failure-resolved`
- `marty-websocket-stale-close`

## Run the Wi-Fi/WebSocket scenario

This scenario is excluded from the default suite. Supply a reachable Marty
hostname, IP address, or complete WebSocket URL.

Shell:

```sh
RAFT_DASHBOARD_E2E_WIFI_LOCATOR='Marty.local' \
RAFT_DASHBOARD_E2E_SCENARIOS='marty-websocket-stale-close' \
npm run test:e2e:real-marty
```

PowerShell:

```powershell
$env:RAFT_DASHBOARD_E2E_WIFI_LOCATOR = "Marty.local"
$env:RAFT_DASHBOARD_E2E_SCENARIOS = "marty-websocket-stale-close"
npm run test:e2e:real-marty
Remove-Item Env:RAFT_DASHBOARD_E2E_WIFI_LOCATOR
Remove-Item Env:RAFT_DASHBOARD_E2E_SCENARIOS
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `RAFT_DASHBOARD_E2E_MARTY_NAME` | Exact BLE chooser name | Required for BLE scenarios |
| `RAFT_DASHBOARD_E2E_SCENARIOS` | Comma-separated scenario names | Four BLE scenarios |
| `RAFT_DASHBOARD_E2E_WIFI_LOCATOR` | Marty Wi-Fi hostname, IP, or WebSocket URL | Required for WebSocket scenario |
| `RAFT_DASHBOARD_E2E_BROWSER_EXECUTABLE` | Chrome/Chromium executable | Platform-dependent |
| `RAFT_DASHBOARD_E2E_BROWSER_URL` | Existing remote-debugging browser | Not set |
| `RAFT_DASHBOARD_E2E_BASE_URL` | Already-running dashboard | Runner starts Parcel |
| `RAFT_DASHBOARD_E2E_DEVICE_TIMEOUT_MS` | BLE chooser discovery timeout | `60000` |
| `RAFT_DASHBOARD_E2E_CONNECT_TIMEOUT_MS` | Connection/scenario timeout | `90000` |
| `RAFT_DASHBOARD_E2E_SERVER_TIMEOUT_MS` | Dashboard startup timeout | `120000` |
| `RAFT_DASHBOARD_E2E_OUTPUT` | Report output directory | Timestamped `e2e-results` folder |

## Output and reports

The console prints each scenario, reproduction result, and final summary:

```text
[scenario] marty-connect-disconnect-race
[reproduced] TypeError: Cannot read properties of null ...
[pass] marty-connect-disconnect-race
[summary] 4 passed, 0 failed
```

Each run writes:

```text
examples/dashboard/e2e-results/<timestamp>/report.json
```

The report records repository provenance, selected scenarios, device selection,
connection events and timings, observed BLE configuration, console messages,
page errors, and pass/fail status. `e2e-results` is ignored by Git.

## Interpreting results

These tests presently assert known broken behaviour:

- **Pass:** the documented issue was reproduced.
- **Fail before connection:** usually a browser, permission, advertising, or
  hardware-availability problem.
- **Fail after connection:** the behaviour may have changed, or the timing gate
  did not reach the expected lifecycle point. Inspect `report.json` before
  deciding whether this is a regression or a fix.

After fixing an issue, update that scenario so it asserts the desired behaviour
and fails if the defect returns.

## Troubleshooting

### Marty does not appear

- Confirm Marty is powered and advertising.
- Confirm the configured name exactly matches the chooser.
- Disconnect Marty from other browsers and applications.
- Close stale test-browser instances and retry with a fresh dedicated profile.
- Power-cycle Marty and wait several seconds before retrying.
- Increase `RAFT_DASHBOARD_E2E_DEVICE_TIMEOUT_MS` if discovery is slow.

Avoid terminating every Chrome process on a shared workstation. Close only the
dedicated test browser/profile.

### Browser opens but Web Bluetooth is unavailable

- Confirm the browser is running headfully.
- Check OS Bluetooth permission for that browser.
- Confirm Chrome/Chromium was built with Web Bluetooth support.
- On macOS, check the app bundle has a Bluetooth usage description.
- On Linux, confirm the browser can access BlueZ and the Bluetooth adapter.

### Dashboard does not start

Run `npm install` from `examples/dashboard`. Alternatively, start the dashboard
yourself and supply `RAFT_DASHBOARD_E2E_BASE_URL`.

### A later scenario cannot reconnect

The suite reuses the browser's granted physical device. If Marty remains
unavailable after a disruptive scenario, close the dedicated test browser,
power-cycle Marty, and run the failed scenario alone.
