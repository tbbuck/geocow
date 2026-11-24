import "./styles.css";
import { applyPanelScheme, savedScheme } from "./theme";
import "./app";

// Runs before the app's first render (Lit renders in a microtask, after this
// module), so the panels never flash the wrong colour scheme.
applyPanelScheme(savedScheme());
