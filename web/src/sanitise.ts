// Tidying up pasted geometry.
//
// What lands in the paste box is rarely what left the database. It has been
// through a terminal, a CLI table formatter, Slack, or all three, and arrives
// wrapped across lines, fenced in column rules, or carrying typographic
// quotes. This module puts it back together *before* it reaches the parser, so
// the user sees a map instead of "failed to parse WKT".
//
// It also decides how the result should be parsed: one geometry that happened
// to contain newlines ("single"), or genuinely one geometry per line ("lines",
// i.e. WKT-per-line or NDJSON), which needs the line-aware endpoint.

export type PasteMode = "single" | "lines";

export interface SanitisedPaste {
  /** The cleaned text to parse. */
  text: string;
  /** Whether to parse it as one document or line-by-line. */
  mode: PasteMode;
  /** Human-readable summary of what was cleaned, for the status line. */
  notes: string[];
}

/** WKT type keywords, including the curved and PostGIS-adjacent ones. */
const WKT_TYPES =
  "POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|" +
  "GEOMETRYCOLLECTION|CIRCULARSTRING|COMPOUNDCURVE|CURVEPOLYGON|MULTICURVE|" +
  "MULTISURFACE|TRIANGLE|TIN|POLYHEDRALSURFACE";

const WKT_START = new RegExp(`^(${WKT_TYPES})\\s*(Z|M|ZM)?\\s*(\\(|EMPTY\\b)`, "i");

/** Column rules and box-drawing characters, as a character class body. */
const BORDER_CHARS = "-+=_~*─━═╌╍│┃║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬<>";

const BORDER_RE = new RegExp(`^[${BORDER_CHARS}\\s]+$`);
const EDGE_PIPE_RE = /^[|│┃]+\s*|\s*[|│┃]+$/g;

/** PostGIS/EWKT prefix: `SRID=27700;POINT(...)`. The WKT parser rejects it. */
const SRID_RE = /^SRID\s*=\s*\d+\s*;\s*/i;

/**
 * Character-level normalisation: line endings, the space-like characters that
 * web and word processors substitute, and the invisibles that ride along with
 * a copy from a rendered page.
 */
function normaliseChars(input: string): string {
  return (
    input
      .replace(/\r\n?/g, "\n")
      // NBSP, narrow NBSP, thin/en/em spaces → a plain space.
      .replace(/[      ]/g, " ")
      // Zero-width space/joiners and the BOM → gone.
      .replace(/[​‌‍﻿]/g, "")
      // Typographic quotes → their ASCII equivalents.
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      // En/em dashes sometimes replace the minus sign in "smart" editors.
      .replace(/[‒–—−](?=\d)/g, "-")
  );
}

/** True if `line` is nothing but column rules / box drawing. */
function isBorder(line: string): boolean {
  return (
    line.length > 0 &&
    BORDER_RE.test(line) &&
    // A line of pure whitespace isn't a border, and `(),` shouldn't count.
    new RegExp(`[${BORDER_CHARS}]`).test(line)
  );
}

/** True if `line` could be part of a geometry rather than table furniture. */
function couldBeGeometry(line: string): boolean {
  return /[0-9]/.test(line) || /[()]/.test(line);
}

/** True if `line` is a complete, self-contained geometry. */
function isCompleteGeometry(line: string): boolean {
  if (line.startsWith("{") || line.startsWith("[")) {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }
  if (!WKT_START.test(line)) return false;
  return balanced(line);
}

/**
 * True when `text` is several complete geometries, one per line (WKT-per-line
 * or NDJSON) rather than a single document. Callers use this to choose the
 * line-aware parse endpoint; {@link sanitisePaste} uses it to decide whether
 * newlines are structure (keep) or an artefact of wrapping (join).
 */
export function looksLineDelimited(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 1 && lines.every(isCompleteGeometry);
}

// ---------------------------------------------------------------------------
// Reassembling numbers broken by a hard wrap
// ---------------------------------------------------------------------------
//
// A terminal wrapping at the window edge inserts a newline with no whitespace,
// which can land in the middle of a number. A wrap at a space between x and y
// looks identical once the line is trimmed: digits at the end of one line,
// digits at the start of the next.
//
// The coordinates settle it. Within one geometry every number is the same
// shape — National Grid eastings and northings have six digits before the
// point, lon/lat has one or two — so a fragment stands out: "88" or "5252"
// where everything else is six digits, or a dangling "525200." that is not a
// number at all. Compare the two candidate readings against the numbers that
// *can't* be fragments (the ones sitting inside a line), and the right one is
// obvious.

