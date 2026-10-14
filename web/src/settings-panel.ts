import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { LightElement } from "./lit-base";
import { SCHEME_NAMES } from "./colors";
import type { Settings, TriState } from "./settings";

@customElement("settings-panel")
export class SettingsPanel extends LightElement {
  @property({ attribute: false }) settings!: Settings;
  @state() private open = false;

  private patch(patch: Partial<Settings>) {
    this.dispatchEvent(
      new CustomEvent<Settings>("settings-change", {
        detail: { ...this.settings, ...patch },
        bubbles: true,
      }),
    );
  }

  private tri(value: TriState, onChange: (v: TriState) => void) {
    return html`
      <select
        .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value as TriState)}
        class="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
      >
        <option value="auto">Auto</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    `;
  }

  private textInput(value: string, onChange: (v: string) => void) {
    return html`<input
      type="text"
      .value=${value}
      @change=${(e: Event) => onChange((e.target as HTMLInputElement).value.trim())}
      class="w-24 rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
    />`;
  }

  private numInput(value: number, onChange: (v: number) => void) {
    return html`<input
      type="number"
      .value=${String(value)}
      @change=${(e: Event) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(n)) onChange(n);
      }}
      class="w-20 rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
    />`;
  }

  render() {
    const s = this.settings;
    const label = "text-xs font-medium text-neutral-600 dark:text-neutral-300";
    const heading = "text-xs font-semibold uppercase tracking-wide text-neutral-500";
    return html`
      <div class="flex flex-col items-start gap-2">
        <button
          @click=${() => (this.open = !this.open)}
          title="Display settings"
          class="flex items-center gap-1.5 rounded-lg bg-white/90 px-3 py-2 text-sm font-medium text-neutral-800 shadow-md backdrop-blur transition hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          <span class="leading-none">⚙</span><span>Settings</span>
        </button>

        ${this.open
          ? html`
              <div
                class="pointer-events-auto w-72 space-y-4 rounded-xl bg-white/95 p-4 shadow-xl backdrop-blur dark:bg-neutral-900/95"
              >
                <!-- Extrusion -->
                <div class="space-y-2">
                  <div class="flex items-center justify-between">
                    <span class=${heading}>Extrude</span>
                    ${this.tri(s.extrudeMode, (v) => this.patch({ extrudeMode: v }))}
                  </div>
                  <div class="flex items-center justify-between">
                    <span class=${label}>Height property</span>
                    ${this.textInput(s.extrudeProp, (v) => this.patch({ extrudeProp: v }))}
                  </div>
                </div>

                <!-- Colour by value -->
                <div class="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-700">
                  <div class="flex items-center justify-between">
                    <span class=${heading}>Colour by value</span>
                    ${this.tri(s.colorMode, (v) => this.patch({ colorMode: v }))}
                  </div>
                  <div class="flex items-center justify-between">
                    <span class=${label}>Property</span>
                    ${this.textInput(s.colorProp, (v) => this.patch({ colorProp: v }))}
                  </div>
                  <div class="flex items-center justify-between">
                    <span class=${label}>Min / Max</span>
                    <span class="flex gap-1">
                      ${this.numInput(s.colorMin, (v) => this.patch({ colorMin: v }))}
                      ${this.numInput(s.colorMax, (v) => this.patch({ colorMax: v }))}
                    </span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class=${label}>Scheme</span>
                    <select
                      .value=${s.colorScheme}
                      @change=${(e: Event) =>
                        this.patch({ colorScheme: (e.target as HTMLSelectElement).value })}
                      class="rounded border border-neutral-300 bg-white px-2 py-1 text-xs capitalize dark:border-neutral-700 dark:bg-neutral-950"
                    >
                      ${SCHEME_NAMES.map(
                        (name) => html`<option value=${name}>${name}</option>`,
                      )}
                    </select>
                  </div>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
