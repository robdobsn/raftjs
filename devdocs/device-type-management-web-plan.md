# Device Type Management from raftjs and a Web UI: Plan

## Status

Decisions W1-W9 made 2026-10-24 (§9). **Phases 1-6 implemented 2026-10-24** (§11), except the on-hardware checks
(no board was attached): RaftCore firmware fields, `_sources`, `--pages` and the Pages workflow; raftjs's type file,
grammar, selection, catalogue and device workflow modules; the Device Types app (`apps/devtypes`). Not committed.

Companion documents:

- RaftCore `devdocs/device-type-record-management-plan.md` - one file per record, `DeviceTypeSources.json`, git
  sources, runtime type files, the raft CLI (phases 1-6, done). §3.7 there says a graphical tool is for later and
  needs only raftjs plus upload, check and apply wrappers. This document is that tool.
- RaftCore `devdocs/runtime-decoding.md` - on-device decoders from a record's attributes and the code interpreter,
  which decide whether a record added at runtime is decoded on the device.
- Wiki: *DeviceManager Settings* (device type file, `typeTable`, `typePolicy`, `typeSettings`), *Selecting Device
  Types* (`DeviceTypeSources.json`, runtime type files, `raft devtypes`), *DeviceManager REST API* (`devman/typefile`,
  `typefile/check`, `typefile/apply`, `typepolicy`, `types`, `typeinfo full=1`), *Device Type Record Format*.

---

## 1. Aims

1. **An end user, not a firmware developer, can add a device type to a device** - a sensor the firmware wasn't built
   with - from a browser, without a toolchain, a project checkout or the raft CLI.
2. **A browsable catalogue** of RaftCore's records and third parties', searchable by name, manufacturer, class and
   I2C address, for anyone, with or without a device.
3. **Records from other sources**, described as `DeviceTypeSources.json` describes them (`bundled`, `git`, `path`), so
   a project's selection can be loaded into the app, and what the app builds can be downloaded as a
   `DeviceTypeSources.json` with its lock (§6a).
4. **The raftjs library does the work**, so the web UI, the dashboard example, apps that embed raftjs (React Native
   included) and scripts all share one implementation of building, checking, pushing and pulling type files.
5. **The device's rules decide.** The browser gives early warnings, but what is accepted is what
   `devman/typefile/check` on the device says - the same principle as the CLI (M7 of the RaftCore plan).
6. **A bridge back to the build**: what a user chose in the UI can be exported as a `typeFile` (or `builtin`)
   selection for `DeviceTypeSources.json`, so a working setup becomes part of a project.

Non-aims (for now): editing a project's files from the browser; private git sources; compiling firmware; anything
that changes the record format or the firmware's checks. Later, on the same site: an ESP32 flasher that knows the
layout of a Raft app (§8, phase 8).

---

## 2. What exists (2026-10-24)

| Piece | Where | State |
|-|-|-|
| Records, one file each | RaftCore `devtypes/records/*.json` (59 records) | Done |
| Catalogue file of every record | RaftCore release asset `DeviceTypeRecords.json` (`release-assets.yml`) | Done. Release assets aren't served with CORS headers, so a browser page can't fetch it |
| Type file builder | RaftCore `scripts/AssembleDeviceTypes.py` `build_type_file()` (new / override / unchanged / policy, `noDecoder`, `initCode`, minify, 64 KB) | Python only |
| Command grammar check | RaftCore `DeviceTypeGrammar.cpp` and `scripts/DeviceTypeGrammar.py`, shared vectors `scripts/tests/grammar_vectors.json` | C++ and Python |
| Decode code check | `PseudocodeHandler.check_code` (Python) | Python; raftjs has `PseudocodeTranspiler.ts` (tokenizer and transpiler) |
| Device endpoints | `devman/typefile`, `typefile/check`, `typefile/apply`, `typepolicy ... save=1`, `types` (paged table with `src` base / override / extended and policy), `typeinfo ... full=1` (a record in type file form), `reident`, `caps` | Done |
| raftjs wrappers | `DeviceManager.getTypeFileStatus`, `checkTypeFile`, `applyTypeFile`, `setTypePolicy`, `reIdentify`; types `DevManTypeFileStatus`, `DevManTypeFileCheck`, `DevManTypeFileEntry` | Done |
| raftjs file transfer | `RaftConnector.sendFile`, `fsGetContents` (RICREST, over BLE, Web Serial and WebSocket) | Done |
| Dashboard panel | `examples/dashboard/src/TypeFilePanel.tsx`: choose a file, upload as `devlib.new.json`, show the device's check per entry, apply | Done, but the workflow is written in the panel, not the library; no reconnect or verify after the restart |
| raft CLI | `raft devtypes push / pull / status` (HTTP), the logic in `DeviceTypesTool.py` | Done |

