# BLE Max Write Size / MTU Handling

> **Status: implemented.** `bleMaxWriteSize` is now a per-system-type,
> version-bracketable value under `capabilities.tuning.bleMaxWriteSize` (removed
> from `ConnectorOptions`). The connector applies the resolved value after
> system-type resolution and again after a channel-only reconnect. See
> [system-type-capabilities.md](system-type-capabilities.md) (`bleMaxWriteSize`
> folding). The design rationale below is retained for context.

## The problem

`RaftChannelBLE.web.ts` splits outbound writes into chunks of at most
`_maxBleWriteSize` bytes. The `feature/wifi` branch hard-coded this to `182`
(down from `244`), a deliberate stability choice for Marty audio streaming
against an ATT_MTU of 185. Landing `182` as a fixed default cuts large-transfer
throughput ~25% for every device that could negotiate a larger MTU (Cog,
Generic, Axiom). We want it configurable per device, defaulting conservatively.

## Design constraints

- Web Bluetooth exposes no MTU API, so the value is a chunk size we choose, not
  something we can read from the browser.
- `RaftConnector.connect()` resolves the system type **after** the channel
  connects, so at first channel connect `_systemType` is null and
  `channel.connect()` receives `{}`. A value passed purely via `ConnectorOptions`
  at connect time won't apply on the first connection — but large writes
  (file/OTA/audio) only happen well after system-type resolution, so a
  post-resolution setter is the right hook.
- Each system type already carries a `connectorOptions` object (Marty
  `{wsSuffix, bleConnItvlMs}`, Cog/Generic likewise), which is the natural place
  for a per-type value.

## Layer 1 — configurable static value (implemented)

1. `RaftSystemType.ts` → `ConnectorOptions`: add `bleMaxWriteSize?: number`.
2. `RaftChannelBLE.web.ts`:
   - Keep the conservative `_maxBleWriteSize = 182` as the default (safe until
     the device type is known).
   - In `connect()`, if `connectorOptions.bleMaxWriteSize` is provided, adopt it
     — covers the reconnect / `_connectToChannel` path where the system type is
     already known.
   - Add `setMaxWriteSize(bytes)` with a sanity clamp (20–512).
3. `RaftConnector.connect()`: right after system-type resolution / `setup()`, if
   the channel supports it and `this._systemType.connectorOptions.bleMaxWriteSize`
   is set, call the setter. A capability check (`typeof
   channel.setMaxWriteSize === "function"`) keeps this BLE-specific without
   widening the shared `RaftChannel` interface.
4. Per-system-type values (in `examples/dashboard`): start low, raise for
   non-Marty:
   - `SystemTypeMarty`: `bleMaxWriteSize: 182` (matches the stability requirement).
   - `SystemTypeCog` / `SystemTypeGeneric`: `bleMaxWriteSize: 244`.
   - Default stays 182 for anything unspecified.

Net effect: Marty keeps 182; Cog/Generic get 244 back after their type is
resolved; nothing regresses on first connect because only small control traffic
flows before resolution.

## Layer 2 — PhoneBLE uses the real negotiated MTU (future, native only)

`react-native-ble-plx` does expose MTU negotiation (`requestMTU()` on Android;
iOS auto-negotiates and reports it). The phone BLE channel implementation can
set `_maxBleWriteSize = negotiatedMTU − 3` after connecting, instead of any
static value — strictly better than configuration where the platform supports
it. Isolated to the phone channel file; does not touch the web path.

## Layer 3 — firmware-driven dynamic MTU (future, removes config entirely)

The firmware already tracks the negotiated MTU (`BLE_GAP_EVENT_MTU` →
`onMTUSizeInfo()` in `BLEGapServer.cpp`) but doesn't surface it. Adding one
field to the BLEMan status JSON would let raftjs — which already calls
`getSysModInfoBLEMan()` for the perf test — read the real MTU after connect and
set `_maxBleWriteSize = mtu − 3`. That makes Layer 1's per-type table
unnecessary long-term; keep Layer 1 as the firmware-independent fallback.

## Scope / validation

- Files touched for Layer 1: `RaftSystemType.ts`, `RaftChannelBLE.web.ts`,
  `RaftConnector.ts`, and the three `examples/dashboard` system-type files. No
  change to the shared `RaftChannel` interface.
- The existing BLE test *"chunks BLE writes for an ATT MTU of 185"* asserts 182
  chunking — still valid for the Marty/default case. A follow-up test can assert
  a 244 override chunks correctly.
- Only behavioural risk is ordering — the setter must run before the first large
  transfer. Since it is applied at system-type resolution and transfers are
  user-initiated later, that holds.
