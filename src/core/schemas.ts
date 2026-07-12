import { z } from "zod";
import { SHAPE_IDS } from "./shapes.ts";
// Cross-tree import (same precedent as tools.ts): the font catalogues live in
// editor/src/ — the parser needs them to drop custom_fonts entries that
// duplicate a built-in family (see stripBuiltinCustomFonts). font-sources.ts
// imports only pure catalogue data, so no cycle.
import { getFontEntry } from "./font-sources.ts";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u, "expected #rrggbb");

// Optional per-layer "colour label" — a small swatch shown at the leftmost
// edge of the Inspector LayersList row, like Finder tags or DAW track
// colours. Pure UI metadata; the renderer ignores it. The eight values map
// to the 8-swatch picker in LayerContextMenu.
export const colorLabelSchema = z.enum([
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
]);
export type ColorLabel = z.infer<typeof colorLabelSchema>;

// One colour stop in a gradient fill. `pos` is the stop position along the
// gradient axis, 0..1. `opacity` is per-stop alpha (the stop's effective
// colour at paint time is colour blended with opacity). Multiple stops at
// the same `pos` are allowed and render as a hard step.
export const fillStopSchema = z
  .object({
    pos: z.number().min(0).max(1),
    color: hexColor,
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();

// A solid fill — used wherever a single colour was used pre-Fill. `opacity`
// is multiplied with any ambient globalAlpha at paint time so animation /
// layer opacity still composes.
export const solidFillSchema = z
  .object({
    type: z.literal("solid"),
    color: hexColor,
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();

// Linear gradient. `angle` follows CSS `linear-gradient(<deg>, ...)` semantics:
// 0° points UP (first stop at the bottom, last at the top), 90° points right,
// 180° points down. The gradient line crosses the centre of the fill rect
// and extends just far enough that the rect is fully covered at any angle.
export const linearGradientSchema = z
  .object({
    type: z.literal("linear"),
    stops: z.array(fillStopSchema).min(2),
    angle: z.number().default(180),
  })
  .strict();

// Radial gradient. `cx` / `cy` are fractions of the fill rect (0.5,0.5 =
// centre). `radius` is a fraction of half the rect's longer side — 1 reaches
// the farther edge midpoint, sqrt(2) ≈ 1.41 reaches the corner.
export const radialGradientSchema = z
  .object({
    type: z.literal("radial"),
    stops: z.array(fillStopSchema).min(2),
    cx: z.number().default(0.5),
    cy: z.number().default(0.5),
    radius: z.number().positive().default(1),
  })
  .strict();

// Mask fill — silhouettes a single colour through the alpha channel of an
// existing image layer. `layer_id` names the source image layer (e.g.
// "image.title"); the renderer reads that layer's already-decoded bitmap
// from the images map and uses its alpha as the mask, so `color` appears
// only where the masking image is opaque. Use case: brand-coloured logos
// that adopt a new tint without re-exporting the artwork, silhouette title
// cards over a video, swatch-driven recolours of stock art. Paints nothing
// when the named layer is missing or its bitmap hasn't decoded yet.
export const maskFillSchema = z
  .object({
    type: z.literal("mask"),
    layer_id: z.string().min(1),
    color: hexColor,
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();

// A paintable fill. Used as: canvas backdrop (palette.fill), shape body
// (shapes[].fill), optional image-layer backdrop (image_layers[].fill),
// optional video-layer backdrop (video_layers[].fill), and optional group
// backdrop (groups[].fill). Discriminator is `type`.
export const fillSchema = z.discriminatedUnion("type", [
  solidFillSchema,
  linearGradientSchema,
  radialGradientSchema,
  maskFillSchema,
]);

// Per-element data that formerly lived in four top-level maps keyed by element
// id (project.animations / styles / color_tracks / track_loops). It now lives
// ON each layer record so an element is self-contained: clones carry it intact
// and id-minting ops (paste / duplicate) no longer have to re-key parallel
// maps. `style` is the singular form of the old `styles[eid]` entry. z.lazy
// defers the value-schema references because those schemas (elementTracks /
// layerStyle / elementColorTracks / trackLoops) are declared further down this
// file than the layer schemas that spread these fields in.
const perElementDataFields = {
  animations: z.lazy(() => elementTracksSchema).optional(),
  style: z.lazy(() => layerStyleSchema).optional(),
  color_tracks: z.lazy(() => elementColorTracksSchema).optional(),
  track_loops: z.lazy(() => trackLoopsSchema).optional(),
  // When this element was inlined from an embedded morpha (see groupSchema's
  // `source_morpha_id`), this is its ORIGINAL element id in that source project
  // (e.g. "image.abc123"). Used to map host-side edits back onto the source on
  // publish. Absent on layers authored directly in the host project.
  source_layer_id: z.string().min(1).optional(),
  // Timeline BLOCK — the layer's on-timeline existence window. `start` is the
  // frame the layer begins, expressed in its PARENT's timeline (composition
  // frames for a root layer; band-local frames for a descendant of an embedded
  // morpha band). `duration` is how many frames it lasts. Two coupled effects,
  // both keyed on `start`:
  //   1. VISIBILITY — the layer is drawn only while the frame is inside
  //      [start, start+duration). (See frameOutsideBlock.)
  //   2. BLOCK-LOCAL TIME — the layer's own animation keyframes are sampled
  //      RELATIVE to `start` (at frame − start), so moving or trimming the
  //      block re-anchors its animation instead of leaving it behind. (See
  //      effectiveFrameOffset.)
  // For an embedded morpha band GROUP, `start` additionally serves as the
  // band's TIME ORIGIN: every descendant subtracts it too, so the band's whole
  // internal animation plays relative to where the band is placed.
  // ABSENT block ⇒ "always present" — a block spanning the whole composition
  // with keyframes sampled at absolute frames: exactly the legacy behavior. So
  // adding this field is backward-compatible (old projects lack it and are
  // unchanged), and migration only writes a block where it changes nothing
  // visible (a caption gate → block) or fixes a bug (a band's time origin).
  block: z
    .object({
      start: z.number().int().nonnegative(),
      duration: z.number().int().positive(),
    })
    .optional(),
};

// One per image layer on the project. (x, y) is the CENTRE of the layer's
// bounding box in canvas coords (1080×1920); width/height the box extents.
// Centre-anchor matches Premiere/FCP/Motion conventions and aligns with the
// renderer's transform pivot — scale + rotation always pivot at (x, y).
// Animations on the layer go under `image.<id>` in project.animations.
//
// The CANVAS BACKDROP is also represented here, as a regular image_layer
// with `pinned: true` + `is_background: true` + no filename. The renderer
// paints `is_background` layers across the full canvas regardless of
// x/y/width/height. Pinned layers are forced to the bottom of the root
// z-stack and refuse deletion / reorder from the UI + tools.
export const imageLayerSchema = z
  .object({
    ...perElementDataFields,
    id: z.string().min(1),
    // Optional for `is_background` (the canvas backdrop has no bitmap).
    // Worker / tool layer enforces non-empty for regular image layers.
    filename: z.string().min(1).optional(),
    // When this layer was inlined from an embedded morpha, its `filename`
    // resolves against THIS project's asset bucket instead of the host's.
    // Absent ⇒ resolve against the host project_id (the normal case).
    asset_project_id: z.string().min(1).optional(),
    // Optional friendly label shown in the Inspector + Timeline lane.
    // When unset/empty, callers fall back to the filename stem. Mirrors
    // groupSchema.name so renaming an image works the same way as a group.
    name: z.string().optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    rotation: z.number().default(0),
    // Normalized rotation / scale pivot in the layer's bbox: 0 = left/top edge,
    // 0.5 = centre (default), 1 = right/bottom edge. The Inspector picker
    // snaps to {0, 0.5, 1} × {0, 0.5, 1} (9 anchor cells); the schema accepts
    // any value in [0, 1] so agents can drive it freely.
    pivotX: z.number().min(0).max(1).default(0.5),
    pivotY: z.number().min(0).max(1).default(0.5),
    // Optional backdrop fill painted in the layer's local rect BEFORE the
    // image bitmap. Shows through any transparent PNG areas. Separate from
    // the existing `tintColor` overlay (which paints OVER opaque pixels).
    // null (default) = no backdrop. For `is_background` layers this is the
    // ONLY visual paint (the canvas backdrop).
    fill: fillSchema.nullable().default(null),
    // When true, the layer is non-deletable, non-reorderable, forced to the
    // bottom of the root z-stack regardless of `layer_order`. Used for the
    // canvas backdrop today.
    pinned: z.boolean().optional(),
    // When true, the layer is the canvas backdrop: rendered at
    // (0, 0, canvas_width, canvas_height) ignoring its own x/y/width/height,
    // with no bitmap loaded (filename is optional/empty). Only `fill` paints.
    is_background: z.boolean().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    matte_source_id: z.string().nullable().optional(),
    // When the layer is masked, invert the mask so the host shows everywhere
    // EXCEPT where the source is opaque — a knock-out / punch-through. Honored
    // on leaf hosts (the canvas matte path); ignored on group hosts for now.
    matte_inverted: z.boolean().optional(),
    // Optional Inspector colour-label tag.
    color_label: colorLabelSchema.optional(),
  })
  .strict();

// One per video layer on the project. Mirrors imageLayerSchema field-for-field:
// (x, y) is the CENTRE of the layer's bounding box; animations go under
// `video.<id>` in project.animations. `clip` is the relative filename under
// the project's clips bucket (`users/<userId>/clips/<projectId>/`), the same
// path image filenames take under the assets bucket.
export const videoLayerSchema = z
  .object({
    ...perElementDataFields,
    id: z.string().min(1),
    clip: z.string().min(1),
    // When this layer was inlined from an embedded morpha, its `clip`
    // resolves against THIS project's clips bucket instead of the host's.
    // Absent ⇒ resolve against the host project_id (the normal case).
    asset_project_id: z.string().min(1).optional(),
    name: z.string().optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    rotation: z.number().default(0),
    // See imageLayerSchema.pivotX/pivotY.
    pivotX: z.number().min(0).max(1).default(0.5),
    pivotY: z.number().min(0).max(1).default(0.5),
    // Source-time in-point: frame within the source mp4 where playback of
    // this slice begins. 0 = start of the source.
    source_in_frame: z.number().int().nonnegative().default(0),
    // Source-time out-point: frame within the source mp4 where playback of
    // this slice stops. null = play to the source's natural end. Resolved
    // against the loaded videoEl's duration via `videoWindow()`.
    source_out_frame: z.number().int().nonnegative().nullable().default(null),
    // Project-timeline frame where this slice begins playing.
    timeline_start_frame: z.number().int().nonnegative().default(0),
    // Optional backdrop fill painted behind the video pixels. Visible in
    // letterbox areas when fit=contain and as a fallback when the video
    // hasn't loaded. null (default) = legacy behaviour (black).
    fill: fillSchema.nullable().default(null),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    // When true, this layer's baked audio is silenced in preview AND export.
    // Set when the editor splits the clip's audio into a standalone overlay on
    // upload (NLE-style linked A/V), so the source audio doesn't double with
    // the new track. Absent/false = mix the baked audio as before.
    muted: z.boolean().optional(),
    matte_source_id: z.string().nullable().optional(),
    // When the layer is masked, invert the mask so the host shows everywhere
    // EXCEPT where the source is opaque — a knock-out / punch-through. Honored
    // on leaf hosts (the canvas matte path); ignored on group hosts for now.
    matte_inverted: z.boolean().optional(),
    speed_keyframes: z
      .array(
        z
          .object({
            frame: z.number().int().nonnegative(),
            rate: z.number().min(0.1).max(8),
          })
          .strict(),
      )
      .optional(),
    // Optional Inspector colour-label tag.
    color_label: colorLabelSchema.optional(),
  })
  .strict();
export type SpeedKeyframe = NonNullable<
  z.infer<typeof videoLayerSchema>["speed_keyframes"]
>[number];

// Text layers — a first-class layer type, distinct from image layers. Element
// ids are `text.<id>`; animations/styles/track-loops key off `text.<id>` and
// they sit in `layer_order` and group `children` exactly like any other leaf.
// The renderer draws live typeset text (multi-line, auto-fit to the box) into
// the same transformed box used for image layers, so a text layer animates
// identically to any other leaf. Looping is the general `track_loops`
// mechanism — there is no text-specific sequencing.
// A single decoration range: half-open [start, end) character offsets (UTF-16
// code units) into a text layer's `text`. `end > start`; the store/tools keep
// range lists normalized (sorted, merged, non-overlapping).
export const textDecorationRangeSchema = z
  .object({
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .strict();

// The two decoration kinds a text layer supports, each an independent set of
// ranges. Orthogonal: a character can be both underlined and struck.
export const textDecorationsSchema = z
  .object({
    underline: z.array(textDecorationRangeSchema).optional(),
    strikethrough: z.array(textDecorationRangeSchema).optional(),
  })
  .strict();

export type TextDecorationRange = z.infer<typeof textDecorationRangeSchema>;
export type TextDecorations = z.infer<typeof textDecorationsSchema>;

export const textLayerSchema = z
  .object({
    ...perElementDataFields,
    id: z.string().min(1),
    // The text to render. Newlines are honoured as hard line breaks.
    text: z.string().default(""),
    // Optional friendly label — the Inspector/Timeline name and the basis for
    // the layer's auto-derived <morpha-video> embed attribute.
    name: z.string().optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    rotation: z.number().default(0),
    // See imageLayerSchema.pivotX/pivotY.
    pivotX: z.number().min(0).max(1).default(0.5),
    pivotY: z.number().min(0).max(1).default(0.5),
    // Google Fonts family name (e.g. "Anton"). Loaded from the Google Fonts
    // CSS2 API before rendering — see editor/src/fonts.ts.
    font_family: z.string().default("Anton"),
    // Desired font size in px. Rendered VERBATIM by default (fixed size — the
    // size you set is the size that renders); shrunk to fit the box when
    // text_autofit is "shrink", ignored entirely when it is "fit" (the box
    // drives the size). Omitted ⇒ derived from the layer box height.
    text_size: z.number().positive().optional(),
    // How text fills its box. "wrap" (default): hold text_size FIXED and only
    // word-wrap (hard-breaking a single word too wide to fit), never shrink —
    // the size you set is the size rendered, every line the same height.
    // "fit": ignore text_size and auto-size the font BOTH ways — grow and
    // shrink — to the largest size whose wrapped block fills the box, so
    // resizing the box resizes the text. "shrink" (legacy): word-wrap, then
    // auto-shrink the font from text_size until the block fits — never grows.
    // Captions use "wrap" to stop size bounce. "hug": the inverse of "fit" —
    // hold text_size FIXED and DERIVE the box (width + height) from the
    // measured text plus style.padding, so the box shrink-wraps the content
    // and grows/shrinks live as the text changes. width/height become derived
    // (and ignored) in this mode; animate size via the scale track instead.
    text_autofit: z.enum(["fit", "shrink", "wrap", "hug"]).default("wrap"),
    // Text fill colour as #rrggbb. Defaults to white when omitted.
    text_color: z.string().optional(),
    // Optional backdrop fill painted in the layer's local rect behind the text.
    fill: fillSchema.nullable().default(null),
    // Multiplier on font size for line spacing. 1.0 = single, 1.4 = 140%.
    // Default 1.2 when omitted — matches today's hard-coded behaviour.
    line_height: z.number().positive().optional(),
    // Pixel tracking between glyphs. May be negative. Default 0.
    letter_spacing: z.number().optional(),
    // Curved baseline. Degrees of total arc the text bends onto: 0 = straight
    // (default). POSITIVE curves the text into a SMILE (⌣ — ends rise, middle
    // dips); NEGATIVE into an ARCH (⌒ — a rainbow). The magnitude is the total
    // sweep in degrees; the renderer clamps to ±135 (beyond that a single
    // title line self-crowds). Curve applies to a SINGLE visual line — while
    // curved, multi-line text is joined to one line for painting and the
    // stored `text` is left untouched (toggling curve back to 0 restores the
    // wrapping losslessly). Rendered on the canvas path only, so the DOM
    // preview matches the export by construction (curve !== 0 promotes the
    // layer to canvas-fallback in dom-render-mode.ts). < 2 glyphs = no-op.
    curve: z.number().default(0),
    // Horizontal alignment of each line within the layer's box. Default
    // "center" when omitted — matches today's renderer.
    text_align: z.enum(["left", "center", "right"]).optional(),
    // Vertical alignment of the text BLOCK within the box. "middle" (default,
    // matches today's renderer) centres it; "bottom" pins it to the box floor
    // so extra wrapped lines grow upward from a fixed baseline (captions use
    // this so a line that wraps doesn't shift the others); "top" pins the top.
    text_valign: z.enum(["top", "middle", "bottom"]).optional(),
    // Font weight 100..900 (Thin..Black). Default 400 when omitted; the
    // renderer also lets the canvas faux-synthesize weights a static font
    // doesn't ship.
    font_weight: z.number().int().min(100).max(900).optional(),
    // Italic toggle. Default "normal".
    font_style: z.enum(["normal", "italic"]).optional(),
    // Case transform applied before layout/measure. Default "none".
    text_transform: z.enum(["none", "uppercase", "lowercase"]).optional(),
    // Outline stroked UNDER the fill. stroke_width in px (0 / omitted = no
    // outline); stroke_color is #rrggbb (renderer defaults to white).
    stroke_width: z.number().min(0).optional(),
    stroke_color: hexColor.optional(),
    // First-class drop shadow for the text fill. `color` is any CSS colour
    // (rgba allowed for soft shadows). null / omitted ⇒ no shadow.
    text_shadow: z
      .object({
        offsetX: z.number(),
        offsetY: z.number(),
        blur: z.number().min(0),
        color: z.string(),
      })
      .nullable()
      .optional(),
    // Track matte: when set, this text layer (the host) shows only through
    // the referenced leaf's alpha. Mirrors image/video/shape layers.
    matte_source_id: z.string().nullable().optional(),
    // When the layer is masked, invert the mask so the host shows everywhere
    // EXCEPT where the source is opaque — a knock-out / punch-through. Honored
    // on leaf hosts (the canvas matte path); ignored on group hosts for now.
    matte_inverted: z.boolean().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    // Optional Inspector colour-label tag.
    color_label: colorLabelSchema.optional(),
    // Per-character text decorations layered on top of the flat `text` string.
    // Each list is a set of half-open character ranges [start, end) in UTF-16
    // code units into `text`, kept normalized (sorted, merged, non-overlapping).
    // Absent / empty ⇒ no decorations. Editing `text` rebases the offsets (see
    // rebaseDecorations in text-decorations.ts). Rendered natively via CSS
    // text-decoration in the DOM preview and mirrored with drawn rules on the
    // canvas export, so preview == export.
    decorations: textDecorationsSchema.optional(),
  })
  .strict();

export type TextLayer = z.infer<typeof textLayerSchema>;

// Curve (arc-baseline) bounds, shared by every write + render site so the
// renderer, the tool catalog, and the Inspector agree. `CURVE_MAX_DEG` is the
// legibility clamp — beyond ±135° a single title line starts to self-crowd.
// `CURVE_MIN_DEG` is the dead-band: below half a degree the arc is
// indistinguishable from straight, so we take the plain horizontal path (this
// also guards the `radius = width / θ` divide-by-zero as θ → 0).
export const CURVE_MAX_DEG = 135;
export const CURVE_MIN_DEG = 0.5;
export const clampCurve = (v: number): number =>
  !Number.isFinite(v) ? 0 : Math.max(-CURVE_MAX_DEG, Math.min(CURVE_MAX_DEG, v));
// True when a resolved curve value should actually bend the text (past the
// dead-band). Callers still AND this with a ">= 2 glyphs" check.
export const curveIsActive = (v: number | undefined | null): boolean =>
  Math.abs(clampCurve(v ?? 0)) >= CURVE_MIN_DEG;

// Resolve a video layer's playback window against the source's actual
// duration. `sourceDurationSeconds` comes from the loaded HTMLVideoElement
// (or, in headless contexts, the source mp4's probed duration). Returns
// project-frame [startFrame, endFrame) and the matching source-time
// [sourceInSeconds, sourceOutSeconds). Single source of truth for the
// renderer, preview, export, and timeline UI — every call site should
// route through this rather than re-deriving the math.
export const videoWindow = (
  layer: VideoLayer,
  sourceDurationSeconds: number,
): {
  startFrame: number;
  endFrame: number;
  sourceInSeconds: number;
  sourceOutSeconds: number;
  windowFrames: number;
} => {
  const FPS = 30;
  const sourceDurationFrames = Math.max(
    0,
    Math.floor(sourceDurationSeconds * FPS),
  );
  const inFrame = Math.max(
    0,
    Math.min(sourceDurationFrames, layer.source_in_frame),
  );
  const rawOut =
    layer.source_out_frame === null ? sourceDurationFrames : layer.source_out_frame;
  const outFrame = Math.max(
    inFrame,
    Math.min(sourceDurationFrames, rawOut),
  );
  const windowFrames = Math.max(0, outFrame - inFrame);
  const startFrame = Math.max(0, layer.timeline_start_frame);
  return {
    startFrame,
    endFrame: startFrame + windowFrames,
    sourceInSeconds: inFrame / FPS,
    sourceOutSeconds: outFrame / FPS,
    windowFrames,
  };
};

// Normalise a video layer's speed-ramp keyframes for evaluation: deduped on
// `frame`, sorted, clamped to the legal rate range [0.1, 8]. Returns an
// empty array when the layer has no speed_keyframes or the array is empty
// (the caller treats that as "constant rate 1, no remap needed").
export const resolveSpeedKeyframes = (
  layer: VideoLayer,
): Array<{ frame: number; rate: number }> => {
  const raw = layer.speed_keyframes ?? [];
  if (raw.length === 0) return [];
  const byFrame = new Map<number, number>();
  for (const kf of raw) {
    if (!Number.isFinite(kf.frame) || !Number.isFinite(kf.rate)) continue;
    const r = Math.max(0.1, Math.min(8, kf.rate));
    byFrame.set(Math.round(kf.frame), r);
  }
  const list = [...byFrame.entries()]
    .map(([frame, rate]) => ({ frame, rate }))
    .sort((a, b) => a.frame - b.frame);
  return list;
};

// Build a frame-indexed table `srcFrame[i]` of the source-frame the playback
// should be at when the project timeline is at `timeline_start_frame + i`.
// Implements the standard trapezoidal integration of the rate curve, with
// `hold` extrapolation before the first speed keyframe and after the last
// (rate clamped to the boundary's value). The first entry (`i = 0`) is
// pinned to `source_in_frame` so the trim's in-point stays exact.
//
// Length is bounded by `maxLength` (typically the layer's playback window in
// project-frames) so the renderer can hit any frame inside the window via a
// single table lookup. Callers that need a value past the table's tail
// re-apply the constant boundary rate themselves (`sourceFrameFor`).
export const buildSourceFrameTable = (
  layer: VideoLayer,
  maxLength: number,
): number[] => {
  const ramp = resolveSpeedKeyframes(layer);
  const out: number[] = [];
  if (maxLength <= 0) return out;
  const sourceIn = layer.source_in_frame ?? 0;
  if (ramp.length === 0) {
    // Constant rate 1: source advances 1:1 with the timeline.
    for (let i = 0; i < maxLength; i++) out.push(sourceIn + i);
    return out;
  }
  const tStart = layer.timeline_start_frame ?? 0;
  let acc = 0;
  for (let i = 0; i < maxLength; i++) {
    if (i === 0) {
      out.push(sourceIn);
      continue;
    }
    // Trapezoid: average of rate at timeline-frame (tStart + i - 1) and
    // (tStart + i), each evaluated by linear interpolation of the rate
    // curve with `hold` outside the first/last keyframe.
    const ra = rateAtTimelineFrame(ramp, tStart + i - 1);
    const rb = rateAtTimelineFrame(ramp, tStart + i);
    acc += (ra + rb) / 2;
    out.push(sourceIn + acc);
  }
  return out;
};

// Linear-interp the rate curve at a given timeline frame, with `hold`
// outside the first/last keyframe. Used by `buildSourceFrameTable`'s
// trapezoidal integrator and by `sourceFrameFor`'s extrapolation tail.
const rateAtTimelineFrame = (
  ramp: Array<{ frame: number; rate: number }>,
  timelineFrame: number,
): number => {
  if (ramp.length === 0) return 1;
  if (timelineFrame <= ramp[0].frame) return ramp[0].rate;
  if (timelineFrame >= ramp[ramp.length - 1].frame) {
    return ramp[ramp.length - 1].rate;
  }
  for (let i = 1; i < ramp.length; i++) {
    const a = ramp[i - 1];
    const b = ramp[i];
    if (timelineFrame <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.rate;
      const t = (timelineFrame - a.frame) / span;
      return a.rate + (b.rate - a.rate) * t;
    }
  }
  return ramp[ramp.length - 1].rate;
};

// Map a project-timeline frame to the source-frame for a given video layer,
// honouring `speed_keyframes` when present. `table` is the cached output of
// `buildSourceFrameTable(layer, …)`; supply null to fall back to the legacy
// 1:1 mapping (used when the layer has no speed keyframes, or the caller
// hasn't built a table). Returns a float source-frame; callers convert to
// seconds via `/ FPS` (or to an integer via Math.floor / round).
export const sourceFrameFor = (
  layer: VideoLayer,
  timelineFrame: number,
  table: number[] | null,
): number => {
  const tStart = layer.timeline_start_frame ?? 0;
  const idx = timelineFrame - tStart;
  if (idx < 0) return layer.source_in_frame ?? 0;
  if (!table || table.length === 0) {
    return (layer.source_in_frame ?? 0) + idx;
  }
  if (idx < table.length) return table[idx];
  // Past the table — constant-rate extrapolate from the last entry.
  const ramp = resolveSpeedKeyframes(layer);
  const tailRate = ramp.length > 0 ? ramp[ramp.length - 1].rate : 1;
  const last = table[table.length - 1];
  return last + (idx - (table.length - 1)) * tailRate;
};

// Inverse of `sourceFrameFor` for a moment in the clip's SOURCE timeline given
// in seconds (e.g. a transcript word's `start`): the PROJECT-timeline frame
// where that moment plays, honouring the layer's trim (`source_in_frame`) and
// placement (`timeline_start_frame`). Constant-rate — `speed_keyframes` are
// intentionally ignored here (transcript navigation targets talking-head clips
// that don't ramp; ramped-clip captions are a follow-up).
export const projectFrameForSourceSeconds = (
  layer: VideoLayer,
  seconds: number,
  fps = 30,
): number => {
  const sourceIn = layer.source_in_frame ?? 0;
  const tStart = layer.timeline_start_frame ?? 0;
  return Math.round(tStart + (seconds * fps - sourceIn));
};

// Whether a SOURCE-seconds moment falls inside the layer's trimmed window — i.e.
// it is actually visible on the project timeline. Words outside the window are
// in the transcript but trimmed off the clip, so the transcript surface shows
// them dimmed and non-seeking.
export const sourceSecondsInWindow = (
  layer: VideoLayer,
  seconds: number,
  fps = 30,
): boolean => {
  const sourceIn = layer.source_in_frame ?? 0;
  const sourceOut = layer.source_out_frame ?? null;
  const f = seconds * fps;
  if (f < sourceIn - 0.5) return false;
  if (sourceOut != null && f > sourceOut + 0.5) return false;
  return true;
};

// Shape primitives. The set is the data-driven shape registry in
// `./shapes.ts` — `SHAPE_IDS` is the readonly tuple of every registry id, so
// adding a shape there widens this enum automatically. `rect` is the historic
// default — older projects with no `kind` field parse as `rect` via
// `.default("rect")`. The renderer's `traceShapePath` looks the kind up in the
// same registry to pick the canvas path.
export const shapeKindSchema = z.enum(SHAPE_IDS).default("rect");

// (x, y) is the CENTRE of the shape's bounding box. See imageLayerSchema.
// `fill` is the shape body (solid colour or gradient). The legacy
// `color: "#rrggbb"` form is migrated to `fill: { type: "solid", color }`
// by `migrateColorsToFills` during preprocess.
export const shapeSchema = z
  .object({
    ...perElementDataFields,
    id: z.string().min(1),
    kind: shapeKindSchema,
    // Optional friendly label shown in the Inspector + Timeline lane.
    // When unset/empty, callers fall back to the shape's `kind`.
    name: z.string().optional(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    fill: fillSchema,
    rotation: z.number().default(0),
    // See imageLayerSchema.pivotX/pivotY.
    pivotX: z.number().min(0).max(1).default(0.5),
    pivotY: z.number().min(0).max(1).default(0.5),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    matte_source_id: z.string().nullable().optional(),
    // When the layer is masked, invert the mask so the host shows everywhere
    // EXCEPT where the source is opaque — a knock-out / punch-through. Honored
    // on leaf hosts (the canvas matte path); ignored on group hosts for now.
    matte_inverted: z.boolean().optional(),
    // Optional Inspector colour-label tag.
    color_label: colorLabelSchema.optional(),
    // Curve / arrow geometry (only used by kind "curve"). `points` are control
    // points as FRACTIONS of the bbox — a quadratic bezier [start, bend, end];
    // the renderer strokes through them instead of filling the kind's trace.
    // `stroke_width` is in px (the `fill` solid colour is used as the stroke).
    // `arrow_head` adds a triangular head at the end, or both ends.
    points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
    stroke_width: z.number().positive().optional(),
    arrow_head: z.enum(["none", "end", "both"]).optional(),
  })
  .strict();

export const easingSchema = z.enum([
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
  "outQuart",
  "outExpo",
  "outBack",
  "inBack",
  "inOutBack",
  "cubicBezier",
  // "hold" is a step-end function: the value sits at the PREVIOUS keyframe's
  // value across the whole interior of this segment, then jumps to this
  // keyframe's value exactly at this keyframe's frame. Matches AE / Premiere
  // / FCP "Hold" interpolation.
  "hold",
]);

export const keyframeSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    value: z.number(),
    easing: easingSchema.default("linear"),
    bezier: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .optional(),
  })
  .strict();

export const trackPropertySchema = z.enum([
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "scale",
  "rotation",
  // Text-only: the arc-baseline curve (degrees). Animating it bends a straight
  // line into a smile/arch over time. Inert on non-text layers (the renderer
  // only reads a curve track in drawTextLayer), mirroring how width/height
  // tracks are inert on groups.
  "curve",
]);

export const elementTracksSchema = z.partialRecord(
  trackPropertySchema,
  z.array(keyframeSchema),
);

export const animationsSchema = z.record(z.string(), elementTracksSchema);

// Track-level extrapolation mode. Determines what `evaluateTrack` returns
// past the last keyframe (and, symmetrically, before the first):
//   - "hold"      — current default. Holds the boundary keyframe's value
//                   forever. AE / Premiere "Hold" extrapolation.
//   - "loop"      — wraps the playhead frame into [firstKf.frame, lastKf.frame]
//                   so the animation cycles. Reference: AE "Loop Out / Cycle".
//   - "ping-pong" — same wrap but reverses direction on alternate cycles.
//                   Reference: AE "Loop Out / PingPong".
//   - "cycle"     — wraps like "loop" but offsets each cycle by
//                   (lastKf.value - firstKf.value), so a finite curve becomes
//                   an endless ramp. Reference: AE "Loop Out / Continue +
//                   Offset" (used for scrolling text, endless rotation).
export const loopModeSchema = z.enum(["hold", "loop", "ping-pong", "cycle"]);
export const trackLoopsSchema = z.partialRecord(
  trackPropertySchema,
  loopModeSchema,
);
export const projectLoopsSchema = z.record(z.string(), trackLoopsSchema);

export type LoopMode = z.infer<typeof loopModeSchema>;
export type TrackLoops = z.infer<typeof trackLoopsSchema>;

// Colour-valued keyframe. Same time + easing model as the numeric
// `keyframeSchema`; `value` is a full Fill (solid / linear / radial).
// Adjacent keyframes are interpolated stop-by-stop with position-union
// resampling (see `evaluateColorTrack` in src/animation.ts), so a
// 2-stop → 5-stop gradient still produces a continuous crossfade.
export const colorKeyframeSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    value: fillSchema,
    easing: easingSchema.default("linear"),
    bezier: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .optional(),
  })
  .strict();

// Color-track property keys. Mirrors `trackPropertySchema` but for Fill-
// valued tracks. Today there's exactly one: "fill" (the element's body or
// backdrop fill). Future colour-valued properties (border colour, tint
// colour) would land here so the timeline UI + tools find them in one place.
export const colorTrackPropertySchema = z.enum(["fill"]);

export const elementColorTracksSchema = z.partialRecord(
  colorTrackPropertySchema,
  z.array(colorKeyframeSchema),
);

// `project.color_tracks[elementId][property]` parallel to `animations`.
// Numeric `animations` keep their narrow type; Fill-valued tracks live here
// so every consumer that walks one map doesn't have to discriminate the
// keyframe value's runtime shape.
//
// Element id conventions mirror `animations`: leaf ids prefixed `video.` /
// `image.` / `shapes.` / `group.`, plus the project-level pseudo-id
// `"palette"` for the canvas backdrop fill track.
export const colorTracksSchema = z.record(z.string(), elementColorTracksSchema);

export type ColorKeyframe = z.infer<typeof colorKeyframeSchema>;
export type ColorTrackProperty = z.infer<typeof colorTrackPropertySchema>;
export type ElementColorTracks = z.infer<typeof elementColorTracksSchema>;
export type ColorTracks = z.infer<typeof colorTracksSchema>;

// How the source pixels (video frame, image bitmap) map into the layer's
// (width, height) box. Mirrors iMovie's Fit/Crop and Premiere's Scale-to-
// Frame-Size / Stretch options:
//   - cover   = fill the box, crop overflow, preserve aspect (iMovie "Crop")
//   - contain = fit the whole source inside the box, preserve aspect
//               (iMovie "Fit" / Premiere "Set to Frame Size")
//   - stretch = ignore aspect, scale to box (Premiere when source aspect is
//               manually overridden)
// Default in the renderer when unset: "cover" for video layers, "stretch" for
// image layers — videos behave like a TV screen by default; images stretch to
// their layer box because callers usually pre-size them in PNG export.
export const fitModeSchema = z.enum(["cover", "contain", "stretch"]);

// One stop of an alpha-mask gradient — `offset` is a position along the
// gradient line (0 at the line's start, 1 at the line's end) and `alpha`
// is the alpha multiplier applied to the image at that point.
export const maskGradientStopSchema = z
  .object({
    offset: z.number().min(0).max(1),
    alpha: z.number().min(0).max(1),
  })
  .strict();

// Linear alpha-mask gradient applied as a multiplicative alpha modulation
// on the rendered layer bitmap. Matches the gradient stop model in
// Figma / Photoshop / Sketch — an angle plus an ordered list of alpha
// stops along the gradient line. Used for the "sandwich" trick (a layer
// shown in front of the caption fading out across the layer), without
// requiring a separately-uploaded cropped asset.
//
// `angle` is in degrees, CSS-style: 0 = bottom→top, 90 = left→right,
// 180 = top→bottom, 270 = right→left. The angle determines which way the
// gradient line points across the layer's bounding box.
// `stops` is sorted by offset; min 2 stops.
export const maskGradientSchema = z
  .object({
    type: z.literal("linear").default("linear"),
    angle: z.number().default(180),
    stops: z.array(maskGradientStopSchema).min(2),
  })
  .strict();

export const layerStyleSchema = z
  .object({
    borderRadius: z.number().nonnegative().optional(),
    borderWidth: z.number().nonnegative().optional(),
    borderColor: hexColor.optional(),
    // Where the border sits relative to the layer's edge — a design-tool "border
    // position". "inner" (default, and how every legacy project renders) draws
    // the whole band INSIDE the box, so it eats into the content; "outer" draws
    // it entirely OUTSIDE the box, framing the content without covering it;
    // "center" straddles the edge 50/50. Honoured by rectangular boxes (image /
    // video / text) in both preview and export. Shapes always stroke centred on
    // their silhouette (SVG has no stroke-alignment), so they ignore this.
    borderAlign: z.enum(["inner", "center", "outer"]).optional(),
    boxShadow: z.string().optional(),
    // Uniform inset (canvas-stage px) between the box edge and the text.
    // Honoured by TEXT layers only — it sets the breathing room around the
    // glyphs for the background box and, in "hug" autofit, the amount the
    // derived box extends past the measured text. Other layer kinds ignore it.
    // When unset, text falls back to the legacy 4% / 0.92 inset.
    padding: z.number().nonnegative().optional(),
    fit: fitModeSchema.optional(),
    // Object-position for cover/contain fit modes. 0..1 along each axis;
    // (0.5, 0.5) = centre (default when unset). For cover, this picks which
    // slice of the source survives cropping (0,0 = keep top-left, crop the
    // bottom + right). For contain, it positions the letterboxed source
    // inside the destination box (0,0 = align top-left, empty space on right
    // + bottom). Ignored when fit is "stretch".
    anchorX: z.number().min(0).max(1).optional(),
    anchorY: z.number().min(0).max(1).optional(),
    // Optional tint overlay for image layers. tintColor is the hex tint;
    // tintStrength (0..1) blends from "no tint" (0) to "fully tinted —
    // image silhouette filled with tintColor" (1). Painted with
    // source-atop so only opaque pixels are coloured. tintStrength alone
    // (no color) and tintColor alone (no strength) both render as no-op.
    tintColor: hexColor.optional(),
    tintStrength: z.number().min(0).max(1).optional(),
    // Optional alpha-mask gradient — fades the layer's alpha along a
    // gradient line. See maskGradientSchema.
    alphaMask: maskGradientSchema.optional(),
    // Mirror flags. Applied in `applyTransform` to flip layer CONTENT around
    // the layer's centre without affecting the selection bbox.
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    // CSS-style filter effects applied via `ctx.filter`. All optional;
    // missing → no-op. `blur` in canvas px; brightness/contrast/saturation
    // are multipliers (1.0 = unchanged); hueRotate in degrees.
    blur: z.number().min(0).max(100).optional(),
    brightness: z.number().min(0).max(3).optional(),
    contrast: z.number().min(0).max(3).optional(),
    saturation: z.number().min(0).max(3).optional(),
    hueRotate: z.number().min(-360).max(360).optional(),
    // Photoshop-style layer blend mode. Maps to Canvas's
    // globalCompositeOperation at render time ("normal" → "source-over").
    // Applies to every layer kind (image / video / shape / text / group).
    blend_mode: z
      .enum([
        "normal",
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "color-dodge",
        "color-burn",
        "hard-light",
        "soft-light",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
      ])
      .optional(),
    // Chroma key (green-screen removal) for video / image layers. `color` is
    // the key colour (#rrggbb, default green). `similarity` (0..1) widens the
    // matched colour range; `smoothness` (0..1) softens the alpha falloff at
    // the edge. Pixels close to `color` are made transparent at render time.
    chroma_key: z
      .object({
        color: hexColor.default("#00ff00"),
        similarity: z.number().min(0).max(1).default(0.4),
        smoothness: z.number().min(0).max(1).default(0.1),
      })
      .optional(),
  })
  .strict();

export type ChromaKey = NonNullable<
  z.infer<typeof layerStyleSchema>["chroma_key"]
>;
export type MaskGradient = z.infer<typeof maskGradientSchema>;
export type MaskGradientStop = z.infer<typeof maskGradientStopSchema>;
export type BlendMode = NonNullable<
  z.infer<typeof layerStyleSchema>["blend_mode"]
>;

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const satisfies ReadonlyArray<BlendMode>;

export const stylesSchema = z.record(z.string(), layerStyleSchema);

// One per audio overlay on the project. Plays a decoded audio buffer at a
// frame-aligned start with optional linear fades. `endFrame` is optional —
// when omitted the overlay plays the source asset's full natural length.
// Filename references an asset in the project's R2 prefix (same bucket
// images live in). 30 fps; convert seconds with frames = round(s * 30).
//
// `filename` is ALWAYS the original audio. When the AI denoiser cleaned the
// clip on import it stores the cleaned MP3 as a second asset in
// `denoisedFilename`; `useDenoised` picks which one plays (absent/true ⇒
// cleaned). Both are resolved through `activeOverlayFilename` — the single
// source of truth so preview, export, and the timeline waveform never drift.
export const audioOverlaySchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    gain: z.number().min(0).max(2).default(1),
    fadeInFrames: z.number().int().nonnegative().default(0),
    fadeOutFrames: z.number().int().nonnegative().default(0),
    endFrame: z.number().int().nonnegative().optional(),
    muted: z.boolean().optional(),
    soloed: z.boolean().optional(),
    denoisedFilename: z.string().min(1).optional(),
    useDenoised: z.boolean().optional(),
  })
  .strict();

export type AudioOverlay = z.infer<typeof audioOverlaySchema>;

// The audio asset an overlay plays right now: the cleaned track when one
// exists and the user hasn't flipped it back (absent/true ⇒ cleaned), else
// the original. Legacy overlays (no `denoisedFilename`) resolve to `filename`.
export const activeOverlayFilename = (o: AudioOverlay): string =>
  o.denoisedFilename && o.useDenoised !== false ? o.denoisedFilename : o.filename;

// A layer group. Holds an ordered list of children — each child is the
// element id of an image layer ("image.<id>"), shape ("shapes.<id>"), or
// another group ("group.<id>"). Groups can nest arbitrarily.
//
// pivotX / pivotY are the rotate/scale pivot in canvas coords; defaulted to
// the children's bounding-box centre at create time and then frozen so a
// later child move/animation doesn't silently swing the pivot. The group
// itself has no body, no styles, no border — it exists purely to compose a
// transform onto its descendants. Animations under "group.<id>" use the same
// five tracks as a leaf (x, y, scale, rotation, opacity).
//
// x / y / scale / rotation are the group's STATIC BASE transform, composed
// about (pivotX, pivotY) exactly like a leaf's base: T(pivot + x, y) · R(rot)
// · S(scale) · T(-pivot). Resizing/rotating a non-animated group writes this
// base (no keyframes); a keyframe track under "group.<id>" overrides the base
// for that property when present. Defaults are identity (0, 0, 1, 0), so a
// freshly created group and any pre-base project both compose to identity.
export const groupSchema = z
  .object({
    ...perElementDataFields,
    id: z.string().min(1),
    name: z.string().default(""),
    pivotX: z.number(),
    pivotY: z.number(),
    // Static base transform, composed about (pivotX, pivotY). Overridden
    // per-property by any keyframe track under "group.<id>".
    x: z.number().default(0),
    y: z.number().default(0),
    scale: z.number().default(1),
    rotation: z.number().default(0),
    children: z.array(z.string()).default([]),
    // Optional backdrop fill painted behind the group's children. The rect is
    // centred on (pivotX, pivotY) in group-local space and sized by
    // (box_width, box_height); it transforms with the group (rotate/scale/
    // translate from x/y tracks). null (default) or zero box = no backdrop.
    fill: fillSchema.nullable().default(null),
    box_width: z.number().nonnegative().default(0),
    box_height: z.number().nonnegative().default(0),
    // Track matte — same primitive as a leaf layer's `matte_source_id`: the
    // group's composited children are shown only where the named source layer
    // (a shapes/image/video leaf) is opaque. A group is a layer of sorts, so
    // anything a leaf can host, it can too. Used e.g. to show a marching
    // chevron strip + black backing only inside an arrow / band shape.
    matte_source_id: z.string().nullable().optional(),
    // When the layer is masked, invert the mask so the host shows everywhere
    // EXCEPT where the source is opaque — a knock-out / punch-through. Honored
    // on leaf hosts (the canvas matte path); ignored on group hosts for now.
    matte_inverted: z.boolean().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    // Optional Inspector colour-label tag.
    color_label: colorLabelSchema.optional(),
    // ── Embedded-morpha provenance ──────────────────────────────────────────
    // When set, this group is an EMBEDDED MORPHA: its children are inlined,
    // re-keyed copies of another project's ("a morpha") layers, pinned to one
    // immutable version of that project. The group is otherwise an ordinary
    // group (it composites its children natively), so the renderer/export need
    // no special-casing — only the Inspector + tools read these fields.
    //   source_morpha_id     — the embedded project's id (NEVER shown to users).
    //   source_version_id     — the pinned version's opaque id.
    //   source_version_label  — the user-facing version label (e.g. "v3").
    //   source_morpha_name    — cached name of the source project for display
    //                           (the only user-facing handle; ids stay hidden).
    source_morpha_id: z.string().min(1).optional(),
    source_version_id: z.string().min(1).optional(),
    source_version_label: z.string().min(1).optional(),
    source_morpha_name: z.string().optional(),
  })
  .strict();
export type Group = z.infer<typeof groupSchema>;

// True when this group is an embedded morpha (carries a pinned source project).
// The single source of truth for "is this the band" across the Inspector,
// tools, and publish-back logic.
export const isMorphaGroup = (group: Group): boolean =>
  typeof group.source_morpha_id === "string" && group.source_morpha_id.length > 0;

// Schema version. Bumped when on-disk JSON gains a meaning that older
// readers can't infer:
//   1 = post-rev1-migration shape with top-left anchored x/y (legacy).
//   2 = current. (x, y) on image_layers / shapes / clip_inset is the
//       CENTRE of the bounding box. migrateProject converts < 2 → 2.
export const SCHEMA_VERSION = 2 as const;

// Strip deprecated clip_frame fields from raw input before validation. The
// pre-refactor schema modelled the source video as a built-in singleton
// "clip_frame" layer with its viewport in `layout.clip_inset` and its
// animations/styles keyed by the literal string "clip_frame". The new model
// represents source videos as ordinary `video_layers[]`, so the legacy fields
// are dropped here. The worker's project GET route is responsible for the
// data-side migration (populating video_layers from the legacy shortlist);
// this preprocess just keeps the parser tolerant of any leftovers.
const stripLegacyClipFrame = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const next = { ...(raw as Record<string, unknown>) };
  if (next.layout && typeof next.layout === "object") {
    const layoutNext = { ...(next.layout as Record<string, unknown>) };
    delete layoutNext.clip_inset;
    if (Object.keys(layoutNext).length === 0) delete next.layout;
    else next.layout = layoutNext;
  }
  if (next.animations && typeof next.animations === "object") {
    const anim = { ...(next.animations as Record<string, unknown>) };
    delete anim.clip_frame;
    next.animations = anim;
  }
  if (next.styles && typeof next.styles === "object") {
    const styles = { ...(next.styles as Record<string, unknown>) };
    delete styles.clip_frame;
    next.styles = styles;
  }
  if (Array.isArray(next.layer_order)) {
    next.layer_order = (next.layer_order as unknown[]).filter(
      (id) => id !== "clip_frame",
    );
  }
  return next;
};

// Strip the deprecated `carousel.aspect` field. Carousel pages used to be
// locked to a 3-value aspect enum; they now share the project's own
// `canvas_width`/`canvas_height`. `carouselSchema` is `.strict()`, so a leftover
// `aspect` key on an already-saved carousel would fail to parse — drop it here.
const stripLegacyCarouselAspect = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!r.carousel || typeof r.carousel !== "object") return raw;
  const carousel = { ...(r.carousel as Record<string, unknown>) };
  if (!("aspect" in carousel)) return raw;
  delete carousel.aspect;
  return { ...r, carousel };
};