/** A complete number. A bare `.5` or a trailing `12.` is a fragment, not one. */
const WHOLE_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** The token a line ends with, when the line ends mid-number-ish. */
const TRAILING_NUMBER = /[+-]?[\d.]+$/;
/** The token a line starts with, when it starts mid-number-ish. */
const LEADING_NUMBER = /^[+-]?[\d.]+/;

/** Digits before and after the decimal point, ignoring any sign. */
function digitCounts(token: string): { int: number; dec: number } {
  const [whole, fraction = ""] = token.replace(/^[+-]/, "").split(".");
  return { int: whole.length, dec: fraction.length };
}

interface Range {
  min: number;
  max: number;
}
interface NumberShape {
  int: Range;
  dec: Range;
}

const range = (values: number[]): Range => ({
  min: Math.min(...values),
  max: Math.max(...values),
});

/**
 * The shape the geometry's numbers actually use — how many digits either side
 * of the point — learned only from tokens that cannot themselves be
 * fragments. `null` when there aren't enough of them to be worth trusting.
 *
 * Both halves matter. Six-digit National Grid coordinates are given away by
 * the integer side; lon/lat, where "‑1.52" and "35" are both plausible
 * integer lengths, is given away by the decimals (everything else has four).
 */
function learnShape(lines: string[]): NumberShape | null {
  const safe: string[] = [];
  for (const line of lines) {
    const tokens = line.match(/[+-]?\d[\d.]*/g) ?? [];
    for (const [i, token] of tokens.entries()) {
      // Skip the first and last token of a line: those are the only ones a
      // wrap could have cut in half, so they can't be used as evidence.
      const atEdge =
        (i === 0 && LEADING_NUMBER.test(line)) ||
        (i === tokens.length - 1 && TRAILING_NUMBER.test(line));
      if (!atEdge && WHOLE_NUMBER.test(token)) safe.push(token);
    }
  }
  if (safe.length < 2) return null;
  const counts = safe.map(digitCounts);
  return {
    int: range(counts.map((c) => c.int)),
    dec: range(counts.map((c) => c.dec)),
  };
}

const within = (n: number, r: Range) => n >= r.min && n <= r.max;

/** Is `token` a whole number of the shape this geometry uses? */
function inFamily(token: string, shape: NumberShape | null): boolean {
  if (!WHOLE_NUMBER.test(token)) return false;
  if (!shape) return true;
  const { int, dec } = digitCounts(token);
  return within(int, shape.int) && within(dec, shape.dec);
}

/**
 * What belongs between two lines a wrap separated: `""` when the break cut a
 * number in half, `" "` when it fell between two of them.
 */
export function bridgeBetween(
  prev: string,
  next: string,
  shape: NumberShape | null,
): "" | " " {
  const before = prev.match(TRAILING_NUMBER)?.[0];
  const after = next.match(LEADING_NUMBER)?.[0];
  // A line ending in `,` or `(` was never cut mid-number.
  if (!before || !after) return " ";

  const glued = before + after;
  if (!WHOLE_NUMBER.test(glued)) return " ";

  // A half that isn't a number on its own — "525200." or ".9972" — can only
  // be part of the one next door. No statistics required.
  if (!WHOLE_NUMBER.test(before) || !WHOLE_NUMBER.test(after)) return "";

  // Both halves stand on their own and look like every other coordinate —
  // that's a wrap at a space, not through a number.
  if (inFamily(before, shape) && inFamily(after, shape)) return " ";

  return inFamily(glued, shape) ? "" : " ";
}

/**
 * The comma-separated coordinate groups in `text`, with the count of numbers
 * in each. In well-formed WKT every group holds the same number of ordinates
 * — two for XY — which is the second, structural signal: a group holding
 * three numbers where its neighbours hold two proves a wrap cut one in half,
 * even when the digits alone look plausible.
 */
interface CoordinateGroup {
  start: number;
  end: number;
  numbers: number;
}

