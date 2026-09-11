// Destination crop geometry — "where does this composition get trimmed when a
// platform shows it somewhere other than full-bleed".
//
// A vertical 9:16 master is NOT shown 9:16 everywhere. Instagram's Feed centre-
// crops it to 4:5 and Explore to 1:1, deleting a band off each end. That is a
// pure geometric fact about the canvas — it needs no project data, no network,
// and no cache — so it lives here as data and every surface reads it.
//
// SCOPE, and how this relates to the other platform-geometry surface. There are
// exactly two, and they model different hazards:
//
//   this module + CropMarks   — the CROP. Content DELETED because a placement
//                               shows a different aspect than the canvas.
//                               Always on; renders only when violated.
//   SocialSafeZoneOverlay     — the CHROME. Content that survives but sits
//                               under a caption block / action rail / tab bar.
//                               An opt-in preview, not a check. Its figures,
//                               combined into the area neither app covers,
//                               live here as PLATFORM_CHROME_INSETS.
//
// They are not a fork: neither can answer the other's question. What they DO
// share is "which canvas is the portrait one", which lives here as
// `isPortraitCanvas` so it cannot drift between them.
//
// Both are editor chrome, so an agent sees neither. `platformSafeAreaFor` is
// their one agent-facing reader: it intersects the two into the part of the
// canvas that stays visible, and describe_video hands that to every agent
// surface. A human and an agent place a title from the same numbers.
//
// SPEC DATE. Platform aspect ratios are far more stable than platform chrome,
// but they are still someone else's product decision. SPEC_AS_OF is code-level
// provenance (it is not surfaced in the UI): bump it whenever the destination
// data below is re-checked against the platforms.

export const SPEC_AS_OF = "2026-07";

export type CropDestination = {
  /** Stable key; used for persistence and test assertions. */
  key: string;
  /** Shown to the user. Short — it appears inside a one-line banner. */
  label: string;
  /** Target aspect ratio the platform crops this canvas to (w / h). */
  aspect: number;
  /** One plain, self-contained sentence for the canvas tooltip: which platform
   *  does what to the grey part. Lives ON the destination so the copy names
   *  the right platform if a second one is ever added. */
  explanation: string;
};

/** A rectangle in canvas pixels. */
export type CanvasRect = { x: number; y: number; width: number; height: number };

/** A crop window in CANVAS pixels — the region that SURVIVES. */
export type CropWindow = CanvasRect & { destination: CropDestination };

const FEED_4_5: CropDestination = {
  key: "feed45",
  label: "Feed 4:5",
  aspect: 4 / 5,
  explanation:
    "Instagram's feed crops this video to 4:5, so the grey areas won't be shown there.",
};

// Instagram's 1:1 Explore GRID is a thumbnail — tapping it plays the reel
// full-bleed — so a layer clipped there is not actually lost to the viewer. It
// was modelled here at first and had to come out: on a real composition it
// fires on every decorative element that reaches the canvas edge, and a check
// that flags fourteen layers on an untouched project is one nobody reads.
// The 4:5 Feed crop is the hazard that actually deletes content.
const DESTINATIONS: CropDestination[] = [FEED_4_5];

const PORTRAIT_9_16 = 9 / 16;
const ASPECT_EPSILON = 0.005;

const aspectIs = (w: number, h: number, target: number): boolean =>
  h > 0 && Math.abs(w / h - target) < ASPECT_EPSILON;

/** The vertical 9:16 canvas SocialSafeZoneOverlay keys its ghost chrome off.
 *  Ratio-based, so a half-size 9:16 canvas (540×960) still counts. The crop
 *  windows below no longer gate on this — they model the letterbox pipeline
 *  for ANY canvas — but the chrome overlay is drawn for the canvas that fills
 *  the player, which is exactly the 9:16 one. */
export const isPortraitCanvas = (w: number, h: number): boolean =>
  aspectIs(w, h, PORTRAIT_9_16);

// The 9:16 frame every vertical placement starts from. Units are arbitrary —
// the result is mapped back to canvas px through the fit scale; 1080×1920
// keeps the intermediate numbers readable.
const FRAME_W = 1080;
const FRAME_H = 1920;

