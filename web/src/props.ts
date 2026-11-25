// Property presentation for the info box: what kind of value a property
// holds and how to show it, how keys group by shared prefix, and — given the
// whole collection — where one feature's value sits among everyone else's.
// Pure: no DOM and no map, so it's all unit-testable.

import type { Feature } from "geojson";

export type ValueKind =
  | "empty"
  | "boolean"
  | "number"
  | "date"
  | "datetime"
  | "uuid"
  | "url"
  | "text"
  | "json";

// YYYY-MM-DD, optionally with a time (T or space), seconds, fraction and an
// offset of Z, ±HH, ±HHMM or ±HH:MM — what databases and OS downloads emit.
const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2})?)?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// A leading zero before another digit marks a code ("004", "06037"), not a quantity.
const ZERO_PADDED_RE = /^[+-]?0\d/;

/** What a property value is, for choosing how to show it. */
export function kindOf(v: unknown): ValueKind {
  if (v === null || v === undefined) return "empty";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v !== "string") return "json";
  const s = v.trim();
  if (s === "") return "empty";
  const t = TIME_RE.exec(s);
  if (t) return t[4] === undefined ? "date" : "datetime";
  if (UUID_RE.test(s)) return "uuid";
  if (URL_RE.test(s)) return "url";
  return "text";
}

/** An ISO date or datetime as epoch milliseconds, or null. */
export function parseTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = TIME_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac, , sign, oh = "0", om = "0"] = m;
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  if (sign) t -= (sign === "+" ? 1 : -1) * (+oh * 60 + +om) * 60_000;
  return Number.isFinite(t) ? t : null;
}

// Unit suffixes a key can end with (after its last underscore).
const UNITS: Record<string, string> = {
  m: "m",
  m2: "m²",
  m3: "m³",
  km: "km",
  km2: "km²",
  ha: "ha",
  cm: "cm",
  mm: "mm",
  ft: "ft",
  pct: "%",
  percent: "%",
  deg: "°",
};

/** The unit a key's suffix names (`height_m` → m, `area_m2` → m²), or null. */
export function unitFor(key: string): string | null {
  const i = key.lastIndexOf("_");
  if (i <= 0) return null;
  return UNITS[key.slice(i + 1).toLowerCase()] ?? null;
}

export interface Shown {
  text: string;
  unit: string | null;
  kind: ValueKind;
}

/** A value as the info box shows it: verbatim text, plus a unit for numbers. */
export function displayValue(key: string, v: unknown): Shown {
  const kind = kindOf(v);
  if (kind === "empty") {
    const text = v === null || v === undefined ? "null" : v === "" ? "empty string" : "blank";
    return { text, unit: null, kind };
  }
  if (kind === "number") return { text: String(v), unit: unitFor(key), kind };
  if (kind === "json") return { text: JSON.stringify(v), unit: null, kind };
  return { text: String(v), unit: null, kind };
}

/** A value as it goes on the clipboard: strings verbatim, the rest as JSON. */
export function copyText(v: unknown): string {
  if (typeof v === "string") return v;
  return v === undefined ? "" : JSON.stringify(v);
}

/** Does a property match the filter text, by key or by value? */
export function matchesFilter(key: string, v: unknown, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return key.toLowerCase().includes(q) || copyText(v).toLowerCase().includes(q);
}

// --- Grouping ---------------------------------------------------------------

/** Keys that start with an underscore — conventionally system fields. */
export const SYSTEM_PREFIX = "_";

/** What ends a key's namespace: `height_max_m`, OpenStreetMap's `addr:street`. */
const SEPARATOR = /[_:]/;
const LEADING_SEPARATORS = /^[_:]+/;

export interface KeyGroup {
  /** The shared prefix, `_` for underscore keys, null for ungrouped keys. */
  prefix: string | null;
  keys: string[];
}

/** The text before a key's first separator, or null when it has none. */
function namespaceOf(key: string): string | null {
  const i = key.search(SEPARATOR);
  return i > 0 ? key.slice(0, i) : null;
}

