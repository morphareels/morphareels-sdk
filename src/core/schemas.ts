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
  // EDGE TRANSITIONS — how the layer enters at the start of its window and
  // leaves at the end, instead of popping. Both are EDGE-RELATIVE: they store
  // a length (and a look), never an absolute frame, so they ride the edge when
  // the layer is re-trimmed, slid, or (for a welded caption) retimed by the
  // clip it follows. That is the whole reason they are not keyframes —
  // `fade_layer` / `apply_preset` write opacity keyframes at ABSOLUTE frames,
  // which strand themselves the moment the edge moves.
  //
  // The window they resolve against is `effectiveWindowOf`, not `block`:
  // video layers carry no block at all (their window comes from the trim), so
  // hanging these off `block` would fix the layer pop and leave the clip pop.
  //
  // Applied as MULTIPLIERS over the layer's own sampled transform (see
  // src/transitions.ts `edgeTransitionAt`, applied in renderer.ts `evalStyle`),
  // never as a replacement — a user's own opacity keyframes survive underneath.
  // An unbounded (always-present) window has no edges, so a transition on such
  // a layer is inert; this is what keeps the field backward-compatible.
  transition_in: z.lazy(() => edgeTransitionSchema).optional(),
  transition_out: z.lazy(() => edgeTransitionSchema).optional(),
  // Caption SOURCE ANCHOR — a caption line's timing tied to a clip's audio
  // track, the caption analog of a welded audio overlay's `sourceLayerId`.
  // `source_start_frame` / `source_end_frame` are the line's window in the
  // referenced clip's OWN (source) timeline — i.e. the Whisper word timings the
  // line was built from, independent of where/how the clip is placed or trimmed.
  // When present, the layer's on-timeline `block` window is DERIVED LIVE from the
  // clip's trim (`deriveCaptionWindow` → blockOf), so trimming or sliding the
  // clip retimes/clips the caption with no stored bookkeeping — exactly like
  // `weldedAudioTiming`. Any stored `block` is ignored while this is set (used
  // only as a fallback when the referenced clip is missing). Only caption text
  // layers carry it.
  caption_source: z
    .object({
      clip_element_id: z.string().min(1),
      source_start_frame: z.number().int().nonnegative(),
      source_end_frame: z.number().int().positive(),
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
    // LANE (track) grouping. Video layers that share a `lane_id` are the same
    // visual track — pieces of one take laid end-to-end (e.g. the two halves of
    // a razor split, or the fragments cut_range leaves behind). A lane is a TIME
    // track, NOT a z-order group: layers keep their independent place in
    // `layer_order`, and lanes never reshape the layer tree. Optional so older
    // projects (and hand-built fixtures) still parse; the schema migration
    // backfills every clip lacking one with a lane of its own (lane_id = id), so
    // today's 1-clip-per-lane behaviour is preserved exactly. Split / cut_range
    // hand both resulting pieces the ORIGINAL clip's lane_id so they read as one
    // track. Dormant for the UI/renderer until a later PR consumes it.
    lane_id: z.string().optional(),
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
    // CONSTANT playback rate for the clip — the simple "play this slower /
    // faster" control. 1 = source speed, 0.5 = half speed, 2 = double. This is
    // the whole retime story for most clips; `speed_keyframes` below is the
    // power-user ramp layered ON TOP (the effective rate at a timeline frame is
    // `speed × ramp(frame)` — see `layerRateAtFrame`).
    //
    // Speed RETIMES the clip: the trimmed source span is fixed, so a slower
    // rate makes the clip occupy MORE timeline frames and a faster one fewer.
    // `videoWindow` derives `windowFrames` from the rate curve — nothing stores
    // the retimed length, so speed and trim compose without bookkeeping.
    speed: z.number().min(0.1).max(8).default(1),
    // Speed RAMP — a rate curve for when the speed must CHANGE across the clip.
    // Multiplies the constant `speed` above (`layerRateAtFrame` = speed × ramp).
    //
    // `frame` is CLIP-RELATIVE: 0 is the clip's first frame, NOT a project
    // frame. That is load-bearing, not a detail. The clip's on-timeline length
    // is derived by integrating this curve, so if the curve were anchored to
    // absolute project frames, sliding a clip would slide the curve underneath
    // it and CHANGE ITS DURATION — and every op that moves a clip would have to
    // remember to remap the keyframes (cut_range did; move_band, shift_group
    // and the clip drag did not). Clip-relative removes the chance to forget.
    // The `add_speed_keyframe` / `remove_speed_keyframe` TOOLS still take a
    // project frame, because that is what a caller with a playhead has; they
    // convert on the way in — and report project frames back out, as does
    // `inspect_layers`, so the round trip closes.
    //
    // The offsets are in the clip's TIMELINE space, not its source space. So a
    // MOVE carries the curve (the point of this), while a HEAD TRIM slides the
    // footage underneath a stationary curve — trimming 10 frames off the front
    // leaves the ramp where it was and different content arrives under it.
    // That is the opposite of `caption_source`, which anchors in SOURCE space
    // and therefore survives a trim. Timeline space is the right choice here
    // because the length integral is over timeline frames; if a future change
    // wants trim-stable ramps, it has to re-anchor deliberately, not by
    // accident. Recorded so the next person has an answer rather than a guess.
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
//
// SPEED: `windowFrames` is the RETIMED on-timeline length — the number of
// project frames it takes to play the trimmed source span at the layer's rate
// curve — so it is NOT `outFrame - inFrame` once the clip is retimed. The
// source span is unchanged by speed (that's `sourceSpanFrames`); what changes
// is how long it takes. Because every call site already routes through here,
// making this speed-aware retimes the clip bar, the renderer's window test,
// trim/snap, welded audio and the comp duration in one move.
export const videoWindow = (
  layer: VideoLayer,
  sourceDurationSeconds: number,
): {
  startFrame: number;
  endFrame: number;
  sourceInSeconds: number;
  sourceOutSeconds: number;
  windowFrames: number;
  sourceSpanFrames: number;
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
  const sourceSpanFrames = Math.max(0, outFrame - inFrame);
  const windowFrames = retimedWindowFrames(layer, sourceSpanFrames);
  const startFrame = Math.max(0, layer.timeline_start_frame);
  return {
    startFrame,
    endFrame: startFrame + windowFrames,
    sourceInSeconds: inFrame / FPS,
    sourceOutSeconds: outFrame / FPS,
    windowFrames,
    sourceSpanFrames,
  };
};

export type VideoWindow = ReturnType<typeof videoWindow>;

// Half-open membership in a resolved clip window: `[startFrame, endFrame)`.
// Trivial, and that is the point — this comparison was hand-written at ten call
// sites (renderer, export, seek math, the preview's play/pause + loop-wrap
// reconciliation) and every one of them had to independently get the closed/open
// ends the right way round. One of them being an off-by-one is a clip that
// paints a frame past its neighbour, or drops its first.
export const frameInVideoWindow = (win: VideoWindow, frame: number): boolean =>
  frame >= win.startFrame && frame < win.endFrame;

// "Is this clip OFF at `frame`" — the visibility gate for a video layer, and the
// clip-side counterpart to `frameOutsideBlock` below.
//
// A clip carries no `block` (no add path writes one), so the block resolvers
// read every clip as always-present. Its real on-timeline window is the TRIM,
// and this is the single home for the gate: `drawVideoLayer` culls the painted
// pixels with it and the canvas hit-test culls the selection rect with it, so
// the two cannot drift into disagreeing about which frames a clip occupies.
//
// `sourceDurationSeconds` is the source's natural (decoded) length — from the
// loaded HTMLVideoElement in the browser, or a probe headlessly. Pass 0 when it
// isn't known yet, which enforces the LOWER bound only. That asymmetry is
// deliberate: clamping a set `source_out_frame` against duration 0 collapses the
// window to `[start, start)` and culls at EVERY frame, so a clip whose source
// failed to load would silently vanish instead of painting its black fallback.
// Callers that genuinely want the collapse (headless export, where a missing
// duration means a missing source) should use `frameInVideoWindow` directly.
export const frameOutsideClipWindow = (
  layer: VideoLayer,
  frame: number,
  sourceDurationSeconds: number,
): boolean =>
  sourceDurationSeconds > 0
    ? !frameInVideoWindow(videoWindow(layer, sourceDurationSeconds), frame)
    : frame < Math.max(0, layer.timeline_start_frame);

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

// Legal bounds for a playback rate, shared by the scalar `speed`, the ramp
// keyframes, and every clamp below. A rate of 0 would consume no source at all
// (an infinitely long clip), so the floor is deliberately > 0.
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 8;
export const clampSpeed = (v: number | undefined | null): number =>
  !Number.isFinite(v ?? 1)
    ? 1
    : Math.max(MIN_SPEED, Math.min(MAX_SPEED, v ?? 1));

// The layer's CONSTANT speed multiplier (the "play slower / faster" control).
export const layerSpeed = (layer: VideoLayer): number => clampSpeed(layer.speed);

// True when the layer plays at anything other than 1:1 — a non-unit constant
// speed, a ramp, or both. Call sites that used to gate remapping on
// `speed_keyframes.length > 0` MUST use this instead, or a constant-speed clip
// silently falls back to the 1:1 path.
export const isRetimed = (layer: VideoLayer): boolean =>
  layerSpeed(layer) !== 1 || resolveSpeedKeyframes(layer).length > 0;

// The EFFECTIVE playback rate at an absolute project-timeline frame: the
// constant `speed` multiplied by the ramp curve (which is 1 everywhere when the
// layer has no speed keyframes). Ramp keyframe `frame` values are CLIP-RELATIVE
// offsets, so this converts the incoming project frame before evaluating.
export const layerRateAtFrame = (
  layer: VideoLayer,
  timelineFrame: number,
): number =>
  rateAtOffsetWithRamp(
    layer,
    resolveSpeedKeyframes(layer),
    timelineFrame - Math.max(0, layer.timeline_start_frame),
  );

// The same evaluation with the ramp ALREADY resolved. `resolveSpeedKeyframes`
// allocates a Map, an array and a sort, so calling `layerRateAtFrame` inside a
// per-frame integration loop is quadratic in the window length — which is
// exactly where the two integrators below spend their time. They hoist the
// ramp once and call this.
const rateAtOffsetWithRamp = (
  layer: VideoLayer,
  ramp: Array<{ frame: number; rate: number }>,
  offset: number,
): number =>
  clampSpeed(layerSpeed(layer) * rateAtClipOffset(ramp, offset));

// The smallest effective rate the layer can reach, used to bound the window
// integrator's loop. Hold-extrapolation means the curve never leaves the
// [min, max] of its keyframes, so this is exact rather than conservative.
const minEffectiveRate = (layer: VideoLayer): number => {
  const ramp = resolveSpeedKeyframes(layer);
  const speed = layerSpeed(layer);
  if (ramp.length === 0) return speed;
  let min = Infinity;
  for (const kf of ramp) min = Math.min(min, kf.rate);
  return Math.max(MIN_SPEED * MIN_SPEED, speed * min);
};

// `videoWindow` runs per-layer per-frame in the render/preview loops, and the
// ramped branch of `retimedWindowFrames` integrates a curve. Memoize on the
// layer OBJECT: store mutations `structuredClone` the project, so a new object
// identity is exactly the invalidation signal we want — no manual busting.
const retimedWindowCache = new WeakMap<VideoLayer, Map<number, number>>();

// How many PROJECT frames it takes to play `sourceSpanFrames` of source at this
// layer's rate curve — the retimed on-timeline length of the clip.
//
// Constant rate is the closed form `span / speed`. A ramp is integrated with
// the SAME trapezoid `buildSourceFrameTable` uses, stepping until the
// accumulated source advance covers the span; sharing the integrator is what
// keeps the window's last frame and the table's last entry on the same source
// frame (a mismatch shows up as a frozen or clipped tail).
export const retimedWindowFrames = (
  layer: VideoLayer,
  sourceSpanFrames: number,
): number => {
  // A non-empty span always occupies at least one frame — a clip you can't see
  // is not a clip. That floor is a WINDOW rule and must not leak into the
  // offset inverse, which is why `timelineOffsetForSourceFrame` has its own
  // un-floored form (a floored offset made short captions on a fast clip
  // collapse to zero length).
  const raw = retimedOffsetFrames(layer, sourceSpanFrames);
  return sourceSpanFrames > 0 ? Math.max(1, raw) : 0;
};

// The un-floored core of `retimedWindowFrames`: how many project frames it
// takes to consume `sourceSpanFrames` of source, rounded but NOT floored to 1.
// Callers wanting a clip LENGTH want the floored `retimedWindowFrames`;
// callers converting a source position to a timeline offset want this.
const retimedOffsetFrames = (
  layer: VideoLayer,
  sourceSpanFrames: number,
): number => {
  if (!(sourceSpanFrames > 0)) return 0;
  const ramp = resolveSpeedKeyframes(layer);
  const speed = layerSpeed(layer);
  if (ramp.length === 0) {
    return Math.round(sourceSpanFrames / speed);
  }
  const cached = retimedWindowCache.get(layer)?.get(sourceSpanFrames);
  if (cached !== undefined) return cached;
  // Integrated over CLIP-RELATIVE offsets, so `timeline_start_frame` does not
  // appear: a clip's length cannot depend on where it sits. Absolute keyframe
  // frames made sliding a ramped clip slide the curve underneath it and change
  // its duration (+33% over a 60-frame move), and every clip-mover would have
  // had to remember to remap. Clip-relative makes that unrepresentable.
  // Terminates: each step adds at least `minEffectiveRate` to `acc`.
  const bound = Math.ceil(sourceSpanFrames / minEffectiveRate(layer)) + 2;
  let acc = 0;
  let out = bound;
  for (let i = 1; i <= bound; i++) {
    const ra = rateAtOffsetWithRamp(layer, ramp, i - 1);
    const rb = rateAtOffsetWithRamp(layer, ramp, i);
    const step = (ra + rb) / 2;
    if (acc + step >= sourceSpanFrames) {
      // Land on the fractional frame where the span is exactly consumed, then
      // round so the window is a whole number of frames.
      const frac = step > 0 ? (sourceSpanFrames - acc) / step : 0;
      out = Math.max(1, Math.round(i - 1 + frac));
      break;
    }
    acc += step;
  }
  let bySpan = retimedWindowCache.get(layer);
  if (!bySpan) {
    bySpan = new Map();
    retimedWindowCache.set(layer, bySpan);
  }
  bySpan.set(sourceSpanFrames, out);
  return out;
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
// `sourceSecondsForLayer` rebuilds a table on EVERY call — once per composition
// frame per layer during export and once per scrub tick in preview — so a
// ramped clip would re-integrate its whole window thousands of times. Memoized
// on the layer OBJECT for the same reason as `retimedWindowCache`: store
// mutations `structuredClone`, so a new identity is the invalidation signal.
const sourceFrameTableCache = new WeakMap<VideoLayer, Map<number, number[]>>();

export const buildSourceFrameTable = (
  layer: VideoLayer,
  maxLength: number,
): number[] => {
  const hit = sourceFrameTableCache.get(layer)?.get(maxLength);
  if (hit) return hit;
  const built = computeSourceFrameTable(layer, maxLength);
  let byLen = sourceFrameTableCache.get(layer);
  if (!byLen) {
    byLen = new Map();
    sourceFrameTableCache.set(layer, byLen);
  }
  byLen.set(maxLength, built);
  return built;
};

const computeSourceFrameTable = (
  layer: VideoLayer,
  maxLength: number,
): number[] => {
  const ramp = resolveSpeedKeyframes(layer);
  const speed = layerSpeed(layer);
  const out: number[] = [];
  if (maxLength <= 0) return out;
  const sourceIn = layer.source_in_frame ?? 0;
  if (ramp.length === 0) {
    // No ramp: the effective rate is the constant `speed` everywhere, so the
    // source advances by `speed` per project frame (1:1 at speed 1).
    for (let i = 0; i < maxLength; i++) out.push(sourceIn + i * speed);
    return out;
  }
  let acc = 0;
  for (let i = 0; i < maxLength; i++) {
    if (i === 0) {
      out.push(sourceIn);
      continue;
    }
    // Trapezoid: average of the EFFECTIVE rate (speed × ramp) at CLIP OFFSETS
    // (i - 1) and i, each evaluated by linear interpolation of the rate curve
    // with `hold` outside the first/last keyframe. Offsets, not absolute
    // frames — see the note in retimedOffsetFrames.
    const ra = rateAtOffsetWithRamp(layer, ramp, i - 1);
    const rb = rateAtOffsetWithRamp(layer, ramp, i);
    acc += (ra + rb) / 2;
    out.push(sourceIn + acc);
  }
  return out;
};

// Linear-interp the rate curve at a CLIP-RELATIVE offset (0 = the clip's first
// frame), with `hold` outside the first/last keyframe. Used by
// `buildSourceFrameTable`'s trapezoidal integrator and by `sourceFrameFor`'s
// extrapolation tail.
const rateAtClipOffset = (
  ramp: Array<{ frame: number; rate: number }>,
  offset: number,
): number => {
  if (ramp.length === 0) return 1;
  if (offset <= ramp[0].frame) return ramp[0].rate;
  if (offset >= ramp[ramp.length - 1].frame) {
    return ramp[ramp.length - 1].rate;
  }
  for (let i = 1; i < ramp.length; i++) {
    const a = ramp[i - 1];
    const b = ramp[i];
    if (offset <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.rate;
      const t = (offset - a.frame) / span;
      return a.rate + (b.rate - a.rate) * t;
    }
  }
  return ramp[ramp.length - 1].rate;
};

// Rebase a rate curve onto a NEW ORIGIN, preserving the rate the curve actually
// had there. This is the one correct way to re-anchor a ramp — used when a
// split hands the right half its own start, and when the v5→v6 migration moves
// absolute frames onto the clip's start.
//
// The naive version (filter to keyframes at/after the origin, subtract) is
// WRONG in two ways, both silent:
//   • every keyframe before the origin ⇒ an EMPTY ramp, and an empty ramp is
//     rate 1, not the held tail. A clip ramped into slow motion, split after
//     the ramp, lost its slow motion entirely and its length collapsed.
//   • a keyframe straddling the origin ⇒ the first survivor's rate holds
//     BACKWARDS to the origin, so the curve starts at the wrong rate and the
//     seam jumps.
// Seeding offset 0 with the interpolated rate at the origin fixes both, and is
// exactly behaviour-preserving: the curve is unchanged, only its coordinates.
export const rebaseRamp = (
  ramp: ReadonlyArray<{ frame: number; rate: number }>,
  originFrame: number,
): Array<{ frame: number; rate: number }> => {
  if (ramp.length === 0) return [];
  // SORT before sampling. `rateAtClipOffset` indexes ramp[0] / ramp[last] and
  // so requires sorted input — every other consumer gets that from
  // `resolveSpeedKeyframes`, and this is the one sampler that doesn't. The
  // schema puts no ordering constraint on the stored array, so an externally
  // written project can arrive unsorted; sampling it raw reintroduces exactly
  // the seam-jump this function exists to prevent.
  const sorted = [...ramp].sort((a, b) => a.frame - b.frame);
  const after = sorted
    .filter((kf) => kf.frame > originFrame)
    .map((kf) => ({ frame: Math.round(kf.frame - originFrame), rate: kf.rate }));
  // When the origin is at or before the curve's start the leading rate already
  // holds backwards, so a seed would only add a keyframe the user never wrote.
  if (originFrame <= sorted[0].frame) {
    return [
      { frame: Math.max(0, Math.round(sorted[0].frame - originFrame)), rate: sorted[0].rate },
      ...after.filter((kf) => kf.frame > Math.round(sorted[0].frame - originFrame)),
    ];
  }
  // A keyframe landing exactly ON the origin is represented by the seed.
  return [{ frame: 0, rate: rateAtClipOffset(sorted, originFrame) }, ...after];
};

// Map a project-timeline frame to the source-frame for a given video layer,
// honouring the layer's rate curve (constant `speed` and/or `speed_keyframes`).
// `table` is the cached output of `buildSourceFrameTable(layer, …)`; supply
// null to fall back to the closed-form constant-rate mapping (correct whenever
// the layer has no ramp, including at speed ≠ 1). Returns a float source-frame;
// callers convert to seconds via `/ FPS` (or to an integer via Math.floor).
export const sourceFrameFor = (
  layer: VideoLayer,
  timelineFrame: number,
  table: number[] | null,
): number => {
  const tStart = layer.timeline_start_frame ?? 0;
  const idx = timelineFrame - tStart;
  if (idx < 0) return layer.source_in_frame ?? 0;
  if (!table || table.length === 0) {
    return (layer.source_in_frame ?? 0) + idx * layerSpeed(layer);
  }
  if (idx < table.length) return table[idx];
  // Past the table — extrapolate at the curve's (held) tail rate.
  const last = table[table.length - 1];
  const tailRate = layerRateAtFrame(layer, tStart + table.length - 1);
  return last + (idx - (table.length - 1)) * tailRate;
};

// Inverse of `sourceFrameFor`: how many PROJECT frames into the clip a given
// SOURCE frame plays. Consuming `n` source frames takes exactly as long as a
// clip whose trimmed span is `n` — so this shares `retimedWindowFrames`'
// integrator, which keeps the inverse consistent with the window by
// construction (a separately derived inverse would drift on ramps and misplace
// captions). Un-floored, unlike the window: an offset of 0 is meaningful.
export const timelineOffsetForSourceFrame = (
  layer: VideoLayer,
  sourceFrame: number,
): number => {
  const advance = sourceFrame - (layer.source_in_frame ?? 0);
  if (!(advance > 0)) return 0;
  return retimedOffsetFrames(layer, advance);
};

// The OTHER direction, and the one every editing operation needs: the SOURCE
// frame playing `offsetFrames` into the clip's on-timeline window.
//
// This is the conversion that must be used whenever a timeline delta (a cut
// point, a split point, a caption chip's committed position, a trim drag) is
// written into `source_in_frame` / `source_out_frame`. Doing it 1:1 is only
// correct at speed 1 — at 2x a one-frame move on the timeline is TWO source
// frames — and getting it wrong silently corrupts the clip rather than
// failing, which is why every such site routes through here.
// `test/source-timeline-mapping-call-sites.test.ts` budgets the exceptions.
export const sourceFrameAtTimelineOffset = (
  layer: VideoLayer,
  offsetFrames: number,
): number => {
  const sourceIn = layer.source_in_frame ?? 0;
  if (!(offsetFrames > 0)) return sourceIn;
  const ramp = resolveSpeedKeyframes(layer);
  if (ramp.length === 0) {
    return Math.round(sourceIn + offsetFrames * layerSpeed(layer));
  }
  const table = buildSourceFrameTable(layer, Math.ceil(offsetFrames) + 1);
  return Math.round(sourceFrameFor(layer, (layer.timeline_start_frame ?? 0) + offsetFrames, table));
};

// Inverse of `sourceFrameFor` for a moment in the clip's SOURCE timeline given
// in seconds (e.g. a transcript word's `start`): the PROJECT-timeline frame
// where that moment plays, honouring the layer's trim (`source_in_frame`), its
// placement (`timeline_start_frame`) and its rate curve.
export const projectFrameForSourceSeconds = (
  layer: VideoLayer,
  seconds: number,
  fps = 30,
): number => {
  const tStart = layer.timeline_start_frame ?? 0;
  return Math.round(tStart + timelineOffsetForSourceFrame(layer, seconds * fps));
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

// ───────────────────────────────────────────────────────────────────────────
// EDGE TRANSITIONS
//
// One end of a layer's on-timeline window: how it enters (`transition_in`) or
// leaves (`transition_out`). See `perElementDataFields.transition_in` for why
// this is edge-relative data rather than keyframes, and src/transitions.ts for
// the evaluation.
//
// `frames` is the RAMP LENGTH, and it is a REQUEST, not a guarantee: when the
// window is shorter than in + out the two are squeezed proportionally at
// sample time (`resolveEdgeFrames`) and the stored values are left alone — so
// trimming a layer down and back out restores the transition the user asked
// for instead of quietly destroying it.
//
// `kind: "cut"` (or `frames: 0`) is the hard cut — the historical behavior, and
// the default for video clips, where a hard cut is the grammar of the format
// rather than a defect.
// ───────────────────────────────────────────────────────────────────────────
export const transitionKindSchema = z.enum(["cut", "fade", "slide", "pop"]);
export type TransitionKind = z.infer<typeof transitionKindSchema>;

// Where a "slide" travels. On the IN edge this is where the layer comes FROM;
// on the OUT edge, where it goes TO — so "left" reads the same way in both
// rows of the Inspector.
export const transitionDirectionSchema = z.enum(["left", "right", "up", "down"]);
export type TransitionDirection = z.infer<typeof transitionDirectionSchema>;

export const edgeTransitionSchema = z
  .object({
    kind: transitionKindSchema,
    frames: z.number().int().nonnegative(),
    // Shaping curve over the ramp. Omitted ⇒ the per-kind default in
    // src/transitions.ts (DEFAULT_CURVE_IN / DEFAULT_CURVE_OUT).
    curve: easingSchema.optional(),
    // "slide" only; ignored by every other kind.
    direction: transitionDirectionSchema.optional(),
  })
  .strict();
export type EdgeTransition = z.infer<typeof edgeTransitionSchema>;

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
//
// `denoiseStrength` (0..1, absent ⇒ 1) is the clean-strength wet/dry mix:
// while the cleaned track is active, playback blends strength × cleaned with
// (1 − strength) × original. Both files come from the same decoded source
// buffer (same encoder, latency-trimmed), so they are sample-aligned and the
// blend is a plain per-source gain. `overlayPlaybackMix` is the resolver every
// playback surface uses.
//
// `sourceLayerId` welds the overlay to the video layer it was split out of
// (the element-id form, "video.<id>"). When set, the editor renders the
// overlay as a waveform footer ON that clip instead of a standalone bottom
// row, and drags it with the clip. Clip audio is ALWAYS welded — there is no
// detach: to silence a clip the user mutes it, and separate music / voiceover
// tracks are the only overlays that stay standalone. Absent on those
// standalone tracks; legacy split overlays created before the link existed are
// healed back onto their clip on load (see migrateWeldClipAudio) so they never
// resurface as a stray bottom lane.
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
    denoiseStrength: z.number().min(0).max(1).optional(),
    sourceLayerId: z.string().min(1).optional(),
  })
  .strict();

export type AudioOverlay = z.infer<typeof audioOverlaySchema>;

// The audio asset an overlay plays right now: the cleaned track when one
// exists and the user hasn't flipped it back (absent/true ⇒ cleaned), else
// the original. Legacy overlays (no `denoisedFilename`) resolve to `filename`.
export const activeOverlayFilename = (o: AudioOverlay): string =>
  o.denoisedFilename && o.useDenoised !== false ? o.denoisedFilename : o.filename;

// The file preview playback should actually use: the active choice, except
// that a cleaned sibling KNOWN to be unfetchable (its asset is missing from
// R2 — the player marks it after the bounded fetch/decode retries give up)
// falls back to the ORIGINAL so audio keeps playing instead of going silent
// while the session grinds 404s. Never falls back the other way: a missing
// ORIGINAL has nothing better to offer.
export const resolveOverlayPlaybackFilename = (
  o: AudioOverlay,
  missing: ReadonlySet<string>,
): string => {
  const active = activeOverlayFilename(o);
  if (active !== o.filename && missing.has(active)) return o.filename;
  return active;
};

// The clean strength newly-imported overlays get when a cleaned track is
// attached: mostly clean, with a slice of the original blended back so the
// denoiser's residual artifacts (musical noise, chopped quiet syllables) stay
// masked and the voice keeps its air. ≈ −20 dB residual noise floor.
export const DEFAULT_DENOISE_STRENGTH = 0.9;

// One weighted source in an overlay's playback mix. Weights sum to 1.
export type OverlayMixEntry = { filename: string; weight: number };

// The weighted set of files an overlay actually plays — the wet/dry
// clean-strength mix. While the cleaned track is active and 0 < strength < 1
// this is two entries (cleaned at `strength`, original at the remainder);
// strength 1 / absent, an inactive or missing cleaned sibling, and legacy
// overlays all collapse to a single full-weight entry, preserving their exact
// pre-mix behavior. Preview and export both resolve through this so they can
// never drift.
export const overlayPlaybackMix = (
  o: AudioOverlay,
  missing?: ReadonlySet<string>,
): OverlayMixEntry[] => {
  const active = missing
    ? resolveOverlayPlaybackFilename(o, missing)
    : activeOverlayFilename(o);
  if (active === o.filename) return [{ filename: o.filename, weight: 1 }];
  const strength = o.denoiseStrength ?? 1;
  if (strength >= 1) return [{ filename: active, weight: 1 }];
  if (strength <= 0) return [{ filename: o.filename, weight: 1 }];
  return [
    { filename: active, weight: strength },
    { filename: o.filename, weight: 1 - strength },
  ];
};

// The video layer a welded overlay was split out of, or null when the overlay
// is standalone / the weld dangles (its source layer was re-id'd or removed).
export const weldedSourceLayer = (
  overlay: AudioOverlay,
  videoLayers: readonly VideoLayer[],
): VideoLayer | null => {
  const src = overlay.sourceLayerId;
  if (!src || !src.startsWith("video.")) return null;
  const id = src.slice("video.".length);
  return videoLayers.find((v) => v.id === id) ?? null;
};

// A welded overlay's playback timing is DERIVED from its source clip — the
// audio IS the clip's audio, so trimming the clip (from the timeline, the
// Inspector, or a headless tool call) retimes what's heard with no
// stored-field bookkeeping. Returns null only when the overlay is standalone
// or the weld dangles (source layer re-id'd / removed); otherwise:
//
//   - `originFrame` — the project frame where audio-FILE time 0 sits:
//     timeline_start − source_in. The demuxed file starts at source frame 0,
//     so this is the sync anchor for buffer offsets. MAY BE NEGATIVE (a clip
//     at the comp head with its first frames trimmed off) — which is exactly
//     why it's derived: the stored nonnegative `startFrame` can't express it.
//   - `startFrame` — audible start: the clip's timeline start.
//   - `endFrame` — audible end (exclusive), or null when unknowable (natural
//     duration unknown AND source_out_frame null — capping there would
//     silence real audio; callers fall back to the buffer's natural extent).
//
// `naturalSecondsOf` supplies the source's natural duration where the caller
// knows it (loaded <video> metadata / a decoded buffer); return undefined
// when it doesn't.
export const weldedAudioTiming = (
  overlay: AudioOverlay,
  videoLayers: readonly VideoLayer[],
  naturalSecondsOf: (layer: VideoLayer) => number | undefined,
): { originFrame: number; startFrame: number; endFrame: number | null } | null => {
  const layer = weldedSourceLayer(overlay, videoLayers);
  if (!layer) return null;
  const startFrame = Math.max(0, layer.timeline_start_frame);
  const originFrame = startFrame - Math.max(0, layer.source_in_frame);
  const natural = naturalSecondsOf(layer);
  let sourceSeconds: number | null;
  if (natural !== undefined && Number.isFinite(natural) && natural > 0) {
    sourceSeconds = natural;
  } else if (layer.source_out_frame !== null) {
    // `videoWindow` clamps the out-point to the duration handed in, so the
    // explicit out-point itself bounds the window exactly.
    sourceSeconds = layer.source_out_frame / 30;
  } else {
    sourceSeconds = null;
  }
  if (sourceSeconds === null) return { originFrame, startFrame, endFrame: null };
  const win = videoWindow(layer, sourceSeconds);
  return { originFrame, startFrame: win.startFrame, endFrame: win.endFrame };
};

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

// The literal name `add_caption_track` / `buildCaptionsForClip` give the group
// they wrap caption lines in. The single marker every surface keys off — the
// producer (tools/captions.ts) stamps it, the Timeline + Inspector fold on it,
// and captions.ts keys idempotency off it — so it never drifts.
export const CAPTIONS_GROUP_NAME = "captions";

// True when a group is an auto-generated caption-track wrapper (the "captions"
// group). Kept deliberately tight — matched by name only — so ordinary user
// groups never fold into a caption lane. The single source of truth for "is
// this a caption track" across the Timeline lane fold, the Inspector layer
// list, and the captioning idempotency guard.
export const isCaptionsGroup = (
  group: { name?: string } | null | undefined,
): boolean =>
  (group?.name ?? "").trim().toLowerCase() === CAPTIONS_GROUP_NAME;

// True when `elementId` is a CAPTION LINE: a text layer carrying a weld
// anchor (caption_source), or one living inside a "captions" group (the
// standalone block flavour). The single source of truth for "is this element
// a caption line" across the pure tools (split/merge), the editor's split
// target resolution, and the clip-action surfaces.
export const isCaptionLineElement = (
  project: Composition,
  elementId: string,
): boolean => {
  if (!elementId.startsWith("text.")) return false;
  const bare = elementId.slice("text.".length);
  const tl = project.text_layers.find((t) => t.id === bare);
  if (!tl) return false;
  if (tl.caption_source) return true;
  for (const g of project.groups ?? []) {
    if (g.children.includes(elementId)) return isCaptionsGroup(g);
  }
  return false;
};

// Schema version. Bumped when on-disk JSON gains a meaning that older
// readers can't infer:
//   1 = post-rev1-migration shape with top-left anchored x/y (legacy).
//   2 = (x, y) on image_layers / shapes / clip_inset is the CENTRE of the
//       bounding box. migrateProject converts < 2 → 2.
//   3 = PAGES-ONLY model: a project is `{ …meta, canvas_width,
//       canvas_height, active_index, pages[≥1] }`. The old top-level
//       composition arrays + `mode` + `carousel` are gone — migrateToPages
//       folds them into `pages`. See migrateToPages below.
//   4 = Video layers carry a `lane_id` (track grouping). Clips that
//       share a lane_id are one visual track laid end-to-end. migrateAssignLaneIds
//       backfills every pre-v4 clip lacking one with its own lane (lane_id = id),
//       so the migration is behaviour-preserving (1 clip = 1 lane). See below.
//   5 = Video layers carry `speed` (constant playback rate, default 1).
//       No data migration is needed — `.default(1)` fills it on parse and 1 is
//       the previous behaviour exactly — but the bump is NOT optional: the
//       schema is `.strict()`, so once a v4 project is loaded and saved it
//       carries the new key, and v4 code would reject it as unknown. Bumping
//       makes that visible instead of letting the version number lie. As with
//       v3→v4, this is ROLL-FORWARD-ONLY on prod (see dev-docs/editor-gotchas.md).
//   6 = current. `speed_keyframes[].frame` is CLIP-RELATIVE (0 = the clip's
//       first frame) instead of an absolute project frame, so a ramped clip's
//       derived length no longer depends on where the clip sits.
//       migrateSpeedKeyframesToClipRelative subtracts `timeline_start_frame`
//       from each keyframe, which preserves behaviour for every project as it
//       stands. ROLL-FORWARD-ONLY, like every bump (dev-docs/editor-gotchas.md).
export const SCHEMA_VERSION = 6 as const;

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

// ---------------------------------------------------------------------------
// Shared composition reflow — used by the v3 migrator (below) and the
// set_canvas_size tool (src/tools.ts) so both fit content to a new canvas
// IDENTICALLY. Uniform fit-scale s = min(newW/oldW, newH/oldH) about the
// centre, then recentre so the old centre maps to the new centre — nothing
// distorts (a circle stays a circle). Leaf x/y are absolute positions
// (affine-mapped); width/height scale by s; a group's pivot is an absolute
// point (mapped) but its x/y keyframes are translation offsets (scale only).
// A pinned backdrop always fills the canvas. Mutates the layer arrays in place.
type ReflowLeaf = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  is_background?: boolean;
  animations?: {
    x?: { value: number }[];
    y?: { value: number }[];
    width?: { value: number }[];
    height?: { value: number }[];
  };
};
type ReflowGroup = {
  pivotX?: number;
  pivotY?: number;
  box_width?: number;
  box_height?: number;
  animations?: Record<string, { value: number }[] | undefined>;
};
type ReflowComposition = {
  image_layers?: ReflowLeaf[];
  video_layers?: ReflowLeaf[];
  text_layers?: ReflowLeaf[];
  shapes?: ReflowLeaf[];
  groups?: ReflowGroup[];
};

export const reflowCompositionLayers = (
  comp: ReflowComposition,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): void => {
  if (oldW <= 0 || oldH <= 0 || (oldW === newW && oldH === newH)) return;
  const s = Math.min(newW / oldW, newH / oldH);
  const mapX = (v: number): number => (v - oldW / 2) * s + newW / 2;
  const mapY = (v: number): number => (v - oldH / 2) * s + newH / 2;
  const reflowLeaf = (r: ReflowLeaf | undefined): void => {
    if (!r) return;
    if (r.is_background) {
      r.x = newW / 2;
      r.y = newH / 2;
      r.width = newW;
      r.height = newH;
      return;
    }
    if (typeof r.x === "number") r.x = mapX(r.x);
    if (typeof r.y === "number") r.y = mapY(r.y);
    if (typeof r.width === "number") r.width *= s;
    if (typeof r.height === "number") r.height *= s;
    const t = r.animations;
    if (!t) return;
    if (t.x) for (const kf of t.x) kf.value = mapX(kf.value);
    if (t.y) for (const kf of t.y) kf.value = mapY(kf.value);
    if (t.width) for (const kf of t.width) kf.value *= s;
    if (t.height) for (const kf of t.height) kf.value *= s;
  };
  for (const l of comp.image_layers ?? []) reflowLeaf(l);
  for (const l of comp.video_layers ?? []) reflowLeaf(l);
  for (const l of comp.shapes ?? []) reflowLeaf(l);
  for (const l of comp.text_layers ?? []) reflowLeaf(l);
  for (const g of comp.groups ?? []) {
    if (!g) continue;
    if (typeof g.pivotX === "number") g.pivotX = mapX(g.pivotX);
    if (typeof g.pivotY === "number") g.pivotY = mapY(g.pivotY);
    if (typeof g.box_width === "number") g.box_width *= s;
    if (typeof g.box_height === "number") g.box_height *= s;
    const t = g.animations;
    if (!t) continue;
    for (const prop of ["x", "y", "width", "height"] as const) {
      const kfs = t[prop];
      if (kfs) for (const kf of kfs) kf.value *= s;
    }
  }
};

// ---------------------------------------------------------------------------
// v2 → v3: unify to the PAGES-ONLY model.
//
// Pre-v3 a project stored its composition TWO ways at once: the top-level layer
// arrays (the "video" composition) AND an optional `carousel.pages[]`, switched
// by a `mode` flag. Nothing enforced "exactly one is populated", so half-
// migrated hybrids existed in prod (a real 9:16 top-level video carrying an
// orphaned 4:5 carousel page). v3 removes the split: every project is
// `{ …meta, canvas_width, canvas_height, active_index, pages[≥1] }`, each page a
// full composition. This migrator folds the old shape into `pages`:
//   • plain video           → pages = [ topLevelComposition ]
//   • carousel (empty top)   → pages = carousel.pages (carry active_index)
//   • hybrid (both present)  → pages = [ topLevelComposition, …carousel.pages ]
// then reflows any page whose own backdrop diverges from the project canvas (the
// orphaned 4:5 page in a 9:16 project) so every page fits the ONE canvas. Runs
// OUTERMOST — after the per-element/background/blocks migrators have normalised
// the flat composition — so folded pages already carry current-shape layers.
// Idempotent: an already-v3 record (has `pages`) is normalised and returned.
const PAGE_COMP_FIELDS = [
  "image_layers",
  "video_layers",
  "text_layers",
  "shapes",
  "groups",
  "layer_order",
  "audio_overlays",
  "duration_seconds",
  "duration_authored",
  "start_at",
  "markers",
  "loop",
  "loop_start_frame",
  "loop_end_frame",
] as const;

const hasNonBackgroundContent = (r: Record<string, unknown>): boolean =>
  ["image_layers", "video_layers", "text_layers", "shapes", "groups"].some(
    (f) =>
      Array.isArray(r[f]) &&
      (r[f] as unknown[]).some(
        (l) => l && typeof l === "object" && !(l as { is_background?: boolean }).is_background,
      ),
  );

// A page's implied canvas = its pinned background layer's box (the backdrop
// always fills the canvas). null when there's no such layer.
const impliedCanvasOf = (
  page: Record<string, unknown>,
): { w: number; h: number } | null => {
  const imgs = page.image_layers;
  if (!Array.isArray(imgs)) return null;
  const bg = imgs.find(
    (l) => l && typeof l === "object" && (l as { is_background?: boolean }).is_background,
  ) as { width?: unknown; height?: unknown } | undefined;
  if (!bg) return null;
  const { width: w, height: h } = bg;
  return typeof w === "number" && typeof h === "number" && w > 0 && h > 0
    ? { w, h }
    : null;
};

const makePage = (
  src: Record<string, unknown>,
  name: unknown,
): Record<string, unknown> => {
  const page: Record<string, unknown> = {};
  for (const f of PAGE_COMP_FIELDS) if (f in src) page[f] = src[f];
  page.id =
    typeof src.id === "string" && src.id.length > 0
      ? src.id
      : crypto.randomUUID();
  if (typeof name === "string" && name.length > 0) page.name = name;
  return page;
};

// Stamp the fallback canvas onto a page that carries no dims of its own — a
// page written before canvas size moved from the project onto the page. A page
// that already has its own size keeps it.
const sizePage = (
  page: Record<string, unknown>,
  fallbackW: number,
  fallbackH: number,
): void => {
  if (typeof page.canvas_width !== "number" || page.canvas_width <= 0)
    page.canvas_width = fallbackW;
  if (typeof page.canvas_height !== "number" || page.canvas_height <= 0)
    page.canvas_height = fallbackH;
};

const migrateToPages = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };

  const canvasW =
    typeof r.canvas_width === "number" && r.canvas_width > 0 ? r.canvas_width : 1080;
  const canvasH =
    typeof r.canvas_height === "number" && r.canvas_height > 0
      ? r.canvas_height
      : 1920;

  // Already v3 — normalise (drop any lingering legacy keys, ensure
  // active_index) and push the project canvas down onto any page that predates
  // per-page sizing.
  if (Array.isArray(r.pages)) {
    for (const f of PAGE_COMP_FIELDS) delete r[f];
    delete r.mode;
    delete r.carousel;
    for (const pg of r.pages) {
      if (pg && typeof pg === "object") sizePage(pg as Record<string, unknown>, canvasW, canvasH);
    }
    delete r.canvas_width;
    delete r.canvas_height;
    if (typeof r.active_index !== "number" || r.active_index < 0)
      r.active_index = 0;
    r.schema_version = SCHEMA_VERSION;
    return r;
  }

  const carousel =
    r.carousel && typeof r.carousel === "object"
      ? (r.carousel as { pages?: unknown; active_index?: unknown })
      : null;
  const carouselPages: Record<string, unknown>[] =
    carousel && Array.isArray(carousel.pages)
      ? (carousel.pages.filter(
          (p) => p && typeof p === "object",
        ) as Record<string, unknown>[])
      : [];

  const pages: Record<string, unknown>[] = [];
  let activeIndex = 0;

  if (carouselPages.length > 0) {
    if (hasNonBackgroundContent(r)) {
      // Hybrid: the top level is a real composition — keep it as page 0, then
      // the carousel pages follow.
      pages.push(makePage(r, r.name));
      for (const pg of carouselPages) pages.push(makePage(pg, pg.name));
      activeIndex = 0;
    } else {
      // Pure carousel: the top level was emptied — carousel pages ARE the project.
      for (const pg of carouselPages) pages.push(makePage(pg, pg.name));
      const ci =
        carousel && typeof carousel.active_index === "number"
          ? carousel.active_index
          : 0;
      activeIndex = Math.max(0, Math.min(ci, pages.length - 1));
    }
  } else {
    // Plain video (or an empty project) → a single page from the top level.
    pages.push(makePage(r, r.name));
    activeIndex = 0;
  }

  // Fit any page whose backdrop diverges from the project canvas, then give
  // every page that project canvas as its own. Pre-pages projects had exactly
  // one shared size, so folding it onto each page is appearance-preserving —
  // the pages only diverge once a user resizes one.
  for (const pg of pages) {
    const implied = impliedCanvasOf(pg);
    if (implied && (implied.w !== canvasW || implied.h !== canvasH)) {
      reflowCompositionLayers(pg, implied.w, implied.h, canvasW, canvasH);
    }
    sizePage(pg, canvasW, canvasH);
  }

  for (const f of PAGE_COMP_FIELDS) delete r[f];
  delete r.mode;
  delete r.carousel;
  delete r.canvas_width;
  delete r.canvas_height;
  r.pages = pages;
  r.active_index = activeIndex;
  r.schema_version = SCHEMA_VERSION;
  return r;
};

