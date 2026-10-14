/**
 * Basemap settings, served by the backend at `/api/config` from its
 * environment, so the bundle carries no keys and one build serves any
 * deployment. Every field is optional: with none set the map still works,
 * on keyless OpenFreeMap styles.
 */
export interface MapConfig {
  /** MapTiler API key: unlocks the dataviz styles and the hybrid basemap. */
  maptilerKey: string | null;
  /** XYZ template for a high-resolution aerial overlay, shown in satellite mode. */
  aerialTileUrl: string | null;
  aerialAttribution: string | null;
}

export const NO_MAP_CONFIG: MapConfig = {
  maptilerKey: null,
  aerialTileUrl: null,
  aerialAttribution: null,
};

/** Read an `/api/config` body, treating anything malformed as unset. */
export function parseMapConfig(body: unknown): MapConfig {
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    maptilerKey: str(o.maptilerKey),
    aerialTileUrl: str(o.aerialTileUrl),
    aerialAttribution: str(o.aerialAttribution),
  };
}

/** Fetch the map config from the backend. */
export async function fetchMapConfig(): Promise<MapConfig> {
  const resp = await fetch("/api/config");
  if (!resp.ok) throw new Error(`map config unavailable (${resp.status})`);
  return parseMapConfig(await resp.json());
}

const maptiler = (name: string, key: string) =>
  `https://api.maptiler.com/maps/${name}/style.json?key=${encodeURIComponent(key)}`;

const openfreemap = (name: string) => `https://tiles.openfreemap.org/styles/${name}`;

// Colour scheme is independent of the satellite basemap: you pick a scheme
// (Auto/Light/Dark) OR switch to satellite imagery.
export type ColorScheme = "system" | "light" | "dark";

export const SCHEMES: { key: ColorScheme; label: string }[] = [
  { key: "system", label: "Auto" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

/** Satellite mode needs imagery from somewhere: MapTiler's or the overlay. */
export function satelliteAvailable(cfg: MapConfig): boolean {
  return cfg.maptilerKey !== null || cfg.aerialTileUrl !== null;
}

/**
 * Resolve config + scheme + satellite flag to a concrete style URL.
 * `prefersDark` is the system preference, consulted only for Auto.
 */
export function resolveStyleUrl(
  cfg: MapConfig,
  scheme: ColorScheme,
  satellite: boolean,
  prefersDark: boolean,
): string {
  const key = cfg.maptilerKey;
  // Without MapTiler, satellite is the aerial overlay drawn over the light
  // style, which still supplies labels and covers ground the imagery doesn't.
  if (satellite && key) return maptiler("hybrid", key);
  const dark = !satellite && (scheme === "dark" || (scheme === "system" && prefersDark));
  if (key) return maptiler(dark ? "dataviz-dark" : "dataviz-light", key);
  return openfreemap(dark ? "dark" : "positron");
}

/**
 * The layer the aerial overlay is inserted beneath. Over a satellite basemap
 * it sits just above the imagery, so roads and labels stay on top. Over a
 * vector basemap it has to cover every fill to be seen at all, so only the
 * labels stay above it. `undefined` puts it on top.
 */
export function aerialInsertBefore(
  layers: { id: string; type: string }[],
  basemapIsImagery: boolean,
): string | undefined {
  const keepAbove = basemapIsImagery
    ? (type: string) => type !== "background" && type !== "raster"
    : (type: string) => type === "symbol";
  return layers.find((l) => keepAbove(l.type))?.id;
}

// Default view: roughly centred on Great Britain.
export const DEFAULT_VIEW = {
  center: [-2.5, 54.2] as [number, number],
  zoom: 4.8,
  bearing: 0,
  pitch: 0,
};

// Styling for rendered geometry — a warm accent that reads on light, dark
// and satellite basemaps alike.
export const GEOM_COLOR = "#ff7a18";
export const GEOM_SOURCE = "geocow-data";
