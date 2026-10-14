import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { LightElement } from "./lit-base";
import { MapView } from "./map-view";
import {
  parseInput,
  parseFile,
  transformInput,
  transformFile,
  createShare,
  fetchShare,
} from "./api";
import { loadFile } from "./upload";
import { isProjected, summarise, type FeatureSummary } from "./geo";
import { sanitisePaste, looksLineDelimited } from "./sanitise";
import { NavigationTracker } from "./navigation";
import {
  NO_MAP_CONFIG,
  SCHEMES,
  fetchMapConfig,
  satelliteAvailable,
  type ColorScheme,
  type MapConfig,
} from "./config";
import {
  MAX_INLINE_SHARE_URL,
  compressText,
  hashFor,
  historyText,
  inlineShareUrl,
  pushHistory,
  shortShareUrl,
  clearSharedData,
  loadLastInput,
  readSharedDataRaw,
  readSharedId,
  readView,
  decompressText,
  saveLastInput,
  writeView,
  type ViewState,
} from "./state";

import {
  loadSettings,
  resolveSettings,
  saveSettings,
  type Settings,
} from "./settings";

import "./style-controls";
import "./paste-box";
import "./info-box";
import "./settings-panel";
import type { PasteStatus, PasteBox } from "./paste-box";
import type { StyleState } from "./style-controls";
import type { FeatureCollection } from "geojson";

const SCHEME_KEY = "geocow:scheme";
const SAT_KEY = "geocow:satellite";

// Above this size, a dropped file is *not* echoed into the paste box or saved
// to sessionStorage (which caps ~5 MB and would throw): both would choke on a
// 22 MB payload. The parsed geometry still goes straight to the map.
const LARGE_FILE_BYTES = 1_000_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement("geocow-app")
export class GeocowApp extends LightElement {
  private map!: MapView;

  @state() private scheme: ColorScheme = "system";
  @state() private satellite = false;
  @state() private mapConfig: MapConfig = NO_MAP_CONFIG;
  @state() private inputText = "";
  @state() private status: PasteStatus = "idle";
  @state() private message = "";
  @state() private summary: FeatureSummary | null = null;
  @state() private shared = false;
  @state() private toast = "";
  @state() private settings: Settings = loadSettings();
  @state() private dragging = false;

  private currentFc: FeatureCollection | null = null;
  private toastTimer?: number;
  // The `d=`/`s=` payload currently plotted, so a location change can tell
  // "new geometry" from "same geometry, different viewport".
  private loadedHashKey: string | null = null;
  // Set once the initial restore is done. Guards against a popstate fired
  // during load (some browsers do) racing the first plot.
  private ready = false;

  // Keeps the map, the URL and the history stack in agreement while camera
  // animations and parses are still in flight. See navigation.ts.
  private nav = new NavigationTracker();
  // The URL as we last left it, to tell a real navigation from our own writes
  // and from the second of the two events one navigation fires.
  private lastSeenHref = "";
  // Depth counter for drag enter/leave: nested elements each fire the pair, so
  // a plain boolean flickers. >0 means a file is being dragged over the page.
  private dragDepth = 0;

  private get pasteBox(): PasteBox | null {
    return this.querySelector("paste-box");
  }

