import type { BBox } from "./geo";
import type { ViewState } from "./state";

export interface FitToPoint {
  kind: "point";
  center: [number, number];
  zoom: number;
  pitch?: number;
}

export interface FitToBounds {
  kind: "bounds";
  bounds: [[number, number], [number, number]];
  pitch?: number;
}

export type FitPlan = FitToPoint | FitToBounds;

/**
 * Decide how to frame `bbox`. A degenerate bbox (a single point — zero
 * extent) becomes a recenter + zoom-in; anything with extent becomes a
 * fitBounds.
 *
 * `pitch` is present *only* when `extrude` is true. Crucially, the plan never
 * carries `pitch: undefined`: feeding that to MapLibre's easeTo/fitBounds
 * coerces it to `+undefined → NaN`, calls setPitch(NaN), corrupts the camera
 * matrices and blanks the map. Omitting the key leaves the current pitch
 * untouched, which is what we want when not extruding.
 */
export function planFit(
  bbox: BBox,
  currentZoom: number,
  extrude: boolean,
): FitPlan {
  const [w, s, e, n] = bbox;
  const tilt = extrude ? { pitch: 45 } : {};
  if (w === e && s === n) {
    return {
      kind: "point",
      center: [w, s],
      // Zoom in to street level for a lone point, but never zoom *out* past
      // wherever the user already is.
      zoom: Math.max(currentZoom, 15),
      ...tilt,
    };
  }
  return {
    kind: "bounds",
    bounds: [
      [w, s],
      [e, n],
    ],
    ...tilt,
  };
}

/**
 * Extract the pitch as a spreadable options fragment — `{ pitch: n }` when the
 * plan tilts, or `{}` otherwise. Use this to splice pitch into MapLibre camera
 * options without ever materialising `pitch: undefined`.
 */
export function pitchOption(plan: FitPlan): { pitch?: number } {
  return plan.pitch === undefined ? {} : { pitch: plan.pitch };
}

// A view that has been through the URL hash is rounded (see viewToString), so
// comparing it to the live camera at full precision always reports a
// difference. Match the hash's precision instead.
const HASH_PRECISION = { zoom: 2, lngLat: 5, angle: 1 } as const;

const round = (n: number, dp: number) => Number(n.toFixed(dp));

/** True when two views are the same to the precision the URL hash carries. */
export function viewsMatch(a: ViewState, b: ViewState): boolean {
  const { zoom, lngLat, angle } = HASH_PRECISION;
  return (
    round(a.zoom, zoom) === round(b.zoom, zoom) &&
    round(a.center[0], lngLat) === round(b.center[0], lngLat) &&
    round(a.center[1], lngLat) === round(b.center[1], lngLat) &&
    round(a.bearing, angle) === round(b.bearing, angle) &&
    round(a.pitch, angle) === round(b.pitch, angle)
  );
}

