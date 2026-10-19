import { describe, it, expect } from "vitest";

import { parseSymbolId, symbolStem } from "./symbols";

describe("symbolStem", () => {
  it("names letters, digits and Maki icons", () => {
    expect(symbolStem("z")).toBe("geocow-symbol:z");
    expect(symbolStem("0")).toBe("geocow-symbol:0");
    expect(symbolStem(9)).toBe("geocow-symbol:9");
    expect(symbolStem(" rocket ")).toBe("geocow-symbol:rocket");
  });

  it("refuses anything it can't draw", () => {
    for (const v of ["", "A", "ab", "no-such-icon", 10, -1, 1.5, null, {}]) {
      expect(symbolStem(v)).toBeNull();
    }
  });
});

describe("parseSymbolId", () => {
  it("splits an image id into symbol and ink", () => {
    expect(parseSymbolId("geocow-symbol:bank-JP:dark")).toEqual({ symbol: "bank-JP", ink: "dark" });
    expect(parseSymbolId("geocow-symbol:7:light")).toEqual({ symbol: "7", ink: "light" });
  });

  it("ignores ids that aren't ours or don't name a drawable symbol", () => {
    expect(parseSymbolId("airport_11")).toBeNull();
    expect(parseSymbolId("geocow-symbol:rocket")).toBeNull();
    expect(parseSymbolId("geocow-symbol:rocket:blue")).toBeNull();
    expect(parseSymbolId("geocow-symbol:no-such-icon:dark")).toBeNull();
  });
});