So the device side is complete for this work. What is missing is (a) the type file logic in TypeScript, (b) a
catalogue a browser can fetch, (c) a few facts the device doesn't yet report, and (d) the UI.

---

## 3. Shape of the solution

```
 RaftCore repo                          raftjs (npm)                              Browser
 ─────────────                          ────────────                              ───────
 devtypes/records/*.json ──CI──►  Pages: catalogue index        RaftDeviceTypes module
                                  + records per release  ─fetch─►  catalogue, type file    ◄── Device Types app
                                                                   builder, early checks       (static page,
                                                                   device workflow  ──────►    GitHub Pages)
                                                                        │                         │
                                                                        └── RaftConnector ── BLE / Web Serial / WS ── device
                                                                            devman/typefile, typefile/check, apply, fs
```

Three deliverables:

1. **A `RaftDeviceTypes` module in raftjs** (§5): no DOM, no React, usable from Node and React Native.
2. **A catalogue published to GitHub Pages by RaftCore's CI** (§6).
3. **A Device Types web app** (§7), a static page that uses both. Hosted on GitHub Pages.

Plus small, additive firmware changes (§4).

---

## 4. Firmware additions (RaftCore, additive)

The UI needs to know which rules the device applies before it builds a file for it. Today it can learn the limits
(`devman/typefile`) and the table (`devman/types`), but not:

| Missing | Why it matters | Proposal |
|-|-|-|
| RaftCore version | Records follow the format of a RaftCore version (e.g. `hwTypeId` replaced `deviceTypeId`, which is now rejected - M14). The UI should offer the catalogue of the device's RaftCore version, or warn when using a newer one. `v` gives the app's `SystemVersion`, not RaftCore's | `raftCore` in `devman/typefile` status (and in `v` if cheap) |
| Runtime decoding built in | Whether a new record will be decoded on the device (`RAFT_RUNTIME_DECODE`) and whether custom decode code and `initCode` run (`RAFT_RUNTIME_DECODE_CODE`). The status has `runtimeDecoders` (the setting) but not what the build has | `decode: {"attrs": true, "code": false}` in the status |
| Record format version | Lets the UI refuse records newer than the device understands without comparing RaftCore versions | `recordFormat: 1`, matching `formatVersion` in a source's `raftdevtypes.json` manifest |
| Protected types | A type a system device expects (`expectType`) can't be overridden or disabled; the UI should grey it out rather than let the check reject it (W6) | `protected: true` on its entry in `devman/types` |

The check endpoint already reports per entry what the device will do, so these only let the UI warn earlier and pick
the right catalogue. raftjs treats them all as optional (older firmware: assume the catalogue of the newest release
and rely on the check).

Not proposed now (W7, maybe later): an endpoint to add or remove one record. The client pulls the device's file, changes it and pushes the
whole file, with the file's CRC to detect a change made meanwhile (as `raft devtypes push` does). This keeps one
route onto the device, through the staged check and apply, and needs no new firmware.

Possibly later: `devman/types?full=1` (records with the table page), if fetching compiled records one `typeinfo` at a
time proves slow over BLE (§5.3).

---

## 5. raftjs: the `RaftDeviceTypes` module

New files in `src/`, exported from `main.ts`. Pure logic is separated from device I/O so it can be unit tested with the
same fixtures as the Python.

### 5.1 Catalogue model and sources

```ts
interface DeviceTypeRecord { [field: string]: unknown }      // a record as in devtypes/records/<Key>.json

interface DeviceTypeCatalogueEntry {
    key: string;
    source: string;                // "raftcore", "local", or a git source's name
    version?: string;              // RaftCore tag, or the git commit
    sha256: string;                // of the record file, as the manifest records it
    summary: {                     // for search without loading every record
        name?: string; manu?: string; clas?: string[]; addresses?: string; hwTypeId?: string;
        hasData: boolean; customCode: boolean; initCode: boolean;
    };
}

interface DeviceTypeSource {
    name: string;
    list(): Promise<DeviceTypeCatalogueEntry[]>;
    get(key: string): Promise<DeviceTypeRecord>;
}
```

Source implementations:

- `RaftCorePagesSource(baseUrl, version)` - the published catalogue (§6). Default for the app; it stands for a
  `{"bundled": true}` source.
- `GitSource(url, ref, path)` - a `git` source of `DeviceTypeSources.json`: a public repo with a folder of record files
  or one record file (default path `records`), optional `raftdevtypes.json` manifest (`formatVersion`,
  `minRaftCore`, checked as the assembler checks them). A browser can't run git, so it reads through the host's HTTP
  API: for GitHub, `ref` is resolved to a commit with the API, the tree is listed once, and files are read from
  `raw.githubusercontent.com` at that commit (both serve CORS headers). Unauthenticated GitHub API requests are
  limited to 60 per hour per IP, so a commit is read once and cached in the browser (records at a commit never
  change). Other hosts (GitLab, Gitea) are further adapters behind the same interface; a host without CORS can't be
  read from a page.
