// GeoJSON simplestyle (mapbox/simplestyle-spec 1.1.0): per-feature styling
// carried in properties — stroke, fill, marker colour/size/symbol, plus a
// title and description for the info box. geocow adds one key of its own,
// `fill-outline-color`: a 1px hairline round a polygon's fill, drawn beneath
// the stroke, so it shows where `stroke-width` or `stroke-opacity` is 0.
//
// A feature that sets any styling key gets the spec defaults for the ones it
// leaves out, as it would on geojson.io; a feature that sets none keeps
// geocow's own look. Colours resolve explicit key → colour-by ramp (when
// active) → default.
//
// Keys are validated here, once per feature, and written onto it as flat
// `__ss_*` render properties for the paint expressions to read. MapLibre
// can't parse the spec's `#`-less hex, and checking up front keeps the
// expressions simple: a render property is either absent or usable.
//
// Per-feature opacity is baked into each colour's alpha rather than set as
// a data-driven opacity. The focus animation rewrites the layer opacities
// every frame, which MapLibre handles cheaply only while they're constants —
// so they stay constants, and multiply the alpha.

import type { GeoJsonProperties } from "geojson";

import { GEOM_COLOR } from "./config";
import { SYMBOL_SIZE, symbolStem } from "./symbols";

/** The render properties written onto a styled feature. */
export const SS = {
  styled: "__ss",
  stroke: "__ss_stroke",
  strokeOpacity: "__ss_stroke_opacity",
  strokeWidth: "__ss_stroke_width",
  fill: "__ss_fill",
  fillOpacity: "__ss_fill_opacity",
  outline: "__ss_outline",
  marker: "__ss_marker",
  markerRadius: "__ss_marker_radius",
  symbol: "__ss_symbol",
} as const;

export type RenderProps = Record<string, string | number | boolean>;

/** The spec's defaults, for a styled feature's missing keys. */
const SPEC = {
  stroke: "#555555",
  strokeOpacity: 1,
  strokeWidth: 2,
  fill: "#555555",
  fillOpacity: 0.6,
  markerColor: "#7e7e7e",
};

/** Marker circle radius for each `marker-size`; the spec leaves pixels to us. */
const MARKER_RADIUS: Record<string, number> = { small: 5, medium: 8, large: 11 };

/** A symbol spans this much of its marker's radius, so it sits inside the circle. */
const SYMBOL_SPAN = 1.4;

/** YIQ brightness above which a marker takes dark ink rather than white. */
const LIGHT_MARKER = 150;

/** The numbers that size and fade one feature. */
export interface Look {
  fillOpacity: number;
  lineOpacity: number;
  lineWidth: number;
  circleRadius: number;
}

/** geocow's own look, for a feature with no styling keys. */
export const DEFAULT_LOOK: Look = {
  fillOpacity: 0.25,
  lineOpacity: 0.95,
  lineWidth: 2.5,
  circleRadius: 6,
};

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A simplestyle colour — 3- or 6-digit hex, `#` optional — as `#rrggbb`. */
export function parseColor(v: unknown): string | null {
  const m = typeof v === "string" ? HEX_RE.exec(v.trim()) : null;
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return "#" + (hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex);
}

/** A number, or a string holding one (CSV-born GeoJSON often has those). */
function parseNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseOpacity(v: unknown): number | null {
  const n = parseNumber(v);
  return n === null ? null : Math.min(1, Math.max(0, n));
}

function parseWidth(v: unknown): number | null {
  const n = parseNumber(v);
  return n !== null && n >= 0 ? n : null;
}

/**
 * The render properties for a feature's simplestyle keys, or `{}` when it
 * has none that are valid. Invalid values count as absent.
 */
export function renderProps(props: GeoJsonProperties): RenderProps {
  const p = props ?? {};
  const colors = {
    [SS.stroke]: parseColor(p["stroke"]),
    [SS.fill]: parseColor(p["fill"]),
    [SS.outline]: parseColor(p["fill-outline-color"]),
    [SS.marker]: parseColor(p["marker-color"]),
  };
  const strokeOpacity = parseOpacity(p["stroke-opacity"]);
  const strokeWidth = parseWidth(p["stroke-width"]);
  const fillOpacity = parseOpacity(p["fill-opacity"]);
  const size = p["marker-size"];
  const markerRadius = typeof size === "string" ? (MARKER_RADIUS[size] ?? null) : null;
  // The spec's "" means no symbol, so it doesn't style the feature; any other
  // value does, even one we can't draw.
  const rawSymbol = p["marker-symbol"];
  const hasSymbol = rawSymbol !== undefined && rawSymbol !== null && rawSymbol !== "";

  const styled =
    Object.values(colors).some((c) => c !== null) ||
    [strokeOpacity, strokeWidth, fillOpacity, markerRadius].some((n) => n !== null) ||
    hasSymbol;
  if (!styled) return {};

  const out: RenderProps = {
    [SS.styled]: true,
    [SS.strokeOpacity]: strokeOpacity ?? SPEC.strokeOpacity,
    [SS.strokeWidth]: strokeWidth ?? SPEC.strokeWidth,
    [SS.fillOpacity]: fillOpacity ?? SPEC.fillOpacity,
    [SS.markerRadius]: markerRadius ?? MARKER_RADIUS.medium,
  };
  // Colours only when given: a missing one falls to the colour-by ramp
  // before the spec default, and the ramp is decided at paint time.
  for (const [key, color] of Object.entries(colors)) {
    if (color !== null) out[key] = color;
  }
  const stem = hasSymbol ? symbolStem(rawSymbol) : null;
  if (stem !== null) out[SS.symbol] = stem;
  return out;
}