// Backfill `lane_id` on every video layer that lacks one (SCHEMA_VERSION 4).
// A lane groups the clips of one visual track; a project written before v4 has
// no lanes, so each existing clip becomes its OWN lane (lane_id = its own id) —
// exactly today's 1-clip-per-lane world. Runs on the FINAL pages shape (after
// migrateToPages), so it sees every page's own `video_layers`. Idempotent: a
// layer that already carries a lane_id is left untouched, so re-parsing a v4
// project is a no-op (and any clip added later without a lane heals on load).
const migrateAssignLaneIds = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    if (!Array.isArray(page.video_layers)) continue;
    for (const layerRaw of page.video_layers) {
      if (!layerRaw || typeof layerRaw !== "object") continue;
      const layer = layerRaw as Record<string, unknown>;
      if (typeof layer.lane_id === "string" && layer.lane_id.length > 0) continue;
      if (typeof layer.id === "string" && layer.id.length > 0) {
        layer.lane_id = layer.id;
      }
    }
  }
  return r;
};

// v5→v6: rebase speed-ramp keyframes from ABSOLUTE project frames onto
// CLIP-RELATIVE offsets. v5 stored them absolute, which made a ramped clip's
// derived length depend on where it sat (see the field comment). Subtracting
// `timeline_start_frame` preserves each keyframe's meaning exactly for a clip
// at its current position, so the migration is behaviour-preserving for every
// project as it stands; only a LATER move behaves differently (correctly).
//
// Idempotent by construction? No — subtracting twice would be wrong, so it is
// gated on the record's stored `schema_version`. Runs on the FINAL pages shape.
const migrateSpeedKeyframesToClipRelative = (
  raw: unknown,
  fromVersion: number,
): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  // Gated on the version of the RECORD AS IT ARRIVED, captured before the
  // chain runs — `migrateToPages` stamps `schema_version` to current on its way
  // through, so reading the field here would always say "already v6" and the
  // rebase would silently never happen.
  if (fromVersion >= 6) return r;
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    if (!Array.isArray(page.video_layers)) continue;
    for (const layerRaw of page.video_layers) {
      if (!layerRaw || typeof layerRaw !== "object") continue;
      const layer = layerRaw as Record<string, unknown>;
      if (!Array.isArray(layer.speed_keyframes)) continue;
      const tStart =
        typeof layer.timeline_start_frame === "number"
          ? Math.max(0, layer.timeline_start_frame)
          : 0;
      if (tStart === 0) continue; // already equivalent
      // REBASE, don't clamp. Subtracting and clamping at 0 collapses every
      // pre-start keyframe onto offset 0, so a curve that STRADDLES the clip's
      // start (reachable: v5's add_speed_keyframe took any project frame, and
      // moving a ramped clip right left its keyframes behind) began at the
      // wrong rate — measured a 39% duration change on first load. `rebaseRamp`
      // seeds offset 0 with the rate the curve actually had at the clip's
      // start, which IS behaviour-preserving.
      const parsed = layer.speed_keyframes
        .filter((k): k is { frame: number; rate: number } =>
          !!k && typeof k === "object" &&
          typeof (k as { frame?: unknown }).frame === "number" &&
          typeof (k as { rate?: unknown }).rate === "number",
        )
        .map((k) => ({ frame: k.frame, rate: k.rate }))
        .sort((x, y) => x.frame - y.frame);
      if (parsed.length === 0) continue;
      layer.speed_keyframes = rebaseRamp(parsed, tStart);
    }
  }
  return r;
};

