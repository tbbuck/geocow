// The app's panels follow the colour scheme picked with Auto/Light/Dark,
// not just the map: Tailwind's dark: variant keys off a `dark` class on
// <html> (darkMode: "class"), which this sets. main.ts applies the saved
// scheme before the first render, so a dark system never flashes light.

import { panelsDark, parseScheme, type ColorScheme } from "./config";

export const SCHEME_KEY = "geocow:scheme";

/** The scheme saved from the last session, or Auto. */
export function savedScheme(): ColorScheme {
  try {
    return parseScheme(window.localStorage.getItem(SCHEME_KEY));
  } catch {
    return "system";
  }
}

/** Darken (or lighten) the panels for `scheme`, the system deciding under Auto. */
export function applyPanelScheme(scheme: ColorScheme): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", panelsDark(scheme, prefersDark));
}
