import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { LightElement } from "./lit-base";

export type PasteStatus = "idle" | "loading" | "ok" | "error";

@customElement("paste-box")
export class PasteBox extends LightElement {
  @property({ type: String }) value = "";
  @property({ type: String }) status: PasteStatus = "idle";
  @property({ type: String }) message = "";
  @state() private expanded = true;

  private get textarea(): HTMLTextAreaElement | null {
    return this.querySelector("textarea");
  }

  /**
   * Expand (if hidden) and focus the textarea. `select` highlights the existing
   * text so typing replaces it — right for the `/` shortcut, wrong for the
   * autofocus on load, where restored geometry shouldn't be primed for deletion.
   */
  focusInput(select = true) {
    this.expanded = true;
    this.updateComplete.then(() => {
      const ta = this.textarea;
      if (!ta) return;
      ta.focus();
      if (select) ta.select();
      else ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  private submit() {
    const text = this.textarea?.value.trim() ?? "";
    if (!text) return;
    this.dispatchEvent(
      new CustomEvent<string>("parse", { detail: text, bubbles: true }),
    );
  }

  private onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      this.submit();
    }
  }

  private statusLine() {
    if (this.status === "error")
      return html`<span class="text-red-600 dark:text-red-400">${this.message}</span>`;
    if (this.status === "ok")
      return html`<span class="text-green-600 dark:text-green-400">${this.message}</span>`;
    if (this.status === "loading")
      return html`<span class="text-neutral-500">parsing…</span>`;
    return html`<span class="text-neutral-400">WKT, GeoJSON, or a bare geometry · ⌘/Ctrl+Enter to plot</span>`;
  }

  render() {
    return html`
      <div
        class="pointer-events-auto w-full rounded-2xl bg-white/95 p-3 shadow-2xl backdrop-blur dark:bg-neutral-900/95"
      >
        <div class="flex items-center justify-between px-1 pb-2">
          <span class="text-xs font-semibold uppercase tracking-wide text-neutral-500">geocow</span>
          <button
            class="text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            @click=${() => (this.expanded = !this.expanded)}
          >
            ${this.expanded ? "Hide" : "Show"}
          </button>
        </div>
        ${this.expanded
          ? html`
              <textarea
                .value=${this.value}
                @keydown=${this.onKeydown}
                rows="3"
                spellcheck="false"
                placeholder='POLYGON((-1.5 52.4, -1.5 52.5, -1.4 52.5, -1.5 52.4))  ·  {"type":"Point","coordinates":[-1.5,52.4]}'
                class="w-full resize-y rounded-lg border border-neutral-300 bg-white p-3 font-mono text-sm text-neutral-900 outline-none focus:border-accent focus:ring-1 focus:ring-accent dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              ></textarea>
              <div class="mt-2 flex items-center justify-between px-1">
                <div class="text-xs">${this.statusLine()}</div>
                <button
                  @click=${this.submit}
                  ?disabled=${this.status === "loading"}
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white shadow transition hover:brightness-110 disabled:opacity-50"
                >
                  Plot
                </button>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