- `LocalRecordsSource(name, files)` - a `path` source: records the user drops or picks (a record file, a folder of
  them, a catalogue file, or a type file pulled from a device).

`fetch` is injected, so Node tests and React Native work. How sources are combined is §6a.

### 5.2 Type file builder (port of `build_type_file`)

```ts
interface TypeFileSelection {
    records: Record<string, DeviceTypeRecord>;          // key -> record to put in the file
    policy: Record<string, "disabled" | "disabledClaim">;   // compiled types to disable
}
interface TypeFileBuildEntry {
    key: string; kind: "new" | "override" | "unchanged" | "policy";
    noDecoder?: boolean; decoder?: "runtime" | "none"; initCode?: "runtime" | "runtime or compiled";
    problems?: string[];                                // early checks (§5.4)
}
function buildTypeFile(sel: TypeFileSelection, compiled: Record<string, DeviceTypeRecord>,
                       opts?: { maxBytes?: number }): { text: string; bytes: number; crc: string; entries: TypeFileBuildEntry[] };
```

Same rules as the Python: `_notes` removed, unchanged records left out, `noDecoder` from the compact `resp` JSON,
keys sorted by UTF-8 bytes, minified, policies as `{"disable": true | "claim"}`, a type file can't enable a compiled
type, the `initCode` / init value slot rules. `crc` is CRC16-CCITT as `filehash` and `devman/typefile` report it, so
the UI can tell whether the device has the file.

**Keeping the two in step:** the Python tests write golden outputs (input selection, compiled records, expected text
and entries) to `scripts/tests/typefile_vectors.json` in RaftCore; raftjs tests run the same vectors (copied into
`testdata/`, or read from a sibling RaftCore checkout in CI). The grammar already works this way with
`grammar_vectors.json`.

### 5.3 What the device has compiled

`buildTypeFile` needs the compiled records to classify new / override / unchanged. The CLI reads them from the build;
a browser has only the device:

- `devman/types` (paged) gives every key with `src` and policy: enough to tell new from override, and to list what
  can be disabled.
- `devman/typeinfo?deviceTypeKey=<k>&full=1` gives a compiled record, fetched only for keys the user selects that the
  device also has (to tell override from unchanged, and whether the response layout changed). Cached per connection,
  keyed by the table's `generation`.

The device's record may not be byte-identical to the source file (field order, whitespace in strings), so the
comparison is structural (sorted keys, as `_comparable`), and a doubtful "unchanged" errs towards including the
record. The device's check is authoritative in any case.

### 5.4 Early checks in the browser

Warnings before upload, so a user isn't surprised by the device's check:

1. **Grammar** of `detectionValues`, `initValues`, `pollInfo.c`: port `DeviceTypeGrammar.py` (about 470 lines) to
   `DeviceTypeGrammar.ts`, tested against `grammar_vectors.json`.