// Drop custom_fonts entries that duplicate a built-in catalogue family.
// custom_fonts is only for typefaces Morpha does not ship: a stray entry for a
// catalogue family (e.g. an agent registering "Fredoka" against a CDN URL)
// shadows the reliable built-in loader, so the family loads only through the
// fragile FontFace path and paints as a system fallback. set_custom_font
// rejects such writes going forward; this preprocess heals projects that
// already carry them (the worker's project GET persists the healed shape for
// owners, mirroring the legacy-translate migration).
const stripBuiltinCustomFonts = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.custom_fonts) || r.custom_fonts.length === 0) return raw;
  const kept = (r.custom_fonts as unknown[]).filter((f) => {
    if (!f || typeof f !== "object") return true;
    const family = (f as { family?: unknown }).family;
    return typeof family !== "string" || getFontEntry(family) === null;
  });
  if (kept.length === r.custom_fonts.length) return raw;
  return { ...r, custom_fonts: kept };
};

// Convert legacy `translateX` / `translateY` keyframe tracks to absolute
// `x` / `y` keyframes by adding the layer's base x/y. Convert `rotation`
// keyframes (which were additive offsets from the layer's base rotation)
// to absolute angles by adding the base rotation. Group entries have no
// base — their translate keyframes were already absolute, so they're
// renamed without offset; group rotation was never additive either.
//
// Lossless and value-preserving: a project rendered with the old base+offset
// renderer and the post-migration project rendered with the new "track wins
// over base when present" renderer produce identical frames.
const migrateTranslateToAbsolute = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const animations = r.animations;
  if (!animations || typeof animations !== "object") return r;

  const baseByEid = new Map<
    string,
    { x: number; y: number; rotation: number }
  >();
  const collect = (kind: string, list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const l = raw as Record<string, unknown>;
      if (typeof l.id !== "string") continue;
      baseByEid.set(`${kind}.${l.id}`, {
        x: typeof l.x === "number" ? l.x : 0,
        y: typeof l.y === "number" ? l.y : 0,
        rotation: typeof l.rotation === "number" ? l.rotation : 0,
      });
    }
  };
  collect("image", r.image_layers);
  collect("video", r.video_layers);
  collect("shapes", r.shapes);

  type LegacyTracks = Record<
    string,
    Array<{ frame: number; value: number; easing?: unknown; bezier?: unknown }>
  >;
  // Detect "is this a legacy project" by sniffing the WHOLE animations map
  // for any `translateX` / `translateY` track. The conversion is idempotent
  // for x/y (it gates on the legacy track being present), but rotation needs
  // a project-wide signal: in the new shape rotation values are absolute, so
  // re-applying the base-rotation offset on every load would compound. We
  // run the rotation conversion only when the project still carries legacy
  // translate tracks.
  let isLegacy = false;
  for (const tracksRaw of Object.values(
    animations as Record<string, unknown>,
  )) {
    if (!tracksRaw || typeof tracksRaw !== "object") continue;
    const t = tracksRaw as Record<string, unknown>;
    if (t.translateX !== undefined || t.translateY !== undefined) {
      isLegacy = true;
      break;
    }
  }

  for (const [eid, tracksRaw] of Object.entries(
    animations as Record<string, unknown>,
  )) {
    if (!tracksRaw || typeof tracksRaw !== "object") continue;
    const tracks = tracksRaw as LegacyTracks;
    const isGroup = eid.startsWith("group.");
    const base = isGroup ? null : (baseByEid.get(eid) ?? null);

    if (Array.isArray(tracks.translateX) && !tracks.x) {
      const offset = base?.x ?? 0;
      tracks.x = tracks.translateX.map((kf) => ({
        ...kf,
        value: offset + kf.value,
      }));
    }
    if (Array.isArray(tracks.translateY) && !tracks.y) {
      const offset = base?.y ?? 0;
      tracks.y = tracks.translateY.map((kf) => ({
        ...kf,
        value: offset + kf.value,
      }));
    }
    if (isLegacy && Array.isArray(tracks.rotation) && base) {
      const offset = base.rotation;
      if (offset !== 0) {
        tracks.rotation = tracks.rotation.map((kf) => ({
          ...kf,
          value: offset + kf.value,
        }));
      }
    }
    delete tracks.translateX;
    delete tracks.translateY;
  }
  return r;
};

