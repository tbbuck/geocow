import { describe, it, expect } from "vitest";

import { planFit, pitchOption, viewsMatch } from "./camera";
import type { BBox } from "./geo";
import type { ViewState } from "./state";

const POINT: BBox = [-0.257176, 51.492291, -0.257176, 51.492291];
const EXTENT: BBox = [-1, 50, 1, 52];

describe("planFit", () => {
  it("recenters on a degenerate (single-point) bbox", () => {
    const plan = planFit(POINT, 4, false);
    expect(plan.kind).toBe("point");
    expect(plan).toMatchObject({ center: [-0.257176, 51.492291] });
  });

  it("zooms a point to street level but never zooms out", () => {
    expect(planFit(POINT, 4, false)).toMatchObject({ zoom: 15 });
    expect(planFit(POINT, 18, false)).toMatchObject({ zoom: 18 });
  });

  it("fits bounds for a bbox with extent", () => {
    const plan = planFit(EXTENT, 4, false);
    expect(plan.kind).toBe("bounds");
    expect(plan).toMatchObject({
      bounds: [
        [-1, 50],
        [1, 52],
      ],
    });
  });

  // Regression guard: the original bug passed `pitch: undefined` into the
  // camera, which MapLibre turned into NaN and used to blank the map. The plan
  // must omit the key entirely when not extruding.
  it("omits pitch entirely when not extruding", () => {
    expect("pitch" in planFit(POINT, 4, false)).toBe(false);
    expect("pitch" in planFit(EXTENT, 4, false)).toBe(false);
  });

  it("tilts to 45 when extruding", () => {
    expect(planFit(POINT, 4, true)).toMatchObject({ pitch: 45 });
    expect(planFit(EXTENT, 4, true)).toMatchObject({ pitch: 45 });
  });
});

describe("pitchOption", () => {
  it("yields an empty fragment when the plan has no pitch", () => {
    const opt = pitchOption(planFit(POINT, 4, false));
    expect(opt).toEqual({});
    expect("pitch" in opt).toBe(false);
  });

  it("yields { pitch } when the plan tilts", () => {
    expect(pitchOption(planFit(POINT, 4, true))).toEqual({ pitch: 45 });
  });
});

const view = (over: Partial<ViewState> = {}): ViewState => ({
  center: [-2.5, 54.2],
  zoom: 8,
  bearing: 0,
  pitch: 0,
  ...over,
});

describe("viewsMatch", () => {
  it("treats identical views as matching", () => {
    expect(viewsMatch(view(), view())).toBe(true);
  });

  // The hash rounds to 5dp of lng/lat, so a live camera that differs only
  // below that precision is the *same* view — otherwise every hashchange
  // would look like a move and fight the user's panning.
  it("ignores differences below the hash's precision", () => {
    expect(viewsMatch(view(), view({ center: [-2.5000004, 54.2000001] }))).toBe(
      true,
    );
    expect(viewsMatch(view(), view({ zoom: 8.001 }))).toBe(true);
  });

  it("sees a real move", () => {
    expect(viewsMatch(view(), view({ center: [-2.4, 54.2] }))).toBe(false);
    expect(viewsMatch(view(), view({ zoom: 9 }))).toBe(false);
    expect(viewsMatch(view(), view({ bearing: 30 }))).toBe(false);
    expect(viewsMatch(view(), view({ pitch: 45 }))).toBe(false);
  });
});