2. **Response size**: `devInfoJson.resp.b` equals what the poll reads produce (from the grammar's steps).
3. **Decode and init code** in the decode language: reuse `PseudocodeTranspiler.ts`'s tokenizer for the rules of
   `PseudocodeHandler.check_code` (no calls, only declared names).
4. **Limits** from `devman/typefile`: `maxFileBytes`, extended records and bytes free, `typeFileLimits`.
5. **Decoding**: with the device's `decode` flags (§4), a clear statement per record - "decoded on the device",
   "decoded in this app only (DataLogger, RaftROS and named values won't see it)".

Option for later (W5): compile the C++ loader and grammar to WebAssembly so the browser uses exactly the firmware's
rules offline. Not needed while the device check exists.

### 5.5 Device workflow

Move the dashboard panel's steps into the library, and add what the CLI's `push` does:

```ts
class DeviceTypeFileManager {
    constructor(connector: RaftConnector);
    status(entries?: boolean): Promise<DevManTypeFileStatus & DeviceTypeFeatures>;
    table(): Promise<DevManTypeTableEntry[]>;                 // devman/types, all pages
    compiledRecord(key: string): Promise<DeviceTypeRecord | undefined>;
    pull(): Promise<{ text: string; crc: string } | undefined>;   // fsGetContents of the type file
    stage(text: string, onProgress?): Promise<DevManTypeFileCheck>;   // upload devlib.new.json, check
    apply(opts?: { waitForRestart?: boolean; timeoutMs?: number }): Promise<TypeFileApplyResult>;
    push(text: string, opts?: { expectedDeviceCrc?: string; dryRun?: boolean; confirm?: (check) => Promise<boolean> }): Promise<TypeFilePushResult>;
}
```

`push` = refuse if the device's current CRC isn't `expectedDeviceCrc` (the file changed since it was pulled - e.g.
`typepolicy save=1`), unless forced; `stage`; refuse if not `valid`; `confirm`; `apply`; wait for the connection to
drop and come back (the connector's reconnect for BLE and WebSocket; Web Serial survives a restart of most boards);
then `status`: `state` applied, same CRC, the same outcome per entry as the check. A dry run removes the staged file.

`TypeFilePanel.tsx` is then rewritten on top of this class.

---

## 6. The published catalogue (RaftCore CI)

A GitHub Pages workflow in RaftCore, on a release and on a push to `main`:

```
https://robdobsn.github.io/RaftCore/devtypes/
    index.json                     {"formatVersion":1, "versions":["main","v1.62.0", ...], "latest":"v1.62.0"}
    v1.62.0/catalogue.json         entries (§5.1): key, sha256, summary
    v1.62.0/records/<Key>.json     each record, as in the repo
    v1.62.0/DeviceTypeRecords.json all records in one file (as the release asset)
    main/...                       the same for the current main
```

- Built by `AssembleDeviceTypes.py` (a new `--pages <dir>` option, so the summary fields and SHA-256 are computed by
  the same code as the manifest).
- Each release adds a version folder; earlier ones are kept (the workflow restores the previous site from the
  `gh-pages` branch, or rebuilds every tag - W3).
- Records are small (49 records were 36 KB minified; the 59 now are still well under 64 KB), so the whole history
  stays small.

Same origin note: if the app is also on `robdobsn.github.io` (§7), the catalogue is same-origin and needs no CORS at
all; for apps elsewhere, GitHub Pages serves `Access-Control-Allow-Origin: *`.

---

## 6a. Sources in the app, and the `DeviceTypeSources.json` it generates

The app's working state *is* a `DeviceTypeSources.json`: named `sources` and a `typeFile` section (`include`,
`exclude`, `policy`). Everything the user does - adding a source, picking records, disabling a compiled type - edits
that, and the type file is built from it. So the app and the build speak one format, and a selection moves between
them without translation.

**Resolving a selection in the browser** (`resolveSelection`, a port of `assemble()`'s selection rules, without the
git fetching): `"*"`, `"<source>:*"`, `"<source>:<key>"` and bare keys; `exclude`; a `path` source replaces the same
key from another source; the same key from two other sources is an error unless `include` names one (M6); `policy`
for compiled types. Covered by vectors from the Python tests, as the builder is (§5.2).

**Adding sources:**

| Source kind | In the app |
|-|-|
| `{"bundled": true}` | The published catalogue (§6), at the device's RaftCore version where it reports one (§4), else a version the user picks |
| `{"git": "<url>", "ref": "<ref>", "path": "..."}` | Paste a repo URL and a tag, branch or commit; read as in §5.1. The app shows the commit the ref resolved to, and offers newer commits on a branch (as `raft devtypes update`) |
| `{"path": "..."}` | Pick or drop record files or a folder. The records are kept in the browser, under the source's name |

**Importing a project's selection:** load a project's `DeviceTypeSources.json` (Common's and the SysType's, merged as
the build merges them) and its `DeviceTypeSources.lock`. Git sources are read at the locked commits, so the app sees
the records the project's build sees; `path` sources can't be read from a URL, so the app asks for their folder (with
`webkitdirectory` or the File System Access API). The `typeFile` section then gives the same type file as `raft
devtypes typefile` (same CRC), which phase 5 verifies.

**Downloads (the record of what was generated):**

- `DeviceTypeSources.json` - the sources and `typeFile` selection, ready to put in `systypes/<SysType>/`. With a
  choice of `typeFile` (records loaded at runtime, as now) or `builtin` (compile them in instead).
- `DeviceTypeSources.lock` - in the build's format (`formatVersion`, the commit each git source resolved to, the
  SHA-256 of each record used), so a build reproduces exactly what was pushed.
- The records of `path` sources, as files under the source's folder name, since only the browser has them.
- `devlib.json` itself, and a manifest per record (source, commit, SHA-256) like
  `DeviceTypeSources.manifest.json`.

These go in one zip, laid out as in a project (`systypes/<SysType>/DeviceTypeSources.json`, `.lock`,
`devtypes/<Key>.json`), so it can be unpacked into a project.

**Provenance in the type file (W9, proposed):** the device type file loader ignores top-level keys other than
`devTypes`, so the generated file can carry a small `_sources` entry - the selection, commits and record hashes. Then
pulling a file from a device tells the app (and `raft devtypes pull`) how it was made, and a device in the field can
be reproduced without the user having kept the download. Costs a few hundred bytes of the 64 KB. If adopted, both
builders (Python and TypeScript) write it, so the CRCs still agree.

---

## 7. The Device Types web app

### 7.1 Where it lives and how it is hosted

- **Source:** in raftjs, `apps/devtypes/` (React and Parcel, like `examples/dashboard`, sharing its connection code
  where sensible). It is a product, not an example, hence `apps/`.
