// The info box's property list. Pinned properties lead as tiles, each saying
// what it was on the previous feature when it changed. Then every property,
// grouped by shared key prefix, with its context alongside: where the value
// sits in the whole collection — a histogram for numbers and dates, a share
// bar for categories, whether another feature shares an id. What stands out
// about the feature comes first; properties the same on every feature, or
// empty on this one, fold away at the end. The Context switch in the box's
// header shows or hides all the context at once; clicking a number's
// histogram colours the map by it. Pins are remembered between sessions.

import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { LightElement } from "./lit-base";
import type { FeatureSummary } from "./geo";
import { loadPins, savePins, togglePin } from "./inspector-prefs";
import {
  MAX_CATEGORIES,
  collectionSize,
  copyText,
  displayValue,
  groupKeys,
  kindOf,
  matchesFilter,
  parseTime,
  partition,
  previousValue,
  shareOf,
  standing,
  standsOut,
  type Distribution,
  type KeyStats,
} from "./props";
import {
  FOCUS,
  HAIRLINE,
  MUTED,
  filterInput,
  fold,
  groupHeading,
  histogram,
  keyButton,
  noMatch,
  ownProps,
  pinIcon,
  shareBar,
  valueButton,
} from "./prop-view";

/** Colour the map by `key` over [min, max]; null stops. */
export type ColorByDetail = { key: string; min: number; max: number } | null;

// Long unbroken keys (versionavailablefromdate, 143px) should fit on one
// line. With context, keys get a shade more than values, since the context
// column takes its room from both. Without it, values get the extra; the
// split still leaves keys 151px in the narrower 24rem box.
const ROW_CONTEXT =
  "group/row grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_5.5rem] items-start gap-x-3 py-1";
const ROW = "group/row grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-x-3 py-[3px]";
const HEADING = "pb-1 text-[12px] font-semibold text-neutral-700 dark:text-neutral-200";

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

