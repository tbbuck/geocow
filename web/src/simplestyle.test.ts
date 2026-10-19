import { describe, it, expect } from "vitest";
import { expression, latest } from "@maplibre/maplibre-gl-style-spec";

import {
  DEFAULT_LOOK,
  buildPaint,
  featureLook,
  featureText,
  parseColor,
  renderProps,
} from "./simplestyle";
import { buildColorExpression } from "./colors";

/**
 * Evaluate a paint/layout expression the way MapLibre will, against a feature
 * carrying `props` plus the render properties map-view adds to it.
 */
function evaluate(
  expr: unknown,
  key: string,
  props: Record<string, unknown>,
): unknown {
  const [kind, layer, name] = key.split("/");
  const spec = (latest as unknown as Record<string, Record<string, unknown>>)[
    `${kind}_${layer}`
  ][name];
  const parsed = expression.createPropertyExpression(expr, key, spec as never);
  if (parsed.result !== "success") {
    throw new Error(parsed.value.map((e) => e.message).join("; "));
  }
  const feature = { type: 1, properties: { ...props, ...renderProps(props) } };
  return parsed.value.evaluate({ zoom: 10 } as never, feature as never);
}

/** A colour result as `rgba(r,g,b,a)`. */
const rgba = (c: unknown) => String(c).replace(/\s/g, "");

const NO_RAMP = buildPaint(null);
const RAMP = buildPaint(buildColorExpression("c", 0, 100, "viridis"));

describe("parseColor", () => {
  it("accepts 6- and 3-digit hex, with or without #", () => {
    expect(parseColor("#ff8800")).toBe("#ff8800");
    expect(parseColor("ff8800")).toBe("#ff8800");
    expect(parseColor("#f80")).toBe("#ff8800");
    expect(parseColor("f80")).toBe("#ff8800");
  });

  it("normalises case", () => {
    expect(parseColor("#FF88AA")).toBe("#ff88aa");
  });

  it("rejects what the spec doesn't allow", () => {
    for (const bad of ["red", "#ff00", "#gggggg", "rgb(1,2,3)", "", 0xff0000, null, undefined]) {
      expect(parseColor(bad)).toBeNull();
    }
  });
});

describe("renderProps", () => {
  it("leaves a feature with no styling keys alone", () => {
    expect(renderProps(null)).toEqual({});
    expect(renderProps({ name: "cow" })).toEqual({});
    // title and description are for the info box, not the paint.
    expect(renderProps({ title: "Cow", description: "Moo" })).toEqual({});
  });

  it("fills the keys a styled feature leaves out with the spec defaults", () => {
    expect(renderProps({ fill: "00f" })).toEqual({
      __ss: true,
      __ss_fill: "#0000ff",
      __ss_fill_opacity: 0.6,
      __ss_stroke_opacity: 1,
      __ss_stroke_width: 2,
      __ss_marker_radius: 8,
    });
  });

  it("reads every key", () => {
    expect(
      renderProps({
        stroke: "#111",
        "stroke-opacity": 0.5,
        "stroke-width": 4,
        fill: "#222",
        "fill-opacity": 0.1,
        "fill-outline-color": "#333",
        "marker-color": "#444",
        "marker-size": "large",
        "marker-symbol": "rocket",
      }),
    ).toEqual({
      __ss: true,
      __ss_stroke: "#111111",
      __ss_stroke_opacity: 0.5,
      __ss_stroke_width: 4,
      __ss_fill: "#222222",
      __ss_fill_opacity: 0.1,
      __ss_outline: "#333333",
      __ss_marker: "#444444",
      __ss_marker_radius: 11,
      __ss_symbol: "geocow-symbol:rocket",
    });
  });

  it("sizes markers small, medium and large", () => {
    const radius = (size: unknown) => renderProps({ "marker-size": size }).__ss_marker_radius;
    expect(radius("small")).toBeLessThan(radius("medium") as number);
    expect(radius("medium")).toBeLessThan(radius("large") as number);
  });

  it("ignores invalid values, and a feature with nothing valid is unstyled", () => {
    expect(
      renderProps({ stroke: "red", "stroke-width": -1, "marker-size": "huge" }),
    ).toEqual({});
    expect(renderProps({ stroke: "red", fill: "#0f0" }).__ss_stroke).toBeUndefined();
  });

  it("takes numbers written as strings, and clamps opacity to 0–1", () => {
    const p = renderProps({ "fill-opacity": "0.3", "stroke-opacity": 1.5, "stroke-width": "5" });
    expect(p.__ss_fill_opacity).toBe(0.3);
    expect(p.__ss_stroke_opacity).toBe(1);
    expect(p.__ss_stroke_width).toBe(5);
  });

  it("maps marker-symbol to an image: letters, digits and Maki icons", () => {
    const symbol = (v: unknown) => renderProps({ "marker-symbol": v }).__ss_symbol;
    expect(symbol("a")).toBe("geocow-symbol:a");
    expect(symbol("7")).toBe("geocow-symbol:7");
    expect(symbol(7)).toBe("geocow-symbol:7");
    expect(symbol("bank-JP")).toBe("geocow-symbol:bank-JP");
  });

  it("styles the marker but draws no symbol it can't render", () => {
    for (const v of ["A", "no-such-icon", 10, 7.5]) {
      const p = renderProps({ "marker-symbol": v });
      expect(p.__ss).toBe(true);
      expect(p.__ss_symbol).toBeUndefined();
    }
    // The spec's "no symbol".
    expect(renderProps({ "marker-symbol": "" })).toEqual({});
  });
});