// Convert legacy single-hex shape colour to the Fill discriminated union.
// Pre-Fill, a shape's body was `shapes[i].color = "#rrggbb"`; it moves to
// `shapes[i].fill = { type: "solid", color, opacity: 1 }`. Idempotent —
// re-running on a post-migration project is a no-op.
const migrateShapeColorsToFills = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(r.shapes)) {
    r.shapes = (r.shapes as unknown[]).map((shape) => {
      if (!shape || typeof shape !== "object" || Array.isArray(shape)) return shape;
      const s = { ...(shape as Record<string, unknown>) };
      if (typeof s.color === "string" && s.fill === undefined) {
        s.fill = { type: "solid", color: s.color, opacity: 1 };
      }
      delete s.color;
      return s;
    });
  }
  return r;
};

// Unified canvas-background migration. The canvas backdrop is no longer a
// sentinel `project.background` field; it's a regular `image_layers[]`
// entry with `pinned: true` + `is_background: true`. This collapses every
// historical shape into the new model in one step, idempotently:
//
//   1. Pre-Fill:        palette.background = "#rrggbb"
//   2. Mid-Fill:        palette = { fill: <Fill> }
//   3. Pre-this-refactor: background = { id: "canvas", name?, fill: <Fill> }
//   4. Already-migrated: image_layers[] contains a pinned is_background
//                       layer — leave untouched.
//
// All cases produce a single pinned image_layer at the FRONT of
// image_layers[] (so the layer tree's root resolution can promote it to the
// bottom of the z-stack), id "background", with the resolved fill. The
// migration also rekeys any colour-track keys "palette" or
// "background.canvas" to "image.<bgId>" so animations on the backdrop keep
// firing after the rename.
const migrateBackgroundToImageLayer = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };

  const imageLayers = Array.isArray(r.image_layers)
    ? [...(r.image_layers as unknown[])]
    : [];

  // 4. Idempotency: if a pinned is_background layer already exists, do
  // nothing destructive — just normalise the `palette` / `background` /
  // colour-track keys away.
  const findBgIdx = (list: unknown[]): number =>
    list.findIndex(
      (l) =>
        l != null &&
        typeof l === "object" &&
        (l as { is_background?: unknown }).is_background === true,
    );
  let bgIdx = findBgIdx(imageLayers);
  let bgId: string = "background";

  if (bgIdx < 0) {
    // Discover the fill + optional name from legacy shapes in priority order.
    let resolvedFill: unknown = null;
    let resolvedName: string | undefined;

    // 3. background: { id, name?, fill }
    if (
      r.background &&
      typeof r.background === "object" &&
      !Array.isArray(r.background) &&
      "fill" in (r.background as object)
    ) {
      const bg = r.background as { fill?: unknown; name?: unknown };
      resolvedFill = bg.fill;
      if (typeof bg.name === "string" && bg.name.length > 0) {
        resolvedName = bg.name;
      }
    }

    // 2. palette: { fill }
    if (
      resolvedFill === null &&
      r.palette &&
      typeof r.palette === "object" &&
      !Array.isArray(r.palette) &&
      "fill" in (r.palette as object)
    ) {
      resolvedFill = (r.palette as { fill: unknown }).fill;
    }

    // 1. palette: { background: "#rrggbb" }
    if (
      resolvedFill === null &&
      r.palette &&
      typeof r.palette === "object" &&
      !Array.isArray(r.palette)
    ) {
      const p = r.palette as { background?: unknown };
      if (typeof p.background === "string") {
        resolvedFill = { type: "solid", color: p.background, opacity: 1 };
      }
    }

    // No legacy fill found at all — seed a sensible black backdrop so the
    // resulting project is always renderable.
    if (resolvedFill === null) {
      resolvedFill = { type: "solid", color: "#000000", opacity: 1 };
    }

    // Dedup the new id against any pre-existing image_layers ids — collide
    // only in pathological cases, but a "background" image layer in the
    // wild from a hand-edit would clash without this.
    const existingIds = new Set(
      imageLayers
        .filter(
          (l): l is Record<string, unknown> =>
            l != null && typeof l === "object" && !Array.isArray(l),
        )
        .map((l) => (typeof l.id === "string" ? l.id : "")),
    );
    let candidate = "background";
    let n = 2;
    while (existingIds.has(candidate)) {
      candidate = `background-${n++}`;
    }
    bgId = candidate;

    const bgLayer: Record<string, unknown> = {
      id: bgId,
      // Geometry is ignored by the renderer for is_background layers, but
      // the schema still requires it. Seed with the canonical canvas.
      x: 540,
      y: 960,
      width: 1080,
      height: 1920,
      rotation: 0,
      fill: resolvedFill,
      pinned: true,
      is_background: true,
    };
    if (resolvedName !== undefined) bgLayer.name = resolvedName;

    imageLayers.unshift(bgLayer);
    bgIdx = 0;
  } else {
    const existing = imageLayers[bgIdx] as Record<string, unknown>;
    if (typeof existing.id === "string") bgId = existing.id;
  }
  r.image_layers = imageLayers;

  // The new schema doesn't have these fields any more.
  delete r.palette;
  delete r.background;

  // Rekey colour tracks: legacy "palette" and "background.canvas" → the new
  // element id "image.<bgId>". If both exist (pathological), the later wins
  // (background.canvas, since it's the more recent shape).
  if (
    r.color_tracks &&
    typeof r.color_tracks === "object" &&
    !Array.isArray(r.color_tracks)
  ) {
    const ct = { ...(r.color_tracks as Record<string, unknown>) };
    const target = `image.${bgId}`;
    if (ct["palette"] !== undefined && ct[target] === undefined) {
      ct[target] = ct["palette"];
    }
    delete ct["palette"];
    if (ct["background.canvas"] !== undefined) {
      // Only overwrite the target when the explicit one is present — the
      // explicit one is the more-recent shape and supersedes "palette".
      ct[target] = ct["background.canvas"];
      delete ct["background.canvas"];
    }
    r.color_tracks = ct;
  }

  // Rekey animations: same rule, in case someone wrote a track under
  // "background.canvas" (no animatable numeric properties on the backdrop
  // today, but be tolerant).
  if (
    r.animations &&
    typeof r.animations === "object" &&
    !Array.isArray(r.animations)
  ) {
    const a = { ...(r.animations as Record<string, unknown>) };
    const target = `image.${bgId}`;
    if (a["background.canvas"] !== undefined && a[target] === undefined) {
      a[target] = a["background.canvas"];
    }
    delete a["background.canvas"];
    r.animations = a;
  }

  // Rekey layer_order: legacy "background.canvas" entries are dropped
  // entirely. The pinned layer doesn't participate in layer_order — the
  // tree resolver places it at the bottom of root order independently.
  if (Array.isArray(r.layer_order)) {
    r.layer_order = (r.layer_order as unknown[]).filter(
      (id) => id !== "background.canvas",
    );
  }

  return r;
};

