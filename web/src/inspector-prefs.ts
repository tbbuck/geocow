// What the info box remembers between sessions: the pinned property keys,
// in pin order, and whether the context boxes are showing. localStorage by
// default; any Storage-like object for tests. Storage that refuses (private
// modes, full quota) just means nothing is remembered.

type Store = Pick<Storage, "getItem" | "setItem">;

const PINS_KEY = "geocow:pinned-properties";
const CONTEXT_KEY = "geocow:inspector-context";

/** `key` pinned at the end, or unpinned if it already was. */
export function togglePin(pins: readonly string[], key: string): string[] {
  return pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
}

export function loadPins(store: Store = window.localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function savePins(pins: readonly string[], store: Store = window.localStorage): void {
  try {
    store.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // not remembered; pins still hold for the session
  }
}

/** Whether the context boxes show: on unless turned off. */
export function loadShowContext(store: Store = window.localStorage): boolean {
  try {
    return store.getItem(CONTEXT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveShowContext(show: boolean, store: Store = window.localStorage): void {
  try {
    store.setItem(CONTEXT_KEY, show ? "on" : "off");
  } catch {
    // not remembered
  }
}