/**
 * Group keys by the text before their first `_` or `:`, where two or more
 * keys share it. A key named just that joins its group too (`description`
 * with `description_*`); one that only begins with the same letters doesn't
 * (`SUBUNIT` stays out of `SU_*`). Ungrouped keys come first, then the
 * groups in order of appearance, then the underscore keys.
 */
export function groupKeys(keys: readonly string[]): KeyGroup[] {
  const system = keys.filter((k) => k.startsWith(SYSTEM_PREFIX));
  const rest = keys.filter((k) => !k.startsWith(SYSTEM_PREFIX));

  const counts = new Map<string, number>();
  for (const k of rest) {
    const ns = namespaceOf(k);
    if (ns !== null) counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  const isGroup = (p: string | null): p is string => p !== null && (counts.get(p) ?? 0) >= 2;

  const loose: string[] = [];
  const groups = new Map<string, string[]>();
  for (const k of rest) {
    const prefix = [namespaceOf(k), k].find(isGroup);
    if (prefix === undefined) {
      loose.push(k);
      continue;
    }
    const members = groups.get(prefix) ?? [];
    members.push(k);
    groups.set(prefix, members);
  }

  const out: KeyGroup[] = [];
  if (loose.length) out.push({ prefix: null, keys: loose });
  for (const [prefix, members] of groups) out.push({ prefix, keys: members });
  if (system.length) out.push({ prefix: SYSTEM_PREFIX, keys: system });
  return out;
}

/** A key as shown under its group heading: the prefix and the separators after it dropped. */
export function shortKey(key: string, prefix: string | null): string {
  if (prefix === null || key === prefix || !key.startsWith(prefix)) return key;
  const rest = key.slice(prefix.length).replace(LEADING_SEPARATORS, "");
  return rest === "" ? key : rest;
}

// --- Collection statistics --------------------------------------------------

/** Text keys with at most this many values are shown as categories. */
export const MAX_CATEGORIES = 12;
/** Histogram bins in a distribution. */
export const BINS = 16;
/** Fewer values than this and a rank says nothing worth saying. */
const MIN_RANKED = 5;
/** Share of features at or past a value for it to count as unusual. */
const UNUSUAL = 0.05;

export interface Distribution {
  min: number;
  max: number;
  /** Every present value, ascending. */
  sorted: Float64Array;
  /** Binned in log10 space: all positive, spanning two orders of magnitude. */
  log: boolean;
  /** Feature count per bin. */
  bins: Uint32Array;
}

export interface KeyStats {
  /** Features in the collection. */
  total: number;
  /** Features where this key holds a value (not null, not blank). */
  present: number;
  /** Distinct values among those. */
  distinct: number;
  /** The same value on every feature. */
  constant: boolean;
  /** No feature has a value. */
  allEmpty: boolean;
  /**
   * Distribution of numbers (or numeric strings), when values vary — but
   * not zero-padded codes, or whole numbers under an id's name.
   */
  numeric: Distribution | null;
  /** Distribution of ISO dates, when values vary. */
  temporal: Distribution | null;
  /** Value → count, most common first, for text keys with few, repeated values. */
  categories: Array<[string, number]> | null;
  /**
   * Unspaced strings, or whole numbers under an id's name, nearly all
   * distinct: ids rather than descriptions or quantities.
   */
  identifier: boolean;
  /** Value → count for every value (by its copy text). */
  counts: Map<string, number>;
}

interface Accumulator {
  present: number;
  numbers: number[];
  times: number[];
  allNumeric: boolean;
  allWhole: boolean;
  allTemporal: boolean;
  allUnspacedText: boolean;
  counts: Map<string, number>;
}

// What GIS tools and publishers call a numeric identifier field.
const ID_NAMES = new Set(["id", "fid", "gid", "oid", "objectid", "ogc_fid", "uprn", "usrn"]);

/**
 * Does a key name an identifier — `FID`, `OBJECTID`, `osm_id`, `parentId`,
 * `uprn` — rather than a quantity? Words that merely end in "id" (`paid`,
 * `valid`, `grid`) don't.
 */
export function idNamed(key: string): boolean {
  return ID_NAMES.has(key.toLowerCase()) || /[_:.-]id$/i.test(key) || /[a-z](?:Id|ID)$/.test(key);
}

/** Per-key statistics over every feature's properties. */
export function collectionStats(features: readonly Feature[]): Map<string, KeyStats> {
  const acc = new Map<string, Accumulator>();
  for (const f of features) {
    for (const [key, v] of Object.entries(f.properties ?? {})) {
      if (key === "__fid") continue;
      let a = acc.get(key);
      if (!a) {
        a = {
          present: 0,
          numbers: [],
          times: [],
          allNumeric: true,
          allWhole: true,
          allTemporal: true,
          allUnspacedText: true,
          counts: new Map(),
        };
        acc.set(key, a);
      }
      const kind = kindOf(v);
      if (kind === "empty") continue;
      a.present++;
      const text = copyText(v);
      a.counts.set(text, (a.counts.get(text) ?? 0) + 1);

      const s = typeof v === "string" ? v.trim() : "";
      const n =
        typeof v === "number"
          ? v
          : NUMERIC_RE.test(s) && !ZERO_PADDED_RE.test(s)
            ? Number(s)
            : NaN;
      if (Number.isFinite(n)) {
        a.numbers.push(n);
        if (!Number.isInteger(n)) a.allWhole = false;
      } else {
        a.allNumeric = false;
      }

      const t = kind === "date" || kind === "datetime" ? parseTime(v) : null;
      if (t !== null) a.times.push(t);
      else a.allTemporal = false;

      if (typeof v !== "string" || /\s/.test(v.trim())) a.allUnspacedText = false;
    }
  }

  const total = features.length;
  const out = new Map<string, KeyStats>();
  for (const [key, a] of acc) {
    const distinct = a.counts.size;
    const varies = distinct > 1;
    // Whole numbers under an id's name label features; they don't measure them.
    const numericIds = a.present > 0 && a.allNumeric && a.allWhole && idNamed(key);
    const numeric =
      a.present > 0 && a.allNumeric && varies && !numericIds ? distribution(a.numbers) : null;
    const temporal =
      a.present > 0 && a.allTemporal && !numeric && varies ? distribution(a.times) : null;
    const identifier =
      (a.allUnspacedText || numericIds) &&
      !numeric &&
      !temporal &&
      a.present >= 2 &&
      distinct / a.present >= 0.9;
    const categorical =
      !numeric && !temporal && !identifier && varies && distinct <= MAX_CATEGORIES && distinct <= a.present / 2;
    out.set(key, {
      total,
      present: a.present,
      distinct,
      constant: a.present === total && distinct === 1,
      allEmpty: a.present === 0,
      numeric,
      temporal,
      categories: categorical ? [...a.counts].sort((x, y) => y[1] - x[1]) : null,
      identifier,
      counts: a.counts,
    });
  }
  return out;
}

/** How many features the statistics were taken over. */
export function collectionSize(stats: Map<string, KeyStats>): number {
  return stats.values().next().value?.total ?? 0;
}

export interface Partition {
  /** Set on this feature, and not the same on every feature. */
  varying: string[];
  /** Set to the same value on every feature in the collection. */
  same: string[];
  /** Null or blank on this feature. */
  empty: string[];
}

/**
 * Split a feature's keys three ways for the inspector. In a collection of
 * one, nothing is "the same everywhere": that would fold away every
 * property of a lone pasted feature.
 */
export function partition(
  keys: readonly string[],
  props: Record<string, unknown>,
  stats: Map<string, KeyStats>,
): Partition {
  const comparable = collectionSize(stats) >= 2;
  const out: Partition = { varying: [], same: [], empty: [] };
  for (const key of keys) {
    if (kindOf(props[key]) === "empty") out.empty.push(key);
    else if (comparable && stats.get(key)?.constant) out.same.push(key);
    else out.varying.push(key);
  }
  return out;
}

/**
 * What `key` was on the previous feature, when that differs from `v` (null
 * included). Null when there was no previous feature, it lacked the key, or
 * the value is unchanged — compared by value, so equal objects match.
 */
export function previousValue(
  before: Record<string, unknown> | null,
  key: string,
  v: unknown,
): { value: unknown } | null {
  if (before === null || !(key in before)) return null;
  return copyText(before[key]) === copyText(v) ? null : { value: before[key] };
}

function distribution(values: number[]): Distribution {
  const sorted = Float64Array.from(values).sort();
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const log = min > 0 && max / min >= 100;
  const bins = new Uint32Array(BINS);
  for (const v of sorted) bins[binOf({ min, max, log }, v)]++;
  return { min, max, sorted, log, bins };
}

/** The histogram bin a value falls in. */
export function binOf(d: Pick<Distribution, "min" | "max" | "log">, v: number): number {
  const scale = (x: number) => (d.log ? Math.log10(x) : x);
  const lo = scale(d.min);
  const hi = scale(d.max);
  if (!(hi > lo)) return 0;
  const i = Math.floor(((scale(v) - lo) / (hi - lo)) * BINS);
  return Math.min(BINS - 1, Math.max(0, i));
}

/** How many values sort strictly below `v`, and how many equal it. */
export function rankOf(sorted: Float64Array, v: number): { below: number; equal: number } {
  const bound = (strict: boolean) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (strict ? sorted[mid] < v : sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const below = bound(true);
  return { below, equal: bound(false) - below };
}

/**
 * Where `v` stands in a distribution, in words: "highest", "joint lowest",
 * "higher than 92%" (the share strictly below, rounded down). Dates read
 * "latest", "earlier"… Null for samples too small to rank.
 */
export function standing(d: Distribution, v: number, temporal = false): string | null {
  const n = d.sorted.length;
  if (n < MIN_RANKED) return null;
  const { below, equal } = rankOf(d.sorted, v);
  const [top, bottom, past] = temporal
    ? ["latest", "earliest", "later"]
    : ["highest", "lowest", "higher"];
  const joint = equal > 1 ? "joint " : "";
  if (below + equal === n) return joint + top;
  if (below === 0) return joint + bottom;
  return `${past} than ${Math.floor((below / n) * 100)}%`;
}

/** How many features share this value, out of those with any. */
export function shareOf(s: KeyStats, v: unknown): { count: number; present: number } {
  return { count: s.counts.get(copyText(v)) ?? 0, present: s.present };
}

export interface Standout {
  key: string;
  note: string;
}

/**
 * What's unusual about one feature against its collection: values at either
 * extreme of a distribution, rare categories, and identifiers it shares with
 * another feature. Rarest first — rarity being the share of features alike
 * (as extreme, same category, same id) — and at most `limit` of them.
 */
export function standsOut(
  props: Record<string, unknown>,
  stats: Map<string, KeyStats>,
  limit = 5,
): Standout[] {
  const found: Array<Standout & { rarity: number; order: number }> = [];
  let order = 0;
  for (const [key, v] of Object.entries(props)) {
    order++;
    const s = stats.get(key);
    if (!s || kindOf(v) === "empty" || s.present < MIN_RANKED) continue;

    const dist = s.numeric ?? s.temporal;
    if (dist) {
      const x = s.numeric ? Number(v) : parseTime(v);
      if (x === null || !Number.isFinite(x)) continue;
      const { below, equal } = rankOf(dist.sorted, x);
      const n = dist.sorted.length;
      const rarity = Math.min((below + equal) / n, (n - below) / n);
      const note = standing(dist, x, !s.numeric);
      if (rarity <= UNUSUAL && note) found.push({ key, note, rarity, order });
      continue;
    }
    const { count, present } = shareOf(s, v);
    if (s.categories && count / present <= UNUSUAL) {
      found.push({ key, note: `${count} of ${present}`, rarity: count / present, order });
    } else if (s.identifier && count > 1) {
      found.push({ key, note: `shared by ${count} features`, rarity: count / present, order });
    }
  }
  return found
    .sort((a, b) => a.rarity - b.rarity || a.order - b.order)
    .slice(0, limit)
    .map(({ key, note }) => ({ key, note }));
}