// Heal legacy clip-audio overlays into welded footers. Clip audio is always
// welded to its clip (it renders as a waveform footer on the clip bar, drags
// with it, and is muted/added-to, never detached). Before the weld existed,
// importing a video demuxed its audio into a STANDALONE overlay (no
// `sourceLayerId`) and muted the clip — which now shows as a stray bottom lane,
// a bug. This reconciles those overlays back onto their clip on every load:
// per page, a standalone overlay whose `filename` starts with a MUTED video
// layer's clip stem (the demux signature — the clip is muted precisely because
// its audio was split out) and whose clip has no overlay welded to it yet is
// welded to that layer (sourceLayerId = "video.<id>"). Genuine music /
// voiceover — no stem match, or an UNMUTED clip — is left standalone. Runs on
// the FINAL pages shape (after migrateToPages), so it sees every page's own
// arrays. Idempotent: an already-welded overlay is skipped, so re-parsing (and
// new imports, welded on upload) is a no-op.
const migrateWeldClipAudio = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    if (!Array.isArray(page.audio_overlays)) continue;
    if (!Array.isArray(page.video_layers)) continue;
    const overlays = page.audio_overlays as Record<string, unknown>[];
    const layers = page.video_layers as Record<string, unknown>[];
    // Clips that already own a welded overlay — never double-weld.
    const weldedLayerIds = new Set<string>();
    for (const ov of overlays) {
      if (!ov || typeof ov !== "object") continue;
      const src = ov.sourceLayerId;
      if (typeof src === "string" && src.startsWith("video.")) {
        weldedLayerIds.add(src.slice("video.".length));
      }
    }
    for (const ov of overlays) {
      if (!ov || typeof ov !== "object") continue;
      // Only standalone overlays are candidates.
      if (typeof ov.sourceLayerId === "string" && ov.sourceLayerId.length > 0) {
        continue;
      }
      const filename = ov.filename;
      if (typeof filename !== "string") continue;
      const match = layers.find((layer) => {
        if (!layer || typeof layer !== "object") return false;
        if (layer.muted !== true) return false; // demux signature
        const id = layer.id;
        const clip = layer.clip;
        if (typeof id !== "string" || id.length === 0) return false;
        if (typeof clip !== "string" || clip.length === 0) return false;
        if (weldedLayerIds.has(id)) return false;
        const stem = clip.replace(/\.[^.]+$/, "");
        return stem.length > 0 && filename.startsWith(stem);
      });
      if (match) {
        const id = match.id as string;
        ov.sourceLayerId = `video.${id}`;
        weldedLayerIds.add(id);
      }
    }
  }
  return r;
};