- **Hosting (W1, decided):** on RaftCore's GitHub Pages site, next to the catalogue and with the rest of Raft's
  documentation: RaftCore's Pages workflow checks out raftjs at a pinned tag, builds the app and deploys it with the
  catalogue, at `https://robdobsn.github.io/RaftCore/devtypes/app/`. The app version is pinned with the catalogue.
- **Later on the same site:** an ESP32 flasher that knows a Raft app's layout (§8, phase 8).

### 7.2 Transports from a page on HTTPS

GitHub Pages serves over HTTPS, which decides how the app can reach a device:

| Transport | From the hosted page | Notes |
|-|-|-|
| Web Bluetooth | Yes | Chrome, Edge, Opera (desktop and Android). Not Firefox or iOS Safari |
| Web Serial | Yes | Chrome, Edge, Opera desktop. USB cable |
| WebSocket / HTTP to the device | **No** | `ws://` and `http://` from an `https://` page are blocked as mixed content (and by Private Network Access); the device has no TLS |

So the hosted app connects by BLE and serial. WiFi is later (W4); the options:

- **A second host serving the app over plain `http`** (W4's preferred direction). The blocker is mixed content, not
  CORS: an `http` page may open `ws://` to the device, and fetches the catalogue from Pages (CORS allowed). But Web
  Bluetooth and Web Serial need a secure context (`https` or `localhost`), so that copy of the app is WiFi only - the
  same build, with the transports offered chosen by `window.isSecureContext`.
- **The app run locally** (`npx` or a downloaded build on `http://localhost`): `localhost` is a secure context, so all
  three transports work. Probably the simplest route for WiFi users.
- **Served by the device** (RaftWebServer WebUI): WebSocket works, but the build must be small, and with the device
  as an access point there is no internet for the catalogue.
- The raft CLI remains the route for HTTP pushes from a terminal.

### 7.3 Screens

1. **Catalogue** (no device needed): search and filter (name, manufacturer, class, address, "has data", source);
   record view - identity and addresses, attributes with units and ranges, actions, poll interval, the raw JSON, and
   a link to the record's file on GitHub. Version picker (from `index.json`).
2. **Device**: connect (BLE / serial); firmware and RaftCore version; type file status (state, CRC, counts, first
   error, `restartRequired`); the device's type table (key, source base / override / extended, policy); the devices
   present and how each was identified (`devman/listdevs`, `typeinfo`), with an "unidentified at 0x.." list that
   links to catalogue records with that address - the commonest reason to use the app.
3. **Sources**: the sources in use (RaftCore's catalogue at a version, git repos at a ref and the commit it resolved
   to, local folders); add one, update a git ref, or import a project's `DeviceTypeSources.json` and lock (§6a).
4. **Compose**: start from the device's current type file (pulled; its `_sources`, if present, restores the
   selection - W9), from an imported selection, or empty; add records from any source; disable compiled types; per entry new / override / unchanged / policy, decoder,
   early check problems; total size against the device's limits. Changes are kept in the browser (`localStorage`)
   until pushed or discarded.
5. **Push**: the device's check, entry by entry, beside the app's own classification (differences highlighted);
   confirm; apply; progress through the restart and reconnect; verification. Then back to the Device screen, where
   the new devices appear.
6. **Export**: the downloads of §6a - `DeviceTypeSources.json` (as `typeFile` or `builtin`), its lock, local records
   and `devlib.json`, as one zip laid out as a project, or each on its own - so a developer can put the setup into a
   project and build it in with `fsImage` or compile it in. Offered after every push, as the record of what the
   device was given.

### 7.4 Security and trust

- The app is static; nothing leaves the browser except to the device and to GitHub for reads.
- Records from third-party sources are shown with their source and commit, and records with decode or init code are
  marked: that code runs in the device's interpreter (bounded - a loop that doesn't end is stopped), and the decode
  language check (§5.4) is applied as for git sources in a build.
- A type file can't override or disable a protected type (`expectType`); the device enforces it, and the app greys
  such types out (from `protected` in `devman/types`, W6).

---

## 8. Phases

