// The family a text layer paints in, in one place. Hanken Grotesk is the Morpha
// brand font (see BRAND.md). The tools write it into new layers, and a layer
// whose `font_family` is unset paints in it, so the export and the preview
// (editor/src/renderer.ts, dom-render.tsx), the font loader that fetches the
// face before either draws (editor/src/fonts.ts) and the Inspector's font field
// all read this rule instead of restating it. A second copy that drifted would
// load one face and lay text out in another.
import type { TextLayer } from "./schemas.ts";

export const DEFAULT_TEXT_FONT = "Hanken Grotesk";

export const textFamily = (layer: Pick<TextLayer, "font_family">): string =>
  layer.font_family?.trim() || DEFAULT_TEXT_FONT;