// Sub-pixel slop for "the window covers the whole canvas". Matches
// deadBandsOf's threshold so the two can't disagree about a hairline band.
const COVER_EPSILON = 0.5;

/** The surviving window of `destination` on this canvas, or null when the
 *  destination doesn't actually cut it.
 *
 *  Models the real pipeline rather than a per-aspect rule: the export is
 *  contain-fit (letterboxed) into the platform's 9:16 frame, the platform
 *  centre-crops that FRAME to the destination's aspect, and what survives is
 *  the intersection mapped back to canvas pixels. One formula, every canvas:
 *   - a 9:16 master fills the frame, so Feed keeps its centre 4:5 — the
 *     classic case, numerically identical to the old exact-9:16 gate;
 *   - any canvas TALLER than 4:5 (2:3, 3:4, a custom size) still loses its
 *     ends, because the letterboxed composite is cropped through the middle —
 *     the exact-9:16 gate silently skipped these;
 *   - 4:5 / 1:1 / 16:9 sit entirely inside the cropped frame (letterboxed,
 *     never trimmed), so they get no window and no marks — correctly. */
export const cropWindowFor = (
  destination: CropDestination,
  canvasWidth: number,
  canvasHeight: number,
): CropWindow | null => {
  if (canvasWidth <= 0 || canvasHeight <= 0) return null;
  const scale = Math.min(FRAME_W / canvasWidth, FRAME_H / canvasHeight);
  const contentW = canvasWidth * scale;
  const contentH = canvasHeight * scale;
  const contentX = (FRAME_W - contentW) / 2;
  const contentY = (FRAME_H - contentH) / 2;

  // The destination's centre crop OF THE FRAME. Width-constrained for every
  // destination we model (all are wider than 9:16); the narrow branch keeps a
  // hypothetical taller-than-frame destination from producing a negative band.
  const wide = destination.aspect > FRAME_W / FRAME_H;
  const winW = wide ? FRAME_W : FRAME_H * destination.aspect;
  const winH = wide ? FRAME_W / destination.aspect : FRAME_H;
  const winX = (FRAME_W - winW) / 2;
  const winY = (FRAME_H - winH) / 2;

  // Intersect window and content in frame units, then map back to canvas px.
  const x0 = Math.max(winX, contentX);
  const y0 = Math.max(winY, contentY);
  const x1 = Math.min(winX + winW, contentX + contentW);
  const y1 = Math.min(winY + winH, contentY + contentH);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;

  const window: CropWindow = {
    destination,
    x: (x0 - contentX) / scale,
    y: (y0 - contentY) / scale,
    width: (x1 - x0) / scale,
    height: (y1 - y0) / scale,
  };
  const coversCanvas =
    window.x <= COVER_EPSILON &&
    window.y <= COVER_EPSILON &&
    window.x + window.width >= canvasWidth - COVER_EPSILON &&
    window.y + window.height >= canvasHeight - COVER_EPSILON;
  return coversCanvas ? null : window;
};

/** Destinations that actually cut a canvas of this size. Derived from the
 *  window geometry — one source of truth, so "has a destination" and "has a
 *  window" can never disagree. */
export const cropDestinationsFor = (
  canvasWidth: number,
  canvasHeight: number,
): CropDestination[] =>
  DESTINATIONS.filter((d) => cropWindowFor(d, canvasWidth, canvasHeight) !== null);

export const cropWindowsFor = (
  canvasWidth: number,
  canvasHeight: number,
): CropWindow[] =>
  DESTINATIONS.map((d) => cropWindowFor(d, canvasWidth, canvasHeight)).filter(
    (w): w is CropWindow => w !== null,
  );