| Phase | Work | Repos | Verify |
|-|-|-|-|
| **1** | Firmware facts (§4): `raftCore`, `decode`, `recordFormat` in `devman/typefile` status, `protected` in `devman/types`; wiki | RaftCore, wiki | Host test of the fields; FeatherS3 and Axiom report them, the Axiom's fuel gauge type as protected |
| **2** | raftjs `RaftDeviceTypes`: models, `LocalRecordsSource`, `buildTypeFile`, CRC, `DeviceTypeFileManager` (status, table, compiledRecord, pull, stage, apply, push with restart and verify); `typefile_vectors.json` from the Python tests; `TypeFilePanel` moved onto it | raftjs, RaftCore (vectors) | Jest on the shared vectors (the TS build gives the Python's text and entries for every vector); dashboard on a FeatherS3 over BLE and serial: push, restart, verify; a file changed on the device is detected |
| **3** | Early checks: `DeviceTypeGrammar.ts` on `grammar_vectors.json`; resp size; decode code check | raftjs | Jest; every RaftCore record passes; the known bad vectors fail as the C++ does |
| **4** | Catalogue on Pages: `AssembleDeviceTypes.py --pages`; Pages workflow (release and `main`); `RaftCorePagesSource` | RaftCore, raftjs | Host test of `--pages`; the site serves `index.json` and a version; raftjs fetch test against a local copy |
| **5** | Other sources and the generated selection (§6a): `resolveSelection` (on vectors from the Python), `GitSource` for GitHub, `LocalRecordsSource` for folders, import of a project's `DeviceTypeSources.json` and lock, the downloads (zip); W9 `_sources` in both builders if adopted | raftjs, RaftCore (vectors; `_sources` in `AssembleDeviceTypes.py`) | Jest; a test repo on GitHub with a manifest and records, at a tag and a branch; Axiom018's selection imported in the browser gives the same type file (same CRC) as `raft devtypes typefile` |
| **6** | The app, hosted: Catalogue, Device, Sources, Compose, Push, Export over BLE and serial | raftjs (`apps/devtypes`), RaftCore (Pages workflow) | On hardware: add a record for an unidentified sensor on a FeatherS3 and the Axiom from the hosted page, from RaftCore's catalogue and from a git source; unpack the downloaded zip into a project and build it with `fsImage`, giving the same file (same CRC) |
| **7** | Later: WiFi (a plain `http` host, or the app run locally - W4); WASM checker (W5); single-record endpoints (W7); record editor with live grammar checks and a test against a device (`devman/cmdraw` reads of detection values, decoded preview with `RaftAttributeHandler`) (W8); other git hosts; `devman/types?full=1` | as needed | Per item |
| **8** | Later: an ESP32 flasher on the same site (esptool-js over Web Serial) that knows a Raft app's layout - the partition table, app, file system image (so a `fsImage` type file goes with it) and OTA slots - flashing a release's build for a SysType, or just the file system | raftjs or its own app, RaftCore (release assets per SysType) | Per board family |

Phases 2 and 4 are independent and can run in parallel; 3 can follow 2 or be folded into 6; 5 needs 2 and 4.

---

## 9. Decisions

| # | Question | Decision |
|-|-|-|
| W1 | Where the app is hosted | **RaftCore's Pages site**, with the wiki and the rest of Raft's documentation, built from raftjs at a pinned tag, beside the catalogue (§7.1). An ESP32 flasher aware of Raft apps' layout can join it later (phase 8) (decided 2026-10-24) |
| W2 | Type file logic in TypeScript or the Python run in the browser (Pyodide) | **TypeScript port**, kept in step with the Python by shared vectors (§5.2) (decided 2026-10-24) |
| W3 | Catalogue history on Pages, and sources beyond RaftCore | **Keep every release's folder, plus `main`. Records from other sources too**, described as `DeviceTypeSources.json` does, and the generated `DeviceTypeSources.json` and lock offered as a download (§6a) (decided 2026-10-24) |
| W4 | WiFi from the app | **Later** (phase 7). Preferred direction: a second host serving the app over `http` (WiFi only there, since BLE and serial need a secure context), or the app run on `localhost` (§7.2) (decided 2026-10-24) |
| W5 | WebAssembly build of the firmware's loader and grammar | **Later**; the device's check is authoritative (decided 2026-10-24) |
| W6 | Report RaftCore version, build features and protected types from the device | **Yes**, additive fields (phase 1) (decided 2026-10-24) |
| W7 | Single-record add and remove endpoints on the device | **Later, if needed**; meanwhile pull, change and push the whole file through the staged check (§4) (decided 2026-10-24) |
| W8 | Record authoring in the app | **Later** (phase 7) (decided 2026-10-24) |
| W9 | Provenance (`_sources`) inside the generated type file | **Yes**, written by both builders (§6a). As built it holds the sources that supplied a record (git ones with their commit, RaftCore's with its version) and the selection - not per-record hashes, which would cost about 1.7 KB for 56 records; the records can be checked against the sources at those commits (decided 2026-10-24) |

---

## 10. Risks and open points

- **Structural equality of records** between the source files and `typeinfo full=1` (§5.3): if they differ in ways a
  structural compare doesn't hide, records will be reported as overrides that are really unchanged. Harmless (the
  device reports `unchanged` and the file is a little larger) but confusing; a test per RaftCore record on a device
  settles it.
- **Catalogue version vs firmware version**: until phase 1 firmware is common, the app can't know a device's RaftCore
  version and may offer records in a newer format. The device's check catches it; the app should explain the
  rejection ("this record needs RaftCore 1.6x or later").
- **Browser support**: no Firefox or iOS Safari (no Web Bluetooth or Web Serial). The catalogue works everywhere; the
  device screens say why they are unavailable.
- **Restart and reconnect**: BLE reconnect after `apply` needs the user's gesture again in some browsers (Web
  Bluetooth reconnects to a remembered device only where `getDevices()` is supported). The workflow must cope with a
  manual reconnect step.
