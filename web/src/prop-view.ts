// Markup for the info box's property list: copyable key and value cells, the
// filter field, group headings and folds, icons, and the two small context
// charts. Orange marks this feature and grey the rest of the collection — the
// same split the map shows while a feature is selected.

import { html, nothing, svg } from "lit";

import { BINS, copyText, displayValue, shortKey, type Distribution } from "./props";

export const INK = "text-neutral-900 dark:text-neutral-100";
export const MUTED = "text-neutral-500 dark:text-neutral-400";
export const HAIRLINE = "border-neutral-200 dark:border-neutral-800";
export const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

// Chart marks. The map's orange is 2.6:1 on white, under the 3:1 a mark
// needs, so light mode takes the next step down; dark keeps the map's own.
const THIS_FILL = "fill-orange-600 dark:fill-accent";
const THIS_STROKE = "stroke-orange-600 dark:stroke-accent";
const REST_FILL = "fill-neutral-400 dark:fill-neutral-500";

/** Copy `text`, flagging "Copied" on the element that asked while it shows. */
export async function copyFrom(el: HTMLElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return; // clipboard blocked: nothing to confirm
  }
  el.dataset.copied = "";
  window.setTimeout(() => delete el.dataset.copied, 1200);
}

/** Shown over a copy button's right edge while its data-copied is set. */
export const copiedFlag = html`<span
  class="pointer-events-none absolute inset-y-0 right-0 hidden items-center rounded bg-white pl-2 pr-1 text-[11px] font-medium text-neutral-600 group-data-[copied]:flex dark:bg-neutral-900 dark:text-neutral-300"
  >Copied</span
>`;

/** A feature's own properties, without the map's bookkeeping. */
export function ownProps(props: Record<string, unknown>): Record<string, unknown> {
  const own = { ...props };
  delete own.__fid;
  return own;
}

/**
 * A key, shortened under its group heading, that wraps at its underscores
 * rather than mid-word. Clicking copies the full key — the exact name the
 * Settings panel and SQL want.
 */
export function keyButton(key: string, prefix: string | null = null) {
  const parts = shortKey(key, prefix).split("_");
  return html`<button
    type="button"
    title=${`${key} (click to copy the key)`}
    class="group relative -mx-1 w-[calc(100%+0.5rem)] rounded px-1 text-left text-[12px] leading-[1.4] ${MUTED} [overflow-wrap:anywhere] hover:text-neutral-800 dark:hover:text-neutral-200 ${FOCUS}"
    @click=${(e: Event) => copyFrom(e.currentTarget as HTMLElement, key)}
  >
    ${parts.map((p, i) => (i < parts.length - 1 ? html`${p}_<wbr />` : p))}${copiedFlag}
  </button>`;
}

/**
 * A value set by kind: numbers and dates in tabular figures, a number's unit
 * from its key, ids and JSON in mono, null and blanks named in muted italic,
 * URLs as links. Clicking copies the raw value.
 */
export function valueButton(
  key: string,
  v: unknown,
  { mono = false, large = false }: { mono?: boolean; large?: boolean } = {},
) {
  const shown = displayValue(key, v);
  if (shown.kind === "url") {
    return html`<a
      href=${shown.text}
      target="_blank"
      rel="noopener noreferrer"
      class="text-[13px] leading-[1.4] ${INK} underline decoration-neutral-300 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-current dark:decoration-neutral-600 ${FOCUS}"
      >${shown.text}</a
    >`;
  }
  const isMono = mono || shown.kind === "uuid" || shown.kind === "json";
  const size = isMono
    ? "font-mono text-[12px] leading-[1.45]"
    : large
      ? "text-[15px] font-medium leading-snug"
      : "text-[13px] leading-[1.4]";
  const figures =
    shown.kind === "number" || shown.kind === "date" || shown.kind === "datetime"
      ? "tabular-nums"
      : "";
  const tone = shown.kind === "empty" ? "italic text-neutral-400 dark:text-neutral-500" : INK;
  return html`<button
    type="button"
    title="Click to copy"
    class="group relative -mx-1 w-[calc(100%+0.5rem)] rounded px-1 text-left ${size} ${figures} ${tone} [overflow-wrap:anywhere] hover:bg-neutral-100 dark:hover:bg-neutral-800/80 ${FOCUS}"
    @click=${(e: Event) => copyFrom(e.currentTarget as HTMLElement, copyText(v))}
  >
    ${shown.text}${shown.unit
      ? html`<span class="ml-0.5 font-normal ${MUTED}">${shown.unit}</span>`
      : nothing}${copiedFlag}
  </button>`;
}

