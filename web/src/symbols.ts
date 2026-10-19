// Marker symbols for simplestyle's `marker-symbol`: a Maki icon, a letter a–z
// or a digit 0–9, drawn centred on the marker circle in a light or dark ink
// (whichever reads on the marker's colour — the paint expression decides).
//
// MapLibre asks map-view for each image the first time a feature needs it,
// and waits while it's drawn. Drawing is async because the Maki SVGs are
// loaded on demand — one tiny chunk per icon, so only the icons in use are
// ever fetched — and letters wait for the web font.

const makiLoaders = import.meta.glob<string>("../node_modules/@mapbox/maki/icons/*.svg", {
  query: "?raw",
  import: "default",
});

/** Maki icon name (the file name, e.g. `bank-JP`) → its SVG source, loaded on demand. */
const MAKI = new Map(
  Object.entries(makiLoaders).map(([path, load]) => [
    path.slice(path.lastIndexOf("/") + 1, -".svg".length),
    load,
  ]),
);

const PREFIX = "geocow-symbol:";
const GLYPH_RE = /^[a-z0-9]$/;

export type Ink = "light" | "dark";
const INK_COLOR: Record<Ink, string> = { light: "#ffffff", dark: "#1c1917" };

/** Logical size of a symbol image, in CSS pixels. */
export const SYMBOL_SIZE = 16;
/** Device pixels drawn per logical pixel: enough to stay crisp when scaled up. */
export const SYMBOL_PIXEL_RATIO = 3;
const PX = SYMBOL_SIZE * SYMBOL_PIXEL_RATIO;

/**
 * The image id stem for a `marker-symbol` value, or null if it isn't one we
 * can draw. The map appends `:light` or `:dark` to choose the ink.
 */
export function symbolStem(value: unknown): string | null {
  const s =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return GLYPH_RE.test(s) || MAKI.has(s) ? PREFIX + s : null;
}

/** Split an image id back into what to draw, or null if it isn't one of ours. */
export function parseSymbolId(id: string): { symbol: string; ink: Ink } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.lastIndexOf(":");
  const symbol = rest.slice(0, at);
  const ink = rest.slice(at + 1);
  if (at < 0 || (ink !== "light" && ink !== "dark")) return null;
  if (symbolStem(symbol) === null) return null;
  return { symbol, ink };
}

const drawings = new Map<string, Promise<ImageData>>();

/**
 * Draw the symbol an image id names, or null if the id isn't one of ours.
 * Drawings are cached, so a style swap (which drops every image) gets them
 * back without redrawing.
 */
export function drawSymbol(id: string): Promise<ImageData> | null {
  const parsed = parseSymbolId(id);
  if (!parsed) return null;
  let drawing = drawings.get(id);
  if (!drawing) {
    drawing = draw(parsed.symbol, INK_COLOR[parsed.ink]);
    drawings.set(id, drawing);
  }
  return drawing;
}

async function draw(symbol: string, ink: string): Promise<ImageData> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas to draw marker symbols on");

  if (GLYPH_RE.test(symbol)) {
    const font = `600 ${PX}px Inter, system-ui, sans-serif`;
    await document.fonts.load(font, symbol);
    ctx.font = font;
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    // Centre the glyph's ink rather than its em box, so `g` sits as level as `a`.
    const m = ctx.measureText(symbol);
    ctx.fillText(symbol, PX / 2, (PX + m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  } else {
    ctx.drawImage(await loadMaki(symbol, ink), 0, 0, PX, PX);
  }
  return ctx.getImageData(0, 0, PX, PX);
}

/** A Maki icon as an image, recoloured to `ink` and rasterised at full size. */
async function loadMaki(name: string, ink: string): Promise<HTMLImageElement> {
  const load = MAKI.get(name);
  if (!load) throw new Error(`no Maki icon named ${name}`);
  const svg = new DOMParser().parseFromString(await load(), "image/svg+xml").documentElement;
  svg.setAttribute("width", String(PX));
  svg.setAttribute("height", String(PX));
  svg.setAttribute("fill", ink);

  // A same-origin blob URL, so drawing it can't taint the canvas.
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