// Retro-anchor legacy caption tracks onto the clip they follow. Before caption
// welding, a caption line stored a FIXED project-frame `block`, so trimming the
// clip left the captions behind. This heals those tracks on load: per page, for
// each text layer inside a "captions" group that lacks a `caption_source`
// anchor, find the clip the captions group was grouped with (buildCaptionsForClip
// wraps [video, captions] in a common parent group) and invert the line's block
// against that clip's CURRENT trim to recover the line's window in the clip's
// SOURCE timeline (source_start = block.start − timeline_start + source_in).
// After that the on-timeline window is derived live (deriveCaptionWindow), so
// trimming/sliding the clip retimes the captions. Assumes the clip wasn't
// retrimmed since captioning (the normal order: caption → then trim); the stored
// block is kept as a fallback for a dangling anchor. Runs on the final pages
// shape. Idempotent: a line that already has `caption_source` is skipped, so new
// (welded-at-creation) tracks and re-parses are a no-op.
//
// A second pass then RE-ROUTES mis-anchored lines: an earlier build welded every
// line of a montage to the lane's FIRST clip, so lines spoken in the later
// pieces sat outside that clip's source window and were culled (invisible).
// See the pass below for the exact rule.
const migrateWeldCaptions = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    if (!Array.isArray(page.groups)) continue;
    if (!Array.isArray(page.text_layers)) continue;
    if (!Array.isArray(page.video_layers)) continue;
    const groups = page.groups as Record<string, unknown>[];
    const textLayers = page.text_layers as Record<string, unknown>[];
    const videoLayers = page.video_layers as Record<string, unknown>[];
    for (const grp of groups) {
      if (!grp || typeof grp !== "object") continue;
      const name = typeof grp.name === "string" ? grp.name.trim().toLowerCase() : "";
      if (name !== CAPTIONS_GROUP_NAME) continue;
      const capId = grp.id;
      if (typeof capId !== "string" || !Array.isArray(grp.children)) continue;
      // The clip is a video sibling of this captions group in its parent group.
      const parent = groups.find(
        (g) =>
          g &&
          typeof g === "object" &&
          Array.isArray(g.children) &&
          (g.children as unknown[]).includes(`group.${capId}`),
      );
      const clipEid = parent
        ? ((parent.children as unknown[]).find(
            (c) => typeof c === "string" && c.startsWith("video."),
          ) as string | undefined)
        : undefined;
      if (!clipEid) continue;
      const clip = videoLayers.find((v) => v && v.id === clipEid.slice("video.".length));
      if (!clip) continue;
      const tStart = typeof clip.timeline_start_frame === "number" ? clip.timeline_start_frame : 0;
      const sourceIn = typeof clip.source_in_frame === "number" ? clip.source_in_frame : 0;
      for (const childId of grp.children as unknown[]) {
        if (typeof childId !== "string" || !childId.startsWith("text.")) continue;
        const tl = textLayers.find((t) => t && t.id === childId.slice("text.".length));
        if (!tl) continue;
        if (tl.caption_source && typeof tl.caption_source === "object") continue; // already welded
        const block = tl.block as { start?: unknown; duration?: unknown } | undefined;
        if (!block || typeof block.start !== "number" || typeof block.duration !== "number") {
          continue;
        }
        const sourceStart = Math.max(0, Math.round(block.start - tStart + sourceIn));
        tl.caption_source = {
          clip_element_id: clipEid,
          source_start_frame: sourceStart,
          source_end_frame: sourceStart + Math.max(1, Math.round(block.duration)),
        };
      }
    }

    // RE-ROUTE mis-anchored caption lines onto the lane clip that actually
    // shows their words. A montage (one source split into several clips) used to
    // get every line welded to the FIRST clip of the lane, so lines spoken in
    // the later pieces fell outside that clip's source window and were culled —
    // invisible captions. For each welded line whose anchor clip does NOT cover
    // its source window, pick the sibling clip (same source file) with the
    // greatest source-window overlap and re-anchor to it. Lines whose current
    // anchor already covers them are left alone, so a deliberate user
    // re-assignment is never overridden, and a line that no clip shows (words
    // cut out of the edit) keeps its anchor and stays culled.
    const coverage = (
      v: Record<string, unknown>,
      s: number,
      e: number,
    ): number => {
      const cin = typeof v.source_in_frame === "number" ? Math.max(0, v.source_in_frame) : 0;
      const cout =
        typeof v.source_out_frame === "number" ? v.source_out_frame : Number.POSITIVE_INFINITY;
      return Math.min(e, cout) - Math.max(s, cin);
    };
    for (const tl of textLayers) {
      if (!tl || typeof tl !== "object") continue;
      const cs = tl.caption_source as
        | { clip_element_id?: unknown; source_start_frame?: unknown; source_end_frame?: unknown }
        | undefined;
      if (!cs || typeof cs.clip_element_id !== "string") continue;
      if (
        typeof cs.source_start_frame !== "number" ||
        typeof cs.source_end_frame !== "number"
      ) {
        continue;
      }
      const anchorId = cs.clip_element_id.slice("video.".length);
      const anchor = videoLayers.find((v) => v && v.id === anchorId);
      if (!anchor) continue; // dangling anchor — leave for the block fallback
      const s = cs.source_start_frame;
      const e = cs.source_end_frame;
      if (coverage(anchor, s, e) > 0) continue; // already on a clip that shows it
      let best: Record<string, unknown> | null = null;
      let bestOverlap = 0;
      for (const v of videoLayers) {
        if (!v || typeof v !== "object" || v.clip !== anchor.clip) continue;
        const ov = coverage(v, s, e);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          best = v;
        }
      }
      if (best && bestOverlap > 0) {
        cs.clip_element_id = `video.${best.id as string}`;
      }
    }
  }
  return r;
};