function coordinateGroups(text: string): CoordinateGroup[] {
  const groups: CoordinateGroup[] = [];
  let start = 0;
  let numbers = 0;
  let inNumber = false;

  const flush = (end: number) => {
    if (numbers > 0) groups.push({ start, end, numbers });
    numbers = 0;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const startsNumber = !inNumber && /[-+0-9.]/.test(ch);
    if (startsNumber) {
      inNumber = true;
      numbers++;
      continue;
    }
    if (inNumber && /[0-9.]/.test(ch)) continue;
    inNumber = false;
    if (ch === "(" || ch === ")" || ch === ",") {
      flush(i);
      start = i + 1;
    }
  }
  flush(text.length);
  return groups;
}

/**
 * How many ordinates each coordinate should have. WKT says so itself — the
 * dimensionality is declared in the type keyword — so this is read, not
 * guessed.
 *
 * Failing that (no recognisable keyword), fall back to the smallest group:
 * a break can only ever *add* to a group's count, since splitting a number
 * turns one into two and never moves anything across a comma. Every group
 * therefore holds at least the true arity, and the untouched ones hold
 * exactly it. (The mode is the wrong statistic: wrap tightly enough and the
 * broken groups outnumber the intact ones.)
 */
function expectedArity(text: string, counts: number[]): number | null {
  const declared = text.match(new RegExp(`^(${WKT_TYPES})\\s*(ZM|Z|M)?`, "i"));
  if (declared) {
    switch (declared[2]?.toUpperCase()) {
      case "ZM":
        return 4;
      case "Z":
      case "M":
        return 3;
      default:
        return 2;
    }
  }
  return counts.length < 2 ? null : Math.min(...counts);
}

/**
 * Rebuild one geometry from the lines a wrap broke it into, deciding at each
 * break whether it fell between two numbers or through the middle of one.
 *
 * Two passes, because neither signal is sufficient alone. The digit shapes
 * catch a split inside a lone coordinate pair, where there's no structure to
 * compare against ("POINT(525217.19" / "88)"). The group arity catches splits
 * in data whose digits are too uniform to distinguish, which is what happens
 * when the wrap is tight enough that every number lands on a line edge.
 */
function reassemble(lines: string[]): { text: string; repaired: number } {
  if (lines.length === 1) return { text: lines[0], repaired: 0 };

  const shape = learnShape(lines);
  const bridges = lines
    .slice(1)
    .map((line, i) => bridgeBetween(lines[i], line, shape));

  const build = () => {
    const offsets: number[] = [];
    let text = lines[0];
    for (let i = 1; i < lines.length; i++) {
      offsets.push(text.length);
      text += bridges[i - 1] + lines[i];
    }
    return { text, offsets };
  };

  let { text, offsets } = build();

  // Structural pass: a group with more ordinates than its neighbours must
  // contain a number that a break split in two.
  const groups = coordinateGroups(text);
  const expected = expectedArity(text, groups.map((g) => g.numbers));
  if (expected !== null) {
    let changed = false;
    for (const group of groups) {
      const excess = group.numbers - expected;
      if (excess <= 0) continue;

      // Which breaks inside this group could be a split number?
      const candidates: number[] = [];
      for (let i = 0; i < bridges.length; i++) {
        if (bridges[i] !== " ") continue;
        if (offsets[i] < group.start || offsets[i] >= group.end) continue;
        const glued =
          (lines[i].match(TRAILING_NUMBER)?.[0] ?? "") +
          (lines[i + 1].match(LEADING_NUMBER)?.[0] ?? "");
        if (WHOLE_NUMBER.test(glued)) candidates.push(i);
      }
      if (candidates.length === 0) continue;

      // The group holds more ordinates than the geometry declares, so a break
      // in it must be a split number. With exactly as many candidates as
      // there is excess, that settles it outright; with more, the digit
      // shapes pick which ones.
      const chosen =
        candidates.length === excess
          ? candidates
          : candidates
              .filter((i) =>
                inFamily(
                  (lines[i].match(TRAILING_NUMBER)?.[0] ?? "") +
                    (lines[i + 1].match(LEADING_NUMBER)?.[0] ?? ""),
                  shape,
                ),
              )
              .slice(0, excess);

      for (const i of chosen) {
        bridges[i] = "";
        changed = true;
      }
    }
    if (changed) ({ text, offsets } = build());
  }

  return { text, repaired: bridges.filter((b) => b === "").length };
}

