import maplibregl, {
  type GeoJSONSource,
  type MapMouseEvent,
  type FilterSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection } from "geojson";

import {
  DEFAULT_VIEW,
  GEOM_COLOR,
  GEOM_SOURCE,
  aerialInsertBefore,
  resolveStyleUrl,
  type ColorScheme,
  type MapConfig,
} from "./config";
import { collectionBBox } from "./geo";
import { planFit, pitchOption, viewsMatch } from "./camera";
import { buildColorExpression } from "./colors";
import {
  DIM_MS,
  HI_MS,
  basePaint,
  highlightPaint,
  easeOutCubic,
  easeOutBack,
  mix,
} from "./selection";
import type { EffectiveSettings } from "./settings";
import type { ViewState } from "./state";

const FILL_LAYER = "geocow-fill";
const EXTRUDE_LAYER = "geocow-extrude";
const LINE_LAYER = "geocow-line";
const CIRCLE_LAYER = "geocow-circle";
// Highlight layers render only the selected feature, on top of the (dimmed)
// base layers, so its constant paint can be animated (data-driven can't be).
const FILL_HI_LAYER = "geocow-fill-hi";
const LINE_HI_LAYER = "geocow-line-hi";
const CIRCLE_HI_LAYER = "geocow-circle-hi";
// The fill and extrude layers are mutually exclusive (2D vs 3D — see
// applySettings), so listing both means the polygon *body* is clickable in
// either mode. Without EXTRUDE_LAYER here, a 3D-extruded polygon only responds
// to clicks on its boundary (the still-visible line layer), not its face.
const INTERACTIVE_LAYERS = [FILL_LAYER, EXTRUDE_LAYER, LINE_LAYER, CIRCLE_LAYER];

// __fid sentinel that no real feature carries: the highlight filters match it
// when nothing is selected, so the highlight layers draw nothing.
const NO_SELECTION = -1;

const POLY_TYPES = ["Polygon", "MultiPolygon"];
const LINE_TYPES = ["Polygon", "MultiPolygon", "LineString", "MultiLineString"];
const POINT_TYPES = ["Point", "MultiPoint"];

/** MapLibre's LngLatLike is a union; normalise whichever shape we're handed. */
function toLngLatArray(
  c: maplibregl.LngLatLike | undefined,
): [number, number] | undefined {
  if (!c) return undefined;
  const ll = maplibregl.LngLat.convert(c);
  return [ll.lng, ll.lat];
}

/** A single rAF tween leg: interpolate `from`→`to` over `dur` ms, `p` linear. */
interface Tween {
  from: number;
  to: number;
  start: number;
  dur: number;
  p: number;
}

/** Filter matching one feature (by __fid) of the given geometry types. */
function hiFilter(types: string[], fid: number): FilterSpecification {
  return [
    "all",
    ["match", ["geometry-type"], types, true, false],
    ["==", ["get", "__fid"], fid],
  ] as FilterSpecification;
}

const DEFAULT_SETTINGS: EffectiveSettings = {
  extrude: false,
  extrudeProp: "height",
  color: false,
  colorProp: "c",
  colorMin: 0,
  colorMax: 100,
  colorScheme: "viridis",
};

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

// Optional hi-res aerial overlay (GEOCOW_AERIAL_TILE_URL), drawn in satellite
// mode. Over the MapTiler hybrid the basemap imagery shows instantly while
// the higher-res tiles draw on top.
const AERIAL_SOURCE = "geocow-aerial";
const AERIAL_LAYER = "geocow-aerial";

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export interface MapViewOptions {
  container: HTMLElement;
  config: MapConfig;
  initialView?: ViewState;
  /**
   * The camera moved. `fromUser` distinguishes a gesture from a move the app
   * asked for — the caller needs it to decide whether a write to the URL is
   * still wanted by the time it arrives.
   */
  onMove: (view: ViewState, fromUser: boolean) => void;
  onFeatureClick: (feature: Feature | null) => void;
}

// How often the camera reports itself *during* a gesture or animation. The
// URL should track the map rather than snapping into place when it stops, but
// one write per frame would hit Safari's cap of 100 history writes per 30s.
const MOVE_REPORT_MS = 400;

