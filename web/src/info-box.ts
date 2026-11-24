import { html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { FeatureCollection } from "geojson";

import { LightElement } from "./lit-base";
import { formatArea, formatLength, type FeatureSummary } from "./geo";
import { featureText } from "./simplestyle";
import { collectionStats, type KeyStats } from "./props";
import { FOCUS, HAIRLINE, INK, MUTED, copiedFlag, copyFrom, ownProps } from "./prop-view";
import "./property-list";

/** Property keys that commonly name a feature, in order of preference. */
const NAME_KEYS = ["name", "Name", "NAME", "title", "label"];

/**
 * The box for the feature clicked on the map: its name (or geometry type)
 * and measurements, its properties (property-list.ts), and copy buttons.
 */
@customElement("info-box")
export class InfoBox extends LightElement {
  @property({ attribute: false }) summary: FeatureSummary | null = null;
  /** Everything plotted, so a feature can be read against the rest. */
  @property({ attribute: false }) collection: FeatureCollection | null = null;
  /** The property the map is coloured by, if any. */
  @property({ attribute: false }) colorProp: string | null = null;

  // The feature shown before this one, for the pinned tiles' "was" lines.
  private previous: FeatureSummary | null = null;
  private lastShown: FeatureSummary | null = null;
  private stats: Map<string, KeyStats> | null = null;
  private statsFor: FeatureCollection | null = null;

  protected willUpdate(changed: PropertyValues<this>) {
    if (changed.has("collection")) {
      this.previous = null;
      this.lastShown = null;
    }
    if (changed.has("summary") && this.summary && this.summary !== this.lastShown) {
      this.previous = this.lastShown;
      this.lastShown = this.summary;
    }
  }

  /** Collection statistics, computed once per collection, on first use. */
  private collectionStats(): Map<string, KeyStats> {
    if (!this.collection) return new Map();
    if (this.statsFor !== this.collection) {
      this.stats = collectionStats(this.collection.features);
      this.statsFor = this.collection;
    }
    return this.stats ?? new Map();
  }

  private close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true }));
  }

  render() {
    const s = this.summary;
    if (!s) return nothing;
    // Room for the context column only when there's a collection to compare
    // against. Full viewport height once the viewport is wide enough for the
    // box to clear the centred paste box (42rem, plus the box and its margin
    // on each side); shorter below that, so the two don't overlap.
    const size =
      (this.collection?.features.length ?? 0) >= 2
        ? "w-[min(28rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-17rem)] min-[1600px]:max-h-[calc(100dvh-4.5rem)]"
        : "w-[min(24rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-17rem)] min-[1480px]:max-h-[calc(100dvh-4.5rem)]";
    return html`<section
      aria-label="Feature properties"
      class="pointer-events-auto flex ${size} flex-col overflow-hidden rounded-xl bg-white/95 shadow-xl backdrop-blur dark:bg-neutral-900/95"
    >
      ${this.renderHeader(s)}
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <property-list
          class="block"
          .summary=${s}
          .previous=${this.previous}
          .stats=${this.collectionStats()}
          .colorProp=${this.colorProp}
        ></property-list>
      </div>
      ${this.renderFooter(s)}
    </section>`;
  }

  private renderHeader(s: FeatureSummary) {
    const { title, description } = featureText(s.properties);
    const named =
      title ??
      NAME_KEYS.map((k) => s.properties[k]).find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      ) ??
      null;
    const measure = (label: string, value: string) =>
      html`<div class="flex items-baseline gap-1.5">
        <dt class=${MUTED}>${label}</dt>
        <dd class="text-[13px] ${INK}">${value}</dd>
      </div>`;
    const measures = [];
    if (s.area != null) measures.push(measure("Area", formatArea(s.area)));
    if (s.length != null) {
      measures.push(measure(s.area != null ? "Perimeter" : "Length", formatLength(s.length)));
    }
    if (s.point) {
      const [lng, lat] = s.point;
      measures.push(measure("Lng, lat", `${lng.toFixed(6)}, ${lat.toFixed(6)}`));
    }
    measures.push(measure("Vertices", s.vertices.toLocaleString()));
    const bbox = s.bbox && !s.point ? s.bbox.map((v) => v.toFixed(6)) : null;

    return html`<header class="shrink-0 px-4 pb-2 pt-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="break-words text-[17px] font-semibold leading-tight ${INK}">
            ${named ?? s.type}
          </h2>
          ${named ? html`<p class="mt-0.5 text-[12px] ${MUTED}">${s.type}</p>` : nothing}
          ${description
            ? // Inline on purpose: pre-line would render the template's newlines.
              html`<p
                class="mt-1 max-h-24 overflow-y-auto overscroll-contain whitespace-pre-line break-words text-[13px] leading-snug text-neutral-700 dark:text-neutral-200"
              >${description}</p>`
            : nothing}
        </div>
        <button
          type="button"
          @click=${this.close}
          class="-mr-1.5 rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 ${FOCUS}"
          title="Close (Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <dl class="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px]">${measures}</dl>
      ${bbox
        ? html`<p class="mt-0.5 text-[11px] tabular-nums ${MUTED}">
            SW ${bbox[1]}, ${bbox[0]} &nbsp; NE ${bbox[3]}, ${bbox[2]}
          </p>`
        : nothing}
    </header>`;
  }

  private renderFooter(s: FeatureSummary) {
    const geometry = s.geojson || "null";
    const feature = `{"type":"Feature","geometry":${geometry},"properties":${JSON.stringify(
      ownProps(s.properties),
    )}}`;
    const button = (label: string, text: string, hint: string) =>
      html`<button
        type="button"
        title=${hint}
        @click=${(e: Event) => copyFrom(e.currentTarget as HTMLElement, text)}
        class="group relative flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800 ${FOCUS}"
      >
        ${label}${copiedFlag}
      </button>`;
    return html`<footer class="flex shrink-0 gap-2 border-t ${HAIRLINE} px-4 py-2.5">
      ${button("Copy feature", feature, "Copy this feature as GeoJSON, properties included")}
      ${button("Copy geometry", geometry, "Copy only the geometry, as GeoJSON")}
    </footer>`;
  }
}