// Text-only fields a legacy image_layer could carry back when an image could
// double as a text layer. They are no longer part of the strict
// imageLayerSchema, so any image that still has them must be migrated (moved to
// a text layer when it actually held text, or stripped when it doesn't) before
// strict validation runs.
const LEGACY_IMAGE_TEXT_FIELDS = [
  "text",
  "text_size",
  "font_family",
  "text_color",
  "line_height",
  "letter_spacing",
  "text_align",
  "line_beat_frames",
  "spans",
] as const;

// Older projects modelled a text layer as an image_layer carrying a `text`
// field (the pre-text_layers design). Two jobs, both required now that the
// image schema no longer accepts any text field:
//   1. Each image with non-empty `text` MOVES into text_layers (rekeying every
//      "image.<id>" reference to "text.<id>" across layer_order, animations,
//      styles, color_tracks, track_loops, and group children).
//   2. Any image KEPT as a bitmap that still carries stray text-only fields
//      (an empty `text`, a leftover `font_family`, …) gets those fields
//      STRIPPED — otherwise the strict imageLayerSchema rejects the project.
// Idempotent — an image_layers array with no legacy text fields passes through
// untouched.
const migrateImageTextLayers = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.image_layers)) return raw;

  const rekey = new Map<string, string>();
  const movedTextLayers: Record<string, unknown>[] = [];
  const keptImages: unknown[] = [];
  let strippedAny = false;

  for (const entry of p.image_layers) {
    const isObj =
      entry && typeof entry === "object" && !Array.isArray(entry);
    const l = isObj ? (entry as Record<string, unknown>) : null;
    if (l && typeof l.text === "string" && l.text.length > 0) {
      const id = String(l.id);
      rekey.set(`image.${id}`, `text.${id}`);
      const tl: Record<string, unknown> = {
        id,
        text: l.text,
        x: l.x,
        y: l.y,
        width: l.width,
        height: l.height,
      };
      if (l.name !== undefined) tl.name = l.name;
      if (l.rotation !== undefined) tl.rotation = l.rotation;
      if (l.font_family !== undefined) tl.font_family = l.font_family;
      if (l.text_size !== undefined) tl.text_size = l.text_size;
      if (l.text_color !== undefined) tl.text_color = l.text_color;
      if (l.line_height !== undefined) tl.line_height = l.line_height;
      if (l.letter_spacing !== undefined) tl.letter_spacing = l.letter_spacing;
      if (l.text_align !== undefined) tl.text_align = l.text_align;
      if (l.fill !== undefined) tl.fill = l.fill;
      // `line_beat_frames` (obsolete line-sequencing hack — looping is the
      // general track_loops mechanism) and `spans` (text_layers carry no
      // per-character spans) are intentionally dropped.
      movedTextLayers.push(tl);
    } else if (l && LEGACY_IMAGE_TEXT_FIELDS.some((f) => f in l)) {
      const stripped = { ...l };
      for (const f of LEGACY_IMAGE_TEXT_FIELDS) delete stripped[f];
      keptImages.push(stripped);
      strippedAny = true;
    } else {
      keptImages.push(entry);
    }
  }

  if (rekey.size === 0 && !strippedAny) return raw;

  const next: Record<string, unknown> = { ...p };
  next.image_layers = keptImages;

  if (rekey.size > 0) {
    const remapId = (id: unknown): unknown =>
      typeof id === "string" && rekey.has(id) ? rekey.get(id)! : id;

    next.text_layers = [
      ...(Array.isArray(p.text_layers) ? p.text_layers : []),
      ...movedTextLayers,
    ];

    if (Array.isArray(p.layer_order)) {
      next.layer_order = p.layer_order.map(remapId);
    }
    for (const field of [
      "animations",
      "styles",
      "color_tracks",
      "track_loops",
    ]) {
      const rec = p[field];
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
          out[rekey.has(k) ? rekey.get(k)! : k] = v;
        }
        next[field] = out;
      }
    }
    if (Array.isArray(p.groups)) {
      next.groups = p.groups.map((g) => {
        if (g && typeof g === "object" && !Array.isArray(g)) {
          const gr = g as Record<string, unknown>;
          if (Array.isArray(gr.children)) {
            return { ...gr, children: gr.children.map(remapId) };
          }
        }
        return g;
      });
    }
  }
  return next;
};

