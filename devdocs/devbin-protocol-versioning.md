# Devbin Protocol Versioning & Naming

## Motivation

The current codebase uses `legacy*` / `current*` to distinguish two devbin
record layouts. This is short-lived terminology: as soon as a third
variant ships, today's "current" becomes tomorrow's "legacy" and the
names need to be churned again. The names also conflate two independent
axes — how records are wrapped on the wire (the **envelope**) and how a
record's body is laid out (the **payload format**).

This document defines a stable naming scheme tied to the actual wire
identity of each variant, so future formats slot in cleanly.

## Two Orthogonal Axes

A devbin message is `[msgType:2][envelope?][record][record]...`.

### Axis 1 — Envelope

What sits between the 2-byte transport `msgType` prefix and the first
record. Three variants are observed in the field / supported by code:

| Variant         | Length | Bytes                                          | Notes                                   |
| --------------- | ------ | ---------------------------------------------- | --------------------------------------- |
| `EnvelopeNone`  | 0      | —                                              | Cog v1.9.5: records start immediately   |
| `EnvelopeV1`    | 2      | `magic(0xDB..0xDF)`, `topicIndex`              | Intermediate firmware                   |
| `EnvelopeV2`    | 3      | `magic(0xDB..0xDF)`, `topicIndex`, `seqNum`    | Current firmware                        |

Detection: peek `rxMsg[2]`; if `(byte & 0xF0) === 0xD0` it is an envelope
magic, otherwise `EnvelopeNone`. Distinguishing V1 vs V2 is done by
probing whether `hasValidRecordAt` validates at offset 4 or 5.

### Axis 2 — Record Payload Format

What a single record body looks like after the common header
`[statusBus:1][address:4][devTypeIdx:2]`. Two variants are currently
defined:

| Variant           | Per-record body after common header                                        | Notes                                                |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `DevbinV0Fixed`   | `[sample][sample]...` with each sample fixed-size from typeinfo            | Cog v1.9.5: no `deviceSeq`, no `sampleLen` prefix    |
| `DevbinV1Framed`  | `[deviceSeq:1] [sampleLen:1][sample]...`                                   | Current firmware: length-prefixed per sample         |

Detection per-record: `resolveRecordPayloadFormat` validates that
`sampleLen` prefixes line up with the record length. The probe is cheap
because all the typeinfo needed is already in hand.

### Why keep them separate

The two axes have already drifted independently once: there exists
intermediate firmware that emits `EnvelopeV1` + `DevbinV1Framed`, where
the envelope grew while the payload format stayed put. Coupling them
into a single enum would force every future combination to be encoded
as a new opaque name. Keeping them orthogonal means `EnvelopeV3` and
`DevbinV2*` can be added independently.

## Naming Rules Going Forward

1. **Envelope variants** use `EnvelopeNone` or `EnvelopeV<n>` where
   `<n>` increments by 1 each time the envelope shape changes
   (additional fields, reordering, magic-range expansion).
2. **Payload-format variants** use `Devbin<scheme>V<n><Trait>` where
   - `<n>` increments with each on-wire layout change to the record body
   - `<Trait>` is one short word describing the dominant property:
     `Fixed` (samples sized from typeinfo), `Framed` (length-prefixed),
     later perhaps `Tagged`, `Mixed`, etc.
3. **The magic byte is documentation, not the version selector.** The
   reserved range `0xDB..0xDF` is still accepted as a single class; if
   the firmware ever differentiates within that range it goes into the
   envelope variant name, not the payload format name.
4. **No firmware references in type names.** "Cog v1.9.5" and similar
   stay in comments next to the variant where they apply, not in the
   identifier.
5. **Capability flags are separate from format variants.** Whether the
   peer supports `devman/typeinfo?deviceid=` versus `?bus=&type=` is a
   per-endpoint capability, not part of the devbin format enum, even
   though the two correlate today.

## Mapping from Current Names

| Current symbol / string                | Renamed to                              |
| -------------------------------------- | --------------------------------------- |
| `BinaryRecordPayloadFormat`            | `DevbinPayloadFormat`                   |
| `"legacyRaw"` (string literal)         | `"DevbinV0Fixed"`                       |
| `"lengthPrefixed"` (string literal)    | `"DevbinV1Framed"`                      |
| `legacyDevbinEnvelopeLen` (= 2)        | `envelopeV1Len`                         |
| `devbinEnvelopeLen` (= 3)              | `envelopeV2Len`                         |
| `legacyMsgPos` (local)                 | `envelopeV1RecordPos`                   |
| `currentMsgPos` (local)                | `envelopeV2RecordPos`                   |
| `legacyRecordHeaderLen` (= 7)          | `devbinV0FixedHeaderLen`                |
| `currentRecordHeaderLen` (= 8)         | `devbinV1FramedHeaderLen`               |
| `getLegacyRawSampleLen()`              | `getDevbinV0FixedSampleLen()`           |
| `payloadFormat` / `recordPayloadFormat`| same names, narrowed to new union       |
| comment "legacy raw layout"            | "`DevbinV0Fixed` payload format"        |
| comment "current 3-byte envelope"      | "`EnvelopeV2` (3-byte)"                 |
| comment "legacy 2-byte envelope"       | "`EnvelopeV1` (2-byte)"                 |

`setLegacySoktoMode` on `RaftConnector` / `RaftStreamHandler` is
unrelated (it is about a different protocol — sokto streaming) and
stays as-is.

## Out of Scope

- The capability-cache approach for `devman/typeinfo` URL form. That is
  already implemented as a per-device fallback and is unaffected by this
  renaming.
- Renaming `_devbinEnvelopeSeqNum` and similar instance state that
  refers to actual on-wire fields, not variant identifiers.
- Anything in the dashboard or examples — no devbin format names leak
  out through the public API today.

## Reference: Variant Truth Table

| Firmware seen so far          | Envelope        | Payload          |
| ----------------------------- | --------------- | ---------------- |
| Cog v1.9.5                    | `EnvelopeNone`  | `DevbinV0Fixed`  |
| Intermediate (pre-current)    | `EnvelopeV1`    | `DevbinV1Framed` |
| Current (Axiom018, recent Cog)| `EnvelopeV2`    | `DevbinV1Framed` |

Combinations not observed but legal under the discriminator code:

- `EnvelopeNone` + `DevbinV1Framed`: detected via the "no envelope but
  first record looks length-prefixed" path already present in
  `handleClientMsgBinary`.
- `EnvelopeV*` + `DevbinV0Fixed`: detected via the fallback path that
  validates `legacyRecordHeaderLen` after an envelope.

Both fallback paths remain valid under the renamed types; they are the
reason payload format must be resolved per-record rather than per-message.
