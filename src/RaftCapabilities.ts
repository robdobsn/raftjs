/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RaftCapabilities
// Layered capability resolution for optional/gated API endpoints.
//
// Combines three layers so the app can avoid sending commands a device does not
// support (which otherwise cause failUnknownAPI + msgTrackTimer retry spam):
//
//   Layer A - static table (closed-world over the gated set), per system type
//             and firmware version. Authored on each RaftSystemType.
//   Layer B - runtime cache (open-world overlay), learned from actual sends
//             this session. Overrides the static table for unknown endpoints.
//   Layer C - firmware self-describe via the "caps" endpoint. Authoritative
//             when present; membership in the list == supported.
//
// The static table also decides whether to call "caps" at all: a type/version
// known not to have it (e.g. old Marty) skips the probe; an unknown/Generic
// device tries it and falls back to A + B when absent.
//
// Rob Dobson 2024
//
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// The only optional, app-initiated endpoints that are gated (closed-world).
// Everything else is always sent. Keys use the wire names; sub-paths are
// reduced to their base endpoint when matched against the caps list.
export const GATED_ENDPOINTS = [
  "caps",
  "pubtopics",
  "datetime",
  "datalog",
  "camera",
  "devman/typeinfo",
  "filelist/local",
  "bledisconnect",
];

// A version bracket. minVersion inclusive, maxVersion exclusive; omit for open.
export interface VersionRange {
  minVersion?: string;
  maxVersion?: string;
}

// Per-system-type capability descriptor (Layer A). Authored on RaftSystemType.
export interface SystemCapabilities {
  // Gated endpoints this type supports, optionally version-gated.
  // `true` = all versions; a range/ranges = only within those versions.
  // Omit `endpoints` entirely to gate nothing statically (fully dynamic, e.g.
  // Generic) - distinct from `endpoints: {}` which denies every gated call.
  endpoints?: Record<string, true | VersionRange | VersionRange[]>;

  // Tuning values, optionally version-bracketed. May be present without
  // `endpoints` (e.g. Generic sets only bleMaxWriteSize).
  tuning?: {
    bleMaxWriteSize?: number | Array<VersionRange & { value: number }>;
  };
}

// Reduce a gated key to the base endpoint name the caps list uses,
// e.g. "devman/typeinfo" -> "devman", "filelist/local" -> "filelist".
function baseEndpoint(endpoint: string): string {
  const slash = endpoint.indexOf("/");
  return slash < 0 ? endpoint : endpoint.substring(0, slash);
}

// Parse the leading major.minor.patch from a version string, ignoring any
// build/suffix (e.g. "1.9.5-6-g367562d-dirty" -> [1,9,5], "v2.1" -> [2,1,0]).
export function parseVersionLite(version: string): [number, number, number] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version ?? "");
  if (!m) {
    return [0, 0, 0];
  }
  return [parseInt(m[1] ?? "0", 10), parseInt(m[2] ?? "0", 10), parseInt(m[3] ?? "0", 10)];
}

// Compare two version-lite strings: negative if a<b, 0 if equal, positive if a>b.
export function compareVersionLite(a: string, b: string): number {
  const va = parseVersionLite(a);
  const vb = parseVersionLite(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) {
      return va[i] - vb[i];
    }
  }
  return 0;
}

// True if version falls within range (minVersion inclusive, maxVersion exclusive).
export function versionInRange(version: string, range: VersionRange): boolean {
  if (range.minVersion !== undefined && compareVersionLite(version, range.minVersion) < 0) {
    return false;
  }
  if (range.maxVersion !== undefined && compareVersionLite(version, range.maxVersion) >= 0) {
    return false;
  }
  return true;
}

/**
 * Resolves whether a gated endpoint is supported, combining the static table
 * (Layer A), the runtime cache (Layer B) and the firmware caps list (Layer C).
 * Seeded at connect from `systemType.capabilities` + `SystemVersion`, cleared on
 * disconnect.
 */
export class RaftCapabilityResolver {
  // Layer A - static table for the connected system type (undefined = Generic)
  private _static: SystemCapabilities | undefined = undefined;
  private _version = "0.0.0";

  // Layer C - authoritative caps list from firmware (null = unavailable)
  private _caps: Set<string> | null = null;

  // Layer B - runtime cache learned from sends this session
  private _runtime = new Map<string, boolean>();

  /**
   * Seed from the static table and firmware version (call at connect).
   */
  seed(capabilities: SystemCapabilities | undefined, systemVersion: string): void {
    this._static = capabilities;
    this._version = systemVersion || "0.0.0";
    this._caps = null;
    this._runtime.clear();
  }

  /**
   * Clear all session-scoped state (call on disconnect).
   */
  reset(): void {
    this._static = undefined;
    this._version = "0.0.0";
    this._caps = null;
    this._runtime.clear();
  }

  /**
   * Whether to call the firmware "caps" endpoint at all. Uses the static
   * table's verdict for "caps" itself: a type/version known not to have it
   * returns false (skip the probe); true/unknown returns true (try it).
   */
  shouldQueryCaps(): boolean {
    return this.staticVerdict("caps") !== false;
  }

  /**
   * Record the result of the caps query. Pass the caps name list on success, or
   * null when caps is unavailable (older firmware) - Layers A + B then apply.
   */
  setCapsResult(capsList: string[] | null): void {
    this._caps = capsList ? new Set(capsList) : null;
  }

  /**
   * True if a firmware caps list is available and authoritative.
   */
  capsAvailable(): boolean {
    return this._caps !== null;
  }

  /**
   * Record the outcome of actually sending a gated endpoint (Layer B). This lets
   * unknown/Generic devices learn support at runtime.
   */
  recordResult(endpoint: string, supported: boolean): void {
    if (GATED_ENDPOINTS.includes(endpoint)) {
      this._runtime.set(endpoint, supported);
    }
  }

  /**
   * Resolve whether an endpoint is supported.
   * @returns true/false when a verdict is known, or undefined when unknown
   *          (caller should send once then record the result via recordResult).
   */
  isSupported(endpoint: string): boolean | undefined {
    // Non-gated endpoints are always allowed
    if (!GATED_ENDPOINTS.includes(endpoint)) {
      return true;
    }
    // Layer C - firmware self-describe is authoritative when present
    if (this._caps !== null) {
      return this._caps.has(baseEndpoint(endpoint));
    }
    // Layer B - runtime cache from prior sends this session
    const cached = this._runtime.get(endpoint);
    if (cached !== undefined) {
      return cached;
    }
    // Layer A - static table for the connected version
    return this.staticVerdict(endpoint);
  }

  /**
   * Resolve the BLE max write size for the connected version, if the static
   * table declares one.
   */
  bleMaxWriteSize(): number | undefined {
    const tuning = this._static?.tuning?.bleMaxWriteSize;
    if (tuning === undefined) {
      return undefined;
    }
    if (typeof tuning === "number") {
      return tuning;
    }
    for (const entry of tuning) {
      if (versionInRange(this._version, entry)) {
        return entry.value;
      }
    }
    return undefined;
  }

  // Layer A verdict: undefined = no static endpoint table (dynamic), false =
  // closed-world deny (table present but endpoint not listed), true = listed and
  // version matches.
  private staticVerdict(endpoint: string): boolean | undefined {
    if (this._static === undefined || this._static.endpoints === undefined) {
      return undefined;
    }
    const spec = this._static.endpoints[endpoint];
    if (spec === undefined) {
      return false;
    }
    if (spec === true) {
      return true;
    }
    const ranges = Array.isArray(spec) ? spec : [spec];
    return ranges.some((r) => versionInRange(this._version, r));
  }
}