/** The filter field. (Escape is handled by the list around it.) */
export function filterInput(value: string, total: number, onInput: (q: string) => void) {
  return html`<input
    type="search"
    .value=${value}
    placeholder=${`Filter ${total} properties`}
    aria-label="Filter properties by key or value"
    spellcheck="false"
    @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
    class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent focus:ring-1 focus:ring-accent dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
  />`;
}

/** A group's heading: its prefix as the data spells it, and how many keys. */
export function groupHeading(prefix: string, count: number) {
  return html`<h3
    class="mt-3 flex items-baseline justify-between border-t ${HAIRLINE} pb-1 pt-2.5 text-[12px] font-semibold text-neutral-700 dark:text-neutral-200"
  >
    <span
      >${prefix}${prefix === "_"
        ? html`<span class="ml-1.5 font-normal ${MUTED}">leading underscore</span>`
        : nothing}</span
    >
    <span class="text-[11px] font-normal tabular-nums ${MUTED}">${count}</span>
  </h3>`;
}

/** "No property matches …", for a filter that empties the list. */
export function noMatch(filter: string) {
  return html`<p class="px-4 py-6 text-center text-[13px] ${MUTED}">
    No property matches “${filter.trim()}”
  </p>`;
}

/**
 * A collapsed section: a title, a count, and a one-line preview of what's
 * inside (usually the keys), opening to `body`. Folded, never dropped.
 */
export function fold(title: string, count: number, preview: string, body: unknown) {
  return html`<details class="group/fold mt-3 border-t ${HAIRLINE} pt-2">
    <summary
      class="flex cursor-pointer list-none items-baseline gap-2 rounded py-0.5 text-[12px] [&::-webkit-details-marker]:hidden ${FOCUS}"
    >
      <svg
        viewBox="0 0 12 12"
        width="10"
        height="10"
        aria-hidden="true"
        class="shrink-0 self-center ${MUTED} transition-transform group-open/fold:rotate-90 motion-reduce:transition-none"
      >
        <path
          d="M4.5 2.5 8 6l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="shrink-0 font-semibold text-neutral-700 dark:text-neutral-200">${title}</span>
      <span class="shrink-0 tabular-nums ${MUTED}">${count}</span>
      <span class="min-w-0 truncate text-neutral-400 dark:text-neutral-500">${preview}</span>
    </summary>
    <div class="mt-1">${body}</div>
  </details>`;
}

/**
 * The switch that shows or hides every context box at once. It lives in the
 * box's header, which never moves: in the list it would ride up as the
 * pinned tiles above it lost their charts.
 */
export function contextSwitch(on: boolean, total: number, onToggle: () => void) {
  const n = total.toLocaleString();
  return html`<button
    type="button"
    aria-pressed=${on ? "true" : "false"}
    title=${on
      ? `Hide how each value compares with all ${n} features`
      : `Show how each value compares with all ${n} features`}
    @click=${onToggle}
    class="flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1 text-[12px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 aria-pressed:border-neutral-300 aria-pressed:bg-neutral-100 aria-pressed:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:aria-pressed:border-neutral-600 dark:aria-pressed:bg-neutral-800 dark:aria-pressed:text-neutral-100 ${FOCUS}"
  >
    ${contextIcon(on)} Context
  </button>`;
}

/**
 * The context switch's icon: three histogram bars, with this feature's
 * orange rule beside them while context is showing.
 */
function contextIcon(on: boolean) {
  return html`<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" class="block">
    <rect x="1" y="7" width="2.5" height="6" rx="0.5" fill="currentColor" />
    <rect x="4.75" y="3" width="2.5" height="10" rx="0.5" fill="currentColor" />
    <rect x="8.5" y="5.5" width="2.5" height="7.5" rx="0.5" fill="currentColor" />
    ${on
      ? svg`<line x1="12.75" x2="12.75" y1="1.5" y2="12.5" stroke-width="1.5" stroke-linecap="round" class=${THIS_STROKE} />`
      : nothing}
  </svg>`;
}