@customElement("property-list")
export class PropertyList extends LightElement {
  @property({ attribute: false }) summary!: FeatureSummary;
  /** The feature shown before this one, for the pinned tiles' "was" lines. */
  @property({ attribute: false }) previous: FeatureSummary | null = null;
  /** Statistics over the whole collection. */
  @property({ attribute: false }) stats: Map<string, KeyStats> = new Map();
  /** The property the map is coloured by, if any. */
  @property({ attribute: false }) colorProp: string | null = null;
  /** Whether the context boxes show (the header's Context switch). */
  @property({ attribute: false }) showContext = true;
  // Kept across clicks while the box is open: filter once, then click around.
  @state() private filter = "";
  @state() private pins: string[] = loadPins();

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("keydown", this.onKeydown);
  }

  disconnectedCallback() {
    this.removeEventListener("keydown", this.onKeydown);
    super.disconnectedCallback();
  }

  /**
   * Escape clears a filter before it closes the box — from anywhere in the
   * list, not only the field, since pinning a filtered row takes focus from
   * it — and puts focus back in the field. With no filter it passes on.
   */
  private onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !this.filter) return;
    e.stopPropagation();
    this.filter = "";
    void this.updateComplete.then(() =>
      this.querySelector<HTMLInputElement>("input[type=search]")?.focus(),
    );
  };

  render() {
    const props = ownProps(this.summary.properties);
    const keys = Object.keys(props);
    if (keys.length === 0) {
      return html`<p class="px-4 pb-4 pt-1 text-[13px] ${MUTED}">No properties</p>`;
    }
    const total = collectionSize(this.stats);
    const context = total >= 2 && this.showContext;
    const shown = keys.filter((k) => matchesFilter(k, props[k], this.filter));
    const { varying, same, empty } = partition(shown, props, this.stats);
    const outs = context
      ? standsOut(Object.fromEntries(varying.map((k) => [k, props[k]])), this.stats)
      : [];
    const pinned = this.pins.filter((k) => k in props);

    return html`
      ${pinned.length ? this.renderPinned(pinned, props, context) : nothing}
      <div
        class="sticky top-0 z-10 flex bg-white/95 px-4 pb-2 pt-1 backdrop-blur dark:bg-neutral-900/95"
      >
        ${filterInput(this.filter, keys.length, (q) => (this.filter = q))}
      </div>
      ${shown.length === 0 ? noMatch(this.filter) : nothing}
      <div class="px-4 pb-4">
        ${outs.length
          ? html`<section>
              <h3 class=${HEADING}>Stands out among ${total.toLocaleString()} features</h3>
              <dl>${outs.map((o) => this.row(o.key, null, props[o.key], true))}</dl>
            </section>`
          : nothing}
        ${groupKeys(varying).map(
          (g) => html`<section
            class=${g.prefix === null && outs.length ? `mt-3 border-t pt-2 ${HAIRLINE}` : ""}
          >
            ${g.prefix === null ? nothing : groupHeading(g.prefix, g.keys.length)}
            <dl>${g.keys.map((k) => this.row(k, g.prefix, props[k], context))}</dl>
          </section>`,
        )}
        ${same.length
          ? fold(
              `Same on all ${total.toLocaleString()} features`,
              same.length,
              same.join(", "),
              html`<dl>${same.map((k) => this.row(k, null, props[k], false))}</dl>`,
            )
          : nothing}
        ${empty.length
          ? fold(
              "Empty on this feature",
              empty.length,
              empty.join(", "),
              html`<dl>${empty.map((k) => this.emptyRow(k, props[k], context))}</dl>`,
            )
          : nothing}
      </div>
    `;
  }

  // --- Pins -----------------------------------------------------------------

  private renderPinned(pinned: string[], props: Record<string, unknown>, context: boolean) {
    const before = this.previous ? ownProps(this.previous.properties) : null;
    return html`<section class="px-4 pb-3 pt-1">
      <h3 class=${HEADING}>Pinned</h3>
      <div class="grid grid-cols-2 gap-x-4">
        ${pinned.map((k) => this.tile(k, props[k], previousValue(before, k, props[k]), context))}
      </div>
    </section>`;
  }

  private tile(key: string, v: unknown, was: { value: unknown } | null, context: boolean) {
    const s = this.stats.get(key);
    const prior = was ? displayValue(key, was.value) : null;
    return html`<div class="group/row min-w-0 border-t ${HAIRLINE} py-2">
      <div class="flex items-start gap-1">
        <div class="min-w-0 flex-1">${keyButton(key)}</div>
        ${this.pinButton(key, "inline")}
      </div>
      ${valueButton(key, v, { large: true, mono: s?.identifier })}
      ${prior
        ? html`<p class="mt-0.5 text-[12px] leading-snug ${MUTED} [overflow-wrap:anywhere]">
            was ${prior.text}${prior.unit ? ` ${prior.unit}` : ""}
          </p>`
        : nothing}
      ${context && s && kindOf(v) !== "empty"
        ? html`<div class="mt-1.5">${this.context(key, v, s)}</div>`
        : nothing}
    </div>`;
  }

  /**
   * A row's pin hangs in the list's left margin, beside the key, so it takes
   * no width from the key or value; a tile's sits after its key.
   */
  private pinButton(key: string, place: "gutter" | "inline") {
    const pinned = this.pins.includes(key);
    const tone = pinned
      ? "text-neutral-700 dark:text-neutral-200"
      : "text-neutral-400 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";
    const at =
      place === "gutter"
        ? "absolute right-full top-px flex h-5 w-3.5 items-center justify-center focus-visible:outline-offset-[-2px]"
        : "mt-0.5 shrink-0 p-0.5";
    return html`<button
      type="button"
      aria-pressed=${pinned ? "true" : "false"}
      aria-label=${`Pin ${key}`}
      title=${pinned ? "Unpin" : "Pin to the top"}
      class="${at} rounded ${tone} hover:text-neutral-900 dark:hover:text-neutral-100 ${FOCUS}"
      @click=${() => {
        this.pins = togglePin(this.pins, key);
        savePins(this.pins);
      }}
    >
      ${pinIcon(pinned, place === "gutter" ? 12 : 14)}
    </button>`;
  }

  // --- Rows -----------------------------------------------------------------

  private row(key: string, prefix: string | null, v: unknown, context: boolean) {
    const s = this.stats.get(key);
    return html`<div class=${context ? ROW_CONTEXT : ROW}>
      <dt class="relative">${this.pinButton(key, "gutter")}${keyButton(key, prefix)}</dt>
      <dd>${valueButton(key, v, { mono: s?.identifier })}</dd>
      ${context ? html`<dd>${s ? this.context(key, v, s) : nothing}</dd>` : nothing}
    </div>`;
  }

  /** An empty property; with context, how many other features do have it. */
  private emptyRow(key: string, v: unknown, context: boolean) {
    const s = this.stats.get(key);
    const note = !s || s.allEmpty ? "empty on every feature" : `set on ${s.present} of ${s.total}`;
    return html`<div class=${ROW}>
      <dt class="relative">${this.pinButton(key, "gutter")}${keyButton(key)}</dt>
      <dd>
        ${context
          ? html`<span class="text-[12px] leading-[1.4] text-neutral-400 dark:text-neutral-500"
              >${note}</span
            >`
          : valueButton(key, v)}
      </dd>
    </div>`;
  }

  // --- Context ----------------------------------------------------------------

  private caption(text: string) {
    return html`<span class="mt-0.5 block text-[11px] leading-tight ${MUTED}">${text}</span>`;
  }

  private context(key: string, v: unknown, s: KeyStats) {
    const dist = s.numeric ?? s.temporal;
    if (dist) return this.distributionCell(key, v, s, dist);

    const { count, present } = shareOf(s, v);
    if (s.categories) {
      const label = `${count} of ${present} features have this value, among ${s.distinct} values`;
      return html`${shareBar(s.categories, present, copyText(v), label)}${this.caption(
        `${count} of ${present}`,
      )}`;
    }
    if (s.identifier) return count > 1 ? this.caption(`shared by ${count} features`) : nothing;
    if (present < s.total) return this.caption(`set on ${present} of ${s.total}`);
    return nothing;
  }

  private distributionCell(key: string, v: unknown, s: KeyStats, d: Distribution) {
    const x = s.numeric ? Number(v) : parseTime(v);
    if (x === null || !Number.isFinite(x)) return nothing;
    const { count, present } = shareOf(s, v);
    // With only a few values, "how many share it" beats "how high it ranks".
    const phrase =
      s.distinct <= MAX_CATEGORIES ? `${count} of ${present}` : (standing(d, x, !s.numeric) ?? "");
    const range = s.numeric ? `${d.min} to ${d.max}` : `${isoDay(d.min)} to ${isoDay(d.max)}`;
    const label = `${phrase}: ${present} values from ${range}${d.log ? ", log scale" : ""}`;
    const chart = histogram(d, x, label);
    if (!s.numeric) return html`${chart}${this.caption(phrase)}`;

    const on = this.colorProp === key;
    return html`<button
      type="button"
      aria-pressed=${on ? "true" : "false"}
      title=${on ? `Stop colouring the map by ${key}` : `Colour the map by ${key}`}
      class="group/chart -m-1 block rounded-md p-1 text-left hover:bg-neutral-100 aria-pressed:bg-neutral-100 aria-pressed:ring-1 aria-pressed:ring-neutral-300 dark:hover:bg-neutral-800/80 dark:aria-pressed:bg-neutral-800 dark:aria-pressed:ring-neutral-600 ${FOCUS}"
      @click=${() => this.colorBy(on ? null : key, d)}
    >
      ${chart}
      <span
        class="mt-0.5 block text-[11px] leading-tight ${MUTED} group-hover/chart:hidden group-focus-visible/chart:hidden"
        >${phrase}</span
      >
      <span
        class="mt-0.5 hidden text-[11px] font-medium leading-tight text-neutral-800 group-hover/chart:block group-focus-visible/chart:block dark:text-neutral-100"
        >${on ? "Stop colouring" : "Colour the map"}</span
      >
    </button>`;
  }

  /** Ask the app to colour the map, over the 2nd–98th percentile so outliers don't flatten the ramp. */
  private colorBy(key: string | null, d: Distribution) {
    let detail: ColorByDetail = null;
    if (key !== null) {
      const at = (p: number) => d.sorted[Math.round(p * (d.sorted.length - 1))];
      const [lo, hi] = at(0.98) > at(0.02) ? [at(0.02), at(0.98)] : [d.min, d.max];
      detail = { key, min: lo, max: hi };
    }
    this.dispatchEvent(new CustomEvent<ColorByDetail>("color-by", { detail, bubbles: true }));
  }
}
