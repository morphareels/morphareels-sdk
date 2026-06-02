// velvetyne-fonts.ts
//
// Curated catalog of Velvetyne (https://velvetyne.fr/) libre faces. Velvetyne
// has no public catalog API; we ship a hand-picked set served via jsDelivr's
// GitHub mirror (https://cdn.jsdelivr.net/gh/velvetyne/…). Adding a face
// means picking a repo, finding its `*.woff2` (or `.woff`) path with the
// GitHub tree API, and slotting it in below. URLs are stable as long as the
// upstream repo keeps the file.
//
// Unlike Bunny / Fontshare / Fontsource (CSS endpoints), Velvetyne faces are
// loaded by the editor via the FontFace API — each entry below lists the
// faces explicitly so a (family, weight, italic) request can be served.

export interface VelvetyneFace {
  weight: number;
  italic: boolean;
  src: string;
}

export interface VelvetyneFont {
  family: string;
  weights: number[];
  italics: boolean;
  category?: string;
  faces: VelvetyneFace[];
}

const GH = "https://cdn.jsdelivr.net/gh/velvetyne";

export const VELVETYNE_FONTS: ReadonlyArray<VelvetyneFont> = [
  {
    family: "Bluu Next",
    weights: [700],
    italics: true,
    category: "display",
    faces: [
      {
        weight: 700,
        italic: false,
        src: `${GH}/BluuNext@master/Fonts/webfonts/bluunext-bold-webfont.woff2`,
      },
      {
        weight: 700,
        italic: true,
        src: `${GH}/BluuNext@master/Fonts/webfonts/bluunext-bolditalic-webfont.woff2`,
      },
    ],
  },
  {
    family: "Sporting Grotesque",
    weights: [400, 700],
    italics: false,
    category: "sans-serif",
    faces: [
      {
        weight: 400,
        italic: false,
        src: `${GH}/Sporting-Grotesque@main/webfonts/Regular/Sporting_Grotesque-Regular_web.woff2`,
      },
      {
        weight: 700,
        italic: false,
        src: `${GH}/Sporting-Grotesque@main/webfonts/Bold/Sporting_Grotesque-Bold_web.woff2`,
      },
    ],
  },
  {
    family: "Trickster",
    weights: [400],
    italics: false,
    category: "display",
    faces: [
      {
        weight: 400,
        italic: false,
        src: `${GH}/Trickster@master/webfonts/Trickster-Regular.woff2`,
      },
    ],
  },
  {
    family: "BilboINC",
    weights: [400],
    italics: false,
    category: "display",
    faces: [
      {
        weight: 400,
        italic: false,
        src: `${GH}/BilboINC@master/Fonts/webfonts/BilboINC-Regular_web.woff2`,
      },
    ],
  },
  {
    family: "Daubenton",
    weights: [400],
    italics: false,
    category: "serif",
    faces: [
      {
        // Daubenton ships .woff only (no .woff2). The FontFace API decodes
        // .woff fine across modern browsers — slightly larger payload.
        weight: 400,
        italic: false,
        src: `${GH}/Daubenton@master/fonts/webfonts/daubentonwebfont.woff`,
      },
    ],
  },
];