// Flatten the four legacy top-level per-element maps (animations / styles /
// color_tracks / track_loops, keyed by element id) ONTO each layer record as
// nested `animations` / `style` / `color_tracks` / `track_loops` fields, then
// drop the top-level maps. Runs OUTERMOST in the preprocess chain so the
// earlier migrators (which still rekey the top-level maps by element id — e.g.
// background→image, image→text) have finished settling those maps before we
// distribute them onto records. Orphan entries (no matching layer) are dropped.
// Idempotent: an already-flattened project has no top-level maps, so this
// no-ops. Non-destructive: clones the layer arrays it touches rather than
// mutating the caller's input.
const migrateFlattenPerElementMaps = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (
    !isObj(r.animations) &&
    !isObj(r.styles) &&
    !isObj(r.color_tracks) &&
    !isObj(r.track_loops)
  ) {
    return raw; // already flattened (or never had the maps)
  }

  const next = { ...r };
  // Clone the layer arrays (shallow per-layer) so attaching nested fields
  // doesn't mutate the caller's objects, then index every layer by element id.
  const byEid = new Map<string, Record<string, unknown>>();
  const cloneAndIndex = (kind: string, key: string): void => {
    const list = next[key];
    if (!Array.isArray(list)) return;
    const cloned = list.map((entry) =>
      isObj(entry) ? { ...entry } : entry,
    );
    next[key] = cloned;
    for (const entry of cloned) {
      if (isObj(entry) && typeof entry.id === "string") {
        byEid.set(`${kind}.${entry.id}`, entry);
      }
    }
  };
  cloneAndIndex("image", "image_layers");
  cloneAndIndex("video", "video_layers");
  cloneAndIndex("text", "text_layers");
  cloneAndIndex("shapes", "shapes");
  cloneAndIndex("group", "groups");

  const distribute = (map: unknown, field: string): void => {
    if (!isObj(map)) return;
    for (const [eid, value] of Object.entries(map)) {
      const layer = byEid.get(eid);
      // Only attach non-empty entries; orphans (no layer) are dropped.
      if (layer && isObj(value) && Object.keys(value).length > 0) {
        layer[field] = value;
      }
    }
  };
  distribute(r.animations, "animations");
  distribute(r.styles, "style"); // styles[eid] → layer.style (singular)
  distribute(r.color_tracks, "color_tracks");
  distribute(r.track_loops, "track_loops");

  delete next.animations;
  delete next.styles;
  delete next.color_tracks;
  delete next.track_loops;
  return next;
};

// Migrate the short-lived group-level `shared` flag (the first "Blocks"
// release, v1.0.52) into the project-level `collection` id-list. A group with
// `shared:true` becomes a "group.<id>" entry in `collection`; the flag is then
// stripped from EVERY group so the strict groupSchema (which no longer declares
// `shared`) parses. `collection` is the canonical store now — it holds any
// element id, not just groups. Idempotent (a project with no `shared` keys is
// returned untouched) and non-destructive (clones the groups it rewrites).
const migrateSharedGroupsToCollection = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.groups)) return raw;
  let touched = false;
  const collected: string[] = [];
  const groups = r.groups.map((g) => {
    if (!g || typeof g !== "object" || Array.isArray(g)) return g;
    const gr = g as Record<string, unknown>;
    if (!("shared" in gr)) return g;
    touched = true;
    const { shared, ...rest } = gr;
    if (shared === true && typeof rest.id === "string") {
      collected.push(`group.${rest.id}`);
    }
    return rest;
  });
  if (!touched) return raw;
  const existing = Array.isArray(r.collection)
    ? (r.collection as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { ...r, groups, collection: Array.from(new Set([...existing, ...collected])) };
};

// Narrow an unknown to a plain object record (not an array). Module-level
// counterpart to the function-local `isObj` used elsewhere in this file.
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

