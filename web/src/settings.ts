// Display settings for data-driven rendering: extrude polygons by a property,
// and colour features by a property through a viridis-family ramp. Persisted
// globally in localStorage; resolved against the loaded data ("auto" turns a
// feature on only when its property is actually present).

import { SCHEME_NAMES } from "./colors";

export type TriState = "auto" | "on" | "off";

export interface Settings {
  extrudeMode: TriState;
  extrudeProp: string;
  colorMode: TriState;
  colorProp: string;
  colorMin: number;
  colorMax: number;
  colorScheme: string;
}

export const DEFAULT_SETTINGS: Settings = {
  extrudeMode: "auto",
  extrudeProp: "height",
  colorMode: "auto",
  colorProp: "c",
  colorMin: 0,
  colorMax: 100,
  colorScheme: "viridis",
};

/** Settings resolved against the data — concrete on/off booleans. */
export interface EffectiveSettings {
  extrude: boolean;
  extrudeProp: string;
  color: boolean;
  colorProp: string;
  colorMin: number;
  colorMax: number;
  colorScheme: string;
}

const KEY = "geocow:settings";

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    if (!SCHEME_NAMES.includes(merged.colorScheme)) merged.colorScheme = "viridis";
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable; non-fatal
  }
}

/** Resolve `auto` modes against which properties the data actually carries. */
export function resolveSettings(
  s: Settings,
  hasProp: (prop: string) => boolean,
): EffectiveSettings {
  const on = (mode: TriState, prop: string) =>
    mode === "on" || (mode === "auto" && hasProp(prop));
  return {
    extrude: on(s.extrudeMode, s.extrudeProp),
    extrudeProp: s.extrudeProp,
    color: on(s.colorMode, s.colorProp),
    colorProp: s.colorProp,
    colorMin: s.colorMin,
    colorMax: s.colorMax,
    colorScheme: s.colorScheme,
  };
}
