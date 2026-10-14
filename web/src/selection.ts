// Animation maths for the "focus" effect: when a feature's info box is open it
// pops to the front while every other feature eases back to a faint shade.
//
// MapLibre only time-animates *constant* paint properties — data-driven
// expressions snap — so map-view.ts renders the selected feature in dedicated
// highlight layers (constant paint) over dimmed base layers, and drives both
// with these pure functions each animation frame. Keeping the maths here (no
// map dependency) makes it unit-testable.

export const DIM_MS = 380; // others fade back over this long
export const HI_MS = 440; // the selected feature pops over this long

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Interpolate `from`→`to` by an already-eased progress. Easing the *progress*
 * (not the value) keeps motion ease-*out* in both directions: reversing a
 * tween starts moving immediately instead of lingering at its old value.
 */
export const mix = (from: number, to: number, easedProgress: number): number =>
  from + (to - from) * easedProgress;

/** Smooth deceleration — used for opacities (no overshoot, stays in [0,1]). */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/** Overshoot-and-settle ("back") — the funky curve. Used for size so the
 * selected outline/dot springs slightly past its target then eases home. */
export function easeOutBack(t: number, s = 1.70158): number {
  const u = clamp01(t) - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

export interface BasePaint {
  fillOpacity: number;
  lineOpacity: number;
  circleOpacity: number;
  circleStrokeOpacity: number;
}

/** Base layers (every feature). `dim` in [0,1]: 0 = normal, 1 = fully faded. */
export function basePaint(dim: number): BasePaint {
  return {
    fillOpacity: lerp(0.25, 0.06, dim),
    lineOpacity: lerp(0.95, 0.18, dim),
    circleOpacity: lerp(0.9, 0.2, dim),
    circleStrokeOpacity: lerp(1, 0.25, dim),
  };
}

export interface HighlightPaint {
  fillOpacity: number;
  lineOpacity: number;
  lineWidth: number;
  circleOpacity: number;
  circleRadius: number;
  circleStrokeOpacity: number;
}

/**
 * Highlight layers (selected feature only). `fade` in [0,1] drives opacity
 * (eased, clamped); `pop` is the overshooting size progress so width/radius
 * spring. At rest (fade=pop=0) the layers are invisible.
 */
export function highlightPaint(fade: number, pop: number): HighlightPaint {
  return {
    fillOpacity: lerp(0, 0.6, fade),
    lineOpacity: lerp(0, 1, fade),
    lineWidth: lerp(2.5, 4.5, pop),
    circleOpacity: lerp(0, 1, fade),
    circleRadius: lerp(6, 9, pop),
    circleStrokeOpacity: lerp(0, 1, fade),
  };
}
