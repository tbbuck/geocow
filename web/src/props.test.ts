import { describe, it, expect } from "vitest";
import type { Feature } from "geojson";

import {
  binOf,
  collectionSize,
  collectionStats,
  copyText,
  displayValue,
  groupKeys,
  kindOf,
  matchesFilter,
  parseTime,
  partition,
  previousValue,
  shareOf,
  shortKey,
  standing,
  standsOut,
  unitFor,
} from "./props";

const feature = (properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [-0.15, 51.5] },
  properties,
});

describe("kindOf", () => {
  it("treats null, undefined and blank strings as empty", () => {
    expect(kindOf(null)).toBe("empty");
    expect(kindOf(undefined)).toBe("empty");
    expect(kindOf("")).toBe("empty");
    expect(kindOf("   ")).toBe("empty");
  });

  it("recognises booleans and numbers", () => {
    expect(kindOf(true)).toBe("boolean");
    expect(kindOf(0)).toBe("number");
    expect(kindOf(-12.5)).toBe("number");
  });

  it("recognises ISO dates, and datetimes with a space or T and any offset", () => {
    expect(kindOf("2004-11-08")).toBe("date");
    expect(kindOf("2026-11-02 19:24:25.184921+00")).toBe("datetime");
    expect(kindOf("2025-02-10T00:00:00Z")).toBe("datetime");
    expect(kindOf("2025-02-10T09:30+01:00")).toBe("datetime");
  });

  it("recognises UUIDs and http(s) URLs", () => {
    expect(kindOf("5dc7c248-65ac-48b7-8463-d15c89111b87")).toBe("uuid");
    expect(kindOf("https://example.com/a?b=1")).toBe("url");
  });

  it("keeps numeric-looking and code-like strings as text", () => {
    expect(kindOf("153801")).toBe("text");
    expect(kindOf("osgb1000005426958")).toBe("text");
    expect(kindOf("2004")).toBe("text");
  });

  it("treats objects and arrays as json", () => {
    expect(kindOf({ a: 1 })).toBe("json");
    expect(kindOf([1, 2])).toBe("json");
  });
});

describe("unitFor", () => {
  it("reads a unit from the key's last underscore segment", () => {
    expect(unitFor("height_relativemax_m")).toBe("m");
    expect(unitFor("geometry_area_m2")).toBe("m²");
    expect(unitFor("volume_m3")).toBe("m³");
    expect(unitFor("length_KM")).toBe("km");
    expect(unitFor("site_ha")).toBe("ha");
    expect(unitFor("cover_pct")).toBe("%");
    expect(unitFor("slope_deg")).toBe("°");
  });

  it("finds none without a recognised suffix", () => {
    expect(unitFor("name")).toBeNull();
    expect(unitFor("_run_id")).toBeNull();
    expect(unitFor("_m")).toBeNull();
    expect(unitFor("team_ms")).toBeNull();
  });
});

describe("displayValue", () => {
  it("keeps a number's full precision and adds the key's unit", () => {
    expect(displayValue("geometry_area_m2", 8605.439)).toEqual({
      text: "8605.439",
      unit: "m²",
      kind: "number",
    });
  });

  it("puts no unit on a string, even under a unit-suffixed key", () => {
    expect(displayValue("height_m", "tall").unit).toBeNull();
  });

  it("names null, the empty string and blanks rather than showing nothing", () => {
    expect(displayValue("status", null).text).toBe("null");
    expect(displayValue("status", "").text).toBe("empty string");
    expect(displayValue("status", "  ").text).toBe("blank");
  });

  it("writes objects and arrays as compact JSON", () => {
    expect(displayValue("tags", { a: [1, 2] }).text).toBe('{"a":[1,2]}');
  });
});