// How long the camera takes to reach a view restored from the URL. Shorter
// than a fit: this is following a navigation, so it should feel like a step
// rather than a tour, and holding back through several entries shouldn't
// queue up seconds of animation.
const RESTORE_MS = 400;

/** Thin wrapper around a MapLibre map: data layers, theme swaps, callbacks. */
export class MapView {
  private map: maplibregl.Map;
  private features: Feature[] = [];
  private data: FeatureCollection = EMPTY_FC;
  private satellite = false;
  private settings: EffectiveSettings = DEFAULT_SETTINGS;
  // __fid of the feature whose info box is open, or null. Drives the focus
  // effect: selected feature vivid, the rest faded.
  private selectedFid: number | null = null;
  // Two tweens animated by rAF: `dim` fades the other features, `hi` pops the
  // selected one. `p` is linear progress [0,1] of the current leg; easing is
  // applied to `p` (not the interpolated value) so reversing starts promptly.
  private dim: Tween = { from: 0, to: 0, start: 0, dur: DIM_MS, p: 1 };
  private hi: Tween = { from: 0, to: 0, start: 0, dur: HI_MS, p: 1 };
  private rafId: number | null = null;
  // Timestamp of the last onMove report, for the MOVE_REPORT_MS throttle.
  private lastMoveReport = 0;
  // Where an in-flight fit is heading, so callers can record the destination
  // instead of a frame of the animation. Cleared when the camera settles.
  private targetView: ViewState | null = null;
  // True while a camera move this class started is in flight. Set at the call
  // site rather than inferred from the event, so there is no question of
  // which moves count as the user's.
  private programmaticMove = false;

  constructor(private opts: MapViewOptions) {
    const view = opts.initialView ?? DEFAULT_VIEW;
    this.map = new maplibregl.Map({
      container: opts.container,
      style: resolveStyleUrl(opts.config, "system", false, prefersDark()),
      center: view.center,
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
      // Tile providers require attribution; compact keeps it to an ⓘ.
      attributionControl: { compact: true },
    });

    // this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");

    // Re-add our overlays whenever a style finishes loading (initial load and
    // every theme swap wipe style-owned sources). Aerial first (under labels),
    // then geometry on top.
    this.map.on("style.load", () => {
      this.installAerialOverlay();
      this.installDataLayers();
    });

    // Report the camera while the user is moving it, not only once it
    // settles, so the URL is right if it's copied mid-gesture.
    //
    // Animations we started are excluded: they publish their destination
    // before they set off (see fitToData), and reporting the frames in
    // between would overwrite that with a view nobody asked to be at.
    this.map.on("move", () => {
      if (this.programmaticMove) return;
      const now = performance.now();
      if (now - this.lastMoveReport < MOVE_REPORT_MS) return;
      this.lastMoveReport = now;
      this.opts.onMove(this.getView(), true);
    });
    this.map.on("moveend", () => {
      const fromUser = !this.programmaticMove;
      this.programmaticMove = false;
      this.targetView = null;
      this.lastMoveReport = performance.now();
      this.opts.onMove(this.getView(), fromUser);
    });

    for (const layer of INTERACTIVE_LAYERS) {
      this.map.on("click", layer, (e) => this.handleClick(e));
      this.map.on("mouseenter", layer, () => {
        this.map.getCanvas().style.cursor = "pointer";
      });
      this.map.on("mouseleave", layer, () => {
        this.map.getCanvas().style.cursor = "";
      });
    }

    // Click on empty map clears the infobox and the focus effect.
    this.map.on("click", (e) => {
      const hits = this.map.queryRenderedFeatures(e.point, {
        layers: INTERACTIVE_LAYERS,
      });
      if (hits.length === 0) {
        this.setSelection(null);
        this.opts.onFeatureClick(null);
      }
    });
  }