- **GitHub API rate limits** for `GitSource` (60 requests per hour unauthenticated): resolve a ref and list the tree
  once per commit, read files from `raw.githubusercontent.com` (not rate limited the same way), and cache by commit.
  A user who hits the limit could add a token, kept only in the browser (later).
- **Git sources the browser can't read**: private repos, `git@` URLs and hosts without CORS work in a build but not in
  the app. On import the app says which sources it couldn't read and builds without them only if the user agrees.
- **Two implementations of the rules** (Python and TypeScript): the shared vectors are what keeps them the same; any
  change to `build_type_file` or the grammar must add vectors.

---

## 11. Progress (2026-10-24)

### Phase 1: firmware facts (RaftCore)

- `devman/typefile` status: `raftCore` (from `library.json`, as the compile definition `RAFTCORE_VERSION` set in
  `CMakeLists.txt`), `recordFormat` (`DeviceTypeFileLoader::RECORD_FORMAT_VERSION`, 1) and `decode`
  (`{"attrs":..,"code":..}` from `RAFT_RUNTIME_DECODE` / `RAFT_RUNTIME_DECODE_CODE`). `devman/types`: `"protected":true`.
- Checked: `DeviceManager.cpp` compiles for the ESP32-S3 (with and without `RAFTCORE_VERSION`), the CMake version
  extraction gives `1.62.0`, `make -C linux_unit_tests check` passes. **Not yet checked on hardware.**
- Wiki: *DeviceManager REST API* (`typefile` fields, `types` `protected`).

### W9 and phase 2: `_sources` and the TypeScript builder

- `AssembleDeviceTypes.py`: `assemble()` records the provenance; `build_type_file` writes it as `_sources` (after
  `devTypes`; `provenance=False` for none). The fs image and `raft devtypes typefile` files have it too.
- Shared vectors (RaftCore `scripts/tests`, copied into raftjs `testdata/`): `typefile_vectors.json`
  (`make_typefile_vectors.py`: every RaftCore record as new and as unchanged, overrides and decoder kinds, policies,
  init code rules, errors, and JSON that JavaScript reads and writes differently from Python) and
  `selection_vectors.json` (`make_selection_vectors.py`: 25 selection cases). `test_typefile_vectors.py` checks that
  the stored outputs are what the Python gives for the stored inputs, so a record change doesn't make them stale.
- raftjs (new files, exported from `main.ts`):
  - `RaftDeviceTypeJson` - JSON as Python reads and writes it. Key order is kept: `JSON.parse` would move LSM6DS3's
    rate map keys `"26","52"` ahead of `"12.5"`. Numbers keep their text and are written as Python's float repr
    (`0.000000125` -> `1.25e-07`), and non-ASCII characters are escaped.
  - `RaftDeviceTypeGrammar` - the command grammar, passing `grammar_vectors.json`.
  - `RaftDeviceTypeFile` - `buildTypeFile`, `typeFileCrc`. Every vector gives the Python's text, byte for byte
    (including the 63.7 KB file of every RaftCore record), and its entries.
  - `RaftDeviceTypeFileManager` - status, table, `deviceRecord` (typeinfo full=1, cached per table generation),
    `pull`, `upload`/`stage`/`check`/`apply`, `push` (stops if the device already has the file or its file changed
    since it was read; dry run; confirm; waits for the restart; verifies CRC and per-entry outcomes). The upload goes
    to `local/devlib.new.json` explicitly, since a bare name goes to the default file system, which can be the SD card.
  - `RaftDeviceManager`: the new status fields and `protected` (types only).
- The dashboard's `TypeFilePanel` uses `DeviceTypeFileManager` (2026-10-25, below).

### Phase 3: early checks

- The grammar (above), and the decode language check (2026-10-25, below).

### Phase 4: the catalogue on Pages (RaftCore)

- `AssembleDeviceTypes.py --pages <dir> --label <version>` and `--pages-index <dir>` (a host test).
- `.github/workflows/pages.yml`: on a push to main (records, scripts, the page), a release, or by hand; builds every
  release from v1.59.0 from its own records (`git archive`), `main` and the index, the landing page
  (`scripts/pages/index.html`) and the app; deploys with `actions/deploy-pages`. Run locally (the same commands): 4
  versions. **Pages must be enabled in the repo settings (Source: GitHub Actions)** before the first deploy.

### Phase 5: other sources and the generated selection (raftjs)

- `RaftDeviceTypeSources`: `mergeDeviceTypeSources`, `resolveDeviceTypeSelection` and `deviceTypeProvenance`,
  passing `selection_vectors.json`.
