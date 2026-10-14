import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

import { LightElement } from "./lit-base";
import { SCHEMES, type ColorScheme } from "./config";

export interface StyleState {
  scheme: ColorScheme;
  satellite: boolean;
}

/**
 * Two independent controls: a Auto/Light/Dark segmented control for the
 * colour scheme, and a separate Satellite toggle. Picking a scheme leaves
 * satellite; toggling satellite overrides the scheme's basemap.
 */
@customElement("style-controls")
export class StyleControls extends LightElement {
  @property({ type: String }) scheme: ColorScheme = "system";
  @property({ type: Boolean }) satellite = false;
  /** False when the server has no imagery configured: the toggle is hidden. */
  @property({ type: Boolean }) satelliteAvailable = false;

  private emit(state: StyleState) {
    this.dispatchEvent(
      new CustomEvent<StyleState>("style-change", { detail: state, bubbles: true }),
    );
  }

  private pickScheme(scheme: ColorScheme) {
    this.emit({ scheme, satellite: false });
  }

  private toggleSatellite() {
    this.emit({ scheme: this.scheme, satellite: !this.satellite });
  }

  render() {
    const segBtn = (key: ColorScheme, label: string) => {
      const active = !this.satellite && this.scheme === key;
      return html`
        <button
          @click=${() => this.pickScheme(key)}
          class=${"px-3 py-2 text-sm font-medium transition " +
          (active
            ? "bg-accent text-white"
            : "text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-200 dark:hover:bg-neutral-700/70")}
        >
          ${label}
        </button>
      `;
    };

    return html`
      <div class="flex gap-2">
        <div
          class="flex divide-x divide-neutral-200 overflow-hidden rounded-lg bg-white/90 shadow-md backdrop-blur dark:divide-neutral-700 dark:bg-neutral-800/90"
        >
          ${SCHEMES.map((s) => segBtn(s.key, s.label))}
        </div>
        ${this.satelliteAvailable
          ? html`<button
              @click=${this.toggleSatellite}
              title="Toggle satellite imagery"
              class=${"flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium shadow-md backdrop-blur transition " +
              (this.satellite
                ? "bg-accent text-white"
                : "bg-white/90 text-neutral-700 hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-200 dark:hover:bg-neutral-800")}
            >
              <span class="leading-none">🛰</span><span>Satellite</span>
            </button>`
          : nothing}
      </div>
    `;
  }
}