/** Parenthesis balance — a wrapped WKT fragment fails this, a whole one passes. */
function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Strip matching wrapping quotes, a trailing `;`, and a trailing `,`. */
function unwrap(text: string, notes: string[]): string {
  let out = text.trim();
  let changed = false;

  for (;;) {
    const before = out;
    if (out.length > 1 && (out.startsWith('"') || out.startsWith("'"))) {
      const q = out[0];
      if (out.endsWith(q)) out = out.slice(1, -1).trim();
    }
    // A row copied out of a JSON array or SQL script drags its separator along.
    if (out.endsWith(";") || out.endsWith(",")) out = out.slice(0, -1).trim();
    if (out === before) break;
    changed = true;
  }

  if (changed) notes.push("removed surrounding quotes/punctuation");
  return out;
}

/**
 * Clean pasted text and decide how it should be parsed.
 *
 * Joining wrapped lines assumes the break landed on whitespace, which is what
 * a terminal soft-wrap and a copied SQL cell both do. A break *inside* a
 * number can't be told apart from a legitimate `x y` pair split across lines,
 * so this joins with a space and leaves that (rarer) case to fail loudly.
 */
export function sanitisePaste(raw: string): SanitisedPaste {
  const notes: string[] = [];
  const normalised = normaliseChars(raw);
  if (!normalised.trim()) return { text: "", mode: "single", notes };

  let sawBorder = false;
  let sawPipe = false;
  let sawSrid = false;

  const lines: string[] = [];
  for (const original of normalised.split("\n")) {
    let line = original.trim();
    if (!line) continue;

    const depiped = line.replace(EDGE_PIPE_RE, "").trim();
    if (depiped !== line) {
      sawPipe = true;
      line = depiped;
    }

    // psql wraps a wide column by parking a `+` in the gutter.
    const decontinued = line.replace(/\s+\+$/, "");
    if (decontinued !== line) line = decontinued;

    if (!line) continue;
    if (isBorder(line)) {
      sawBorder = true;
      continue;
    }

    const desrided = line.replace(SRID_RE, "");
    if (desrided !== line) {
      sawSrid = true;
      line = desrided;
    }

    lines.push(line);
  }

  // Inside a table, a cell with neither digits nor parentheses is a column
  // heading, not geometry. Outside one, keep everything: an unparenthesised
  // fragment is still part of whatever we're about to join up.
  const tableLike = sawPipe || sawBorder;
  const kept = tableLike ? lines.filter(couldBeGeometry) : lines;

  if (sawBorder || sawPipe) notes.push("removed table borders");
  if (sawSrid) notes.push("removed SRID prefix");

  if (kept.length === 0) return { text: "", mode: "single", notes };

  // Several complete geometries: keep them apart and parse line-by-line.
  if (looksLineDelimited(kept.join("\n"))) {
    notes.push(`${kept.length} geometries, one per line`);
    return { text: kept.join("\n"), mode: "lines", notes };
  }

  if (kept.length > 1) notes.push(`joined ${kept.length} wrapped lines`);

  // Rejoin, deciding at each break whether it fell between two numbers or
  // through the middle of one.
  const { text: joined, repaired } = reassemble(kept);
  if (repaired > 0) {
    notes.push(`repaired ${repaired} split number${repaired === 1 ? "" : "s"}`);
  }

  let text = unwrap(joined, notes);

  if (text.startsWith("{") || text.startsWith("[")) {
    // Re-serialising is the safe way to normalise JSON whitespace: collapsing
    // runs by regex would also rewrite the insides of string properties.
    try {
      text = JSON.stringify(JSON.parse(text));
    } catch {
      // Not valid JSON — leave it be and let the parser produce the real error.
    }
  } else {
    text = text
      .replace(/\s+/g, " ")
      // Rejoining can leave a space stranded in front of punctuation
      // ("…3032 , 525081"). Harmless to the parser, ugly in the box.
      .replace(/\s+([,)])/g, "$1")
      .replace(/([(])\s+/g, "$1")
      .trim();
  }

  return { text, mode: "single", notes };
}