  private installAerialOverlay(): void {
    const { aerialTileUrl, aerialAttribution, maptilerKey } = this.opts.config;
    if (!this.satellite || !aerialTileUrl) return;
    if (!this.map.getSource(AERIAL_SOURCE)) {
      this.map.addSource(AERIAL_SOURCE, {
        type: "raster",
        tiles: [aerialTileUrl],
        tileSize: 256,
        maxzoom: 21,
        ...(aerialAttribution ? { attribution: aerialAttribution } : {}),
      });
    }
    if (!this.map.getLayer(AERIAL_LAYER)) {
      // With a MapTiler key the satellite basemap is imagery; without one
      // it's the light vector style. See aerialInsertBefore.
      const beforeId = aerialInsertBefore(this.map.getStyle().layers ?? [], maptilerKey !== null);
      this.map.addLayer({ id: AERIAL_LAYER, type: "raster", source: AERIAL_SOURCE }, beforeId);
    }
  }

  private installDataLayers(): void {
    if (!this.map.getSource(GEOM_SOURCE)) {
      this.map.addSource(GEOM_SOURCE, { type: "geojson", data: this.data });
    }
    if (!this.map.getLayer(FILL_LAYER)) {
      this.map.addLayer({
        id: FILL_LAYER,
        type: "fill",
        source: GEOM_SOURCE,
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: { "fill-color": GEOM_COLOR, "fill-opacity": 0.25 },
      });
    }
    if (!this.map.getLayer(EXTRUDE_LAYER)) {
      this.map.addLayer({
        id: EXTRUDE_LAYER,
        type: "fill-extrusion",
        source: GEOM_SOURCE,
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": GEOM_COLOR,
          "fill-extrusion-opacity": 0.85,
          "fill-extrusion-base": 0,
          "fill-extrusion-height": 0,
        },
      });
    }
    if (!this.map.getLayer(LINE_LAYER)) {
      this.map.addLayer({
        id: LINE_LAYER,
        type: "line",
        source: GEOM_SOURCE,
        filter: [
          "match",
          ["geometry-type"],
          ["Polygon", "MultiPolygon", "LineString", "MultiLineString"],
          true,
          false,
        ],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": GEOM_COLOR, "line-width": 2.5, "line-opacity": 0.95 },
      });
    }
    if (!this.map.getLayer(CIRCLE_LAYER)) {
      this.map.addLayer({
        id: CIRCLE_LAYER,
        type: "circle",
        source: GEOM_SOURCE,
        filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
        paint: {
          "circle-radius": 6,
          "circle-color": GEOM_COLOR,
          "circle-opacity": 0.9,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    }
    this.installHighlightLayers();
    this.applySettings();
  }

  /** Highlight layers: one feature (the selection) drawn vividly on top. Paint
   * starts invisible and is animated by the rAF loop. `*-transition: 0` so our
   * per-frame constants apply immediately rather than double-easing. */
  private installHighlightLayers(): void {
    if (!this.map.getLayer(FILL_HI_LAYER)) {
      this.map.addLayer({
        id: FILL_HI_LAYER,
        type: "fill",
        source: GEOM_SOURCE,
        filter: hiFilter(POLY_TYPES, NO_SELECTION),
        paint: {
          "fill-color": GEOM_COLOR,
          "fill-opacity": 0,
          "fill-opacity-transition": { duration: 0 },
        },
      });
    }
    if (!this.map.getLayer(LINE_HI_LAYER)) {
      this.map.addLayer({
        id: LINE_HI_LAYER,
        type: "line",
        source: GEOM_SOURCE,
        filter: hiFilter(LINE_TYPES, NO_SELECTION),
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": GEOM_COLOR,
          "line-width": 2.5,
          "line-opacity": 0,
          "line-width-transition": { duration: 0 },
          "line-opacity-transition": { duration: 0 },
        },
      });
    }
    if (!this.map.getLayer(CIRCLE_HI_LAYER)) {
      this.map.addLayer({
        id: CIRCLE_HI_LAYER,
        type: "circle",
        source: GEOM_SOURCE,
        filter: hiFilter(POINT_TYPES, NO_SELECTION),
        paint: {
          "circle-radius": 6,
          "circle-color": GEOM_COLOR,
          "circle-opacity": 0,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": 0,
          "circle-radius-transition": { duration: 0 },
          "circle-opacity-transition": { duration: 0 },
          "circle-stroke-opacity-transition": { duration: 0 },
        },
      });
    }
  }

  /** The active geometry colour: a colour-by expression or the flat accent. */
  private colorExpression(): unknown {
    const s = this.settings;
    return s.color
      ? buildColorExpression(s.colorProp, s.colorMin, s.colorMax, s.colorScheme)
      : GEOM_COLOR;
  }

  /** Apply colour-by-value and extrusion settings to the data layers. */
  private applySettings(): void {
    if (!this.map.getLayer(FILL_LAYER)) return; // layers not installed yet
    const s = this.settings;

    // Colour, shared by the base and highlight layers so a focused feature
    // keeps its colour-by shade.
    const colorExpr = this.colorExpression();
    this.map.setPaintProperty(FILL_LAYER, "fill-color", colorExpr as never);
    this.map.setPaintProperty(LINE_LAYER, "line-color", colorExpr as never);
    this.map.setPaintProperty(CIRCLE_LAYER, "circle-color", colorExpr as never);
    this.map.setPaintProperty(EXTRUDE_LAYER, "fill-extrusion-color", colorExpr as never);
    this.map.setPaintProperty(FILL_HI_LAYER, "fill-color", colorExpr as never);
    this.map.setPaintProperty(LINE_HI_LAYER, "line-color", colorExpr as never);
    this.map.setPaintProperty(CIRCLE_HI_LAYER, "circle-color", colorExpr as never);

    // Extrusion: height from the chosen property; swap flat fill for 3D. The
    // flat highlight fill hides in 3D too (its outline still reads).
    const heightExpr: unknown = ["coalesce", ["to-number", ["get", s.extrudeProp]], 0];
    this.map.setPaintProperty(EXTRUDE_LAYER, "fill-extrusion-height", heightExpr as never);
    this.map.setLayoutProperty(EXTRUDE_LAYER, "visibility", s.extrude ? "visible" : "none");
    this.map.setLayoutProperty(FILL_LAYER, "visibility", s.extrude ? "none" : "visible");
    this.map.setLayoutProperty(FILL_HI_LAYER, "visibility", s.extrude ? "none" : "visible");

    // Reassert the current animation frame (a style reload resets paint).
    this.renderFocus();
  }

  /** Point the highlight layers at the selected feature (or nothing). */
  private setHighlightFilters(fid: number): void {
    if (!this.map.getLayer(FILL_HI_LAYER)) return;
    this.map.setFilter(FILL_HI_LAYER, hiFilter(POLY_TYPES, fid));
    this.map.setFilter(LINE_HI_LAYER, hiFilter(LINE_TYPES, fid));
    this.map.setFilter(CIRCLE_HI_LAYER, hiFilter(POINT_TYPES, fid));
  }

  /** Current displayed amount of a tween (eased, for continuity on retarget). */
  private static amount(tw: Tween): number {
    return mix(tw.from, tw.to, easeOutCubic(tw.p));
  }

  /** Push the current eased scalars into layer paint (one animation frame). */
  private renderFocus(): void {
    if (!this.map.getLayer(FILL_LAYER)) return; // layers not installed yet
    const dim = mix(this.dim.from, this.dim.to, easeOutCubic(this.dim.p));
    const base = basePaint(dim);
    this.map.setPaintProperty(FILL_LAYER, "fill-opacity", base.fillOpacity as never);
    this.map.setPaintProperty(LINE_LAYER, "line-opacity", base.lineOpacity as never);
    this.map.setPaintProperty(CIRCLE_LAYER, "circle-opacity", base.circleOpacity as never);
    this.map.setPaintProperty(
      CIRCLE_LAYER,
      "circle-stroke-opacity",
      base.circleStrokeOpacity as never,
    );

    // Opacity eases smoothly; size springs (easeOutBack) off the same progress.
    const fade = mix(this.hi.from, this.hi.to, easeOutCubic(this.hi.p));
    const pop = mix(this.hi.from, this.hi.to, easeOutBack(this.hi.p));
    const hi = highlightPaint(fade, pop);
    this.map.setPaintProperty(FILL_HI_LAYER, "fill-opacity", hi.fillOpacity as never);
    this.map.setPaintProperty(LINE_HI_LAYER, "line-opacity", hi.lineOpacity as never);
    this.map.setPaintProperty(LINE_HI_LAYER, "line-width", hi.lineWidth as never);
    this.map.setPaintProperty(CIRCLE_HI_LAYER, "circle-opacity", hi.circleOpacity as never);
    this.map.setPaintProperty(CIRCLE_HI_LAYER, "circle-radius", hi.circleRadius as never);
    this.map.setPaintProperty(
      CIRCLE_HI_LAYER,
      "circle-stroke-opacity",
      hi.circleStrokeOpacity as never,
    );
  }

  /** Start a new tween leg to `to`, continuing from `from` (default: current
   * displayed value), and ensure the animation loop is running. */
  private tweenTo(tw: Tween, to: number, from = MapView.amount(tw)): void {
    tw.from = from;
    tw.to = to;
    tw.p = 0;
    tw.start = performance.now();
    if (this.rafId == null) this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    const now = performance.now();
    const step = (tw: Tween): boolean => {
      tw.p = Math.min(1, (now - tw.start) / tw.dur);
      return tw.p >= 1;
    };
    const done = [step(this.dim), step(this.hi)].every(Boolean);
    this.renderFocus();
    this.rafId = done ? null : requestAnimationFrame(this.frame);
  };

  /** Focus a feature (`fid`) or clear the focus (`null`), with animation. */
  private setSelection(fid: number | null): void {
    if (fid === this.selectedFid) return;
    const hadSelection = this.selectedFid != null;
    this.selectedFid = fid;

    if (fid != null) {
      this.setHighlightFilters(fid);
      // Fresh selection dims the rest; switching A→B keeps them dimmed. Either
      // way the highlight replays from 0 so the new feature springs in.
      if (!hadSelection) this.tweenTo(this.dim, 1);
      this.tweenTo(this.hi, 1, 0);
    } else {
      this.tweenTo(this.dim, 0);
      this.tweenTo(this.hi, 0);
    }
  }

  /** Clear the focus effect — called when the info box closes. */
  clearSelection(): void {
    this.setSelection(null);
  }

  /** Snap the focus state back to nothing-selected, no animation (new data). */
  private resetFocus(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.selectedFid = null;
    this.dim = { from: 0, to: 0, start: 0, dur: DIM_MS, p: 1 };
    this.hi = { from: 0, to: 0, start: 0, dur: HI_MS, p: 1 };
  }

  /** Update display settings (colour-by / extrusion) and re-render. */
  setSettings(s: EffectiveSettings): void {
    this.settings = s;
    this.applySettings();
  }

  /** Tilt so extrusions are visible. Call on a manual toggle — NOT during a
   * fit, where the pitch is folded into fitBounds to avoid cancelling it. */
  ensureExtrusionPitch(): void {
    if (this.settings.extrude && this.map.getPitch() < 5) {
      this.beginProgrammaticMove({ ...this.getView(), pitch: 45 });
      this.map.easeTo({ pitch: 45, duration: 600 });
    }
  }

  private handleClick(e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }): void {
    const hit = e.features?.[0];
    if (!hit) return;
    const fid = hit.properties?.__fid;
    if (typeof fid === "number") this.setSelection(fid);
    const original = typeof fid === "number" ? this.features[fid] : undefined;
    this.opts.onFeatureClick(original ?? (hit as unknown as Feature));
  }

