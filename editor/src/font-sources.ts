// Font source registry — Google + Bunny + Fontshare + Fontsource + Velvetyne.
//
// Each source ships a static family catalog (a sibling `<source>-fonts.ts`
// module, refreshed by `scripts/build-fonts.mjs`). At load time the editor
// looks up a family's source via `getFontSource(family)` and dispatches to
// the right URL pattern:
//
//   google     → fonts.googleapis.com/css2  (per-face)
//   bunny      → fonts.bunny.net/css         (per-face, Google-compatible)
//   fontshare  → api.fontshare.com/v2/css    (one URL per family, all weights)
//   fontsource → cdn.jsdelivr.net/fontsource (one URL per family, all weights)
//   velvetyne  → direct font file URLs (FontFace API, per-face)
//
// Overlap rule: when a family exists in more than one catalog, the first
// hit in PRIORITY order wins. Google is the priority root because the existing
// loader path is well-tested; the other sources only "own" their EXCLUSIVE
// families. The picker uses the same priority to dedupe what it lists.

import { GOOGLE_FONTS } from "./google-fonts.ts";
import { BUNNY_FONTS } from "./bunny-fonts.ts";
import { FONTSHARE_FONTS } from "./fontshare-fonts.ts";
import { FONTSOURCE_FONTS } from "./fontsource-fonts.ts";
import { VELVETYNE_FONTS } from "./velvetyne-fonts.ts";

export type FontSource =
  | "google"
  | "bunny"
  | "fontshare"
  | "fontsource"
  | "velvetyne";

// A single (weight, italic) face for sources that load files directly
// (Velvetyne). Other sources resolve faces via their CSS endpoint.
export interface FontFaceFile {
  weight: number;
  italic: boolean;
  /** Direct font file URL (woff2 preferred). */
  src: string;
}

// One family in a source's catalog. Slug is the source-specific URL token
// (e.g. Bunny "be-vietnam-pro" for "Be Vietnam Pro"); Fontshare/Fontsource
// also use slugs. Velvetyne has no slug — its faces are explicit file URLs.
export interface FontCatalogEntry {
  family: string;
  source: FontSource;
  /** Slug used in the source's URL pattern. Optional for Velvetyne. */
  slug?: string;
  /** Available numeric weights (no italic flag — italic is a separate axis). */
  weights: number[];
  /** True if any italic face is available. */
  italics: boolean;
  /** Velvetyne only: explicit per-face file URLs. */
  faces?: FontFaceFile[];
  /** "sans-serif" | "serif" | "display" | "handwriting" | "monospace" — best-effort. */
  category?: string;
}

// Priority order. When a family appears in multiple catalogs the FIRST source
// in this list wins — both for loader dispatch and for picker dedup.
const PRIORITY: FontSource[] = [
  "google",
  "fontshare",
  "fontsource",
  "bunny",
  "velvetyne",
];

// Catalog lookup is case-insensitive on family. The picker is allowed to
// drop hits whose family already appeared in a higher-priority catalog.
const norm = (s: string): string => s.trim().toLowerCase();

// Source → Map<lower-family, entry>. Built once at module load.
const indexBySource: Record<FontSource, Map<string, FontCatalogEntry>> = {
  google: new Map(GOOGLE_FONTS.map((f) => [norm(f), googleEntry(f)])),
  bunny: new Map(BUNNY_FONTS.map((e) => [norm(e.family), { ...e, source: "bunny" as FontSource }])),
  fontshare: new Map(
    FONTSHARE_FONTS.map((e) => [norm(e.family), { ...e, source: "fontshare" as FontSource }]),
  ),
  fontsource: new Map(
    FONTSOURCE_FONTS.map((e) => [norm(e.family), { ...e, source: "fontsource" as FontSource }]),
  ),
  velvetyne: new Map(
    VELVETYNE_FONTS.map((e) => [norm(e.family), { ...e, source: "velvetyne" as FontSource }]),
  ),
};

// Google entries are bare strings in google-fonts.ts (the file predates this
// module). Wrap them into a uniform entry with no per-family slug (Google's
// CSS2 URL takes the family name directly).
function googleEntry(family: string): FontCatalogEntry {
  return {
    family,
    source: "google",
    weights: [],   // resolved per-face by the existing Google loader
    italics: true, // assume yes; the Google CSS2 endpoint 400s harmlessly when not
  };
}

// Resolve a family → source via the priority order. Returns null when the
// family is in no catalog (likely a user-uploaded custom_font; the loader
// then falls back to the existing FontFace path for project.custom_fonts).
export const getFontSource = (family: string): FontSource | null => {
  const key = norm(family);
  for (const s of PRIORITY) {
    if (indexBySource[s].has(key)) return s;
  }
  return null;
};

// Resolve to the full catalog entry (or null). Used by the loader for slug
// + face URLs; used by the picker for badge + filter.
export const getFontEntry = (family: string): FontCatalogEntry | null => {
  const key = norm(family);
  for (const s of PRIORITY) {
    const e = indexBySource[s].get(key);
    if (e) return e;
  }
  return null;
};

// Catalog for the picker, deduped by priority. The picker should render the
// returned array as-is (already sorted by source priority, then alphabetical
// within each source).
export const allFontEntries = (): FontCatalogEntry[] => {
  const seen = new Set<string>();
  const out: FontCatalogEntry[] = [];
  for (const s of PRIORITY) {
    const sorted = [...indexBySource[s].values()].sort((a, b) =>
      a.family.localeCompare(b.family),
    );
    for (const e of sorted) {
      const key = norm(e.family);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
};

// ── URL builders ────────────────────────────────────────────────────────────

// Bunny mirrors Google's CSS2 axis syntax; safe to reuse the same format.
// Returns a stylesheet URL — inject as <link>.
export const bunnyCssUrl = (
  slug: string,
  weight: number,
  italic: boolean,
): string => {
  const axis = italic ? `ital,wght@1,${weight}` : `wght@${weight}`;
  return `https://fonts.bunny.net/css?family=${slug}:${axis}&display=swap`;
};

// Fontshare exposes a single CSS endpoint per family that ships every face;
// loading once covers all weights/italics for that family. Wasteful vs Google
// but simple + reliable.
export const fontshareCssUrl = (slug: string): string =>
  `https://api.fontshare.com/v2/css?f[]=${slug}&display=swap`;

// Fontsource via jsDelivr — `index.css` contains every face for the family.
export const fontsourceCssUrl = (slug: string): string =>
  `https://cdn.jsdelivr.net/fontsource/css/${slug}@latest/index.css`;

// Pick a Velvetyne face for (weight, italic). Falls back to the nearest
// available weight (closest numeric distance, italic match preferred).
export const velvetyneFaceFor = (
  entry: FontCatalogEntry,
  weight: number,
  italic: boolean,
): FontFaceFile | null => {
  const faces = entry.faces ?? [];
  if (faces.length === 0) return null;
  const score = (f: FontFaceFile): number =>
    Math.abs(f.weight - weight) + (f.italic === italic ? 0 : 1000);
  return faces.slice().sort((a, b) => score(a) - score(b))[0] ?? null;
};
