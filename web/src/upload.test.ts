import { describe, it, expect } from "vitest";

import { parseGeojsonText, toFeatures, loadFile } from "./upload";

describe("toFeatures", () => {
  it("passes through a FeatureCollection's features", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { id: 1 } },
      ],
    };
    expect(toFeatures(fc)).toHaveLength(1);
  });

  it("wraps a single Feature", () => {
    const f = { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} };
    expect(toFeatures(f)).toEqual([f]);
  });

  it("wraps a bare geometry in a property-less Feature", () => {
    const feats = toFeatures({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
    expect(feats).toHaveLength(1);
    expect(feats[0].type).toBe("Feature");
    expect(feats[0].geometry?.type).toBe("Polygon");
  });

  it("throws on an unrecognised object", () => {
    expect(() => toFeatures({ type: "Nonsense" })).toThrow(/unrecognised/);
  });
});

describe("parseGeojsonText", () => {
  it("parses a single FeatureCollection", () => {
    const text = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { id: 1 } },
        { type: "Feature", geometry: { type: "Point", coordinates: [3, 4] }, properties: { id: 2 } },
      ],
    });
    const out = parseGeojsonText(text)!;
    expect(out.format).toBe("geojson");
    expect(out.fc.features).toHaveLength(2);
    expect(out.fc.features[1].properties?.id).toBe(2);
  });

  it("parses a bare geometry document", () => {
    const out = parseGeojsonText('{"type":"Point","coordinates":[-1.5,52.4]}')!;
    expect(out.format).toBe("geojson");
    expect(out.fc.features).toHaveLength(1);
  });

  it("parses NDJSON (one Feature per line) — the big-file shape", () => {
    const text = [
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":1}}',
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{"id":2}}',
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[5,6]},"properties":{"id":3}}',
    ].join("\n");
    const out = parseGeojsonText(text)!;
    expect(out.format).toBe("ndjson");
    expect(out.fc.features).toHaveLength(3);
    expect(out.fc.features[2].properties?.id).toBe(3);
  });

  it("tolerates blank lines and trailing newline in NDJSON", () => {
    const text = '\n{"type":"Point","coordinates":[1,2]}\n\n{"type":"Point","coordinates":[3,4]}\n';
    const out = parseGeojsonText(text)!;
    expect(out.fc.features).toHaveLength(2);
  });

  it("returns null for WKT (defer to the backend)", () => {
    expect(parseGeojsonText("POINT(1 2)\nLINESTRING(0 0,1 1)")).toBeNull();
  });

  it("reports the offending line number for malformed NDJSON", () => {
    const text = '{"type":"Point","coordinates":[1,2]}\n{ this is not json }';
    expect(() => parseGeojsonText(text)).toThrow(/line 2/);
  });

  it("throws on empty input", () => {
    expect(() => parseGeojsonText("   \n  ")).toThrow(/empty/);
  });
});

describe("loadFile (local path, no network)", () => {
  it("loads NDJSON from a File without touching the backend", async () => {
    const text = [
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{}}',
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]},"properties":{}}',
    ].join("\n");
    const file = new File([text], "results.geojson", { type: "application/geo+json" });
    const loaded = await loadFile(file);
    expect(loaded.format).toBe("ndjson");
    expect(loaded.name).toBe("results.geojson");
    expect(loaded.fc.features).toHaveLength(2);
    expect(loaded.bytes).toBe(file.size);
  });
});