- `RaftDeviceTypeCatalogue`: `RaftCoreCatalogue` (index, version for a RaftCore version, entries, records, record
  files), `readGitHubSource` (ref to commit with the GitHub API, the tree once per commit, files from
  `raw.githubusercontent.com`, the manifest's `formatVersion` and `minRaftCore`, cached by commit),
  `recordsFromFiles` (folder, record file or catalogue file, with the build's checks), and `deviceTypeLockText` (the
  build's lock, byte for byte).

### Phase 6: the app (raftjs `apps/devtypes`)

- React and Parcel. The model is kept apart from the views. Tabs:
  - **Catalogue**: search, including by address; record detail; add to the type file.
  - **Device**: firmware facts and type file status; devices found; unidentified addresses (`busstatus` identTiming
    `noMatch`) with the catalogue records for them; the type table with per-type policy; read the file back and
    start from it (its `_sources`, or its records as a local source).
  - **Sources**: GitHub sources, local files or folders, import of a project's selection and lock.
  - **Type file**: the selection, entries with what each does and where it is decoded, check on the device, push
    with confirmation.
  - **Export**: a zip laid out as a project, or each file on its own.
- Checked in headless Chrome against a local copy of the site:
  - the catalogue, search, adding a record and the export;
  - phone width, with no horizontal overflow;
  - importing a test selection (part of RaftCore's records, a git source - RaftCore itself at v1.61.0, read live
    from GitHub - Axiom's records as a path source, an exclude and two policies) gave the same type file as
    `AssembleDeviceTypes.py --typefile` (51,108 bytes, CRC `9796`) and the same lock;
  - unpacking the app's export zip as a project and building it with the Python tool gave the same file again, with
    the lock unchanged.
- **Not yet checked:** anything on a device (connect, Device tab, push, pull). Next, on a FeatherS3 or Axiom:
  - connect by Bluetooth and by serial;
  - push a file with a new record for a sensor that isn't identified, and see it identified after the restart;
  - a rejected record is refused; read the file back and start from it;
  - the restart and reconnect over Bluetooth (§10).

### Found on the way

- Every RaftCore record as one type file is now 63,673 bytes, just under the 64 KB default `maxFileBytes`. The
  "all records at runtime" setup (RaftCore plan §3.8) will need a larger limit after a record or two more.

### 2026-10-25

- **Merged:** RaftCore#18 and raftjs#21. RaftCore v1.62.0 was released; the catalogue and the app are on Pages.
- **Release deploys:** the v1.62.0 release's Pages run built, but its deploy was refused ("Tag v1.62.0 is not allowed
  to deploy to github-pages"). The environment only deploys from `main`, and a `release` event runs on the tag. Now
  `release-assets.yml` starts `pages.yml` on `main` (`gh workflow run`, allowed from `GITHUB_TOKEN`), and `pages.yml`
  has no `release` trigger. Until this is merged, v1.62.0 is published by running the workflow by hand.
- **The type file size limit:**
  - It was 64 KB on every board (`DeviceTypeFileLoader::Limits`). The whole file is read into one buffer (in PSRAM
    where there is any) and parsed in place, so the limit guards one large allocation. Every RaftCore record as one
    file was already 63.7 KB.
  - Now the default is 256 KB with PSRAM and 64 KB without, as `typeTable` already is (256 KB / 20 KB of extended
    records). `typeFileLimits.maxFileBytes` still sets another.
  - The Python tools use the same default for the SysType, from its `sdkconfig.defaults` (`CONFIG_SPIRAM=y`; the
    build's merged file for `--fs-image`, the selection files' folders for `--typefile`). `raft devtypes push` uses
    the device's own limit, as before.
  - With no device, the app allows 256 KB and warns above 64 KB.
- **Decode code check in TypeScript:** `RaftDeviceTypeCodeCheck` (`checkDeviceTypeCode`, `checkDeviceTypeRecordCode`)
  gives `PseudocodeHandler.check_code`'s problems, word for word, on the shared `codecheck_vectors.json` (written by
  `make_codecheck_vectors.py`, with RaftCore's records' code). `readGitHubSource` refuses a record with such code, as
  a build refuses one from a git source. The app shows the problems of local records' code.
- **Dashboard `TypeFilePanel`:** on `DeviceTypeFileManager`. Check only, or upload and check, then Apply or Cancel; it
  waits for the restart and verifies. It can also download the device's file.
- **Raft Flasher (`apps/flasher`, published at `flash/` on the Pages site):**
  - esptool-js 0.7.0 over Web Serial.
  - Reads a build folder (or its files) through `flasher_args.json`, as `raft flash` does, or an ESP Web Tools manifest.
  - Shows the partition table and the app's description, checks image sizes against partitions and the chip, and
    writes everything, the firmware only (`--no-fs`) or the file system only, optionally erasing first, with MD5
    verification.
  - Checked: `flashImage.test.ts` (13 tests), Axiom018's real build read correctly, and the page in headless Chrome.
  - **Not yet checked on a board.**