  /** Replace displayed geometry. When `fit` is true, zoom to its extent. */
  setData(fc: FeatureCollection, fit = true): void {
    this.resetFocus(); // old __fid no longer refers to anything
    this.features = fc.features;
    // Tag each feature with its index so clicks can recover the original.
    this.data = {
      type: "FeatureCollection",
      features: fc.features.map((f, i) => ({
        ...f,
        properties: { ...(f.properties ?? {}), __fid: i },
      })),
    };
    const source = this.map.getSource(GEOM_SOURCE) as GeoJSONSource | undefined;
    if (source) {
      source.setData(this.data);
      this.setHighlightFilters(NO_SELECTION);
      this.renderFocus(); // snap layers back to the unfocused look
    } else if (this.map.isStyleLoaded()) {
      this.installDataLayers();
    }

    if (fit) this.fitToData();
  }

  fitToData(): void {
    const bbox = collectionBBox(this.data);
    if (!bbox) return;
    // The extrusion tilt is folded into the fit so it's one camera move, not
    // two competing animations. `pitchOption` yields `{}` (not
    // `{ pitch: undefined }`) when flat — see camera.ts for why that matters.
    const plan = planFit(bbox, this.map.getZoom(), this.settings.extrude);

    // Asymmetric padding keeps geometry clear of the bottom paste box, the
    // top-right controls and the right-hand infobox.
    const padding = { top: 80, right: 320, bottom: 200, left: 80 };

    const target: maplibregl.CameraOptions =
      plan.kind === "point"
        ? { center: plan.center, zoom: plan.zoom }
        : (this.map.cameraForBounds(plan.bounds, { padding, maxZoom: 17 }) ?? {});

    // Work out where the camera is going *before* it sets off, so a caller
    // recording this moment in history can record the view it will end on
    // rather than the one it is leaving.
    const now = this.getView();
    this.beginProgrammaticMove({
      center: toLngLatArray(target.center) ?? now.center,
      zoom: target.zoom ?? now.zoom,
      bearing: target.bearing ?? now.bearing,
      pitch: plan.pitch ?? now.pitch,
    });

    if (plan.kind === "point") {
      this.map.easeTo({ ...target, ...pitchOption(plan), duration: 600 });
    } else {
      this.map.fitBounds(plan.bounds, {
        padding,
        maxZoom: 17,
        ...pitchOption(plan),
        duration: 600,
      });
    }
  }

