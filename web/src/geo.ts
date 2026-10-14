import type {
  Feature,
  FeatureCollection,
  Geometry,
  Position,
} from "geojson";

export type BBox = [number, number, number, number]; // [west, south, east, north]

/** Walk every coordinate position in a geometry. */
function* positions(geom: Geometry): Generator<Position> {
  switch (geom.type) {
    case "Point":
      yield geom.coordinates;
      break;
    case "MultiPoint":
    case "LineString":
      yield* geom.coordinates;
      break;
    case "MultiLineString":
    case "Polygon":
      for (const ring of geom.coordinates) yield* ring;
      break;
    case "MultiPolygon":
      for (const poly of geom.coordinates) for (const ring of poly) yield* ring;
      break;
    case "GeometryCollection":
      for (const g of geom.geometries) yield* positions(g);
      break;
  }
}

/** Count distinct coordinate positions (vertices). */
export function vertexCount(geom: Geometry): number {
  let n = 0;
  for (const _ of positions(geom)) n++;
  return n;
}

/** Bounding box of a single geometry, or null if it has no coordinates. */
export function geometryBBox(geom: Geometry): BBox | null {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  let any = false;
  for (const [x, y] of positions(geom)) {
    any = true;
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return any ? [w, s, e, n] : null;
}

/** Bounding box of an entire FeatureCollection. */
export function collectionBBox(fc: FeatureCollection): BBox | null {
  let acc: BBox | null = null;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const b = geometryBBox(f.geometry);
    if (!b) continue;
    acc = acc
      ? [
          Math.min(acc[0], b[0]),
          Math.min(acc[1], b[1]),
          Math.max(acc[2], b[2]),
          Math.max(acc[3], b[3]),
        ]
      : b;
  }
  return acc;
}

/**
 * True when a collection's coordinates fall outside lon/lat bounds, i.e. they
 * are projected. EPSG:27700 is the only projected CRS geocow supports, so
 * callers take this as "assume National Grid and reproject".
 */
export function isProjected(fc: FeatureCollection): boolean {
  const b = collectionBBox(fc);
  return b != null && (b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90);
}

// Geodesic measurements on the WGS84 mean sphere. Good to a fraction of a
// percent for the sizes this tool deals with; labelled "geodesic" so it's
// clear these aren't planar (OSGB) figures. Precise planar area/length is a
// job for the geocow backend (v2).
const R = 6371008.8; // metres
const rad = (d: number) => (d * Math.PI) / 180;

function haversine(a: Position, b: Position): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(a[0] - b[0]);
  const lat1 = rad(a[1]);
  const lat2 = rad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coords: Position[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

/** Signed spherical area of one ring, in m² (sign encodes winding). */
function ringArea(ring: Position[]): number {
  if (ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    sum += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return (sum * R * R) / 2;
}

/** Total geodesic length of all line work in a geometry (m). */
export function geodesicLength(geom: Geometry): number {
  switch (geom.type) {
    case "LineString":
      return lineLength(geom.coordinates);
    case "MultiLineString":
      return geom.coordinates.reduce((s, l) => s + lineLength(l), 0);
    case "Polygon":
      return geom.coordinates.reduce((s, r) => s + lineLength(r), 0);
    case "MultiPolygon":
      return geom.coordinates.reduce(
        (s, p) => s + p.reduce((t, r) => t + lineLength(r), 0),
        0,
      );
    case "GeometryCollection":
      return geom.geometries.reduce((s, g) => s + geodesicLength(g), 0);
    default:
      return 0;
  }
}

/** Geodesic area of polygonal geometry (m²); outer minus holes. */
export function geodesicArea(geom: Geometry): number {
  switch (geom.type) {
    case "Polygon": {
      const [outer, ...holes] = geom.coordinates;
      return holes.reduce(
        (a, h) => a - Math.abs(ringArea(h)),
        Math.abs(ringArea(outer)),
      );
    }
    case "MultiPolygon":
      return geom.coordinates.reduce(
        (a, poly) => a + geodesicArea({ type: "Polygon", coordinates: poly }),
        0,
      );
    case "GeometryCollection":
      return geom.geometries.reduce((a, g) => a + geodesicArea(g), 0);
    default:
      return 0;
  }
}

export function formatLength(m: number): string {
  return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(3)} km`;
}

export function formatArea(m2: number): string {
  if (m2 < 10_000) return `${m2.toFixed(1)} m²`;
  if (m2 < 1_000_000) return `${(m2 / 10_000).toFixed(3)} ha`;
  return `${(m2 / 1_000_000).toFixed(3)} km²`;
}

export interface FeatureSummary {
  type: string;
  vertices: number;
  bbox: BBox | null;
  point: Position | null;
  length: number | null; // metres, geodesic
  area: number | null; // m², geodesic
  properties: Record<string, unknown>;
  geojson: string; // pretty-printed geometry, for copy
}

/** Summarise a feature for the infobox. */
export function summarise(feature: Feature): FeatureSummary {
  const geom = feature.geometry;
  const isPoint = geom?.type === "Point";
  const hasArea = geom?.type === "Polygon" || geom?.type === "MultiPolygon";
  const hasLine =
    geom?.type === "LineString" ||
    geom?.type === "MultiLineString" ||
    hasArea;
  return {
    type: geom?.type ?? "—",
    vertices: geom ? vertexCount(geom) : 0,
    bbox: geom ? geometryBBox(geom) : null,
    point: isPoint ? (geom.coordinates as Position) : null,
    length: geom && hasLine ? geodesicLength(geom) : null,
    area: geom && hasArea ? geodesicArea(geom) : null,
    properties: (feature.properties as Record<string, unknown>) ?? {},
    geojson: geom ? JSON.stringify(geom) : "",
  };
}
