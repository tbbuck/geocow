import { describe, it, expect } from "vitest";

import {
  NO_MAP_CONFIG,
  aerialInsertBefore,
  parseMapConfig,
  resolveStyleUrl,
  satelliteAvailable,
  type MapConfig,
} from "./config";

const KEYED: MapConfig = { ...NO_MAP_CONFIG, maptilerKey: "k" };
const AERIAL: MapConfig = {
  ...NO_MAP_CONFIG,
  aerialTileUrl: "https://tiles.example.com/{z}/{x}/{y}.jpg",
};

describe("resolveStyleUrl", () => {
  it("uses MapTiler dataviz styles when a key is configured", () => {
    expect(resolveStyleUrl(KEYED, "light", false, false)).toBe(
      "https://api.maptiler.com/maps/dataviz-light/style.json?key=k",
    );
    expect(resolveStyleUrl(KEYED, "dark", false, false)).toContain("dataviz-dark");
  });

  it("uses the MapTiler hybrid basemap for satellite", () => {
    expect(resolveStyleUrl(KEYED, "light", true, false)).toContain("/maps/hybrid/");
  });

  it("falls back to keyless OpenFreeMap styles without a key", () => {
    expect(resolveStyleUrl(NO_MAP_CONFIG, "light", false, false)).toBe(
      "https://tiles.openfreemap.org/styles/positron",
    );
    expect(resolveStyleUrl(NO_MAP_CONFIG, "dark", false, false)).toBe(
      "https://tiles.openfreemap.org/styles/dark",
    );
  });

  it("follows the system colour scheme for Auto", () => {
    expect(resolveStyleUrl(NO_MAP_CONFIG, "system", false, true)).toContain("/dark");
    expect(resolveStyleUrl(NO_MAP_CONFIG, "system", false, false)).toContain("/positron");
  });

  it("lays keyless aerial imagery over the light style", () => {
    expect(resolveStyleUrl(AERIAL, "dark", true, true)).toContain("/positron");
  });

  it("never puts the key anywhere but the MapTiler URL", () => {
    expect(resolveStyleUrl(KEYED, "light", false, false)).not.toContain("openfreemap");
  });
});

describe("satelliteAvailable", () => {
  it("needs either a MapTiler key or an aerial tile URL", () => {
    expect(satelliteAvailable(NO_MAP_CONFIG)).toBe(false);
    expect(satelliteAvailable(KEYED)).toBe(true);
    expect(satelliteAvailable(AERIAL)).toBe(true);
  });
});

describe("aerialInsertBefore", () => {
  const layers = [
    { id: "bg", type: "background" },
    { id: "sat", type: "raster" },
    { id: "water", type: "fill" },
    { id: "roads", type: "line" },
    { id: "labels", type: "symbol" },
  ];

  it("sits just above imagery on a satellite basemap, keeping roads on top", () => {
    expect(aerialInsertBefore(layers, true)).toBe("water");
  });

  it("covers every fill on a vector basemap, keeping only labels on top", () => {
    expect(aerialInsertBefore(layers, false)).toBe("labels");
  });

  it("goes on top when there is nothing to keep above it", () => {
    expect(aerialInsertBefore([{ id: "bg", type: "background" }], false)).toBeUndefined();
  });
});

describe("parseMapConfig", () => {
  it("reads the server's /api/config body", () => {
    expect(
      parseMapConfig({
        maptilerKey: "k",
        aerialTileUrl: "https://t/{z}/{x}/{y}.jpg",
        aerialAttribution: "© T",
      }),
    ).toEqual({
      maptilerKey: "k",
      aerialTileUrl: "https://t/{z}/{x}/{y}.jpg",
      aerialAttribution: "© T",
    });
  });

  it("treats missing or non-string fields as unset", () => {
    expect(parseMapConfig({ maptilerKey: 3 })).toEqual(NO_MAP_CONFIG);
    expect(parseMapConfig(null)).toEqual(NO_MAP_CONFIG);
  });
});
