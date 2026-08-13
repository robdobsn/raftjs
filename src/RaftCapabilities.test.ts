import {
  RaftCapabilityResolver,
  SystemCapabilities,
  parseVersionLite,
  compareVersionLite,
  versionInRange,
} from "./RaftCapabilities";

// ===== Version helpers =====

describe("parseVersionLite", () => {
  test("full version with git-describe commit count", () => {
    expect(parseVersionLite("1.9.5-6-g367562d-dirty")).toEqual([1, 9, 5, 6]);
  });
  test("v prefix and missing parts", () => {
    expect(parseVersionLite("v2.1")).toEqual([2, 1, 0, 0]);
  });
  test("plain release has zero commit count", () => {
    expect(parseVersionLite("1.9.5")).toEqual([1, 9, 5, 0]);
  });
  test("empty/garbage -> zeros", () => {
    expect(parseVersionLite("")).toEqual([0, 0, 0, 0]);
    expect(parseVersionLite("unknown")).toEqual([0, 0, 0, 0]);
  });
});

describe("compareVersionLite", () => {
  test("ordering", () => {
    expect(compareVersionLite("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersionLite("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersionLite("1.2.3", "1.2.3")).toBe(0);
  });
  test("git-describe build sorts after its base tag", () => {
    expect(compareVersionLite("1.9.5-6-gabc", "1.9.5")).toBeGreaterThan(0);
    expect(compareVersionLite("1.9.5", "1.9.5-6-gabc")).toBeLessThan(0);
    expect(compareVersionLite("1.9.5-2-gabc", "1.9.5-6-gabc")).toBeLessThan(0);
    expect(compareVersionLite("1.9.6", "1.9.5-6-gabc")).toBeGreaterThan(0);
  });
});

describe("versionInRange", () => {
  test("min inclusive, max exclusive", () => {
    expect(versionInRange("1.5.0", { minVersion: "1.5.0" })).toBe(true);
    expect(versionInRange("1.4.9", { minVersion: "1.5.0" })).toBe(false);
    expect(versionInRange("2.0.0", { maxVersion: "2.0.0" })).toBe(false);
    expect(versionInRange("1.9.9", { maxVersion: "2.0.0" })).toBe(true);
  });
  test("1.9.5-1 bracket excludes the 1.9.5 release, includes dev builds and later", () => {
    expect(versionInRange("1.9.5", { minVersion: "1.9.5-1" })).toBe(false);
    expect(versionInRange("1.9.5-6-g367562d", { minVersion: "1.9.5-1" })).toBe(true);
    expect(versionInRange("1.9.6", { minVersion: "1.9.5-1" })).toBe(true);
  });
});

// ===== Resolver: layered resolution =====

const cogTable: SystemCapabilities = {
  endpoints: {
    caps: true,
    pubtopics: true,
    datetime: true,
    "devman/typeinfo": true,
    bledisconnect: true,
  },
};

const martyTable: SystemCapabilities = {
  endpoints: {
    "filelist/local": true,
    // datetime added only in a hypothetical newer build:
    datetime: { minVersion: "2.0.0" },
  },
};

describe("RaftCapabilityResolver - shouldQueryCaps", () => {
  test("queries caps when static table lists it (Cog)", () => {
    const r = new RaftCapabilityResolver();
    r.seed(cogTable, "1.9.5");
    expect(r.shouldQueryCaps()).toBe(true);
  });
  test("skips caps when static table omits it (old Marty)", () => {
    const r = new RaftCapabilityResolver();
    r.seed(martyTable, "1.3.21");
    expect(r.shouldQueryCaps()).toBe(false);
  });
  test("queries caps when no static table (Generic)", () => {
    const r = new RaftCapabilityResolver();
    r.seed(undefined, "0.0.0");
    expect(r.shouldQueryCaps()).toBe(true);
  });
});

describe("RaftCapabilityResolver - Layer C authoritative", () => {
  test("caps membership wins; sub-paths map to base name", () => {
    const r = new RaftCapabilityResolver();
    r.seed(cogTable, "1.9.5");
    r.setCapsResult(["datetime", "devman", "pubtopics"]);
    expect(r.isSupported("datetime")).toBe(true);
    expect(r.isSupported("devman/typeinfo")).toBe(true); // -> "devman"
    expect(r.isSupported("camera")).toBe(false); // gated, not in caps
    expect(r.isSupported("bledisconnect")).toBe(false); // not in caps list
  });
  test("non-gated endpoints always allowed", () => {
    const r = new RaftCapabilityResolver();
    r.seed(cogTable, "1.9.5");
    r.setCapsResult(["datetime"]);
    expect(r.isSupported("v")).toBe(true);
    expect(r.isSupported("subscription")).toBe(true);
  });
});

describe("RaftCapabilityResolver - Layer A static fallback", () => {
  test("closed-world: listed=true, unlisted=false, version-gated respected", () => {
    const r = new RaftCapabilityResolver();
    r.seed(martyTable, "1.3.21"); // no caps -> Layer A used
    expect(r.isSupported("filelist/local")).toBe(true);
    expect(r.isSupported("pubtopics")).toBe(false); // not listed
    expect(r.isSupported("datetime")).toBe(false); // needs >= 2.0.0
  });
  test("version bracket enables endpoint on newer build", () => {
    const r = new RaftCapabilityResolver();
    r.seed(martyTable, "2.1.0");
    expect(r.isSupported("datetime")).toBe(true);
  });
});

describe("RaftCapabilityResolver - Layer B runtime cache (Generic)", () => {
  test("unknown until sent, then remembered", () => {
    const r = new RaftCapabilityResolver();
    r.seed(undefined, "0.0.0"); // Generic - no static table
    expect(r.isSupported("pubtopics")).toBeUndefined();
    r.recordResult("pubtopics", true);
    expect(r.isSupported("pubtopics")).toBe(true);
    r.recordResult("datetime", false);
    expect(r.isSupported("datetime")).toBe(false);
  });
  test("caps (Layer C) overrides runtime cache", () => {
    const r = new RaftCapabilityResolver();
    r.seed(undefined, "0.0.0");
    r.recordResult("datetime", false);
    r.setCapsResult(["datetime"]);
    expect(r.isSupported("datetime")).toBe(true);
  });
});

describe("RaftCapabilityResolver - reset", () => {
  test("clears all layers", () => {
    const r = new RaftCapabilityResolver();
    r.seed(cogTable, "1.9.5");
    r.setCapsResult(["datetime"]);
    r.reset();
    expect(r.capsAvailable()).toBe(false);
    expect(r.isSupported("datetime")).toBeUndefined(); // no table, no caps, no cache
  });
});

describe("RaftCapabilityResolver - tuning (bleMaxWriteSize)", () => {
  test("scalar tuning value", () => {
    const r = new RaftCapabilityResolver();
    r.seed({ tuning: { bleMaxWriteSize: 244 } }, "1.0.0");
    expect(r.bleMaxWriteSize()).toBe(244);
  });
  test("tuning-only table leaves endpoints fully dynamic", () => {
    const r = new RaftCapabilityResolver();
    r.seed({ tuning: { bleMaxWriteSize: 244 } }, "1.0.0"); // no endpoints
    expect(r.bleMaxWriteSize()).toBe(244);
    expect(r.isSupported("datetime")).toBeUndefined(); // dynamic, not denied
    expect(r.shouldQueryCaps()).toBe(true);
  });
  test("version-bracketed tuning", () => {
    const r = new RaftCapabilityResolver();
    const table: SystemCapabilities = {
      tuning: {
        bleMaxWriteSize: [
          { maxVersion: "2.0.0", value: 182 },
          { minVersion: "2.0.0", value: 244 },
        ],
      },
    };
    r.seed(table, "1.5.0");
    expect(r.bleMaxWriteSize()).toBe(182);
    r.seed(table, "2.1.0");
    expect(r.bleMaxWriteSize()).toBe(244);
  });
  test("no tuning -> undefined", () => {
    const r = new RaftCapabilityResolver();
    r.seed(martyTable, "1.3.21");
    expect(r.bleMaxWriteSize()).toBeUndefined();
  });
});