// Convert legacy ALWAYS-PRESENT layers into real bounded clips where the author
// already expressed a window through the layer's opacity FADE. Before the
// clip/block model, a layer added to a project carried no `block` — the
// "always-present" sentinel — so it spanned however long the video ever became.
// A layer that fades DOWN to invisible (opacity ends at 0) has already told us
// when it should end; `deriveLegacyBlockFromOpacity` turns that into a
// `{ start: 0, duration }` block that bounds the growing TAIL while rendering
// frame-for-frame identically (start stays 0, so nothing is re-timed; the culled
// tail was already opacity-0). See that function for the full rationale and why
// the head is deliberately left open.
//
// Deliberately conservative: touches ONLY layers with NO stored block (never
// re-bounds a real clip), NEVER video (a clip's window IS its trim) and NEVER
// groups (a group's `block.start` is a band time-origin with subtree-wide
// effects). Skips caption lines (their window is DERIVED from the welded clip,
// not a stored block). A layer whose opacity yields no window (open tail /
// degenerate) is left untouched — unbounded already means "full length, and
// keeps growing", exactly right for a persistent background / watermark.
//
// Runs on the FINAL pages shape (after migrateToPages), so it heals both legacy
// flat projects (folded into pages upstream) and current pages-shaped ones on
// load. Idempotent: once a block is written the layer is skipped on re-parse,
// and a layer left unbounded re-derives null — so a second migration is a no-op.
const migrateDeriveLegacyBlocks = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  // Leaf layer kinds only — NOT video_layers, NOT groups (see doc comment).
  const arrays = ["image_layers", "text_layers", "shapes"];
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    for (const key of arrays) {
      const arr = page[key];
      if (!Array.isArray(arr)) continue;
      for (const layerRaw of arr) {
        if (!layerRaw || typeof layerRaw !== "object") continue;
        const layer = layerRaw as Record<string, unknown>;
        // Only ever bound an always-present layer; never re-bound a real clip.
        if (layer.block !== undefined && layer.block !== null) continue;
        // Captions derive their window from the clip they're welded to.
        if (layer.caption_source !== undefined && layer.caption_source !== null) {
          continue;
        }
        const derived = deriveLegacyBlockFromOpacity(
          layer as {
            animations?: { opacity?: { frame: number; value: number }[] };
          },
        );
        if (!derived) continue;
        layer.block = derived;
      }
    }
  }
  return r;
};

// Dissolve EMPTY captions groups on load. `removeCaptionLines` dissolves the
// wrapper it empties, but interrupted re-captioning has left zero-child
// "captions" groups behind — invisible on canvas yet surfacing as a phantom
// (often duplicate) "Captions" entry in the UI. An empty captions wrapper
// renders nothing by definition, so dropping it is pure cleanup: remove the
// group record and every reference to it (layer_order, other groups'
// children). Runs on the FINAL pages shape. Idempotent: a healed project has
// no empty captions group to match on re-parse.
const migrateDissolveEmptyCaptionsGroups = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    const groups = page.groups;
    if (!Array.isArray(groups)) continue;
    const emptyIds = new Set<string>();
    for (const gRaw of groups) {
      if (!gRaw || typeof gRaw !== "object") continue;
      const g = gRaw as Record<string, unknown>;
      if (!isCaptionsGroup(g as { name?: string })) continue;
      const children = Array.isArray(g.children) ? g.children : [];
      if (children.length === 0 && typeof g.id === "string") {
        emptyIds.add(`group.${g.id}`);
      }
    }
    if (emptyIds.size === 0) continue;
    page.groups = groups.filter(
      (gRaw) =>
        !(
          gRaw &&
          typeof gRaw === "object" &&
          emptyIds.has(`group.${(gRaw as Record<string, unknown>).id as string}`)
        ),
    );
    if (Array.isArray(page.layer_order)) {
      page.layer_order = page.layer_order.filter(
        (id) => !(typeof id === "string" && emptyIds.has(id)),
      );
    }
    for (const gRaw of page.groups as unknown[]) {
      if (!gRaw || typeof gRaw !== "object") continue;
      const g = gRaw as Record<string, unknown>;
      if (Array.isArray(g.children)) {
        g.children = g.children.filter(
          (id) => !(typeof id === "string" && emptyIds.has(id)),
        );
      }
    }
  }
  return r;
};

// Prune DANGLING child references on load — ids in a group's `children` that
// name a layer no longer in the project.
//
// A group's `children` is a list of ids, so it is a foreign key with nothing
// enforcing it. Any code path that removes a layer record has to also strip it
// from every group's `children`, and `replaceBand` didn't: re-pinning an
// embedded band to a newer version stripped the old band group and minted a new
// id, leaving the parent group pointing at an id that no longer resolved.
//
// The damage is worse than a cosmetic stale entry, because "this child cannot be
// resolved" is indistinguishable from "this child spans the whole composition"
// unless callers are careful (see deriveGroupWindow). A group whose only child
// was dangling read as always-present, which is why it lost its timeline
// handles. Prune the references so the group is honestly empty instead of
// mysteriously unbounded.
//
// Runs on the FINAL pages shape, and is idempotent: a healed project has no
// unresolvable id left to match. Deliberately prunes the REFERENCE only — it
// never deletes a group, because an emptied group may still carry the
// animation the user authored on it.
const migratePruneDanglingChildren = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return r;
  for (const pageRaw of r.pages) {
    if (!pageRaw || typeof pageRaw !== "object") continue;
    const page = pageRaw as Record<string, unknown>;
    if (!Array.isArray(page.groups)) continue;
    // Every element id the page actually contains.
    const present = new Set<string>();
    for (const [kind, key] of [
      ["image", "image_layers"],
      ["video", "video_layers"],
      ["text", "text_layers"],
      ["shapes", "shapes"],
      ["group", "groups"],
    ] as const) {
      const arr = page[key];
      if (!Array.isArray(arr)) continue;
      for (const l of arr) {
        if (l && typeof l === "object") {
          const id = (l as Record<string, unknown>).id;
          if (typeof id === "string") present.add(`${kind}.${id}`);
        }
      }
    }
    for (const gRaw of page.groups) {
      if (!gRaw || typeof gRaw !== "object") continue;
      const g = gRaw as Record<string, unknown>;
      if (!Array.isArray(g.children)) continue;
      g.children = g.children.filter(
        (id) => typeof id === "string" && present.has(id),
      );
    }
  }
  return r;
};

const preprocessProject = (raw: unknown): unknown => {
  // The incoming record's version, read BEFORE any migration rewrites it.
  const incomingVersion =
    raw && typeof raw === "object" && !Array.isArray(raw) &&
    typeof (raw as Record<string, unknown>).schema_version === "number"
      ? ((raw as Record<string, unknown>).schema_version as number)
      : 0;
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
  // The per-element-map migrators run first (they flatten onto each layer).
  // migrateToPages folds the now-current flat composition (plus any carousel
  // pages) into the `pages` array; migrateAssignLaneIds and migrateWeldClipAudio
  // run LAST, on that pages shape, so they see every page's video_layers +
  // audio_overlays (lanes backfilled, legacy clip audio welded to its footer).
  // migrateDeriveLegacyBlocks runs OUTERMOST — after migrateWeldCaptions has set
  // every caption's `caption_source`, so its caption skip is reliable, and on the
  // final pages shape so it reaches each page's own leaf layers.
  // migrateDissolveEmptyCaptionsGroups sits just outside migrateWeldCaptions:
  // welding never re-populates an empty wrapper, so dissolving after it is safe.
  // migratePruneDanglingChildren runs OUTSIDE the caption heals: dissolving an
  // empty captions group removes a group record, so pruning must come after it
  // to catch the references that removal leaves behind.
  return migratePruneDanglingChildren(
    migrateDeriveLegacyBlocks(
      migrateDissolveEmptyCaptionsGroups(
        migrateWeldCaptions(
          migrateWeldClipAudio(
            migrateSpeedKeyframesToClipRelative(
            migrateAssignLaneIds(
              migrateToPages(
                migrateGroupConstantTracksToBase(
                  migrateSharedGroupsToCollection(migrateLayersToBlocks(base)),
                ),
              ),
            ),
            incomingVersion,
            ),
          ),
        ),
      ),
    ),
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
// field defaults. Canvas dims are the PAGE's own — a project can hold a
// 1080×1920 story next to a 1920×1080 cut of the same idea — while uploaded
// assets resolve against the parent project id (one asset bucket).
export const pageCompositionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // This page's canvas dimensions in pixels. Drives the renderer, export,
    // and embed render size for THIS page only; resizing one page never
    // touches its siblings. Defaults to 1080×1920 (vertical 9:16). Projects
    // saved before per-page sizing carried these at the top level —
    // migrateToPages pushes them down onto every page.
    canvas_width: z.number().int().positive().default(1080),
    canvas_height: z.number().int().positive().default(1920),
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
      // The composition pages. A project is an ordered list of full
      // compositions (≥1); a single-page project is a plain "video", a
      // multi-page one is what used to be a "carousel". Each page (see
      // pageCompositionSchema) is a complete composition — its own layers,
      // timeline, duration, AND canvas dimensions — that can be a still OR a
      // video. There is no `mode` and no separate top-level composition: the
      // editor always edits `pages[active_index]`, and every render/export
      // path targets a page.
      pages: z.array(pageCompositionSchema).min(1),
      // Index of the page currently open in the editor. Persisted so reopening a
      // project lands on the same page; clamped into range on load.
      active_index: z.number().int().nonnegative().default(0),
      // Element ids (a leaf like "text.<id>" or a "group.<id>") the user has
      // added to their reusable COLLECTION from THIS project. A workspace
      // teammate — and the owner on their own solo projects — can drop a
      // self-contained COPY of one into another project (see list_collection /
      // add_from_collection); copies are immutable, nothing links back. Storing
      // ids (not a per-layer flag) lets ANY layer, not just groups, be
      // collected; ids whose layer was later deleted are simply skipped when the
      // collection is read. Default [] so existing projects parse unchanged.
      collection: z.array(z.string()).default([]),
      // NOTE: composition fields — canvas_width, canvas_height,
      // duration_seconds, duration_authored, start_at, audio_overlays,
      // markers, loop, loop_start_frame, loop_end_frame — live on each PAGE
      // (see pageCompositionSchema), not on the project. The project only
      // carries what's genuinely shared across pages (fonts, collection,
      // embed) plus per-project metadata.
      //
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
    })
    .strict(),
);