describe("featureLook", () => {
  it("is geocow's own look for an unstyled feature", () => {
    expect(featureLook({})).toEqual(DEFAULT_LOOK);
  });

  it("reads a styled feature's render properties", () => {
    expect(
      featureLook(renderProps({ "fill-opacity": 0, "stroke-width": 6, "marker-size": "large" })),
    ).toEqual({ fillOpacity: 0, lineOpacity: 1, lineWidth: 6, circleRadius: 11 });
  });
});

describe("featureText", () => {
  it("reads title and description", () => {
    expect(featureText({ title: " Cow ", description: "Says moo" })).toEqual({
      title: "Cow",
      description: "Says moo",
    });
  });

  it("drops what isn't non-empty text", () => {
    expect(featureText({ title: "", description: 3 })).toEqual({
      title: null,
      description: null,
    });
    expect(featureText(null)).toEqual({ title: null, description: null });
  });
});

describe("buildPaint", () => {
  const fill = (paint: ReturnType<typeof buildPaint>, props: Record<string, unknown>) =>
    rgba(evaluate(paint.fillColor, "paint/fill/fill-color", props));

  it("keeps geocow's accent for unstyled features", () => {
    expect(fill(NO_RAMP, {})).toBe("rgba(255,122,24,0.25)");
    expect(rgba(evaluate(NO_RAMP.lineColor, "paint/line/line-color", {}))).toBe(
      "rgba(255,122,24,0.95)",
    );
    expect(evaluate(NO_RAMP.lineWidth, "paint/line/line-width", {})).toBe(2.5);
    expect(evaluate(NO_RAMP.circleRadius, "paint/circle/circle-radius", {})).toBe(6);
  });

  it("uses the spec default colours for a styled feature", () => {
    expect(fill(NO_RAMP, { "stroke-width": 3 })).toBe("rgba(85,85,85,0.6)");
    expect(
      rgba(evaluate(NO_RAMP.lineColor, "paint/line/line-color", { "stroke-width": 3 })),
    ).toBe("rgba(85,85,85,1)");
    expect(
      rgba(evaluate(NO_RAMP.circleColor, "paint/circle/circle-color", { "marker-size": "small" })),
    ).toBe("rgba(126,126,126,1)");
  });

  it("puts a feature's own colour and opacity on the map", () => {
    const props = { fill: "#00f", "fill-opacity": 0.3, stroke: "#f00", "stroke-opacity": 0.5 };
    expect(fill(NO_RAMP, props)).toBe("rgba(0,0,255,0.3)");
    expect(rgba(evaluate(NO_RAMP.lineColor, "paint/line/line-color", props))).toBe(
      "rgba(255,0,0,0.5)",
    );
  });

  it("lets an explicit colour beat colour-by, and colour-by beat the defaults", () => {
    // c=0 is the bottom of viridis.
    expect(fill(RAMP, { c: 0, fill: "#00f" })).toBe("rgba(0,0,255,0.6)");
    expect(fill(RAMP, { c: 0, "stroke-width": 3 })).toBe("rgba(68,1,84,0.6)");
    expect(fill(RAMP, { c: 0 })).toBe("rgba(68,1,84,0.25)");
  });

  it("draws fill-outline-color opaque, even on an unfilled polygon", () => {
    const props = { "fill-outline-color": "#0f0", "fill-opacity": 0 };
    expect(
      rgba(evaluate(NO_RAMP.fillOutlineColor, "paint/fill/fill-outline-color", props)),
    ).toBe("rgba(0,255,0,1)");
  });

  it("outlines with the fill colour when fill-outline-color is absent", () => {
    expect(
      rgba(evaluate(NO_RAMP.fillOutlineColor, "paint/fill/fill-outline-color", { fill: "#00f" })),
    ).toBe("rgba(0,0,255,0.6)");
  });

  it("gives the highlight layers opaque colours", () => {
    const props = { fill: "#00f", "fill-opacity": 0.3 };
    expect(rgba(evaluate(NO_RAMP.hiFillColor, "paint/fill/fill-color", props))).toBe(
      "rgba(0,0,255,1)",
    );
  });

  it("inks symbols dark on light markers and white on the rest", () => {
    const image = (props: Record<string, unknown>) =>
      String(evaluate(NO_RAMP.iconImage, "layout/symbol/icon-image", props));
    expect(image({ "marker-symbol": "a", "marker-color": "#fff" })).toBe("geocow-symbol:a:dark");
    expect(image({ "marker-symbol": "a" })).toBe("geocow-symbol:a:light");
    expect(image({ "marker-symbol": "a", "marker-color": "#000080" })).toBe(
      "geocow-symbol:a:light",
    );
  });

  it("scales symbols with the marker", () => {
    const size = (s: string) =>
      evaluate(NO_RAMP.iconSize, "layout/symbol/icon-size", {
        "marker-symbol": "a",
        "marker-size": s,
      }) as number;
    expect(size("small")).toBeLessThan(size("large"));
  });
});
