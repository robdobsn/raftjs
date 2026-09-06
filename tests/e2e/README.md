# Hardware end-to-end tools

Scripts here talk to **real hardware over the network**. They are not run by jest — its
`testMatch` only picks up `*.test.*` / `*.spec.*` under `src/`, so nothing in this directory
runs in CI.

They connect exactly as the dashboard example does: a WebSocket to `ws://<host>/wsjson`, a
`devbin` subscription, and the same `DeviceManager` decode path. That matters — a bug found
here is a bug a real client would hit.

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

These tools **locate and characterise**; they do not gate anything. There is no pass/fail
suite here, deliberately: a previous capture harness that drove a rate/mode matrix proved
unreliable above ~200 SPS — it under-collected where the dashboard did not — and a test that
fails for its own reasons is worse than no test. The dashboard remains the reference client
for high-rate work.

If you need to verify sample-rate behaviour, the method that has proved trustworthy is to
**count samples per cycle of a known input**. That is independent of the reconstructed
timestamps, so it separates "the device is delivering the wrong rate" from "the client is
labelling the time axis wrongly" — two failures that look identical on a chart. It is how both
the EMA timestamp bug and the dropped-sample problem were found. See
`RoboticalAxiom1/docs/sample-rate-and-polling.md` §4 and §5b.
