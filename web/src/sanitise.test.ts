import { describe, it, expect } from "vitest";

import { sanitisePaste } from "./sanitise";

const POLY = "POLYGON((-1.5 52.4, -1.5 52.5, -1.4 52.5, -1.5 52.4))";

describe("sanitisePaste", () => {
  it("leaves clean single-line WKT alone", () => {
    const out = sanitisePaste(POLY);
    expect(out.text).toBe(POLY);
    expect(out.mode).toBe("single");
    expect(out.notes).toEqual([]);
  });

  it("leaves clean GeoJSON alone", () => {
    const gj = '{"type":"Point","coordinates":[-1.5,52.4]}';
    expect(sanitisePaste(gj)).toMatchObject({ text: gj, mode: "single" });
  });

  // The headline case: a long WKT copied out of a terminal, hard-wrapped at
  // the window edge. The breaks land on whitespace, so joining with a space
  // reconstitutes the original.
  it("rejoins a WKT geometry wrapped across lines", () => {
    const wrapped = [
      "POLYGON((525217.1988 105907.8035, 525200.9972 105931.6966,",
      "525189.6025 105949.2016, 525157.1005 106002.3964,",
      "525098.9976 106102.8976))",
    ].join("\n");
    const out = sanitisePaste(wrapped);
    expect(out.mode).toBe("single");
    expect(out.text).toBe(
      "POLYGON((525217.1988 105907.8035, 525200.9972 105931.6966, " +
        "525189.6025 105949.2016, 525157.1005 106002.3964, " +
        "525098.9976 106102.8976))",
    );
    expect(out.notes).toContain("joined 3 wrapped lines");
  });

  it("rejoins pretty-printed GeoJSON", () => {
    const pretty = '{\n  "type": "Point",\n  "coordinates": [-1.5, 52.4]\n}';
    const out = sanitisePaste(pretty);
    expect(out.mode).toBe("single");
    expect(JSON.parse(out.text)).toEqual({
      type: "Point",
      coordinates: [-1.5, 52.4],
    });
  });

  // Copying a cell out of a CLI table (psql, mysql, duckdb) drags the column
  // rules along with it.
  it("strips ASCII table pipes and rules", () => {
    const table = [
      "+------------------+",
      "| geom             |",
      "+------------------+",
      `| ${POLY} |`,
      "+------------------+",
    ].join("\n");
    const out = sanitisePaste(table);
    expect(out.text).toBe(POLY);
    expect(out.notes).toContain("removed table borders");
  });

  it("strips unicode box-drawing borders", () => {
    const table = [
      "┌──────────────────┐",
      "│ geom             │",
      "├──────────────────┤",
      `│ ${POLY} │`,
      "└──────────────────┘",
    ].join("\n");
    expect(sanitisePaste(table).text).toBe(POLY);
  });

  it("drops a header row that isn't geometry", () => {
    const table = [`| geom |`, `| ${POLY} |`].join("\n");
    expect(sanitisePaste(table).text).toBe(POLY);
  });

  it("strips psql's trailing + continuation markers", () => {
    const wrapped = ["POLYGON((-1.5 52.4, -1.5 52.5,   +", "-1.4 52.5, -1.5 52.4))"].join(
      "\n",
    );
    expect(sanitisePaste(wrapped).text).toBe(
      "POLYGON((-1.5 52.4, -1.5 52.5, -1.4 52.5, -1.5 52.4))",
    );
  });

  it("unwraps a quoted blob and drops a trailing semicolon", () => {
    expect(sanitisePaste(`"${POLY}";`).text).toBe(POLY);
    expect(sanitisePaste(`'${POLY}'`).text).toBe(POLY);
  });

  it("normalises smart quotes, nbsp and zero-width characters", () => {
    // Smart quotes wrapping the blob, a non-breaking space between the
    // coordinates, and a stray zero-width space — the Slack/Word paste.
    const dirty = "“POINT(-1.5 52.4)​”";
    expect(sanitisePaste(dirty).text).toBe("POINT(-1.5 52.4)");
  });

  it("collapses runs of whitespace", () => {
    expect(sanitisePaste("POINT(-1.5     52.4)").text).toBe("POINT(-1.5 52.4)");
  });

  it("keeps several WKT geometries as separate lines", () => {
    const many = ["POINT(-1.5 52.4)", "POINT(-1.4 52.5)", "POINT(-1.3 52.6)"].join(
      "\n",
    );
    const out = sanitisePaste(many);
    expect(out.mode).toBe("lines");
    expect(out.text).toBe(many);
    expect(out.notes).toContain("3 geometries, one per line");
  });

  it("keeps NDJSON as separate lines", () => {
    const nd = [
      '{"type":"Point","coordinates":[-1.5,52.4]}',
      '{"type":"Point","coordinates":[-1.4,52.5]}',
    ].join("\n");
    const out = sanitisePaste(nd);
    expect(out.mode).toBe("lines");
    expect(out.text).toBe(nd);
  });

  // A table of one-geometry-per-row is both problems at once.
  it("handles a table of several geometries", () => {
    const table = [
      "| geom             |",
      "|------------------|",
      "| POINT(-1.5 52.4) |",
      "| POINT(-1.4 52.5) |",
    ].join("\n");
    const out = sanitisePaste(table);
    expect(out.mode).toBe("lines");
    expect(out.text).toBe("POINT(-1.5 52.4)\nPOINT(-1.4 52.5)");
  });

  it("does not split a single geometry that merely contains newlines", () => {
    // Each line here is a *fragment*, not a geometry, so it must be joined.
    const out = sanitisePaste("MULTIPOINT(\n(1 2),\n(3 4)\n)");
    expect(out.mode).toBe("single");
    expect(out.text).toBe("MULTIPOINT((1 2), (3 4))");
  });

  // A terminal that hard-wraps at the window edge breaks *inside* numbers, with
  // no whitespace to mark it. The coordinates themselves give it away: every
  // easting and northing here has six digits before the point, so a fragment
  // like "88" or "5252" is obviously half of something.
  describe("numbers split by a hard wrap", () => {
    it("rejoins a number split in its decimals", () => {
      const out = sanitisePaste(
        "POLYGON((525217.19\n88 105907.8035, 525200.9972 105931.6966, 525217.1988 105907.8035))",
      );
      expect(out.text).toBe(
        "POLYGON((525217.1988 105907.8035, 525200.9972 105931.6966, 525217.1988 105907.8035))",
      );
    });

    it("rejoins a number split in its integer part", () => {
      const out = sanitisePaste(
        "POLYGON((525217.1988 105907.8035, 5252\n00.9972 105931.6966, 525217.1988 105907.8035))",
      );
      expect(out.text).toContain("525200.9972");
    });

    it("rejoins a number split at the decimal point", () => {
      const before = sanitisePaste(
        "POLYGON((525217.1988 105907.8035, 525200.\n9972 105931.6966, 525217.1988 105907.8035))",
      );
      expect(before.text).toContain("525200.9972");

      const after = sanitisePaste(
        "POLYGON((525217.1988 105907.8035, 525200\n.9972 105931.6966, 525217.1988 105907.8035))",
      );
      expect(after.text).toContain("525200.9972");
    });

    // The counter-case that makes this hard: a break between x and y also puts
    // a digit at the end of one line and a digit at the start of the next, but
    // both halves are whole coordinates and must stay apart.
    it("does not glue a legitimate x/y pair split across lines", () => {
      const out = sanitisePaste(
        "POLYGON((525217.1988 105907.8035, 525200.9972\n105931.6966, 525189.6025 105949.2016, 525217.1988 105907.8035))",
      );
      expect(out.text).toContain("525200.9972 105931.6966");
      expect(out.text).not.toContain("525200.9972105931.6966");
    });

    it("handles glued and separate boundaries in the same paste", () => {
      const out = sanitisePaste(
        [
          "POLYGON((525217.1988 105907.8035, 525200.99",
          "72 105931.6966, 525189.6025",
          "105949.2016, 525217.1988 105907.8035))",
        ].join("\n"),
      );
      expect(out.text).toBe(
        "POLYGON((525217.1988 105907.8035, 525200.9972 105931.6966, " +
          "525189.6025 105949.2016, 525217.1988 105907.8035))",
      );
    });

    it("works on lon/lat, where the integer parts are short", () => {
      const out = sanitisePaste(
        "LINESTRING(-1.5234 52.4001, -1.52\n35 52.4002, -1.5236 52.4003)",
      );
      expect(out.text).toContain("-1.5235 52.4002");
    });

    // The real test: wrap known geometries at every plausible terminal width,
    // with no regard for word boundaries, and demand the original back.
    const FIXTURES: Record<string, string> = {
      "national grid polygon":
        "POLYGON((525217.1988 105907.8035, 525200.9972 105931.6966, " +
        "525189.6025 105949.2016, 525157.1005 106002.3964, " +
        "525098.9976 106102.8976, 525098.1978 106104.2972, " +
        "525090.0022 106118.3032, 525081.7984 106132.2992, " +
        "525073.7017 106146.3952, 525065.9019 106160.7011, " +
        "525217.1988 105907.8035))",
      "lon/lat linestring":
        "LINESTRING(-1.5234 52.4001, -1.5235 52.4002, -1.5236 52.4003, " +
        "-1.5237 52.4004, -1.5238 52.4005, -1.5239 52.4006, -1.5240 52.4007)",
      // Trailing zeros dropped, as a database hands them over: the decimal
      // count varies, so neither signal is uniform on its own.
      "ragged precision":
        "POLYGON((525217.1988 105907.8, 525200.997 105931.6966, " +
        "525189.6 105949.2016, 525157.1005 106002.396, " +
        "525098.9976 106102.89, 525217.1988 105907.8))",
      "negative and small":
        "MULTIPOINT((-3.1883 55.9533), (-0.1276 51.5072), (-2.5879 51.4545))",
    };

    // 16 columns is already narrower than a single coordinate *pair* of
    // National Grid values ("525217.1988 105907.8035" is 23 characters), i.e.
    // far below anything a terminal could produce. Below that the fragments
    // carry too little of the original to be recognisable.
    for (const [name, original] of Object.entries(FIXTURES)) {
      it(`survives a hard wrap at any width: ${name}`, () => {
        for (let width = 16; width <= 200; width++) {
          const wrapped = original.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
          expect(sanitisePaste(wrapped).text, `${name} at width ${width}`).toBe(
            original,
          );
        }
      });
    }
  });

  it("reports nothing to do for already-clean input", () => {
    expect(sanitisePaste(POLY).notes).toEqual([]);
    expect(sanitisePaste("  " + POLY + "  ").notes).toEqual([]);
  });

  it("survives empty and whitespace-only input", () => {
    expect(sanitisePaste("").text).toBe("");
    expect(sanitisePaste("   \n\n  ").text).toBe("");
  });

  // PostGIS hands out EWKT; the WKT parser doesn't take the SRID prefix.
  it("strips an EWKT SRID prefix", () => {
    const out = sanitisePaste("SRID=27700;POINT(434115.78 278114.07)");
    expect(out.text).toBe("POINT(434115.78 278114.07)");
    expect(out.notes).toContain("removed SRID prefix");
  });

  it("strips a trailing comma left over from a list", () => {
    expect(sanitisePaste(`${POLY},`).text).toBe(POLY);
  });

  it("normalises CRLF without reporting a join", () => {
    expect(sanitisePaste(`${POLY}\r\n`).text).toBe(POLY);
    expect(sanitisePaste(`${POLY}\r\n`).notes).toEqual([]);
  });
});
