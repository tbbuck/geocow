// Viridis-family colour ramps (9 evenly-spaced stops, 0→1) and a helper that
// turns "colour feature by property value" into a MapLibre interpolate
// expression. Sampled from the matplotlib palettes.

export const PALETTES: Record<string, string[]> = {
  viridis: ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"],
  magma:   ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55064", "#fb8761", "#fec287", "#fcfdbf"],
  inferno: ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#fcffa4"],
  plasma:  ["#0d0887", "#41049d", "#6a00a8", "#8f0da4", "#b12a90", "#cc4778", "#e16462", "#fca636", "#f0f921"],
  cividis: ["#00204d", "#00336f", "#39486b", "#575d6d", "#707173", "#8a8779", "#a69d75", "#c4b56c", "#ffea46"],
};

export const SCHEME_NAMES = Object.keys(PALETTES);

/**
 * Build a MapLibre `interpolate` colour expression that maps a numeric feature
 * property across [min, max] through the chosen palette. Missing values fall
 * back to `min`. Returns a maplibre expression (typed loosely on purpose).
 */
export function buildColorExpression(
  prop: string,
  min: number,
  max: number,
  scheme: string,
): unknown {
  const palette = PALETTES[scheme] ?? PALETTES.viridis;
  // Guard against a zero/negative range, which makes interpolate throw.
  const lo = min;
  const hi = max > min ? max : min + 1e-9;
  const span = hi - lo;

  const stops: (number | string)[] = [];
  palette.forEach((color, i) => {
    stops.push(lo + (i / (palette.length - 1)) * span, color);
  });

  return [
    "interpolate",
    ["linear"],
    ["to-number", ["coalesce", ["get", prop], lo]],
    ...stops,
  ];
}