/** The dead bands of a crop window, in canvas pixels. Zero-height bands are omitted. */
export const deadBandsOf = (
  window: CropWindow,
  canvasWidth: number,
  canvasHeight: number,
): CanvasRect[] => {
  const bands: CanvasRect[] = [];
  if (window.y > 0.5) bands.push({ x: 0, y: 0, width: canvasWidth, height: window.y });
  const bottom = window.y + window.height;
  if (canvasHeight - bottom > 0.5) {
    bands.push({ x: 0, y: bottom, width: canvasWidth, height: canvasHeight - bottom });
  }
  if (window.x > 0.5) bands.push({ x: 0, y: 0, width: window.x, height: canvasHeight });
  const right = window.x + window.width;
  if (canvasWidth - right > 0.5) {
    bands.push({ x: right, y: 0, width: canvasWidth - right, height: canvasHeight });
  }
  return bands;
};

// PLATFORM CHROME, the other hazard. TikTok and Instagram Reels draw their own
// buttons, caption block and tab bar over a full-screen 9:16 video, and
// SocialSafeZoneOverlay ghosts that chrome for the user. These are the insets,
// in the 1080×1920 frame the overlay is drawn in, of the area NEITHER app
// covers. The overlay's chrome approximates the apps' published ad safe-area
// specs, and each side here takes the larger of the two apps' figures:
//
//   top    220  Instagram Reels' header (TikTok's is ~130)
//   right  140  TikTok's action rail (the Reels rail, as drawn, sits inside it)
//   bottom 480  TikTok's caption block and tab bar (Reels' is ~420)
//   left     0  neither app keeps a margin on the left
//
// test/platform-safe-area.test.ts walks the overlay's drawing and fails if any
// of it enters this area, so the drawing and these numbers move together.
export const PLATFORM_CHROME_INSETS = {
  top: 220,
  right: 140,
  bottom: 480,
  left: 0,
} as const;

/** The part of the canvas that stays visible on the platforms Morpha models:
 *  clear of the TikTok and Reels chrome on a 9:16 canvas, and inside every
 *  crop window (Instagram's 4:5 feed) on any canvas taller than 4:5. Null when
 *  neither applies, which is to say nothing is covered or cropped (1:1, 16:9,
 *  4:5).
 *
 *  The chrome gate is `isPortraitCanvas`, the predicate the overlay uses, so
 *  an agent is told about the chrome exactly when a human can switch it on.
 *  Edges round INWARD (ceil for left and top, floor for right and bottom) so
 *  rounding never hands back a pixel the platforms cover. */
export const platformSafeAreaFor = (
  canvasWidth: number,
  canvasHeight: number,
): CanvasRect | null => {
  const chrome = isPortraitCanvas(canvasWidth, canvasHeight);
  const windows = cropWindowsFor(canvasWidth, canvasHeight);
  if (!chrome && windows.length === 0) return null;
  let left = 0;
  let top = 0;
  let right = canvasWidth;
  let bottom = canvasHeight;
  if (chrome) {
    const scale = canvasWidth / FRAME_W;
    left = PLATFORM_CHROME_INSETS.left * scale;
    top = PLATFORM_CHROME_INSETS.top * scale;
    right = canvasWidth - PLATFORM_CHROME_INSETS.right * scale;
    bottom = canvasHeight - PLATFORM_CHROME_INSETS.bottom * scale;
  }
  for (const win of windows) {
    left = Math.max(left, win.x);
    top = Math.max(top, win.y);
    right = Math.min(right, win.x + win.width);
    bottom = Math.min(bottom, win.y + win.height);
  }
  const x = Math.ceil(left);
  const y = Math.ceil(top);
  return {
    x,
    y,
    width: Math.max(0, Math.floor(right) - x),
    height: Math.max(0, Math.floor(bottom) - y),
  };
};

/** The rule every agent surface carries: the MCP instructions, both assistant
 *  prompts, and describe_video's own note. They interpolate this constant
 *  rather than restating it, so no surface can drift from the others. */
export const PLATFORM_SAFE_AREA_GUIDANCE =
  "TikTok and Instagram Reels draw their own buttons, captions and tab bar " +
  "over the edges of a full-screen 9:16 video, and Instagram's feed crops " +
  "tall videos to 4:5. describe_video's platform_safe_area is the part of " +
  "the canvas that stays visible (null when nothing is covered or cropped). " +
  "Put text, captions, logos, buttons and other key content inside it; " +
  "backgrounds, footage and decoration can run to the canvas edge.";
