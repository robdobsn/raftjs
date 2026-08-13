# System Type Capabilities

## Status

Implemented. `RaftCapabilityResolver` ([../src/RaftCapabilities.ts](../src/RaftCapabilities.ts))
combines Layer A (static table on each `RaftSystemType.capabilities`), Layer B
(runtime cache) and Layer C (firmware `caps`). Seeded at connect from the static
table + `SystemVersion`, cleared on disconnect. The static table decides whether
to call `caps` at all. `bleMaxWriteSize` is folded into `capabilities.tuning` and
applied by the connector after system-type resolution (removed from
`ConnectorOptions`).

## Problem

The app sends optional commands that many devices do not support. On a Marty /
RIC (SystemName `RIC`, firmware v1.3.21) connection this produces repeated
`failUnknownAPI` responses and `msgTrackTimer TIMEOUT after 5 retries` spam for
`pubtopics`, `datetime`, `datalog`, `camera`, `devman/typeinfo`, and
`bledisconnect`. Each unsupported call also wastes time (retries + timeout)
during connection, slowing the whole flow — trying `camera` on a Marty is pure
cost with no chance of success.

The set of supported commands genuinely differs per device family **and** per
firmware version (see the matrix below), so this cannot be solved by a single
global list.

## Goals

- Never send an optional command a device is known not to support (avoid the
  first bad send, not just suppress the retries).
- Pick the correct *form* of a command when it changed across versions
  (e.g. `devman/typeinfo?bus=&type=` vs `?deviceid=`).
- Keep working for unknown/custom firmware (don't hard-fail if the table is
  incomplete).
- Fold `bleMaxWriteSize` into the same per-system-type, version-aware descriptor.

## Non-goals

- Gating *core* commands (`v`, `subscription`, `sysmodinfo`, …). Only a defined
  set of optional endpoints is gated.
- Full semver. A small "leading `major.minor.patch`, ignore `-g…-dirty` suffix"
  parser is enough.

## Approach: two layers (+ a future third)

**Layer A — static table (closed-world over the gated set).** Each system type
declares, per version range, which *gated* endpoints it supports and any
form/tuning values. For the gated set only, "not listed for this version" =
"do not send". Non-gated endpoints are always allowed.

**Layer B — runtime cache (open-world overlay).** On every response, key by
endpoint: `rslt:ok` → supported, `failUnknownAPI` → unsupported. Overrides the
static table for this connection (covers custom builds and table gaps). Reset on
disconnect. This is the cache from `legacy-firmware-compatibility.md`.