export type Easing = z.infer<typeof easingSchema>;
export type Keyframe = z.infer<typeof keyframeSchema>;
export type TrackProperty = z.infer<typeof trackPropertySchema>;
export type ElementTracks = z.infer<typeof elementTracksSchema>;
export type Animations = z.infer<typeof animationsSchema>;
export type Project = z.infer<typeof projectSchema>;
// A flat, single-composition VIEW of one page of a project — the shape the
// renderer and the pure tools operate on. It carries the page's composition
// (layers + timeline) plus the project-level context a render/tool needs
// (project_id, canvas dims, fonts, collection, embed). Built by
// compositionForPage() and folded back by writeCompositionBack() (src/
// carousel.ts). This is a pure selector, NOT stored state — the persisted
// Project is pages-only. Structurally it equals the pre-v3 flat Project, so the
// ~1000 `project.<field>` reads in the renderer/tools compile unchanged.
export type Composition = Omit<Project, "pages" | "active_index"> &
  Omit<PageComposition, "id" | "name">;
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
export const resolveDefaultTextSize = (project: Composition): number => {
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

const collectPresentIds = (project: Composition): Set<string> => {
  const present = new Set<string>();
  for (const v of project.video_layers) present.add(`video.${v.id}`);
  for (const s of project.shapes) present.add(`shapes.${s.id}`);
  for (const l of project.image_layers) present.add(`image.${l.id}`);
  for (const t of project.text_layers) present.add(`text.${t.id}`);
  for (const g of project.groups ?? []) present.add(`group.${g.id}`);
  return present;
};

const collectGroupedIds = (project: Composition): Set<string> => {
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
export const collectPinnedRootIds = (project: Composition): string[] =>
  project.image_layers
    .filter((l) => l.pinned === true)
    .map((l) => `image.${l.id}`);

// Root-level captions-group ids, in `groups` array order. The mirror of
// `collectPinnedRootIds` at the other end of the stack: these are forced to
// the TOP of the root z regardless of where `layer_order` mentions them
// (which silently ignores them), so captions can never be buried by a
// later-created group or layer. Only ROOT-level captions groups pin — one
// nested inside a user group keeps its parent's stacking (legacy projects
// wrapped [video, captions] in a shared parent; their transform/opacity
// scoping must keep meaning what it meant).
// Callers that already hold the grouped-id set (resolveLayerTree computes it
// per call, per rendered frame) pass it in; standalone callers omit it.
export const collectCaptionsRootIds = (
  project: Composition,
  grouped: Set<string> = collectGroupedIds(project),
): string[] =>
  (project.groups ?? [])
    .filter((g) => isCaptionsGroup(g) && !grouped.has(`group.${g.id}`))
    .map((g) => `group.${g.id}`);

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
//   - CAPTIONS groups at root are appended last (= top of z) regardless of
//     layer_order — the top-side mirror of the pinned backdrop. Grouping or
//     adding layers after captioning can never bury the captions.
// A given element id appears at most once in the whole tree.
export const resolveLayerTree = (project: Composition): LayerNode[] => {
  const present = collectPresentIds(project);
  const grouped = collectGroupedIds(project);
  const groupById = new Map<string, Group>();
  for (const g of project.groups ?? []) groupById.set(g.id, g);
  const pinnedRoot = new Set(collectPinnedRootIds(project));
  const captionsRoot = collectCaptionsRootIds(project, grouped);
  const captionsRootSet = new Set(captionsRoot);

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
    if (captionsRootSet.has(id)) return;
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
  // Captions groups come LAST in tree order (= top of z, painted over
  // everything). Relative order among several tracks follows groups[].
  for (const id of captionsRoot) {
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
export const resolveLayerOrder = (project: Composition): string[] =>
  flattenTree(resolveLayerTree(project), false);

// Flat render-order list of LEAF ids only (video + shape + image layers).
// Use this for hit-testing and any consumer that wants to address visual
// layers and not the abstract groups containing them.
export const resolveLeafOrder = (project: Composition): string[] =>
  flattenTree(resolveLayerTree(project), true);

// A LANE is a TIME track (NOT a z-order group): the video layers that share a
// `lane_id` are the pieces of ONE take laid end-to-end — the two halves of a
// razor split, or the fragments a `cut_range` leaves behind. `resolveLanes`
// groups a composition's `video_layers` into lanes so every consumer — the
// agent surface (`describe_video`), the Timeline, the Inspector — reads lane
// membership from ONE place instead of re-deriving it three times.
//
// Within a lane, clips are ordered by `timeline_start_frame` (the order they
// play). Lanes are ordered by their earliest clip's `timeline_start_frame`.
// A video layer with no `lane_id` is defensively treated as its OWN lane keyed
// by its id — post-migration every clip carries one (see migrateAssignLaneIds),
// but callers must not assume it. Returns EVERY lane (including single-clip
// ones) so UI callers can address each clip's lane; callers that want only the
// lanes that actually group several clips use `resolveMultiClipLanes`.
export type Lane = { lane_id: string; clips: VideoLayer[] };

export const resolveLanes = (project: Composition): Lane[] => {
  const byLane = new Map<string, VideoLayer[]>();
  for (const v of project.video_layers) {
    const laneId = v.lane_id && v.lane_id.length > 0 ? v.lane_id : v.id;
    const bucket = byLane.get(laneId);
    if (bucket) bucket.push(v);
    else byLane.set(laneId, [v]);
  }
  return [...byLane.entries()]
    .map(([lane_id, clips]) => ({
      lane_id,
      clips: [...clips].sort(
        (a, b) => a.timeline_start_frame - b.timeline_start_frame,
      ),
    }))
    .sort(
      (a, b) =>
        a.clips[0].timeline_start_frame - b.clips[0].timeline_start_frame,
    );
};

// The multi-clip lanes only (2+ clips) — the "interesting" ones: a track that
// actually laid several pieces of one take end-to-end. A thin filter over
// `resolveLanes` so `describe_video` / a track UI don't re-derive the `> 1`
// predicate. (A fallback lane, keyed by a unique layer id, is always
// single-clip, so it never survives this filter.)
export const resolveMultiClipLanes = (project: Composition): Lane[] =>
  resolveLanes(project).filter((lane) => lane.clips.length > 1);

// A collapsed lane reorders as ONE unit: its clips move together and stay a
// contiguous block. `set_group_parent` only moves a single element (and removes
// it BEFORE inserting), so a lane move is realised as a short sequence of
// single-element moves — the first clip to the drop slot, then each remaining
// clip packed immediately after the previous one. These two pure functions
// compute each step's insertion index against a freshly-read siblings array
// (`siblingIds` = the parent's children in `set_group_parent`'s coordinate
// system), so the block always lands contiguous regardless of drop direction.
// Shared by the store's batched `reorderLaneClips` action AND the Inspector /
// Timeline drag surfaces that drive it, so all three agree on the index math.
//
// Step 1 — place the lane's first clip at `baseIndex` (the pre-removal target
// slot). When that clip currently sits below the slot in the same parent, its
// removal shifts the slot down by one (mirrors the single-element drop
// adjustment).
export const laneFirstInsertIndex = (
  siblingIds: string[],
  firstClipId: string,
  baseIndex: number,
): number => {
  const cur = siblingIds.indexOf(firstClipId);
  const idx = cur >= 0 && cur < baseIndex ? baseIndex - 1 : baseIndex;
  return Math.max(0, idx);
};

// Steps 2..N — insert `movingId` immediately after `afterId` (the clip placed
// on the previous step). If `movingId` currently sits below `afterId`, removing
// it shifts `afterId` down one, so the post-removal "right after" slot is
// `indexOf(afterId)` rather than `indexOf(afterId) + 1`.
export const laneStepInsertIndex = (
  siblingIds: string[],
  afterId: string,
  movingId: string,
): number => {
  const p = siblingIds.indexOf(afterId);
  const q = siblingIds.indexOf(movingId);
  return q > p ? p + 1 : p;
};

// The project's CURRENT root-level render order as an explicit `layer_order`
// value: every non-pinned root id (leaves and groups, no descendants),
// back-to-front exactly as resolveLayerTree renders them today. Ops that
// append a new id to `layer_order` expecting it to land ON TOP must write
// this first when the existing order may be partial — unlisted root ids
// (legacy projects on the canonical fallback) render ABOVE the explicit
// list, so appending to a partial list sinks the new layer underneath them.
export const materializeRootLayerOrder = (project: Composition): string[] => {
  const pinned = new Set(collectPinnedRootIds(project));
  return resolveLayerTree(project)
    .map((n) => n.id)
    .filter((id) => !pinned.has(id));
};

// The immediate parent group's bare id (no "group." prefix), or null if the
// element sits at the tree root or isn't referenced by any group.
export const findParentGroup = (
  project: Composition,
  elementId: string,
): string | null => {
  for (const g of project.groups ?? []) {
    if (g.children.includes(elementId)) return g.id;
  }
  return null;
};

// The `reorder_layer` target index (within a parent's bottom→top sibling list)
// that lands `host` DIRECTLY ABOVE `source` — the arrangement the Layers panel
// nests a consumed mask stencil under its host. Accounts for the splice
// shifting `source` down by one when the host starts below it. Returns null
// when either id is absent or they're already the same slot (nothing to move).
export const maskArrangeTarget = (
  siblings: string[],
  host: string,
  source: string,
): number | null => {
  const h = siblings.indexOf(host);
  const s = siblings.indexOf(source);
  if (h < 0 || s < 0 || h === s) return null;
  return h < s ? s : s + 1;
};

// Ancestor group ids (bare, no prefix) from root-most to immediate parent,
// excluding the element itself. Empty for root-level elements / unknown ids.
// The maxDepth bound is defensive — dispatchers refuse cycles, but a hand-
// edited file could in principle produce one.
export const getAncestorGroupChain = (
  project: Composition,
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
  project: Composition,
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
  project: Composition,
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
  project: Composition,
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
const elementIndexCache = new WeakMap<Composition, Map<string, AnyLayer>>();

// Build (once per Project identity, then cached) a map from element id → layer.
// For per-frame hot paths (renderer/geometry samplers) that previously did O(1)
// `project.animations[eid]` map lookups and must stay O(1) now that the data
// is on the records.
export const elementIndex = (project: Composition): Map<string, AnyLayer> => {
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
  project: Composition,
  elementId: string,
): AnyLayer | null =>
  elementIndex(project).get(elementId) ??
  findLayerByElementId(project, elementId);

// ───────────────────────────────────────────────────────────────────────────
// Timeline blocks — a layer's on-timeline existence window + block-local time.
//
// Every layer optionally carries a `block` ({start, duration}); absent means
// "always present" (a block spanning the whole comp, keyframes sampled at
// absolute frames). These five resolvers are the SINGLE source of truth for the
// block model — the renderer, DOM sync, content-duration, and tools all route
// through them so canvas and DOM stay frame-for-frame identical. Never re-derive
// the offset/gate inline.
//
// TWO VISIBILITY GATES, AND WHICH ONE YOU WANT.
//   `frameOutsideBlock`     — the DEFAULT. Culls when the element's own window
//                             OR any ANCESTOR group's excludes the frame. Any
//                             code asking about ONE element in isolation wants
//                             this: hit-testing, selection, a per-leaf probe.
//   `frameOutsideOwnBlock`  — own window ONLY. Correct exclusively for a
//                             TOP-DOWN walk that has already culled the
//                             ancestors on its way in (drawNode's recursion,
//                             the DOM sync's nested wrappers). Its call sites
//                             are pinned by test/block-gate-call-sites.test.ts.
// The plain name is the safe one on purpose: guessing gets you the correct
// answer, and the fast path has to be asked for. Note `hidden` and `locked`
// inherit down the same way (isElementHidden / isElementLocked in
// CanvasOverlay) — a block window is not special.
//
// A VIDEO LAYER IS THE EXCEPTION, and neither gate above covers it. No add path
// writes a `block` onto a clip, so both read it as always-present; its window is
// the TRIM. `frameOutsideClipWindow` (above, beside `videoWindow`) is that
// third gate, and any code asking "is this element painted at frame f" about a
// clip needs it as well as the block gate — the renderer and the canvas
// hit-test both call it.
// ───────────────────────────────────────────────────────────────────────────

// Sentinel duration for an absent (always-present) block: unbounded, so the
// visibility gate never culls and sampling is at absolute frames. Never
// serialized — a stored block always has a finite positive duration.
export const ALWAYS_PRESENT_DURATION = Number.POSITIVE_INFINITY;

// A caption line's source anchor (perElementDataFields.caption_source): the clip
// it follows plus its window in that clip's OWN (source) timeline.
export interface CaptionSourceAnchor {
  clip_element_id: string;
  source_start_frame: number;
  source_end_frame: number;
}

// Derive a source-anchored caption line's on-timeline window from the clip it
// follows — the caption analog of weldedAudioTiming/videoWindow. The line's
// source range [source_start, source_end) is intersected with the clip's visible
// source window [source_in, source_out) and mapped onto the composition timeline
// via the clip's placement, so trimming the head/tail or sliding the clip
// retimes/clips the caption with zero stored bookkeeping. No natural-duration
// lookup is needed: a caption's own source_end is already ≤ the clip's real
// length, so source_out (when set) bounds the tail and source_end bounds it
// otherwise. Returns:
//   - { start, duration } in composition frames (a caption never sits under an
//     embedded morpha band, so its parent timeline == the composition timeline).
//   - duration 0 when the line is fully trimmed off (culled: frameOutsideBlock
//     never draws it; the Timeline skips its bar).
//   - null when the referenced clip is missing (dangling anchor → caller falls
//     back to any stored block).
export const deriveCaptionWindow = (
  project: Composition,
  cs: CaptionSourceAnchor,
): { start: number; duration: number } | null => {
  const id = cs.clip_element_id.startsWith("video.")
    ? cs.clip_element_id.slice("video.".length)
    : cs.clip_element_id;
  const clip = project.video_layers.find((v) => v.id === id);
  if (!clip) return null;
  const inFrame = Math.max(0, clip.source_in_frame);
  const outFrame =
    clip.source_out_frame === null ? Number.POSITIVE_INFINITY : clip.source_out_frame;
  const clampWin = (f: number) => Math.min(Math.max(f, inFrame), outFrame);
  const visStart = clampWin(cs.source_start_frame);
  const visEnd = clampWin(cs.source_end_frame);
  const tStart = Math.max(0, clip.timeline_start_frame);
  // Map both ends through the clip's rate curve, so a retimed clip stretches
  // (or compresses) its captions with it instead of leaving them behind at
  // 1:1 offsets. At speed 1 with no ramp this is the identity it always was.
  const startOffset = timelineOffsetForSourceFrame(clip, visStart);
  const endOffset = timelineOffsetForSourceFrame(clip, visEnd);
  return {
    start: tStart + startOffset,
    duration: Math.max(0, endOffset - startOffset),
  };
};

// The layer's on-timeline window in its PARENT's timeline, defaulting to the
// always-present window when the layer has no stored block. A caption line
// (carries `caption_source`) overrides any stored block with a window DERIVED
// live from the clip it follows (deriveCaptionWindow), so it tracks the clip's
// trim; the stored block is used only as a fallback when the clip is missing.
export const blockOf = (
  project: Composition,
  elementId: string,
): { start: number; duration: number } => {
  const layer = layerOf(project, elementId);
  const cs = layer?.caption_source;
  if (cs) {
    const derived = deriveCaptionWindow(project, cs);
    if (derived) return derived;
    // Dangling anchor (clip removed) — fall through to any stored block. A
    // welded caption has no stored block, and it must CULL, not become
    // always-present: falling through to the blockless default plastered a
    // deleted clip's captions over every frame of the composition.
    if (!layer?.block) return { start: 0, duration: 0 };
  }
  const block = layer?.block;
  if (!block) return { start: 0, duration: ALWAYS_PRESENT_DURATION };
  return { start: block.start, duration: block.duration };
};

// The layer's on-timeline window for EDGE PURPOSES — the one place that knows
// a project has two different sources of "when does this layer exist".
//
// `blockOf` answers for everything that stores a block, and derives it live for
// a welded caption. But a VIDEO layer carries no block at all: its window comes
// from the trim (timeline_start + source_in/source_out), which is why
// `blockOf` on a video row would fabricate an Infinity duration. Anything
// reasoning about a layer's EDGES — where it starts, where it ends — has to ask
// here, or it silently handles every layer class except the one the user is
// most likely to be trimming.
//
// Deliberately PURE, so it works in the worker / SDK with no decoded media:
// when `source_out_frame` is null (clip runs to its natural end, a length that
// lives in the bytes and not in the JSON) the window is taken to the
// composition end. That matches the fallback `clipBarWindow` already draws the
// bar with, so the Timeline and the renderer agree about where the edge is.
//
// KEEP IN STEP WITH `clipBarWindow` (editor/src/clip-snap.ts). This is NOT a
// rival source of truth: it is the same question asked where no media has been
// decoded, so it can only implement clipBarWindow's no-duration branch. The one
// place they can diverge is a clip with `source_out_frame: null` whose real
// footage is SHORTER than the composition — the bar and this both run the
// window to the comp end, so an out-transition anchors there rather than at the
// last decoded frame. Set an explicit `source_out_frame` (every trim does) and
// they agree exactly. If you change either fallback, change both.
//
// An unbounded result (ALWAYS_PRESENT_DURATION) means "no edges" — the caller
// must treat edge behaviour as inert rather than pinning it to frame 0.
export const effectiveWindowOf = (
  project: Composition,
  elementId: string,
): { start: number; duration: number } => {
  if (!elementId.startsWith("video.")) return blockOf(project, elementId);
  const id = elementId.slice("video.".length);
  const layer = project.video_layers.find((v) => v.id === id);
  if (!layer) return { start: 0, duration: 0 };
  const start = Math.max(0, layer.timeline_start_frame);
  if (layer.source_out_frame === null) {
    // Same 30 fps the rest of the project timeline runs at (see videoWindow).
    const compFrames = Math.round((project.duration_seconds ?? 0) * 30);
    return { start, duration: Math.max(0, compFrames - start) };
  }
  const inFrame = Math.max(0, layer.source_in_frame);
  // Retimed exactly as `videoWindow`/`clipBarWindow` do — a fade handle placed
  // from this window must land where the (retimed) clip bar actually reaches.
  return {
    start,
    duration: retimedWindowFrames(
      layer,
      Math.max(0, layer.source_out_frame - inFrame),
    ),
  };
};

// The window a GROUP occupies on its parent timeline, DERIVED as the hull of
// its children's windows.
//
// A group is a CONTAINER, not a clip: it holds no media and has no intrinsic
// extent, so "no stored block" must not read as "always present" — it means
// "for as long as whatever is inside it". Deriving the hull, rather than
// stamping a block when the group is created or migrating one onto existing
// groups, keeps that honest two ways: it can never go stale as children are
// added, moved or trimmed, and it writes nothing, so the standing rule that a
// layer's absent block is never retroactively bound still holds.
//
// SCOPE — this feeds the TIMELINE BAR (and the group drag that rides on it).
// It is deliberately NOT wired into `blockOf`, and so not into
// `effectiveFrameOffset` (which would rebase the group's OWN keyframes by the
// hull start — a silent retime of every animated group in every project) nor
// `frameOutsideBlock` (children already gate themselves; a derived gate could
// only ever cull something it shouldn't). A group's RENDER semantics are
// unchanged by this function — it is a description of where the contents sit,
// not a new authority over them.
//
// Returns null when the hull is genuinely unbounded — an empty group, or one
// holding an always-present (blockless) descendant — so the caller falls back
// to the full-lane blockless bar and keeps telling the truth.
// How a group's contents are measured. `videoNaturalSeconds` is the same
// injected lookup `computeContentDurationFrames` and `weldedAudioTiming` take:
// a CLIP's end is only knowable from the decoded source when it plays to its
// natural end, so the caller that has those lengths (the editor store's
// `videoDurations`) hands them in, and a headless caller simply doesn't. Passing
// it is what turns an "open" hull into a measured one — never guess an extent.
export interface GroupWindowOptions {
  videoNaturalSeconds?: (layer: VideoLayer) => number | undefined;
}

// What one walk of a group's contents establishes. Two questions with two
// different answers, deliberately resolved together so they can never drift:
//   `start`  — WHERE the contents begin. Null only when nothing inside carries
//              a position (an empty group, or an always-present descendant).
//   `window` — how far they run as well. Null whenever any part of the extent
//              is unknown, which is strictly more often than `start` is null.
type GroupExtent = {
  start: number | null;
  window: { start: number; duration: number } | null;
};
const UNPLACED: GroupExtent = { start: null, window: null };

// The memo is per (project, options) — two callers measuring the same project
// with different clip lengths must not read each other's answers. Callers that
// re-render (the Timeline) should hold their options object stable.
const NO_GROUP_WINDOW_OPTIONS: GroupWindowOptions = {};
const groupExtentCache = new WeakMap<
  Composition,
  WeakMap<GroupWindowOptions, Map<string, GroupExtent>>
>();

const groupExtent = (
  project: Composition,
  elementId: string,
  opts: GroupWindowOptions,
): GroupExtent => {
  let byOpts = groupExtentCache.get(project);
  if (!byOpts) {
    byOpts = new WeakMap();
    groupExtentCache.set(project, byOpts);
  }
  let cache = byOpts.get(opts);
  if (!cache) {
    cache = new Map();
    byOpts.set(opts, cache);
  }
  const hit = cache.get(elementId);
  if (hit !== undefined) return hit;
  // Seed the memo BEFORE recursing so a malformed `children` cycle resolves to
  // "unplaced" instead of blowing the stack.
  cache.set(elementId, UNPLACED);
  const group = layerOf(project, elementId);
  const children: string[] =
    group && Array.isArray((group as Group).children)
      ? (group as Group).children
      : [];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let anyOpen = false;
  for (const childId of children) {
    const win = childTimelineWindow(project, childId, opts);
    // An id that doesn't resolve contributes nothing — skip it. It must NOT be
    // read as unbounded, or one stale reference would strip the whole group of
    // its timeline window.
    if (win.kind === "absent") continue;
    // A genuinely always-present child has neither a start nor an end, so the
    // group has neither either — say so rather than inventing an extent that
    // would visually clip its own contents.
    if (win.kind === "unbounded") {
      cache.set(elementId, UNPLACED);
      return UNPLACED;
    }
    // Placed, but its end is unmeasurable (a clip playing to its natural end
    // with no source length to hand). It still pins the start; it can only
    // spoil the extent.
    if (win.kind === "open") {
      anyOpen = true;
      lo = Math.min(lo, win.start);
      continue;
    }
    // A fully-trimmed-off caption (duration 0) is culled — it contributes no
    // extent, exactly as it contributes no pixels.
    if (win.duration <= 0) continue;
    lo = Math.min(lo, win.start);
    hi = Math.max(hi, win.start + win.duration);
  }
  const start = Number.isFinite(lo) ? lo : null;
  const out: GroupExtent = {
    start,
    window:
      !anyOpen && start !== null && Number.isFinite(hi) && hi > start
        ? { start, duration: hi - start }
        : null,
  };
  cache.set(elementId, out);
  return out;
};

export const deriveGroupWindow = (
  project: Composition,
  elementId: string,
  opts: GroupWindowOptions = NO_GROUP_WINDOW_OPTIONS,
): { start: number; duration: number } | null =>
  groupExtent(project, elementId, opts).window;

// WHERE a group's contents begin — a strictly weaker question than how long
// they run, and the only one a MOVE has to answer.
//
// `shift_group` resolves an absolute target against the group's current
// position, so it needs a start and nothing else. Asking deriveGroupWindow for
// a whole bounded hull is what made a group holding an untrimmed clip
// unmovable: the clip's end isn't measurable headlessly, so the hull came back
// null and the move was refused over an extent it never used.
export const deriveGroupStart = (
  project: Composition,
  elementId: string,
  opts: GroupWindowOptions = NO_GROUP_WINDOW_OPTIONS,
): number | null => groupExtent(project, elementId, opts).start;

// True when `elementId` is a plain group — a container, as opposed to an
// embedded morpha band, which is its own time origin and behaves like a clip.
// The single predicate for "does the container treatment apply", so the Timeline,
// the resolvers below and the tools can't disagree about it.
export const isContainerGroup = (
  project: Composition,
  elementId: string,
): boolean => {
  if (!elementId.startsWith("group.")) return false;
  const g = layerOf(project, elementId);
  return !!g && !isMorphaGroup(g as Group);
};

// The composition frame a layer's TIMELINE BAR starts at.
//
// For every ordinary layer this is just `effectiveFrameOffset` — the bar and the
// row's keyframe dots share one origin. A container group on a DERIVED window is
// the sole exception, and it needs its own resolver rather than an inline
// calculation at the call site: the group stays blockless, so its own keyframes
// are still sampled at absolute frames and their dots must keep drawing at
// `effectiveFrameOffset`, while the BAR has to sit at the hull of its contents.
// Using effectiveFrameOffset for both would pin the bar to frame 0 at the hull's
// width — right length, wrong place.
export const blockBarOriginFrame = (
  project: Composition,
  elementId: string,
  opts: GroupWindowOptions = NO_GROUP_WINDOW_OPTIONS,
): number => {
  const base = effectiveFrameOffset(project, elementId);
  const layer = layerOf(project, elementId);
  if (layer?.block || !isContainerGroup(project, elementId)) return base;
  // Falls back to `base` when the hull is unmeasurable — the SAME condition
  // under which the bar has no stored window and renders full-lane from the
  // row's own origin, so the bar's left edge and this origin can't disagree.
  return base + (deriveGroupWindow(project, elementId, opts)?.start ?? 0);
};

// One child's window expressed in ITS PARENT's timeline — the space the hull is
// summed in. A nested plain group has no window of its own, so it recurses; a
// morpha band does (its `block` places the band on this timeline, and its
// descendants are band-LOCAL, so folding them in here would double-count the
// band origin). Null ⇒ unbounded.
// "absent" ⇒ the id doesn't resolve to a layer at all, so it contributes NOTHING
// and must be skipped. "unbounded" ⇒ a real child that spans the whole
// composition, which genuinely makes the hull unbounded. Collapsing these two
// into a bare null is a bug that has already bitten: a group whose only child
// was a dangling id (left by a band re-pin) read as always-present and lost its
// timeline handles. `children` is an unenforced foreign key, so absent ids WILL
// occur — migratePruneDanglingChildren cleans them on load, but this must not
// depend on that having run.
// "absent"    ⇒ the id doesn't resolve to a layer at all: contributes NOTHING.
// "unbounded" ⇒ a real child that spans the whole composition and has no start
//               to speak of, which genuinely makes the hull unbounded.
// "open"      ⇒ PLACED, but how far it runs can't be measured here — a clip
//               playing to its natural end with no source length to hand. It
//               has a start (a move can use it) and no end (a hull can't).
type ChildWindow =
  | { kind: "window"; start: number; duration: number }
  | { kind: "open"; start: number }
  | { kind: "unbounded" }
  | { kind: "absent" };

// A CLIP's window on its parent timeline. A video layer is the one leaf whose
// placement does NOT live in `block` — `timeline_start_frame` positions it and
// the source in/out points give its length — so `blockOf` reports it as
// always-present and it would poison every hull it sits in. It is never
// genuinely always-present: it starts where it is placed and stops when its
// source runs out.
//
// The length goes through `videoWindow`, the one home for trim math, resolving
// the source length by the SAME ladder `computeContentDurationFrames` uses:
// the caller's measured length, else an explicit out-point (which bounds the
// window by itself), else unmeasurable — in which case the clip is "open"
// rather than assigned an invented extent.
const clipTimelineWindow = (
  layer: VideoLayer,
  opts: GroupWindowOptions,
): ChildWindow => {
  const FPS = 30;
  const natural = opts.videoNaturalSeconds?.(layer);
  const sourceSeconds =
    natural !== undefined && Number.isFinite(natural) && natural > 0
      ? natural
      : layer.source_out_frame !== null
        ? layer.source_out_frame / FPS
        : null;
  if (sourceSeconds === null) {
    return { kind: "open", start: Math.max(0, layer.timeline_start_frame) };
  }
  const win = videoWindow(layer, sourceSeconds);
  return { kind: "window", start: win.startFrame, duration: win.windowFrames };
};

const childTimelineWindow = (
  project: Composition,
  childId: string,
  opts: GroupWindowOptions,
): ChildWindow => {
  const layer = layerOf(project, childId);
  if (!layer) return { kind: "absent" };
  // An explicit block on a clip GATES it — the layer is drawn only inside that
  // window regardless of where its footage sits — so the block IS its window.
  // Both readers come through here, so the hull and the move can't disagree
  // about which field is authoritative for a given clip.
  if (childId.startsWith("video.") && !layer.block) {
    return clipTimelineWindow(layer as VideoLayer, opts);
  }
  if (
    childId.startsWith("group.") &&
    !layer.block &&
    !isMorphaGroup(layer as Group)
  ) {
    // One walk answers both halves. A nested group with no hull is empty,
    // unbounded, or merely unmeasurable — and only an unbounded child may
    // poison the parent, so the weaker question tells them apart:
    //   window ⇒ measured
    //   start only ⇒ placed but open (a clip inside whose end is unmeasurable)
    //   neither, but resolvable content ⇒ genuinely unbounded
    //   nothing resolvable ⇒ absent (skip; a stale id must not strip the
    //     parent of its window)
    const nested = groupExtent(project, childId, opts);
    if (nested.window) return { kind: "window", ...nested.window };
    if (nested.start !== null) return { kind: "open", start: nested.start };
    const g = layer as Group;
    const hasContent = (g.children ?? []).some((c) => layerOf(project, c) !== null);
    return hasContent ? { kind: "unbounded" } : { kind: "absent" };
  }
  const win = blockOf(project, childId);
  return Number.isFinite(win.duration)
    ? { kind: "window", start: win.start, duration: win.duration }
    : { kind: "unbounded" };
};


// Remove every caption line welded to `clipElementId` (its `caption_source`
// anchor points at that clip), stripping their ids from `layer_order` and every
// group's `children`. Deleting a clip takes its welded captions with it, exactly
// like its welded audio overlay — a caption's window is DERIVED from the clip's
// trim, so with the clip gone the line has nothing to play against. Shared by
// the editor store and the pure remove_layer tool so the two surfaces can't
// drift. Returns the removed `text.<id>` element ids.
export const removeWeldedCaptionLines = (
  project: Composition,
  clipElementId: string,
): string[] => {
  const doomed = project.text_layers.filter(
    (t) => t.caption_source?.clip_element_id === clipElementId,
  );
  if (doomed.length === 0) return [];
  const ids = new Set(doomed.map((t) => `text.${t.id}`));
  project.text_layers = project.text_layers.filter(
    (t) => !ids.has(`text.${t.id}`),
  );
  project.layer_order = (project.layer_order ?? []).filter((x) => !ids.has(x));
  for (const g of project.groups) {
    g.children = g.children.filter((x) => !ids.has(x));
  }
  return [...ids];
};

// Sum of the TIME ORIGINS of every ANCESTOR embedded morpha band of `elementId`
// (each band's block.start). A band's whole subtree plays relative to where the
// band sits on the host timeline, so its descendants subtract this. Regular
// (non-band) ancestor groups contribute nothing — grouping never retimes.
// Memoized per Project identity (structural, frame-independent) so the per-frame
// render loop doesn't re-walk the ancestor chain 5× per layer — same
// invalidate-on-clone contract as elementIndex.
const bandOriginSumCache = new WeakMap<Composition, Map<string, number>>();
export const ancestorBandOriginSum = (project: Composition, elementId: string): number => {
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
  project: Composition,
  elementId: string,
): number =>
  ancestorBandOriginSum(project, elementId) + blockOf(project, elementId).start;

// True when the layer's OWN block window excludes `frame` — ancestors NOT
// considered. `frame` is the raw composition frame; the layer's block window is
// expressed in its PARENT timeline, so ancestor band origins are subtracted
// first. Always false for an always-present (blockless) layer.
//
// ONLY for a top-down walk that culls ancestors before it reaches this node:
// the canvas (`drawNode` returns early on a group, so the subtree is never
// visited) and the DOM sync (hiding a group wrapper hides its nested children
// via CSS). Both would get the same answer from the ancestor-aware
// `frameOutsideBlock` below — they use this to avoid re-walking a chain their
// recursion has already covered, which is the ONLY reason to reach for it.
// Anything asking about one element in isolation must use `frameOutsideBlock`.
// New call sites need an entry in test/block-gate-call-sites.test.ts.
export const frameOutsideOwnBlock = (
  project: Composition,
  elementId: string,
  frame: number,
): boolean => {
  const { start, duration } = blockOf(project, elementId);
  if (duration === ALWAYS_PRESENT_DURATION) return false;
  // A fully-trimmed-off caption derives duration 0 — never drawn.
  if (duration <= 0) return true;
  const parentFrame = frame - ancestorBandOriginSum(project, elementId);
  return parentFrame < start || parentFrame >= start + duration;
};

// True when NOTHING of this element reaches the screen at `frame` — its own
// block window excludes the frame, OR any ANCESTOR group's does. THE DEFAULT
// GATE: use this unless you are a top-down walk (see frameOutsideOwnBlock).
//
// The ancestor half is the whole point. `drawNode` culls a group whose window
// excludes the frame BEFORE recursing, so the entire subtree paints nothing —
// but each child's own block says nothing about that, and a BLOCKLESS child
// (the always-present sentinel every legacy and embedded layer carries) reports
// "visible" at every frame unconditionally, so only the ancestor walk can catch
// it. Asking per-leaf instead left every child of a not-yet-started band with a
// live hit-box: dashed outlines over footage the band hadn't reached, each rect
// swallowing clicks meant for what IS visible beneath.
export const frameOutsideBlock = (
  project: Composition,
  elementId: string,
  frame: number,
): boolean => {
  if (frameOutsideOwnBlock(project, elementId, frame)) return true;
  // Each ancestor resolves against ITS parent timeline (frameOutsideOwnBlock
  // subtracts that group's own band-origin sum), so the raw composition frame
  // is the right argument at every level.
  for (const gid of getAncestorGroupChain(project, elementId)) {
    if (frameOutsideOwnBlock(project, `group.${gid}`, frame)) return true;
  }
  return false;
};

// A BLOCK MUST NEVER SILENTLY TRUNCATE AN AUTHORED KEYFRAME.
//
// The two effects of a block are coupled: it gates visibility AND it re-bases
// the layer's keyframes to its `start`. So a keyframe authored at block-local
// frame `f` is only ever SEEN while `f < block.duration` — past that the layer
// is culled and the animation just vanishes, with nothing on screen to say why.
// (Bounding every added layer by default, rather than only images, makes that
// the DEFAULT trap rather than a corner case.)
//
// So: whenever a keyframe is AUTHORED (added / moved / pasted) at block-local
// `authoredFrame`, grow the block just far enough to cover it. Deliberately
// scoped to the frame the user just touched, NOT to the layer's whole track
// extent — otherwise tweaking a keyframe near the start would resurrect a tail
// the user had deliberately trimmed off, which is its own surprise.
//
// This runs at AUTHORING time only — never on load, never on a block edit — so:
//   - it is non-destructive: nothing is deleted, moved or re-timed, and the
//     user can still drag the block's right edge back in afterwards (an
//     explicit trim IS allowed to hide a tail; only silence isn't).
//   - it is invisible when correct: authoring inside the block, or on a
//     blockless (always-present) layer, changes nothing.
//   - nothing walks existing projects — a block-less layer stays block-less.
// Skips caption lines, whose window is DERIVED from the clip they're welded to
// (deriveCaptionWindow) and so can't be grown by writing a stored block.
// FRAME SPACE — the authored frame is BLOCK-RELATIVE (the space keyframes are
// stored in; see `effectiveFrameOffset`), which is why it's compared against
// `block.duration` and not against an absolute timeline position. Passing an
// absolute project frame here would over-grow every block on a layer that
// doesn't start at 0. Callers holding a timeline frame must subtract
// `effectiveFrameOffset(project, elementId)` first. This repo has shipped that
// exact bug class before (block-offset editing surfaces), hence the loud note.
//
// Mutates `project` in place; returns true when the block actually changed.
export const growBlockToCoverFrame = (
  project: Composition,
  elementId: string,
  authoredBlockRelativeFrame: number,
): boolean => {
  if (!Number.isFinite(authoredBlockRelativeFrame)) return false;
  const layer = findLayerByElementId(project, elementId);
  if (!layer?.block) return false; // always-present ⇒ nothing to truncate
  if (layer.caption_source) return false; // window derived from the clip
  // HEAD case: a frame before the block start can't be covered by growing.
  // Moving `start` earlier would re-time every OTHER keyframe on the layer
  // (they're all block-relative), i.e. fix one hidden keyframe by silently
  // moving the rest — strictly worse. The authoring surfaces clamp the
  // playhead into the block, so this is unreachable in practice; if you ever
  // make it reachable, clamp at the surface, don't grow the head here.
  if (authoredBlockRelativeFrame < 0) return false;
  const needed = Math.round(authoredBlockRelativeFrame) + 1;
  if (needed <= layer.block.duration) return false;
  layer.block = { start: layer.block.start, duration: needed };
  return true;
};

// Derive a legacy ALWAYS-PRESENT layer's timeline BLOCK from its OWN opacity
// animation — the shape the author already expressed. Legacy layers (added
// before the clip/block model) carry no `block`, which is the "always-present"
// sentinel: unbounded, so lengthening the composition later drags the layer out
// to the new full length. Where the author faded the layer DOWN to invisible,
// that window is already encoded in the opacity track, and we can bound the
// layer to it render-identically. Returns `{ start, duration }` for a
// bounded window, or `null` to leave the layer unbounded (the safe default).
//
// REPRESENTATION — why `start` is ALWAYS 0, and only the TAIL is bounded.
// A block is NOT a passive visibility marker: `block.start` also RE-BASES every
// one of the layer's animation tracks (see `effectiveFrameOffset` — the renderer
// samples each track at `frame − block.start`). Writing `start = firstZeroFrame`
// (the "bind the head" reading) would therefore silently slide the fade — and
// any x/y/scale/rotation/fill track — LATER by that many frames, failing the
// frame-for-frame render-identity requirement whenever the fade-in doesn't begin
// at frame 0. Rewriting the keyframes to compensate is unsafe (a track authored
// before the fade would shift to a negative frame, which the schema forbids),
// and no block-CREATION path in the app re-bases keyframes anyway
// (`set_layer_block` just stores the window). The only render-safe start is 0.
//
// That loses nothing that matters: the authored `opacity == 0` HEAD already
// hides the layer before it appears, and the head is FIXED — it never grows with
// the composition. Only the unbounded TAIL grows, so only the tail needs
// bounding. Concretely, mapping the four cases in the derivation rule:
//   - track ENDS at 0 (fade-out / trailing hidden keyframe) ⇒ the tail is
//     authored-invisible, so cull it: block { start: 0, duration: lastFrame + 1 }.
//     Covers BOTH the "starts-0 and ends-0" and the "ends-0 only" cases — a
//     start of 0 already expresses the "head open" half of the latter, and is
//     render-identical to the head bound of the former (the head is opacity-0
//     either way). The window is [0, lastFrame] inclusive in the layer's parent
//     timeline.
//   - track does NOT end at 0 (open tail: "starts-0 only", or neither end at 0)
//     ⇒ the layer is authored to stay visible to the end, however long that
//     becomes, so it must remain unbounded. A finite block CANNOT represent an
//     open tail without eventually truncating the layer when the comp is
//     lengthened — the exact regression the migration must avoid — and a
//     head-only layer's authored extent is merely its fade-IN end, so bounding
//     there would cull it the instant it finishes appearing. ⇒ return null.
// Degenerate opacity tracks (fewer than two keyframes, or all-zero — invisible
// everywhere, no window to speak of) also return null: there's nothing to bound.
//
// PURE + node-testable; reads only the layer's own opacity track (no project /
// I/O), so the migration and the editor's lazy block materialisation can share
// it. Reads frame/value defensively so it works on both a parsed layer and a
// raw pre-parse record.
export const deriveLegacyBlockFromOpacity = (
  layer:
    | {
        animations?:
          | { opacity?: readonly { frame: number; value: number }[] }
          | null;
      }
    | null
    | undefined,
): { start: number; duration: number } | null => {
  const track = layer?.animations?.opacity;
  if (!Array.isArray(track) || track.length < 2) return null;
  const kfs: { frame: number; value: number }[] = [];
  for (const kf of track) {
    const f = (kf as { frame?: unknown })?.frame;
    const v = (kf as { value?: unknown })?.value;
    if (typeof f !== "number" || !Number.isFinite(f)) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    kfs.push({ frame: f, value: v });
  }
  kfs.sort((a, b) => a.frame - b.frame);
  const last = kfs[kfs.length - 1];
  // Open tail (last authored opacity ≠ exactly 0) ⇒ keep unbounded. Must be
  // EXACTLY 0: a fade that ends at, say, 0.01 is still faintly visible, so
  // culling there would NOT be render-identical.
  if (last.value !== 0) return null;
  // Bound to the FADE-OUT frame (the first 0 after the last visible keyframe),
  // not the last keyframe overall — so a track that fades to 0 and then HOLDS 0
  // for extra keyframes (`[{0,1},{100,0},{200,0}]`) yields a tight bar ending at
  // 100, not an empty 100-frame tail out to 200. Trimming those trailing held-0
  // keyframes is render-identical: opacity is 0 across the whole trimmed span,
  // so culling there matches the opacity-0 exactly. The keyframe right after the
  // last positive one is that fade-out 0 (everything past the last positive is
  // ≤0 ⇒ 0, since opacity is never negative).
  let lastPositiveIdx = -1;
  for (let i = kfs.length - 1; i >= 0; i--) {
    if (kfs[i].value > 0) {
      lastPositiveIdx = i;
      break;
    }
  }
  // All-zero track ⇒ invisible everywhere, no visible window ⇒ leave alone.
  if (lastPositiveIdx === -1) return null;
  const fadeOutFrame = kfs[lastPositiveIdx + 1].frame;
  return { start: 0, duration: fadeOutFrame + 1 };
};

