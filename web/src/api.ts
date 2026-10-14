import type { FeatureCollection } from "geojson";

export interface ParseResult {
  format: "wkt" | "geojson";
  geojson: FeatureCollection;
}

/** POST raw text to the backend, which parses WKT/GeoJSON via geocow's lib. */
export async function parseInput(input: string): Promise<ParseResult> {
  const resp = await fetch("/api/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });

  if (!resp.ok) {
    let message = `parse failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status-based message
    }
    throw new Error(message);
  }

  return (await resp.json()) as ParseResult;
}

export interface TransformResult {
  format: "wkt" | "geojson";
  from: number;
  to: number;
  geojson: FeatureCollection;
  text: string;
}

/** Reproject pasted geometry server-side (default EPSG:27700 → 4258). */
export async function transformInput(
  input: string,
  from = 27700,
  to = 4258,
): Promise<TransformResult> {
  const resp = await fetch("/api/transform", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, from, to }),
  });

  if (!resp.ok) {
    let message = `transform failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep status-based message
    }
    throw new Error(message);
  }

  return (await resp.json()) as TransformResult;
}

/** Pull an `{error}` message off a failed response, else a status fallback. */
async function errorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // non-JSON body; keep the status-based message
  }
  return fallback;
}

/**
 * Parse a raw uploaded body (WKT-per-line, NDJSON, or a single GeoJSON doc)
 * via `/api/parse-file`. Unlike {@link parseInput}, the body is the geometry
 * itself — no JSON envelope — so multi-MB uploads skip escaping/double-encoding
 * and the endpoint's raised body limit. Used for file drops the client can't
 * (or shouldn't) parse locally, i.e. WKT.
 */
export async function parseFile(text: string): Promise<ParseResult> {
  const resp = await fetch("/api/parse-file", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: text,
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, `parse failed (${resp.status})`));
  return (await resp.json()) as ParseResult;
}

export interface TransformFileResult {
  from: number;
  to: number;
  geojson: FeatureCollection;
}

/**
 * Stash an opaque (already-compressed) share payload server-side and get back a
 * short id to look it up with. Used automatically when an inline share URL
 * would exceed MAX_INLINE_SHARE_URL; the server keeps only the few most recent
 * payloads, so the id is short-lived.
 */
export async function createShare(payload: string): Promise<string> {
  const resp = await fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: payload,
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, `share failed (${resp.status})`));
  const body = (await resp.json()) as { id: string };
  return body.id;
}

/** Fetch a previously-stored share payload by id. Throws if it 404s (evicted
 * or never existed). */
export async function fetchShare(id: string): Promise<string> {
  const resp = await fetch(`/api/share/${encodeURIComponent(id)}`);
  if (!resp.ok) throw new Error(await errorMessage(resp, `share not found (${resp.status})`));
  return resp.text();
}

/** Reproject a raw uploaded body via `/api/transform-file` (raised body limit,
 * no re-serialised text — the paste box isn't repopulated for large drops). */
export async function transformFile(
  text: string,
  from = 27700,
  to = 4258,
): Promise<TransformFileResult> {
  const resp = await fetch(`/api/transform-file?from=${from}&to=${to}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: text,
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, `transform failed (${resp.status})`));
  return (await resp.json()) as TransformFileResult;
}
