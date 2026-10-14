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
    expect(basePaint(0)).toEqual({
      fillOpacity: 0.25,
      lineOpacity: 0.95,
      circleOpacity: 0.9,
      circleStrokeOpacity: 1,
    });
  });

  it("fades everything toward faint at dim=1", () => {
    const p = basePaint(1);
    expect(p.fillOpacity).toBeCloseTo(0.06);
    expect(p.lineOpacity).toBeCloseTo(0.18);
    expect(p.fillOpacity).toBeLessThan(basePaint(0).fillOpacity);
  });
});

describe("highlightPaint (selected feature only)", () => {
  it("is invisible at rest (fade=pop=0)", () => {
    const p = highlightPaint(0, 0);
    expect(p.fillOpacity).toBe(0);
    expect(p.lineOpacity).toBe(0);
    expect(p.circleOpacity).toBe(0);
  });

  it("reaches full vividness at fade=pop=1", () => {
    const p = highlightPaint(1, 1);
    expect(p.fillOpacity).toBeCloseTo(0.6);
    expect(p.lineOpacity).toBe(1);
    expect(p.lineWidth).toBeCloseTo(4.5);
    expect(p.circleRadius).toBeCloseTo(9);
  });

  it("lets size overshoot when pop > 1 (spring past target)", () => {
    const p = highlightPaint(1, 1.05);
    expect(p.lineWidth).toBeGreaterThan(4.5);
    expect(p.circleRadius).toBeGreaterThan(9);
  });
});