// Recognise a PURE visibility gate: an opacity keyframe array whose every
// keyframe is `hold`-eased with a value strictly in {0,1}, rising to 1 and then
// falling back to 0. That's the shape the old caption / set_layer_visible path
// produced to fake a [start, end) window. Returns the window, or null for a
// genuine fade (interpolating easing / intermediate opacity) which must stay a
// keyframe.
const detectVisibilityGate = (
  kfs: unknown,
): { start: number; end: number } | null => {
  if (!Array.isArray(kfs) || kfs.length < 2) return null;
  const parsed: { frame: number; value: number }[] = [];
  for (const kf of kfs) {
    const k = asRecord(kf);
    if (!k) return null;
    if (k.easing !== "hold") return null;
    if (k.value !== 0 && k.value !== 1) return null;
    if (typeof k.frame !== "number" || !Number.isFinite(k.frame)) return null;
    parsed.push({ frame: k.frame, value: k.value });
  }
  parsed.sort((a, b) => a.frame - b.frame);
  const rise = parsed.find((k) => k.value === 1);
  if (!rise) return null;
  const fall = parsed.find((k) => k.frame > rise.frame && k.value === 0);
  if (!fall) return null;
  return { start: rise.frame, end: fall.frame };
};

// Convert legacy caption / visibility opacity-gates into timeline blocks. A
// caption line used to be N opacity keyframes (hidden→1→0, all hold-eased); the
// block model expresses that same window as a single [start, duration). This
// preprocess recognises a PURE gate (see detectVisibilityGate) on a layer whose
// ONLY per-element animation data is that opacity track — i.e. an actual
// caption / show-hide layer, never a moving/tinted one — and replaces the track
// with a `block`. Genuine fades, and any layer with other motion / colour
// tracks, are left untouched, so the conversion is render-identical: it only
// tidies the data (40 lines → 40 blocks, not 120 keyframes). Idempotent: a layer
// that already has a `block` is skipped, and a converted layer no longer has an
// opacity gate to re-trigger on — so the editor's re-parse poll sees no phantom
// diff. Runs OUTERMOST, after per-element maps are flattened onto each layer.
const migrateLayersToBlocks = (raw: unknown): unknown => {
  const proj = asRecord(raw);
  if (!proj) return raw;
  const arrays = [
    "image_layers",
    "video_layers",
    "text_layers",
    "shapes",
    "groups",
  ];
  let changed = false;
  const nextProj: Record<string, unknown> = { ...proj };
  for (const key of arrays) {
    const arr = proj[key];
    if (!Array.isArray(arr)) continue;
    let arrChanged = false;
    const nextArr = arr.map((layer) => {
      const l = asRecord(layer);
      if (!l) return layer;
      if (l.block !== undefined && l.block !== null) return layer;
      const anims = asRecord(l.animations);
      if (!anims) return layer;
      const animKeys = Object.keys(anims);
      // Only convert when opacity is the SOLE animated property and there are no
      // colour / loop tracks — the exact profile of a caption / show-hide layer.
      if (animKeys.length !== 1 || animKeys[0] !== "opacity") return layer;
      const colorTracks = asRecord(l.color_tracks);
      if (colorTracks && Object.keys(colorTracks).length > 0) return layer;
      const trackLoops = asRecord(l.track_loops);
      if (trackLoops && Object.keys(trackLoops).length > 0) return layer;
      const gate = detectVisibilityGate(anims.opacity);
      if (!gate) return layer;
      arrChanged = true;
      const nextLayer: Record<string, unknown> = { ...l };
      nextLayer.block = {
        start: gate.start,
        duration: Math.max(1, gate.end - gate.start),
      };
      delete nextLayer.animations;
      return nextLayer;
    });
    if (arrChanged) {
      nextProj[key] = nextArr;
      changed = true;
    }
  }
  return changed ? nextProj : raw;
};

// True when a RAW project (or version blob, which wraps the project under
// `.project`) has at least one layer that migrateLayersToBlocks would convert —
// a pure caption/visibility opacity-gate with no block yet. The one-shot
// backfill uses this to rewrite ONLY the blobs that actually change, avoiding
// write amplification (re-serializing every project would differ on key order /
// defaults even when semantically unchanged).
export const rawProjectHasConvertibleGate = (raw: unknown): boolean => {
  const proj = asRecord(raw);
  if (!proj) return false;
  const target = asRecord(proj.project) ?? proj;
  const arrays = [
    "image_layers",
    "video_layers",
    "text_layers",
    "shapes",
    "groups",
  ];
  for (const key of arrays) {
    const arr = target[key];
    if (!Array.isArray(arr)) continue;
    for (const layer of arr) {
      const l = asRecord(layer);
      if (!l) continue;
      if (l.block !== undefined && l.block !== null) continue;
      const anims = asRecord(l.animations);
      if (!anims) continue;
      if (Object.keys(anims).length !== 1 || !("opacity" in anims)) continue;
      const ct = asRecord(l.color_tracks);
      if (ct && Object.keys(ct).length > 0) continue;
      const tl = asRecord(l.track_loops);
      if (tl && Object.keys(tl).length > 0) continue;
      if (detectVisibilityGate(anims.opacity)) return true;
    }
  }
  return false;
};

// Fold a group's legacy single-frame-0 transform keyframe into the new static
// base. Before groups carried a base, a whole-group move / scale / rotate was
// stored as a lone frame-0 keyframe (a constant). Groups now have a base
// x/y/scale/rotation, so collapse that constant into the base and drop the
// track: a frame-0-only keyframe evaluates to its value at every frame, so this
// is visually identical, and it lets subsequent edits write the base like a
// leaf instead of stacking a second keyframe. Genuine animations (any keyframe
// at frame > 0, or two-plus keyframes) are left untouched. Runs after
// migrateFlattenPerElementMaps so each group already carries its `animations`.
const GROUP_BASE_TRANSFORM_PROPS = ["x", "y", "scale", "rotation"] as const;
const migrateGroupConstantTracksToBase = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const groups = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return raw;
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const grp = g as Record<string, unknown>;
    const anims = grp.animations;
    if (!anims || typeof anims !== "object") continue;
    const tracks = anims as Record<string, unknown>;
    for (const prop of GROUP_BASE_TRANSFORM_PROPS) {
      const track = tracks[prop];
      if (!Array.isArray(track) || track.length !== 1) continue;
      const kf = track[0] as { frame?: unknown; value?: unknown };
      if (kf?.frame !== 0 || typeof kf.value !== "number") continue;
      grp[prop] = kf.value;
      delete tracks[prop];
    }
  }
  return raw;
};

const preprocessProject = (raw: unknown): unknown => {
  const base = migrateFlattenPerElementMaps(
    migrateImageTextLayers(
      migrateBackgroundToImageLayer(
        migrateShapeColorsToFills(
          migrateTranslateToAbsolute(
            stripBuiltinCustomFonts(
              stripLegacyCarouselAspect(stripLegacyClipFrame(raw)),
            ),
          ),
        ),
      ),
    ),
  );
  // Both outermost migrators run after the per-element maps are flattened onto
  // each layer. They touch disjoint fields (collection ids vs. layer blocks), so
  // their order relative to each other doesn't matter.
  return migrateGroupConstantTracksToBase(
    migrateSharedGroupsToCollection(migrateLayersToBlocks(base)),
  );
};

// A "public property" exposes one layer's content as a partner-overridable
// attribute on the <morpha-video> embed (e.g. `name="title"` mapped to
// `image.title.filename`). The embed SDK reads HTML attributes by `name`,
// matches the schema entry, and substitutes the target layer's field before
// rendering. `default_value` is what partners get when they don't override.
//
//   { name: "title", type: "image", layer_id: "image.title",
//     default_value: "drop-003-title.png" }
//
// Type semantics:
//   "image"  → swaps the targeted image_layer.filename (absolute URL allowed
//              from the partner side; the SDK fetches it directly).
//   "text"   → reserved for a future text-layer kind. No-op in v1.
//   "number" → reserved for numeric overrides (opacity, scale). No-op in v1.
//   "color"  → reserved for shape/palette colour overrides. No-op in v1.
const publicPropertySchema = z
  .object({
    name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
    type: z.enum(["text", "image", "number", "color"]),
    layer_id: z.string().min(1),
    default_value: z.string().default(""),
  })
  .strict();

// ── Loop section ───────────────────────────────────────────────────────────
// When `project.loop` has 1+ passes the WHOLE composition is a looped section:
// it plays once per pass, so N passes ⇒ the comp repeats N times. Before pass
// i renders, every override in passes[i] is applied to the project — so each
// repeat can show different text / colour / position / any layer field. Empty
// `loop` ⇒ the comp plays once. This is the general looping mechanism: an
// explicit array of property-sets, not a text-specific hack.
const loopOverrideSchema = z
  .object({
    // Target layer: text.<id> / image.<id> / shapes.<id> / video.<id>.
    elementId: z.string().min(1),
    // The layer field this pass overrides — e.g. "text", "text_color",
    // "font_family", "filename". Applied for this pass only.
    field: z.string().min(1),
    // The value to set for this pass.
    value: z.union([z.string(), z.number()]),
  })
  .strict();

const loopPassSchema = z
  .object({
    // Optional human label for the pass (shown in the Inspector).
    label: z.string().optional(),
    overrides: z.array(loopOverrideSchema).default([]),
  })
  .strict();

export type LoopOverride = z.infer<typeof loopOverrideSchema>;
export type LoopPass = z.infer<typeof loopPassSchema>;

// A custom (non-Google-Fonts) typeface registered on the project. Text layers
// reference it by `family` via their `font_family`, exactly like a Google
// family. `src` is EITHER a full URL (https://…, data:…) OR an uploaded asset
// filename — resolved against the project's asset bucket the same way image
// filenames are. The font loader (editor/src/fonts.ts) loads each via the
// FontFace API into document.fonts before the synchronous render loop.
const customFontSchema = z
  .object({
    family: z.string().min(1),
    src: z.string().min(1),
    // Optional specific face this src provides. When omitted the face is
    // treated as the family's 400/normal baseline.
    weight: z.number().int().min(1).max(1000).optional(),
    style: z.enum(["normal", "italic"]).optional(),
  })
  .strict();

export type CustomFont = z.infer<typeof customFontSchema>;

// One timeline marker — a named, frame-aligned cue point. Shared by the
// top-level composition and every carousel page so a page's timeline carries
// the same editorial cues a single-composition morpha does.
export const markerSchema = z
  .object({
    id: z.string().min(1),
    frame: z.number().int().nonnegative(),
    label: z.string().default(""),
    color: z.string().optional(), // #rrggbb, optional accent override
  })
  .strict();
export type Marker = z.infer<typeof markerSchema>;

// One page of a carousel — a FULL composition (video OR image), the same shape
// the single-composition editor edits. It carries every timeline field the
// top-level project does (video_layers / audio_overlays / duration / start_at /
// loop region / markers) so a video page's timeline works identically; the
// still-only pages saved before this widening still parse because every new
// field defaults. Canvas dims come from the parent project's own
// `canvas_width`/`canvas_height` (changeable like any video), and uploaded
// assets resolve against the parent carousel's project id (one asset bucket).
export const pageCompositionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    image_layers: z.array(imageLayerSchema).default([]),
    video_layers: z.array(videoLayerSchema).default([]),
    text_layers: z.array(textLayerSchema).default([]),
    shapes: z.array(shapeSchema).default([]),
    groups: z.array(groupSchema).default([]),
    layer_order: z.array(z.string()).default([]),
    audio_overlays: z.array(audioOverlaySchema).default([]),
    duration_seconds: z.number().positive().default(1),
    // Whether `duration_seconds` is USER-AUTHORED (an explicit page length the
    // user set) rather than DERIVED from content — the page-level twin of the
    // project field. Must survive the pageToProject/projectToPage round-trip:
    // without it a hand-trimmed page re-projects as un-authored and the
    // editor's recomputeDuration re-fits the trim away. Default false so
    // already-saved pages parse unchanged.
    duration_authored: z.boolean().default(false),
    start_at: z.number().nonnegative().nullable().default(null),
    markers: z.array(markerSchema).default([]),
    loop: z.array(loopPassSchema).default([]),
    loop_start_frame: z.number().int().min(0).default(0),
    loop_end_frame: z.number().int().min(1).nullable().default(null),
  })
  .strict();
export type PageComposition = z.infer<typeof pageCompositionSchema>;

// The carousel record on a project when `mode` is "carousel". Holds one or
// more full compositions (video or image pages) that all share the project's
// own canvas dims; `active_index` is the page the editor is currently
// projecting. No upper bound on page count.
export const carouselSchema = z
  .object({
    active_index: z.number().int().nonnegative().default(0),
    pages: z.array(pageCompositionSchema).min(1),
  })
  .strict();
export type Carousel = z.infer<typeof carouselSchema>;