describe("copyText", () => {
  it("copies strings verbatim and everything else as JSON", () => {
    expect(copyText("Hotel / Motel")).toBe("Hotel / Motel");
    expect(copyText(40.6)).toBe("40.6");
    expect(copyText(null)).toBe("null");
    expect(copyText(false)).toBe("false");
    expect(copyText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("parseTime", () => {
  it("reads a date as UTC midnight", () => {
    expect(parseTime("2004-11-08")).toBe(Date.UTC(2004, 10, 8));
  });

  it("applies offsets, including a bare +HH", () => {
    expect(parseTime("2026-11-02 19:24:25.184921+00")).toBe(
      Date.UTC(2026, 10, 2, 19, 24, 25, 185),
    );
    expect(parseTime("2025-02-10T09:30+01:00")).toBe(Date.UTC(2025, 1, 10, 8, 30));
  });

  it("rejects anything that is not an ISO date", () => {
    expect(parseTime("08/11/2004")).toBeNull();
    expect(parseTime(20041108)).toBeNull();
  });
});

describe("groupKeys", () => {
  const NGD = [
    "_ingested_at",
    "_run_id",
    "address_classificationcode",
    "address_primarydescription",
    "changetype",
    "description",
    "description_capturemethod",
    "description_updatedate",
    "height_absolutemax_m",
    "height_relativemax_m",
    "osid",
    "oslandcover_capturemethod",
    "oslandcover_updatedate",
    "oslandcovertiera",
    "oslandcovertierb",
    "toid",
    "versiondate",
  ];

  it("groups keys that share a prefix before their first underscore", () => {
    const groups = groupKeys(NGD);
    expect(groups.find((g) => g.prefix === "height")?.keys).toEqual([
      "height_absolutemax_m",
      "height_relativemax_m",
    ]);
  });

  it("pulls in keys that start with a group's prefix, the bare prefix included", () => {
    const groups = groupKeys(NGD);
    expect(groups.find((g) => g.prefix === "oslandcover")?.keys).toEqual([
      "oslandcover_capturemethod",
      "oslandcover_updatedate",
      "oslandcovertiera",
      "oslandcovertierb",
    ]);
    expect(groups.find((g) => g.prefix === "description")?.keys).toEqual([
      "description",
      "description_capturemethod",
      "description_updatedate",
    ]);
  });

  it("puts ungrouped keys first and underscore keys last, groups in order of appearance", () => {
    const groups = groupKeys(NGD);
    expect(groups.map((g) => g.prefix)).toEqual([
      null,
      "address",
      "description",
      "height",
      "oslandcover",
      "_",
    ]);
    expect(groups[0].keys).toEqual(["changetype", "osid", "toid", "versiondate"]);
    expect(groups[groups.length - 1].keys).toEqual(["_ingested_at", "_run_id"]);
  });

  it("leaves a prefix that only one key uses ungrouped", () => {
    expect(groupKeys(["name", "pop_total", "area"])).toEqual([
      { prefix: null, keys: ["name", "pop_total", "area"] },
    ]);
  });

  it("joins the most specific group a key starts with", () => {
    const groups = groupKeys(["os_a", "os_b", "osland_a", "osland_b", "oslandx"]);
    expect(groups.find((g) => g.prefix === "osland")?.keys).toEqual([
      "osland_a",
      "osland_b",
      "oslandx",
    ]);
  });

  it("returns nothing for no keys", () => {
    expect(groupKeys([])).toEqual([]);
  });
});

describe("shortKey", () => {
  it("drops the group prefix and the underscore after it", () => {
    expect(shortKey("height_relativemax_m", "height")).toBe("relativemax_m");
    expect(shortKey("oslandcovertiera", "oslandcover")).toBe("tiera");
    expect(shortKey("_run_id", "_")).toBe("run_id");
  });

  it("keeps the key whole when ungrouped or equal to the prefix", () => {
    expect(shortKey("description", "description")).toBe("description");
    expect(shortKey("osid", null)).toBe("osid");
  });
});

describe("collectionStats", () => {
  const heights = [3, 5, 5, 8, 12, 15, 20, 40, 41, 65.6];
  const features = heights.map((h, i) =>
    feature({
      height_m: h,
      use: i < 7 ? "Residential" : i < 9 ? "Commercial" : "Hotel",
      theme: "Buildings",
      gone: null,
      osid: i === 3 ? "id-2" : `id-${i}`,
      captured: `20${10 + i}-01-0${1 + (i % 9)}`,
      area_m2: 10 ** (1 + i / 3),
      sparse: i < 2 ? "x" : null,
      note: `free text ${i}`,
    }),
  );
  const stats = collectionStats(features);

  it("counts presence and distinct values, ignoring empties", () => {
    const s = stats.get("sparse")!;
    expect(s.total).toBe(10);
    expect(s.present).toBe(2);
    expect(s.distinct).toBe(1);
    expect(s.constant).toBe(false);
  });

  it("marks one value on every feature constant, and all-empty keys as such", () => {
    expect(stats.get("theme")!.constant).toBe(true);
    expect(stats.get("gone")!.allEmpty).toBe(true);
    expect(stats.get("gone")!.constant).toBe(false);
  });

  it("builds a numeric distribution over all-number keys", () => {
    const d = stats.get("height_m")!.numeric!;
    expect(d.min).toBe(3);
    expect(d.max).toBe(65.6);
    expect(Array.from(d.sorted)).toEqual(heights);
    expect(d.log).toBe(false);
    expect(d.bins.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("bins on a log scale when values span two orders of magnitude", () => {
    expect(stats.get("area_m2")!.numeric!.log).toBe(true);
  });

  it("builds a time distribution over ISO dates", () => {
    const s = stats.get("captured")!;
    expect(s.numeric).toBeNull();
    expect(s.temporal!.min).toBe(Date.UTC(2010, 0, 1));
    expect(s.identifier).toBe(false);
  });

  it("lists categories by count for text keys with few values", () => {
    expect(stats.get("use")!.categories).toEqual([
      ["Residential", 7],
      ["Commercial", 2],
      ["Hotel", 1],
    ]);
    expect(stats.get("note")!.categories).toBeNull();
  });

  it("spots identifiers, tolerating a duplicate", () => {
    expect(stats.get("osid")!.identifier).toBe(true);
    expect(stats.get("note")!.identifier).toBe(false); // has spaces
    expect(shareOf(stats.get("osid")!, "id-2")).toEqual({ count: 2, present: 10 });
  });

  it("ignores the map's internal __fid", () => {
    const withFid = collectionStats([feature({ __fid: 0, a: 1 })]);
    expect(withFid.has("__fid")).toBe(false);
  });
});

describe("binOf", () => {
  it("spreads a linear range over the bins, clamping the top value into the last", () => {
    const d = { min: 0, max: 16, log: false };
    expect(binOf(d, 0)).toBe(0);
    expect(binOf(d, 8)).toBe(8);
    expect(binOf(d, 16)).toBe(15);
  });

  it("bins in log10 space when the distribution is logarithmic", () => {
    const d = { min: 1, max: 10_000, log: true };
    expect(binOf(d, 100)).toBe(8);
  });
});

describe("standing", () => {
  const dist = (values: number[]) =>
    collectionStats(values.map((v) => feature({ v }))).get("v")!.numeric!;

  it("names the extremes, and ties at them", () => {
    const d = dist([1, 2, 3, 4, 5, 6]);
    expect(standing(d, 6)).toBe("highest");
    expect(standing(d, 1)).toBe("lowest");
    expect(standing(dist([1, 2, 3, 4, 6, 6]), 6)).toBe("joint highest");
  });

  it("gives the share of values strictly below, rounded down", () => {
    const d = dist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(standing(d, 8)).toBe("higher than 70%");
  });

  it("speaks of dates as earlier and later", () => {
    const t = collectionStats(
      ["2001-01-01", "2002-01-01", "2003-01-01", "2004-01-01", "2005-01-01"].map((v) =>
        feature({ v }),
      ),
    ).get("v")!.temporal!;
    expect(standing(t, Date.UTC(2005, 0, 1), true)).toBe("latest");
    expect(standing(t, Date.UTC(2003, 0, 1), true)).toBe("later than 40%");
  });

  it("says nothing about samples too small to rank", () => {
    expect(standing(dist([1, 2, 3]), 3)).toBeNull();
  });
});

describe("standsOut", () => {
  const n = 40;
  const features = Array.from({ length: n }, (_, i) =>
    feature({
      height_m: i,
      use: i === 0 ? "Hotel" : "Residential",
      toid: i === 1 ? "osgb0" : `osgb${i}`,
      plain: i % 4,
    }),
  );
  const stats = collectionStats(features);

  it("picks extremes, rare categories and duplicated identifiers, rarest first", () => {
    // Rarity is the share of features alike: as extreme, same category, same
    // id. Ties keep property order.
    const notes = standsOut(features[0].properties!, stats);
    expect(notes).toEqual([
      { key: "height_m", note: "lowest" },
      { key: "use", note: "1 of 40" },
      { key: "toid", note: "shared by 2 features" },
    ]);
  });

  it("passes over features with nothing unusual", () => {
    expect(standsOut(features[20].properties!, stats)).toEqual([]);
  });

  it("keeps to the limit", () => {
    expect(standsOut(features[0].properties!, stats, 1)).toHaveLength(1);
  });
});

describe("collectionSize", () => {
  it("is the feature count the statistics were taken over", () => {
    expect(collectionSize(collectionStats([feature({ a: 1 }), feature({ a: 2 })]))).toBe(2);
  });

  it("is zero with no statistics", () => {
    expect(collectionSize(new Map())).toBe(0);
  });
});

describe("partition", () => {
  const features = [
    feature({ use: "Hotel", theme: "Buildings", gone: null, h: 1 }),
    feature({ use: "Flat", theme: "Buildings", gone: null, h: null }),
  ];
  const stats = collectionStats(features);

  it("splits keys into varying, the same on every feature, and empty on this one", () => {
    const props = features[1].properties!;
    expect(partition(Object.keys(props), props, stats)).toEqual({
      varying: ["use"],
      same: ["theme"],
      empty: ["gone", "h"],
    });
  });

  it("calls nothing the same everywhere in a collection of one", () => {
    const one = collectionStats([features[0]]);
    const props = features[0].properties!;
    expect(partition(Object.keys(props), props, one)).toEqual({
      varying: ["use", "theme", "h"],
      same: [],
      empty: ["gone"],
    });
  });

  it("counts a key the statistics never saw as varying", () => {
    expect(partition(["extra"], { extra: 1 }, stats).varying).toEqual(["extra"]);
  });
});

describe("previousValue", () => {
  it("gives the previous feature's value when it differs", () => {
    expect(previousValue({ h: 40.6 }, "h", 41.1)).toEqual({ value: 40.6 });
  });

  it("counts a change to or from null", () => {
    expect(previousValue({ d: "Hotel" }, "d", null)).toEqual({ value: "Hotel" });
    expect(previousValue({ d: null }, "d", "Hotel")).toEqual({ value: null });
  });

  it("says nothing when unchanged, absent before, or with no previous feature", () => {
    expect(previousValue({ h: 41.1 }, "h", 41.1)).toBeNull();
    expect(previousValue({}, "h", 41.1)).toBeNull();
    expect(previousValue(null, "h", 41.1)).toBeNull();
  });

  it("compares by value, so equal objects are unchanged", () => {
    expect(previousValue({ t: { a: [1] } }, "t", { a: [1] })).toBeNull();
  });
});

describe("matchesFilter", () => {
  it("matches keys and values, case-insensitively", () => {
    expect(matchesFilter("height_relativemax_m", 40.6, "HEIGHT")).toBe(true);
    expect(matchesFilter("use", "Hotel / Motel", "motel")).toBe(true);
    expect(matchesFilter("use", "Hotel", "flat")).toBe(false);
  });

  it("matches everything when blank", () => {
    expect(matchesFilter("a", null, "  ")).toBe(true);
  });
});