/** A filled or outlined push-pin, `size` px square. */
export function pinIcon(filled: boolean, size = 14) {
  return html`<svg viewBox="0 0 16 16" width=${size} height=${size} aria-hidden="true" class="block">
    <circle
      cx="8"
      cy="5.5"
      r="3.25"
      fill=${filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.5"
    />
    <path d="M8 8.75v5.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  </svg>`;
}

// --- Charts -------------------------------------------------------------------

const CHART_W = 88;
const HIST_H = 18;
const GAP = 2;

/**
 * The collection's values as a 16-bin histogram in grey, with this feature's
 * value as an orange rule through it (on a surface-coloured halo, so it stays
 * legible over a bar). Log-binned distributions place the rule in log space.
 */
export function histogram(d: Distribution, v: number, label: string) {
  const barW = (CHART_W - GAP * (BINS - 1)) / BINS;
  const peak = Math.max(...d.bins);
  const scale = (x: number) => (d.log ? Math.log10(x) : x);
  const lo = scale(d.min);
  const hi = scale(d.max);
  const at = hi > lo ? ((scale(v) - lo) / (hi - lo)) * CHART_W : CHART_W / 2;
  const x = Math.min(CHART_W - 1, Math.max(1, at));
  const bars = Array.from(d.bins, (count, i) => {
    if (count === 0) return nothing;
    const h = Math.max(1.5, (count / peak) * (HIST_H - 2));
    return svg`<rect x=${i * (barW + GAP)} y=${HIST_H - 1 - h} width=${barW} height=${h} rx="0.75" class=${REST_FILL} />`;
  });
  return html`<svg
    viewBox="0 0 ${CHART_W} ${HIST_H}"
    width=${CHART_W}
    height=${HIST_H}
    role="img"
    aria-label=${label}
    class="block overflow-visible"
  >
    <title>${label}</title>
    ${bars}
    <line x1="0" x2=${CHART_W} y1=${HIST_H - 0.5} y2=${HIST_H - 0.5} stroke-width="1" class="stroke-neutral-200 dark:stroke-neutral-700" />
    <line x1=${x} x2=${x} y1="0" y2=${HIST_H} stroke-width="4" class="stroke-white dark:stroke-neutral-900" />
    <line x1=${x} x2=${x} y1="0.5" y2=${HIST_H - 0.5} stroke-width="2" stroke-linecap="round" class=${THIS_STROKE} />
  </svg>`;
}

const SHARE_H = 6;
const SHARE_SEGMENTS = 5;

/**
 * Each category's share as one segmented bar, most common first and the tail
 * past five folded into one segment; this feature's category in orange. A
 * selected sliver keeps 3px so it can still be seen.
 */
export function shareBar(
  categories: Array<[string, number]>,
  present: number,
  selected: string,
  label: string,
) {
  const head = categories.slice(0, SHARE_SEGMENTS);
  const tail = categories.slice(SHARE_SEGMENTS);
  const segments = head.map(([value, count]) => ({ count, on: value === selected }));
  if (tail.length) {
    segments.push({
      count: tail.reduce((sum, [, count]) => sum + count, 0),
      on: tail.some(([value]) => value === selected),
    });
  }
  const usable = CHART_W - GAP * (segments.length - 1);
  let x = 0;
  const rects = segments.map((s) => {
    const w = Math.max(s.on ? 3 : 1, (s.count / present) * usable);
    const rect = svg`<rect x=${x} y="0" width=${w} height=${SHARE_H} rx=${SHARE_H / 2} class=${s.on ? THIS_FILL : REST_FILL} />`;
    x += w + GAP;
    return rect;
  });
  return html`<svg
    viewBox="0 0 ${CHART_W} ${SHARE_H}"
    width=${CHART_W}
    height=${SHARE_H}
    role="img"
    aria-label=${label}
    class="mt-1.5 block"
  >
    <title>${label}</title>
    ${rects}
  </svg>`;
}
