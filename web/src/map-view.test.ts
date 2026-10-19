import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeatureCollection } from "geojson";

import { NO_MAP_CONFIG } from "./config";

// Just enough of maplibregl.Map for MapView to run without WebGL: it keeps
// sources, layers and their filters, and setStyle wipes them all and fires
// style.load, as a real theme swap does.
const { FakeMap } = vi.hoisted(() => {
  type Handler = (e: unknown) => void;
  class FakeMap {
    static last: FakeMap;
    sources = new Map<string, { setData: (data: unknown) => void }>();
    layers = new Map<string, { filter?: unknown }>();
    private handlers = new Map<string, Handler[]>();

    constructor() {
      FakeMap.last = this;
    }

    // on(event, handler) or on(event, layerId, handler); fire() takes the
    // same key, "event" or "event:layerId".
    on(event: string, layerOrHandler: string | Handler, handler?: Handler): void {
      const key = typeof layerOrHandler === "string" ? `${event}:${layerOrHandler}` : event;
      const h = typeof layerOrHandler === "string" ? handler : layerOrHandler;
      if (h) this.handlers.set(key, [...(this.handlers.get(key) ?? []), h]);
    }
    fire(key: string, e: unknown = {}): void {
      for (const h of this.handlers.get(key) ?? []) h(e);
    }

    setStyle(): void {
      this.sources.clear();
      this.layers.clear();
      this.fire("style.load");
    }
    isStyleLoaded(): boolean {
      return true;
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addSource(id: string): void {
      this.sources.set(id, { setData: () => {} });
    }
    getLayer(id: string) {
      return this.layers.get(id);
    }
    addLayer(layer: { id: string; filter?: unknown }): void {
      this.layers.set(layer.id, { filter: layer.filter });
    }
    setFilter(id: string, filter: unknown): void {
      const layer = this.layers.get(id);
      if (layer) layer.filter = filter;
    }
    setPaintProperty(): void {}
    setLayoutProperty(): void {}
    setMissingStyleImageResolver(): void {}
  }
  return { FakeMap };
});

vi.mock("maplibre-gl", () => ({ Map: FakeMap, setWorkerUrl: () => {} }));

import { MapView } from "./map-view";

const HI_LAYERS = ["geocow-fill-hi", "geocow-line-hi", "geocow-circle-hi", "geocow-symbol-hi"];

const PARK: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { title: "Park" },
      geometry: {
        type: "Polygon",
        coordinates: [[[-0.19, 51.51], [-0.15, 51.51], [-0.15, 51.5], [-0.19, 51.51]]],
      },
    },
  ],
};

/** A MapView with PARK loaded, and the fake map behind it. */
function loadedView(): { view: MapView; map: InstanceType<typeof FakeMap> } {
  const view = new MapView({
    container: {} as HTMLElement,
    config: NO_MAP_CONFIG,
    onMove: () => {},
    onFeatureClick: () => {},
  });
  const map = FakeMap.last;
  map.fire("style.load");
  view.setData(PARK, false);
  return { view, map };
}

/** Clicking a feature, as MapLibre reports it to a layer's click handler. */
function clickFeature(map: InstanceType<typeof FakeMap>, fid: number): void {
  map.fire("click:geocow-fill", { features: [{ properties: { __fid: fid } }] });
}

/** Whether every highlight layer is drawing the feature with this __fid. */
function highlights(map: InstanceType<typeof FakeMap>, fid: number): boolean {
  return HI_LAYERS.every((id) =>
    JSON.stringify(map.layers.get(id)?.filter).includes(`["==",["get","__fid"],${fid}]`),
  );
}

describe("MapView theme swap", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("requestAnimationFrame", () => 1);
  });

  it("keeps the selected feature highlighted", () => {
    const { view, map } = loadedView();
    clickFeature(map, 0);
    expect(highlights(map, 0)).toBe(true);

    view.setTheme("light", false);

    // The info box is still open and the rest still dimmed, so the
    // selection has to survive the rebuilt layers.
    expect(highlights(map, 0)).toBe(true);
  });

  it("highlights nothing when nothing was selected", () => {
    const { view, map } = loadedView();

    view.setTheme("light", false);

    expect(highlights(map, -1)).toBe(true);
  });
});
