# Hardware end-to-end tools

Scripts here talk to **real hardware over the network**. They are not run by jest — its
`testMatch` only picks up `*.test.*` / `*.spec.*` under `src/`, so nothing in this directory
runs in CI.

They connect exactly as the dashboard example does: a WebSocket to `ws://<host>/ws` (the
firmware's RICSerial endpoint), a `devbin` subscription, and the same `DeviceManager` decode
path. That matters — a bug found here is a bug a real client would hit.

All of them load the built library, so run `npm run build` first, and run them from the raftjs
directory.

| Script | Purpose | Result |
|---|---|---|
| `ws-reconnect.mjs` | connect / disconnect / connect cycles and automatic retry after a dropped socket | pass / fail |
| `wifi-scan.mjs` | run `RaftSystemUtils.wifiScan()` and print progress and results | pass / fail |
| `observe-devices.mjs` | print what the device publishes: per-device sample counts, values, raw records | observation only |
| `vcp-find-signal.mjs` | find which `RoboticalVCP` input a signal is on | observation only |

---

## `ws-reconnect.mjs`

Checks that a WebSocket connection can be **re-established**, which a single connect never
exercises:

1. `initializeChannel` → `connect` → read system info → `disconnect`, repeated `NUM_CYCLES`
   times, as pressing Connect / Disconnect in the dashboard does.
2. The socket is then closed underneath the connector to simulate a lost link. The connector
   must emit `CONN_ISSUE_DETECTED`, retry, emit `CONN_ISSUE_RESOLVED`, and answer a request over
   the restored connection.

Every connect and the retry must land on `ws://<host>/ws`. The cycles run back-to-back with no
pause, which also checks event ordering: `CONN_DISCONNECTED` must have been reported by the time
`disconnect()` returns, and a connect must see only `CONNECTING, CONNECTED` — the previous
socket's close event arrives during the next connect and must not be reported against it.

```
AXIOM=192.168.86.136 node tests/e2e/ws-reconnect.mjs
```

Exit code `0` if every check passed, `1` otherwise.

| Variable | Default | Purpose |
|---|---|---|
| `AXIOM` | 192.168.86.136 | host or IP of the device |
| `NUM_CYCLES` | 3 | number of explicit connect cycles |
| `RETRY_TIMEOUT_MS` | 20000 | how long to wait for the automatic retry to finish |

### Why the system type declares a suffix nothing serves

The script's system type sets `connectorOptions.wsSuffix` to a path no firmware serves. That is
deliberate. The system type is only resolved once the channel is up, so its options are unknown
for the first connect — and they must stay out of later connects and retries too. They once did
not: the type left over from the previous session was applied to the second connect, which went
to a different path from the first and failed, and every automatic retry failed the same way.
A script that connects once cannot see this, which is how these tools declared an unserved
suffix for months without noticing.

---

## `wifi-scan.mjs`

Runs `RaftSystemUtils.wifiScan()` `NUM_SCANS` times (default 2) and prints each progress callback,
the outcome and the access points found. Two scans are the useful minimum: the second shows the
previous results being offered during the scan (`prevScanWifi`) and the `NEW` marker on BSSIDs
that were not in the previous scan.

```
AXIOM=192.168.86.136 node tests/e2e/wifi-scan.mjs
```

Exit code `0` if every scan succeeded. Over WiFi the device does not answer while it scans, so
expect few or no progress lines and a pause of a few seconds before the outcome — that is the
device, not the script. It passes `resumeWifiIfPaused: true`, so it also works on a device whose
WiFi is paused because a BLE client is connected.

---

## `observe-devices.mjs`

Subscribes to `devbin`, dwells for `DWELL_MS` (default 12000) and then prints, for each device,
its type, online state, sample count, last timestamp, stats and the last value of every
attribute, plus a tally of the frames received by type and topic. While it runs it also dumps
the first few **raw poll records** of the devices listed in `SIGS` at the top of the script
(matched by address and device type index) — edit that table for the device under study.

```
AXIOM=192.168.86.136 SUB_RATE_HZ=20 node tests/e2e/observe-devices.mjs
```

It reports and always exits `0`; it is for looking at a device that is misbehaving, e.g. one
that has stopped producing samples while still reported online.

---

## `vcp-find-signal.mjs`

Answers one question: **which input is the signal actually on?**

Puts every `RoboticalVCP` it finds into mode 1 (the 4-channel scan, so all inputs report at
once) and prints min / max / peak-to-peak for each channel plus `ovf`. A quiet input sits at a
few mV; a driven one swings volts. The answer is unambiguous at a glance.

```
VCP_E2E_AXIOM=192.168.86.136 npm run vcp:find-signal
```

```
(all devices seen: 0_1, 1_76a, 1_16c, 1_168)
Found VCPs: 1_16c, 1_168

device    channel    n     min       max      pk-pk
--------------------------------------------------------
1_16c     V1        249    -1.478     1.486     2.964  <== SIGNAL HERE
1_16c     V2        249     0.003     0.004     0.001
1_16c     V3        249    -0.001     0.000     0.001
1_16c     I         249     0.000     0.000     0.000
1_16c     ovf       249     0.000     0.000     0.000
1_168     V1        253     1.297     1.301     0.004
```

Exit code `0` if any channel is moving, `1` if none, `2` if `VCP_E2E_AXIOM` is unset.

### Why you want this before anything else

A flat trace has at least four causes that look identical from a capture alone: the generator
is off, it is on the other board, it is on a different channel, or the device has stopped
publishing. This separates them in about twenty seconds. Several hours were lost to a
"firmware problem" that was a generator switched on but not started.

Two things in the output are worth reading carefully:

- **`ovf` is the device's own dropped-sample counter.** Non-zero means the board discarded
  samples it could not ship — the master's poll interval is too long for the burst size at
  that rate. It is the single most useful number here, and it is why `ovf` is listed as a
  channel rather than hidden.
- **A floating input sits near 1.30 V**, not near zero, because the front-end biases to
  VREF/2. An input reading ~0 V is connected to something; an input reading ~1.30 V probably
  is not. That distinction told us which of two boards was under test.

### Options

| Variable | Default | Purpose |
|---|---|---|
| `VCP_E2E_AXIOM` | — | host or IP of the Axiom. **Required** |
| `VCP_E2E_DISCOVER_MS` | 12000 | how long to dwell collecting devices |
| `VCP_E2E_CAPTURE_MS` | 4000 | capture window once configured |
| `VCP_E2E_SUB_RATE_HZ` | 50 | `devbin` subscription publish rate |
| `VCP_E2E_NO_CONFIG` | unset | observe the devices as they are, changing nothing |
| `VCP_E2E_FRAMES` | unset | tally received frames by topic — is the master publishing at all? |
| `VCP_E2E_LENCHECK` | unset | assert `timestampsUs.length` matches each attribute's `values.length` |

`VCP_E2E_NO_CONFIG=1` is the one to reach for when you are debugging a device that is already
in an interesting state and must not be disturbed.

### Three gotchas the script encodes

**Discovery dwells for the whole window** rather than returning on the first device found.
Devices are identified as the bus scanner reaches them, so an early return silently examines
only whichever board happened to be first — which produced a confident, wrong "no signal on
either board" while the generator was driving the board it never looked at.

**The subscription rate defaults to 50 Hz, not the dashboard's 0.1 Hz.** The dashboard relies
on `trigger: timeorchange` to push data as it changes. A capture tool cannot: a *static* input
never changes, so publishing falls back to the periodic rate and the device's ~1 s of retained
poll results is overwritten before it is ever sent. Measured: 10 Hz still lost samples at
500 SPS; 50 Hz captured everything.

**A `RaftChannelBLE` resolve shim is installed before `main.js` is required.**
`RaftChannelBLEFactory` requires `./RaftChannelBLE`, which is not a real file — the `.web` and
`.native` variants are selected by the bundler, or under jest by `moduleNameMapper`. Plain
Node has neither, so the script applies the same mapping jest does.

---

## Scope

The measurement tools **locate and characterise**; they do not gate anything. Only
`ws-reconnect.mjs` and `wifi-scan.mjs` return a pass/fail exit code, because a connection or a
scan either works or it does not. There is no pass/fail suite for sampled data, deliberately: a
previous capture harness that drove a rate/mode matrix proved
unreliable above ~200 SPS — it under-collected where the dashboard did not — and a test that
fails for its own reasons is worse than no test. The dashboard remains the reference client
for high-rate work.

If you need to verify sample-rate behaviour, the method that has proved trustworthy is to
**count samples per cycle of a known input**. That is independent of the reconstructed
timestamps, so it separates "the device is delivering the wrong rate" from "the client is
labelling the time axis wrongly" — two failures that look identical on a chart. It is how both
the EMA timestamp bug and the dropped-sample problem were found. See
`RoboticalAxiom1/docs/sample-rate-and-polling.md` §4 and §5b.