  setTheme(scheme: ColorScheme, satellite: boolean): void {
    // setStyle wipes custom sources/layers; style.load re-installs them
    // (including the aerial overlay, which keys off this flag).
    this.satellite = satellite;
    this.map.setStyle(resolveStyleUrl(this.opts.config, scheme, satellite, prefersDark()), {
      diff: false,
    });
  }

  getView(): ViewState {
    const c = this.map.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
    };
  }

  /**
   * Where the camera will be once it stops — the destination of a fit that is
   * still animating, or simply where it is now.
   *
   * Callers recording the current state (a history entry, a share link) want
   * this, not [`getView`]: mid-flight, `getView` is a frame of the animation
   * and would pin the record to a view nobody asked for.
   */
  getIntendedView(): ViewState {
    return this.targetView ?? this.getView();
  }

  /**
   * Move the camera to `v`. Used when the URL changes under us — a pasted
   * link, or back/forward.
   *
   * Animated, so the move reads as a move. The URL doesn't have to wait for
   * it: the destination is published before the camera sets off, and the
   * frames in between are never reported, so at every instant the URL says
   * where the map is going rather than where it happens to be.
   *
   * Any animation already running is stopped first. That ends it cleanly
   * *before* the new destination is recorded — its parting `moveend` then
   * belongs to the move being abandoned, and the caller can tell it apart
   * from this one.
   */
  setView(v: ViewState): void {
    if (viewsMatch(this.getView(), v)) return;
    this.beginProgrammaticMove(v);
    this.map.easeTo({
      center: v.center,
      zoom: v.zoom,
      bearing: v.bearing,
      pitch: v.pitch,
      duration: RESTORE_MS,
    });
  }

  /**
   * Take ownership of the camera for a move this class is about to start.
   *
   * Stopping first matters: beginning an animation while another is running
   * makes MapLibre end the old one, and that sign-off would otherwise land
   * *after* the new destination was recorded and wipe it. Ending it up front
   * keeps the two moves distinguishable — the old one's parting report is
   * still attributed to the old one.
   */
  private beginProgrammaticMove(target: ViewState): void {
    this.map.stop();
    this.programmaticMove = true;
    this.targetView = target;
  }

  hasData(): boolean {
    return this.features.length > 0;
  }
}
