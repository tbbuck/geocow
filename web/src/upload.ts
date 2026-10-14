// Reading dropped files into a FeatureCollection.
//
// The "magic" for large files (a 22 MB drop is routine): GeoJSON and NDJSON
// are parsed *entirely in the browser* — the bytes never touch the network,
// there's no `{"input":"…"}` envelope to escape, and the backend's memory is
// untouched. Only WKT-per-line (which needs geocow's Rust parser) is sent to
// the raw-body `/api/parse-file` endpoint. Format is sniffed from *content*,
// never the filename — the canonical example is a `.geojson` file that is
// actually NDJSON.

import type { Feature, FeatureCollection, Geometry } from "geojson";

import { parseFile } from "./api";

export type UploadFormat = "geojson" | "ndjson" | "wkt";

export interface LoadedUpload {
  fc: FeatureCollection;
  format: UploadFormat;
  name: string;
  bytes: number;
  /** Raw file text, retained for the reprojection round-trip when the
   * coordinates turn out to be projected (EPSG:27700). */
  text: string;
}

const GEOMETRY_TYPES = new Set<string>([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

function featureCollection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

/** Coerce a parsed GeoJSON value (FeatureCollection, Feature, bare geometry,
 * or an array of any of those) into a flat list of Features. */
export function toFeatures(value: unknown): Feature[] {
  if (Array.isArray(value)) return value.flatMap(toFeatures);
  if (!value || typeof value !== "object") throw new Error("not a GeoJSON object");

  const type = (value as { type?: string }).type;
  if (type === "FeatureCollection") {
    return (value as FeatureCollection).features ?? [];
  }
  if (type === "Feature") return [value as Feature];
  if (type && GEOMETRY_TYPES.has(type)) {
    return [{ type: "Feature", geometry: value as Geometry, properties: {} }];
  }
  throw new Error(`unrecognised GeoJSON type: ${type ?? "(none)"}`);
}

export interface ClientParse {
  fc: FeatureCollection;
  format: "geojson" | "ndjson";
}

/**
 * Parse GeoJSON or NDJSON text client-side. Returns `null` when the content is
 * not JSON (i.e. WKT-per-line), signalling the caller to use the backend.
 * Throws on malformed JSON.
 *
 * The whole-document path is tried first, so a valid (possibly pretty-printed,
 * multi-line) GeoJSON blob is never mistaken for NDJSON; only when that fails
 * do we parse line by line.
 */
export function parseGeojsonText(text: string): ClientParse | null {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty file");

  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null; // WKT — backend's job

  // Fast path: the whole payload is one GeoJSON document.
  try {
    return { fc: featureCollection(toFeatures(JSON.parse(trimmed))), format: "geojson" };
  } catch {
    // Not a single document — fall through to NDJSON (one value per line).
  }

  const features: Feature[] = [];
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: invalid JSON — ${line.slice(0, 80)}`);
    }
    for (const f of toFeatures(value)) features.push(f);
  }
  if (!features.length) throw new Error("no features found in file");
  return { fc: featureCollection(features), format: "ndjson" };
}

/**
 * Read a dropped file into a FeatureCollection. GeoJSON/NDJSON are parsed
 * locally; WKT-per-line is handed to `/api/parse-file`. The raw text is
 * retained so a projected dataset can be reprojected without re-reading.
 */
export async function loadFile(file: File): Promise<LoadedUpload> {
  const text = await file.text();

  const local = parseGeojsonText(text); // throws on malformed JSON
  if (local) {
    return { fc: local.fc, format: local.format, name: file.name, bytes: file.size, text };
  }

  // WKT-per-line (or any non-JSON): geocow's Rust parser does it.
  const { geojson } = await parseFile(text);
  return { fc: geojson, format: "wkt", name: file.name, bytes: file.size, text };
}
