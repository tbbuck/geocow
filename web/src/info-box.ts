import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { LightElement } from "./lit-base";
import { formatArea, formatLength, type FeatureSummary } from "./geo";
import { featureText } from "./simplestyle";

@customElement("info-box")
export class InfoBox extends LightElement {
  @property({ attribute: false }) summary: FeatureSummary | null = null;
  @state() private copied = false;

  private close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true }));
  }

  private async copyGeoJson() {
    if (!this.summary?.geojson) return;
    try {
      await navigator.clipboard.writeText(this.summary.geojson);
      this.copied = true;
      window.setTimeout(() => (this.copied = false), 1500);
    } catch {
      // clipboard blocked; ignore
    }
  }

  private metric(label: string, value: string) {
    return html`
      <div>
        <div class="text-xs uppercase tracking-wide text-neutral-500">${label}</div>
        <div class="font-mono text-sm">${value}</div>
      </div>
    `;
  }

  private renderMetrics(s: FeatureSummary) {
    const items = [];
    if (s.point) {
      const [lng, lat] = s.point;
      items.push(this.metric("Lng, Lat", `${lng.toFixed(6)}, ${lat.toFixed(6)}`));
    }
    if (s.area != null) items.push(this.metric("Area", formatArea(s.area)));
    if (s.length != null) {
      items.push(
        this.metric(s.area != null ? "Perimeter" : "Length", formatLength(s.length)),
      );
    }
    if (items.length === 0) return nothing;
    return html`<div class="mt-2 grid grid-cols-2 gap-2">${items}</div>`;
  }

  private renderBBox(bbox: FeatureSummary["bbox"]) {
    if (!bbox) return nothing;
    const [w, s, e, n] = bbox.map((v) => v.toFixed(6));
    return html`
      <div class="mt-2">
        <div class="text-xs uppercase tracking-wide text-neutral-500">Bounds</div>
        <div class="font-mono text-xs">SW ${s}, ${w}</div>
        <div class="font-mono text-xs">NE ${n}, ${e}</div>
      </div>
    `;
  }

  private renderProps(props: Record<string, unknown>) {
    const entries = Object.entries(props).filter(([k]) => k !== "__fid");
    if (entries.length === 0) return nothing;
    return html`
      <div class="mt-2">
        <div class="text-xs uppercase tracking-wide text-neutral-500">Properties</div>
        <dl
          class="mt-1 grid max-h-48 grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 overflow-y-auto overscroll-contain pr-1 text-xs"
        >
          ${entries.map(
            ([k, v]) => html`
              <dt class="font-medium text-neutral-600 dark:text-neutral-300">${k}</dt>
              <dd class="font-mono break-all">${typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
            `,
          )}
        </dl>
      </div>
    `;
  }

  render() {
    if (!this.summary) return nothing;
    const s = this.summary;
    // A simplestyle title takes the heading, and the geometry type its label.
    const { title, description } = featureText(s.properties);
    return html`
      <div
        class="pointer-events-auto w-72 rounded-xl bg-white/95 p-4 shadow-xl backdrop-blur dark:bg-neutral-900/95"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-xs uppercase tracking-wide text-neutral-500">
              ${title ? s.type : "Geometry"}
            </div>
            <div class="break-words text-lg font-semibold">${title ?? s.type}</div>
          </div>
          <button
            @click=${this.close}
            class="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        ${description
          ? // Inline on purpose: pre-line would render the template's newlines.
            html`<p
              class="mt-1 max-h-32 overflow-y-auto overscroll-contain whitespace-pre-line break-words text-sm text-neutral-800 dark:text-neutral-100"
            >${description}</p>`
          : nothing}
        <div class="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
          ${s.vertices} vertices
        </div>
        ${this.renderMetrics(s)} ${this.renderBBox(s.bbox)} ${this.renderProps(s.properties)}
        <button
          @click=${this.copyGeoJson}
          class="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          ${this.copied ? "Copied ✓" : "Copy GeoJSON"}
        </button>
      </div>
    `;
  }
}
