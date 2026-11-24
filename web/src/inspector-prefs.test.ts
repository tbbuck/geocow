import { describe, it, expect } from "vitest";

import {
  loadPins,
  loadShowContext,
  savePins,
  saveShowContext,
  togglePin,
} from "./inspector-prefs";

/** A Storage stand-in backed by a Map. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

/** Storage that refuses everything, as a locked-down browser's can. */
const refusing = {
  getItem: (): string | null => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("togglePin", () => {
  it("pins a key at the end, and unpins one already pinned", () => {
    expect(togglePin(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePin(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("pins", () => {
  it("round-trip through storage, in order", () => {
    const storage = memoryStorage();
    savePins(["height_m", "use"], storage);
    expect(loadPins(storage)).toEqual(["height_m", "use"]);
  });

  it("load as none when missing or malformed, keeping only string keys", () => {
    const at = (raw: string) => memoryStorage({ "geocow:pinned-properties": raw });
    expect(loadPins(memoryStorage())).toEqual([]);
    expect(loadPins(at("{oops"))).toEqual([]);
    expect(loadPins(at('{"a":1}'))).toEqual([]);
    expect(loadPins(at('["a",2,"b"]'))).toEqual(["a", "b"]);
  });

  it("survive storage that refuses", () => {
    expect(loadPins(refusing)).toEqual([]);
    expect(() => savePins(["a"], refusing)).not.toThrow();
  });
});

describe("context visibility", () => {
  it("is on until turned off, and remembered either way", () => {
    const storage = memoryStorage();
    expect(loadShowContext(storage)).toBe(true);
    saveShowContext(false, storage);
    expect(loadShowContext(storage)).toBe(false);
    saveShowContext(true, storage);
    expect(loadShowContext(storage)).toBe(true);
  });

  it("is on when storage refuses", () => {
    expect(loadShowContext(refusing)).toBe(true);
    expect(() => saveShowContext(false, refusing)).not.toThrow();
  });
});