export const projectSchema = z.preprocess(
  preprocessProject,
  z
    .object({
      project_id: z.string().min(1),
      // Human-readable label shown in the project picker. Optional — falls
      // back to project_id when missing or empty so the dropdown is never
      // blank for older projects that pre-date this field.
      name: z.string().optional(),
      // The organization this project belongs to, or null/absent when it's a
      // personal project. Opaque org UUID; the org membership index decides who
      // can see it.
      org_id: z.string().nullable().optional(),
      schema_version: z.literal(SCHEMA_VERSION),
      image_layers: z.array(imageLayerSchema).default([]),
      video_layers: z.array(videoLayerSchema).default([]),
      // Text layers — first-class leaf type, addressed as text.<id>.
      text_layers: z.array(textLayerSchema).default([]),
      shapes: z.array(shapeSchema).default([]),
      // Ordered list of ROOT-LEVEL element ids defining the top of the z-stack
      // tree (later in array = higher z = on top). Element ids:
      // "video.<id>", "image.<id>", "shapes.<id>", "group.<id>". Children of
      // any group are ordered by that group's `children` field, NOT here.
      // Empty → canonical fallback (ungrouped video layers, then shapes, then
      // image layers, then groups, all in array order). Missing-from-array but
      // present-and-ungrouped → appended (defaults to top); present-in-array
      // but grouped or missing → silently skipped.
      layer_order: z.array(z.string()).default([]),
      // Layer groups. See groupSchema. Empty by default; older projects parse
      // cleanly because the field defaults to [].
      groups: z.array(groupSchema).default([]),
      // Element ids (a leaf like "text.<id>" or a "group.<id>") the user has
      // added to their reusable COLLECTION from THIS project. A workspace
      // teammate — and the owner on their own solo projects — can drop a
      // self-contained COPY of one into another project (see list_collection /
      // add_from_collection); copies are immutable, nothing links back. Storing
      // ids (not a per-layer flag) lets ANY layer, not just groups, be
      // collected; ids whose layer was later deleted are simply skipped when the
      // collection is read. Default [] so existing projects parse unchanged.
      collection: z.array(z.string()).default([]),
      // Composition duration in seconds (drives the timeline / export length).
      // DERIVED from content, not set by hand: the editor (store
      // recomputeDuration) and the worker (write-back) re-fit it to the
      // furthest video-window / keyframe / audio end on every change, with a
      // 1s floor (see src/content-duration.ts). This stored value is the last
      // fitted result; the default only applies to a field-less project until
      // the first re-fit. 30 fps; durationInFrames = ceil(duration_seconds * 30).
      duration_seconds: z.number().positive().default(1),
      // Whether `duration_seconds` is USER-AUTHORED (an explicit composition
      // length the user set by dragging the timeline end handle) rather than
      // DERIVED from content. When false (the default, and the state of every
      // legacy project), the editor's recomputeDuration and the worker
      // write-back re-fit `duration_seconds` to the furthest content (auto-fit,
      // which also seeds the length as content is added). When true, that
      // re-fit becomes DISPLAY-ONLY — it never overwrites the authored length —
      // so the composition is a fixed stage you can author into (needed for
      // building from scratch, where content doesn't exist to derive a length
      // from yet) and can be dragged shorter than its content (content past the
      // end is kept, just not played/exported). "Fit to content" clears this
      // back to false. Default false ⇒ existing projects behave exactly as
      // before until the user drags the end.
      duration_authored: z.boolean().default(false),
      // Poster timestamp in SECONDS the editor seeks to on first load instead
      // of frame 0 — so a freshly-opened project doesn't sit on a blank /
      // cold-open frame. The landing "Try" templates set this to a composed
      // still (their builds finish a few seconds in, then hold). Clamped into
      // the comp on load; clones carry it. null/absent ⇒ open at frame 0 (the
      // historic behaviour). A returning user's saved scrub position still
      // wins — see the editor load path in App.tsx.
      start_at: z.number().nonnegative().nullable().default(null),
      // Audio overlays — independent sound clips scheduled at frame-aligned
      // starts. Played in the editor preview via WebAudio and mixed into the
      // MP4 export's AAC track alongside any source-mp4 audio. Default [] so
      // older projects parse cleanly.
      audio_overlays: z.array(audioOverlaySchema).default([]),
      // Timeline markers — named cue points on the timeline ruler (beat
      // markers, action cues, "CTA here" notes). Frame-aligned, purely
      // editorial — they don't affect the render. Default [] so older
      // projects parse cleanly.
      markers: z.array(markerSchema).default([]),
      // Loop section — see loopPassSchema. Empty ⇒ the comp plays once;
      // N passes ⇒ pass i applying its overrides plays in the loop region
      // (see loop_start_frame / loop_end_frame) once each. The region is a
      // SUB-SECTION of the video, not the whole video — frames outside
      // [loop_start_frame, loop_end_frame) play linearly once.
      loop: z.array(loopPassSchema).default([]),
      // Loop region — the sub-section of the video that repeats. Frame
      // numbers in the video's local frame space (0 = video start). If
      // loop_end_frame is null, the region ends at the video's last frame.
      // Defaults cover the whole video for back-compat with projects whose
      // loop was authored before this field existed.
      loop_start_frame: z.number().int().min(0).default(0),
      loop_end_frame: z.number().int().min(1).nullable().default(null),
      // The version this project state is checkpointed against. null when
      // no version exists yet (brand-new project or pre-versions JSON).
      // Set by the worker on save_version / restore_version; the editor
      // reads it to identify which entry in the Versions list is "current".
      current_version_id: z.string().nullable().default(null),
      // Unix ms of the last mutation. Bumped on every editor edit (via
      // scheduleSave) and reset to the version's timestamp on save/restore.
      // `last_modified_at > <currentVersion.timestamp>` ⇒ project is dirty.
      last_modified_at: z.number().int().nonnegative().default(0),
      // Allowlist of bare hostnames (no scheme, no port) where this project's
      // <morpha-video> embed is permitted to render. Worker checks the
      // request's Origin header against this list and 403s mismatches. Empty
      // ⇒ embedding disabled (the embed endpoint returns 404 for the project).
      embed_origins: z.array(z.string()).default([]),
      // Partner-overridable attributes exposed via the <morpha-video> tag.
      // See publicPropertySchema above for shape + semantics.
      public_properties: z.array(publicPropertySchema).default([]),
      // Email allowlist for read-only sharing. Lowercased Google-account
      // emails the OWNER has granted view access to. Empty ⇒ private (only the
      // owner can load it). A signed-in viewer whose email is on this list gets
      // a read-only copy of the project; everyone else 404s. Mirrored into the
      // KV project index on save so the worker can resolve owner-from-id for a
      // non-owner request. See worker/src/embed.ts + routes/project.ts.
      shared_with_emails: z.array(z.string()).default([]),
      // Subset of shared_with_emails granted EDIT access. An editor saves
      // straight into the owner's copy (worker routes write to the owner's
      // namespace); everyone else on shared_with_emails is a read-only
      // viewer. Kept as a parallel list (not a role field per entry) so all
      // existing view-path code keyed on shared_with_emails is untouched.
      shared_with_editors: z.array(z.string()).default([]),
      // Custom (non-Google) typefaces registered on the project. See
      // customFontSchema. Text layers reference them by family name via
      // font_family. Default [] so older projects parse cleanly.
      custom_fonts: z.array(customFontSchema).default([]),
      // Composition canvas dimensions in pixels. Drives renderer, export, and
      // embed render size. Defaults to 1080×1920 (vertical 9:16) so existing
      // R2 projects parse unchanged. Picker in PlayerPanel exposes three
      // platform presets + a Pro-gated Custom row.
      canvas_width: z.number().int().positive().default(1080),
      canvas_height: z.number().int().positive().default(1920),
      // Project mode. "video" (default) is the single-composition editor that
      // exports one MP4; "carousel" holds ordered pages in `carousel` and
      // exports ordered PNGs. Additive + defaulted so existing R2 projects
      // parse unchanged as "video".
      mode: z.enum(["video", "carousel"]).default("video"),
      // The carousel record — present only in carousel mode, holding the
      // still pages. null (default) in video mode. Style is chosen at creation,
      // never flipped on an existing morpha.
      carousel: carouselSchema.nullable().default(null),
    })
    .strict(),
);

export type Easing = z.infer<typeof easingSchema>;
export type Keyframe = z.infer<typeof keyframeSchema>;
export type TrackProperty = z.infer<typeof trackPropertySchema>;
export type ElementTracks = z.infer<typeof elementTracksSchema>;
export type Animations = z.infer<typeof animationsSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ImageLayer = z.infer<typeof imageLayerSchema>;
export type VideoLayer = z.infer<typeof videoLayerSchema>;
export type ShapeKind = z.infer<typeof shapeKindSchema>;
export type Shape = z.infer<typeof shapeSchema>;
export type LayerStyle = z.infer<typeof layerStyleSchema>;
export type Styles = z.infer<typeof stylesSchema>;
export type FitMode = z.infer<typeof fitModeSchema>;
export type PublicProperty = z.infer<typeof publicPropertySchema>;
export type FillStop = z.infer<typeof fillStopSchema>;
export type SolidFill = z.infer<typeof solidFillSchema>;
export type LinearGradient = z.infer<typeof linearGradientSchema>;
export type RadialGradient = z.infer<typeof radialGradientSchema>;
export type MaskFill = z.infer<typeof maskFillSchema>;
export type Fill = z.infer<typeof fillSchema>;

// A sensible default font size (px) for a NEW text layer: the median of the
// project's existing explicit text_size values, or ~10% of the canvas height
// when there are none. Used by both the editor's addTextLayer and the headless
// add_text_layer tool so editor- and agent-created text get the SAME explicit
// size — text_size is the single source of truth for the font, so it must
// always be set; an unset text_size makes the renderer derive the font from the
// box height, which lets a box resize silently change the font.
export const resolveDefaultTextSize = (project: Project): number => {
  const sizes = project.text_layers
    .map((t) => t.text_size)
    .filter((s): s is number => typeof s === "number" && s > 0)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return Math.round(project.canvas_height * 0.1);
  const mid = Math.floor(sizes.length / 2);
  return sizes.length % 2 === 1
    ? sizes[mid]
    : (sizes[mid - 1] + sizes[mid]) / 2;
};

// Legacy source-clip entry. Pre-refactor, projects had a global "shortlist" of
// candidate source clips and the editor flipped between them via an active-
// entry index. The new model represents source clips as ordinary
// `video_layers[]`. The shortlist schema is retained for the worker's project
// GET migration: it reads any existing shortlist file and converts each entry
// into a video_layer. Older JSON stored `label` as `performer` — preprocess
// transparently maps that.
export const shortlistEntrySchema = z.preprocess((v) => {
  if (
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    "performer" in v &&
    !("label" in v)
  ) {
    const { performer, ...rest } = v as Record<string, unknown>;
    return { ...rest, label: performer };
  }
  return v;
}, z
  .object({
    clip: z.string().min(1),
    label: z.string().min(1),
  })
  .strict());

export const shortlistSchema = z
  .object({
    project_id: z.string().min(1),
    entries: z.array(shortlistEntrySchema),
  })
  .strict();

export type ShortlistEntry = z.infer<typeof shortlistEntrySchema>;
export type Shortlist = z.infer<typeof shortlistSchema>;

// Server-backed version. One row per saved version of a project; restoring
// rewrites the live project to `project`. We keep the inner project as the
// validated schema so a version can never carry a malformed payload.
export const versionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    /** Unix ms — sort key for the picker. */
    timestamp: z.number().int().nonnegative(),
    /** "manual" = user pressed Save; "agent" = MCP/HTTP tool wrote it. */
    source: z.enum(["manual", "agent"]).default("manual"),
    /** Discriminator for the Figma / Google Docs split:
     *   "bookmark" — user/agent deliberately marked a milestone. Surfaces in
     *                the main Bookmarks list, gets a V<n> pill, and is the
     *                only kind the embed snippet can pin to.
     *   "auto"     — background auto-snapshot written by the editor every
     *                ~10 mutations or 5 min of edit activity. Surfaces only
     *                in the Auto-history drawer; never referenced externally.
     * Default = "bookmark" so legacy rows (missing the field) parse as
     * bookmarks — they were all deliberate saves before this split. */
    kind: z.enum(["bookmark", "auto"]).default("bookmark"),
    /** Stable, monotonic per-project version number assigned at save time.
     * v1 = first version saved, v<n> = nth. Deleting a version leaves gaps —
     * numbers never re-shuffle, so any external reference (snippet, MCP call,
     * shared link) keeps pointing at the same content for its lifetime.
     * Assigned across BOTH kinds at save time; the editor's bookmarks-only
     * V<n> display label is computed by filtering to kind=="bookmark" and
     * indexing, NOT by reading this field directly.
     * Optional only for backwards-compat with legacy versions saved before
     * the field was introduced; the worker backfills missing values on read
     * by timestamp-ascending order and persists the result. */
    version_number: z.number().int().positive().optional(),
    project: projectSchema,
  })
  .strict();

export type Version = z.infer<typeof versionSchema>;

// Tree node returned by resolveLayerTree. id is always set; children is
// populated only on group nodes (an empty array still means "this is a
// group with no kids", which is renderably distinct from a leaf).
export type LayerNode = { id: string; children?: LayerNode[] };

const collectPresentIds = (project: Project): Set<string> => {
  const present = new Set<string>();
  for (const v of project.video_layers) present.add(`video.${v.id}`);
  for (const s of project.shapes) present.add(`shapes.${s.id}`);
  for (const l of project.image_layers) present.add(`image.${l.id}`);
  for (const t of project.text_layers) present.add(`text.${t.id}`);
  for (const g of project.groups ?? []) present.add(`group.${g.id}`);
  return present;
};

const collectGroupedIds = (project: Project): Set<string> => {
  const out = new Set<string>();
  for (const g of project.groups ?? []) {
    for (const child of g.children) out.add(child);
  }
  return out;
};

// Pinned image_layer ids. Layers marked `pinned: true` are forced to the
// BOTTOM of the root z-stack regardless of where they appear in
// `layer_order` (which silently ignores them). Today only the canvas
// backdrop is pinned, but the mechanism is general — any pinned-tagged
// layer behaves the same way.
export const collectPinnedRootIds = (project: Project): string[] =>
  project.image_layers
    .filter((l) => l.pinned === true)
    .map((l) => `image.${l.id}`);