/** The look of a feature, from the render properties map-view gave it. */
export function featureLook(props: GeoJsonProperties): Look {
  const p = props ?? {};
  const num = (key: string, fallback: number) =>
    typeof p[key] === "number" ? (p[key] as number) : fallback;
  // A styled feature always carries these; an unstyled one never does.
  return {
    fillOpacity: num(SS.fillOpacity, DEFAULT_LOOK.fillOpacity),
    lineOpacity: num(SS.strokeOpacity, DEFAULT_LOOK.lineOpacity),
    lineWidth: num(SS.strokeWidth, DEFAULT_LOOK.lineWidth),
    circleRadius: num(SS.markerRadius, DEFAULT_LOOK.circleRadius),
  };
}

/** A feature's simplestyle title and description, for the info box. */
export function featureText(props: GeoJsonProperties): {
  title: string | null;
  description: string | null;
} {
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return { title: text(props?.title), description: text(props?.description) };
}

// --- Paint expressions ------------------------------------------------------

type Expr = unknown;

/** One colour channel: the feature's own colour, else the ramp, else a default. */
function channel(key: string, specDefault: string, ramp: Expr | null): Expr {
  const fallback = ramp ?? [
    "case",
    ["has", SS.styled],
    ["to-color", specDefault],
    ["to-color", GEOM_COLOR],
  ];
  return ["case", ["has", key], ["to-color", ["get", key]], fallback];
}

/** `color` with its alpha replaced by `alpha`. */
function withAlpha(color: Expr, alpha: Expr): Expr {
  const c = ["var", "rgba"];
  return [
    "let",
    "rgba",
    ["to-rgba", color],
    ["rgba", ["at", 0, c], ["at", 1, c], ["at", 2, c], alpha],
  ];
}

/** `:dark` ink for a light marker, `:light` for the rest (YIQ brightness). */
function inkFor(color: Expr): Expr {
  const c = ["var", "ink"];
  const brightness = [
    "+",
    ["*", 0.299, ["at", 0, c]],
    ["*", 0.587, ["at", 1, c]],
    ["*", 0.114, ["at", 2, c]],
  ];
  return [
    "let",
    "ink",
    ["to-rgba", color],
    ["case", [">", brightness, LIGHT_MARKER], ":dark", ":light"],
  ];
}

/**
 * Every data-driven paint and layout value the geometry layers need, given
 * the colour-by ramp (or null when colour-by is off). The highlight layers
 * get opaque colours: they draw one feature, so its opacity is a constant
 * the animation sets.
 */
export function buildPaint(ramp: Expr | null) {
  const fill = channel(SS.fill, SPEC.fill, ramp);
  const stroke = channel(SS.stroke, SPEC.stroke, ramp);
  const marker = channel(SS.marker, SPEC.markerColor, ramp);
  const fillColor = withAlpha(fill, ["coalesce", ["get", SS.fillOpacity], DEFAULT_LOOK.fillOpacity]);
  return {
    fillColor,
    // Opaque, so it still shows round a polygon with fill-opacity 0. Absent,
    // it's the fill colour, as MapLibre would have it.
    fillOutlineColor: ["case", ["has", SS.outline], ["to-color", ["get", SS.outline]], fillColor],
    lineColor: withAlpha(stroke, [
      "coalesce",
      ["get", SS.strokeOpacity],
      DEFAULT_LOOK.lineOpacity,
    ]),
    lineWidth: ["coalesce", ["get", SS.strokeWidth], DEFAULT_LOOK.lineWidth],
    circleColor: marker,
    circleRadius: ["coalesce", ["get", SS.markerRadius], DEFAULT_LOOK.circleRadius],
    extrudeColor: fill,
    hiFillColor: fill,
    hiLineColor: stroke,
    hiCircleColor: marker,
    iconImage: ["concat", ["get", SS.symbol], inkFor(marker)],
    iconSize: ["/", ["*", ["get", SS.markerRadius], SYMBOL_SPAN], SYMBOL_SIZE],
  };
}
