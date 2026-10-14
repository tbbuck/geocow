// Persistence: viewport in the URL hash, last-pasted data in sessionStorage
// (see saveLastInput for why not localStorage), and an opt-in "share link"
// that packs the data (gzip + base64url) into the hash so a URL reproduces
// both the view and the geometry.

export interface ViewState {
  center: [number, number]; // [lng, lat]
  zoom: number;
  bearing: number;
  pitch: number;
}

const DATA_KEY = "geocow:lastInput";

// ---------------------------------------------------------------------------
// Hash <-> view
// ---------------------------------------------------------------------------

interface HashParts {
  view?: ViewState;
  data?: string; // still-compressed base64url payload, decode separately
  shareId?: string; // id of a server-stored (temporary) share payload
}

function parseHashParts(): HashParts {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return {};
  const parts: HashParts = {};
  for (const seg of raw.split("&")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const key = seg.slice(0, eq);
    const val = seg.slice(eq + 1);
    if (key === "m") {
      const [zoom, lat, lng, bearing, pitch] = val.split("/").map(Number);
      if ([zoom, lat, lng].every((n) => Number.isFinite(n))) {
        parts.view = {
          center: [lng, lat],
          zoom,
          bearing: Number.isFinite(bearing) ? bearing : 0,
          pitch: Number.isFinite(pitch) ? pitch : 0,
        };
      }
    } else if (key === "d") {
      parts.data = val;
    } else if (key === "s") {
      parts.shareId = val;
    }
  }
  return parts;
}

export function readView(): ViewState | undefined {
  return parseHashParts().view;
}

/** Compressed data payload from the hash, if a shared link was opened. */
export function readSharedDataRaw(): string | undefined {
  return parseHashParts().data;
}

/** Id of a server-stored temporary share, if a short link was opened. */
export function readSharedId(): string | undefined {
  return parseHashParts().shareId;
}

function viewToString(v: ViewState): string {
  const r = (n: number, p: number) => Number(n.toFixed(p));
  return [
    r(v.zoom, 2),
    r(v.center[1], 5),
    r(v.center[0], 5),
    r(v.bearing, 1),
    r(v.pitch, 1),
  ].join("/");
}

/**
 * What a history entry remembers beyond its URL. Geometry plotted from the
 * box lives nowhere in the URL, so without this, going back past a plot would
 * land on an entry with nothing to restore.
 */
export interface HistoryState {
  text?: string;
}

/** Geometry the current history entry remembers, if any. */
export function historyText(): string | undefined {
  const state = history.state as HistoryState | null;
  return typeof state?.text === "string" ? state.text : undefined;
}

// Above this, geometry is left out of the history entry rather than risking
// the browser's state-object quota (Firefox draws the line at 640 KB, and a
// rejected pushState throws). Back/forward still moves the viewport; only the
// remembered geometry is dropped.
const MAX_HISTORY_TEXT = 256 * 1024;

function historyPayload(text: string | undefined): HistoryState | null {
  return text && text.length <= MAX_HISTORY_TEXT ? { text } : null;
}

/**
 * Write the view to the hash, preserving any existing share payload/id.
 *
 * Replaces rather than pushes: this runs on every map movement, and a history
 * entry per frame of a pan would bury whatever the user actually wants to go
 * back to. The current entry's state is carried over — replaceState would
 * otherwise wipe the geometry it remembers.
 */
export function writeView(v: ViewState): void {
  const existing = parseHashParts();
  let hash = `#m=${viewToString(v)}`;
  if (existing.data) hash += `&d=${existing.data}`;
  if (existing.shareId) hash += `&s=${existing.shareId}`;
  history.replaceState(history.state, "", hash);
}

/**
 * Start a new history entry for a change the user should be able to undo with
 * the back button: plotting something different, sharing, clearing the URL.
 * `hash` is the whole new hash; `text` is the geometry to remember with it.
 */
export function pushHistory(hash: string, text?: string): void {
  history.pushState(historyPayload(text), "", hash);
}

/** Hash string for a view plus an optional shared payload reference. */
export function hashFor(
  v: ViewState,
  shared?: { data?: string; shareId?: string },
): string {
  let hash = `#m=${viewToString(v)}`;
  if (shared?.data) hash += `&d=${shared.data}`;
  if (shared?.shareId) hash += `&s=${shared.shareId}`;
  return hash;
}

/** Strip any shared payload/id, leaving just the viewport in the hash. */
export function clearSharedData(v: ViewState, text?: string): void {
  pushHistory(`#m=${viewToString(v)}`, text);
}

// ---------------------------------------------------------------------------
// sessionStorage
// ---------------------------------------------------------------------------

// Geometry lives in sessionStorage, not localStorage: it survives a refresh
// within a tab but is *not* shared across tabs, so two tabs can hold different
// geometries for side-by-side comparison.
export function saveLastInput(text: string): void {
  try {
    window.sessionStorage.setItem(DATA_KEY, text);
  } catch {
    // storage may be unavailable (private mode); non-fatal
  }
}

export function loadLastInput(): string | null {
  try {
    return window.sessionStorage.getItem(DATA_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compression (gzip + base64url) for share links
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: "gzip" | "gunzip",
): Promise<Uint8Array> {
  const stream =
    transform === "gzip"
      ? new CompressionStream("gzip")
      : new DecompressionStream("gzip");
  const blob = new Blob([bytes as BlobPart]);
  const piped = blob.stream().pipeThrough(stream as ReadableWritablePair);
  const buf = await new Response(piped).arrayBuffer();
  return new Uint8Array(buf);
}

export async function compressText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const gz = await pipeThrough(bytes, "gzip");
  return bytesToBase64Url(gz);
}

export async function decompressText(payload: string): Promise<string> {
  const bytes = base64UrlToBytes(payload);
  const raw = await pipeThrough(bytes, "gunzip");
  return new TextDecoder().decode(raw);
}

// Above this total URL length we switch from a self-contained link to a
// server-stored short one. ~2000 chars is the long-standing cross-tool safe
// ceiling (legacy IE, proxies, link-preview bots, QR encoders); Slack won't
// break a longer link but renders it as an ugly truncated wall. Tiny geometry
// stays inline; anything sizeable (a detailed polygon ≈ 5–6k chars) shortens.
export const MAX_INLINE_SHARE_URL = 2000;

function shareUrl(hash: string): string {
  return `${window.location.origin}${window.location.pathname}${hash}`;
}

/** Self-contained share URL carrying the compressed geometry inline (`d=`).
 * Long, but needs no server. `data` is the output of {@link compressText}. */
export function inlineShareUrl(v: ViewState, data: string): string {
  return shareUrl(`#m=${viewToString(v)}&d=${data}`);
}

/** Short share URL referencing a server-stored payload by id (`s=`).
 * Temporary — see the share store's eviction contract. */
export function shortShareUrl(v: ViewState, id: string): string {
  return shareUrl(`#m=${viewToString(v)}&s=${id}`);
}
