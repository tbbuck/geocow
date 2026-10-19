import { describe, it, expect } from "vitest";

import {
  lerp,
  clamp01,
  mix,
  easeOutCubic,
  easeOutBack,
  basePaint,
  highlightPaint,
} from "./selection";
import { DEFAULT_LOOK } from "./simplestyle";

describe("easing helpers", () => {
  it("lerp and clamp01 behave", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
  });

  it("easeOutCubic is pinned at the ends and decelerates", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // Front-loaded: past halfway by t=0.5.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    // Never leaves [0,1].
    expect(easeOutCubic(0.5)).toBeLessThanOrEqual(1);
  });

  it("easeOutBack overshoots past 1 before settling — the funky bit", () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 6);
    expect(easeOutBack(1)).toBeCloseTo(1, 6);
    // Somewhere in the back half it springs beyond the target.
    expect(easeOutBack(0.8)).toBeGreaterThan(1);
  });

  it("mix eases the progress, so reversing starts moving promptly", () => {
    expect(mix(0, 1, 0)).toBe(0);
    expect(mix(0, 1, 1)).toBe(1);
    // The bug that was fixed: on deselect the dim travels 1 → 0. Only 15% of
    // the way through, it must already have moved well off 1 (prompt fade-in
    // of the others) rather than lingering near fully-dimmed.
    const early = mix(1, 0, easeOutCubic(0.15));
    expect(early).toBeLessThan(0.7);
    // Sanity: the *value*-eased approach it replaced barely moved by 15%.
    expect(easeOutCubic(1 - 0.15)).toBeGreaterThan(0.99);
  });
});

describe("basePaint (all features dim as `dim` → 1)", () => {
  it("is the normal look at dim=0", () => {
    // Fill and line opacity multiply the alpha baked into each feature's
    // colour, so at rest they leave it untouched.
    expect(basePaint(0)).toEqual({
      fillOpacity: 1,
      lineOpacity: 1,
      circleOpacity: 0.9,
      circleStrokeOpacity: 1,
      iconOpacity: 1,
    });
  });

  it("fades an unstyled feature to the same faint shade as ever at dim=1", () => {
    const p = basePaint(1);
    expect(DEFAULT_LOOK.fillOpacity * p.fillOpacity).toBeCloseTo(0.06);
    expect(DEFAULT_LOOK.lineOpacity * p.lineOpacity).toBeCloseTo(0.18);
    expect(p.circleOpacity).toBeCloseTo(0.2);
    expect(p.iconOpacity).toBeLessThan(basePaint(0).iconOpacity);
  });
});

describe("highlightPaint (selected feature only)", () => {
  it("is invisible at rest (fade=pop=0)", () => {
    const p = highlightPaint(0, 0);
    expect(p.fillOpacity).toBe(0);
    expect(p.lineOpacity).toBe(0);
    expect(p.circleOpacity).toBe(0);
    expect(p.iconOpacity).toBe(0);
  });

  it("reaches full vividness at fade=pop=1", () => {
    const p = highlightPaint(1, 1);
    expect(p.fillOpacity).toBeCloseTo(0.6);
    expect(p.lineOpacity).toBe(1);
    expect(p.lineWidth).toBeCloseTo(4.5);
    expect(p.circleRadius).toBeCloseTo(9);
    expect(p.iconOpacity).toBe(1);
  });

  it("lets size overshoot when pop > 1 (spring past target)", () => {
    const p = highlightPaint(1, 1.05);
    expect(p.lineWidth).toBeGreaterThan(4.5);
    expect(p.circleRadius).toBeGreaterThan(9);
  });

  it("grows from the selected feature's own look", () => {
    const look = { fillOpacity: 0.1, lineOpacity: 0.5, lineWidth: 6, circleRadius: 11 };
    expect(highlightPaint(1, 0, look).lineWidth).toBe(6);
    const p = highlightPaint(1, 1, look);
    expect(p.lineWidth).toBeCloseTo(8);
    expect(p.circleRadius).toBeCloseTo(16.5);
    expect(p.fillOpacity).toBeCloseTo(0.24);
    expect(p.lineOpacity).toBe(1);
  });

  it("keeps an invisible fill or stroke invisible", () => {
    const look = { fillOpacity: 0, lineOpacity: 0, lineWidth: 0, circleRadius: 6 };
    const p = highlightPaint(1, 1, look);
    expect(p.fillOpacity).toBe(0);
    expect(p.lineOpacity).toBe(0);
    expect(p.lineWidth).toBe(0);
  });

  it("never fills the selection solid", () => {
    const look = { ...DEFAULT_LOOK, fillOpacity: 0.6 };
    expect(highlightPaint(1, 1, look).fillOpacity).toBeLessThan(1);
  });
});
