import { LitElement } from "lit";

/**
 * Base class that renders into light DOM instead of a shadow root.
 *
 * We do this so global Tailwind utility classes and MapLibre's stylesheet
 * apply to component markup without per-component style injection — the
 * pragmatic choice when integrating a map library that expects to own real
 * DOM nodes.
 */
export class LightElement extends LitElement {
  protected createRenderRoot() {
    return this;
  }
}