  async firstUpdated() {
    // Tile keys come from the server, so the bundle carries none. If they
    // can't be had, say so and carry on with the keyless basemap.
    let configError = "";
    try {
      this.mapConfig = await fetchMapConfig();
    } catch (e) {
      configError = e instanceof Error ? e.message : String(e);
    }

    this.scheme = this.loadScheme();
    this.satellite =
      window.localStorage.getItem(SAT_KEY) === "1" && satelliteAvailable(this.mapConfig);
    const initialView = readView();

    const container = this.querySelector("#map") as HTMLElement;
    this.map = new MapView({
      container,
      config: this.mapConfig,
      initialView,
      onMove: (v, fromUser) => this.onMapMoved(v, fromUser),
      onFeatureClick: (f) => {
        this.summary = f ? summarise(f) : null;
      },
    });

    if (configError) this.flashToast(`${configError} — using the keyless basemap`);

    // Apply persisted theme once the first style settles.
    if (this.scheme !== "system" || this.satellite) {
      this.map.setTheme(this.scheme, this.satellite);
    }
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (this.scheme === "system" && !this.satellite) {
          this.map.setTheme("system", false);
        }
      });

    // `/` focuses the paste box when nothing editable is focused.
    window.addEventListener("keydown", this.onGlobalKey);

    // Drop a file anywhere on the page to load it. Listeners live on the
    // window so the whole viewport (map included) is a drop target.
    window.addEventListener("dragenter", this.onDragEnter);
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("dragleave", this.onDragLeave);
    window.addEventListener("drop", this.onDrop);

    // Paste a new geocow URL over the current one and the map follows it; so
    // do the back and forward buttons. Both events are needed — popstate for
    // a traversal, hashchange for a hash edited in the address bar — and a
    // single navigation fires both, which the handler deduplicates by URL.
    window.addEventListener("hashchange", this.onLocationChange);
    window.addEventListener("popstate", this.onLocationChange);

    const loadedFromHash = await this.loadFromHash({
      fitWhenNoView: true,
      generation: this.nav.generation,
    });
    if (!loadedFromHash) {
      const last = loadLastInput();
      if (last) await this.plot(last, !initialView);
    }
    this.noteUrl();
    this.ready = true;

    // Land with the cursor in the box: the overwhelmingly common first action
    // is pasting geometry. Don't select the restored text (typing shouldn't
    // wipe it), and leave touch devices alone rather than forcing the keyboard
    // up over the map.
    if (!window.matchMedia("(pointer: coarse)").matches) {
      this.pasteBox?.focusInput(false);
    }
  }

  /**
   * The camera moved: keep the URL in step with it.
   *
   * A gesture is always current — the user is dragging *this* entry's map, so
   * it is written straight away, mid-drag, rather than waiting for the map to
   * settle. A move the app started is only written if the entry it was
   * started for is still the one on screen; otherwise it is the tail end of
   * something the user has already navigated past, and writing it would
   * overwrite the entry they are now on.
   */
  private onMapMoved(v: ViewState, fromUser: boolean) {
    if (!this.nav.allowsViewWrite(fromUser)) return;
    writeView(v);
    this.noteUrl();
  }

  /**
   * Record the URL as one we produced, so the navigation handler can tell our
   * own writes and the twin events of a single navigation from a genuine move
   * to somewhere else.
   */
  private noteUrl() {
    this.lastSeenHref = window.location.href;
  }

  /**
   * Plot whatever the URL hash carries, if anything. Two link shapes: `d=`
   * holds the (compressed) geometry inline, `s=` references a server-stored
   * temporary payload we fetch first. Returns true if the hash had data.
   *
   * A hash-supplied viewport wins over auto-fitting, so a shared link lands on
   * exactly the view it was shared from.
   */
  private async loadFromHash({
    fitWhenNoView,
    generation,
  }: {
    fitWhenNoView: boolean;
    generation: number;
  }): Promise<boolean> {
    const shared = readSharedDataRaw();
    const shareId = readSharedId();
    if (!shared && !shareId) return false;

    this.shared = true;
    const fit = fitWhenNoView && !readView();
    try {
      const payload = shareId ? await fetchShare(shareId) : shared!;
      const text = await decompressText(payload);
      if (!(await this.plot(text, fit, [], generation))) return true;
      // Only now is this payload actually on the map. Recording it earlier
      // would mark a load that got superseded as done, and navigating back
      // to it would be skipped as "already showing".
      this.loadedHashKey = shareId ?? shared ?? null;
    } catch {
      if (!this.nav.isCurrent(generation)) return true;
      this.setStatus(
        "error",
        shareId
          ? "shared link has expired — the geometry is no longer stored"
          : "could not read shared geometry from link",
      );
    }
    return true;
  }

  /**
   * React to the location changing under us — a pasted URL, an anchor, or the
   * back/forward buttons. The viewport is applied whenever it differs; the
   * geometry is reloaded only when it actually changed, so dragging the map
   * doesn't replot and the two events this fires on don't do the work twice.
   */
  private onLocationChange = () => {
    if (!this.ready) return;
    // One navigation, two events: a hash change fires `popstate` *and*
    // `hashchange`. Acting on both would advance the generation a second
    // time and supersede the restore the first one just started, so the
    // geometry would never arrive. Compare the URL to the last one handled.
    if (window.location.href === this.lastSeenHref) return;
    this.noteUrl();

    // Everything below belongs to this entry. Anything still in flight for an
    // earlier one is now stale and will drop its results when it lands.
    const generation = this.nav.advance();

    const view = readView();
    if (view) {
      // Order matters. setView stops whatever the camera was doing, and that
      // abandoned move signs off as it goes; claiming the camera first would
      // let its parting position be written as this entry's view. Claim it
      // afterwards, so only the move starting now counts.
      this.map.setView(view);
      this.nav.beginCameraMove();
    }

    const key = readSharedId() ?? readSharedDataRaw() ?? null;
    if (key !== null) {
      if (key !== this.loadedHashKey) {
        void this.loadFromHash({ fitWhenNoView: true, generation });
      }
      return;
    }

    // No geometry in the URL. A history entry may still remember what was
    // plotted when it was created — that's how back/forward works across a
    // plot from the box, whose geometry never goes in the URL at all.
    this.loadedHashKey = null;
    this.shared = false;
    const remembered = historyText();
    if (remembered !== undefined && remembered !== this.inputText) {
      // The entry carries its own viewport, so don't refit over it.
      void this.plot(remembered, !view, [], generation);
    }
  };

  private onGlobalKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (this.summary) this.closeInfo();
      return;
    }
    if (e.key !== "/") return;
    const el = document.activeElement as HTMLElement | null;
    const tag = el?.tagName;
    const editable =
      tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable === true;
    if (editable) return;
    e.preventDefault();
    this.pasteBox?.focusInput();
  };

  /** Close the info box and drop the map's focus highlight. */
  private closeInfo = () => {
    this.summary = null;
    this.map.clearSelection();
  };

  // --- Drag & drop --------------------------------------------------------

  /** True while a file (not a text selection) is being dragged. */
  private static isFileDrag(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  private onDragEnter = (e: DragEvent) => {
    if (!GeocowApp.isFileDrag(e)) return;
    this.dragDepth++;
    this.dragging = true;
  };

  private onDragOver = (e: DragEvent) => {
    if (!GeocowApp.isFileDrag(e)) return;
    // Without preventDefault the browser navigates to / opens the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  private onDragLeave = (e: DragEvent) => {
    if (!GeocowApp.isFileDrag(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging = false;
  };

  private onDrop = (e: DragEvent) => {
    if (!GeocowApp.isFileDrag(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.dragging = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.plotFile(file);
  };

  /**
   * Load a dropped file and display it. GeoJSON/NDJSON are parsed in-browser;
   * WKT goes to the backend. Projected coordinates are reprojected server-side.
   * Large files bypass the paste box and sessionStorage — see LARGE_FILE_BYTES.
   */
  private async plotFile(file: File) {
    this.setStatus("loading", `reading ${file.name}…`);
    try {
      const loaded = await loadFile(file);

      // Coordinates outside lon/lat bounds are projected — assume EPSG:27700
      // (geocow's only projected CRS) and reproject server-side.
      let fc = loaded.fc;
      let note: string = loaded.format;
      if (isProjected(loaded.fc)) {
        this.setStatus("loading", `reprojecting ${file.name} (27700 → 4258)…`);
        fc = (await transformFile(loaded.text, 27700, 4258)).geojson;
        note = `${loaded.format} · transformed 27700 → 4258`;
        this.flashToast("Detected EPSG:27700 — reprojected to ETRS89 (4258)");
      }

      this.currentFc = fc;
      const large = loaded.bytes > LARGE_FILE_BYTES;
      // Big payloads would choke the textarea and blow the sessionStorage
      // quota, so keep them off both; the map holds the data regardless.
      this.inputText = large ? "" : loaded.text;
      this.applySettings();
      this.map.setData(fc, true);
      if (!large) saveLastInput(loaded.text);

      const n = fc.features.length;
      const size = formatBytes(loaded.bytes);
      this.setStatus(
        "ok",
        `${n.toLocaleString()} feature${n === 1 ? "" : "s"} · ${note} · ${file.name} (${size})`,
      );
      this.pushPlotted();
    } catch (err) {
      this.setStatus("error", err instanceof Error ? err.message : String(err));
    }
  }

  private loadScheme(): ColorScheme {
    const v = window.localStorage.getItem(SCHEME_KEY) as ColorScheme | null;
    return v && SCHEMES.some((s) => s.key === v) ? v : "system";
  }

  private setStatus(status: PasteStatus, message = "") {
    this.status = status;
    this.message = message;
  }

  /**
   * Parse, reproject if needed, and draw `text`. Returns false on failure.
   *
   * `generation` ties the work to a history entry: if the user navigates
   * again while a parse is in flight, the results are dropped rather than
   * painted over whatever they moved on to.
   */
  private async plot(
    text: string,
    fit = true,
    extraNotes: string[] = [],
    generation?: number,
  ): Promise<boolean> {
    const superseded = () =>
      !this.nav.isCurrent(generation);
    if (superseded()) return false;

    this.inputText = text;
    this.setStatus("loading");
    const suffix = extraNotes.length ? ` · ${extraNotes.join(" · ")}` : "";
    try {
      // One geometry parses through /api/parse (which can echo the transformed
      // text back into the box); several geometries need the line-aware
      // endpoint, same as a file drop.
      const lines = looksLineDelimited(text);
      const { format, geojson } = lines
        ? await parseFile(text)
        : await parseInput(text);
      if (superseded()) return false;

      if (isProjected(geojson)) {
        const t = lines
          ? { geojson: (await transformFile(text, 27700, 4258)).geojson, text }
          : await transformInput(text, 27700, 4258);
        if (superseded()) return false;
        this.nav.beginCameraMove();
        this.inputText = t.text;
        this.currentFc = t.geojson;
        this.applySettings();
        this.map.setData(t.geojson, fit);
        saveLastInput(t.text);
        const n = t.geojson.features.length;
        this.setStatus(
          "ok",
          `${n} feature${n === 1 ? "" : "s"} · transformed 27700 → 4258${suffix}`,
        );
        this.flashToast("Detected EPSG:27700 — reprojected to ETRS89 (4258)");
        return true;
      }

      this.nav.beginCameraMove();
      this.currentFc = geojson;
      this.applySettings();
      this.map.setData(geojson, fit);
      saveLastInput(text);
      const n = geojson.features.length;
      this.setStatus("ok", `${n} feature${n === 1 ? "" : "s"} · ${format}${suffix}`);
      return true;
    } catch (err) {
      if (superseded()) return false;
      this.setStatus("error", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Record a plot the user initiated as its own history entry, so back
   * returns to whatever was on screen before it.
   *
   * This is also where a stale share link is dropped: once different geometry
   * is plotted, the `s=`/`d=` in the URL no longer describes what's on
   * screen, and reloading it would quietly bring the old geometry back.
   */
  private pushPlotted() {
    this.nav.advance();
    // The fit is still animating, so record where it is going — otherwise the
    // entry pins the view the map is leaving, and the URL only catches up
    // when the animation ends.
    pushHistory(hashFor(this.map.getIntendedView()), this.inputText);
    this.noteUrl();
    // That in-flight fit now belongs to this entry, so its finishing position
    // is allowed to refine the hash.
    this.nav.adoptCameraMove();
    this.loadedHashKey = null;
    this.shared = false;
  }

  /**
   * Plot what the user typed or pasted, after putting it back together —
   * see sanitisePaste for the wrapping, table rules and stray punctuation it
   * undoes. The cleaned text replaces what's in the box, so what was plotted
   * is what's on screen.
   */
  private async onParse(e: CustomEvent<string>) {
    const { text, notes } = sanitisePaste(e.detail);
    if (!text) {
      this.setStatus("error", "nothing to plot");
      return;
    }
    if (await this.plot(text, true, notes)) this.pushPlotted();
  }

  /** Resolve settings against the loaded data's properties and push to the map. */
  private applySettings() {
    const keys = new Set<string>();
    if (this.currentFc) {
      for (const f of this.currentFc.features) {
        for (const k of Object.keys(f.properties ?? {})) keys.add(k);
      }
    }
    this.map.setSettings(resolveSettings(this.settings, (p) => keys.has(p)));
  }

  private onSettingsChange(e: CustomEvent<Settings>) {
    this.settings = e.detail;
    saveSettings(this.settings);
    this.applySettings();
    this.map.ensureExtrusionPitch();
  }

  private onStyleChange(e: CustomEvent<StyleState>) {
    this.scheme = e.detail.scheme;
    this.satellite = e.detail.satellite;
    window.localStorage.setItem(SCHEME_KEY, this.scheme);
    window.localStorage.setItem(SAT_KEY, this.satellite ? "1" : "0");
    this.map.setTheme(this.scheme, this.satellite);
  }

  private async share() {
    if (!this.inputText) {
      this.flashToast("Nothing to share yet — plot something first");
      return;
    }
    try {
      const view = this.map.getIntendedView();
      const data = await compressText(this.inputText);
      // Prefer a self-contained link; if it would be unwieldy to paste
      // (Slack et al.), fall back to a temporary server-stored short link.
      const inline = inlineShareUrl(view, data);
      let url = inline;
      let key = data;
      let temporary = false;
      if (inline.length > MAX_INLINE_SHARE_URL) {
        key = await createShare(data);
        url = shortShareUrl(view, key);
        temporary = true;
      }
      // Push, so back undoes the share and returns to the plain URL.
      this.nav.advance();
      this.nav.adoptCameraMove();
      pushHistory(url, this.inputText);
      this.noteUrl();
      // The URL now carries what's already plotted; don't reload it when the
      // resulting navigation comes back round.
      this.loadedHashKey = key;
      await navigator.clipboard.writeText(url);
      this.shared = true;
      this.flashToast(
        temporary
          ? "Large geometry — copied a temporary short link"
          : "Share link copied to clipboard",
      );
    } catch {
      this.flashToast("Couldn't copy link");
    }
  }

  private clearUrl() {
    this.nav.advance();
    this.nav.adoptCameraMove();
    clearSharedData(this.map.getIntendedView(), this.inputText);
    this.noteUrl();
    this.loadedHashKey = null;
    this.shared = false;
    this.flashToast("URL cleared");
  }

  private flashToast(msg: string) {
    this.toast = msg;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = ""), 2600);
  }

  render() {
    const chrome =
      "rounded-lg bg-white/90 px-3 py-2 text-sm font-medium text-neutral-800 shadow-md backdrop-blur transition hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-100 dark:hover:bg-neutral-800";
    return html`
      <div id="map" class="absolute inset-0"></div>

      ${this.dragging
        ? html`<div
            class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-neutral-900/40 backdrop-blur-sm"
          >
            <div
              class="rounded-2xl border-2 border-dashed border-white/80 bg-neutral-900/70 px-10 py-8 text-center text-white shadow-2xl"
            >
              <div class="text-lg font-semibold">Drop to plot</div>
              <div class="mt-1 text-sm text-white/70">
                GeoJSON · line-delimited GeoJSON · WKT-per-line
              </div>
            </div>
          </div>`
        : nothing}

      <div class="absolute left-3 top-3 z-10">
        <settings-panel
          .settings=${this.settings}
          @settings-change=${this.onSettingsChange}
        ></settings-panel>
      </div>

      <div class="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
        <div class="flex gap-2">
          <style-controls
            .scheme=${this.scheme}
            .satellite=${this.satellite}
            .satelliteAvailable=${satelliteAvailable(this.mapConfig)}
            @style-change=${this.onStyleChange}
          ></style-controls>
          <button @click=${this.share} title="Copy a link reproducing this view and geometry (large geometry gets a temporary short link)" class=${chrome}>
            Share
          </button>
          ${this.shared
            ? html`<button
                @click=${this.clearUrl}
                title="Remove the shared geometry from the URL"
                class=${chrome}
              >
                Clear URL
              </button>`
            : nothing}
        </div>
        <info-box
          .summary=${this.summary}
          @close=${this.closeInfo}
        ></info-box>
      </div>

      <!-- Full-width strip, so the box centres — but it must not eat map
           clicks either side of it; the box itself re-enables pointer events. -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4"
      >
        <paste-box
          class="w-full max-w-2xl"
          .value=${this.inputText}
          .status=${this.status}
          .message=${this.message}
          @parse=${this.onParse}
        ></paste-box>
      </div>

      ${this.toast
        ? html`<div
            class="absolute bottom-44 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-neutral-900/90 px-4 py-2 text-sm text-white shadow-lg dark:bg-neutral-100/90 dark:text-neutral-900"
          >
            ${this.toast}
          </div>`
        : ""}
    `;
  }
}