**Layer C (preferred when available) — firmware self-describe via `caps`.** The
firmware exposes its own capability list over the normal transport through a new
`caps` API (see [The `caps` API](#the-caps-api)). When present it is authoritative
— the app builds the capability set directly from it and skips both the static
table and try-and-fail probing. When absent (older firmware) the app falls back
to Layers A + B, so those remain necessary.

### Resolution order before sending an optional command

0. If `caps` was available at connect (Layer C), its list is authoritative —
   support = membership in the list; nothing else is consulted.
1. Else runtime cache (Layer B) has a verdict → use it.
2. Else static table (Layer A) for the connected version → use it.
3. Else unknown → send once, record the result in Layer B.

Crucially the check sits **before** the `msgTrackTimer` retry loop, so a
known-unsupported endpoint is never enqueued and never produces
"TIMEOUT after 5 retries".

## The `caps` API

A firmware endpoint that returns the device's own capability list, so the app can
negotiate rather than probe. `caps` is itself the **first** capability probed at
connect: one call decides whether all other probing can be skipped.

### Default form: `caps`

Returns a flat JSON list of the supported endpoint/feature names (all of them,
not just the gated set — useful for tooling and docs too):

```json
{ "req": "caps", "rslt": "ok", "capsVersion": 1,
  "caps": ["v", "subscription", "pubtopics", "datetime",
           "devman/typeinfo", "filelist", "bledisconnect", "camera"] }
```

The app filters this against its gated set by simple membership. `capsVersion`
lets the response schema evolve without breaking older apps.

### Extended form: `caps/<feature>`

Returns detail for one feature. In **v1** the registry holds each endpoint's
name, HTTP method and a single free-form description string (the same text the
serial console prints on ENTER), so the response is:

```json
{ "req": "caps/datetime", "rslt": "ok", "capsVersion": 1,
  "name": "datetime", "method": "GET",
  "desc": "Get/set UTC time. Set: datetime?UTC=yyyy-mm-ddThh:mm:ssZ" }
```

An unknown feature returns `{"rslt":"fail","error":"unknownFeature","capsVersion":1}`.

Uses beyond help text:

- **Machine-readable help** — the `desc` string is the machine-readable
  equivalent of the serial help text, keyed by exact endpoint name.
- **Optional UI generation** — the app can decide which panels to show from the
  feature list.

> Structured per-argument metadata (a real `args` array, and an
> "introduced-in" version to retire the `forms` brackets) requires extending the
> endpoint registration API to carry structured args. That is a **future**
> `capsVersion` bump, out of scope for v1.

### Discovery and fallback

1. After `v`/`getSystemInfo`, the app calls `caps` once.
2. `rslt:ok` → build the authoritative capability set from the list; done.
3. `failUnknownAPI` → firmware predates `caps`; record `caps` as unavailable
   (so it is not retried) and fall back to Layers A + B.

### Single source of truth (firmware)

The RaftCore REST endpoint registry already holds each endpoint's name and
description — that is exactly what the serial console prints on ENTER. `caps`
enumerates the same registry, so:

- `caps` = registry names, `caps/<name>` = that entry's method + description.
- The serial-console ENTER handler (`SerialConsole::showEndpoints`) already
  enumerates the *same* registry, so both paths share one source of truth with
  no refactor needed.

**Implemented:** `SysManager::apiGetCaps` in RaftCore registers the `caps`
endpoint (branch `feature/caps-api`). Because it enumerates the shared REST
endpoint registry, no RaftSysMods change is required for the firmware side.

### Scope

This spans two repos: the `caps` endpoint (firmware, **RaftCore**) and its
consumption (**raftjs**, Layer C). The app change degrades gracefully against any
firmware without `caps`.

## Gated endpoint set

Only these optional, app-initiated endpoints are gated (closed-world). Everything
else is always sent.

`pubtopics`, `datetime`, `datalog`, `camera`, `devman/typeinfo`,
`filelist/local`, `bledisconnect`. (Extend as new optional calls are added.)

## Capability matrix (from captured firmware command lists)

Derived from the serial command lists of Marty/RIC v1.3.21, current Axiom, and
current Cog. ✓ = present in the firmware's command list, ✗ = absent, `dynamic`
= no static entry, resolved at runtime (Layer B).

The Axiom family splits into two device types: **AxiomOne** (the current Axiom
command set) and **AxiomPlant** (identical to AxiomOne plus a camera). **Generic**
intentionally declares no static table and discovers everything dynamically.

| Gated endpoint      | Marty/RIC v1.3.21 | AxiomOne | AxiomPlant | Cog (current) | Generic |
| ------------------- | ----------------- | -------- | ---------- | ------------- | ------- |
| `pubtopics`         | ✗                 | ✓        | ✓          | ✓             | dynamic |
| `datetime`          | ✗                 | ✓        | ✓          | ✓             | dynamic |
| `datalog`           | ✗                 | ✓        | ✓          | ✗             | dynamic |
| `camera`            | ✗                 | ✗        | ✓          | ✗             | dynamic |
| `devman/typeinfo`   | ✗                 | ✓        | ✓          | ✓             | dynamic |
| `filelist/local`    | ✓                 | ✓        | ✓          | ✗             | dynamic |
| `bledisconnect`     | ✗                 | ✓        | ✓          | ✓             | dynamic |

Observations:

- **Marty v1.3.21** supports almost none of the gated endpoints — it uses an
  older command set (`traj`, `servo`, `elem`, `hwstatus`, `pwrctrl`, `pyrun`, …)
  and publishes its own state format, not devbin. It notably lacks
  `bledisconnect` (it has `blerestart` only), so the current
  `ricRestCmdBeforeDisconnect` → `bledisconnect` is itself an unsupported call on
  this firmware.
- **camera** is the only difference between **AxiomOne** and **AxiomPlant**, and
  is absent everywhere else. It must default to *off* and be enabled only on
  types that explicitly declare it (today: AxiomPlant).
- **datalog** and **filelist** differ between the Axiom types and Cog, confirming
  the table must be per system type, not global.
- **Generic** is the catch-all: it declares no gated endpoints statically, so
  every gated call resolves as *unknown* → tried once → cached (Layer B). This is
  the correct behaviour when the device family is not known ahead of time.
- Marty entries are a **lower version bracket**; newer Marty firmware likely adds
  `datetime`/`pubtopics`/`devman`, so those become `minVersion`-gated once the
  introducing version is known.

## Descriptor shape (folds in `bleMaxWriteSize`)

Authored on each `RaftSystemType` (e.g. `SystemTypeMarty`), colocated with the
type. String endpoint keys (no enum) — they match the wire names and the command
lists directly. A logical `forms` section handles the one case where the call
*form* changes by version.

```ts
interface VersionRange {
  minVersion?: string;  // inclusive, semver-lite; omit = from 0
  maxVersion?: string;  // exclusive; omit = to infinity
}

interface SystemCapabilities {
  // Gated endpoints this type supports, optionally version-gated.
  // `true` = all versions; a range/ranges = only within those versions.
  endpoints: Record<string, true | VersionRange | VersionRange[]>;

  // Endpoints whose call *form* changed across versions. First matching
  // range wins; used to build the actual URL.
  forms?: Record<string, Array<VersionRange & { build: (p: unknown) => string }>>;

  // Tuning values, version-bracketable. bleMaxWriteSize folded in here.
  tuning?: {
    bleMaxWriteSize?: number | Array<VersionRange & { value: number }>;
  };
}
```

Example (Marty):

```ts
capabilities: SystemCapabilities = {
  endpoints: {
    "filelist/local": true,
    // datetime/pubtopics/devman/typeinfo added in a later Marty build:
    // "datetime": { minVersion: "<TBD>" },
  },
  tuning: { bleMaxWriteSize: 182 },
};
```

Example (`devman/typeinfo` form switch, from git history commit `054125c`):

```ts
forms: {
  "devman/typeinfo": [
    { maxVersion: "<054125c-equiv>", build: (d) => `devman/typeinfo?bus=${d.bus}&type=${d.type}` },
    {                                build: (d) => `devman/typeinfo?deviceid=${d.key}` },
  ],
}
```

Example (AxiomOne, AxiomPlant, Generic). AxiomPlant reuses AxiomOne's set and
adds `camera`; Generic declares nothing so everything is discovered dynamically:

```ts
const axiomOneEndpoints = {
  "pubtopics": true,
  "datetime": true,
  "datalog": true,
  "devman/typeinfo": true,
  "filelist/local": true,
  "bledisconnect": true,
};

// AxiomOne
capabilities = { endpoints: axiomOneEndpoints, tuning: { bleMaxWriteSize: 244 } };

// AxiomPlant = AxiomOne + camera
capabilities = {
  endpoints: { ...axiomOneEndpoints, "camera": true },
  tuning: { bleMaxWriteSize: 244 },
};

// Generic — no static endpoint table; every gated call is tried once and cached
// (Layer B). Declares only tuning, so BLE write size is set while endpoints stay
// dynamic.
capabilities = { tuning: { bleMaxWriteSize: 244 } };
```

Omitting `endpoints` (or `capabilities` entirely) means "gate nothing
statically"; resolution falls through to the runtime cache. This is distinct from
an empty `endpoints: {}`, which under closed-world would deny every gated call.
Because `endpoints` is optional, a type can declare `tuning` alone (as Generic
does) and remain fully dynamic for endpoint support.

## Version handling

- Parse `major.minor.patch` from `SystemVersion`, plus the git-describe
  "commits since tag" count as a 4th ordinal, so a dev build sorts **after** its
  base tag: `1.9.5-6-g367562d` → `[1,9,5,6]` > `1.9.5` → `[1,9,5,0]`. A trailing
  `-dirty` (or any non `-<n>-g<hash>` suffix) is ignored.
- Comparator supports `minVersion` (inclusive) / `maxVersion` (exclusive) and
  ordered range lists. Keep it a small local helper; do not add a semver
  dependency for this.

> **Distinguishing pre-release dev builds from a release tag.** Because the
> commit count is ordered, a `minVersion` of `1.9.5-1` (≥ 1 commit past the
> `1.9.5` tag) matches current dev builds (`1.9.5-6-g…`) **and** any future
> release (`1.9.6`, `1.10.0`, …) but **not** the plain `1.9.5` release. Verified
> on Cog: v1.9.5 lacks `caps`/`pubtopics`/`datetime`/`devman/typeinfo`; the dev
> build (`1.9.5-6`) has them. The Cog table therefore version-gates those (and
> `caps` itself) at `minVersion: "1.9.5-1"`, so on 1.9.5 the caps probe is
> skipped and the gated endpoints are not sent, while newer firmware queries caps
> and uses it as authoritative.

## Enforcement point

Centralise in one wrapper, e.g. `RaftSystemUtils.sendOptional(endpoint, params)`
(or a `CapabilityResolver` owned by the connector), which:

1. resolves `endpoint` → concrete URL via `forms` (or skips if unsupported),
2. consults Layer B then Layer A,
3. sends at most once when unknown,
4. records the result in Layer B,
5. short-circuits the retry tracker and demotes the log to debug for
   known-unsupported endpoints.

The resolver is seeded from `systemType.capabilities` + `SystemVersion` at
connect time and cleared on disconnect.

## `bleMaxWriteSize` folding

`bleMaxWriteSize` now lives in `capabilities.tuning.bleMaxWriteSize` (removed from
`ConnectorOptions`) so all per-type, version-aware values sit together. The
channel keeps the conservative 182 default at initial connect; the connector
reads the resolved value (`RaftSystemUtils.getBleMaxWriteSize()`) and applies it
via a shared `_applyResolvedBleMaxWriteSize()` helper after system-type
resolution and again after a channel-only reconnect (a fresh connect resets the
channel to the default). Supports a scalar or version-bracketed list.

## Phasing

Implemented as a single `RaftCapabilityResolver` covering all three layers:

1. **Layer B + retry short-circuit.** Runtime cache; gated sends check
   `isCapabilitySupported` first (done for `pubtopics`, `datetime`).
2. **Layer A static table** authored on `SystemTypeCog` (with `caps`),
   `SystemTypeMarty` (no `caps`, so the probe is skipped), Generic = undefined.
   Version brackets supported via `minVersion`/`maxVersion`.
3. **`forms` brackets** for `devman/typeinfo` and `bleMaxWriteSize` folding into
   `tuning`: `bleMaxWriteSize` is now in `capabilities.tuning` (removed from
   `ConnectorOptions`) and applied by the connector on connect and reconnect;
   `forms` brackets still to do.
4. **Layer C — the `caps` API.** Firmware endpoint (`SysManager::apiGetCaps`,
   merged to RaftCore main) + app consumption via the resolver. Authoritative
   when present; the static table decides whether to query it.

## Open questions

- Exact Marty firmware versions that introduced `datetime`/`pubtopics`/`devman`
  (needed to set `minVersion` brackets precisely; today only v1.3.21 is sampled).
- Whether to gate `bledisconnect` via this table or keep it in
  `ricRestCmdBeforeDisconnect` with a capability check (it is unsupported on
  Marty v1.3.21).
- `caps` response schema: v1 returns endpoint names (default form) and
  name/method/description (extended form). Structured per-argument metadata to
  drive form selection (e.g. `devman/typeinfo`) and UI generation would require
  extending endpoint registration and a `capsVersion` bump — not yet scheduled.