// Resolve the project's render tree. Each entry is a root-level id; group
// nodes carry a nested `children` list. Same precedence rules as the old
// flat resolver, just applied at root and recursed into each group:
//   - non-empty `layer_order` is filtered to root-level present ids, then
//     any unlisted ungrouped ids are appended in canonical order;
//   - empty `layer_order` falls back to canonical (ungrouped video layers,
//     then ungrouped shapes, then ungrouped image layers, then ungrouped
//     groups), all in array order.
//   - PINNED image layers are pre-pended at root (= bottom of z) regardless
//     of layer_order; non-pinned layers sit above them. Render order in
//     the tree is back-to-front, so the pinned layer paints first.
// A given element id appears at most once in the whole tree.
export const resolveLayerTree = (project: Project): LayerNode[] => {
  const present = collectPresentIds(project);
  const grouped = collectGroupedIds(project);
  const groupById = new Map<string, Group>();
  for (const g of project.groups ?? []) groupById.set(g.id, g);
  const pinnedRoot = new Set(collectPinnedRootIds(project));

  const seen = new Set<string>();
  const buildNode = (id: string): LayerNode | null => {
    if (!present.has(id)) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    if (id.startsWith("group.")) {
      const g = groupById.get(id.slice("group.".length));
      if (!g) return null;
      const children: LayerNode[] = [];
      for (const childId of g.children) {
        const node = buildNode(childId);
        if (node) children.push(node);
      }
      return { id, children };
    }
    return { id };
  };

  const rootIds: string[] = [];
  const seenRoot = new Set<string>();
  const pushRoot = (id: string) => {
    if (seenRoot.has(id)) return;
    if (grouped.has(id)) return;
    if (!present.has(id)) return;
    if (pinnedRoot.has(id)) return;
    seenRoot.add(id);
    rootIds.push(id);
  };

  const explicit = project.layer_order ?? [];
  for (const id of explicit) pushRoot(id);
  for (const v of project.video_layers) pushRoot(`video.${v.id}`);
  for (const s of project.shapes) pushRoot(`shapes.${s.id}`);
  for (const l of project.image_layers) {
    if (l.pinned === true) continue;
    pushRoot(`image.${l.id}`);
  }
  for (const t of project.text_layers) pushRoot(`text.${t.id}`);
  for (const g of project.groups ?? []) pushRoot(`group.${g.id}`);

  const out: LayerNode[] = [];
  // Pinned layers come FIRST in tree order (= back of z-stack, painted
  // before everything else). Preserve their relative order from
  // image_layers[].
  for (const id of pinnedRoot) {
    const node = buildNode(id);
    if (node) out.push(node);
  }
  for (const id of rootIds) {
    const node = buildNode(id);
    if (node) out.push(node);
  }
  return out;
};

const flattenTree = (nodes: LayerNode[], leavesOnly: boolean): string[] => {
  const out: string[] = [];
  const walk = (ns: LayerNode[]) => {
    for (const n of ns) {
      const isGroup = n.children !== undefined;
      if (isGroup) {
        if (!leavesOnly) out.push(n.id);
        walk(n.children!);
      } else {
        out.push(n.id);
      }
    }
  };
  walk(nodes);
  return out;
};

// Flat render-order list of every element id in the project, depth-first.
// Includes group ids interleaved with their descendants. Backwards-compatible
// with the pre-groups behaviour for projects that have no groups (the result
// is identical to the old shapes-then-images list).
export const resolveLayerOrder = (project: Project): string[] =>
  flattenTree(resolveLayerTree(project), false);

// Flat render-order list of LEAF ids only (video + shape + image layers).
// Use this for hit-testing and any consumer that wants to address visual
// layers and not the abstract groups containing them.
export const resolveLeafOrder = (project: Project): string[] =>
  flattenTree(resolveLayerTree(project), true);

// The project's CURRENT root-level render order as an explicit `layer_order`
// value: every non-pinned root id (leaves and groups, no descendants),
// back-to-front exactly as resolveLayerTree renders them today. Ops that
// append a new id to `layer_order` expecting it to land ON TOP must write
// this first when the existing order may be partial — unlisted root ids
// (legacy projects on the canonical fallback) render ABOVE the explicit
// list, so appending to a partial list sinks the new layer underneath them.
export const materializeRootLayerOrder = (project: Project): string[] => {
  const pinned = new Set(collectPinnedRootIds(project));
  return resolveLayerTree(project)
    .map((n) => n.id)
    .filter((id) => !pinned.has(id));
};

// The immediate parent group's bare id (no "group." prefix), or null if the
// element sits at the tree root or isn't referenced by any group.
export const findParentGroup = (
  project: Project,
  elementId: string,
): string | null => {
  for (const g of project.groups ?? []) {
    if (g.children.includes(elementId)) return g.id;
  }
  return null;
};

// Ancestor group ids (bare, no prefix) from root-most to immediate parent,
// excluding the element itself. Empty for root-level elements / unknown ids.
// The maxDepth bound is defensive — dispatchers refuse cycles, but a hand-
// edited file could in principle produce one.
export const getAncestorGroupChain = (
  project: Project,
  elementId: string,
): string[] => {
  const chain: string[] = [];
  let current = elementId;
  const maxDepth = (project.groups ?? []).length + 1;
  for (let i = 0; i < maxDepth; i++) {
    const parentGid = findParentGroup(project, current);
    if (parentGid === null) break;
    chain.unshift(parentGid);
    current = `group.${parentGid}`;
  }
  return chain;
};

// Drop any selected id whose ANCESTOR group is also in the same selection. A
// group already carries its descendants, so any operation that moves both the
// group and one of its members (multi-drag, align, distribute) would shift that
// member twice — once via the group's transform, once via its own base. Keeping
// only the top-most selected element on each nesting path makes every such
// operation move independent things. Order-preserving; dedupes first occurrence.
// The single source of truth shared by the drag co-move path (CanvasOverlay) and
// the align / distribute store actions.
export const deNestSelection = (
  project: Project,
  ids: readonly string[],
): string[] => {
  const sel = new Set(ids);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (getAncestorGroupChain(project, id).some((g) => sel.has(`group.${g}`))) {
      continue;
    }
    out.push(id);
  }
  return out;
};

// All descendant element ids of a group (depth-first, leaves and nested
// groups). Used by ungroup to splice children back in, by renderer hit-test
// to pick a leaf for drill-down, and to enforce group cycle prevention.
export const getGroupDescendants = (
  project: Project,
  groupId: string,
): string[] => {
  const groupById = new Map<string, Group>();
  for (const g of project.groups ?? []) groupById.set(g.id, g);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (gid: string) => {
    if (seen.has(gid)) return;
    seen.add(gid);
    const g = groupById.get(gid);
    if (!g) return;
    for (const child of g.children) {
      out.push(child);
      if (child.startsWith("group.")) walk(child.slice("group.".length));
    }
  };
  walk(groupId);
  return out;
};

// Validate raw JSON as a Project. Kept as a named function so callers that
// already invoke `migrateProject(raw)` keep working — the historical v0/v1
// transforms are gone (data has been wiped), so this is now just a parse.
export const migrateProject = (raw: unknown): Project => projectSchema.parse(raw);

// Any leaf or group layer record. Per-element data (animations / style /
// color_tracks / track_loops) lives on these directly — see perElementDataFields.
export type AnyLayer = ImageLayer | VideoLayer | TextLayer | Shape | Group;

// Resolve an element id ("image.abc", "group.g1", "shapes.s2") to its layer
// record across the five kind-arrays. Returns null when the id has no matching
// layer. The single lookup that replaces the ~25 inline
// `if (eid.startsWith("image.")) { …find… }` dispatches across editor + tools.
export const findLayerByElementId = (
  project: Project,
  elementId: string,
): AnyLayer | null => {
  const dot = elementId.indexOf(".");
  if (dot < 1) return null;
  const kind = elementId.slice(0, dot);
  const id = elementId.slice(dot + 1);
  const list: readonly AnyLayer[] | null =
    kind === "image"
      ? project.image_layers
      : kind === "video"
        ? project.video_layers
        : kind === "text"
          ? project.text_layers
          : kind === "shapes"
            ? project.shapes
            : kind === "group"
              ? project.groups
              : null;
  if (!list) return null;
  return list.find((l) => l.id === id) ?? null;
};

// Per-Project-identity cache of element id → layer record. The store clones the
// project (structuredClone) on every mutation, so a fresh identity invalidates
// this automatically — no manual invalidation needed.
const elementIndexCache = new WeakMap<Project, Map<string, AnyLayer>>();

// Build (once per Project identity, then cached) a map from element id → layer.
// For per-frame hot paths (renderer/geometry samplers) that previously did O(1)
// `project.animations[eid]` map lookups and must stay O(1) now that the data
// is on the records.
export const elementIndex = (project: Project): Map<string, AnyLayer> => {
  const cached = elementIndexCache.get(project);
  if (cached) return cached;
  const idx = new Map<string, AnyLayer>();
  for (const l of project.image_layers) idx.set(`image.${l.id}`, l);
  for (const l of project.video_layers) idx.set(`video.${l.id}`, l);
  for (const l of project.text_layers) idx.set(`text.${l.id}`, l);
  for (const l of project.shapes) idx.set(`shapes.${l.id}`, l);
  for (const l of project.groups) idx.set(`group.${l.id}`, l);
  elementIndexCache.set(project, idx);
  return idx;
};

// Cached element id → layer lookup for hot paths. Falls back to a direct scan
// on a miss (the cached index may predate a layer added on the same Project
// identity); never caches a null. Mutators in src/tools.ts that splice layer
// arrays mid-function should use findLayerByElementId (uncached) instead.
export const layerOf = (
  project: Project,
  elementId: string,
): AnyLayer | null =>
  elementIndex(project).get(elementId) ??
  findLayerByElementId(project, elementId);

// ───────────────────────────────────────────────────────────────────────────
// Timeline blocks — a layer's on-timeline existence window + block-local time.
//
// Every layer optionally carries a `block` ({start, duration}); absent means
// "always present" (a block spanning the whole comp, keyframes sampled at
// absolute frames). These four resolvers are the SINGLE source of truth for the
// block model — the renderer, DOM sync, content-duration, and tools all route
// through them so canvas and DOM stay frame-for-frame identical. Never re-derive
// the offset/gate inline.
// ───────────────────────────────────────────────────────────────────────────

// Sentinel duration for an absent (always-present) block: unbounded, so the
// visibility gate never culls and sampling is at absolute frames. Never
// serialized — a stored block always has a finite positive duration.
const ALWAYS_PRESENT_DURATION = Number.POSITIVE_INFINITY;

// The layer's on-timeline window in its PARENT's timeline, defaulting to the
// always-present window when the layer has no stored block.
export const blockOf = (
  project: Project,
  elementId: string,
): { start: number; duration: number } => {
  const block = layerOf(project, elementId)?.block;
  if (!block) return { start: 0, duration: ALWAYS_PRESENT_DURATION };
  return { start: block.start, duration: block.duration };
};

// Sum of the TIME ORIGINS of every ANCESTOR embedded morpha band of `elementId`
// (each band's block.start). A band's whole subtree plays relative to where the
// band sits on the host timeline, so its descendants subtract this. Regular
// (non-band) ancestor groups contribute nothing — grouping never retimes.
// Memoized per Project identity (structural, frame-independent) so the per-frame
// render loop doesn't re-walk the ancestor chain 5× per layer — same
// invalidate-on-clone contract as elementIndex.
const bandOriginSumCache = new WeakMap<Project, Map<string, number>>();
const ancestorBandOriginSum = (project: Project, elementId: string): number => {
  let cache = bandOriginSumCache.get(project);
  if (!cache) {
    cache = new Map();
    bandOriginSumCache.set(project, cache);
  }
  const hit = cache.get(elementId);
  if (hit !== undefined) return hit;
  let sum = 0;
  for (const gid of getAncestorGroupChain(project, elementId)) {
    const g = layerOf(project, `group.${gid}`) as Group | null;
    if (g && isMorphaGroup(g)) sum += g.block?.start ?? 0;
  }
  cache.set(elementId, sum);
  return sum;
};

// The frame offset to subtract before sampling a layer's OWN animation tracks,
// making keyframes block-relative (own block.start) AND band-local (ancestor
// band origins). A blockless root layer with no band ancestors returns 0 ⇒
// absolute-frame sampling ⇒ identical to the pre-blocks behavior. The renderer's
// resolveTrack/evalFill and content-duration route every track read through this.
export const effectiveFrameOffset = (
  project: Project,
  elementId: string,
): number =>
  ancestorBandOriginSum(project, elementId) + blockOf(project, elementId).start;

// True when the layer is NOT drawn at `frame` (frame outside its block window).
// `frame` is the raw composition frame; the layer's block window is expressed in
// its PARENT timeline, so ancestor band origins are subtracted first. Always
// false for an always-present (blockless) layer. The one gate the canvas
// (drawNode) and the DOM sync both call.
export const frameOutsideBlock = (
  project: Project,
  elementId: string,
  frame: number,
): boolean => {
  const { start, duration } = blockOf(project, elementId);
  if (duration === ALWAYS_PRESENT_DURATION) return false;
  const parentFrame = frame - ancestorBandOriginSum(project, elementId);
  return parentFrame < start || parentFrame >= start + duration;
};

