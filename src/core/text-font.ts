// The rules a text layer's type shares between the browser and the headless
// layer, in one place: the family it paints in, the line ratio its lines
// stack at, the size a hug layer falls back to, and the string that is
// measured and painted. The export and the preview (editor/src/renderer.ts,
// dom-render.tsx), the font loader that fetches the face before either draws
// (editor/src/fonts.ts), the Inspector's font field, the tools and the
// headless text measurer (src/text-measure.ts) all read these instead of
// restating them. A second copy that drifted would load one face and lay text
// out in another, or report a box the canvas does not paint.
import type { TextLayer } from "./schemas.ts";

// Hanken Grotesk is the Morpha brand font (see BRAND.md). The tools write it
// into new layers, and a layer whose `font_family` is unset paints in it.
export const DEFAULT_TEXT_FONT = "Hanken Grotesk";

export const textFamily = (layer: Pick<TextLayer, "font_family">): string =>
  layer.font_family?.trim() || DEFAULT_TEXT_FONT;

// Line height as a multiple of the font size when a layer sets none.
export const TEXT_LINE_RATIO = 1.16;

// Font size for a hug layer with no explicit text_size. The Inspector and the
// tools seed text_size on entering hug, so this is only a defensive default.
export const DEFAULT_HUG_FONT_PX = 120;

// The string that is measured and painted: the text after its case transform.
export const textDisplayString = (layer: TextLayer): string =>
  layer.text_transform === "uppercase"
    ? layer.text.toUpperCase()
    : layer.text_transform === "lowercase"
      ? layer.text.toLowerCase()
      : layer.text;
