// Pure tool dispatchers — single source of truth for the agent-callable
// catalog. Each dispatcher takes a Project (already validated) and tool args,
// returns { project, result }. No I/O, no store access, no UI dependencies.
//
// Two surfaces wrap these:
//   1. Editor adapter (`editor/src/llm-tools.ts`) — runs the dispatcher on the
//      live zustand `project`, then `setState` + `scheduleSave` so the running
//      editor reflects + persists the change.
//   2. Headless callers — the Worker's `POST /api/tool/<name>` HTTP route
//      and the MCP server at `worker/src/routes/mcp.ts`. Both load the
//      project from R2, run the dispatcher, write back on `result.ok`.
//
// Element id convention (matches schema layer_order):
//   - "video.<id>"      — video layers (a source mp4 rendered into the layer
//                         box; multiple per project allowed, audio mixes in
//                         preview + export).
//   - "image.<id>"      — image layers
//   - "shapes.<id>"     — shape layers
//   - "group.<id>"      — layer groups (transform composes onto descendants)
import { SHAPE_DEFS, SHAPE_IDS } from "./shapes.ts";
import { formatClockLabel } from "./clock-time.ts";
// Cross-tree import: the font catalogues live in editor/src/ (the editor is
// their primary consumer); the agent-facing list_fonts tool reuses them so
// every source the picker knows about is also discoverable via MCP.
import {
  allFontEntries,
  getFontEntry,
  type FontSource,
} from "./font-sources.ts";
import {
  activeComposition,
  blankPage,
  clampActiveIndex,
  compositionForPage,
  writeCompositionBack,
} from "./carousel.ts";
import { fitCurveBox } from "./curve-bbox.ts";
import {
  canvasDelta,
  canvasDeltaToParentSpace,
  composeAncestors,
} from "./layer-space.ts";
import {
  DEFAULT_OVERLAY_TRANSITION_FRAMES,
  bornLayerDefaults,
} from "./transitions.ts";
import {
  animatedFillRefusal,
  blockOf,
  clampCurve,
  CAPTIONS_GROUP_NAME,
  clearFillColorTrack,
  collectCaptionsRootIds,
  fillSchema,
  findLayerByElementId,
  findParentGroup,
  getAncestorGroupChain,
  isCaptionLineElement,
  layerOf,
  deriveGroupStart,
  getGroupDescendants,
  growBlockToCoverFrame,
  guardStaticFillWrite,
  isMorphaGroup,
  type AnyLayer,
  materializeRootLayerOrder,
  projectSchema,
  reflowCompositionLayers,
  removeWeldedCaptionLines,
  resolveDefaultTextSize,
  resolveLayerTree,
  resolveMultiClipLanes,
  videoWindow,
  weldedAudioTiming,
  weldedSourceLayer,
  type AudioOverlay,
  type Composition,
  type ColorKeyframe,
  type Easing,
  type EdgeTransition,
  type TransitionDirection,
  type TransitionKind,
  type ElementColorTracks,
  type ElementTracks,
  type Fill,
  type Group,
  type ImageLayer,
  type Keyframe,
  type LayerStyle,
  MIN_SPEED,
  MAX_SPEED,
  LAYER_CLIP_DEFAULT_FRAMES,
  layerSpeed,
  sourceFrameAtTimelineOffset,
  type LoopPass,
  type PageComposition,
  type Project,
  type Shape,
  type ShapeKind,
  type TextDecorations,
  type TextLayer,
  type TrackProperty,
  type VideoLayer,
} from "./schemas.ts";
import {
  normalizeDecorations,
  rebaseDecorations,
} from "./text-decorations.ts";
import {
  computeContentDurationFrames,
  computeContentDurationSeconds,
} from "./content-duration.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ToolFunction = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

// A composition-scoped tool (the vast majority: layers, keyframes, styles,
// groups, audio, duration, text …) operates on a flat `Composition` — the
// active page projected with its project-level render context. `project` is the
// historical field name kept so the ~1000 `project.<field>` reads in the tool
// bodies compile unchanged; it holds a Composition, not the whole Project.
export type ToolOutcome = {
  project: Composition;
  result: ToolResult;
};

export type ToolDispatch<Args = Record<string, unknown>> = (
  project: Composition,
  args: Args,
) => ToolOutcome;

// A project-scoped tool operates on the whole pages-only Project — the few that
// manage the page list (add/delete/reorder/select) or touch every page at once
// (set_canvas_size). Routed by dispatchOnProject; never runs on a projection.
export type ProjectToolOutcome = {
  project: Project;
  result: ToolResult;
};

export type ProjectToolDispatch<Args = Record<string, unknown>> = (
  project: Project,
  args: Args,
) => ProjectToolOutcome;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Deep clone a Composition (the common case in composition tools) or a whole
// Project (the project-scoped tools). Generic so both callers keep their type.
const cloneProject = <T>(p: T): T => structuredClone(p) as T;

const HEX = /^#[0-9a-fA-F]{6}$/;

// Surfaced verbatim in the tool error when a fill can't be coerced, so the
// agent learns the canonical Fill rather than seeing a default silently applied.
const FILL_SHAPE_HINT =
  '"#rrggbb", or a Fill object: {type:"solid",color} / ' +
  '{type:"linear",stops:[{pos:0..1,color}],angle?} / ' +
  '{type:"radial",stops:[{pos:0..1,color}],cx?,cy?,radius?} / ' +
  '{type:"mask",layer_id,color}. Gradient stop position key is `pos` (0..1); ' +
  "`offset` is also accepted.";

// Accept the `"#rrggbb"` shorthand (promoted to a solid Fill at full opacity),
// a canonical Fill object (validated through `fillSchema`), or a loosely-shaped
// gradient an LLM is likely to emit (coerced into a canonical gradient Fill).
// Returns the parsed Fill, or null if no shape matched.
const coerceFill = (input: unknown): Fill | null => {
  if (typeof input === "string") {
    if (!HEX.test(input)) return null;
    return { type: "solid", color: input, opacity: 1 };
  }
  if (!input || typeof input !== "object") return null;
  const direct = fillSchema.safeParse(input);
  if (direct.success) return direct.data;
  return coerceGradientFill(input as Record<string, unknown>);
};

// Synonyms an LLM reaches for in place of the canonical "linear" / "radial".
const GRADIENT_TYPE_ALIASES: Record<string, "linear" | "radial"> = {
  linear: "linear",
  "linear-gradient": "linear",
  lineargradient: "linear",
  gradient: "linear",
  radial: "radial",
  "radial-gradient": "radial",
  radialgradient: "radial",
};

// Coerce a loosely-shaped gradient ({type:"linear-gradient", colors:[...]},
// stops keyed by offset/position, 0..100 offsets) into a canonical
// linear/radial Fill, then validate through `fillSchema`. null when the object
// isn't gradient-shaped or a stop colour isn't "#rrggbb".
const coerceGradientFill = (input: Record<string, unknown>): Fill | null => {
  const rawType =
    typeof input.type === "string" ? input.type.toLowerCase() : "";
  const kind = GRADIENT_TYPE_ALIASES[rawType];
  const rawStops = input.stops ?? input.colors;
  if (!kind && rawStops === undefined) return null;
  const stops = normalizeGradientStops(rawStops);
  if (!stops) return null;
  if ((kind ?? "linear") === "radial") {
    return parseFillCandidate({
      type: "radial",
      stops,
      ...(input.cx !== undefined ? { cx: input.cx } : {}),
      ...(input.cy !== undefined ? { cy: input.cy } : {}),
      ...(input.radius !== undefined ? { radius: input.radius } : {}),
    });
  }
  const angle = input.angle ?? input.degrees ?? input.deg;
  return parseFillCandidate({
    type: "linear",
    stops,
    ...(angle !== undefined ? { angle } : {}),
  });
};

const parseFillCandidate = (candidate: unknown): Fill | null => {
  const parsed = fillSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

type CoercedStop = { pos: number; color: string; opacity?: number };

// Normalize a stops/colors array into canonical {pos,color,opacity?} stops:
// bare "#rrggbb" strings, or objects keyed by color/colour + pos/offset/
// position/stop. Offsets >1 are read as 0..100 percentages; missing offsets are
// distributed evenly across the run. null if any stop is unusable.
const normalizeGradientStops = (raw: unknown): CoercedStop[] | null => {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const evenPos = (i: number) => i / (raw.length - 1);
  const out: CoercedStop[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry === "string") {
      if (!HEX.test(entry)) return null;
      out.push({ pos: evenPos(i), color: entry });
      continue;
    }
    if (!entry || typeof entry !== "object") return null;
    const o = entry as Record<string, unknown>;
    const color = o.color ?? o.colour;
    if (typeof color !== "string" || !HEX.test(color)) return null;
    const pos = normalizeStopOffset(
      o.pos ?? o.offset ?? o.position ?? o.stop,
      evenPos(i),
    );
    if (pos === null) return null;
    const stop: CoercedStop = { pos, color };
    const alpha = o.opacity ?? o.alpha;
    if (typeof alpha === "number") stop.opacity = alpha;
    out.push(stop);
  }
  return out;
};

const normalizeStopOffset = (
  raw: unknown,
  fallback: number,
): number | null => {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const pos = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, pos));
};

// Static x/y for the leaf-layer behind an elementId. Groups have no static
// position — their x/y track values are direct translation offsets around the
// frozen pivot — so this returns zeros for them. Used by apply_preset to
// turn delta-style tuple values (slide/shake) into absolute keyframes.
const baseForElement = (
  project: Composition,
  elementId: string,
): { x: number; y: number } => {
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const l = project.image_layers.find((x) => x.id === id);
    if (l) return { x: l.x, y: l.y };
  } else if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    const v = project.video_layers.find((x) => x.id === id);
    if (v) return { x: v.x, y: v.y };
  } else if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    const s = project.shapes.find((x) => x.id === id);
    if (s) return { x: s.x, y: s.y };
  } else if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    const t = project.text_layers.find((x) => x.id === id);
    if (t) return { x: t.x, y: t.y };
  }
  return { x: 0, y: 0 };
};

const VALID_PROPS: TrackProperty[] = [
  "x",
  "y",
  "width",
  "height",
  "scale",
  "rotation",
  "opacity",
  // Text-only arc curve (degrees). Keyframe it to bend a title into a smile
  // over time. Inert on non-text layers (only drawTextLayer reads it).
  "curve",
];

const VALID_EASINGS: Easing[] = [
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
  "hold",
];

const ensureTrack = (
  project: Composition,
  elementId: string,
  property: TrackProperty,
): Keyframe[] => {
  const layer = findLayerByElementId(project, elementId);
  // Callers pre-validate the element id; a miss here is defensive. Return a
  // detached array so the caller doesn't crash (the write is simply dropped).
  if (!layer) return [];
  const tracks: ElementTracks = (layer.animations ??= {} as ElementTracks);
  if (!tracks[property]) {
    tracks[property] = [];
  }
  return tracks[property] as Keyframe[];
};

const sortByFrame = (kfs: Keyframe[]) => {
  kfs.sort((a, b) => a.frame - b.frame);
};

// Upsert a keyframe at exactly `frame` on `elementId.property`. If a keyframe
// already exists at that frame, its value (and optionally easing) are updated;
// otherwise a new one is inserted with linear easing as the default.
const upsertKeyframe = (
  project: Composition,
  elementId: string,
  property: TrackProperty,
  frame: number,
  value: number,
  easing?: Easing,
): void => {
  const kfs = ensureTrack(project, elementId, property);
  const idx = kfs.findIndex((k) => k.frame === frame);
  if (idx >= 0) {
    kfs[idx] = { ...kfs[idx], value, ...(easing ? { easing } : {}) };
  } else {
    kfs.push({ frame, value, easing: easing ?? "linear" });
  }
  sortByFrame(kfs);
  // A block gates visibility AND re-bases keyframes to its start, so a keyframe
  // written past the block's end would silently never be drawn. Grow the block
  // to cover it. No-op for a blockless (always-present) layer, which is what
  // every headless-created layer is unless the caller asked for a block.
  growBlockToCoverFrame(project, elementId, frame);
};

// Force project.layer_order to be a complete list of root-level element ids,
// in the same order resolveLayerTree would return. The schema permits the
// resolver to invent missing entries (so old files round-trip cleanly), but
// dispatchers that splice into the root list need a definite ordering — call
// this on the cloned project before any layer_order mutation.
const normalizeRoot = (project: Composition): void => {
  project.layer_order = resolveLayerTree(project).map((n) => n.id);
};

// Base-position centre of a child element. Used to seed a new group's pivot.
// Returns null for unknown ids; the caller defaults to the canvas centre.
const childBaseCenter = (
  project: Composition,
  childId: string,
): { x: number; y: number } | null => {
  if (childId.startsWith("video.")) {
    const id = childId.slice("video.".length);
    const v = project.video_layers.find((x) => x.id === id);
    return v ? { x: v.x, y: v.y } : null;
  }
  if (childId.startsWith("image.")) {
    const id = childId.slice("image.".length);
    const l = project.image_layers.find((x) => x.id === id);
    return l ? { x: l.x, y: l.y } : null;
  }
  if (childId.startsWith("shapes.")) {
    const id = childId.slice("shapes.".length);
    const s = project.shapes.find((x) => x.id === id);
    return s ? { x: s.x, y: s.y } : null;
  }
  if (childId.startsWith("text.")) {
    const id = childId.slice("text.".length);
    const t = project.text_layers.find((x) => x.id === id);
    return t ? { x: t.x, y: t.y } : null;
  }
  if (childId.startsWith("group.")) {
    const id = childId.slice("group.".length);
    const g = project.groups.find((x) => x.id === id);
    return g ? { x: g.pivotX, y: g.pivotY } : null;
  }
  return null;
};

// Layer ids are 6 lowercase hex chars — opaque tokens generated at creation,
// never derived from name/filename/text content. Matches the pattern every
// major motion / NLE / design editor uses (After Effects, Premiere, FCP,
// Figma, Illustrator): ids are storage keys, names are user-facing labels,
// and the two carry no relationship. The pre-2026-05 model derived ids from
// names, which drifted as layers were renamed (e.g. `image.raj` long after
// the layer was renamed to "character"). Opaque ids end the bug class.
// The pinned background image_layer keeps its `"background"` sentinel id;
// that is the only non-hex layer id allowed.
export const LAYER_ID_FORMAT = /^[0-9a-f]{6}$/;
export const BACKGROUND_LAYER_ID = "background";

// Layer-id minting moved to src/clip-split.ts (the razor mints the right
// half's id there). Imported — not just re-exported — because this module uses
// both throughout (`export … from` creates no local binding); re-exported so
// existing importers keep working.
import {
  generateLayerId,
  insertElementAfter,
  splitClipAt,
  type LayerKind,
} from "./clip-split.ts";
export { generateLayerId, type LayerKind };

// Rewrite every reference to `oldElementId` so they point at `newElementId`.
// Mutates `project` in place — call on a cloned project. Covers every
// reference site found in `projectSchema`:
//   - the layer's own `.id` field (bare suffix after the dot); the per-element
//     animations / style / track_loops / color_tracks now ride along with the
//     layer record, so changing `.id` re-keys them implicitly.
//   - `layer_order[]`
//   - `groups[*].children[]`
//   - `matte_source_id` on every layer kind (image / video / text / shapes / group)
//   - `mask`-type `.fill.layer_id` on every layer's fill
//   - `loop[*].overrides[*].elementId`
//   - `public_properties[*].layer_id`
// Both ids must share the same kind prefix; the function throws otherwise.
export const rekeyElementId = (
  project: Composition,
  oldElementId: string,
  newElementId: string,
): void => {
  if (oldElementId === newElementId) return;
  const oldDot = oldElementId.indexOf(".");
  const newDot = newElementId.indexOf(".");
  if (oldDot < 1 || newDot < 1) {
    throw new Error(`rekeyElementId: ids must contain "kind." prefix`);
  }
  const oldKind = oldElementId.slice(0, oldDot);
  const newKind = newElementId.slice(0, newDot);
  if (oldKind !== newKind) {
    throw new Error(`rekeyElementId: kind mismatch ${oldKind} → ${newKind}`);
  }
  const oldBare = oldElementId.slice(oldDot + 1);
  const newBare = newElementId.slice(newDot + 1);

  // 1. The layer's own .id field
  const arr =
    oldKind === "image"
      ? project.image_layers
      : oldKind === "video"
        ? project.video_layers
        : oldKind === "text"
          ? project.text_layers
          : oldKind === "shapes"
            ? project.shapes
            : oldKind === "group"
              ? project.groups
              : null;
  if (!arr) {
    throw new Error(`rekeyElementId: unknown kind ${oldKind}`);
  }
  for (const layer of arr as { id: string }[]) {
    if (layer.id === oldBare) layer.id = newBare;
  }

  // 2. layer_order
  project.layer_order = project.layer_order.map((id) =>
    id === oldElementId ? newElementId : id,
  );

  // (Per-element animations / style / track_loops / color_tracks now live on
  // the layer record itself and rode along when site 1 rewrote `layer.id` — no
  // separate re-key needed.)

  // 3. groups[*].children[]
  for (const g of project.groups) {
    g.children = g.children.map((id) =>
      id === oldElementId ? newElementId : id,
    );
  }

  // 4. matte_source_id on every layer kind
  const fixMatte = (layer: { matte_source_id?: string | null }): void => {
    if (layer.matte_source_id === oldElementId) {
      layer.matte_source_id = newElementId;
    }
  };
  project.image_layers.forEach(fixMatte);
  project.video_layers.forEach(fixMatte);
  project.text_layers.forEach(fixMatte);
  project.shapes.forEach(fixMatte);
  project.groups.forEach(fixMatte);

  // 5. mask-type fills (.fill.layer_id) — discriminated union, check type
  const fixMaskFill = (layer: { fill?: Fill | null }): void => {
    if (layer.fill && layer.fill.type === "mask") {
      if (layer.fill.layer_id === oldElementId) {
        layer.fill.layer_id = newElementId;
      }
    }
  };
  project.image_layers.forEach(fixMaskFill);
  project.video_layers.forEach(fixMaskFill);
  project.text_layers.forEach(fixMaskFill);
  project.shapes.forEach(fixMaskFill);
  project.groups.forEach(fixMaskFill);

  // 6. loop[*].overrides[*].elementId
  if (project.loop) {
    for (const pass of project.loop) {
      for (const ov of pass.overrides) {
        if (ov.elementId === oldElementId) ov.elementId = newElementId;
      }
    }
  }

  // 7. public_properties[*].layer_id
  if (project.public_properties) {
    for (const pp of project.public_properties) {
      if (pp.layer_id === oldElementId) pp.layer_id = newElementId;
    }
  }

  // 8. The two WELDS onto a clip — a caption line's `caption_source
  // .clip_element_id` and an audio overlay's `sourceLayerId`. Both hold a
  // `video.<id>` and both derive their timing LIVE from the clip they name
  // (deriveCaptionWindow / weldedAudioTiming), so a weld left pointing at the
  // old id doesn't merely go stale — the line or overlay re-times against a
  // DIFFERENT clip, or falls back to a stored block that was only ever meant to
  // cover a missing clip. `remove_layer` already treats both as references (it
  // takes them with the clip); they were simply never mirrored here, so a
  // pasted subtree kept its captions anchored to the clip they were copied FROM.
  // `audio_overlays` is optional on the standalone composition pasteSubtree
  // re-keys against, hence the guard.
  if (oldKind === "video") {
    for (const t of project.text_layers) {
      const cs = t.caption_source;
      if (cs && cs.clip_element_id === oldElementId) {
        t.caption_source = { ...cs, clip_element_id: newElementId };
      }
    }
    if (project.audio_overlays) {
      for (const ov of project.audio_overlays) {
        if (ov.sourceLayerId === oldElementId) ov.sourceLayerId = newElementId;
      }
    }
  }
};

// Drop every dangling reference to `elementId` once its primary layer object
// has been spliced out by the caller. The deletion-mirror of rekeyElementId —
// it MUST cover the same reference sites (2–7; site 1, the layer's own record,
// is the caller's splice, which also carries off its per-element animations /
// style / track_loops / color_tracks). When a reference site is added to
// rekeyElementId, add it here too.
//
// Site 8 (the caption / audio WELDS onto a clip) is the one deliberate
// exception, and it is not an omission: a welded caption line and a welded
// audio overlay have no standalone existence, so deleting a clip DELETES them
// rather than un-welding them — `remove_layer`'s video branch does that at the
// call site (removeWeldedCaptionLines + the sourceLayerId filter), before
// anything here could observe an orphan. Clearing the weld here instead would
// leave a caption line stranded with a fallback block, which is the state that
// exists for a MISSING clip, not a deleted one.
const purgeElementId = (project: Composition, elementId: string): void => {
  // 2. layer_order
  project.layer_order = project.layer_order.filter((id) => id !== elementId);

  // (The per-element animations / style / track_loops / color_tracks lived on
  // the spliced-out layer record, so they're already gone — nothing to delete.)

  // 3. groups[*].children[]
  for (const g of project.groups) {
    g.children = g.children.filter((id) => id !== elementId);
  }

  // 4. matte_source_id on every layer kind
  const clearMatte = (layer: { matte_source_id?: string | null }): void => {
    if (layer.matte_source_id === elementId) layer.matte_source_id = null;
  };
  project.image_layers.forEach(clearMatte);
  project.video_layers.forEach(clearMatte);
  project.text_layers.forEach(clearMatte);
  project.shapes.forEach(clearMatte);
  project.groups.forEach(clearMatte);

  // 5. mask-type fills (.fill.layer_id). Nullable-fill kinds drop the fill;
  // shapes require a fill, so the orphaned mask degrades to a solid of its
  // own colour rather than leaving an unresolvable layer_id behind.
  const dropMaskFill = (layer: { fill?: Fill | null }): void => {
    if (
      layer.fill &&
      layer.fill.type === "mask" &&
      layer.fill.layer_id === elementId
    ) {
      layer.fill = null;
    }
  };
  project.image_layers.forEach(dropMaskFill);
  project.video_layers.forEach(dropMaskFill);
  project.text_layers.forEach(dropMaskFill);
  project.groups.forEach(dropMaskFill);
  for (const s of project.shapes) {
    if (s.fill.type === "mask" && s.fill.layer_id === elementId) {
      s.fill = { type: "solid", color: s.fill.color, opacity: s.fill.opacity };
    }
  }
  // The fill's OTHER home. A colour keyframe holds a whole Fill, so a mask
  // pointing at the deleted layer survives there too — and the track is what
  // the renderer reads, so purging only the static field leaves the dangling
  // reference in the copy that actually paints. Degrade each such keyframe the
  // same way, to a solid of its own colour.
  const dropMaskKeyframes = (layer: AnyLayer): void => {
    const track = layer.color_tracks?.fill;
    if (!track) return;
    for (let i = 0; i < track.length; i += 1) {
      const v = track[i].value;
      if (v.type === "mask" && v.layer_id === elementId) {
        track[i] = {
          ...track[i],
          value: { type: "solid", color: v.color, opacity: v.opacity },
        };
      }
    }
  };
  project.image_layers.forEach(dropMaskKeyframes);
  project.video_layers.forEach(dropMaskKeyframes);
  project.text_layers.forEach(dropMaskKeyframes);
  project.shapes.forEach(dropMaskKeyframes);
  project.groups.forEach(dropMaskKeyframes);

  // 6. loop[*].overrides[*].elementId
  if (project.loop) {
    for (const pass of project.loop) {
      pass.overrides = pass.overrides.filter((ov) => ov.elementId !== elementId);
    }
  }

  // 7. public_properties[*].layer_id
  if (project.public_properties) {
    project.public_properties = project.public_properties.filter(
      (pp) => pp.layer_id !== elementId,
    );
  }
};

// Walk every layer in the project and re-id any whose current id doesn't
// match LAYER_ID_FORMAT (other than the pinned background sentinel). Used by
// the one-shot `POST /api/migrate-layer-ids` route to normalize legacy
// projects whose ids were derived from layer names (e.g. `image.raj`,
// `text.label-raj`). Mutates `project` in place; returns the list of rekeys
// performed so the route can report what changed.
export const normalizeProjectLayerIds = (
  project: Composition,
): Array<{ from: string; to: string }> => {
  const rekeys: Array<{ from: string; to: string }> = [];
  const kinds: LayerKind[] = ["image", "video", "text", "shapes", "group"];
  for (const kind of kinds) {
    // Snapshot the list of (kind, oldBareId) BEFORE mutating — the array's
    // element identity is preserved across rekeyElementId calls, but we want
    // a stable iteration order regardless of any future reshape.
    const arr =
      kind === "image"
        ? project.image_layers
        : kind === "video"
          ? project.video_layers
          : kind === "text"
            ? project.text_layers
            : kind === "shapes"
              ? project.shapes
              : project.groups;
    const snapshot = arr.map((l) => l);
    for (const layer of snapshot) {
      // Pinned background image keeps its sentinel id forever.
      if (kind === "image" && (layer as ImageLayer).is_background) continue;
      if (layer.id === BACKGROUND_LAYER_ID) continue;
      if (LAYER_ID_FORMAT.test(layer.id)) continue;
      const oldElementId = `${kind}.${layer.id}`;
      const newBare = generateLayerId(project, kind);
      const newElementId = `${kind}.${newBare}`;
      rekeyElementId(project, oldElementId, newElementId);
      rekeys.push({ from: oldElementId, to: newElementId });
    }
  }
  return rekeys;
};

// ---------------------------------------------------------------------------
// inlineMorpha — embed one project ("a morpha") inside another
// ---------------------------------------------------------------------------

export type InlineMorphaOptions = {
  /** Source project id (the embedded morpha). Never shown to users. */
  sourceMorphaId: string;
  /** Pinned version's opaque id (from the versions API). */
  versionId?: string;
  /** User-facing version label, e.g. "v3". */
  versionLabel?: string;
  /** Source project name, cached on the band for display (the only handle a
   *  user ever sees — ids stay hidden). */
  sourceName?: string;
  /** Frame on the HOST timeline where the band is placed — its TIME ORIGIN. The
   *  band gets a block starting here (spanning the source's content length), and
   *  every descendant samples at `frame − blockStart`, so the embedded reel's
   *  internal animation plays relative to where it's dropped (fixing "the intro
   *  fires at 0:00 while the band is invisible"). Omit ⇒ the band is
   *  always-present and its children play at absolute host frames (legacy). The
   *  editor passes the current playhead; a headless caller may pass a frame. */
  blockStart?: number;
};

// Inline `source`'s layers into `host` as a new EMBEDDED-MORPHA group — a
// version-pinned "band". Pure: returns a fresh host project, never mutating
// either input. The band is an ordinary `group` (so the renderer/export
// composite it natively, no new layer kind) carrying provenance fields.
// A carousel source keeps its composition in `carousel.pages[]` (top-level
// arrays empty), so it inlines as the projection of its ACTIVE page —
// matching the content-tools-target-the-active-page convention.
//
// - The source's canvas backdrop (`is_background`) becomes the band group's
//   editable/removable backdrop fill, so the morpha looks as it does
//   standalone but the fill can be cleared for overlay use.
// - Every other source layer is deep-cloned, re-keyed to host-unique ids
//   (so two embeds of the same morpha never collide), stamped with
//   `source_layer_id` (its ORIGINAL element id, for publish-back mapping) and,
//   for media layers, `asset_project_id` (so its image/clip resolves from the
//   source's R2 bucket), then nested under the band group in source z-order.
export const inlineMorpha = (
  host: Composition,
  source: Composition,
  opts: InlineMorphaOptions,
): ToolOutcome => {
  if (!opts.sourceMorphaId) {
    return { project: host, result: { ok: false, error: "sourceMorphaId is required" } };
  }
  if (opts.sourceMorphaId === host.project_id) {
    return { project: host, result: { ok: false, error: "a morpha can't embed itself" } };
  }

  const next = cloneProject(host);
  // `source` is already the flat active-page composition (addMorphaLayer
  // projects it via activeComposition), so it inlines directly.
  const src = cloneProject(source);

  // Source canvas backdrop → band group backdrop fill (editable, removable).
  const srcBg = findBackgroundLayer(src);
  const bgBareId = srcBg ? srcBg.id : null;
  const bgElementId = srcBg ? `image.${srcBg.id}` : null;
  const bgFill = srcBg ? srcBg.fill : null;

  // Stamp provenance on every NON-background source layer BEFORE re-keying:
  // source_layer_id (original eid) on all kinds; asset_project_id on media.
  const stamp = (kind: LayerKind, layers: Array<{ id: string }>): void => {
    for (const l of layers) {
      const eid = `${kind}.${l.id}`;
      if (eid === bgElementId) continue;
      (l as { source_layer_id?: string }).source_layer_id = eid;
      if (kind === "image" || kind === "video") {
        (l as { asset_project_id?: string }).asset_project_id = opts.sourceMorphaId;
      }
    }
  };
  stamp("image", src.image_layers);
  stamp("video", src.video_layers);
  stamp("text", src.text_layers);
  stamp("shapes", src.shapes);
  stamp("group", src.groups);

  // Re-key every source element to an id unique against BOTH the host and the
  // source's own remaining ids (so a mint never lands on an unprocessed source
  // id) and prior mints. rekeyElementId rewrites src's internal refs in place;
  // source_layer_id rides along untouched.
  const reserved: Record<LayerKind, Set<string>> = {
    image: new Set([...next.image_layers, ...src.image_layers].map((l) => l.id)),
    video: new Set([...next.video_layers, ...src.video_layers].map((l) => l.id)),
    text: new Set([...next.text_layers, ...src.text_layers].map((l) => l.id)),
    shapes: new Set([...next.shapes, ...src.shapes].map((l) => l.id)),
    group: new Set([...next.groups, ...src.groups].map((l) => l.id)),
  };
  const mintId = (kind: LayerKind): string => {
    for (let i = 0; i < 100; i += 1) {
      const buf = new Uint8Array(3);
      crypto.getRandomValues(buf);
      const id = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!reserved[kind].has(id)) {
        reserved[kind].add(id);
        return id;
      }
    }
    throw new Error(`inlineMorpha: 100 id-mint collisions on ${kind}`);
  };
  const rekeyAll = (kind: LayerKind, layers: Array<{ id: string }>): void => {
    const originals = layers
      .map((l) => l.id)
      .filter((id) => `${kind}.${id}` !== bgElementId);
    for (const oldBare of originals) {
      rekeyElementId(src, `${kind}.${oldBare}`, `${kind}.${mintId(kind)}`);
    }
  };
  rekeyAll("image", src.image_layers);
  rekeyAll("video", src.video_layers);
  rekeyAll("text", src.text_layers);
  rekeyAll("shapes", src.shapes);
  rekeyAll("group", src.groups);

  // rekeyElementId already rewrote src.layer_order to the new ids; the
  // backdrop never appears there. That ordered list is the band's children.
  const bandChildren = src.layer_order.filter((eid) => eid !== bgElementId);

  // Merge the re-keyed source layer records into the host arrays (dropping the
  // backdrop — it lives on the band group as a fill).
  next.image_layers = [
    ...next.image_layers,
    ...src.image_layers.filter((l) => l.id !== bgBareId && !l.is_background),
  ];
  next.video_layers = [...next.video_layers, ...src.video_layers];
  next.text_layers = [...next.text_layers, ...src.text_layers];
  next.shapes = [...next.shapes, ...src.shapes];
  next.groups = [...next.groups, ...src.groups];

  // Create the band group at the host canvas centre, carrying the morpha
  // provenance. Append only the band id to the host root order — its children
  // live nested under it.
  const bandId = mintId("group");
  const bandElementId = `group.${bandId}`;
  // Fall back to the RECORD's name — a carousel projection's `name` is the
  // active page's, not the project's.
  const displayName = opts.sourceName ?? source.name ?? "";
  next.groups = [
    ...next.groups,
    {
      id: bandId,
      name: displayName,
      opacity: 1,
      pivotX: next.canvas_width / 2,
      pivotY: next.canvas_height / 2,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      children: bandChildren,
      fill: bgFill,
      box_width: bgFill ? src.canvas_width : 0,
      box_height: bgFill ? src.canvas_height : 0,
      source_morpha_id: opts.sourceMorphaId,
      source_version_id: opts.versionId,
      source_version_label: opts.versionLabel,
      source_morpha_name: displayName.length > 0 ? displayName : undefined,
      // Place the band on the host timeline: its block start is the band's time
      // origin (descendants sample at frame − start), and its duration is the
      // source reel's content length so it plays as a clip. Omitted ⇒ blockless
      // = always-present, children at absolute host frames (legacy behavior).
      ...(opts.blockStart !== undefined
        ? {
            block: {
              start: Math.max(0, Math.round(opts.blockStart)),
              duration: Math.max(1, computeContentDurationFrames(source)),
            },
          }
        : {}),
    },
  ];
  next.layer_order = [...next.layer_order, bandElementId];

  return {
    project: next,
    result: {
      ok: true,
      data: {
        id: bandId,
        elementId: bandElementId,
        childCount: bandChildren.length,
        name: displayName,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Group subtree copy / paste
// ---------------------------------------------------------------------------
//
// A group is a subtree: the group record plus the transitive closure of its
// `children` (leaves and nested groups), each layer carrying its own
// animations / style / colour tracks. `collectSubtree` extracts that closure
// into a self-contained bundle (the ⌘C payload); `pasteSubtree` re-keys every
// id in the bundle to destination-unique ids and merges it in (the ⌘V action).
// Together they are the group-aware counterpart to the leaf clipboard, and the
// paste half is `inlineMorpha` without the embedded-morpha provenance.

// A copied group + everything under it. `rootElementId` and every id inside the
// arrays are still the SOURCE project's ids — `pasteSubtree` re-keys them.
export interface SubtreeBundle {
  rootElementId: string;
  image_layers: ImageLayer[];
  video_layers: VideoLayer[];
  text_layers: TextLayer[];
  shapes: Shape[];
  groups: Group[];
}

// A pasted media descendant whose bytes live in another project's bucket. The
// editor copies them into the destination after the paste lands, then drops the
// asset_project_id. `elementId` is the id in the DESTINATION (already re-keyed).
export interface PendingMedia {
  elementId: string;
  kind: "image" | "video";
  filename: string;
  sourceProjectId: string;
}

// Extract the group at `rootElementId` and its whole descendant closure into a
// bundle. Returns null if the id isn't a present group. Deep-clones every
// record so the bundle is detached from `project`.
export const collectSubtree = (
  project: Composition,
  rootElementId: string,
): SubtreeBundle | null => {
  if (!rootElementId.startsWith("group.")) return null;
  const rootGroup = findLayerByElementId(project, rootElementId);
  if (!rootGroup) return null;

  const bundle: SubtreeBundle = {
    rootElementId,
    image_layers: [],
    video_layers: [],
    text_layers: [],
    shapes: [],
    groups: [],
  };
  const push = (elementId: string): void => {
    const layer = findLayerByElementId(project, elementId);
    if (!layer) return;
    const clone = structuredClone(layer);
    if (elementId.startsWith("image.")) bundle.image_layers.push(clone as ImageLayer);
    else if (elementId.startsWith("video.")) bundle.video_layers.push(clone as VideoLayer);
    else if (elementId.startsWith("text.")) bundle.text_layers.push(clone as TextLayer);
    else if (elementId.startsWith("shapes.")) bundle.shapes.push(clone as Shape);
    else if (elementId.startsWith("group.")) bundle.groups.push(clone as Group);
  };

  push(rootElementId);
  for (const descendant of getGroupDescendants(project, rootGroup.id)) {
    push(descendant);
  }
  return bundle;
};

// Put freshly-pasted clips on their OWN lanes, in place. `lane_id` buckets
// clips into ONE timeline row (`resolveLanes`), and it is not an element id, so
// nothing in the re-key path rewrites it: a pasted clip carrying the source's
// lane_id folds straight back into the original's row, and — pasting keeps
// `timeline_start_frame` — lands exactly on top of the clip it was copied from.
// The copy is then invisible in the timeline and can't be grabbed, which reads
// as "paste did nothing". Same rule `duplicate_layer` already applies ("a
// duplicated clip is a fresh take, not a keyframed sibling").
//
// Each DISTINCT source lane maps to one fresh lane, so a folded multi-clip take
// copied whole stays one lane end-to-end instead of exploding into a row per
// clip. A clip with no lane_id needs nothing: `resolveLanes` falls back to its
// id, which the re-key already made unique. Call AFTER the copies have their
// destination ids — the first clip of each lane donates its new id as the lane
// id, mirroring `add_video_layer`.
export const relaneClipCopies = (clips: VideoLayer[]): void => {
  const remapped = new Map<string, string>();
  for (const clip of clips) {
    const sourceLane = clip.lane_id;
    if (!sourceLane) continue;
    const already = remapped.get(sourceLane);
    if (already !== undefined) {
      clip.lane_id = already;
    } else {
      remapped.set(sourceLane, clip.id);
      clip.lane_id = clip.id;
    }
  }
};

// Add `delta` to a group's frame-0 x/y translation (groups have no static base
// position, so a paste offset lives on the translation track). Mirrors the
// store's group-nudge so a pasted group can be dragged clear of the original.
const bumpGroupFrameZero = (
  project: Composition,
  elementId: string,
  property: TrackProperty,
  delta: number,
): void => {
  const kfs = ensureTrack(project, elementId, property);
  const idx = kfs.findIndex((k) => k.frame === 0);
  if (idx >= 0) kfs[idx] = { ...kfs[idx], value: kfs[idx].value + delta };
  else kfs.push({ frame: 0, value: delta, easing: "linear" });
  sortByFrame(kfs);
};

// Paste a subtree bundle into `dest`. Re-keys every id in the bundle to ids
// unique against dest (so same-project paste never collides and never renames a
// dest layer), merges the records in, appends the new root group to the root
// z-order, and nudges it by `offset` px. Media descendants whose bytes live in
// another project are repointed at that bucket and returned as `pendingMedia`
// for the caller to copy across. Pure: never mutates `dest` or `bundle`.
export const pasteSubtree = (
  dest: Composition,
  bundle: SubtreeBundle,
  opts: { sourceProjectId: string; offset?: number },
): { project: Composition; rootElementId: string; pendingMedia: PendingMedia[] } => {
  const next = cloneProject(dest);
  const offset = opts.offset ?? 0;

  // Re-key the bundle in isolation as a standalone project so a mint can't land
  // on — or rename — an existing dest layer. rekeyElementId only reads the
  // layer arrays + layer_order (loop / public_properties stay undefined here).
  const sub = {
    image_layers: bundle.image_layers.map((l) => structuredClone(l)),
    video_layers: bundle.video_layers.map((l) => structuredClone(l)),
    text_layers: bundle.text_layers.map((l) => structuredClone(l)),
    shapes: bundle.shapes.map((l) => structuredClone(l)),
    groups: bundle.groups.map((l) => structuredClone(l)),
    layer_order: [bundle.rootElementId],
  } as unknown as Composition;

  const reserved: Record<LayerKind, Set<string>> = {
    image: new Set([...next.image_layers, ...sub.image_layers].map((l) => l.id)),
    video: new Set([...next.video_layers, ...sub.video_layers].map((l) => l.id)),
    text: new Set([...next.text_layers, ...sub.text_layers].map((l) => l.id)),
    shapes: new Set([...next.shapes, ...sub.shapes].map((l) => l.id)),
    group: new Set([...next.groups, ...sub.groups].map((l) => l.id)),
  };
  const mintId = (kind: LayerKind): string => {
    for (let i = 0; i < 100; i += 1) {
      const buf = new Uint8Array(3);
      crypto.getRandomValues(buf);
      const id = Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (!reserved[kind].has(id)) {
        reserved[kind].add(id);
        return id;
      }
    }
    throw new Error(`pasteSubtree: 100 id-mint collisions on ${kind}`);
  };
  const rekeyAll = (kind: LayerKind, layers: Array<{ id: string }>): void => {
    const originals = layers.map((l) => l.id);
    for (const oldBare of originals) {
      rekeyElementId(sub, `${kind}.${oldBare}`, `${kind}.${mintId(kind)}`);
    }
  };
  rekeyAll("image", sub.image_layers);
  rekeyAll("video", sub.video_layers);
  rekeyAll("text", sub.text_layers);
  rekeyAll("shapes", sub.shapes);
  rekeyAll("group", sub.groups);
  // `lane_id` is not an element id, so rekeyElementId leaves it pointing at the
  // SOURCE lane — see relaneClipCopies for why that hides the paste.
  relaneClipCopies(sub.video_layers);

  // rekeyElementId rewrote sub.layer_order, so its sole entry is the new root.
  const rootElementId = sub.layer_order[0];

  // Media whose bytes live elsewhere: point at that bucket for instant render
  // and queue a byte-copy. `asset_project_id` already set = inlined-morpha media
  // that stays pointing at its own home.
  const pendingMedia: PendingMedia[] = [];
  const claimMedia = (
    layer: {
      id: string;
      asset_project_id?: string;
      filename?: string;
      clip?: string;
    },
    kind: "image" | "video",
  ): void => {
    const filename = kind === "image" ? layer.filename : layer.clip;
    const home = layer.asset_project_id ?? opts.sourceProjectId;
    if (home !== next.project_id) {
      layer.asset_project_id = home;
      if (filename) {
        pendingMedia.push({ elementId: `${kind}.${layer.id}`, kind, filename, sourceProjectId: home });
      }
    } else {
      delete layer.asset_project_id;
    }
  };
  sub.image_layers.forEach((l) => claimMedia(l, "image"));
  sub.video_layers.forEach((l) => claimMedia(l, "video"));

  // Materialize the dest's CURRENT root order before merging so the pasted
  // root lands ON TOP: root ids missing from a partial layer_order render
  // above the explicit list, so appending to it as-is would sink the paste
  // under any layer still on the canonical fallback.
  const rootOrder = materializeRootLayerOrder(next);
  next.image_layers = [...next.image_layers, ...sub.image_layers];
  next.video_layers = [...next.video_layers, ...sub.video_layers];
  next.text_layers = [...next.text_layers, ...sub.text_layers];
  next.shapes = [...next.shapes, ...sub.shapes];
  next.groups = [...next.groups, ...sub.groups];
  next.layer_order = [...rootOrder, rootElementId];

  if (offset !== 0) {
    bumpGroupFrameZero(next, rootElementId, "x", offset);
    bumpGroupFrameZero(next, rootElementId, "y", offset);
  }

  return { project: next, rootElementId, pendingMedia };
};

type AddMorphaLayerArgs = {
  source_morpha_id: string;
  // The fetched source Project JSON, injected by the caller (worker tool route
  // / editor adapter) — the agent only supplies `source_morpha_id` (+ version).
  source_project?: unknown;
  version_id?: string;
  version_label?: string;
  source_name?: string;
};

// Pure tool: embed another project as a version-pinned band. The source
// project JSON must be supplied in `source_project` (the worker route fetches
// it from R2 at the pinned version and injects it; the editor adapter does the
// same client-side). Delegates to `inlineMorpha`.
const addMorphaLayer: ToolDispatch<AddMorphaLayerArgs> = (project, args) => {
  if (!args || typeof args.source_morpha_id !== "string" || args.source_morpha_id.length === 0) {
    return { project, result: { ok: false, error: "source_morpha_id is required" } };
  }
  if (args.source_project == null) {
    return {
      project,
      result: {
        ok: false,
        error:
          "source_project is required (the fetched source project JSON for the pinned version)",
      },
    };
  }
  let source: Composition;
  try {
    // The injected JSON is a full (multi-page) Project; inline its active page.
    source = activeComposition(projectSchema.parse(args.source_project));
  } catch (e) {
    return {
      project,
      result: { ok: false, error: `source_project failed to parse: ${(e as Error).message}` },
    };
  }
  return inlineMorpha(project, source, {
    sourceMorphaId: args.source_morpha_id,
    versionId: typeof args.version_id === "string" ? args.version_id : undefined,
    versionLabel: typeof args.version_label === "string" ? args.version_label : undefined,
    sourceName: typeof args.source_name === "string" ? args.source_name : undefined,
  });
};

// Replace an existing band's content with a fresh inline of a chosen source
// snapshot (the version-picker re-pin), preserving the band's host placement
// (pivot, transform tracks, name, colour label, z-order slot) and re-pinning it.
export const replaceBand = (
  host: Composition,
  bandGroupId: string,
  freshSource: Composition,
  pin: InlineMorphaOptions,
): ToolOutcome => {
  const old = host.groups.find((g) => g.id === bandGroupId);
  if (!old || !isMorphaGroup(old)) {
    return { project: host, result: { ok: false, error: "not an embedded morpha band" } };
  }
  const oldEid = `group.${bandGroupId}`;
  const oldIdx = host.layer_order.indexOf(oldEid);
  // Where the band SITS IN THE TREE, captured before anything is stripped. A
  // nested band lives in its parent group's `children`, not in the root
  // `layer_order`, and re-pinning mints a NEW group id — so restoring only the
  // layer_order slot (as this used to) left the parent pointing at an id that no
  // longer resolved AND floated the fresh band up to the root. The parent's
  // `children` is an unenforced list of ids, so nothing caught it.
  const parentGroup = host.groups.find((g) => g.children.includes(oldEid));
  const parentChildIdx = parentGroup
    ? parentGroup.children.indexOf(oldEid)
    : -1;

  // Strip the old band + every descendant.
  const stripped = cloneProject(host);
  const toRemove = new Set<string>([oldEid, ...getGroupDescendants(host, bandGroupId)]);
  const removeBare: Record<LayerKind, Set<string>> = {
    image: new Set(),
    video: new Set(),
    text: new Set(),
    shapes: new Set(),
    group: new Set(),
  };
  for (const eid of toRemove) {
    removeBare[eid.slice(0, eid.indexOf(".")) as LayerKind].add(
      eid.slice(eid.indexOf(".") + 1),
    );
  }
  stripped.image_layers = stripped.image_layers.filter((l) => !removeBare.image.has(l.id));
  stripped.video_layers = stripped.video_layers.filter((l) => !removeBare.video.has(l.id));
  stripped.text_layers = stripped.text_layers.filter((l) => !removeBare.text.has(l.id));
  stripped.shapes = stripped.shapes.filter((l) => !removeBare.shapes.has(l.id));
  stripped.groups = stripped.groups.filter((g) => !removeBare.group.has(g.id));
  // Removing the RECORDS is only half of a removal — every id that pointed at
  // them has to go too, and there are seven such places (layer_order, group
  // children, matte_source_id, mask fills, loop overrides, public_properties).
  // purgeElementId is the single remover that knows all of them, and every other
  // deletion path in the codebase calls it. This one used to hand-roll a
  // layer_order filter and nothing else, which is why re-pinning a NESTED band
  // left its parent pointing at an id that no longer resolved — and would have
  // left a dangling matte source or mask fill just as silently.
  for (const eid of toRemove) purgeElementId(stripped, eid);

  const { project: inlined, result } = inlineMorpha(stripped, freshSource, pin);
  if (!result.ok) return { project: host, result };
  const data = result.data as { id: string; elementId: string };

  const newBand = inlined.groups.find((g) => g.id === data.id);
  if (newBand) {
    newBand.pivotX = old.pivotX;
    newBand.pivotY = old.pivotY;
    newBand.name = old.name;
    if (old.animations) newBand.animations = structuredClone(old.animations);
    if (old.style) newBand.style = structuredClone(old.style);
    if (old.color_label) newBand.color_label = old.color_label;
    // Preserve the band's timeline placement (start = time origin, duration =
    // window) across a re-pin, so re-pinning to another version keeps the band
    // where the user dropped it — re-pin-safe by construction.
    if (old.block) newBand.block = { ...old.block };
  }
  // Restore the band's original position in the tree. inlineMorpha always appends
  // the fresh band to the root layer_order, so drop that first and then put it
  // back where the OLD one actually was — which is the parent group's `children`
  // for a nested band (z-order inside a group comes from that array) and the root
  // `layer_order` otherwise. The two are mutually exclusive: a nested band in
  // layer_order would be drawn twice, a root band in neither would vanish.
  // purgeElementId already removed oldEid from the parent's children, so the slot
  // index captured up front is what puts it back in the same place.
  inlined.layer_order = inlined.layer_order.filter((id) => id !== data.elementId);
  const parent = parentGroup
    ? inlined.groups.find((g) => g.id === parentGroup.id)
    : undefined;
  if (parent) {
    parent.children.splice(
      Math.min(parentChildIdx, parent.children.length),
      0,
      data.elementId,
    );
  } else {
    const idx =
      oldIdx >= 0
        ? Math.min(oldIdx, inlined.layer_order.length)
        : inlined.layer_order.length;
    inlined.layer_order.splice(idx, 0, data.elementId);
  }

  return { project: inlined, result };
};

// ---------------------------------------------------------------------------
// describe_video
// ---------------------------------------------------------------------------

// Locate the canvas-backdrop image_layer id ("background" by convention,
// but tolerant of migrated projects where the id may differ). Returns null
// only for a project that's never been through `projectSchema.parse` — the
// preprocess guarantees one exists.
const findBackgroundLayer = (project: Composition): ImageLayer | null => {
  for (const l of project.image_layers) {
    if (l.is_background) return l;
  }
  return null;
};
const backgroundElementId = (project: Composition): string | null => {
  const l = findBackgroundLayer(project);
  return l ? `image.${l.id}` : null;
};
// Resolve the agent-facing alias `"background.canvas"` to the actual
// element id (`"image.<bgId>"`). Agents written against the previous
// schema keep working — they pass "background.canvas" and the dispatcher
// rewrites it on the fly. Everything else passes through unchanged.
const resolveBackgroundAlias = (
  project: Composition,
  elementId: string,
): string => {
  if (elementId === "background.canvas") {
    const eid = backgroundElementId(project);
    if (eid) return eid;
  }
  return elementId;
};

type ElementType = "image" | "video" | "text" | "shapes" | "group";

const elementTypeOf = (elementId: string): ElementType | null => {
  if (elementId.startsWith("image.")) return "image";
  if (elementId.startsWith("video.")) return "video";
  if (elementId.startsWith("text.")) return "text";
  if (elementId.startsWith("shapes.")) return "shapes";
  if (elementId.startsWith("group.")) return "group";
  return null;
};

// Bare id from an element id. Prefix length is always `type.length + 1` (the
// dot): image.→6, video.→6, text.→5, shapes.→7, group.→6.
const bareIdOf = (elementId: string, type: ElementType): string =>
  elementId.slice(type.length + 1);

// Which properties carry a non-empty animation track for this element —
// transform tracks (`animations`) plus the fill colour track (`color_tracks`,
// surfaced as the pseudo-property "fill"). Returns just the keys, never the
// keyframe arrays themselves — that's the whole point of the overview.
const animatedProps = (project: Composition, elementId: string): string[] => {
  const out: string[] = [];
  const layer = findLayerByElementId(project, elementId);
  const tracks = layer?.animations as Record<string, unknown[]> | undefined;
  if (tracks) {
    for (const k of Object.keys(tracks)) {
      if (Array.isArray(tracks[k]) && tracks[k].length > 0) out.push(k);
    }
  }
  const color = layer?.color_tracks;
  if (color?.fill && (color.fill as unknown[]).length > 0) out.push("fill");
  return out;
};

// One node of the describe_video overview tree. Cheap: geometry + name + the
// type-specific label + which properties are animated. NO keyframe arrays, NO
// styles — pull those per-element via inspect_layers.
type OverviewNode = {
  elementId: string;
  type: ElementType;
  name: string | null;
  filename?: string;
  clip?: string;
  text?: string;
  kind?: ShapeKind;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  source_in_frame?: number;
  source_out_frame?: number | null;
  timeline_start_frame?: number;
  // Lane (track) grouping for video layers. Clips sharing a lane_id are one
  // visual track laid end-to-end (split halves / cut_range fragments of one
  // take). A lane is a TIME track, not a z-order group, so the tree stays 1:1;
  // bucket video nodes by lane_id to see which clips belong to the same take.
  lane_id?: string;
  pivotX?: number;
  pivotY?: number;
  childCount?: number;
  // Embedded-morpha provenance — present ONLY on a group that is an explicit
  // embed (another project inlined as a version-pinned band), so an agent can
  // tell an embed apart from a plain group. Absent on ordinary groups.
  morpha?: true;
  source_morpha_id?: string;
  source_version_label?: string;
  source_morpha_name?: string;
  animated?: string[];
  children?: OverviewNode[];
};

const overviewNode = (
  project: Composition,
  node: { id: string; children?: { id: string; children?: unknown[] }[] },
): OverviewNode | null => {
  const elementId = node.id;
  const type = elementTypeOf(elementId);
  if (!type) return null;
  const id = bareIdOf(elementId, type);
  const animated = animatedProps(project, elementId);
  const animField = animated.length > 0 ? { animated } : {};

  if (type === "group") {
    const g = project.groups.find((x) => x.id === id);
    if (!g) return null;
    const children = (node.children ?? [])
      .map((c) => overviewNode(project, c as { id: string }))
      .filter((n): n is OverviewNode => n !== null)
      .reverse();
    return {
      elementId,
      type,
      name: g.name ?? null,
      pivotX: g.pivotX,
      pivotY: g.pivotY,
      childCount: g.children.length,
      // Surface embed provenance so describe_video marks morpha bands explicitly
      // (a plain group omits these). source_morpha_id stays for the agent to
      // reference; ids are never shown to end users, but this is agent-facing.
      ...(isMorphaGroup(g)
        ? {
            morpha: true as const,
            source_morpha_id: g.source_morpha_id,
            source_version_label: g.source_version_label,
            source_morpha_name: g.source_morpha_name,
          }
        : {}),
      ...animField,
      children,
    };
  }
  if (type === "image") {
    const l = project.image_layers.find((x) => x.id === id);
    if (!l) return null;
    return {
      elementId,
      type,
      name: l.name ?? null,
      filename: l.filename,
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      rotation: l.rotation,
      ...animField,
    };
  }
  if (type === "video") {
    const v = project.video_layers.find((x) => x.id === id);
    if (!v) return null;
    return {
      elementId,
      type,
      name: v.name ?? null,
      clip: v.clip,
      x: v.x,
      y: v.y,
      width: v.width,
      height: v.height,
      rotation: v.rotation,
      source_in_frame: v.source_in_frame,
      source_out_frame: v.source_out_frame,
      timeline_start_frame: v.timeline_start_frame,
      // Reported only when retimed, so the common 1x clip stays terse — but it
      // MUST be reported when set: the clip's length on the timeline is derived
      // from it, so an agent reasoning about duration from the trim alone would
      // be wrong by a factor of `speed`. describe-before-mutate needs it.
      ...(layerSpeed(v) !== 1 ? { speed: layerSpeed(v) } : {}),
      ...(v.lane_id !== undefined ? { lane_id: v.lane_id } : {}),
      ...animField,
    };
  }
  if (type === "text") {
    const t = project.text_layers.find((x) => x.id === id);
    if (!t) return null;
    const text = t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text;
    return {
      elementId,
      type,
      name: t.name ?? null,
      text,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      rotation: t.rotation,
      ...animField,
    };
  }
  const s = project.shapes.find((x) => x.id === id);
  if (!s) return null;
  return {
    elementId,
    type,
    name: s.name ?? null,
    kind: s.kind,
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    rotation: s.rotation,
    ...animField,
  };
};

// describe_video — a cheap STRUCTURAL OVERVIEW (the project's table of
// contents), not a full dump. Returns canvas meta + the backdrop summary + a
// z-ordered tree of every layer with its geometry and which properties are
// animated. It deliberately OMITS keyframe arrays and styles — those are the
// unbounded part. To get full per-element detail (keyframes, styles, every
// field) before mutating a specific layer, call inspect_layers([elementId]).
const describeVideo: ToolDispatch<Record<string, never>> = (project) => {
  const bg = findBackgroundLayer(project);
  const bgElementId = bg ? `image.${bg.id}` : null;
  // resolveLayerTree returns roots back-to-front (render order); the canvas
  // backdrop is pinned at the bottom — drop it from the tree (reported in
  // `background`) and reverse so the tree reads top-of-z first.
  const tree = resolveLayerTree(project)
    .filter((n) => n.id !== bgElementId)
    .map((n) => overviewNode(project, n))
    .filter((n): n is OverviewNode => n !== null)
    .reverse();

  const layerCount =
    project.image_layers.length -
    (bg ? 1 : 0) +
    project.video_layers.length +
    project.text_layers.length +
    project.shapes.length +
    project.groups.length;

  // Lane (track) grouping — buckets video layers that share a lane_id, i.e. the
  // pieces of one take laid end-to-end (razor-split halves, cut_range fragments).
  // Every clip also carries its lane_id inline on its tree node; this summary
  // surfaces ONLY the lanes that actually group 2+ clips (the interesting ones),
  // so single-clip projects don't get a redundant 1:1 mapping. Within a lane the
  // clips are ordered by timeline_start_frame; lanes are ordered by their
  // earliest clip. A lane is a TIME track, not a z-order group — the tree stays
  // unchanged. The grouping itself lives in resolveMultiClipLanes (src/schemas)
  // so the Timeline/Inspector consume the exact same lanes; here we just map
  // each lane's clips to their element ids.
  const lanes = resolveMultiClipLanes(project).map((lane) => ({
    lane_id: lane.lane_id,
    clips: lane.clips.map((c) => `video.${c.id}`),
  }));

  const data = {
    project_id: project.project_id,
    name: project.name ?? null,
    canvas_width: project.canvas_width,
    canvas_height: project.canvas_height,
    duration_seconds: project.duration_seconds,
    // Whether `duration_seconds` is an AUTHORED (pinned) length vs auto-fit to
    // content. `content_duration_seconds` is the length auto-fit WOULD pick
    // right now (the furthest keyframe / video window / audio end, 1s floor) —
    // so the agent can see when an authored length differs from its content and
    // decide between set_duration / fit_duration_to_content / cut_range.
    duration_authored: project.duration_authored,
    content_duration_seconds: computeContentDurationSeconds(project, {
      floorSeconds: 1,
    }),
    // Agent-facing summary of the canvas backdrop.
    background: bg
      ? { elementId: `image.${bg.id}`, name: bg.name, fill: bg.fill }
      : null,
    // Embed allowlist — hostnames permitted to load this project through the
    // public <morpha-video> embed. Empty ⇒ embedding is OFF.
    embed_origins: project.embed_origins,
    public_properties: project.public_properties,
    // Loop section — see set_loop. Empty ⇒ the comp plays once.
    loop: project.loop,
    // Audio tracks (music / voiceover / split-out clip audio). Surfaced here so
    // an agent can find a track's `id` to target with update_audio_overlay
    // (replace / regain / refade) or remove_audio_overlay — the id is not
    // otherwise discoverable. `sourceLayerId` (when set) means the track is
    // welded to that video layer's split-out audio. Empty ⇒ no standalone audio.
    audio_overlays: (project.audio_overlays ?? []).map((o) => ({
      id: o.id,
      filename: o.filename,
      startFrame: o.startFrame,
      endFrame: o.endFrame ?? null,
      gain: o.gain,
      muted: o.muted ?? false,
      soloed: o.soloed ?? false,
      sourceLayerId: o.sourceLayerId ?? null,
      // AI clean state: whether a cleaned sibling track exists, and the
      // clean-strength mix (update_audio_overlay's denoiseStrength, absent ⇒
      // full clean). Absent cleaned track ⇒ the knob has no effect.
      hasCleanedTrack: !!o.denoisedFilename,
      denoiseStrength: o.denoiseStrength ?? null,
    })),
    layer_count: layerCount,
    // Video lanes (time tracks) that group 2+ clips of one take laid
    // end-to-end. Each clip also carries `lane_id` on its tree node; this lists
    // only multi-clip lanes so an agent can see, e.g., that two split halves are
    // the same track. Empty ⇒ every video clip is its own lane (the common case).
    lanes,
    // Overview tree, top of z-stack first. Each node lists which properties are
    // animated but NOT the keyframes — call inspect_layers for those.
    tree,
    hint: "Call inspect_layers([elementId, …]) for full detail (keyframes, styles, every property) on the layers you're about to change. Don't guess values from this overview.",
  };
  return { project, result: { ok: true, data } };
};

// ---------------------------------------------------------------------------
// inspect_layers — full per-element drill-in (the "open this layer" half of the
// structural browser). Returns each named element's complete record: all its
// own fields plus its animation tracks, colour tracks, track-loop modes, and
// style. Tiny per call, so the agent pulls detail only for the handful of
// layers it's about to touch instead of dumping the whole project.
// ---------------------------------------------------------------------------

type InspectLayersArgs = { elementIds?: unknown; elementId?: unknown };

const fullLayerRecord = (
  project: Composition,
  elementId: string,
): Record<string, unknown> | null => {
  const type = elementTypeOf(elementId);
  if (!type) return null;
  const id = bareIdOf(elementId, type);
  let layer:
    | ImageLayer
    | VideoLayer
    | TextLayer
    | Shape
    | Group
    | undefined;
  switch (type) {
    case "image":
      layer = project.image_layers.find((x) => x.id === id);
      break;
    case "video":
      layer = project.video_layers.find((x) => x.id === id);
      break;
    case "text":
      layer = project.text_layers.find((x) => x.id === id);
      break;
    case "shapes":
      layer = project.shapes.find((x) => x.id === id);
      break;
    case "group":
      layer = project.groups.find((x) => x.id === id);
      break;
  }
  if (!layer) return null;
  // Speed keyframes are STORED clip-relative (so a clip's length can't change
  // when it moves), but every frame number an agent sees or sends elsewhere is
  // a PROJECT frame — including the ones add/remove_speed_keyframe take. Report
  // them in project frames so the round trip closes; leaking the raw offsets
  // made a caller delete the wrong keyframe with the number it had just read.
  const speedKfs =
    type === "video" && (layer as VideoLayer).speed_keyframes
      ? (layer as VideoLayer).speed_keyframes!.map((kf) => ({
          ...kf,
          frame: kf.frame + Math.max(0, (layer as VideoLayer).timeline_start_frame),
        }))
      : undefined;
  // An element inside a group stores x/y in its GROUP's space, not the canvas's
  // — so the raw numbers above are not where it appears. Reads and writes are
  // both in that stored space (move_layer writes what inspect_layers reports,
  // and changing that would break every read-modify-write an agent does), so
  // the canvas position is reported ALONGSIDE rather than replacing it. Only
  // for grouped elements: for a root-level layer the two are identical and the
  // extra keys would be noise.
  const anc = composeAncestors(project, elementId, 0);
  const nested = anc.scaleProduct !== 1 || anc.rotationProduct !== 0 ||
    getAncestorGroupChain(project, elementId).length > 0;
  const canvasGeom = nested
    ? (() => {
        const p = anc.apply({
          x: (layer as { x?: number }).x ?? 0,
          y: (layer as { y?: number }).y ?? 0,
        });
        return {
          canvas_x: p.x,
          canvas_y: p.y,
          canvas_scale: anc.scaleProduct,
          canvas_rotation: ((layer as { rotation?: number }).rotation ?? 0) +
            anc.rotationProduct,
        };
      })()
    : {};
  return {
    elementId,
    type,
    ...layer,
    ...(speedKfs ? { speed_keyframes: speedKfs } : {}),
    ...canvasGeom,
    animations: layer.animations ?? null,
    color_tracks: layer.color_tracks ?? null,
    track_loops: layer.track_loops ?? null,
    style: layer.style ?? null,
  };
};

const inspectLayers: ToolDispatch<InspectLayersArgs> = (project, args) => {
  const ids: string[] = Array.isArray(args.elementIds)
    ? (args.elementIds.filter((x) => typeof x === "string") as string[])
    : typeof args.elementId === "string"
      ? [args.elementId]
      : [];
  if (ids.length === 0) {
    return {
      project,
      result: { ok: false, error: "elementIds (a string array) is required" },
    };
  }
  const layers: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const elementId of ids) {
    const rec = fullLayerRecord(project, elementId);
    if (rec) layers.push(rec);
    else notFound.push(elementId);
  }
  if (layers.length === 0) {
    return {
      project,
      result: {
        ok: false,
        error: `no such element(s): ${notFound.join(", ")}. Call describe_video for valid ids.`,
      },
    };
  }
  return {
    project,
    result: {
      ok: true,
      data: { layers, ...(notFound.length > 0 ? { notFound } : {}) },
    },
  };
};

// ---------------------------------------------------------------------------
// move_layer
// ---------------------------------------------------------------------------

type MoveLayerArgs = {
  elementId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  scale?: number;
  opacity?: number;
  clear_animation?: unknown;
};

const moveLayer: ToolDispatch<MoveLayerArgs> = (project, args) => {
  const { elementId, x, y, width, height, rotation, scale, opacity } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (x !== undefined && !Number.isFinite(x)) {
    return { project, result: { ok: false, error: `invalid x: ${x}` } };
  }
  if (y !== undefined && !Number.isFinite(y)) {
    return { project, result: { ok: false, error: `invalid y: ${y}` } };
  }
  if (rotation !== undefined && !Number.isFinite(rotation)) {
    return { project, result: { ok: false, error: `invalid rotation: ${rotation}` } };
  }
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
    return { project, result: { ok: false, error: `invalid width: ${width}` } };
  }
  if (height !== undefined && (!Number.isFinite(height) || height <= 0)) {
    return { project, result: { ok: false, error: `invalid height: ${height}` } };
  }
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
    return { project, result: { ok: false, error: `invalid scale: ${scale}` } };
  }
  if (opacity !== undefined && !Number.isFinite(opacity)) {
    return { project, result: { ok: false, error: `invalid opacity: ${opacity}` } };
  }

  const next = cloneProject(project);

  // `scale` and `opacity` live on every layer record (leaf and group alike), so
  // they are written ONCE here rather than in each per-kind branch below. Same
  // rule as set_layer_fill: a keyframe track beats the static base at every
  // frame, so writing a base under a live track would be invisible — refuse it,
  // and name the two ways forward.
  const baseTarget = findLayerByElementId(next, elementId);
  for (const [prop, value] of [
    ["scale", scale],
    ["opacity", opacity],
  ] as const) {
    if (value === undefined || !baseTarget) continue;
    const keyframes = baseTarget.animations?.[prop]?.length ?? 0;
    if (keyframes > 0 && args.clear_animation !== true) {
      return {
        project,
        result: {
          ok: false,
          error:
            `${elementId}'s ${prop} is ANIMATED (${keyframes} keyframe` +
            `${keyframes === 1 ? "" : "s"}); setting a static ${prop} would be ` +
            `invisible because the animation wins at every frame. Either change ` +
            `it at a frame with add_keyframe, or pass clear_animation: true to ` +
            `replace the animation with this value.`,
        },
      };
    }
    if (keyframes > 0 && baseTarget.animations) delete baseTarget.animations[prop];
    baseTarget[prop] = value;
  }

  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const idx = next.image_layers.findIndex((l: ImageLayer) => l.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `image layer not found: ${id}` } };
    }
    const cur = next.image_layers[idx];
    next.image_layers[idx] = {
      ...cur,
      x: x ?? cur.x,
      y: y ?? cur.y,
      width: width ?? cur.width,
      height: height ?? cur.height,
      rotation: rotation ?? cur.rotation,
    };
    return {
      project: next,
      result: {
        ok: true,
        data: { id: elementId, x: next.image_layers[idx].x, y: next.image_layers[idx].y },
      },
    };
  }

  if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    const idx = next.video_layers.findIndex((v: VideoLayer) => v.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `video layer not found: ${id}` } };
    }
    const cur = next.video_layers[idx];
    next.video_layers[idx] = {
      ...cur,
      x: x ?? cur.x,
      y: y ?? cur.y,
      width: width ?? cur.width,
      height: height ?? cur.height,
      rotation: rotation ?? cur.rotation,
    };
    return {
      project: next,
      result: {
        ok: true,
        data: { id: elementId, x: next.video_layers[idx].x, y: next.video_layers[idx].y },
      },
    };
  }

  if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    const idx = next.shapes.findIndex((s: Shape) => s.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `shape not found: ${id}` } };
    }
    const cur = next.shapes[idx];
    next.shapes[idx] = {
      ...cur,
      x: x ?? cur.x,
      y: y ?? cur.y,
      width: width ?? cur.width,
      height: height ?? cur.height,
      rotation: rotation ?? cur.rotation,
    };
    return {
      project: next,
      result: { ok: true, data: { id: elementId, x: next.shapes[idx].x, y: next.shapes[idx].y } },
    };
  }

  if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    const idx = next.text_layers.findIndex((t: TextLayer) => t.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `text layer not found: ${id}` } };
    }
    const cur = next.text_layers[idx];
    next.text_layers[idx] = {
      ...cur,
      x: x ?? cur.x,
      y: y ?? cur.y,
      width: width ?? cur.width,
      height: height ?? cur.height,
      rotation: rotation ?? cur.rotation,
    };
    return {
      project: next,
      result: {
        ok: true,
        data: { id: elementId, x: next.text_layers[idx].x, y: next.text_layers[idx].y },
      },
    };
  }

  if (elementId.startsWith("group.")) {
    const id = elementId.slice("group.".length);
    const idx = next.groups.findIndex((g: Group) => g.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `group not found: ${id}` } };
    }
    if (width !== undefined || height !== undefined) {
      return {
        project,
        result: { ok: false, error: "groups have no width/height; resize their children individually" },
      };
    }
    if (rotation !== undefined) {
      return {
        project,
        result: {
          ok: false,
          error: "set group rotation via add_keyframe on group.<id> (rotation track)",
        },
      };
    }
    const cur = next.groups[idx];
    next.groups[idx] = {
      ...cur,
      pivotX: x ?? cur.pivotX,
      pivotY: y ?? cur.pivotY,
    };
    return {
      project: next,
      result: {
        ok: true,
        data: {
          id: elementId,
          pivotX: next.groups[idx].pivotX,
          pivotY: next.groups[idx].pivotY,
        },
      },
    };
  }

  return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
};

// ---------------------------------------------------------------------------
// set_pivot
// ---------------------------------------------------------------------------

// Discrete 9-cell anchor → normalized {x,y} pivot in the leaf's bbox. Centre
// matches the un-anchored default; corners and edge midpoints fan out from it.
const ANCHOR_TO_PIVOT: Record<string, { x: number; y: number }> = {
  tl: { x: 0, y: 0 },
  t: { x: 0.5, y: 0 },
  tr: { x: 1, y: 0 },
  l: { x: 0, y: 0.5 },
  c: { x: 0.5, y: 0.5 },
  r: { x: 1, y: 0.5 },
  bl: { x: 0, y: 1 },
  b: { x: 0.5, y: 1 },
  br: { x: 1, y: 1 },
};

type SetPivotArgs = {
  elementId: string;
  anchor: "tl" | "t" | "tr" | "l" | "c" | "r" | "bl" | "b" | "br";
};

const setPivot: ToolDispatch<SetPivotArgs> = (project, args) => {
  const { elementId, anchor } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (elementId.startsWith("group.")) {
    return {
      project,
      result: {
        ok: false,
        error:
          "groups carry an absolute pivot in canvas coords — set it via move_layer with x/y on group.<id>",
      },
    };
  }
  const piv = ANCHOR_TO_PIVOT[anchor];
  if (!piv) {
    return {
      project,
      result: {
        ok: false,
        error: `unknown anchor: ${anchor}; must be one of tl|t|tr|l|c|r|bl|b|br`,
      },
    };
  }
  const next = cloneProject(project);
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const idx = next.image_layers.findIndex((l: ImageLayer) => l.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `image layer not found: ${id}` } };
    }
    next.image_layers[idx] = { ...next.image_layers[idx], pivotX: piv.x, pivotY: piv.y };
  } else if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    const idx = next.video_layers.findIndex((v: VideoLayer) => v.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `video layer not found: ${id}` } };
    }
    next.video_layers[idx] = { ...next.video_layers[idx], pivotX: piv.x, pivotY: piv.y };
  } else if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    const idx = next.shapes.findIndex((s: Shape) => s.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `shape not found: ${id}` } };
    }
    next.shapes[idx] = { ...next.shapes[idx], pivotX: piv.x, pivotY: piv.y };
  } else if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    const idx = next.text_layers.findIndex((t: TextLayer) => t.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `text layer not found: ${id}` } };
    }
    next.text_layers[idx] = { ...next.text_layers[idx], pivotX: piv.x, pivotY: piv.y };
  } else {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  return {
    project: next,
    result: { ok: true, data: { elementId, anchor, pivotX: piv.x, pivotY: piv.y } },
  };
};

// ---------------------------------------------------------------------------
// add_keyframe / remove_keyframe
// ---------------------------------------------------------------------------

type AddKeyframeArgs = {
  elementId: string;
  property: string;
  frame: number;
  value: number;
  easing?: string;
};

const addKeyframe: ToolDispatch<AddKeyframeArgs> = (project, args) => {
  const { elementId, property, frame, value, easing } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (!VALID_PROPS.includes(property as TrackProperty)) {
    return { project, result: { ok: false, error: `invalid property: ${property}` } };
  }
  if (!Number.isFinite(frame) || frame < 0) {
    return { project, result: { ok: false, error: `invalid frame: ${frame}` } };
  }
  if (!Number.isFinite(value)) {
    return { project, result: { ok: false, error: `invalid value: ${value}` } };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  if (easing !== undefined && !VALID_EASINGS.includes(easing as Easing)) {
    return { project, result: { ok: false, error: `invalid easing: ${easing}` } };
  }
  const easingArg = easing as Easing | undefined;
  const next = cloneProject(project);
  upsertKeyframe(
    next,
    elementId,
    property as TrackProperty,
    Math.round(frame),
    value,
    easingArg,
  );
  return {
    project: next,
    result: { ok: true, data: { elementId, property, frame: Math.round(frame), value } },
  };
};

// ---------------------------------------------------------------------------
// set_keyframes_batch — add/replace many keyframes across many layers in ONE
// call. Functionally equivalent to N invocations of add_keyframe but collapses
// the per-call HTTP/MCP round-trip overhead — the difference between 1 call
// and 300 when an agent is keyframing a 100-element starfield. All entries are
// validated up front; if any entry is invalid the whole batch is rejected
// (atomic).
// ---------------------------------------------------------------------------

type SetKeyframesBatchArgs = {
  keyframes?: unknown;
};

const setKeyframesBatch: ToolDispatch<SetKeyframesBatchArgs> = (project, args) => {
  const kfs = args.keyframes;
  if (!Array.isArray(kfs)) {
    return {
      project,
      result: { ok: false, error: "keyframes must be an array of entries" },
    };
  }
  if (kfs.length === 0) {
    return { project, result: { ok: false, error: "keyframes array is empty" } };
  }
  type Op = {
    elementId: string;
    property: TrackProperty;
    frame: number;
    value: number;
    easing?: Easing;
  };
  const ops: Op[] = [];
  for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i] as
      | undefined
      | null
      | {
          elementId?: unknown;
          property?: unknown;
          frame?: unknown;
          value?: unknown;
          easing?: unknown;
        };
    if (!k || typeof k !== "object") {
      return { project, result: { ok: false, error: `entry ${i}: not an object` } };
    }
    const { elementId, property, frame, value, easing } = k;
    if (typeof elementId !== "string" || !elementId) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: elementId is required` },
      };
    }
    if (!isValidColorTarget(project, elementId)) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: unknown elementId: ${elementId}` },
      };
    }
    if (
      typeof property !== "string" ||
      !VALID_PROPS.includes(property as TrackProperty)
    ) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: invalid property: ${property}` },
      };
    }
    if (typeof frame !== "number" || !Number.isFinite(frame) || frame < 0) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: invalid frame: ${frame}` },
      };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: invalid value: ${value}` },
      };
    }
    let easingArg: Easing | undefined;
    if (easing !== undefined && easing !== null) {
      if (
        typeof easing !== "string" ||
        !VALID_EASINGS.includes(easing as Easing)
      ) {
        return {
          project,
          result: { ok: false, error: `entry ${i}: invalid easing: ${easing}` },
        };
      }
      easingArg = easing as Easing;
    }
    ops.push({
      elementId,
      property: property as TrackProperty,
      frame: Math.round(frame),
      value,
      easing: easingArg,
    });
  }
  const next = cloneProject(project);
  for (const op of ops) {
    upsertKeyframe(next, op.elementId, op.property, op.frame, op.value, op.easing);
  }
  return {
    project: next,
    result: { ok: true, data: { count: ops.length } },
  };
};

// ---------------------------------------------------------------------------
// add_keyframes — many keyframes on ONE element's ONE property, with an
// optional loop mode applied in the same call. The idiomatic batch form when
// every dot in a ripple / snowflake / spinner / equaliser-bar gets its own
// track: it factors elementId + property out of the loop body (so the payload
// is just `{frame, value, easing?}` per kf), AND folds set_track_loop into
// the same call so an endless ripple takes one call instead of two.
// ---------------------------------------------------------------------------

type AddKeyframesArgs = {
  elementId?: unknown;
  property?: unknown;
  keyframes?: unknown;
  loop?: unknown;
};

const addKeyframes: ToolDispatch<AddKeyframesArgs> = (project, args) => {
  const { elementId, property, keyframes, loop } = args;
  if (typeof elementId !== "string" || !elementId) {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (
    typeof property !== "string" ||
    !VALID_PROPS.includes(property as TrackProperty)
  ) {
    return { project, result: { ok: false, error: `invalid property: ${property}` } };
  }
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    return {
      project,
      result: { ok: false, error: "keyframes must be a non-empty array" },
    };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  let loopMode: LoopModeArg | undefined;
  if (loop !== undefined && loop !== null) {
    if (typeof loop !== "string" || !VALID_LOOP_MODES.includes(loop as LoopModeArg)) {
      return {
        project,
        result: {
          ok: false,
          error: `invalid loop mode: ${loop} (valid: ${VALID_LOOP_MODES.join(", ")})`,
        },
      };
    }
    loopMode = loop as LoopModeArg;
  }
  // Validate every keyframe before mutating, so the batch is atomic.
  type Kf = { frame: number; value: number; easing?: Easing };
  const ops: Kf[] = [];
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i] as
      | undefined
      | null
      | { frame?: unknown; value?: unknown; easing?: unknown };
    if (!k || typeof k !== "object") {
      return { project, result: { ok: false, error: `entry ${i}: not an object` } };
    }
    const { frame, value, easing } = k;
    if (typeof frame !== "number" || !Number.isFinite(frame) || frame < 0) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: invalid frame: ${frame}` },
      };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return {
        project,
        result: { ok: false, error: `entry ${i}: invalid value: ${value}` },
      };
    }
    let easingArg: Easing | undefined;
    if (easing !== undefined && easing !== null) {
      if (
        typeof easing !== "string" ||
        !VALID_EASINGS.includes(easing as Easing)
      ) {
        return {
          project,
          result: { ok: false, error: `entry ${i}: invalid easing: ${easing}` },
        };
      }
      easingArg = easing as Easing;
    }
    ops.push({ frame: Math.round(frame), value, easing: easingArg });
  }
  const next = cloneProject(project);
  const prop = property as TrackProperty;
  for (const op of ops) {
    upsertKeyframe(next, elementId, prop, op.frame, op.value, op.easing);
  }
  // Optional: fold the loop-mode update into the same call. "hold" is the
  // default — clear any existing override; other modes write to track_loops.
  if (loopMode !== undefined) {
    const layer = findLayerByElementId(next, elementId);
    if (!layer) {
      return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
    }
    if (loopMode === "hold") {
      if (layer.track_loops?.[prop]) {
        const tracks = { ...layer.track_loops };
        delete tracks[prop];
        layer.track_loops =
          Object.keys(tracks).length === 0 ? undefined : tracks;
      }
    } else {
      (layer.track_loops ??= {})[prop] = loopMode;
    }
  }
  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId,
        property: prop,
        count: ops.length,
        loop: loopMode ?? null,
      },
    },
  };
};

type RemoveKeyframeArgs = {
  elementId: string;
  property: string;
  frame: number;
};

// shift_track — bulk-shift every keyframe's VALUE on one property by a delta.
// Mirrors the "select all keyframes + nudge layer" gesture in After Effects /
// Premiere / FCP: shifts the whole animation curve by `delta` while preserving
// every keyframe's relative spacing. For x / y / rotation / scale / opacity /
// width / height. Doesn't touch the keyframe TIMES — only their values.
type ShiftTrackArgs = {
  elementId: string;
  property: string;
  delta: number;
};

const shiftTrack: ToolDispatch<ShiftTrackArgs> = (project, args) => {
  const { elementId, property, delta } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (!VALID_PROPS.includes(property as TrackProperty)) {
    return { project, result: { ok: false, error: `invalid property: ${property}` } };
  }
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return { project, result: { ok: false, error: "delta must be a finite number" } };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  const next = cloneProject(project);
  const layer = findLayerByElementId(next, elementId);
  const tracks = layer?.animations;
  const kfs = tracks?.[property as TrackProperty];
  if (!kfs || kfs.length === 0) {
    return {
      project,
      result: {
        ok: false,
        error: `no keyframes on ${elementId}.${property} to shift`,
      },
    };
  }
  for (const k of kfs) k.value += delta;
  return {
    project: next,
    result: {
      ok: true,
      data: { elementId, property, delta, shifted: kfs.length },
    },
  };
};

const removeKeyframe: ToolDispatch<RemoveKeyframeArgs> = (project, args) => {
  const { elementId, property, frame } = args;
  if (!VALID_PROPS.includes(property as TrackProperty)) {
    return { project, result: { ok: false, error: `invalid property: ${property}` } };
  }
  const next = cloneProject(project);
  const layer = findLayerByElementId(next, elementId);
  const kfs = layer?.animations?.[property as TrackProperty] ?? [];
  const idx = kfs.findIndex((k) => k.frame === Math.round(frame));
  if (idx < 0) {
    return {
      project,
      result: {
        ok: false,
        error: `no keyframe at frame ${frame} on ${elementId}.${property}`,
      },
    };
  }
  kfs.splice(idx, 1);
  return { project: next, result: { ok: true } };
};

// ---------------------------------------------------------------------------
// set_track_loop — extrapolation mode for one property's animation track.
// ---------------------------------------------------------------------------

const VALID_LOOP_MODES = ["hold", "loop", "ping-pong", "cycle"] as const;
type LoopModeArg = (typeof VALID_LOOP_MODES)[number];
type SetTrackLoopArgs = {
  elementId: string;
  property: string;
  mode: string;
};

const setTrackLoop: ToolDispatch<SetTrackLoopArgs> = (project, args) => {
  const { elementId, property, mode } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (!VALID_PROPS.includes(property as TrackProperty)) {
    return {
      project,
      result: { ok: false, error: `invalid property: ${property}` },
    };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  if (!VALID_LOOP_MODES.includes(mode as LoopModeArg)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid mode: ${mode} (valid: ${VALID_LOOP_MODES.join(", ")})`,
      },
    };
  }
  const next = cloneProject(project);
  const layer = findLayerByElementId(next, elementId);
  if (!layer) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  // hold is the default — clear the override so the project stays compact.
  if (mode === "hold") {
    if (layer.track_loops?.[property as TrackProperty]) {
      const tracks = { ...layer.track_loops };
      delete tracks[property as TrackProperty];
      layer.track_loops =
        Object.keys(tracks).length === 0 ? undefined : tracks;
    }
    return {
      project: next,
      result: { ok: true, data: { elementId, property, mode: "hold" } },
    };
  }
  (layer.track_loops ??= {})[property as TrackProperty] = mode as LoopModeArg;
  return {
    project: next,
    result: { ok: true, data: { elementId, property, mode } },
  };
};

// ---------------------------------------------------------------------------
// Optional `block` on a headless add (add_image_layer / add_shape /
// add_text_layer)
// ---------------------------------------------------------------------------
//
// THE RULE, so the two surfaces can't drift by accident:
//
//   • EDITOR adds (drop an image, + shape, + text) always supply a block —
//     `defaultBlockOnAdd(playhead, compFrames)` in editor/src/clip-snap.ts:
//     one shared 5 s clip at the playhead, for every layer kind.
//   • HEADLESS adds (MCP / HTTP / SDK) OMIT it by default and the layer is
//     ALWAYS-PRESENT — an unbounded persistent overlay. That is an EXPLICIT,
//     documented choice, not "whichever function happened to run": an agent
//     has no playhead, and an agent-placed layer is usually a watermark /
//     lower-third that should hold for the whole composition.
//   • A headless caller that wants a clip passes `block: { start, duration }`.
//
// Returns the parsed block (or undefined when omitted), or an error string.
const parseAddBlockArg = (
  block: unknown,
):
  | { block: { start: number; duration: number } | undefined; error?: undefined }
  | { block?: undefined; error: string } => {
  if (block === undefined || block === null) return { block: undefined };
  if (typeof block !== "object" || Array.isArray(block)) {
    return { error: "block must be an object { start, duration }" };
  }
  const { start, duration } = block as { start?: unknown; duration?: unknown };
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) {
    return { error: `invalid block.start: ${String(start)}` };
  }
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 1
  ) {
    return { error: `invalid block.duration (must be ≥ 1): ${String(duration)}` };
  }
  return { block: { start: Math.round(start), duration: Math.round(duration) } };
};

// ---------------------------------------------------------------------------
// add_image_layer
// ---------------------------------------------------------------------------
//
// Headless callers should pre-check that the asset exists at
// users/<userId>/assets/<projectId>/<filename> in R2; this dispatcher does
// NOT verify the file. The editor adapter retains its XHR HEAD pre-check.

type AddImageLayerArgs = {
  filename: string;
  x: number;
  y: number;
  width: number;
  height: number;
  block?: unknown;
};

const addImageLayer: ToolDispatch<AddImageLayerArgs> = (project, args) => {
  const { filename, x, y, width, height } = args;
  if (!filename) {
    return { project, result: { ok: false, error: "filename is required" } };
  }
  if (!Number.isFinite(x)) {
    return { project, result: { ok: false, error: `invalid x: ${x}` } };
  }
  if (!Number.isFinite(y)) {
    return { project, result: { ok: false, error: `invalid y: ${y}` } };
  }
  if (!Number.isFinite(width) || width <= 0) {
    return { project, result: { ok: false, error: `invalid width: ${width}` } };
  }
  if (!Number.isFinite(height) || height <= 0) {
    return { project, result: { ok: false, error: `invalid height: ${height}` } };
  }
  const parsedBlock = parseAddBlockArg(args.block);
  if (parsedBlock.error) {
    return { project, result: { ok: false, error: parsedBlock.error } };
  }
  const next = cloneProject(project);
  const id = generateLayerId(next, "image");
  const layer: ImageLayer = {
    id,
    filename,
    // Base transform identity; see perElementDataFields.
    scale: 1,
    opacity: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    fill: null,
    // Window AND edge transitions together — a bounded overlay is born with a
    // short fade at each edge, an omitted block means always-present (where a
    // transition would be inert). See bornLayerDefaults.
    ...bornLayerDefaults(parsedBlock.block),
  };
  next.image_layers = [...next.image_layers, layer];
  next.layer_order = [...next.layer_order, `image.${id}`];
  return {
    project: next,
    result: { ok: true, data: { id, elementId: `image.${id}` } },
  };
};

// ---------------------------------------------------------------------------
// add_video_layer
// ---------------------------------------------------------------------------
//
// Mirrors add_image_layer. Headless callers should pre-check that the clip
// exists at users/<userId>/clips/<projectId>/<clip> in R2; this dispatcher
// does NOT verify the file. The editor adapter retains its XHR HEAD check.

type AddVideoLayerArgs = {
  clip: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
};

const addVideoLayer: ToolDispatch<AddVideoLayerArgs> = (project, args) => {
  const { clip, x, y, width, height, name } = args;
  if (!clip) {
    return { project, result: { ok: false, error: "clip is required" } };
  }
  if (!Number.isFinite(x)) {
    return { project, result: { ok: false, error: `invalid x: ${x}` } };
  }
  if (!Number.isFinite(y)) {
    return { project, result: { ok: false, error: `invalid y: ${y}` } };
  }
  if (!Number.isFinite(width) || width <= 0) {
    return { project, result: { ok: false, error: `invalid width: ${width}` } };
  }
  if (!Number.isFinite(height) || height <= 0) {
    return { project, result: { ok: false, error: `invalid height: ${height}` } };
  }
  const next = cloneProject(project);
  const id = generateLayerId(next, "video");
  const layer: VideoLayer = {
    id,
    clip,
    scale: 1,
    opacity: 1,
    ...(name && name.length > 0 ? { name } : {}),
    x,
    y,
    width,
    height,
    rotation: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    source_in_frame: 0,
    source_out_frame: null,
    timeline_start_frame: 0,
    // Source speed until the user retimes it (set_clip_speed / the Inspector).
    speed: 1,
    // A freshly-added clip is its own lane (track); a later split/cut shares this
    // lane_id across the resulting pieces so they read as one take.
    lane_id: id,
    fill: null,
  };
  next.video_layers = [...next.video_layers, layer];
  next.layer_order = [...next.layer_order, `video.${id}`];
  return {
    project: next,
    result: { ok: true, data: { id, elementId: `video.${id}` } },
  };
};

// ---------------------------------------------------------------------------
// add_shape
// ---------------------------------------------------------------------------

type AddShapeArgs = {
  kind: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  block?: unknown;
};

const DEFAULT_SHAPE_W = 320;
const DEFAULT_SHAPE_H = 180;

// Every shape in the registry is valid. Derive from SHAPE_IDS so this stays in
// lockstep with src/shapes.ts and the MCP enum (which also derives from it).
const SHAPE_KINDS = new Set<ShapeKind>(SHAPE_IDS);

const addShape: ToolDispatch<AddShapeArgs> = (project, args) => {
  const { kind, x, y, width, height, color } = args;
  if (!SHAPE_KINDS.has(kind as ShapeKind)) {
    return {
      project,
      result: {
        ok: false,
        error: `unsupported shape kind: ${kind} (expected one of ${[...SHAPE_KINDS].join(" | ")})`,
      },
    };
  }
  if (color !== undefined && !HEX.test(color)) {
    return {
      project,
      result: { ok: false, error: `invalid color (expected #rrggbb): ${color}` },
    };
  }
  if (x !== undefined && !Number.isFinite(x)) {
    return { project, result: { ok: false, error: `invalid x: ${x}` } };
  }
  if (y !== undefined && !Number.isFinite(y)) {
    return { project, result: { ok: false, error: `invalid y: ${y}` } };
  }
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
    return { project, result: { ok: false, error: `invalid width: ${width}` } };
  }
  if (height !== undefined && (!Number.isFinite(height) || height <= 0)) {
    return { project, result: { ok: false, error: `invalid height: ${height}` } };
  }
  const parsedBlock = parseAddBlockArg(args.block);
  if (parsedBlock.error) {
    return { project, result: { ok: false, error: parsedBlock.error } };
  }
  const next = cloneProject(project);
  const id = generateLayerId(next, "shapes");
  const w = width ?? DEFAULT_SHAPE_W;
  const h = height ?? DEFAULT_SHAPE_H;
  const shape: Shape = {
    id,
    kind: kind as ShapeKind,
    scale: 1,
    opacity: 1,
    // (x, y) is the CENTRE of the shape's bounding box — default to canvas
    // centre when the caller omits a position.
    x: x ?? next.canvas_width / 2,
    y: y ?? next.canvas_height / 2,
    width: w,
    height: h,
    fill: { type: "solid", color: color ?? "#ffffff", opacity: 1 },
    rotation: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    // Window AND edge transitions together — see bornLayerDefaults.
    ...bornLayerDefaults(parsedBlock.block),
  };
  next.shapes = [...next.shapes, shape];
  next.layer_order = [...next.layer_order, `shapes.${id}`];
  return {
    project: next,
    result: { ok: true, data: { id, elementId: `shapes.${id}` } },
  };
};

// ---------------------------------------------------------------------------
// add_curve — the editable line / arrow primitive: a stroked quadratic bezier
// with an arrowhead. Draw it by endpoints (x1,y1)→(x2,y2) with an optional
// perpendicular `bend` (px; 0 = straight, +/- curves either way). Stored as a
// kind:"curve" shape whose bbox bounds the control points and whose `points`
// are bbox fractions, so it scales / rotates / animates like any other shape.
// ---------------------------------------------------------------------------

type AddCurveArgs = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  bend?: number;
  color?: string;
  stroke_width?: number;
  arrow_head?: "none" | "end" | "both";
};

const addCurve: ToolDispatch<AddCurveArgs> = (project, args) => {
  const { x1, y1, x2, y2 } = args;
  for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return {
        project,
        result: { ok: false, error: `${k} must be a finite number` },
      };
    }
  }
  const color = args.color ?? "#ffffff";
  if (!HEX.test(color)) {
    return {
      project,
      result: { ok: false, error: `invalid color (expected #rrggbb): ${color}` },
    };
  }
  const sw = args.stroke_width && args.stroke_width > 0 ? args.stroke_width : 10;
  const head = args.arrow_head ?? "end";
  const bend = args.bend ?? 0;
  // Control point: the segment midpoint pushed perpendicular by `bend`.
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const cxp = mx + (-dy / len) * bend;
  const cyp = my + (dx / len) * bend;
  // Size the bbox to the curve's TRUE ink (a quadratic bezier only bulges
  // halfway to its control point), not the raw control point — otherwise the
  // box over-reserves the bend side and the arrow floats off into a corner of
  // an oversized selection rect. `fitCurveBox` is the single source of truth
  // for this geometry, shared with the editor's heal path so a created curve
  // and a later-edited/legacy one agree. See src/curve-bbox.ts.
  const fit = fitCurveBox(
    [
      { x: x1, y: y1 },
      { x: cxp, y: cyp },
      { x: x2, y: y2 },
    ],
    sw,
  );
  const next = cloneProject(project);
  const id = generateLayerId(next, "shapes");
  const shape: Shape = {
    id,
    kind: "curve",
    scale: 1,
    opacity: 1,
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    fill: { type: "solid", color, opacity: 1 },
    rotation: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    points: fit.points,
    stroke_width: sw,
    arrow_head: head,
  };
  next.shapes = [...next.shapes, shape];
  next.layer_order = [...next.layer_order, `shapes.${id}`];
  return {
    project: next,
    result: { ok: true, data: { id, elementId: `shapes.${id}` } },
  };
};

// ---------------------------------------------------------------------------
// duplicate_layer — composition primitive. Clone a leaf (image / video / shape
// / text) `count` times, applying a cumulative per-step transform: copy i sits
// at base + i·(dx, dy), rotated base + i·d_rotation, scaled base · d_scale^i.
// One call replaces the dozens the LLM would otherwise make for a circle of
// stars, a row of chevrons, a fractal, a staggered grid, etc. Styles are
// copied so clones match; animations are not (animate the result afterwards,
// e.g. group them + a cycle-loop track for endless marching).
// ---------------------------------------------------------------------------

type DuplicateLayerArgs = {
  elementId: string;
  count?: number;
  dx?: number;
  dy?: number;
  d_rotation?: number;
  d_scale?: number;
};

// d_scale^i overflows to Infinity for ds > 1 across enough copies; clamping the
// resulting dimensions keeps them finite so they never serialize to JSON null
// and brick the project on reload.
const MAX_LAYER_DIMENSION = 100_000;

// Generic clone-with-offset over any leaf list (all share id/x/y/w/h/rotation).
// Mutates `list` and `next.styles` in place; returns the new element ids.
const duplicateInList = <
  T extends {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  },
>(
  list: T[],
  next: Composition,
  baseId: string,
  kind: LayerKind,
  count: number,
  dx: number,
  dy: number,
  dr: number,
  ds: number,
): string[] | null => {
  const src = list.find((l) => l.id === baseId);
  if (!src) return null;
  const prefix = `${kind}.`;
  const newIds: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = generateLayerId(next, kind);
    const scale = Math.pow(ds, i);
    const copy: T = {
      ...structuredClone(src),
      id,
      x: src.x + dx * i,
      y: src.y + dy * i,
      width: Math.min(MAX_LAYER_DIMENSION, Math.max(1, src.width * scale)),
      height: Math.min(MAX_LAYER_DIMENSION, Math.max(1, src.height * scale)),
      rotation: (src.rotation ?? 0) + dr * i,
    };
    // A duplicated VIDEO clip is a fresh take, not a keyframed sibling: per the
    // tool contract ("styles are copied; animations are not") drop its animation
    // + colour tracks and caption anchor, and give it its OWN lane so it lands on
    // a new track instead of folding into the source's lane end-to-end (mirrors
    // add_video_layer seeding lane_id to the new clip's id). Non-video leaves keep
    // copying their per-element data (guarded by flatten-clone-regression.test).
    if (kind === "video") {
      const vc = copy as Record<string, unknown>;
      delete vc.animations;
      delete vc.color_tracks;
      delete vc.caption_source;
      vc.lane_id = id;
    }
    list.push(copy);
    const newElementId = `${prefix}${id}`;
    newIds.push(newElementId);
  }
  return newIds;
};

const duplicateLayer: ToolDispatch<DuplicateLayerArgs> = (project, args) => {
  const { elementId } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  const count = Math.max(1, Math.min(1000, Math.floor(args.count ?? 1)));
  const dx = args.dx ?? 0;
  const dy = args.dy ?? 0;
  const dr = args.d_rotation ?? 0;
  const ds = args.d_scale ?? 1;
  for (const [k, v] of [
    ["dx", dx],
    ["dy", dy],
    ["d_rotation", dr],
    ["d_scale", ds],
  ] as const) {
    if (!Number.isFinite(v)) {
      return { project, result: { ok: false, error: `${k} must be a finite number` } };
    }
  }
  const next = cloneProject(project);

  let ids: string[] | null = null;
  if (elementId.startsWith("shapes.")) {
    ids = duplicateInList(next.shapes, next, elementId.slice(7), "shapes", count, dx, dy, dr, ds);
  } else if (elementId.startsWith("image.")) {
    ids = duplicateInList(next.image_layers, next, elementId.slice(6), "image", count, dx, dy, dr, ds);
  } else if (elementId.startsWith("text.")) {
    ids = duplicateInList(next.text_layers, next, elementId.slice(5), "text", count, dx, dy, dr, ds);
  } else if (elementId.startsWith("video.")) {
    ids = duplicateInList(next.video_layers, next, elementId.slice(6), "video", count, dx, dy, dr, ds);
  } else {
    return {
      project,
      result: {
        ok: false,
        error: "duplicate_layer supports image / video / shape / text leaves (not groups)",
      },
    };
  }
  if (ids === null) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  return { project: next, result: { ok: true, data: { ids, count: ids.length } } };
};

// ---------------------------------------------------------------------------
// remove_layer
// ---------------------------------------------------------------------------

type RemoveLayerArgs = { elementId: string };

const removeLayer: ToolDispatch<RemoveLayerArgs> = (project, args) => {
  const { elementId } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (elementId.startsWith("group.")) {
    return {
      project,
      result: {
        ok: false,
        error: "use ungroup_layers on a group; remove_layer is for video/image/shape leaves",
      },
    };
  }
  const next = cloneProject(project);
  if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    const idx = next.shapes.findIndex((s) => s.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `shape not found: ${id}` } };
    }
    next.shapes.splice(idx, 1);
    purgeElementId(next, elementId);
    return { project: next, result: { ok: true } };
  }
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const idx = next.image_layers.findIndex((l) => l.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `image layer not found: ${id}` } };
    }
    // Pinned layers (e.g. the canvas backdrop) refuse deletion.
    if (next.image_layers[idx].pinned === true) {
      return {
        project,
        result: {
          ok: false,
          error: `cannot delete pinned layer: ${elementId}`,
        },
      };
    }
    next.image_layers.splice(idx, 1);
    purgeElementId(next, elementId);
    return { project: next, result: { ok: true } };
  }
  if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    const idx = next.video_layers.findIndex((v) => v.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `video layer not found: ${id}` } };
    }
    next.video_layers.splice(idx, 1);
    purgeElementId(next, elementId);
    // Clip audio is welded to its clip and has no standalone existence — a
    // deleted clip takes its welded overlay(s) with it, same as the editor's
    // delete path (there is no detach: a left-behind overlay would stay
    // audible in preview/export while pointing at a dead clip). Welded
    // captions go with the clip for the same reason — their windows are
    // DERIVED from the clip's trim, so leaving them behind strands dangling
    // anchors.
    next.audio_overlays = (next.audio_overlays ?? []).filter(
      (ov) => ov.sourceLayerId !== elementId,
    );
    removeWeldedCaptionLines(next, elementId);
    return { project: next, result: { ok: true } };
  }
  if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    const idx = next.text_layers.findIndex((t) => t.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `text layer not found: ${id}` } };
    }
    next.text_layers.splice(idx, 1);
    purgeElementId(next, elementId);
    return { project: next, result: { ok: true } };
  }
  return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
};

// ---------------------------------------------------------------------------
// reorder_layer
// ---------------------------------------------------------------------------

type ReorderLayerArgs = { elementId: string; newIndex: number };

// Reorder within siblings — newIndex is 0-based within the element's parent
// (root list when ungrouped, or the parent group's `children` when nested).
// 0 = bottom of that subtree; last index = top of that subtree.
const reorderLayer: ToolDispatch<ReorderLayerArgs> = (project, args) => {
  const { elementId, newIndex } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (!Number.isFinite(newIndex)) {
    return { project, result: { ok: false, error: `invalid newIndex: ${newIndex}` } };
  }
  // Pinned image_layers refuse reorder — they're forced to the bottom of
  // root z by `resolveLayerTree` regardless of position in layer_order.
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const layer = project.image_layers.find((l) => l.id === id);
    if (layer?.pinned === true) {
      return {
        project,
        result: {
          ok: false,
          error: `cannot reorder pinned layer: ${elementId}`,
        },
      };
    }
  }
  // Root captions groups refuse reorder for the same reason at the other end
  // of the stack: `resolveLayerTree` forces them to the TOP of root z.
  if (collectCaptionsRootIds(project).includes(elementId)) {
    return {
      project,
      result: {
        ok: false,
        error: `captions always render on top; cannot reorder: ${elementId}`,
      },
    };
  }
  const next = cloneProject(project);
  normalizeRoot(next);
  const parentGid = findParentGroup(next, elementId);
  const siblings: string[] =
    parentGid === null
      ? next.layer_order
      : (next.groups.find((g) => g.id === parentGid)?.children ?? []);
  const oldIdx = siblings.indexOf(elementId);
  if (oldIdx < 0) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  const target = Math.max(0, Math.min(siblings.length - 1, Math.round(newIndex)));
  if (target === oldIdx) {
    return {
      project,
      result: { ok: true, data: { newIndex: target, totalSiblings: siblings.length } },
    };
  }
  const [item] = siblings.splice(oldIdx, 1);
  siblings.splice(target, 0, item);
  return {
    project: next,
    result: { ok: true, data: { newIndex: target, totalSiblings: siblings.length } },
  };
};

// ---------------------------------------------------------------------------
// set_style
// ---------------------------------------------------------------------------

type SetStyleArgs = {
  elementId: string;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  borderAlign?: "inner" | "center" | "outer";
  boxShadow?: string | null;
  fit?: "stretch" | "cover" | "contain";
  anchorX?: number;
  anchorY?: number;
  tintColor?: string;
  tintStrength?: number;
  alphaMask?: unknown;
  chroma_key?: unknown;
  blend_mode?: string;
};

const BLEND_MODE_VALUES: ReadonlyArray<string> = [
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
];

const FIT_VALUES: ReadonlyArray<"stretch" | "cover" | "contain"> = [
  "stretch",
  "cover",
  "contain",
];

const BORDER_ALIGN_VALUES: ReadonlyArray<"inner" | "center" | "outer"> = [
  "inner",
  "center",
  "outer",
];

const setStyle: ToolDispatch<SetStyleArgs> = (project, args) => {
  const {
    elementId,
    borderRadius,
    borderWidth,
    borderColor,
    borderAlign,
    boxShadow,
    fit,
    anchorX,
    anchorY,
    tintColor,
    tintStrength,
    alphaMask,
    chroma_key,
    blend_mode,
  } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (elementId.startsWith("group.")) {
    // Groups have no styled body, but they CAN carry a blend_mode that
    // affects how their composite blits onto the parent canvas. Allow that
    // single field through; reject everything else.
    const onlyBlend =
      blend_mode !== undefined &&
      borderRadius === undefined &&
      borderWidth === undefined &&
      borderColor === undefined &&
      borderAlign === undefined &&
      boxShadow === undefined &&
      fit === undefined &&
      anchorX === undefined &&
      anchorY === undefined &&
      tintColor === undefined &&
      tintStrength === undefined &&
      alphaMask === undefined &&
      chroma_key === undefined;
    if (!onlyBlend) {
      return {
        project,
        result: {
          ok: false,
          error:
            "groups have no styles; set_style on group.<id> accepts blend_mode only",
        },
      };
    }
  }
  if (blend_mode !== undefined && !BLEND_MODE_VALUES.includes(blend_mode)) {
    return {
      project,
      result: { ok: false, error: `invalid blend_mode: ${blend_mode}` },
    };
  }
  if (borderColor !== undefined && !HEX.test(borderColor)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid borderColor (expected #rrggbb): ${borderColor}`,
      },
    };
  }
  if (tintColor !== undefined && !HEX.test(tintColor)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid tintColor (expected #rrggbb): ${tintColor}`,
      },
    };
  }
  if (fit !== undefined && !FIT_VALUES.includes(fit)) {
    return {
      project,
      result: { ok: false, error: `invalid fit: ${fit}` },
    };
  }
  if (borderAlign !== undefined && !BORDER_ALIGN_VALUES.includes(borderAlign)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid borderAlign (expected inner|center|outer): ${borderAlign}`,
      },
    };
  }
  for (const [name, v] of [
    ["borderWidth", borderWidth],
    ["borderRadius", borderRadius],
  ] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return {
        project,
        result: { ok: false, error: `${name} must be a non-negative number` },
      };
    }
  }
  for (const [name, v] of [
    ["anchorX", anchorX],
    ["anchorY", anchorY],
    ["tintStrength", tintStrength],
  ] as const) {
    if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1)) {
      return {
        project,
        result: { ok: false, error: `${name} must be a number in [0, 1]` },
      };
    }
  }
  // alphaMask validation. `null` clears the mask; an object sets it; undefined
  // leaves the existing mask untouched. Mirrors maskGradientSchema in shape.
  let validatedAlphaMask:
    | { type: "linear"; angle: number; stops: Array<{ offset: number; alpha: number }> }
    | null
    | undefined = undefined;
  if (alphaMask !== undefined) {
    if (alphaMask === null) {
      validatedAlphaMask = null;
    } else if (typeof alphaMask !== "object") {
      return { project, result: { ok: false, error: "alphaMask must be an object or null" } };
    } else {
      const m = alphaMask as Record<string, unknown>;
      const type = m.type === undefined ? "linear" : m.type;
      if (type !== "linear") {
        return { project, result: { ok: false, error: "alphaMask.type must be 'linear'" } };
      }
      const angle = m.angle === undefined ? 180 : m.angle;
      if (typeof angle !== "number" || !Number.isFinite(angle)) {
        return { project, result: { ok: false, error: "alphaMask.angle must be a finite number" } };
      }
      const stops = m.stops;
      if (!Array.isArray(stops) || stops.length < 2) {
        return {
          project,
          result: { ok: false, error: "alphaMask.stops must be an array of ≥ 2 stops" },
        };
      }
      const validStops: Array<{ offset: number; alpha: number }> = [];
      for (const s of stops) {
        if (typeof s !== "object" || s === null) {
          return { project, result: { ok: false, error: "each stop must be {offset, alpha}" } };
        }
        const so = (s as { offset?: unknown }).offset;
        const sa = (s as { alpha?: unknown }).alpha;
        if (typeof so !== "number" || so < 0 || so > 1) {
          return { project, result: { ok: false, error: "stop.offset must be a number in [0, 1]" } };
        }
        if (typeof sa !== "number" || sa < 0 || sa > 1) {
          return { project, result: { ok: false, error: "stop.alpha must be a number in [0, 1]" } };
        }
        validStops.push({ offset: so, alpha: sa });
      }
      validatedAlphaMask = { type: "linear", angle, stops: validStops };
    }
  }
  // chroma_key validation. `null` clears it; an object sets it (with defaults
  // for any omitted field); undefined leaves the existing key untouched.
  let validatedChroma:
    | { color: string; similarity: number; smoothness: number }
    | null
    | undefined = undefined;
  if (chroma_key !== undefined) {
    if (chroma_key === null) {
      validatedChroma = null;
    } else if (typeof chroma_key !== "object") {
      return {
        project,
        result: { ok: false, error: "chroma_key must be an object or null" },
      };
    } else {
      const k = chroma_key as Record<string, unknown>;
      const color = k.color === undefined ? "#00ff00" : k.color;
      if (typeof color !== "string" || !HEX.test(color)) {
        return {
          project,
          result: { ok: false, error: "chroma_key.color must be #rrggbb" },
        };
      }
      const similarity = k.similarity === undefined ? 0.4 : k.similarity;
      const smoothness = k.smoothness === undefined ? 0.1 : k.smoothness;
      for (const [n, v] of [
        ["similarity", similarity],
        ["smoothness", smoothness],
      ] as const) {
        if (typeof v !== "number" || v < 0 || v > 1) {
          return {
            project,
            result: { ok: false, error: `chroma_key.${n} must be in [0, 1]` },
          };
        }
      }
      validatedChroma = {
        color,
        similarity: similarity as number,
        smoothness: smoothness as number,
      };
    }
  }
  // boxShadow: null / "" / "none" / "null" all CLEAR the shadow; any other
  // string sets it. Models asked to "remove the shadow" reach for these, so
  // accept them all rather than storing a bogus "null" CSS value.
  let boxShadowPatch: string | undefined;
  let clearBoxShadow = false;
  if (boxShadow !== undefined) {
    const trimmed = typeof boxShadow === "string" ? boxShadow.trim() : "";
    const lowered = trimmed.toLowerCase();
    if (
      boxShadow === null ||
      trimmed === "" ||
      lowered === "none" ||
      lowered === "null"
    ) {
      clearBoxShadow = true;
    } else {
      boxShadowPatch = boxShadow as string;
    }
  }
  const next = cloneProject(project);
  const layer = findLayerByElementId(next, elementId);
  if (!layer) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  const existing = layer.style ?? {};
  const merged: LayerStyle = {
    ...existing,
    ...(borderRadius !== undefined ? { borderRadius } : {}),
    ...(borderWidth !== undefined ? { borderWidth } : {}),
    ...(borderColor !== undefined ? { borderColor } : {}),
    ...(borderAlign !== undefined ? { borderAlign } : {}),
    ...(boxShadowPatch !== undefined ? { boxShadow: boxShadowPatch } : {}),
    ...(fit !== undefined ? { fit } : {}),
    ...(anchorX !== undefined ? { anchorX } : {}),
    ...(anchorY !== undefined ? { anchorY } : {}),
    ...(tintColor !== undefined ? { tintColor } : {}),
    ...(tintStrength !== undefined ? { tintStrength } : {}),
    ...(blend_mode !== undefined
      ? { blend_mode: blend_mode as LayerStyle["blend_mode"] }
      : {}),
  };
  if (clearBoxShadow) delete merged.boxShadow;
  if (validatedAlphaMask !== undefined) {
    if (validatedAlphaMask === null) {
      delete merged.alphaMask;
    } else {
      merged.alphaMask = validatedAlphaMask;
    }
  }
  if (validatedChroma !== undefined) {
    if (validatedChroma === null) {
      delete merged.chroma_key;
    } else {
      merged.chroma_key = validatedChroma;
    }
  }
  const clean: LayerStyle = {};
  if (merged.borderRadius != null) clean.borderRadius = merged.borderRadius;
  if (merged.borderWidth != null) clean.borderWidth = merged.borderWidth;
  if (merged.borderColor) clean.borderColor = merged.borderColor;
  // Border alignment. Only kept alongside an actual border and when non-default,
  // so "inner" and legacy projects (no field) stay compact + render identically.
  if (
    merged.borderWidth != null &&
    merged.borderWidth > 0 &&
    merged.borderAlign &&
    merged.borderAlign !== "inner"
  ) {
    clean.borderAlign = merged.borderAlign;
  }
  // Preserve text-box padding (set via set_text_background) — set_style must
  // not nuke it when patching an unrelated style field.
  if (merged.padding != null) clean.padding = merged.padding;
  if (merged.boxShadow) clean.boxShadow = merged.boxShadow;
  if (merged.fit) clean.fit = merged.fit;
  if (merged.anchorX != null) clean.anchorX = merged.anchorX;
  if (merged.anchorY != null) clean.anchorY = merged.anchorY;
  if (merged.tintColor) clean.tintColor = merged.tintColor;
  if (merged.tintStrength != null && merged.tintStrength > 0) {
    clean.tintStrength = merged.tintStrength;
  }
  // Mirror flags — only persisted when true (mirrors editor/src/store.ts).
  if (merged.flipX === true) clean.flipX = true;
  if (merged.flipY === true) clean.flipY = true;
  // CSS-style filter effects. Each field is dropped when it equals the no-op
  // default (blur 0 / brightness 1 / contrast 1 / saturate 1 / hueRotate 0) so
  // the JSON stays compact — and, crucially, an unrelated set_style patch must
  // not silently strip an existing flip / blur / colour-filter off the layer.
  if (merged.blur != null && merged.blur > 0) clean.blur = merged.blur;
  if (merged.brightness != null && merged.brightness !== 1) {
    clean.brightness = merged.brightness;
  }
  if (merged.contrast != null && merged.contrast !== 1) {
    clean.contrast = merged.contrast;
  }
  if (merged.saturation != null && merged.saturation !== 1) {
    clean.saturation = merged.saturation;
  }
  if (merged.hueRotate != null && merged.hueRotate !== 0) {
    clean.hueRotate = merged.hueRotate;
  }
  if (merged.alphaMask) clean.alphaMask = merged.alphaMask;
  if (merged.chroma_key) clean.chroma_key = merged.chroma_key;
  // blend_mode is dropped when it's "normal" (the default) so the JSON
  // stays compact and renderers don't waste a save/restore on no-op blends.
  if (merged.blend_mode && merged.blend_mode !== "normal") {
    clean.blend_mode = merged.blend_mode;
  }
  if (Object.keys(clean).length === 0) {
    layer.style = undefined;
  } else {
    layer.style = clean;
  }
  // SVGs carry no intrinsic pixel size, so fit:"contain"/"cover" (which scale the
  // source to its own intrinsic box) collapse them to nothing — an invisible
  // layer. Warn rather than silently render blank; "stretch" (the default) is
  // the right fit for a vector that should fill its frame.
  const filename = (layer as { filename?: unknown }).filename;
  const svgFitWarning =
    (fit === "contain" || fit === "cover") &&
    typeof filename === "string" &&
    filename.toLowerCase().endsWith(".svg")
      ? `fit:"${fit}" on an SVG ("${filename}") scales it by its (absent) intrinsic ` +
        `size and can render it invisibly — use fit:"stretch" for a vector that ` +
        `should fill its frame.`
      : null;
  return {
    project: next,
    result: svgFitWarning
      ? { ok: true, data: { warning: svgFitWarning } }
      : { ok: true },
  };
};

// ---------------------------------------------------------------------------
// set_layer_fill
// ---------------------------------------------------------------------------

type SetLayerFillArgs = {
  elementId: string;
  fill: unknown;
  clear_animation?: unknown;
};

const setLayerFill: ToolDispatch<SetLayerFillArgs> = (project, args) => {
  const { fill } = args;
  if (!args.elementId || typeof args.elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  // Accept the legacy alias "background.canvas" and rewrite it to the
  // canvas backdrop's actual element id. Agents written against the
  // previous schema keep working.
  const elementId = resolveBackgroundAlias(project, args.elementId);
  const bgLayer = findBackgroundLayer(project);
  const isBackgroundLayer =
    bgLayer !== null && elementId === `image.${bgLayer.id}`;
  // is_background image_layers are the canvas backdrop — fill is required,
  // null is rejected (matches the old "background.canvas" semantics).
  const allowsNull =
    !isBackgroundLayer && (
      elementId.startsWith("image.") ||
      elementId.startsWith("video.") ||
      elementId.startsWith("text.") ||
      elementId.startsWith("group.")
    );
  if (fill === null) {
    if (!allowsNull) {
      return {
        project,
        result: { ok: false, error: "shape and canvas-backdrop fills are required; null is not allowed" },
      };
    }
    const next = cloneProject(project);
    if (elementId.startsWith("image.")) {
      const id = elementId.slice("image.".length);
      const idx = next.image_layers.findIndex((l) => l.id === id);
      if (idx < 0) {
        return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
      }
      next.image_layers[idx] = { ...next.image_layers[idx], fill: null };
    } else if (elementId.startsWith("video.")) {
      const id = elementId.slice("video.".length);
      const idx = next.video_layers.findIndex((v) => v.id === id);
      if (idx < 0) {
        return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
      }
      next.video_layers[idx] = { ...next.video_layers[idx], fill: null };
    } else if (elementId.startsWith("text.")) {
      const id = elementId.slice("text.".length);
      const idx = next.text_layers.findIndex((t) => t.id === id);
      if (idx < 0) {
        return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
      }
      next.text_layers[idx] = { ...next.text_layers[idx], fill: null };
    } else if (elementId.startsWith("group.")) {
      const id = elementId.slice("group.".length);
      const idx = next.groups.findIndex((g) => g.id === id);
      if (idx < 0) {
        return { project, result: { ok: false, error: `unknown group: ${elementId}` } };
      }
      next.groups[idx] = { ...next.groups[idx], fill: null };
    }
    // Clearing the fill clears its ANIMATION too — a surviving colour track
    // keeps painting (evalFill prefers the track over the static field), so a
    // "cleared" backdrop that still shows is not cleared at all.
    const cleared = findLayerByElementId(next, elementId);
    if (cleared) clearFillColorTrack(cleared);
    return { project: next, result: { ok: true } };
  }
  if (fill === undefined) {
    return { project, result: { ok: false, error: "fill is required" } };
  }
  const coerced = coerceFill(fill);
  if (!coerced) {
    return {
      project,
      result: { ok: false, error: `invalid fill (expected ${FILL_SHAPE_HINT})` },
    };
  }
  const next = cloneProject(project);
  // A fill has two homes and the track wins, so this write is invisible on a
  // layer whose fill is animated. Refuse it (or replace the animation when the
  // caller says to) rather than report ok on a change nobody can see.
  // `target` IS the record the per-kind branch below spreads, so clearing the
  // track here survives that spread.
  const target = findLayerByElementId(next, elementId);
  if (target) {
    const guard = guardStaticFillWrite(target, args.clear_animation === true);
    if (!guard.ok) {
      return {
        project,
        result: {
          ok: false,
          error: animatedFillRefusal(elementId, guard.keyframes),
        },
      };
    }
  }
  if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    const idx = next.shapes.findIndex((s) => s.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown shape: ${elementId}` } };
    }
    next.shapes[idx] = { ...next.shapes[idx], fill: coerced };
  } else if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const idx = next.image_layers.findIndex((l) => l.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
    }
    next.image_layers[idx] = { ...next.image_layers[idx], fill: coerced };
  } else if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    const idx = next.video_layers.findIndex((v) => v.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
    }
    next.video_layers[idx] = { ...next.video_layers[idx], fill: coerced };
  } else if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    const idx = next.text_layers.findIndex((t) => t.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
    }
    next.text_layers[idx] = { ...next.text_layers[idx], fill: coerced };
  } else if (elementId.startsWith("group.")) {
    const id = elementId.slice("group.".length);
    const idx = next.groups.findIndex((g) => g.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown group: ${elementId}` } };
    }
    next.groups[idx] = { ...next.groups[idx], fill: coerced };
  } else {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  return { project: next, result: { ok: true } };
};

// ---------------------------------------------------------------------------
// set_text_background
// ---------------------------------------------------------------------------

type SetTextBackgroundArgs = {
  elementId: string;
  fill?: unknown;
  padding?: number;
  cornerRadius?: number;
  strokeWidth?: number;
  strokeColor?: string;
  clear_animation?: unknown;
};

// Declarative "rounded box behind text": sets the text layer's backdrop fill
// plus the box's padding / corner radius / stroke in ONE call. Pair with
// text_autofit "hug" so the box shrink-wraps the text. Text layers only.
const setTextBackground: ToolDispatch<SetTextBackgroundArgs> = (
  project,
  args,
) => {
  const { elementId, fill, padding, cornerRadius, strokeWidth, strokeColor } =
    args;
  if (
    !elementId ||
    typeof elementId !== "string" ||
    !elementId.startsWith("text.")
  ) {
    return {
      project,
      result: { ok: false, error: "elementId must be a text.<id>" },
    };
  }
  for (const [v, name] of [
    [padding, "padding"],
    [cornerRadius, "cornerRadius"],
    [strokeWidth, "strokeWidth"],
  ] as const) {
    if (
      v !== undefined &&
      (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    ) {
      return {
        project,
        result: { ok: false, error: `${name} must be a number >= 0` },
      };
    }
  }
  if (strokeColor !== undefined && !HEX.test(strokeColor)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid strokeColor (expected #rrggbb): ${strokeColor}`,
      },
    };
  }
  let coercedFill: Fill | null | undefined = undefined;
  if (fill !== undefined) {
    if (fill === null) {
      coercedFill = null;
    } else {
      const c = coerceFill(fill);
      if (!c) {
        return {
          project,
          result: {
            ok: false,
            error: `invalid fill (expected ${FILL_SHAPE_HINT})`,
          },
        };
      }
      coercedFill = c;
    }
  }
  const next = cloneProject(project);
  const id = elementId.slice("text.".length);
  const idx = next.text_layers.findIndex((t) => t.id === id);
  if (idx < 0) {
    return {
      project,
      result: { ok: false, error: `unknown text layer: ${elementId}` },
    };
  }
  const layer = next.text_layers[idx];
  if (coercedFill !== undefined) {
    // Same rule as set_layer_fill: the backdrop's colour track wins, so a
    // static write over one would be invisible.
    const guard = guardStaticFillWrite(layer, args.clear_animation === true);
    if (!guard.ok) {
      return {
        project,
        result: {
          ok: false,
          error: animatedFillRefusal(elementId, guard.keyframes),
        },
      };
    }
    layer.fill = coercedFill;
  }
  // Merge the box style onto any existing style; zeros / empties drop out so
  // "no padding / border" stays unrepresentable rather than stored as 0.
  const merged: LayerStyle = { ...(layer.style ?? {}) };
  if (padding !== undefined) merged.padding = padding;
  if (cornerRadius !== undefined) merged.borderRadius = cornerRadius;
  if (strokeWidth !== undefined) merged.borderWidth = strokeWidth;
  if (strokeColor !== undefined) merged.borderColor = strokeColor;
  if (!(merged.padding != null && merged.padding > 0)) delete merged.padding;
  if (!(merged.borderRadius != null && merged.borderRadius > 0)) {
    delete merged.borderRadius;
  }
  if (!(merged.borderWidth != null && merged.borderWidth > 0)) {
    delete merged.borderWidth;
  }
  if (!merged.borderColor) delete merged.borderColor;
  layer.style = Object.keys(merged).length === 0 ? undefined : merged;
  return { project: next, result: { ok: true } };
};

// ---------------------------------------------------------------------------
// set_group_box
// ---------------------------------------------------------------------------

type SetGroupBoxArgs = {
  elementId: string;
  box_width: number;
  box_height: number;
};

const setGroupBox: ToolDispatch<SetGroupBoxArgs> = (project, args) => {
  const { elementId, box_width, box_height } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (!elementId.startsWith("group.")) {
    return {
      project,
      result: { ok: false, error: "set_group_box only applies to group.<id>" },
    };
  }
  for (const [k, v] of Object.entries({ box_width, box_height })) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return {
        project,
        result: { ok: false, error: `${k} must be a non-negative finite number` },
      };
    }
  }
  const id = elementId.slice("group.".length);
  const idx = project.groups.findIndex((g) => g.id === id);
  if (idx < 0) {
    return { project, result: { ok: false, error: `unknown group: ${elementId}` } };
  }
  const next = cloneProject(project);
  next.groups[idx] = {
    ...next.groups[idx],
    box_width,
    box_height,
  };
  return { project: next, result: { ok: true } };
};

// ---------------------------------------------------------------------------
// color keyframe helpers
// ---------------------------------------------------------------------------

const COLOR_PROPS = ["fill"] as const;
type ColorProperty = (typeof COLOR_PROPS)[number];

// Verify an elementId is a valid colour-track target: a known leaf, group,
// or image_layer (including the pinned canvas-backdrop image_layer). The
// caller is responsible for resolving any "background.canvas" alias before
// reaching here (see resolveBackgroundAlias).
const isValidColorTarget = (project: Composition, elementId: string): boolean => {
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    return project.image_layers.some((l) => l.id === id);
  }
  if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    return project.video_layers.some((v) => v.id === id);
  }
  if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    return project.shapes.some((s) => s.id === id);
  }
  if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    return project.text_layers.some((t) => t.id === id);
  }
  if (elementId.startsWith("group.")) {
    const id = elementId.slice("group.".length);
    return project.groups.some((g) => g.id === id);
  }
  return false;
};

// ---------------------------------------------------------------------------
// add_color_keyframe
// ---------------------------------------------------------------------------

type AddColorKeyframeArgs = {
  elementId: string;
  property: string;
  frame: number;
  value: unknown;
  easing?: string;
};

const addColorKeyframe: ToolDispatch<AddColorKeyframeArgs> = (project, args) => {
  const { property, frame, value, easing } = args;
  if (!args.elementId || typeof args.elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  const elementId = resolveBackgroundAlias(project, args.elementId);
  if (!isValidColorTarget(project, elementId)) {
    return {
      project,
      result: { ok: false, error: `unknown elementId: ${elementId}` },
    };
  }
  if (!COLOR_PROPS.includes(property as ColorProperty)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid color property: ${property} (only "fill" is supported)`,
      },
    };
  }
  if (!Number.isFinite(frame) || frame < 0) {
    return { project, result: { ok: false, error: `invalid frame: ${frame}` } };
  }
  if (easing !== undefined && !VALID_EASINGS.includes(easing as Easing)) {
    return { project, result: { ok: false, error: `invalid easing: ${easing}` } };
  }
  const coerced = coerceFill(value);
  if (!coerced) {
    return {
      project,
      result: { ok: false, error: `invalid fill value (expected ${FILL_SHAPE_HINT})` },
    };
  }
  const next = cloneProject(project);
  const layer = findLayerByElementId(next, elementId);
  if (!layer) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  const tracks = (layer.color_tracks ??= {} as ElementColorTracks);
  if (!tracks.fill) tracks.fill = [];
  const kfs = tracks.fill as ColorKeyframe[];
  const targetFrame = Math.round(frame);
  const idx = kfs.findIndex((k) => k.frame === targetFrame);
  const resolvedEasing = (easing as Easing | undefined) ?? "linear";
  if (idx >= 0) {
    kfs[idx] = {
      ...kfs[idx],
      value: coerced,
      easing: resolvedEasing,
    };
  } else {
    kfs.push({ frame: targetFrame, value: coerced, easing: resolvedEasing });
  }
  kfs.sort((a, b) => a.frame - b.frame);
  return {
    project: next,
    result: {
      ok: true,
      data: { elementId, property: "fill", frame: targetFrame },
    },
  };
};

// ---------------------------------------------------------------------------
// remove_color_keyframe
// ---------------------------------------------------------------------------

type RemoveColorKeyframeArgs = {
  elementId: string;
  property: string;
  frame: number;
};

const removeColorKeyframe: ToolDispatch<RemoveColorKeyframeArgs> = (
  project,
  args,
) => {
  const { property, frame } = args;
  if (!args.elementId || typeof args.elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  const elementId = resolveBackgroundAlias(project, args.elementId);
  if (!isValidColorTarget(project, elementId)) {
    return {
      project,
      result: { ok: false, error: `unknown elementId: ${elementId}` },
    };
  }
  if (!COLOR_PROPS.includes(property as ColorProperty)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid color property: ${property} (only "fill" is supported)`,
      },
    };
  }
  if (!Number.isFinite(frame) || frame < 0) {
    return { project, result: { ok: false, error: `invalid frame: ${frame}` } };
  }
  const srcLayer = findLayerByElementId(project, elementId);
  const tracks = srcLayer?.color_tracks;
  const kfs = tracks?.fill;
  const targetFrame = Math.round(frame);
  if (!kfs || kfs.length === 0) {
    return { project, result: { ok: true, data: { removed: false } } };
  }
  const idx = kfs.findIndex((k) => k.frame === targetFrame);
  if (idx < 0) {
    return { project, result: { ok: true, data: { removed: false } } };
  }
  const next = cloneProject(project);
  const layer = findLayerByElementId(next, elementId);
  if (!layer?.color_tracks?.fill) {
    return { project, result: { ok: true, data: { removed: false } } };
  }
  const nextKfs = layer.color_tracks.fill as ColorKeyframe[];
  nextKfs.splice(idx, 1);
  if (nextKfs.length === 0) {
    delete layer.color_tracks.fill;
    if (Object.keys(layer.color_tracks).length === 0) {
      layer.color_tracks = undefined;
    }
  }
  return { project: next, result: { ok: true, data: { removed: true } } };
};

// ---------------------------------------------------------------------------
// fade_layer
// ---------------------------------------------------------------------------

type FadeLayerArgs = {
  elementId: string;
  fromFrame: number;
  toFrame: number;
  fromOpacity: number;
  toOpacity: number;
};

const fadeLayer: ToolDispatch<FadeLayerArgs> = (project, args) => {
  const { elementId, fromFrame, toFrame, fromOpacity, toOpacity } = args;
  if (!elementId) {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  for (const [k, v] of Object.entries({ fromFrame, toFrame, fromOpacity, toOpacity })) {
    if (!Number.isFinite(v as number)) {
      return { project, result: { ok: false, error: `invalid ${k}: ${v}` } };
    }
  }
  if (fromFrame < 0 || toFrame < 0) {
    return { project, result: { ok: false, error: "frames must be non-negative" } };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  const next = cloneProject(project);
  upsertKeyframe(next, elementId, "opacity", Math.round(fromFrame), fromOpacity);
  upsertKeyframe(next, elementId, "opacity", Math.round(toFrame), toOpacity);
  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId,
        fromFrame: Math.round(fromFrame),
        toFrame: Math.round(toFrame),
        fromOpacity,
        toOpacity,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// set_layer_visible
// ---------------------------------------------------------------------------

type SetLayerVisibleArgs = { elementId: string; visible: boolean };

const setLayerVisible: ToolDispatch<SetLayerVisibleArgs> = (project, args) => {
  const { elementId, visible } = args;
  if (!elementId) {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (typeof visible !== "boolean") {
    return {
      project,
      result: { ok: false, error: `visible must be a boolean (got ${typeof visible})` },
    };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  const next = cloneProject(project);
  upsertKeyframe(next, elementId, "opacity", 0, visible ? 1 : 0);
  return {
    project: next,
    result: { ok: true, data: { elementId, visible } },
  };
};

// ---------------------------------------------------------------------------
// apply_preset
// ---------------------------------------------------------------------------

export type AnimationPreset =
  | "fade-in"
  | "fade-out"
  | "pulse"
  | "slide-in-left"
  | "slide-in-right"
  | "slide-up"
  | "shake"
  | "pop";

const VALID_PRESETS: AnimationPreset[] = [
  "fade-in",
  "fade-out",
  "pulse",
  "slide-in-left",
  "slide-in-right",
  "slide-up",
  "shake",
  "pop",
];

type PresetTuple = {
  property: TrackProperty;
  frame: number;
  value: number;
  easing?: Easing;
};

// Tuple table — duplicated from editor/src/store.ts intentionally so the pure
// dispatcher has zero editor dependencies. Keep in sync if you add presets.
const PRESET_TUPLES: Record<AnimationPreset, PresetTuple[]> = {
  "fade-in": [
    { property: "opacity", frame: 0, value: 0 },
    { property: "opacity", frame: 30, value: 1, easing: "outQuart" },
  ],
  "fade-out": [
    { property: "opacity", frame: 0, value: 1 },
    { property: "opacity", frame: 30, value: 0, easing: "easeInOut" },
  ],
  pulse: [
    { property: "scale", frame: 0, value: 1 },
    { property: "scale", frame: 15, value: 1.2, easing: "outBack" },
    { property: "scale", frame: 30, value: 1, easing: "easeInOut" },
  ],
  // Slide / shake values are DELTAS from the layer's base x/y, in CANVAS px —
  // "slide in from 200px to the left" is a statement about the screen. Inside a
  // group, x/y are the GROUP's space, so applyPreset converts the delta through
  // the ancestor chain before adding the base; the keyframes that land on the
  // project are absolute positions in the layer's own frame.
  "slide-in-left": [
    { property: "x", frame: 0, value: -200 },
    { property: "x", frame: 30, value: 0, easing: "outBack" },
  ],
  "slide-in-right": [
    { property: "x", frame: 0, value: 200 },
    { property: "x", frame: 30, value: 0, easing: "outBack" },
  ],
  "slide-up": [
    { property: "y", frame: 0, value: 200 },
    { property: "y", frame: 30, value: 0, easing: "outBack" },
  ],
  shake: [
    { property: "x", frame: 0, value: 0, easing: "linear" },
    { property: "x", frame: 8, value: -15, easing: "linear" },
    { property: "x", frame: 16, value: 15, easing: "linear" },
    { property: "x", frame: 24, value: -15, easing: "linear" },
    { property: "x", frame: 32, value: 0, easing: "linear" },
  ],
  pop: [
    { property: "scale", frame: 0, value: 0 },
    { property: "scale", frame: 10, value: 1.1, easing: "outBack" },
    { property: "scale", frame: 20, value: 1, easing: "easeInOut" },
  ],
};

type ApplyPresetArgs = {
  elementId: string;
  preset: string;
  startFrame?: number;
};

/** Write a preset's tuples onto one element, starting at `sf`.
 *
 *  Shared by `apply_preset` and `apply_preset_stagger`, which carried
 *  byte-identical copies of this loop — and so would have needed the same fix
 *  twice.
 *
 *  A slide/shake offset is CANVAS-space travel ("come in from 200px to the
 *  left" is a statement about the screen), but x/y are stored in the element's
 *  PARENT space. Inside a group at scale 1.5 the raw offset travelled 300px,
 *  and inside a rotated group a left-slide arrived diagonally. So the positional
 *  tuples are summed per frame into one vector, converted through the ancestor
 *  chain, and written back per axis. A rotated ancestor genuinely turns
 *  single-axis canvas travel into both parent axes, so an x-only preset gains a
 *  y track there; at the top level the conversion is exactly identity, so the
 *  flat case is unchanged and gains nothing. */
const applyPresetTuples = (
  next: Composition,
  elementId: string,
  sf: number,
  tuples: PresetTuple[],
): Array<{ property: TrackProperty; frame: number; value: number }> => {
  const base = baseForElement(next, elementId);
  const writes: Array<{ property: TrackProperty; frame: number; value: number }> = [];

  const offsetsByFrame = new Map<number, { x: number; y: number }>();
  const easingByFrame = new Map<number, Easing>();
  for (const t of tuples) {
    if (t.property !== "x" && t.property !== "y") continue;
    const frame = Math.max(0, Math.round(sf + t.frame));
    const at = offsetsByFrame.get(frame) ?? { x: 0, y: 0 };
    at[t.property] += t.value;
    offsetsByFrame.set(frame, at);
    // First positional tuple at a frame wins the easing. Every shipped preset
    // has exactly one, so this only decides a case that does not exist yet —
    // stated rather than left to be discovered by whoever writes the first
    // diagonal preset.
    if (!easingByFrame.has(frame)) easingByFrame.set(frame, t.easing ?? "easeInOut");
  }
  const parentOffsets = new Map<number, { x: number; y: number }>();
  for (const [frame, off] of offsetsByFrame) {
    const pd = canvasDeltaToParentSpace(
      next,
      elementId,
      frame,
      undefined,
      canvasDelta(off.x, off.y),
    );
    parentOffsets.set(frame, { x: pd.x, y: pd.y });
  }
  const frames = [...parentOffsets.keys()].sort((a, b) => a - b);
  // An axis gets a track only if the travel actually touches it. Every frame of
  // the travel then gets a keyframe on that axis, so a converted cross-axis
  // component animates across the whole move rather than only where the
  // original tuple happened to sit.
  const axisLive = {
    x: frames.some((f) => parentOffsets.get(f)!.x !== 0),
    y: frames.some((f) => parentOffsets.get(f)!.y !== 0),
  };
  for (const frame of frames) {
    const pd = parentOffsets.get(frame)!;
    const easing = easingByFrame.get(frame) ?? "easeInOut";
    for (const axis of ["x", "y"] as const) {
      if (!axisLive[axis]) continue;
      const value = (axis === "x" ? base.x : base.y) + pd[axis];
      upsertKeyframe(next, elementId, axis, frame, value, easing);
      writes.push({ property: axis, frame, value });
    }
  }

  for (const t of tuples) {
    if (t.property === "x" || t.property === "y") continue;
    const frame = Math.max(0, Math.round(sf + t.frame));
    upsertKeyframe(next, elementId, t.property, frame, t.value, t.easing ?? "easeInOut");
    writes.push({ property: t.property, frame, value: t.value });
  }
  return writes;
};

const applyPreset: ToolDispatch<ApplyPresetArgs> = (project, args) => {
  const { elementId, preset, startFrame } = args;
  if (!elementId) {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (!VALID_PRESETS.includes(preset as AnimationPreset)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid preset: ${preset} (valid: ${VALID_PRESETS.join(", ")})`,
      },
    };
  }
  if (!isValidColorTarget(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  const sf = startFrame === undefined ? 0 : Math.round(startFrame);
  const tuples = PRESET_TUPLES[preset as AnimationPreset];
  const next = cloneProject(project);
  const writes = applyPresetTuples(next, elementId, sf, tuples);
  return {
    project: next,
    result: { ok: true, data: { elementId, preset, startFrame: sf, writes } },
  };
};

// ---------------------------------------------------------------------------
// apply_preset_stagger — apply the same preset to a list of layers with a
// per-element startFrame offset. For diagonal pop-in grids, sequential reveal
// lists, ring-pulse sweeps: one call instead of N. The startFrame for entry i
// is `startFrame + i * stagger` (both default to 0 and 1 respectively).
// ---------------------------------------------------------------------------

type ApplyPresetStaggerArgs = {
  elementIds?: unknown;
  preset?: unknown;
  startFrame?: unknown;
  stagger?: unknown;
};

const applyPresetStagger: ToolDispatch<ApplyPresetStaggerArgs> = (project, args) => {
  const ids = args.elementIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return {
      project,
      result: { ok: false, error: "elementIds must be a non-empty array of layer ids" },
    };
  }
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== "string" || !ids[i]) {
      return {
        project,
        result: { ok: false, error: `elementIds[${i}] must be a non-empty string` },
      };
    }
    if (!isValidColorTarget(project, ids[i] as string)) {
      return {
        project,
        result: { ok: false, error: `unknown elementId: ${ids[i]}` },
      };
    }
  }
  const preset = args.preset;
  if (typeof preset !== "string" || !preset) {
    return { project, result: { ok: false, error: "preset is required" } };
  }
  if (!VALID_PRESETS.includes(preset as AnimationPreset)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid preset: ${preset} (valid: ${VALID_PRESETS.join(", ")})`,
      },
    };
  }
  const startFrameRaw = args.startFrame ?? 0;
  const startFrame = Number(startFrameRaw);
  if (!Number.isFinite(startFrame) || startFrame < 0) {
    return {
      project,
      result: { ok: false, error: "startFrame must be a non-negative number" },
    };
  }
  const staggerRaw = args.stagger ?? 1;
  const stagger = Number(staggerRaw);
  if (!Number.isFinite(stagger)) {
    return { project, result: { ok: false, error: "stagger must be a finite number" } };
  }
  const tuples = PRESET_TUPLES[preset as AnimationPreset];
  const next = cloneProject(project);
  for (let i = 0; i < ids.length; i++) {
    const elementId = ids[i] as string;
    const sf = Math.max(0, Math.round(startFrame + i * stagger));
    applyPresetTuples(next, elementId, sf, tuples);
  }
  return {
    project: next,
    result: {
      ok: true,
      data: { count: ids.length, preset, startFrame, stagger },
    },
  };
};

// ---------------------------------------------------------------------------
// group_layers / ungroup_layers / set_group_parent / rename_group
// ---------------------------------------------------------------------------

type GroupLayersArgs = { elementIds: string[]; name?: string };

// Wrap a set of sibling elements in a new group. The new group is created at
// the position of the FIRST listed element within its parent; remaining
// listed elements are removed from the parent and become the group's
// children in their existing render-order. The group's pivot is seeded to
// the centroid of its children's base centres at create time and then frozen.
const groupLayers: ToolDispatch<GroupLayersArgs> = (project, args) => {
  const { elementIds, name } = args;
  if (!Array.isArray(elementIds) || elementIds.length === 0) {
    return { project, result: { ok: false, error: "elementIds must be a non-empty array" } };
  }
  const idSet = new Set(elementIds);
  if (idSet.size !== elementIds.length) {
    return { project, result: { ok: false, error: "elementIds contains duplicates" } };
  }
  const present = new Set<string>();
  for (const v of project.video_layers) present.add(`video.${v.id}`);
  for (const s of project.shapes) present.add(`shapes.${s.id}`);
  for (const l of project.image_layers) present.add(`image.${l.id}`);
  for (const t of project.text_layers) present.add(`text.${t.id}`);
  for (const g of project.groups) present.add(`group.${g.id}`);
  for (const id of elementIds) {
    if (!present.has(id)) {
      return { project, result: { ok: false, error: `unknown elementId: ${id}` } };
    }
  }
  const parents = new Set(elementIds.map((id) => findParentGroup(project, id)));
  if (parents.size !== 1) {
    return {
      project,
      result: { ok: false, error: "elementIds must all share the same parent (root or one group)" },
    };
  }
  const [parentGid] = [...parents];

  const centers: Array<{ x: number; y: number }> = [];
  for (const id of elementIds) {
    const c = childBaseCenter(project, id);
    if (c) centers.push(c);
  }
  const pivotX = centers.length
    ? centers.reduce((a, c) => a + c.x, 0) / centers.length
    : project.canvas_width / 2;
  const pivotY = centers.length
    ? centers.reduce((a, c) => a + c.y, 0) / centers.length
    : project.canvas_height / 2;

  const next = cloneProject(project);
  const newId = generateLayerId(next, "group");
  const groupElementId = `group.${newId}`;

  normalizeRoot(next);

  const siblings: string[] =
    parentGid === null
      ? next.layer_order
      : (next.groups.find((g) => g.id === parentGid)!.children);
  const orderedChildren = siblings.filter((cid) => idSet.has(cid));
  const firstIdx = siblings.findIndex((cid) => idSet.has(cid));

  // Splice children out and insert the group placeholder at firstIdx
  const filtered = siblings.filter((cid) => !idSet.has(cid));
  filtered.splice(firstIdx, 0, groupElementId);
  if (parentGid === null) {
    next.layer_order = filtered;
  } else {
    next.groups.find((g) => g.id === parentGid)!.children = filtered;
  }

  next.groups = [
    ...next.groups,
    {
      id: newId,
      name: name ?? "",
      opacity: 1,
      pivotX,
      pivotY,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      children: orderedChildren,
      fill: null,
      box_width: 0,
      box_height: 0,
    },
  ];

  return {
    project: next,
    result: {
      ok: true,
      data: { id: newId, elementId: groupElementId, pivotX, pivotY, children: orderedChildren },
    },
  };
};

type UngroupLayersArgs = { groupId: string };

// Dissolve a group: its children are spliced into the group's parent at the
// group's old position, the group entry is removed, and the group's animation
// + style records are dropped. Children survive at their last positions; the
// group's keyframes do NOT bake onto the children.
const ungroupLayers: ToolDispatch<UngroupLayersArgs> = (project, args) => {
  const { groupId } = args;
  if (!groupId || typeof groupId !== "string") {
    return { project, result: { ok: false, error: "groupId is required" } };
  }
  const groupIdx = project.groups.findIndex((g) => g.id === groupId);
  if (groupIdx < 0) {
    return { project, result: { ok: false, error: `group not found: ${groupId}` } };
  }
  const groupElementId = `group.${groupId}`;
  const parentGid = findParentGroup(project, groupElementId);

  const next = cloneProject(project);
  normalizeRoot(next);
  const group = next.groups[groupIdx];
  const children = [...group.children];

  if (parentGid === null) {
    const idx = next.layer_order.indexOf(groupElementId);
    if (idx >= 0) {
      next.layer_order.splice(idx, 1, ...children);
    } else {
      next.layer_order.push(...children);
    }
  } else {
    const pg = next.groups.find((g) => g.id === parentGid)!;
    const idx = pg.children.indexOf(groupElementId);
    if (idx >= 0) {
      pg.children.splice(idx, 1, ...children);
    } else {
      pg.children.push(...children);
    }
  }
  next.groups.splice(groupIdx, 1);
  purgeElementId(next, groupElementId);

  return {
    project: next,
    result: { ok: true, data: { groupId, elementId: groupElementId, children } },
  };
};

type SetGroupParentArgs = {
  elementId: string;
  parentGroupId: string | null;
  index?: number;
};

// Move an element from its current parent (root or another group) into the
// children of `parentGroupId` (null = root) at `index` (defaults to end).
// Cycle prevention: a group cannot be placed inside itself or any of its
// descendants. video, shape, image, and group ids are all valid.
const setGroupParent: ToolDispatch<SetGroupParentArgs> = (project, args) => {
  const { elementId, parentGroupId, index } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  const present = new Set<string>();
  for (const v of project.video_layers) present.add(`video.${v.id}`);
  for (const s of project.shapes) present.add(`shapes.${s.id}`);
  for (const l of project.image_layers) present.add(`image.${l.id}`);
  for (const t of project.text_layers) present.add(`text.${t.id}`);
  for (const g of project.groups) present.add(`group.${g.id}`);
  if (!present.has(elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  // Pinned image_layers (e.g. canvas backdrop) refuse parent change — they
  // belong at the bottom of root z and can't be nested into a group.
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const layer = project.image_layers.find((l) => l.id === id);
    if (layer?.pinned === true) {
      return {
        project,
        result: {
          ok: false,
          error: `cannot move pinned layer: ${elementId}`,
        },
      };
    }
  }
  if (parentGroupId !== null && parentGroupId !== undefined) {
    if (!present.has(`group.${parentGroupId}`)) {
      return {
        project,
        result: { ok: false, error: `unknown parentGroupId: ${parentGroupId}` },
      };
    }
    if (elementId.startsWith("group.")) {
      const movedId = elementId.slice("group.".length);
      if (movedId === parentGroupId) {
        return { project, result: { ok: false, error: "a group cannot be its own parent" } };
      }
      const descendants = getGroupDescendants(project, movedId);
      if (descendants.includes(`group.${parentGroupId}`)) {
        return {
          project,
          result: {
            ok: false,
            error: "cycle: cannot place a group inside one of its descendants",
          },
        };
      }
    }
  }

  const next = cloneProject(project);
  normalizeRoot(next);
  const currentParent = findParentGroup(next, elementId);

  if (currentParent === null) {
    next.layer_order = next.layer_order.filter((id) => id !== elementId);
  } else {
    const pg = next.groups.find((g) => g.id === currentParent)!;
    pg.children = pg.children.filter((id) => id !== elementId);
  }

  const target =
    parentGroupId == null
      ? next.layer_order
      : next.groups.find((g) => g.id === parentGroupId)!.children;
  const insertIdx =
    index === undefined
      ? target.length
      : Math.max(0, Math.min(target.length, Math.round(index)));
  target.splice(insertIdx, 0, elementId);

  return {
    project: next,
    result: {
      ok: true,
      data: { elementId, parentGroupId: parentGroupId ?? null, index: insertIdx },
    },
  };
};

type RenameGroupArgs = { groupId: string; name: string };

const renameGroup: ToolDispatch<RenameGroupArgs> = (project, args) => {
  const { groupId, name } = args;
  if (!groupId) return { project, result: { ok: false, error: "groupId is required" } };
  if (typeof name !== "string") {
    return { project, result: { ok: false, error: "name must be a string" } };
  }
  const next = cloneProject(project);
  const idx = next.groups.findIndex((g) => g.id === groupId);
  if (idx < 0) {
    return { project, result: { ok: false, error: `group not found: ${groupId}` } };
  }
  next.groups[idx] = { ...next.groups[idx], name };
  return { project: next, result: { ok: true, data: { groupId, name } } };
};

// ---------------------------------------------------------------------------
// add_to_collection / remove_from_collection
// ---------------------------------------------------------------------------
//
// The Collection is a per-user library of reusable layers. `add_to_collection`
// records an element id (ANY leaf or group) in THIS project's `collection`
// list; that layer then appears in the user's Collection — and, if the project
// is in a workspace, in every teammate's — where anyone can drop a
// self-contained COPY of it into another project (list_collection /
// add_from_collection). Copies are immutable: nothing links back.

type CollectionArgs = { elementId: string };

const addToCollection: ToolDispatch<CollectionArgs> = (project, args) => {
  const { elementId } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  // Any leaf or group can be collected — the item is whatever that element is.
  if (!findLayerByElementId(project, elementId)) {
    return { project, result: { ok: false, error: `unknown elementId: ${elementId}` } };
  }
  const current = project.collection ?? [];
  if (current.includes(elementId)) {
    return { project, result: { ok: true, data: { elementId, inCollection: true } } };
  }
  const next = cloneProject(project);
  next.collection = [...current, elementId];
  return { project: next, result: { ok: true, data: { elementId, inCollection: true } } };
};

const removeFromCollection: ToolDispatch<CollectionArgs> = (project, args) => {
  const { elementId } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  const current = project.collection ?? [];
  if (!current.includes(elementId)) {
    return { project, result: { ok: true, data: { elementId, inCollection: false } } };
  }
  const next = cloneProject(project);
  next.collection = current.filter((id) => id !== elementId);
  return { project: next, result: { ok: true, data: { elementId, inCollection: false } } };
};

// ---------------------------------------------------------------------------
// add_audio_overlay / remove_audio_overlay / update_audio_overlay
// ---------------------------------------------------------------------------
//
// Asset must already exist at users/<userId>/assets/<projectId>/<filename>.
// This dispatcher does NOT verify the file (consistent with add_image_layer);
// the editor adapter and HTTP/MCP routes do their own pre-checks.

type AddAudioOverlayArgs = {
  filename: string;
  startFrame: number;
  gain?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  endFrame?: number;
  sourceLayerId?: string;
};

const reserveAudioOverlayId = (existing: Set<string>): string => {
  let n = existing.size + 1;
  let id = `audio_${n}`;
  while (existing.has(id)) {
    n += 1;
    id = `audio_${n}`;
  }
  return id;
};

const addAudioOverlay: ToolDispatch<AddAudioOverlayArgs> = (project, args) => {
  const {
    filename,
    startFrame,
    gain,
    fadeInFrames,
    fadeOutFrames,
    endFrame,
    sourceLayerId,
  } = args;
  if (!filename || typeof filename !== "string") {
    return { project, result: { ok: false, error: "filename is required" } };
  }
  if (
    sourceLayerId !== undefined &&
    (typeof sourceLayerId !== "string" || sourceLayerId.length === 0)
  ) {
    return {
      project,
      result: { ok: false, error: "sourceLayerId must be a non-empty string" },
    };
  }
  if (!Number.isFinite(startFrame) || startFrame < 0) {
    return {
      project,
      result: { ok: false, error: `invalid startFrame: ${startFrame}` },
    };
  }
  if (gain !== undefined && (!Number.isFinite(gain) || gain < 0 || gain > 2)) {
    return {
      project,
      result: { ok: false, error: `gain must be in [0, 2]: ${gain}` },
    };
  }
  if (
    fadeInFrames !== undefined &&
    (!Number.isFinite(fadeInFrames) || fadeInFrames < 0)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `fadeInFrames must be a non-negative integer: ${fadeInFrames}`,
      },
    };
  }
  if (
    fadeOutFrames !== undefined &&
    (!Number.isFinite(fadeOutFrames) || fadeOutFrames < 0)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `fadeOutFrames must be a non-negative integer: ${fadeOutFrames}`,
      },
    };
  }
  if (endFrame !== undefined) {
    if (!Number.isFinite(endFrame) || endFrame < 0) {
      return {
        project,
        result: { ok: false, error: `invalid endFrame: ${endFrame}` },
      };
    }
    if (Math.round(endFrame) <= Math.round(startFrame)) {
      return {
        project,
        result: {
          ok: false,
          error: "endFrame must be greater than startFrame",
        },
      };
    }
  }
  const next = cloneProject(project);
  const existing = new Set((next.audio_overlays ?? []).map((o) => o.id));
  const id = reserveAudioOverlayId(existing);
  const overlay: AudioOverlay = {
    id,
    filename,
    startFrame: Math.round(startFrame),
    gain: gain ?? 1,
    fadeInFrames:
      fadeInFrames === undefined ? 0 : Math.round(fadeInFrames),
    fadeOutFrames:
      fadeOutFrames === undefined ? 0 : Math.round(fadeOutFrames),
    ...(endFrame !== undefined ? { endFrame: Math.round(endFrame) } : {}),
    ...(sourceLayerId !== undefined ? { sourceLayerId } : {}),
  };
  next.audio_overlays = [...(next.audio_overlays ?? []), overlay];
  return { project: next, result: { ok: true, data: overlay } };
};

type RemoveAudioOverlayArgs = { id: string };

const removeAudioOverlay: ToolDispatch<RemoveAudioOverlayArgs> = (
  project,
  args,
) => {
  const { id } = args;
  if (!id || typeof id !== "string") {
    return { project, result: { ok: false, error: "id is required" } };
  }
  const overlays = project.audio_overlays ?? [];
  const idx = overlays.findIndex((o) => o.id === id);
  if (idx < 0) {
    return {
      project,
      result: { ok: false, error: `audio overlay not found: ${id}` },
    };
  }
  const next = cloneProject(project);
  next.audio_overlays.splice(idx, 1);
  return { project: next, result: { ok: true, data: { id } } };
};

type UpdateAudioOverlayArgs = {
  id: string;
  startFrame?: number;
  gain?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  endFrame?: number | null;
  filename?: string;
  // Weld / detach the overlay from a video layer. A "video.<id>" string welds
  // it (renders as a clip footer, drags with the clip); null clears the link
  // (Detach → standalone track). Undefined leaves it untouched.
  sourceLayerId?: string | null;
  // Clean-strength wet/dry mix (0..1) while the AI-cleaned track is active;
  // null clears the field (full clean). Undefined leaves it untouched.
  denoiseStrength?: number | null;
};

const updateAudioOverlay: ToolDispatch<UpdateAudioOverlayArgs> = (
  project,
  args,
) => {
  const {
    id,
    startFrame,
    gain,
    fadeInFrames,
    fadeOutFrames,
    endFrame,
    filename,
    sourceLayerId,
    denoiseStrength,
  } = args;
  if (!id || typeof id !== "string") {
    return { project, result: { ok: false, error: "id is required" } };
  }
  if (
    sourceLayerId !== undefined &&
    sourceLayerId !== null &&
    (typeof sourceLayerId !== "string" || sourceLayerId.length === 0)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: "sourceLayerId must be a non-empty string or null",
      },
    };
  }
  const overlays = project.audio_overlays ?? [];
  const idx = overlays.findIndex((o) => o.id === id);
  if (idx < 0) {
    return {
      project,
      result: { ok: false, error: `audio overlay not found: ${id}` },
    };
  }
  if (startFrame !== undefined && (!Number.isFinite(startFrame) || startFrame < 0)) {
    return {
      project,
      result: { ok: false, error: `invalid startFrame: ${startFrame}` },
    };
  }
  if (gain !== undefined && (!Number.isFinite(gain) || gain < 0 || gain > 2)) {
    return {
      project,
      result: { ok: false, error: `gain must be in [0, 2]: ${gain}` },
    };
  }
  if (
    fadeInFrames !== undefined &&
    (!Number.isFinite(fadeInFrames) || fadeInFrames < 0)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `fadeInFrames must be a non-negative integer: ${fadeInFrames}`,
      },
    };
  }
  if (
    fadeOutFrames !== undefined &&
    (!Number.isFinite(fadeOutFrames) || fadeOutFrames < 0)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `fadeOutFrames must be a non-negative integer: ${fadeOutFrames}`,
      },
    };
  }
  if (endFrame !== undefined && endFrame !== null) {
    if (!Number.isFinite(endFrame) || endFrame < 0) {
      return {
        project,
        result: { ok: false, error: `invalid endFrame: ${endFrame}` },
      };
    }
  }
  if (filename !== undefined && (typeof filename !== "string" || filename.length === 0)) {
    return {
      project,
      result: { ok: false, error: "filename must be a non-empty string" },
    };
  }
  if (
    denoiseStrength !== undefined &&
    denoiseStrength !== null &&
    (!Number.isFinite(denoiseStrength) ||
      denoiseStrength < 0 ||
      denoiseStrength > 1)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `denoiseStrength must be in [0, 1] or null: ${denoiseStrength}`,
      },
    };
  }
  const next = cloneProject(project);
  const cur = next.audio_overlays[idx];
  const merged: AudioOverlay = {
    ...cur,
    ...(filename !== undefined ? { filename } : {}),
    ...(startFrame !== undefined
      ? { startFrame: Math.round(startFrame) }
      : {}),
    ...(gain !== undefined ? { gain } : {}),
    ...(fadeInFrames !== undefined
      ? { fadeInFrames: Math.round(fadeInFrames) }
      : {}),
    ...(fadeOutFrames !== undefined
      ? { fadeOutFrames: Math.round(fadeOutFrames) }
      : {}),
  };
  if (denoiseStrength === null) {
    delete merged.denoiseStrength;
  } else if (denoiseStrength !== undefined) {
    merged.denoiseStrength = denoiseStrength;
  }
  // Swapping the file (a "replace this track" edit) invalidates any AI-cleaned
  // companion of the OLD file: activeOverlayFilename would otherwise keep
  // playing the stale denoisedFilename and shadow the replacement. Drop the
  // denoise fields so the new file plays as-is until it's (re)denoised.
  if (filename !== undefined && filename !== cur.filename) {
    delete merged.denoisedFilename;
    delete merged.useDenoised;
    delete merged.denoiseStrength;
  }
  if (endFrame === null) {
    delete merged.endFrame;
  } else if (endFrame !== undefined) {
    merged.endFrame = Math.round(endFrame);
  }
  if (sourceLayerId === null) {
    // Detach: while welded, the overlay's playback timing is DERIVED from
    // its source clip (weldedAudioTiming) and the stored startFrame/endFrame
    // may be stale. A standalone track plays purely from its stored fields,
    // so materialize the derived timing into them now — unless no explicit
    // startFrame/endFrame were passed alongside. The stored model can't
    // express a negative file-time origin (head-trimmed clip at the comp
    // start): clamp to 0, accepting that such a detach starts the audio at
    // file time 0 (the un-representable head offset is the cost of leaving
    // the weld).
    const welded = weldedSourceLayer(cur, project.video_layers ?? []);
    if (welded && cur.sourceLayerId) {
      const timing = weldedAudioTiming(
        cur,
        project.video_layers ?? [],
        () => undefined,
      );
      if (timing) {
        if (startFrame === undefined) {
          merged.startFrame = Math.max(0, timing.originFrame);
        }
        if (endFrame === undefined && timing.endFrame !== null) {
          merged.endFrame = timing.endFrame;
        }
      }
    }
    delete merged.sourceLayerId;
  } else if (sourceLayerId !== undefined) {
    merged.sourceLayerId = sourceLayerId;
  }
  if (
    merged.endFrame !== undefined &&
    merged.endFrame <= merged.startFrame
  ) {
    return {
      project,
      result: { ok: false, error: "endFrame must be greater than startFrame" },
    };
  }
  next.audio_overlays[idx] = merged;
  return { project: next, result: { ok: true, data: merged } };
};

// ---------------------------------------------------------------------------
// set_video_layer_trim — patch a video_layer's trim window
// ---------------------------------------------------------------------------

type SetVideoLayerTrimArgs = {
  elementId: string;
  source_in_frame?: number;
  source_out_frame?: number | null;
  timeline_start_frame?: number;
};

const setVideoLayerTrim: ToolDispatch<SetVideoLayerTrimArgs> = (
  project,
  args,
) => {
  const { elementId, source_in_frame, source_out_frame, timeline_start_frame } = args;
  if (!elementId || !elementId.startsWith("video.")) {
    return {
      project,
      result: { ok: false, error: `elementId must be video.<id>: ${elementId}` },
    };
  }
  const id = elementId.slice("video.".length);
  const idx = project.video_layers.findIndex((v) => v.id === id);
  if (idx < 0) {
    return {
      project,
      result: { ok: false, error: `video layer not found: ${elementId}` },
    };
  }
  if (
    source_in_frame !== undefined &&
    (!Number.isFinite(source_in_frame) || source_in_frame < 0)
  ) {
    return {
      project,
      result: { ok: false, error: `invalid source_in_frame: ${source_in_frame}` },
    };
  }
  if (source_out_frame !== undefined && source_out_frame !== null) {
    if (!Number.isFinite(source_out_frame) || source_out_frame < 0) {
      return {
        project,
        result: { ok: false, error: `invalid source_out_frame: ${source_out_frame}` },
      };
    }
  }
  if (
    timeline_start_frame !== undefined &&
    (!Number.isFinite(timeline_start_frame) || timeline_start_frame < 0)
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid timeline_start_frame: ${timeline_start_frame}`,
      },
    };
  }
  const next = cloneProject(project);
  const cur = next.video_layers[idx];
  const merged: VideoLayer = {
    ...cur,
    ...(source_in_frame !== undefined
      ? { source_in_frame: Math.round(source_in_frame) }
      : {}),
    ...(timeline_start_frame !== undefined
      ? { timeline_start_frame: Math.round(timeline_start_frame) }
      : {}),
  };
  if (source_out_frame === null) {
    merged.source_out_frame = null;
  } else if (source_out_frame !== undefined) {
    merged.source_out_frame = Math.round(source_out_frame);
  }
  if (
    merged.source_out_frame !== null &&
    merged.source_out_frame <= merged.source_in_frame
  ) {
    return {
      project,
      result: {
        ok: false,
        error: "source_out_frame must be greater than source_in_frame",
      },
    };
  }
  next.video_layers[idx] = merged;
  return { project: next, result: { ok: true, data: merged } };
};

// ---------------------------------------------------------------------------
// set_layer_block / move_band — timeline placement (blocks)
// ---------------------------------------------------------------------------

type SetLayerBlockArgs = {
  elementId: string;
  start: number;
  duration: number;
};

// Set (or replace) a layer's timeline BLOCK — its [start, start+duration)
// existence window. The layer is drawn only inside the window, and its
// keyframes are sampled RELATIVE to `start`, so moving the block re-anchors its
// animation. Works on any leaf or group (for a group, `start` is also the time
// origin for its subtree when it's an embedded band). Frames are in the layer's
// parent timeline (composition frames at root; band-local inside a band).
// COMP frame → a clip's SOURCE timeline, against its current trim. THE single
// conversion for every caption-window write (set_layer_block's caption branch,
// split_caption_line) — the inverse of deriveCaptionWindow's mapping. Keep it
// in one place: a drifted copy here silently un-welds caption edits.
const clipSourceFrameFromComp = (
  clip: VideoLayer,
  compFrame: number,
): number =>
  sourceFrameAtTimelineOffset(
    clip,
    compFrame - Math.max(0, clip.timeline_start_frame),
  );

const setLayerBlock: ToolDispatch<SetLayerBlockArgs> = (project, args) => {
  const { elementId, start, duration } = args;
  if (!findLayerByElementId(project, elementId)) {
    return {
      project,
      result: { ok: false, error: `layer not found: ${elementId}` },
    };
  }
  if (!Number.isFinite(start) || start < 0) {
    return { project, result: { ok: false, error: `invalid start: ${start}` } };
  }
  if (!Number.isFinite(duration) || duration < 1) {
    return {
      project,
      result: { ok: false, error: `invalid duration (must be ≥ 1): ${duration}` },
    };
  }
  const next = cloneProject(project);
  const target = findLayerByElementId(next, elementId)!;
  const roundedStart = Math.round(start);
  const roundedDuration = Math.round(duration);
  // A welded caption line (carries a caption_source anchor) has no fixed block —
  // its on-timeline window is derived from the clip it follows. Re-anchoring it
  // must be expressed in the clip's SOURCE timeline, or the edit would write a
  // block that blockOf ignores and silently no-op. Convert the requested
  // composition-frame window back to source frames against the clip's trim so
  // the line stays welded (and keeps following later trims). Falls through to a
  // plain block write when the caption's clip is missing (dangling anchor).
  const cs = target.caption_source;
  if (cs) {
    const clipId = cs.clip_element_id.startsWith("video.")
      ? cs.clip_element_id.slice("video.".length)
      : cs.clip_element_id;
    const clip = next.video_layers.find((v) => v.id === clipId);
    if (clip) {
      // BOTH ends convert through the clip's rate. Adding the composition
      // duration to the source start would be a source/timeline unit mix-up —
      // right only at speed 1, and a factor of `speed` wrong otherwise (a 2x
      // clip's caption halved on every commit).
      const sourceStart = Math.max(0, clipSourceFrameFromComp(clip, roundedStart));
      const sourceEnd = Math.max(
        sourceStart,
        clipSourceFrameFromComp(clip, roundedStart + roundedDuration),
      );
      target.caption_source = {
        clip_element_id: cs.clip_element_id,
        source_start_frame: sourceStart,
        source_end_frame: sourceEnd,
      };
      return {
        project: next,
        result: { ok: true, data: { elementId, caption_source: target.caption_source } },
      };
    }
  }
  target.block = { start: roundedStart, duration: roundedDuration };
  return {
    project: next,
    result: { ok: true, data: { elementId, block: target.block } },
  };
};

// ---------------------------------------------------------------------------
// set_layer_transition
// ---------------------------------------------------------------------------

type SetLayerTransitionArgs = {
  elementId: string;
  edge: "in" | "out" | "both";
  kind: TransitionKind;
  frames?: number;
  curve?: Easing;
  direction?: TransitionDirection;
};

// Set how a layer enters / leaves at the edges of its on-timeline window.
//
// Edge-relative by construction: only a LENGTH and a look are stored, so the
// transition rides the edge through every later trim or slide. This is the
// difference from `fade_layer` / `apply_preset`, which write opacity keyframes
// at absolute frames and strand themselves the moment the edge moves — prefer
// this tool whenever the intent is "enters/leaves nicely" rather than "a
// specific opacity at a specific frame".
//
// `kind: "cut"` clears the edge back to a hard cut (the field is removed rather
// than stored as a cut, so a layer with no transitions carries no keys).
const setLayerTransition: ToolDispatch<SetLayerTransitionArgs> = (project, args) => {
  const { elementId, edge, kind, frames, curve, direction } = args;
  if (!findLayerByElementId(project, elementId)) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  if (edge !== "in" && edge !== "out" && edge !== "both") {
    return {
      project,
      result: { ok: false, error: `invalid edge: ${edge} (valid: in, out, both)` },
    };
  }
  const validKinds: TransitionKind[] = ["cut", "fade", "slide", "pop"];
  if (!validKinds.includes(kind)) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid kind: ${kind} (valid: ${validKinds.join(", ")})`,
      },
    };
  }
  const requested = frames ?? DEFAULT_OVERLAY_TRANSITION_FRAMES;
  if (!Number.isFinite(requested) || requested < 0) {
    return { project, result: { ok: false, error: `invalid frames: ${frames}` } };
  }
  const next = cloneProject(project);
  const target = findLayerByElementId(next, elementId)!;
  const value: EdgeTransition | null =
    kind === "cut"
      ? null
      : {
          kind,
          frames: Math.round(requested),
          ...(curve ? { curve } : {}),
          ...(kind === "slide" ? { direction: direction ?? "left" } : {}),
        };
  if (edge === "in" || edge === "both") {
    if (value) target.transition_in = value;
    else delete target.transition_in;
  }
  if (edge === "out" || edge === "both") {
    if (value) target.transition_out = value;
    else delete target.transition_out;
  }
  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId,
        transition_in: target.transition_in ?? null,
        transition_out: target.transition_out ?? null,
      },
    },
  };
};

type MoveBandArgs = {
  bandId: string;
  start: number;
};

// Set an embedded morpha band's TIME ORIGIN (its block.start) — where the band
// sits on the host timeline. The band's descendants play relative to `start`,
// so the embedded reel's intro fires when the band appears instead of at 0:00.
// Keeps the band's existing window length; if the band had no block yet, spans
// from `start` to the composition end.
const moveBand: ToolDispatch<MoveBandArgs> = (project, args) => {
  const { bandId, start } = args;
  const bare = bandId.startsWith("group.")
    ? bandId.slice("group.".length)
    : bandId;
  const band = project.groups.find((g) => g.id === bare);
  if (!band || !isMorphaGroup(band)) {
    return {
      project,
      result: { ok: false, error: `not an embedded morpha band: ${bandId}` },
    };
  }
  if (!Number.isFinite(start) || start < 0) {
    return { project, result: { ok: false, error: `invalid start: ${start}` } };
  }
  const next = cloneProject(project);
  const target = next.groups.find((g) => g.id === bare)!;
  const roundedStart = Math.round(start);
  const duration = target.block
    ? target.block.duration
    : Math.max(1, computeContentDurationFrames(next) - roundedStart);
  target.block = { start: roundedStart, duration };
  return {
    project: next,
    result: {
      ok: true,
      data: { elementId: `group.${bare}`, block: target.block },
    },
  };
};

// ---------------------------------------------------------------------------
// shift_group / set_group_window — a group as a relative CONTAINER
//
// A plain group holds no media, so it has no window of its own: the timeline
// shows it spanning the hull of its contents (`deriveGroupWindow`). These are
// the two things you can then do to it, and they mean different things because
// a container and a clip differ:
//   shift_group      — MOVE it: the whole subtree slides, keeping its shape.
//   set_group_window — TRIM it: the group's own visible window narrows, and the
//                      contents are left exactly where they are.
// A morpha band is excluded from both: its block already IS its subtree's time
// origin, so `set_layer_block` / `move_band` already move it as a unit.
// ---------------------------------------------------------------------------

type ShiftGroupArgs = { elementId: string; start: number };

// Every element inside `elementId` (and the group itself) that CARRIES time,
// plus the earliest frame any of them occupies. Which field carries the time
// follows from how the block model samples:
//   - a VIDEO layer: its `timeline_start_frame`. A clip is the one leaf whose
//     placement doesn't live in `block`, and moving the block instead would
//     leave the footage exactly where it was — the whole reason a group
//     holding a clip used to move everything EXCEPT the clip.
//   - a layer WITH a stored block: its `block.start` (keyframes are
//     block-relative, so they ride along when the block moves).
//   - a layer WITHOUT one: its keyframes, which are absolute.
// A morpha band is a mover but is never recursed into — moving the band's block
// moves its descendants band-locally, so touching them too would double-move
// them. Welded captions are skipped: they anchor to their clip's source timeline
// and are speech-timed, so they must stay on their words.
type FrameTrack = ReadonlyArray<{ frame: number }>;
const numericTracks = (layer: AnyLayer): FrameTrack[] => [
  ...Object.values((layer.animations ?? {}) as Record<string, FrameTrack>),
  ...Object.values((layer.color_tracks ?? {}) as Record<string, FrameTrack>),
];

// A clip carries its time in `timeline_start_frame` — unless it also holds an
// explicit block, which gates it and so owns its window (childTimelineWindow
// reads it the same way, so the hull and the move can't disagree).
const isClipMover = (eid: string, layer: AnyLayer): boolean =>
  eid.startsWith("video.") && !layer.block;

export const groupTimeCarriers = (
  project: Composition,
  elementId: string,
): { movers: string[]; earliest: number } => {
  const movers: string[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  const noteKeyframeFloor = (layer: AnyLayer): void => {
    for (const track of numericTracks(layer)) {
      for (const kf of track) earliest = Math.min(earliest, kf.frame);
    }
  };
  const visit = (eid: string, isRoot: boolean): void => {
    const layer = layerOf(project, eid);
    if (!layer) return;
    if (!isRoot && isCaptionLineElement(project, eid)) return;
    movers.push(eid);
    if (isClipMover(eid, layer)) {
      earliest = Math.min(earliest, (layer as VideoLayer).timeline_start_frame);
    } else if (layer.block) {
      earliest = Math.min(earliest, layer.block.start);
    } else {
      noteKeyframeFloor(layer);
    }
    if (eid.startsWith("group.") && (isRoot || !isMorphaGroup(layer as Group))) {
      for (const child of (layer as Group).children ?? []) visit(child, false);
    }
  };
  visit(elementId, true);
  return { movers, earliest };
};

// Slide a group and everything inside it along the timeline.
//
// `start` is where the group's window should END UP in its parent timeline — not
// a delta — and the shift is resolved against the group's CURRENT window every
// call. That makes it idempotent, so an editor drag can fire it once per
// pointermove with the same target and the second call is a no-op, with no
// per-gesture bookkeeping to get wrong.
//
// The subtree moves as ONE RIGID BODY: the delta is clamped so the earliest
// thing inside lands no earlier than frame 0. The clamp is applied to the DELTA,
// never to individual frames — clamping per-frame would collapse keyframes onto
// 0 and silently destroy the shape of the animation.
const shiftGroup: ToolDispatch<ShiftGroupArgs> = (project, args) => {
  const { elementId, start } = args;
  const root = layerOf(project, elementId);
  if (!root) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  if (!elementId.startsWith("group.")) {
    return {
      project,
      result: { ok: false, error: `not a group: ${elementId}` },
    };
  }
  if (!Number.isFinite(start) || start < 0) {
    return { project, result: { ok: false, error: `invalid start: ${start}` } };
  }
  // A move needs a POSITION, not an extent: `start` is absolute, so the delta
  // is resolved against where the group currently begins. Asking for a whole
  // bounded hull here is what made a group holding an untrimmed clip unmovable —
  // the clip's end isn't measurable headlessly, so the hull was null and the
  // move was refused over a duration it never used.
  const currentStart = root.block?.start ?? deriveGroupStart(project, elementId);
  if (currentStart === null) {
    return {
      project,
      result: {
        ok: false,
        error:
          `${elementId} has no position to move from: it is empty, or something ` +
          `inside it is always-present (spans the whole composition). Give the ` +
          `always-present child a block first, or set one on the group.`,
      },
    };
  }
  const { movers, earliest } = groupTimeCarriers(project, elementId);
  const requested = Math.round(start) - currentStart;
  const delta = Number.isFinite(earliest)
    ? Math.max(requested, -earliest)
    : requested;
  if (delta === 0) {
    return {
      project,
      result: { ok: true, data: { elementId, start: currentStart, delta: 0, moved: 0 } },
    };
  }
  const next = cloneProject(project);
  applyTimeShift(next, movers, delta);
  return {
    project: next,
    result: {
      ok: true,
      data: { elementId, start: currentStart + delta, delta, moved: movers.length },
    },
  };
};

// Slide every mover by `delta`, IN PLACE. Extracted from shift_group so the
// arrival re-time (src/arrival.ts — paste / duplicate / add-from-collection
// landing at the playhead) moves things the same way a group move does, rather
// than growing a second copy of these three branches.
//
// `movers` comes from `groupTimeCarriers`, and the caller owns the clamp: the
// delta is applied as a RIGID BODY, so it must already be reduced so nothing
// lands before frame 0. Clamping per-frame here would collapse keyframes onto 0
// and silently destroy the shape of an animation.
export const applyTimeShift = (
  project: Composition,
  movers: readonly string[],
  delta: number,
): void => {
  if (delta === 0) return;
  for (const eid of movers) {
    const target = layerOf(project, eid);
    if (!target) continue;
    if (isClipMover(eid, target)) {
      const clip = target as VideoLayer;
      // Source in/out are untouched — the clip slides, it is not retrimmed. Its
      // welded audio overlay and caption lines DERIVE their timing from this
      // field (weldedAudioTiming / deriveCaptionWindow), so they follow with no
      // bookkeeping here. Its speed RAMP follows too, for a different reason:
      // `speed_keyframes` are stored clip-relative precisely so a move can't
      // change the clip's derived length.
      //
      // Its `animations` / `color_tracks` keyframes deliberately do NOT follow
      // (see the note below) — a video layer is blockless, so those sample at
      // absolute project frames. That asymmetry is intended: the ramp is the
      // only per-layer curve the clip's LENGTH is derived from, so anchoring it
      // to the clip is a correctness requirement, not a convenience.
      //
      // Its own KEYFRAMES deliberately stay where they are, unlike a blockless
      // shape's. A clip is blockless, so its tracks sample at absolute frames —
      // and dragging the clip's OWN bar (set_video_layer_trim, the everyday
      // gesture) leaves them absolute too. Moving them only here would make
      // "move the group by N" differ from "move the only clip in it by N", and
      // would silently retime animations in projects that never asked for it.
      // The two gestures agree instead; a clip's animation is absolute either
      // way. (It also keeps a keyframe at frame 0 from pinning the whole group
      // against ever moving left.)
      clip.timeline_start_frame = clip.timeline_start_frame + delta;
      continue;
    }
    if (target.block) {
      target.block = { start: target.block.start + delta, duration: target.block.duration };
      continue;
    }
    for (const track of numericTracks(target)) {
      for (const kf of track) (kf as { frame: number }).frame += delta;
    }
  }
};

type SetGroupWindowArgs = {
  elementId: string;
  start: number;
  duration: number;
};

// The last frame the layer's OWN tracks author, block-relative. Used to stop a
// window write from hiding an authored keyframe.
const ownKeyframeExtent = (layer: AnyLayer): number => {
  let last = -1;
  for (const track of numericTracks(layer)) {
    for (const kf of track) last = Math.max(last, kf.frame);
  }
  return last;
};

// Trim a group's own visible window — the counterpart to shift_group's move.
// Writes an explicit block on the group, which from then on overrides its derived
// contents-hull. The CONTENTS ARE NOT TOUCHED: trimming a container clips what
// is shown of it, it does not retime or destroy children.
//
// Two corrections make the write safe, and both exist because a block does two
// coupled things — it gates visibility AND re-bases the layer's own keyframes to
// its start (effectiveFrameOffset):
//   1. Writing a start onto a previously blockless group would jump its own
//      animation forward by the whole start. So its keyframes are compensated by
//      the same amount in the opposite direction and the animation stays put.
//      The compensation is clamped as a WHOLE (the shift is reduced so the
//      earliest keyframe lands at 0) — never per-frame, which would collapse
//      keyframes together and destroy the animation's shape.
//   2. The duration is grown if needed to cover the group's own keyframe extent,
//      so a trim can never silently truncate an authored keyframe (the invariant
//      growBlockToCoverFrame protects at authoring time). Trimming the CONTENTS
//      out of view is still allowed — that's what a visibility window is for.
const setGroupWindow: ToolDispatch<SetGroupWindowArgs> = (project, args) => {
  const { elementId, start, duration } = args;
  const layer = layerOf(project, elementId);
  if (!layer) {
    return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
  }
  if (!elementId.startsWith("group.")) {
    return { project, result: { ok: false, error: `not a group: ${elementId}` } };
  }
  if (!Number.isFinite(start) || start < 0) {
    return { project, result: { ok: false, error: `invalid start: ${start}` } };
  }
  if (!Number.isFinite(duration) || duration < 1) {
    return {
      project,
      result: { ok: false, error: `invalid duration (must be ≥ 1): ${duration}` },
    };
  }
  const nextStart = Math.round(start);
  const prevStart = layer.block?.start ?? 0;
  // Reduce the compensation rather than clipping frames, so relative timing is
  // preserved even when the group's animation starts near 0.
  const earliestOwn = (() => {
    let lo = Number.POSITIVE_INFINITY;
    for (const track of numericTracks(layer)) {
      for (const kf of track) lo = Math.min(lo, kf.frame);
    }
    return lo;
  })();
  const wantShift = nextStart - prevStart;
  const shift = Number.isFinite(earliestOwn)
    ? Math.min(wantShift, earliestOwn)
    : wantShift;

  const next = cloneProject(project);
  const target = layerOf(next, elementId)!;
  if (shift !== 0) {
    for (const track of numericTracks(target)) {
      for (const kf of track) (kf as { frame: number }).frame -= shift;
    }
  }
  const extent = ownKeyframeExtent(target);
  const nextDuration = Math.max(Math.round(duration), extent + 1, 1);
  target.block = { start: nextStart, duration: nextDuration };
  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId,
        block: target.block,
        keyframesCompensatedBy: -shift,
        grownToCoverKeyframes: nextDuration !== Math.round(duration),
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Composition length — set_duration / fit_duration_to_content / cut_range
// ---------------------------------------------------------------------------
//
// `project.duration_seconds` is normally DERIVED: the editor + worker auto-fit
// it to the furthest content (see src/content-duration.ts). `duration_authored`
// pins an explicit length instead. These three pure tools are the headless
// equivalents of the editor affordances — the timeline end-handle drag
// (setAuthoredDurationFrames), "fit to content" (fitDurationToContent), and a
// ripple-delete — so an agent can shorten / fix / cut a comp without the editor.

const DURATION_FPS = 30;
const MAX_DURATION_SECONDS = 600;

// Clamp the loop region into a composition that is `endFrame` frames long.
// `endFrame` is a frame COUNT (>= 1). Mutates the (already-cloned) project in
// place so the clamp lives in exactly one spot across the three tools. Mirrors
// the loop-clamp in store.ts setAuthoredDurationFrames / fitDurationToContent.
const clampLoopRegionToLength = (project: Composition, endFrame: number): void => {
  if (project.loop_start_frame > endFrame - 1) {
    project.loop_start_frame = Math.max(0, endFrame - 1);
  }
  if (project.loop_end_frame !== null && project.loop_end_frame > endFrame) {
    project.loop_end_frame = endFrame;
  }
};

type SetDurationArgs = { seconds?: unknown };

const setDuration: ToolDispatch<SetDurationArgs> = (project, args) => {
  const { seconds } = args;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return {
      project,
      result: {
        ok: false,
        error: `seconds must be a finite number > 0: ${seconds}`,
      },
    };
  }
  const clamped = Math.max(1, Math.min(MAX_DURATION_SECONDS, seconds));
  const next = cloneProject(project);
  next.duration_authored = true;
  next.duration_seconds = clamped;
  const endFrame = Math.max(1, Math.round(clamped * DURATION_FPS));
  clampLoopRegionToLength(next, endFrame);
  return {
    project: next,
    result: {
      ok: true,
      data: { duration_seconds: clamped, duration_authored: true },
    },
  };
};

const fitDurationToContent: ToolDispatch<Record<string, never>> = (project) => {
  const next = cloneProject(project);
  next.duration_authored = false;
  const fitted = Math.max(
    1,
    Math.min(
      MAX_DURATION_SECONDS,
      computeContentDurationSeconds(next, { floorSeconds: 1 }),
    ),
  );
  next.duration_seconds = fitted;
  const endFrame = Math.max(1, Math.round(fitted * DURATION_FPS));
  clampLoopRegionToLength(next, endFrame);
  return {
    project: next,
    result: {
      ok: true,
      data: { duration_seconds: fitted, duration_authored: false },
    },
  };
};

type CutRangeArgs = { startFrame?: unknown; endFrame?: unknown };

const cutRange: ToolDispatch<CutRangeArgs> = (project, args) => {
  const FPS = DURATION_FPS;
  const rawStart = args.startFrame;
  const rawEnd = args.endFrame;
  if (typeof rawStart !== "number" || !Number.isFinite(rawStart)) {
    return { project, result: { ok: false, error: `invalid startFrame: ${rawStart}` } };
  }
  if (typeof rawEnd !== "number" || !Number.isFinite(rawEnd)) {
    return { project, result: { ok: false, error: `invalid endFrame: ${rawEnd}` } };
  }
  const start = Math.round(rawStart);
  let end = Math.round(rawEnd);
  if (start < 0) {
    return { project, result: { ok: false, error: `startFrame must be >= 0: ${start}` } };
  }
  if (end <= start) {
    return {
      project,
      result: {
        ok: false,
        error: `endFrame (${end}) must be greater than startFrame (${start})`,
      },
    };
  }
  const oldDurationSeconds = project.duration_seconds;
  const durFrames = Math.ceil(oldDurationSeconds * FPS);
  end = Math.min(end, durFrames);
  if (end <= start || start >= durFrames) {
    return {
      project,
      result: {
        ok: false,
        error: "cut range is empty or outside the composition",
      },
    };
  }
  const delta = end - start;

  // Ripple-delete map for a project-timeline frame: content before the cut
  // stays, content inside the cut collapses to `start`, content after shifts
  // earlier by `delta`.
  const phi = (f: number): number => (f < start ? f : f < end ? start : f - delta);

  // Timeline window [ws, we) a video layer occupies, resolved through
  // `videoWindow` — the declared one home for the trim math. Re-deriving
  // `out - in` here was a fourth copy of it, and copies of this particular sum
  // do not stay merely redundant: the moment a clip's on-timeline length stops
  // being its raw source span (a playback rate makes a 0.5× clip occupy twice
  // the timeline), a hand-rolled `we` silently under-reports the span and the
  // ripple cuts through footage it thinks it missed. Routing through the
  // resolver means this follows whatever `videoWindow` decides a clip occupies.
  //
  // we = Infinity for a null (natural-end) out-point: the real length needs the
  // decoded source, which is unmeasurable headless. Feeding the out-point back
  // in as the source length is the same ladder `computeContentDurationFrames`
  // uses, and it clamps `in` against `out` — which the old subtraction didn't,
  // so an inverted trim could produce we < ws.
  const videoWs = (l: VideoLayer): number => Math.max(0, l.timeline_start_frame);
  const videoWe = (l: VideoLayer): number =>
    l.source_out_frame === null
      ? Infinity
      : videoWindow(l, l.source_out_frame / DURATION_FPS).endFrame;

  // Refusal check FIRST (before any mutation): a ripple-cut across a
  // speed-ramped video layer would misalign its remapped time, so refuse it.
  for (const layer of project.video_layers) {
    if ((layer.speed_keyframes?.length ?? 0) === 0) continue;
    const ws = videoWs(layer);
    const we = videoWe(layer);
    const ovStart = Math.max(start, ws);
    const ovEnd = Math.min(end, we);
    if (ovStart < ovEnd) {
      return {
        project,
        result: {
          ok: false,
          error: `cannot ripple-cut across a speed-ramped video layer video.${layer.id}; remove its speed keyframes or cut outside its span`,
        },
      };
    }
  }

  const next = cloneProject(project);

  // Point-event keyframes: drop the ones inside the cut, shift the survivors
  // through phi. Generic over numeric Keyframe[] and colour ColorKeyframe[].
  const shiftKeyframes = <T extends { frame: number }>(arr: T[]): T[] =>
    arr
      .filter((kf) => !(kf.frame >= start && kf.frame < end))
      .map((kf) => ({ ...kf, frame: phi(kf.frame) }));
  // The two halves of an interior split partition the SAME track by side of the
  // cut: the left keeps the pre-cut keyframes verbatim (phi is the identity
  // below `start`), the right keeps the post-cut keyframes shifted by -delta.
  const leftKeyframes = <T extends { frame: number }>(arr: T[]): T[] =>
    arr.filter((kf) => kf.frame < start);
  const rightKeyframes = <T extends { frame: number }>(arr: T[]): T[] =>
    arr.filter((kf) => kf.frame >= end).map((kf) => ({ ...kf, frame: kf.frame - delta }));

  // Rebuild a tracks map (animations / color_tracks) through `pick`, dropping
  // any property whose array empties out. Returns a fresh partial record.
  const pickTracks = <K extends string, V extends { frame: number }>(
    tracks: Partial<Record<K, V[]>>,
    pick: (arr: V[]) => V[],
  ): Partial<Record<K, V[]>> => {
    const out: Partial<Record<K, V[]>> = {};
    for (const key of Object.keys(tracks) as K[]) {
      const arr = tracks[key];
      if (!arr) continue;
      const kept = pick(arr);
      if (kept.length > 0) out[key] = kept;
    }
    return out;
  };

  // Apply a keyframe-array transform to a leaf/group's own animations +
  // color_tracks in place, deleting a map that fully empties out.
  const remapLayerTracks = (
    layer: { animations?: ElementTracks; color_tracks?: ElementColorTracks },
    pick: <T extends { frame: number }>(arr: T[]) => T[],
  ): void => {
    if (layer.animations) {
      const anims = pickTracks(layer.animations, pick);
      if (Object.keys(anims).length > 0) layer.animations = anims;
      else delete layer.animations;
    }
    if (layer.color_tracks) {
      const cts = pickTracks(layer.color_tracks, pick);
      if (Object.keys(cts).length > 0) layer.color_tracks = cts;
      else delete layer.color_tracks;
    }
  };

  // A layer with a `block` rides the composition timeline at block.start, and its
  // OWN keyframes are BLOCK-LOCAL — sampled at frame − block.start (see
  // effectiveFrameOffset). So the ripple has to touch both: shift the block
  // window like a timeline_start_frame, AND remap the local keyframes in the same
  // frame space as everything else. Do it by lifting each local keyframe into an
  // absolute composition frame (kf + block.start), running it through the SAME
  // phi (drop inside the cut, shift the survivors), then rebasing onto the
  // block's NEW start. The new window is what survives removing [start, end) from
  // the block's absolute span; a block whose whole span is inside the cut
  // collapses (returns "cull"). Uses block.start as the composition offset — for
  // the rare layer nested under an embedded morpha band the true offset also
  // includes the band origin, but that path is left as-was (no worse than before).
  const remapBlockedLayer = (layer: {
    block?: { start: number; duration: number };
    animations?: ElementTracks;
    color_tracks?: ElementColorTracks;
  }): "kept" | "cull" => {
    const block = layer.block!;
    const bStart = block.start;
    const bEnd = bStart + block.duration;
    const survivingBefore = Math.max(0, Math.min(bEnd, start) - bStart);
    const survivingAfter = Math.max(0, bEnd - Math.max(bStart, end));
    const newDuration = survivingBefore + survivingAfter;
    if (newDuration <= 0) return "cull";
    const newStart = phi(bStart);
    const rebase = <T extends { frame: number }>(arr: T[]): T[] =>
      arr
        .filter((kf) => {
          const abs = kf.frame + bStart;
          return !(abs >= start && abs < end);
        })
        .map((kf) => ({ ...kf, frame: phi(kf.frame + bStart) - newStart }));
    remapLayerTracks(layer, rebase);
    layer.block = { start: newStart, duration: newDuration };
    return "kept";
  };

  // 1. Non-video layers: numeric + colour keyframe tracks. A stored-block layer
  // (not a welded caption line, whose window is DERIVED from its clip and already
  // retimed by the video pass) routes through the block-aware remap; a leaf whose
  // whole block window falls inside the cut is culled. Groups keep at least a
  // minimal window rather than orphan their children.
  const culledBlockIds: string[] = [];
  const remapNonVideoLayer = (
    layer: {
      id: string;
      block?: { start: number; duration: number };
      caption_source?: unknown;
      animations?: ElementTracks;
      color_tracks?: ElementColorTracks;
    },
    elementId: string,
    cullable: boolean,
  ): void => {
    if (layer.block && !layer.caption_source) {
      const blockStart = layer.block.start;
      if (remapBlockedLayer(layer) === "cull") {
        if (cullable) {
          culledBlockIds.push(elementId);
        } else {
          // A group's whole window fell in the cut; keep a 1-frame window at the
          // seam so the subtree stays structurally valid rather than orphaned.
          layer.block = { start: phi(blockStart), duration: 1 };
        }
      }
    } else {
      remapLayerTracks(layer, shiftKeyframes);
    }
  };
  for (const l of next.image_layers) remapNonVideoLayer(l, `image.${l.id}`, true);
  for (const l of next.text_layers) remapNonVideoLayer(l, `text.${l.id}`, true);
  for (const l of next.shapes) remapNonVideoLayer(l, `shapes.${l.id}`, true);
  for (const g of next.groups) remapNonVideoLayer(g, `group.${g.id}`, false);
  if (culledBlockIds.length > 0) {
    const cull = new Set(culledBlockIds);
    next.image_layers = next.image_layers.filter((l) => !cull.has(`image.${l.id}`));
    next.text_layers = next.text_layers.filter((l) => !cull.has(`text.${l.id}`));
    next.shapes = next.shapes.filter((s) => !cull.has(`shapes.${s.id}`));
    for (const eid of culledBlockIds) purgeElementId(next, eid);
  }

  // 2. Markers: drop inside, shift survivors.
  next.markers = next.markers
    .filter((m) => !(m.frame >= start && m.frame < end))
    .map((m) => ({ ...m, frame: phi(m.frame) }));

  // 3. Video layers — source-aware. A layer overlapping the cut is trimmed,
  // fully covered → deleted, or (interior cut) SPLIT into two. Iterate a
  // snapshot; `layer` references live in next.video_layers, so in-place edits
  // land, and split right-halves are appended immediately (so generateLayerId
  // sees them and keeps ids unique across several splits).
  const deletedVideoIds: string[] = [];
  const splitInserts: Array<{ after: string; elementId: string }> = [];
  let splitCount = 0;
  const pruneIfEmptyVideo = (layer: VideoLayer): void => {
    // Only prune a video that is PROVABLY empty (finite window collapsed). A
    // null out-point is a natural-end half whose real length is unknown here —
    // never prune it.
    if (
      layer.source_out_frame !== null &&
      layer.source_in_frame >= layer.source_out_frame
    ) {
      deletedVideoIds.push(`video.${layer.id}`);
    }
  };
  for (const layer of [...next.video_layers]) {
    const ws = videoWs(layer);
    const finiteEnd = layer.source_out_frame !== null;
    const we = videoWe(layer);
    const ovStart = Math.max(start, ws);
    const ovEnd = Math.min(end, we);

    if (end <= ws) {
      // Entirely after the cut → shift earlier.
      layer.timeline_start_frame = ws - delta;
      remapLayerTracks(layer, shiftKeyframes);
      // Speed keyframes are CLIP-RELATIVE, so a clip that merely SLIDES keeps
      // its curve unchanged — that is the whole point of the clip-relative
      // storage, and remapping here would re-introduce the drift it removes.
      continue;
    }
    if (finiteEnd && start >= we) {
      // Entirely before the cut → untouched (its frames are all < start).
      remapLayerTracks(layer, shiftKeyframes);
      continue;
    }
    // Overlap (ovStart < ovEnd). Speed-ramped overlaps were refused above, so
    // nothing below can carry a rate curve — which is why none of these
    // branches remaps `speed_keyframes`. A clip that merely slides keeps its
    // (clip-relative) curve untouched.
    if (ovStart === ws && finiteEnd && ovEnd === we) {
      // Whole window inside the cut → delete the layer.
      deletedVideoIds.push(`video.${layer.id}`);
      continue;
    }
    if (ovStart > ws && finiteEnd && ovEnd === we) {
      // Tail-trim: keep [ws, ovStart).
      // Timeline offset -> SOURCE frame at the clip's rate (1:1 only at speed 1).
      layer.source_out_frame = sourceFrameAtTimelineOffset(layer, ovStart - ws);
      remapLayerTracks(layer, shiftKeyframes);
      pruneIfEmptyVideo(layer);
      continue;
    }
    if (ovStart === ws && ovEnd < we) {
      // Head-trim: drop the front; content from ovEnd now plays at ovEnd-delta.
      layer.source_in_frame = sourceFrameAtTimelineOffset(layer, ovEnd - ws);
      layer.timeline_start_frame = ovEnd - delta;
      remapLayerTracks(layer, shiftKeyframes);
      pruneIfEmptyVideo(layer);
      continue;
    }
    // Interior split: ws < start, end < we. Left keeps [ws, ovStart); right
    // plays [ovEnd, we) at ovEnd-delta. Both halves are pieces of ONE take, so
    // they must share a lane_id: ensure the original carries one (mint from its
    // id if absent), then the right half inherits it via the clone below.
    if (!layer.lane_id) layer.lane_id = layer.id;
    const rightId = generateLayerId(next, "video");
    const right: VideoLayer = {
      ...structuredClone(layer),
      id: rightId,
      source_in_frame: sourceFrameAtTimelineOffset(layer, ovEnd - ws),
      timeline_start_frame: ovEnd - delta,
      // source_out_frame inherited (may be null → keeps the natural end).
      // lane_id inherited from the original clone → both halves = one lane.
    };
    remapLayerTracks(right, rightKeyframes);
    // Left: tail-trim + keep only the pre-cut tracks.
    layer.source_out_frame = sourceFrameAtTimelineOffset(layer, ovStart - ws);
    remapLayerTracks(layer, leftKeyframes);
    // Captions welded to this clip follow the interior split: a line whose
    // source window begins at/after the right half's in-point belongs to the
    // right half (leaving it on the left would cull it — the left's source_out
    // now ends at the cut). Repoint those; earlier / straddling lines stay left.
    for (const tl of next.text_layers) {
      const cs = tl.caption_source;
      if (
        cs &&
        cs.clip_element_id === `video.${layer.id}` &&
        cs.source_start_frame >= right.source_in_frame
      ) {
        tl.caption_source = { ...cs, clip_element_id: `video.${rightId}` };
      }
    }
    next.video_layers.push(right);
    splitInserts.push({ after: `video.${layer.id}`, elementId: `video.${rightId}` });
    splitCount += 1;
    // Both halves are provably non-empty for an interior cut, but guard anyway.
    pruneIfEmptyVideo(right);
    pruneIfEmptyVideo(layer);
  }

  // Place each split's right half adjacent to its left in layer_order and, if
  // the source layer was nested, in the parent group's children.
  for (const ins of splitInserts) {
    const loIdx = next.layer_order.indexOf(ins.after);
    if (loIdx >= 0) next.layer_order.splice(loIdx + 1, 0, ins.elementId);
    else next.layer_order.push(ins.elementId);
    for (const g of next.groups) {
      const cIdx = g.children.indexOf(ins.after);
      if (cIdx >= 0) {
        g.children.splice(cIdx + 1, 0, ins.elementId);
        break;
      }
    }
  }

  // Splice out deleted / pruned video layers and purge their dangling refs.
  for (const eid of deletedVideoIds) {
    const bare = eid.slice("video.".length);
    next.video_layers = next.video_layers.filter((v) => v.id !== bare);
    purgeElementId(next, eid);
  }

  // 4. Audio overlays. Interval events: drop those fully inside the cut, else
  // clamp both ends through phi (interior audio is truncated at the seam — an
  // overlay has no source-in to bridge the removed span). Drop a clamp that
  // leaves an empty interval.
  next.audio_overlays = next.audio_overlays
    .filter(
      (o) =>
        !(start <= o.startFrame && o.endFrame !== undefined && o.endFrame <= end),
    )
    .map((o) => {
      const shifted: AudioOverlay = { ...o, startFrame: phi(o.startFrame) };
      if (o.endFrame !== undefined) shifted.endFrame = phi(o.endFrame);
      return shifted;
    })
    .filter((o) => o.endFrame === undefined || o.endFrame > o.startFrame);

  // 5. Loop region. Shift both edges through phi; if they collapse (equal or
  // inverted, which also covers the loop_end min-1 floor) reset to "whole comp".
  next.loop_start_frame = phi(next.loop_start_frame);
  next.loop_end_frame =
    next.loop_end_frame === null ? null : phi(next.loop_end_frame);
  if (
    next.loop_end_frame !== null &&
    next.loop_end_frame <= next.loop_start_frame
  ) {
    next.loop_start_frame = 0;
    next.loop_end_frame = null;
  }

  // 6. Duration bake. Authored: subtract only the overlap of the cut with the
  // currently-visible region (content past an authored end isn't played, so
  // cutting it must not shrink the stage). Auto-fit: subtract the whole delta
  // (recompute on next editor open refines it against real media lengths).
  const oldDurFrames = Math.round(oldDurationSeconds * FPS);
  if (next.duration_authored) {
    const visibleOverlap = Math.max(
      0,
      Math.min(end, oldDurFrames) - Math.min(start, oldDurFrames),
    );
    next.duration_seconds = Math.max(1, oldDurationSeconds - visibleOverlap / FPS);
  } else {
    next.duration_seconds = Math.max(1, oldDurationSeconds - delta / FPS);
  }
  const newDurationSeconds = next.duration_seconds;

  // 7. Poster timestamp (seconds): shift through phi in frame space, clamp in.
  if (next.start_at !== null) {
    const shifted = phi(Math.round(next.start_at * FPS)) / FPS;
    next.start_at = Math.max(0, Math.min(newDurationSeconds, shifted));
  }

  return {
    project: next,
    result: {
      ok: true,
      data: {
        duration_seconds: next.duration_seconds,
        delta_frames: delta,
        split_layers: splitCount,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// set_embed_origins / add_embed_origin / remove_embed_origin
// ---------------------------------------------------------------------------
//
// `embed_origins` is the per-project allowlist of hostnames permitted to load
// the project through the public <morpha-video> embed. An empty list
// turns embedding OFF — the unauthenticated /api/embed route 404s the project.
// Entries are bare, lowercased hostnames; scheme, port, and path are stripped
// on the way in, so "https://shop.example.com:443/x" and "shop.example.com"
// both normalize to "shop.example.com" (matching the worker's exact-hostname
// Origin check in worker/src/embed.ts). The HTTP + MCP routes mirror the
// resulting list into KV after the write (syncEmbedIndex) so the public embed
// route can resolve the project without auth.

const normalizeOrigin = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // strip scheme
    .replace(/[/?#].*$/, "") // strip path / query / fragment
    .replace(/:\d+$/, ""); // strip port

type SetEmbedOriginsArgs = { origins?: unknown };

const setEmbedOrigins: ToolDispatch<SetEmbedOriginsArgs> = (project, args) => {
  const { origins } = args;
  if (!Array.isArray(origins)) {
    return {
      project,
      result: {
        ok: false,
        error: "origins must be an array of hostname strings",
      },
    };
  }
  const out: string[] = [];
  for (const o of origins) {
    if (typeof o !== "string") {
      return {
        project,
        result: { ok: false, error: "every origin must be a string" },
      };
    }
    const host = normalizeOrigin(o);
    if (host && !out.includes(host)) out.push(host);
  }
  const next = cloneProject(project);
  next.embed_origins = out;
  return { project: next, result: { ok: true, data: { embed_origins: out } } };
};

// ---------------------------------------------------------------------------
// set_custom_font — register a typeface Morpha does not ship
// ---------------------------------------------------------------------------
//
// Adds (or replaces) an entry in project.custom_fonts so text layers can use it
// by `family` via their font_family, exactly like a built-in family. Families
// already in the built-in catalogues (Google/Bunny/Fontshare/Fontsource/
// Velvetyne) are REJECTED: they load through the catalogue path by name alone,
// and a custom_fonts duplicate would shadow that reliable loader with a
// second source of truth. `src` is EITHER a full URL (https://…, data:…) OR an
// uploaded asset filename in the project's asset bucket (uploaded via
// POST /api/upload-asset/<projectId>, raw bytes + X-Filename header). Like
// add_image_layer this does NOT verify an uploaded
// filename exists. Dedupes by family+weight+style, replacing a matching face.
// The editor/embed font loader (fonts.ts) decodes each via the FontFace API
// before the first render. NOTE: a pasted URL only loads if that host sends
// permissive CORS headers; uploading the font (served same-origin) is the
// robust path.

type SetCustomFontArgs = {
  family?: unknown;
  src?: unknown;
  weight?: unknown;
  style?: unknown;
};

const setCustomFont: ToolDispatch<SetCustomFontArgs> = (project, args) => {
  const family = typeof args.family === "string" ? args.family.trim() : "";
  const src = typeof args.src === "string" ? args.src.trim() : "";
  if (!family) {
    return { project, result: { ok: false, error: "family is required" } };
  }
  if (!src) {
    return {
      project,
      result: {
        ok: false,
        error: "src is required (a font URL or an uploaded asset filename)",
      },
    };
  }
  const builtin = getFontEntry(family);
  if (builtin) {
    return {
      project,
      result: {
        ok: false,
        error:
          `"${family}" is a built-in ${builtin.source} family — reference it ` +
          `directly via font_family (add_text_layer / set_layer_text); ` +
          `set_custom_font is only for typefaces Morpha does not ship. ` +
          `Use list_fonts to browse built-in families.`,
      },
    };
  }
  let weight = 400;
  if (args.weight !== undefined && args.weight !== null) {
    const w = Number(args.weight);
    if (!Number.isFinite(w) || w < 1 || w > 1000) {
      return {
        project,
        result: { ok: false, error: "weight must be a number between 1 and 1000" },
      };
    }
    weight = Math.round(w);
  }
  let style: "normal" | "italic" = "normal";
  if (args.style !== undefined && args.style !== null) {
    if (args.style !== "normal" && args.style !== "italic") {
      return {
        project,
        result: { ok: false, error: "style must be 'normal' or 'italic'" },
      };
    }
    style = args.style;
  }
  const next = cloneProject(project);
  const list = [...(next.custom_fonts ?? [])];
  const faceKey = (f: { family: string; weight?: number; style?: string }) =>
    `${f.family.trim().toLowerCase()}|${f.weight ?? 400}|${f.style ?? "normal"}`;
  const entry = { family, src, weight, style };
  const existing = list.findIndex((f) => faceKey(f) === faceKey(entry));
  if (existing >= 0) list[existing] = entry;
  else list.push(entry);
  next.custom_fonts = list;
  return {
    project: next,
    result: { ok: true, data: { custom_fonts: next.custom_fonts } },
  };
};

// ---------------------------------------------------------------------------
// list_fonts — discover families across all sources (+ the project's custom
// fonts) so an agent can pick one to use in set_layer_text / add_text_layer.
// ---------------------------------------------------------------------------

type ListFontsArgs = {
  q?: unknown;
  source?: unknown;
  limit?: unknown;
};

const VALID_SOURCES: ReadonlyArray<FontSource | "custom"> = [
  "google",
  "bunny",
  "fontshare",
  "fontsource",
  "velvetyne",
  "custom",
];

const listFonts: ToolDispatch<ListFontsArgs> = (project, args) => {
  const q = typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
  const srcRaw = typeof args.source === "string" ? args.source.trim().toLowerCase() : "";
  if (srcRaw && !VALID_SOURCES.includes(srcRaw as FontSource | "custom")) {
    return {
      project,
      result: {
        ok: false,
        error: `source must be one of: ${VALID_SOURCES.join(", ")}`,
      },
    };
  }
  let limit = 50;
  if (args.limit !== undefined && args.limit !== null) {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n < 1) {
      return {
        project,
        result: { ok: false, error: "limit must be a positive number" },
      };
    }
    limit = Math.max(1, Math.min(1000, Math.floor(n)));
  }

  // Project's user-uploaded faces, surfaced as source: "custom".
  const customs = (project.custom_fonts ?? []).map((c) => ({
    family: c.family,
    source: "custom" as const,
    weights: c.weight ? [c.weight] : [400],
    italics: c.style === "italic",
  }));
  // Dedupe customs by family (one entry per family, weights merged).
  const customByFamily = new Map<string, (typeof customs)[number]>();
  for (const c of customs) {
    const key = c.family.toLowerCase();
    const existing = customByFamily.get(key);
    if (!existing) customByFamily.set(key, { ...c, weights: [...c.weights] });
    else {
      for (const w of c.weights) if (!existing.weights.includes(w)) existing.weights.push(w);
      existing.italics = existing.italics || c.italics;
    }
  }
  const customEntries = [...customByFamily.values()];

  // Cross-source catalog (Google + the four added sources, deduped by priority).
  const catalog = allFontEntries().map((e) => ({
    family: e.family,
    source: e.source,
    weights: e.weights,
    italics: e.italics,
  }));

  const all = [...customEntries, ...catalog];
  const filtered = all.filter((e) => {
    if (srcRaw && e.source !== srcRaw) return false;
    if (q && !e.family.toLowerCase().includes(q)) return false;
    return true;
  });
  const returned = filtered.slice(0, limit);
  return {
    project,
    result: {
      ok: true,
      data: {
        fonts: returned,
        total: filtered.length,
        returned: returned.length,
        sources: VALID_SOURCES,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// set_matte_source — track matte (one layer masks another's alpha)
// ---------------------------------------------------------------------------

type SetMatteSourceArgs = {
  elementId: string;
  matte_source_id: string | null;
  // Optional. When omitted, the host's existing invert flag is preserved;
  // clearing the mask (matte_source_id null) always clears it.
  matte_inverted?: boolean;
};

const isLeafElementId = (id: string): boolean =>
  id.startsWith("image.") ||
  id.startsWith("video.") ||
  id.startsWith("shapes.") ||
  id.startsWith("text.");

const setMatteSource: ToolDispatch<SetMatteSourceArgs> = (project, args) => {
  const { elementId, matte_source_id } = args;
  if (!elementId || typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  const isGroupHost = elementId.startsWith("group.");
  if (!isLeafElementId(elementId) && !isGroupHost) {
    return {
      project,
      result: {
        ok: false,
        error: "matte can be set on a leaf (image/video/shapes/text.<id>) or a group.<id>",
      },
    };
  }
  if (
    matte_source_id !== null &&
    matte_source_id !== undefined &&
    typeof matte_source_id !== "string"
  ) {
    return {
      project,
      result: { ok: false, error: "matte_source_id must be a string or null" },
    };
  }
  if (typeof matte_source_id === "string") {
    if (isGroupHost) {
      // A group is masked by a shape's path (vector clip), so its matte source
      // must be a shape leaf.
      if (!matte_source_id.startsWith("shapes.")) {
        return {
          project,
          result: {
            ok: false,
            error: "a group's matte source must be a shape (shapes.<id>) — its path clips the group's children",
          },
        };
      }
    } else if (!isLeafElementId(matte_source_id)) {
      return {
        project,
        result: {
          ok: false,
          error: "matte_source_id must be a leaf element id (image.<id>, video.<id>, shapes.<id>, text.<id>)",
        },
      };
    }
    if (matte_source_id === elementId) {
      return {
        project,
        result: { ok: false, error: "matte_source_id cannot reference the host layer" },
      };
    }
    if (!isValidColorTarget(project, matte_source_id)) {
      return {
        project,
        result: { ok: false, error: `unknown matte_source_id: ${matte_source_id}` },
      };
    }
  }
  const next = cloneProject(project);
  const value =
    matte_source_id === null || matte_source_id === undefined
      ? null
      : matte_source_id;
  // Invert flag: clearing the mask clears invert; an explicit boolean wins;
  // otherwise preserve the host's current value.
  const nextInverted = (prev: boolean | undefined): boolean | undefined =>
    value === null
      ? undefined
      : typeof args.matte_inverted === "boolean"
        ? args.matte_inverted
        : prev;
  if (elementId.startsWith("image.")) {
    const id = elementId.slice("image.".length);
    const idx = next.image_layers.findIndex((l) => l.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
    }
    next.image_layers[idx] = {
      ...next.image_layers[idx],
      matte_source_id: value,
      matte_inverted: nextInverted(next.image_layers[idx].matte_inverted),
    };
  } else if (elementId.startsWith("video.")) {
    const id = elementId.slice("video.".length);
    const idx = next.video_layers.findIndex((v) => v.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown layer: ${elementId}` } };
    }
    next.video_layers[idx] = {
      ...next.video_layers[idx],
      matte_source_id: value,
      matte_inverted: nextInverted(next.video_layers[idx].matte_inverted),
    };
  } else if (elementId.startsWith("shapes.")) {
    const id = elementId.slice("shapes.".length);
    const idx = next.shapes.findIndex((s) => s.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown shape: ${elementId}` } };
    }
    next.shapes[idx] = {
      ...next.shapes[idx],
      matte_source_id: value,
      matte_inverted: nextInverted(next.shapes[idx].matte_inverted),
    };
  } else if (elementId.startsWith("text.")) {
    const id = elementId.slice("text.".length);
    const idx = next.text_layers.findIndex((t) => t.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown text layer: ${elementId}` } };
    }
    next.text_layers[idx] = {
      ...next.text_layers[idx],
      matte_source_id: value,
      matte_inverted: nextInverted(next.text_layers[idx].matte_inverted),
    };
  } else if (elementId.startsWith("group.")) {
    const id = elementId.slice("group.".length);
    const idx = next.groups.findIndex((g) => g.id === id);
    if (idx < 0) {
      return { project, result: { ok: false, error: `unknown group: ${elementId}` } };
    }
    next.groups[idx] = {
      ...next.groups[idx],
      matte_source_id: value,
      matte_inverted: nextInverted(next.groups[idx].matte_inverted),
    };
  }
  return { project: next, result: { ok: true, data: { elementId, matte_source_id: value } } };
};

// ---------------------------------------------------------------------------
// set_clip_speed — constant playback rate for a clip
// ---------------------------------------------------------------------------

type SetClipSpeedArgs = {
  elementId: string;
  speed: number;
};

// Retime a clip to a constant rate. The trimmed source span is untouched — the
// clip's on-timeline length is DERIVED from the rate (`videoWindow`), so 0.5×
// makes the clip twice as long and 2× halves it. Layers after it on the
// timeline are NOT rippled; a retimed clip can therefore overlap or leave a gap
// against its neighbours, exactly as dragging its trim handle can.
const setClipSpeed: ToolDispatch<SetClipSpeedArgs> = (project, args) => {
  const { elementId, speed } = args;
  if (!elementId || !elementId.startsWith("video.")) {
    return { project, result: { ok: false, error: "elementId must be video.<id>" } };
  }
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    return {
      project,
      result: {
        ok: false,
        error: `invalid speed: ${speed} (must be in [${MIN_SPEED}, ${MAX_SPEED}])`,
      },
    };
  }
  const id = elementId.slice("video.".length);
  const idx = project.video_layers.findIndex((v) => v.id === id);
  if (idx < 0) {
    return { project, result: { ok: false, error: `video layer not found: ${elementId}` } };
  }
  const next = cloneProject(project);
  next.video_layers[idx] = { ...next.video_layers[idx], speed };
  return { project: next, result: { ok: true, data: { elementId, speed } } };
};

// Push everything at or after `at` later by `delta` — the INSERT half of an
// edit that adds time. Every kind of thing that sits on the timeline moves:
// clips, bounded layers, audio overlays and welded captions. Shifting only
// `video_layers` was the first version of this and it silently left music,
// captions and every bounded overlay behind.
//
// `skip` names layers the caller has already positioned itself. Anything that
// STRADDLES `at` is deliberately untouched — it was already on screen when the
// insert began, so moving it would tear it away from what it was over.
const shiftTimelineAt = (
  project: Composition,
  at: number,
  delta: number,
  skip: ReadonlySet<string>, // ELEMENT ids ("image.ab12"), not bare ids
): void => {
  if (delta === 0) return;
  // A layer nested under an embedded morpha BAND lives in the band's own
  // timeline: its `block.start` / `timeline_start_frame` are BAND-LOCAL (see
  // `ancestorBandOriginSum` / `effectiveFrameOffset`), so comparing them
  // against a host-timeline frame is category confusion, and inserting host
  // time never moves them — the BAND is the thing on the host timeline, and it
  // shifts (or straddles) as one unit via its own block below. Shifting a band
  // child too would double-shift it, leaving it painting at no frame.
  const bandNested = (elementId: string): boolean => {
    for (const gid of getAncestorGroupChain(project, elementId)) {
      const g = layerOf(project, `group.${gid}`);
      if (g && isMorphaGroup(g as Group)) return true;
    }
    return false;
  };
  for (let i = 0; i < project.video_layers.length; i++) {
    const l = project.video_layers[i];
    const eid = `video.${l.id}`;
    if (skip.has(eid) || bandNested(eid)) continue;
    if (l.timeline_start_frame >= at) {
      project.video_layers[i] = {
        ...l,
        timeline_start_frame: l.timeline_start_frame + delta,
      };
    }
  }
  // Bounded layers of every other kind — image / text / shape / group. A
  // welded caption line is skipped even if it carries a block: its window is
  // DERIVED from its clip's trim (deriveCaptionWindow), and that clip has
  // already moved — same reason cut_range's remap excludes `caption_source`
  // layers.
  const bounded: Array<
    [
      string,
      Array<{
        id: string;
        block?: { start: number; duration: number };
        caption_source?: unknown;
      }>,
    ]
  > = [
    ["image", project.image_layers],
    ["text", project.text_layers],
    ["shapes", project.shapes],
    ["group", project.groups],
  ];
  for (const [kind, arr] of bounded) {
    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      const eid = `${kind}.${l.id}`;
      if (skip.has(eid) || l.caption_source || bandNested(eid)) continue;
      if (l.block && l.block.start >= at) {
        (arr[i] as { block?: { start: number; duration: number } }) = {
          ...(arr[i] as object),
          block: { ...l.block, start: l.block.start + delta },
        } as never;
      }
    }
  }
  // Audio overlays. A WELDED overlay derives its timing from its clip, which
  // has already moved, so only a STANDALONE one (music, voiceover) is shifted
  // here — moving both would double the shift.
  for (let i = 0; i < (project.audio_overlays ?? []).length; i++) {
    const o = project.audio_overlays[i];
    if (o.sourceLayerId) continue;
    if (o.startFrame >= at) {
      project.audio_overlays[i] = {
        ...o,
        startFrame: o.startFrame + delta,
        ...(o.endFrame != null ? { endFrame: o.endFrame + delta } : {}),
      };
    }
  }
};

// ---------------------------------------------------------------------------
// freeze_frame — split at a frame and hold it as a still IMAGE
// ---------------------------------------------------------------------------

type FreezeFrameArgs = {
  elementId: string;
  frame: number;
  image: string;
  holdFrames?: number;
};

// Freeze the picture at `frame`: the clip is cut there and a STILL of that frame
// is inserted between the halves, pushing everything after it later. The NLE
// "frame hold".
//
// The still is an IMAGE LAYER, not a frozen video layer. That is the whole
// design, and it is the third attempt: a video layer's geometry is maintained
// through its TRIM by every operation that touches it — both Timeline handles,
// `cut_range`, the razor — so giving a clip a SECOND notion of length
// desynchronises the moment anything moves it. (Reading `source_out_frame` as a
// duration broke four consumers; putting the length in `block` made a moved
// still paint zero frames, because the block gate and the clip-window gate went
// disjoint.) An image layer has ONE notion of length — its block — and every op
// already handles it correctly, so nothing has to learn that stills exist.
//
// `image` is the filename of a PNG of that frame, already uploaded to the
// project's assets. Rendering it needs the browser's compositor, so the editor
// captures and uploads first, then calls this — the same split `add_image_layer`
// already uses (it does not verify the file exists either).
//
// The CUT half is `splitClipAt` — the same razor the editor's scissors is a
// wrapper over — so a freeze carries everything a split carries (retimed cut
// point, speed-ramp rebase, lane weld, adjacent z-placement, welded-audio
// re-weld, caption re-anchor) by construction, not by re-implementation. A
// natural-end clip (`source_out_frame` null) is treated as unbounded on the
// right, same as `cut_range` / `splitClipAt`; the editor, which can decode the
// real duration, guards the end before calling.
const freezeFrame: ToolDispatch<FreezeFrameArgs> = (project, args) => {
  const { elementId, frame, image, holdFrames } = args;
  if (!elementId || !elementId.startsWith("video.")) {
    return { project, result: { ok: false, error: "elementId must be video.<id>" } };
  }
  if (!image || typeof image !== "string") {
    return {
      project,
      result: { ok: false, error: "image is required — the uploaded PNG of the frozen frame" },
    };
  }
  const src = project.video_layers.find(
    (v) => v.id === elementId.slice("video.".length),
  );
  if (!src) {
    return { project, result: { ok: false, error: `video layer not found: ${elementId}` } };
  }
  const hold = Math.round(holdFrames ?? LAYER_CLIP_DEFAULT_FRAMES);
  if (!Number.isFinite(hold) || hold < 1) {
    return { project, result: { ok: false, error: `invalid holdFrames: ${holdFrames}` } };
  }
  const at = Math.round(frame);

  // 1. THE CUT — the shared razor. On refusal nothing has been touched.
  const next = cloneProject(project);
  const split = splitClipAt(next, elementId, at, src.source_out_frame);
  if (!split.ok) {
    return {
      project,
      result: { ok: false, error: `${split.error} — move the playhead into the clip` },
    };
  }
  // The SOURCE frame on screen at the cut — on a retimed clip this is not
  // `at - start`, and it is the frame the caller must have rendered.
  const frozenSource = split.cutSourceFrame;

  // 2. THE STILL — an ordinary bounded image clip, matching the source clip's
  // geometry so the freeze is visually seamless.
  const stillId = generateLayerId(next, "image");
  const still: ImageLayer = {
    id: stillId,
    scale: 1,
    opacity: 1,
    // Label by the timeline moment, in clock time — without a name the
    // Timeline/Inspector would fall back to the asset filename, which carries
    // a raw source-frame count (never user-facing).
    name: `Freeze ${formatClockLabel(at)}`,
    filename: image,
    x: src.x,
    y: src.y,
    width: src.width,
    height: src.height,
    rotation: src.rotation,
    pivotX: src.pivotX,
    pivotY: src.pivotY,
    fill: null,
    // A hard cut in and out: a freeze is a cut, not a dissolve, and the born
    // defaults would otherwise fade it.
    block: { start: at, duration: hold },
  };
  next.image_layers = [...next.image_layers, still];
  // Between the halves: the razor placed the remainder directly after the left
  // half (in the parent group's children or layer_order), so inserting the
  // still after the left half reads left → still → remainder, at the clip's own
  // z — and each id appears exactly ONCE (the first version materialized the
  // root order AFTER pushing the new layers, which listed them twice).
  insertElementAfter(next, elementId, `image.${stillId}`);

  // 3. THE INSERT — everything starting at or after the cut moves later by the
  // hold: the remainder (the razor left it flush at the cut), other clips,
  // bounded layers, standalone audio. Welded captions and welded overlays
  // derive their timing from their clip, so they follow it; anything that
  // STRADDLES the cut is left alone — it was already on screen when the freeze
  // began. Only the still is pre-positioned.
  shiftTimelineAt(next, at, hold, new Set([`image.${stillId}`]));
  // The welded overlay the razor copied onto the remainder recorded the
  // remainder's PRE-shift file-time origin. Vestigial while welded (timing
  // derives from the clip), but keep it sensible for a later detach.
  for (let i = 0; i < (next.audio_overlays ?? []).length; i++) {
    const o = next.audio_overlays[i];
    if (o.sourceLayerId === split.rightEid) {
      next.audio_overlays[i] = {
        ...o,
        startFrame: Math.max(0, at + hold - frozenSource),
      };
    }
  }
  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId,
        frozenAt: at,
        frozenSourceFrame: frozenSource,
        holdFrames: hold,
        still: `image.${stillId}`,
        remainder: split.rightEid,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// add_speed_keyframe / remove_speed_keyframe — video time-remap curve
// ---------------------------------------------------------------------------

type AddSpeedKeyframeArgs = {
  elementId: string;
  frame: number;
  rate: number;
};

const addSpeedKeyframe: ToolDispatch<AddSpeedKeyframeArgs> = (project, args) => {
  const { elementId, frame, rate } = args;
  if (!elementId || !elementId.startsWith("video.")) {
    return { project, result: { ok: false, error: "elementId must be video.<id>" } };
  }
  if (!Number.isFinite(frame) || frame < 0) {
    return { project, result: { ok: false, error: `invalid frame: ${frame}` } };
  }
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 8) {
    return { project, result: { ok: false, error: `invalid rate: ${rate} (must be in [0.1, 8])` } };
  }
  const id = elementId.slice("video.".length);
  const idx = project.video_layers.findIndex((v) => v.id === id);
  if (idx < 0) {
    return { project, result: { ok: false, error: `video layer not found: ${elementId}` } };
  }
  const next = cloneProject(project);
  const cur = next.video_layers[idx];
  const list = [...(cur.speed_keyframes ?? [])];
  // `frame` is a PROJECT frame (what a caller with a playhead has); storage is
  // CLIP-RELATIVE so the curve travels with the clip. Convert here — the one
  // place the two spaces meet on the write path — and answer in PROJECT frames
  // too, so the value a caller reads back is the value that addresses the
  // keyframe again. Echoing the stored offset made remove_speed_keyframe fail
  // on the number add_speed_keyframe had just returned.
  const clipStart = Math.max(0, cur.timeline_start_frame);
  const projectFrame = Math.round(frame);
  // A frame BEFORE the clip has no offset — clamping it onto 0 silently
  // rewrote the head keyframe's rate. Refuse instead.
  if (projectFrame < clipStart) {
    return {
      project,
      result: {
        ok: false,
        error: `frame ${projectFrame} is before ${elementId} starts (${clipStart}); a speed keyframe must sit on the clip`,
      },
    };
  }
  const f = projectFrame - clipStart;
  const existing = list.findIndex((k) => k.frame === f);
  if (existing >= 0) list[existing] = { frame: f, rate };
  else list.push({ frame: f, rate });
  list.sort((a, b) => a.frame - b.frame);
  next.video_layers[idx] = { ...cur, speed_keyframes: list };
  return {
    project: next,
    result: { ok: true, data: { elementId, frame: projectFrame, rate } },
  };
};

type RemoveSpeedKeyframeArgs = { elementId: string; frame: number };

const removeSpeedKeyframe: ToolDispatch<RemoveSpeedKeyframeArgs> = (project, args) => {
  const { elementId, frame } = args;
  if (!elementId || !elementId.startsWith("video.")) {
    return { project, result: { ok: false, error: "elementId must be video.<id>" } };
  }
  const id = elementId.slice("video.".length);
  const idx = project.video_layers.findIndex((v) => v.id === id);
  if (idx < 0) {
    return { project, result: { ok: false, error: `video layer not found: ${elementId}` } };
  }
  const next = cloneProject(project);
  const cur = next.video_layers[idx];
  // Project frame in, clip-relative storage out — mirrors addSpeedKeyframe,
  // including reporting the PROJECT frame the caller passed rather than the
  // internal offset (which is neither the argument nor anything they can see).
  const clipStart = Math.max(0, cur.timeline_start_frame);
  const projectFrame = Math.round(frame);
  const f = projectFrame - clipStart;
  const list = (cur.speed_keyframes ?? []).filter((k) => k.frame !== f);
  if (list.length === (cur.speed_keyframes ?? []).length) {
    return {
      project,
      result: {
        ok: false,
        error: `no speed keyframe at frame ${projectFrame} on ${elementId}`,
      },
    };
  }
  next.video_layers[idx] = {
    ...cur,
    speed_keyframes: list.length > 0 ? list : undefined,
  };
  return { project: next, result: { ok: true } };
};

type EmbedOriginArg = { origin?: unknown };

const addEmbedOrigin: ToolDispatch<EmbedOriginArg> = (project, args) => {
  const { origin } = args;
  if (typeof origin !== "string") {
    return {
      project,
      result: { ok: false, error: "origin must be a string" },
    };
  }
  const host = normalizeOrigin(origin);
  if (!host) {
    return {
      project,
      result: { ok: false, error: "origin is empty after normalization" },
    };
  }
  if (project.embed_origins.includes(host)) {
    // Idempotent — already allowlisted; return the same project ref so the
    // route's `outcome.project !== project` guard skips a redundant write.
    return {
      project,
      result: {
        ok: true,
        data: { embed_origins: project.embed_origins, added: false },
      },
    };
  }
  const next = cloneProject(project);
  next.embed_origins = [...project.embed_origins, host];
  return {
    project: next,
    result: {
      ok: true,
      data: { embed_origins: next.embed_origins, added: true },
    },
  };
};

const removeEmbedOrigin: ToolDispatch<EmbedOriginArg> = (project, args) => {
  const { origin } = args;
  if (typeof origin !== "string") {
    return {
      project,
      result: { ok: false, error: "origin must be a string" },
    };
  }
  const host = normalizeOrigin(origin);
  if (!project.embed_origins.includes(host)) {
    // Idempotent — not present; same project ref so the route skips the write.
    return {
      project,
      result: {
        ok: true,
        data: { embed_origins: project.embed_origins, removed: false },
      },
    };
  }
  const next = cloneProject(project);
  next.embed_origins = project.embed_origins.filter((h) => h !== host);
  return {
    project: next,
    result: {
      ok: true,
      data: { embed_origins: next.embed_origins, removed: true },
    },
  };
};

// ---------------------------------------------------------------------------
// set_layer_text
// ---------------------------------------------------------------------------
//
// Edit an existing text layer (text.<id>) — patch its text content, font,
// size, or colour. Pass only the fields you want to change. Use
// add_text_layer to create a new text layer; set_layer_text never creates
// one and never touches image layers.

const DEFAULT_TEXT_FONT = "Hanken Grotesk";

// Validate + assign the optional text-style props shared by set_layer_text and
// add_text_layer. Mutates `layer`; returns an error message on the first bad
// field, else null.
// Validate a `decorations` tool arg into a normalized TextDecorations (or
// undefined to clear). Returns an error string on a malformed shape. Offsets are
// character indices [start, end) into the layer's `text`.
const parseDecorationsArg = (
  v: unknown,
): TextDecorations | undefined | string => {
  if (v === null) return undefined; // explicit clear
  if (typeof v !== "object") {
    return "decorations must be an object { underline?, strikethrough? } or null";
  }
  const obj = v as Record<string, unknown>;
  const out: TextDecorations = {};
  for (const kind of ["underline", "strikethrough"] as const) {
    const list = obj[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      return `decorations.${kind} must be an array of { start, end } ranges`;
    }
    const ranges: { start: number; end: number }[] = [];
    for (const r of list) {
      const rr = r as Record<string, unknown>;
      if (
        typeof r !== "object" ||
        r === null ||
        typeof rr.start !== "number" ||
        typeof rr.end !== "number" ||
        !Number.isFinite(rr.start) ||
        !Number.isFinite(rr.end)
      ) {
        return `decorations.${kind} ranges must be { start: number, end: number }`;
      }
      ranges.push({ start: rr.start, end: rr.end });
    }
    out[kind] = ranges;
  }
  // normalizeDecorations sorts/merges/drops invalid ranges and returns undefined
  // when nothing is left, so a clear round-trips to no field.
  return normalizeDecorations(out);
};

const applyTextStyleProps = (
  layer: TextLayer,
  args: Record<string, unknown>,
): string | null => {
  if (args.font_weight !== undefined) {
    const w = args.font_weight;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 100 || w > 900) {
      return "font_weight must be a number 100..900";
    }
    layer.font_weight = Math.round(w);
  }
  if (args.font_style !== undefined) {
    const v = args.font_style;
    if (v === "normal" || v === "italic") layer.font_style = v;
    else return 'font_style must be "normal" or "italic"';
  }
  if (args.text_transform !== undefined) {
    const v = args.text_transform;
    if (v === "none" || v === "uppercase" || v === "lowercase") {
      layer.text_transform = v;
    } else {
      return 'text_transform must be "none", "uppercase", or "lowercase"';
    }
  }
  if (args.letter_spacing !== undefined) {
    const v = args.letter_spacing;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return "letter_spacing must be a number";
    }
    layer.letter_spacing = v;
  }
  if (args.curve !== undefined) {
    const v = args.curve;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return "curve must be a number (degrees; 0 = straight)";
    }
    // Clamp to the legible range; store the bounded value so downstream reads
    // (renderer, Inspector) never see an out-of-range curve.
    layer.curve = clampCurve(v);
  }
  if (args.line_height !== undefined) {
    const v = args.line_height;
    if (typeof v !== "number" || !(v > 0)) {
      return "line_height must be a positive number";
    }
    layer.line_height = v;
  }
  if (args.text_align !== undefined) {
    const v = args.text_align;
    if (v === "left" || v === "center" || v === "right") layer.text_align = v;
    else return 'text_align must be "left", "center", or "right"';
  }
  if (args.text_autofit !== undefined) {
    const v = args.text_autofit;
    if (v === "fit" || v === "shrink" || v === "wrap" || v === "hug") {
      layer.text_autofit = v;
      // "hug" derives the box from the text at a FIXED size — seed text_size
      // from the current box so the layer doesn't collapse to the renderer's
      // default. An explicit text_size in the same call still wins.
      if (
        v === "hug" &&
        (layer.text_size == null || layer.text_size <= 0) &&
        args.text_size === undefined
      ) {
        layer.text_size = Math.max(8, Math.round(layer.height * 0.5));
      }
    } else {
      return 'text_autofit must be "fit", "shrink", "wrap", or "hug"';
    }
  }
  if (args.text_valign !== undefined) {
    const v = args.text_valign;
    if (v === "top" || v === "middle" || v === "bottom") layer.text_valign = v;
    else return 'text_valign must be "top", "middle", or "bottom"';
  }
  if (args.stroke_width !== undefined) {
    const v = args.stroke_width;
    if (typeof v !== "number" || !(v >= 0)) {
      return "stroke_width must be a number >= 0";
    }
    layer.stroke_width = v;
  }
  if (args.stroke_color !== undefined) {
    const v = args.stroke_color;
    if (typeof v !== "string" || !HEX.test(v)) {
      return "stroke_color must be a #rrggbb hex string";
    }
    layer.stroke_color = v;
  }
  if (args.text_shadow !== undefined) {
    const v = args.text_shadow;
    if (v === null) {
      layer.text_shadow = null;
    } else if (typeof v === "object") {
      const sh = v as Record<string, unknown>;
      if (
        typeof sh.offsetX !== "number" ||
        typeof sh.offsetY !== "number" ||
        typeof sh.blur !== "number" ||
        !(sh.blur >= 0) ||
        typeof sh.color !== "string"
      ) {
        return "text_shadow must be { offsetX, offsetY, blur>=0, color } or null";
      }
      layer.text_shadow = {
        offsetX: sh.offsetX,
        offsetY: sh.offsetY,
        blur: sh.blur,
        color: sh.color,
      };
    } else {
      return "text_shadow must be an object or null";
    }
  }
  if (args.decorations !== undefined) {
    const parsed = parseDecorationsArg(args.decorations);
    if (typeof parsed === "string") return parsed;
    if (parsed) layer.decorations = parsed;
    else delete layer.decorations;
  }
  return null;
};

type SetLayerTextArgs = {
  elementId?: unknown;
  text?: unknown;
  text_size?: unknown;
  font_family?: unknown;
  text_color?: unknown;
  font_weight?: unknown;
  font_style?: unknown;
  text_transform?: unknown;
  letter_spacing?: unknown;
  curve?: unknown;
  line_height?: unknown;
  text_align?: unknown;
  stroke_width?: unknown;
  stroke_color?: unknown;
  text_shadow?: unknown;
  decorations?: unknown;
};

const setLayerText: ToolDispatch<SetLayerTextArgs> = (project, args) => {
  const { elementId } = args;
  if (typeof elementId !== "string" || !elementId.startsWith("text.")) {
    return {
      project,
      result: {
        ok: false,
        error: "elementId must be a text layer id (text.<id>)",
      },
    };
  }
  const id = elementId.slice("text.".length);
  const next = cloneProject(project);
  const layer = next.text_layers.find((t) => t.id === id);
  if (!layer) {
    return {
      project,
      result: { ok: false, error: `text layer not found: ${elementId}` },
    };
  }

  const { text, text_size, font_family, text_color } = args;

  if (text !== undefined) {
    if (typeof text !== "string") {
      return {
        project,
        result: { ok: false, error: "text must be a string" },
      };
    }
    // Rebase existing decoration offsets across the text edit, UNLESS the caller
    // also supplies a fresh `decorations` set (applied authoritatively below,
    // indexing into the new text).
    if (
      layer.decorations &&
      args.decorations === undefined &&
      text !== layer.text
    ) {
      const rebased = rebaseDecorations(layer.text, text, layer.decorations);
      if (rebased) layer.decorations = rebased;
      else delete layer.decorations;
    }
    layer.text = text;
  }
  if (text_size !== undefined) {
    if (typeof text_size !== "number" || !(text_size > 0)) {
      return {
        project,
        result: { ok: false, error: "text_size must be a positive number" },
      };
    }
    layer.text_size = text_size;
  }
  if (font_family !== undefined) {
    if (typeof font_family !== "string" || font_family.trim().length === 0) {
      return {
        project,
        result: { ok: false, error: "font_family must be a non-empty string" },
      };
    }
    layer.font_family = font_family.trim();
  }
  if (text_color !== undefined) {
    if (typeof text_color !== "string" || !HEX.test(text_color)) {
      return {
        project,
        result: {
          ok: false,
          error: "text_color must be a #rrggbb hex string",
        },
      };
    }
    layer.text_color = text_color;
  }

  const styleErr = applyTextStyleProps(layer, args as Record<string, unknown>);
  if (styleErr) {
    return { project, result: { ok: false, error: styleErr } };
  }

  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId,
        text: layer.text,
        text_size: layer.text_size ?? null,
        font_family: layer.font_family,
        text_color: layer.text_color ?? null,
        font_weight: layer.font_weight ?? null,
        font_style: layer.font_style ?? null,
        text_transform: layer.text_transform ?? null,
        letter_spacing: layer.letter_spacing ?? null,
        curve: layer.curve ?? 0,
        line_height: layer.line_height ?? null,
        text_align: layer.text_align ?? null,
        stroke_width: layer.stroke_width ?? null,
        stroke_color: layer.stroke_color ?? null,
        decorations: layer.decorations ?? null,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// add_text_layer
// ---------------------------------------------------------------------------
//
// Create a new text layer. Mints a fresh `text.<id>`, appends a TextLayer to
// project.text_layers, and appends the element id to layer_order so it lands
// at the top of the root z-stack. A text layer is a first-class leaf — it
// animates, groups, and z-orders exactly like an image or shape.

type AddTextLayerArgs = {
  text?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  font_family?: unknown;
  text_size?: unknown;
  text_color?: unknown;
  font_weight?: unknown;
  font_style?: unknown;
  text_transform?: unknown;
  letter_spacing?: unknown;
  curve?: unknown;
  line_height?: unknown;
  text_align?: unknown;
  stroke_width?: unknown;
  stroke_color?: unknown;
  text_shadow?: unknown;
  decorations?: unknown;
  block?: unknown;
};

const DEFAULT_TEXT_W = 900;
const DEFAULT_TEXT_H = 320;

const addTextLayer: ToolDispatch<AddTextLayerArgs> = (project, args) => {
  const { text, x, y, width, height, font_family, text_size, text_color } =
    args;
  if (text !== undefined && typeof text !== "string") {
    return { project, result: { ok: false, error: "text must be a string" } };
  }
  if (
    font_family !== undefined &&
    (typeof font_family !== "string" || font_family.trim().length === 0)
  ) {
    return {
      project,
      result: { ok: false, error: "font_family must be a non-empty string" },
    };
  }
  if (
    text_size !== undefined &&
    (typeof text_size !== "number" || !(text_size > 0))
  ) {
    return {
      project,
      result: { ok: false, error: "text_size must be a positive number" },
    };
  }
  if (
    text_color !== undefined &&
    (typeof text_color !== "string" || !HEX.test(text_color))
  ) {
    return {
      project,
      result: { ok: false, error: "text_color must be a #rrggbb hex string" },
    };
  }
  for (const [k, v] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      return {
        project,
        result: { ok: false, error: `${k} must be a finite number` },
      };
    }
  }
  for (const [k, v] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (
      v !== undefined &&
      (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
    ) {
      return {
        project,
        result: { ok: false, error: `${k} must be a positive number` },
      };
    }
  }
  const parsedBlock = parseAddBlockArg(args.block);
  if (parsedBlock.error) {
    return { project, result: { ok: false, error: parsedBlock.error } };
  }

  const next = cloneProject(project);
  const id = generateLayerId(next, "text");

  // Default text_size: shared with the editor's addTextLayer so editor- and
  // agent-created text get the SAME explicit size (see resolveDefaultTextSize).
  const resolvedTextSize =
    typeof text_size === "number" ? text_size : resolveDefaultTextSize(next);

  const layer: TextLayer = {
    id,
    scale: 1,
    opacity: 1,
    text: typeof text === "string" ? text : "",
    x: typeof x === "number" ? x : next.canvas_width / 2,
    y: typeof y === "number" ? y : next.canvas_height / 2,
    width: typeof width === "number" ? width : DEFAULT_TEXT_W,
    height: typeof height === "number" ? height : DEFAULT_TEXT_H,
    rotation: 0,
    // Straight by default; an explicit `curve` arg is applied via
    // applyTextStyleProps below (mirrors how `rotation` seeds 0 here).
    curve: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    font_family:
      typeof font_family === "string" ? font_family.trim() : DEFAULT_TEXT_FONT,
    ...(resolvedTextSize !== undefined ? { text_size: resolvedTextSize } : {}),
    ...(typeof text_color === "string" ? { text_color } : {}),
    // Hug by default — the box is DERIVED from the measured text (honouring its
    // literal "\n" breaks) at the fixed text_size, so it shrink-wraps the exact
    // content and can NEVER re-wrap differently between the editor preview and
    // the export. That divergence is the failure mode fixed-width "wrap" text
    // hits whenever the two paths resolve different font metrics (e.g. a weight
    // the editor faux-synthesizes but the export loads as a real cut). Callers
    // bake their own line breaks; an explicit `text_autofit` arg overrides this
    // via applyTextStyleProps. (The editor's manual "add text" button keeps
    // "wrap": it creates an empty layer to type into, and an empty hug box
    // would collapse to nothing.)
    text_autofit: "hug",
    fill: null,
    // Window AND edge transitions together — see bornLayerDefaults.
    ...bornLayerDefaults(parsedBlock.block),
  };
  const styleErr = applyTextStyleProps(layer, args as Record<string, unknown>);
  if (styleErr) {
    return { project, result: { ok: false, error: styleErr } };
  }
  next.text_layers = [...next.text_layers, layer];
  next.layer_order = [...next.layer_order, `text.${id}`];
  return {
    project: next,
    result: { ok: true, data: { id, elementId: `text.${id}` } },
  };
};

// ---------------------------------------------------------------------------
// add_caption_track
// ---------------------------------------------------------------------------
//
// Build a caption track from pre-timed lines. The editor derives the lines
// from the clip's Whisper transcript (word timings → ~5-word lines); an agent
// can pass its own. Two modes:
//   • "line-sync" (default) — one text layer per line, each shown only during
//     its [startFrame, endFrame) window via hold-eased opacity keyframes (the
//     "active line" karaoke read). Hold easing makes the lines snap on/off.
//   • "static" — a single layer with every line joined by newlines.
// A style preset maps to the text layer's font / colour / outline. Lines
// default to a lower-third band spanning most of the canvas width. Every
// created layer is named "Captions …" so callers can detect / clear the track.

type CaptionLineArg = {
  text?: unknown;
  startFrame?: unknown;
  endFrame?: unknown;
  clip_element_id?: unknown;
};
type AddCaptionTrackArgs = {
  lines?: unknown;
  mode?: unknown;
  style?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  clip_element_id?: unknown;
};

export const CAPTION_STYLE_PRESETS: Record<string, Record<string, unknown>> = {
  classic: {
    font_family: "Hanken Grotesk",
    font_weight: 800,
    text_color: "#FFFFFF",
    text_align: "center",
    text_shadow: { offsetX: 0, offsetY: 2, blur: 10, color: "rgba(0,0,0,0.5)" },
  },
  "bold-outline": {
    font_family: "Anton",
    text_color: "#FFFFFF",
    text_transform: "uppercase",
    text_align: "center",
    // A thin outline reads cleanly over busy footage; a heavy one (was 10px)
    // swallows the white fill and the text becomes unreadable.
    stroke_width: 4,
    stroke_color: "#000000",
  },
  "word-pop": {
    font_family: "Anton",
    text_color: "#FF7A66",
    text_transform: "uppercase",
    text_align: "center",
    stroke_width: 8,
    stroke_color: "#FFFFFF",
  },
};

// Layer name `add_caption_track` stamps on the text layers it creates — bare
// for a single static block, suffixed with the line number per line otherwise —
// so a caption reads as a caption in the layer list rather than by its words.
// A label only: whether a clip is already captioned is answered by its welded
// `caption_source` anchor (see hasCaptionsForClip), never by this string.
export const CAPTION_LAYER_NAME = "Captions";

const addCaptionTrack: ToolDispatch<AddCaptionTrackArgs> = (project, args) => {
  if (!Array.isArray(args.lines) || args.lines.length === 0) {
    return {
      project,
      result: { ok: false, error: "lines must be a non-empty array" },
    };
  }
  const lines: {
    text: string;
    startFrame: number;
    endFrame: number;
    clipElementId?: string;
  }[] = [];
  for (const raw of args.lines as CaptionLineArg[]) {
    if (!raw || typeof raw !== "object") {
      return {
        project,
        result: { ok: false, error: "each line must be an object" },
      };
    }
    const text = typeof raw.text === "string" ? raw.text : "";
    if (text.trim().length === 0) continue;
    const startFrame =
      typeof raw.startFrame === "number" && Number.isFinite(raw.startFrame)
        ? Math.max(0, Math.round(raw.startFrame))
        : 0;
    const endRaw =
      typeof raw.endFrame === "number" && Number.isFinite(raw.endFrame)
        ? Math.round(raw.endFrame)
        : startFrame + 30;
    const lineClip =
      typeof raw.clip_element_id === "string" ? raw.clip_element_id : undefined;
    lines.push({
      text,
      startFrame,
      endFrame: Math.max(startFrame + 1, endRaw),
      clipElementId: lineClip,
    });
  }
  if (lines.length === 0) {
    return {
      project,
      result: { ok: false, error: "no non-empty caption lines" },
    };
  }

  const mode = args.mode === "static" ? "static" : "line-sync";
  const styleKey =
    typeof args.style === "string" && args.style in CAPTION_STYLE_PRESETS
      ? args.style
      : "classic";
  const stylePreset = CAPTION_STYLE_PRESETS[styleKey];

  // Optional clip to WELD the caption lines to. When a line has a weld clip
  // (its own `clip_element_id`, or the top-level default), its [startFrame,
  // endFrame) is treated as the line's window in that clip's OWN (source)
  // timeline and stored as a `caption_source` anchor instead of a fixed
  // project-frame block — its on-timeline window is then derived live from the
  // clip's trim (deriveCaptionWindow), so trimming/sliding the clip retimes the
  // caption. Per-line clips let a montage (one source split into several lane
  // clips) route each line onto the clip that actually shows its words. Every
  // referenced clip must be an existing video layer.
  const validClipEid = (eid: string): boolean =>
    eid.startsWith("video.") &&
    project.video_layers.some((v) => v.id === eid.slice("video.".length));
  if (
    args.clip_element_id !== undefined &&
    args.clip_element_id !== null &&
    (typeof args.clip_element_id !== "string" || !validClipEid(args.clip_element_id))
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `clip_element_id must be an existing "video.<id>": ${String(args.clip_element_id)}`,
      },
    };
  }
  const defaultClipElementId =
    typeof args.clip_element_id === "string" ? args.clip_element_id : undefined;
  for (const line of lines) {
    const eff = line.clipElementId ?? defaultClipElementId;
    if (eff !== undefined && !validClipEid(eff)) {
      return {
        project,
        result: { ok: false, error: `clip_element_id not found: ${eff}` },
      };
    }
    line.clipElementId = eff;
  }

  const cw = project.canvas_width;
  const ch = project.canvas_height;
  const x = typeof args.x === "number" ? args.x : cw / 2;
  // Default the band so its BOTTOM sits at ~0.8·height (the lower-third spot a
  // single caption line used to occupy): with bottom valign below, a 1-line
  // caption stays put and a wrapped 2-line caption grows UPWARD instead of
  // shifting. y is the box centre, so centre = bottom − height/2.
  const height =
    typeof args.height === "number" ? args.height : Math.round(ch * 0.16);
  const y =
    typeof args.y === "number" ? args.y : Math.round(ch * 0.8 - height / 2);
  const width = typeof args.width === "number" ? args.width : Math.round(cw * 0.86);
  // Fixed caption text size + "wrap" autofit + "bottom" valign → every line is
  // the SAME height AND pinned to a fixed baseline. ~10% of canvas width pairs
  // with the short-chunk caption lines (≤~18 chars). "wrap" holds the size
  // fixed and word-wraps a long line onto a second line (hard-breaking a single
  // over-wide word) instead of shrinking it; "bottom" makes that extra line
  // grow upward so the caption never bounces size OR position line-to-line.
  const captionTextSize = Math.round(cw * 0.1);
  const baseTextArgs = {
    x,
    y,
    width,
    height,
    text_size: captionTextSize,
    text_autofit: "wrap",
    text_valign: "bottom",
    ...stylePreset,
  };

  let cur = project;
  const created: string[] = [];
  const setName = (proj: Composition, elementId: string, name: string) => {
    const id = elementId.slice("text.".length);
    const tl = proj.text_layers.find((t) => t.id === id);
    if (tl) tl.name = name;
  };
  const setBlock = (
    proj: Composition,
    elementId: string,
    block: { start: number; duration: number },
  ) => {
    const id = elementId.slice("text.".length);
    const tl = proj.text_layers.find((t) => t.id === id);
    if (tl) tl.block = block;
  };
  const setCaptionSource = (
    proj: Composition,
    elementId: string,
    source: {
      clip_element_id: string;
      source_start_frame: number;
      source_end_frame: number;
    },
  ) => {
    const id = elementId.slice("text.".length);
    const tl = proj.text_layers.find((t) => t.id === id);
    if (tl) tl.caption_source = source;
  };

  if (mode === "static") {
    const out = addTextLayer(cur, {
      ...baseTextArgs,
      text: lines.map((l) => l.text).join("\n"),
    });
    if (!out.result.ok) return out;
    cur = out.project;
    const elementId = (out.result.data as { elementId: string }).elementId;
    setName(cur, elementId, CAPTION_LAYER_NAME);
    created.push(elementId);
  } else {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const out = addTextLayer(cur, { ...baseTextArgs, text: line.text });
      if (!out.result.ok) return out;
      cur = out.project;
      const elementId = (out.result.data as { elementId: string }).elementId;
      setName(cur, elementId, `${CAPTION_LAYER_NAME} ${i + 1}`);
      created.push(elementId);
      if (line.clipElementId) {
        // Welded to a clip: store the line's window in the clip's SOURCE
        // timeline (line.startFrame/endFrame ARE source frames — Whisper word
        // timings). Its on-timeline window is derived live from the clip's trim
        // (deriveCaptionWindow), so no fixed block is written.
        setCaptionSource(cur, elementId, {
          clip_element_id: line.clipElementId,
          source_start_frame: line.startFrame,
          source_end_frame: Math.max(line.startFrame + 1, line.endFrame),
        });
      } else {
        // Standalone: the line's on-timeline window is a BLOCK — it exists only
        // during [startFrame, endFrame). No opacity envelope — the block IS the
        // visibility, so a 40-line track is 40 blocks, not 120 hold keyframes.
        setBlock(cur, elementId, {
          start: line.startFrame,
          duration: Math.max(1, line.endFrame - line.startFrame),
        });
      }
    }
  }

  // Always wrap the caption layers in a "captions" group so a track never
  // clutters the layers list — the user collapses one group instead of wading
  // through every line. The layers were all just created at root, so they share
  // a parent (the group_layers same-parent invariant holds). buildCaptionsForClip
  // consumes the returned groupElementId rather than grouping a second time.
  let groupElementId: string | undefined;
  const grouped = groupLayers(cur, {
    elementIds: created,
    name: CAPTIONS_GROUP_NAME,
  });
  if (grouped.result.ok) {
    cur = grouped.project;
    groupElementId = (grouped.result.data as { elementId: string }).elementId;
  }

  return {
    project: cur,
    result: {
      ok: true,
      data: { elementIds: created, count: created.length, mode, groupElementId },
    },
  };
};

// ---------------------------------------------------------------------------
// split_caption_line / merge_caption_lines
// ---------------------------------------------------------------------------

// Divide caption text at the word gap nearest the time-proportional split
// point. A single word (no interior whitespace) stays on the LEFT half and the
// right half starts empty — the caller notes it so the user edits the new
// line (the UI selects the right half, so it's immediately typeable).
const splitCaptionText = (
  text: string,
  frac: number,
): { left: string; right: string } => {
  const target = Math.round(text.length * Math.min(1, Math.max(0, frac)));
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i])) continue;
    const dist = Math.abs(i - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best === -1) return { left: text.trimEnd(), right: "" };
  return { left: text.slice(0, best).trimEnd(), right: text.slice(best + 1).trimStart() };
};

type SplitCaptionLineArgs = { elementId?: unknown; atFrame?: unknown };

// Split one caption line into two at a COMPOSITION frame (the playhead, in
// the editor's gesture). The right half is a full clone of the line — style,
// band geometry, name — so the split is invisible except for the boundary;
// the text divides at the word gap nearest the split point. A welded line
// converts the frame into the clip's SOURCE timeline (the same math as
// set_layer_block's caption branch) so BOTH halves stay welded; a standalone
// (block) line splits its block. The new layer registers next to the original
// (captions-group children, or layer_order for an ungrouped line).
const splitCaptionLine: ToolDispatch<SplitCaptionLineArgs> = (project, args) => {
  const { elementId, atFrame } = args;
  if (typeof elementId !== "string" || !elementId.startsWith("text.")) {
    return {
      project,
      result: { ok: false, error: `elementId must be a "text.<id>": ${String(elementId)}` },
    };
  }
  if (typeof atFrame !== "number" || !Number.isFinite(atFrame)) {
    return { project, result: { ok: false, error: "atFrame must be a finite number" } };
  }
  const next = cloneProject(project);
  const bare = elementId.slice("text.".length);
  const tl = next.text_layers.find((t) => t.id === bare);
  if (!tl) {
    return { project, result: { ok: false, error: `text layer not found: ${elementId}` } };
  }
  if (!isCaptionLineElement(next, `text.${tl.id}`)) {
    return {
      project,
      result: {
        ok: false,
        error: `${elementId} is not a caption line (no caption_source and not in a "captions" group)`,
      },
    };
  }
  const win = blockOf(next, elementId);
  if (!Number.isFinite(win.duration) || win.duration <= 1) {
    return {
      project,
      result: { ok: false, error: `line is too short to split (window ${win.duration} frames)` },
    };
  }
  const frame = Math.round(atFrame);
  if (!(frame > win.start && frame < win.start + win.duration)) {
    return {
      project,
      result: {
        ok: false,
        error: `atFrame ${frame} must be strictly inside the line's window [${win.start}, ${win.start + win.duration})`,
      },
    };
  }

  const rightBare = generateLayerId(next, "text");
  const clone = structuredClone(tl);
  clone.id = rightBare;
  const { left: leftText, right: rightText } = splitCaptionText(
    tl.text ?? "",
    (frame - win.start) / win.duration,
  );
  tl.text = leftText;
  clone.text = rightText;

  if (tl.caption_source) {
    const cs = tl.caption_source;
    const clipBare = cs.clip_element_id.startsWith("video.")
      ? cs.clip_element_id.slice("video.".length)
      : cs.clip_element_id;
    const clip = next.video_layers.find((v) => v.id === clipBare);
    if (!clip) {
      return {
        project,
        result: { ok: false, error: `welded clip not found: ${cs.clip_element_id}` },
      };
    }
    // COMP frame → the clip's SOURCE timeline, same conversion as
    // set_layer_block's caption branch — both halves stay welded.
    const sourceSplit = clipSourceFrameFromComp(clip, frame);
    tl.caption_source = { ...cs, source_end_frame: sourceSplit };
    clone.caption_source = { ...cs, source_start_frame: sourceSplit };
  } else {
    tl.block = { start: win.start, duration: frame - win.start };
    clone.block = { start: frame, duration: win.start + win.duration - frame };
  }

  // Register the right half NEXT TO the original: inside the same captions
  // group when grouped, else in layer_order (any leaf-creating root op must
  // register there — unlisted ids float to the top of the z-stack).
  const idx = next.text_layers.findIndex((t) => t.id === bare);
  next.text_layers.splice(idx + 1, 0, clone);
  const rightEid = `text.${rightBare}`;
  const parentGid = findParentGroup(next, elementId);
  if (parentGid) {
    const g = next.groups.find((x) => x.id === parentGid)!;
    const at = g.children.indexOf(elementId);
    g.children.splice(at + 1, 0, rightEid);
  } else {
    materializeRootLayerOrder(next);
    const at = next.layer_order.indexOf(elementId);
    next.layer_order.splice(at >= 0 ? at + 1 : next.layer_order.length, 0, rightEid);
  }

  return {
    project: next,
    result: {
      ok: true,
      data: {
        left: elementId,
        right: rightEid,
        splitFrame: frame,
        ...(rightText.length === 0
          ? { note: "single-word line: the right half's text is empty — set it with set_layer_text" }
          : null),
      },
    },
  };
};

type MergeCaptionLinesArgs = { elementIds?: unknown };

// Merge two or more caption lines into one. The earliest line survives with
// the union window and the time-ordered texts joined by spaces; the others
// are removed (text_layers + group children + layer_order). All lines must be
// the same flavour — every one welded to the SAME clip, or every one a
// standalone block line — and no OTHER caption line on that track may sit
// inside the merged span (it would end up buried under the merged window).
const mergeCaptionLines: ToolDispatch<MergeCaptionLinesArgs> = (project, args) => {
  const { elementIds } = args;
  if (
    !Array.isArray(elementIds) ||
    elementIds.length < 2 ||
    !elementIds.every((x) => typeof x === "string" && x.startsWith("text."))
  ) {
    return {
      project,
      result: { ok: false, error: 'elementIds must be ≥2 "text.<id>" strings' },
    };
  }
  const ids = [...new Set(elementIds as string[])];
  if (ids.length < 2) {
    return { project, result: { ok: false, error: "elementIds must name ≥2 distinct lines" } };
  }
  const next = cloneProject(project);
  const layers: TextLayer[] = [];
  for (const eid of ids) {
    const tl = next.text_layers.find((t) => t.id === eid.slice("text.".length));
    if (!tl) {
      return { project, result: { ok: false, error: `text layer not found: ${eid}` } };
    }
    if (!isCaptionLineElement(next, `text.${tl.id}`)) {
      return { project, result: { ok: false, error: `${eid} is not a caption line` } };
    }
    layers.push(tl);
  }
  const weldClips = new Set(layers.map((t) => t.caption_source?.clip_element_id ?? null));
  if (weldClips.size > 1) {
    return {
      project,
      result: {
        ok: false,
        error: "lines must share one flavour: all welded to the SAME clip, or all standalone",
      },
    };
  }

  // Time-order by the on-timeline window; the earliest layer survives.
  const withWin = layers
    .map((tl) => ({ tl, win: blockOf(next, `text.${tl.id}`) }))
    .sort((a, b) => a.win.start - b.win.start);
  const spanStart = withWin[0].win.start;
  const spanEnd = Math.max(...withWin.map((w) => w.win.start + w.win.duration));
  const mergedIds = new Set(layers.map((t) => t.id));

  // No bystander caption line inside the merged span.
  for (const other of next.text_layers) {
    if (mergedIds.has(other.id) || !isCaptionLineElement(next, `text.${other.id}`)) continue;
    const sameTrack =
      (weldClips.values().next().value ?? null) !== null
        ? other.caption_source?.clip_element_id === weldClips.values().next().value
        : findParentGroup(next, `text.${other.id}`) ===
          findParentGroup(next, `text.${withWin[0].tl.id}`);
    if (!sameTrack) continue;
    const w = blockOf(next, `text.${other.id}`);
    if (w.duration > 0 && w.start < spanEnd && w.start + w.duration > spanStart) {
      return {
        project,
        result: {
          ok: false,
          error: `another line ("${(other.text ?? "").slice(0, 24)}") sits inside the merged span — merge it too or move it first`,
        },
      };
    }
  }

  const keep = withWin[0].tl;
  keep.text = withWin
    .map((w) => (w.tl.text ?? "").trim())
    .filter((t) => t.length > 0)
    .join(" ");
  if (keep.caption_source) {
    keep.caption_source = {
      ...keep.caption_source,
      source_start_frame: Math.min(
        ...withWin.map((w) => w.tl.caption_source!.source_start_frame),
      ),
      source_end_frame: Math.max(
        ...withWin.map((w) => w.tl.caption_source!.source_end_frame),
      ),
    };
  } else {
    keep.block = { start: spanStart, duration: Math.max(1, spanEnd - spanStart) };
  }

  const doomedEids = new Set(
    withWin.slice(1).map((w) => `text.${w.tl.id}`),
  );
  next.text_layers = next.text_layers.filter((t) => !doomedEids.has(`text.${t.id}`));
  next.layer_order = (next.layer_order ?? []).filter((x) => !doomedEids.has(x));
  for (const g of next.groups) {
    g.children = g.children.filter((x) => !doomedEids.has(x));
  }

  return {
    project: next,
    result: {
      ok: true,
      data: {
        elementId: `text.${keep.id}`,
        removed: [...doomedEids],
        text: keep.text,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// rename_layer
// ---------------------------------------------------------------------------
//
// Sets (or clears) the human-readable `name` of a video / image / shape layer
// — the label shown in the Inspector and the basis for the layer's auto-
// derived <morpha-video> embed attribute. Symmetric with rename_group.
// An empty name clears it (callers fall back to the filename stem).

type RenameLayerArgs = { elementId?: unknown; name?: unknown };

const renameLayer: ToolDispatch<RenameLayerArgs> = (project, args) => {
  const { elementId, name } = args;
  if (typeof elementId !== "string") {
    return { project, result: { ok: false, error: "elementId is required" } };
  }
  if (typeof name !== "string") {
    return { project, result: { ok: false, error: "name must be a string" } };
  }
  const next = cloneProject(project);
  const apply = (layer: { name?: string }): ToolOutcome => {
    if (name.trim().length === 0) delete layer.name;
    else layer.name = name;
    return { project: next, result: { ok: true, data: { elementId, name } } };
  };
  if (elementId.startsWith("image.")) {
    const l = next.image_layers.find((x) => x.id === elementId.slice(6));
    if (!l) {
      return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
    }
    return apply(l);
  }
  if (elementId.startsWith("video.")) {
    const l = next.video_layers.find((x) => x.id === elementId.slice(6));
    if (!l) {
      return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
    }
    return apply(l);
  }
  if (elementId.startsWith("shapes.")) {
    const l = next.shapes.find((x) => x.id === elementId.slice(7));
    if (!l) {
      return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
    }
    return apply(l);
  }
  if (elementId.startsWith("text.")) {
    const l = next.text_layers.find((x) => x.id === elementId.slice(5));
    if (!l) {
      return { project, result: { ok: false, error: `layer not found: ${elementId}` } };
    }
    return apply(l);
  }
  return {
    project,
    result: {
      ok: false,
      error:
        "elementId must be a video / image / shape / text layer — use rename_group for groups",
    },
  };
};

// ---------------------------------------------------------------------------
// set_loop
// ---------------------------------------------------------------------------
//
// Builds the project's loop section as one pass per value. Each pass carries a
// single override that sets `field` of `elementId` to that pass's value, so
// the whole composition repeats once per value with that one field varying —
// the common case being a caption text layer cycling through several strings.
// `values: []` clears the loop (the comp plays once).

type SetLoopArgs = {
  elementId?: unknown;
  field?: unknown;
  values?: unknown;
};

const setLoop: ToolDispatch<SetLoopArgs> = (project, args) => {
  const { elementId, field, values } = args;
  if (typeof elementId !== "string" || elementId.trim().length === 0) {
    return {
      project,
      result: { ok: false, error: "elementId is required" },
    };
  }
  if (!Array.isArray(values)) {
    return {
      project,
      result: { ok: false, error: "values must be an array of strings" },
    };
  }
  if (!values.every((v) => typeof v === "string")) {
    return {
      project,
      result: { ok: false, error: "values must be an array of strings" },
    };
  }
  const resolvedField =
    typeof field === "string" && field.trim().length > 0 ? field : "text";
  const loop: LoopPass[] = (values as string[]).map((value) => ({
    overrides: [{ elementId, field: resolvedField, value }],
  }));
  const next = cloneProject(project);
  next.loop = loop;
  return {
    project: next,
    result: { ok: true, data: { loop } },
  };
};

// ---------------------------------------------------------------------------
// set_canvas_size
// ---------------------------------------------------------------------------
//
// Resize ONE page's canvas with a "fit + recenter" reflow: that page is scaled
// by a SINGLE uniform factor s = min(newW/oldW, newH/oldH) — so nothing
// distorts (a circle stays a circle) — then recentred so the old composition
// centre maps to the new canvas centre. On a same-aspect resize the recentre
// term cancels and this reduces to a plain uniform scale. Mirrors the editor's
// CanvasSizePicker behaviour — both the editor store and this tool call
// reflowPage.

// Reflow page `index` into a new canvas size: its layers are fit-scaled and
// recentred from the old canvas to the new one (via the shared
// reflowCompositionLayers), then the page's dims are stamped. Pure: clones,
// never mutates the input. Sibling pages keep their own sizes — a resize is a
// per-page operation.
export const reflowPage = (
  project: Project,
  index: number,
  newW: number,
  newH: number,
): Project => {
  const next = cloneProject(project);
  const page = next.pages[index];
  if (!page) {
    throw new Error(
      `reflowPage: no page at index ${index} (project has ${next.pages.length})`,
    );
  }
  reflowCompositionLayers(page, page.canvas_width, page.canvas_height, newW, newH);
  page.canvas_width = newW;
  page.canvas_height = newH;
  return next;
};

type SetCanvasSizeArgs = { width?: unknown; height?: unknown };

// Resizes the ACTIVE page only, like every other content tool — use
// select_page to point it at a different one.
const setCanvasSize: ProjectToolDispatch<SetCanvasSizeArgs> = (
  project,
  args,
) => {
  const { width, height } = args;
  const validDim = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n > 0;
  if (!validDim(width) || !validDim(height)) {
    return {
      project,
      result: {
        ok: false,
        error: "width and height must be positive integers (pixels)",
      },
    };
  }
  const index = clampActiveIndex(project);
  const page = project.pages[index];
  if (page.canvas_width === width && page.canvas_height === height) {
    return {
      project,
      result: {
        ok: true,
        data: { canvas_width: width, canvas_height: height },
      },
    };
  }
  const next = reflowPage(project, index, width, height);
  return {
    project: next,
    result: { ok: true, data: { canvas_width: width, canvas_height: height } },
  };
};

// ---------------------------------------------------------------------------
// set_video_clip
// ---------------------------------------------------------------------------
//
// Repoint an existing video layer at a different uploaded clip, keeping its
// id, position, size, animations, styles, and trim window — only the source
// mp4 changes. The clip must already exist at users/<userId>/clips/<projectId>/
// <clip> (same precondition as add_video_layer); this dispatcher does not
// verify it.

type SetVideoClipArgs = { elementId?: unknown; clip?: unknown };

const setVideoClip: ToolDispatch<SetVideoClipArgs> = (project, args) => {
  const { elementId, clip } = args;
  if (typeof elementId !== "string" || !elementId.startsWith("video.")) {
    return {
      project,
      result: {
        ok: false,
        error: "elementId must be a video layer id (video.<id>)",
      },
    };
  }
  if (typeof clip !== "string" || clip.trim().length === 0) {
    return {
      project,
      result: { ok: false, error: "clip must be a non-empty string" },
    };
  }
  const id = elementId.slice("video.".length);
  const next = cloneProject(project);
  const layer = next.video_layers.find((l) => l.id === id);
  if (!layer) {
    return {
      project,
      result: { ok: false, error: `video layer not found: ${elementId}` },
    };
  }
  layer.clip = clip;
  return { project: next, result: { ok: true, data: { elementId, clip } } };
};

// ---------------------------------------------------------------------------
// set_video_layer_muted
// ---------------------------------------------------------------------------
//
// Silence (or unmute) a video layer's baked audio in preview AND export. The
// audio-split processing step sets this true after demuxing the clip's audio
// into a standalone overlay (NLE-style linked A/V), so the source audio doesn't
// double with the new track.
type SetVideoLayerMutedArgs = { elementId?: unknown; muted?: unknown };

const setVideoLayerMuted: ToolDispatch<SetVideoLayerMutedArgs> = (project, args) => {
  const { elementId, muted } = args;
  if (typeof elementId !== "string" || !elementId.startsWith("video.")) {
    return {
      project,
      result: {
        ok: false,
        error: "elementId must be a video layer id (video.<id>)",
      },
    };
  }
  if (typeof muted !== "boolean") {
    return {
      project,
      result: { ok: false, error: "muted must be a boolean (true to mute, false to unmute)" },
    };
  }
  const id = elementId.slice("video.".length);
  const next = cloneProject(project);
  const layer = next.video_layers.find((l) => l.id === id);
  if (!layer) {
    return {
      project,
      result: { ok: false, error: `video layer not found: ${elementId}` },
    };
  }
  layer.muted = muted;
  return { project: next, result: { ok: true, data: { elementId, muted } } };
};

// ---------------------------------------------------------------------------
// set_image_filename
// ---------------------------------------------------------------------------
//
// Repoint an existing image layer at a different uploaded asset, keeping its
// id, position, size, animations, and styles — only the bitmap changes. The
// asset must already exist at users/<userId>/assets/<projectId>/<filename>
// (same precondition as add_image_layer); this dispatcher does not verify it.

type SetImageFilenameArgs = { elementId?: unknown; filename?: unknown };

const setImageFilename: ToolDispatch<SetImageFilenameArgs> = (project, args) => {
  const { elementId, filename } = args;
  if (typeof elementId !== "string" || !elementId.startsWith("image.")) {
    return {
      project,
      result: {
        ok: false,
        error: "elementId must be an image layer id (image.<id>)",
      },
    };
  }
  if (typeof filename !== "string" || filename.trim().length === 0) {
    return {
      project,
      result: { ok: false, error: "filename must be a non-empty string" },
    };
  }
  const id = elementId.slice("image.".length);
  const next = cloneProject(project);
  const layer = next.image_layers.find((l) => l.id === id);
  if (!layer) {
    return {
      project,
      result: { ok: false, error: `image layer not found: ${elementId}` },
    };
  }
  if (layer.is_background) {
    return {
      project,
      result: {
        ok: false,
        error: "the canvas backdrop has no bitmap — use set_layer_fill",
      },
    };
  }
  layer.filename = filename;
  return { project: next, result: { ok: true, data: { elementId, filename } } };
};

// ---------------------------------------------------------------------------
// add_page / delete_page / reorder_pages / select_page
// ---------------------------------------------------------------------------
//
// Page management on the pages-only project. Every project has ≥1 page, so
// these operate on project.pages + project.active_index directly — no carousel
// record, no "carousel mode" gate. A single-page "video" is just a 1-page
// project; add_page turns it into a multi-page one.

// Append a page. With duplicate_index, deep-clones that page (minting a fresh
// id); otherwise appends a blank page sized to the project canvas. Sets
// active_index to the new page and returns its index.
type AddPageArgs = { name?: unknown; duplicate_index?: unknown };

const addPage: ProjectToolDispatch<AddPageArgs> = (project, args) => {
  const { name, duplicate_index } = args;
  if (name !== undefined && typeof name !== "string") {
    return {
      project,
      result: { ok: false, error: "name must be a string" },
    };
  }
  const pages = project.pages;
  let page: PageComposition;
  if (duplicate_index !== undefined) {
    if (
      typeof duplicate_index !== "number" ||
      !Number.isInteger(duplicate_index) ||
      duplicate_index < 0 ||
      duplicate_index >= pages.length
    ) {
      return {
        project,
        result: {
          ok: false,
          error: `duplicate_index must be an integer in [0, ${pages.length - 1}]`,
        },
      };
    }
    page = structuredClone(pages[duplicate_index]) as PageComposition;
    page.id = crypto.randomUUID();
    if (name !== undefined) page.name = name;
  } else {
    // A new page inherits the ACTIVE page's canvas — pages stay uniform until
    // the user deliberately resizes one.
    const from = pages[clampActiveIndex(project)];
    page = blankPage(from.canvas_width, from.canvas_height, name);
  }
  const next = cloneProject(project);
  next.pages.push(page);
  const index = next.pages.length - 1;
  next.active_index = index;
  return {
    project: next,
    result: { ok: true, data: { index, page_count: next.pages.length } },
  };
};

// Remove a page. Refuses to drop below 1 page. The active page is tracked by id
// across the splice — deleting a page before it must not silently retarget
// active_index at a different page. Only when the active page itself is deleted
// does active_index fall to the page that slid into its position (or the new
// last page).
type DeletePageArgs = { index?: unknown };

const deletePage: ProjectToolDispatch<DeletePageArgs> = (project, args) => {
  const { index } = args;
  const pages = project.pages;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= pages.length
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `index must be an integer in [0, ${pages.length - 1}]`,
      },
    };
  }
  if (pages.length <= 1) {
    return {
      project,
      result: { ok: false, error: "a project must keep at least 1 page" },
    };
  }
  const next = cloneProject(project);
  const activePageId = next.pages[clampActiveIndex(next)]?.id;
  next.pages.splice(index, 1);
  const survivingIndex = next.pages.findIndex((p) => p.id === activePageId);
  next.active_index =
    survivingIndex >= 0
      ? survivingIndex
      : Math.min(index, next.pages.length - 1);
  return {
    project: next,
    result: {
      ok: true,
      data: {
        index,
        active_index: next.active_index,
        page_count: next.pages.length,
      },
    },
  };
};

// Move a page from one position to another. active_index is rewritten so it
// keeps pointing at the same page it did before the move.
type ReorderPagesArgs = { from_index?: unknown; to_index?: unknown };

const reorderPages: ProjectToolDispatch<ReorderPagesArgs> = (project, args) => {
  const { from_index, to_index } = args;
  const pages = project.pages;
  const validIndex = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n < pages.length;
  if (!validIndex(from_index) || !validIndex(to_index)) {
    return {
      project,
      result: {
        ok: false,
        error: `from_index and to_index must be integers in [0, ${pages.length - 1}]`,
      },
    };
  }
  const next = cloneProject(project);
  const activeId = next.pages[clampActiveIndex(next)].id;
  const [moved] = next.pages.splice(from_index, 1);
  next.pages.splice(to_index, 0, moved);
  next.active_index = next.pages.findIndex((p) => p.id === activeId);
  return {
    project: next,
    result: {
      ok: true,
      data: { from_index, to_index, active_index: next.active_index },
    },
  };
};

// ---------------------------------------------------------------------------
// select_page
// ---------------------------------------------------------------------------
//
// Switch which page is ACTIVE — the page every content tool (and describe_video
// / inspect_layers) reads and writes through dispatchOnProject. add_page
// activates the page it creates; this is the deliberate way to move the cursor,
// and the only way BACK to an earlier page. Re-selecting the active page is a
// harmless success. Persisted so headless callers can move between pages.
type SelectPageArgs = { index?: unknown };

const selectPage: ProjectToolDispatch<SelectPageArgs> = (project, args) => {
  const { index } = args;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= project.pages.length
  ) {
    return {
      project,
      result: {
        ok: false,
        error: `index must be an integer in [0, ${project.pages.length - 1}]`,
      },
    };
  }
  const next = cloneProject(project);
  next.active_index = index;
  return {
    project: next,
    result: {
      ok: true,
      data: {
        index,
        page_count: next.pages.length,
        name: next.pages[index].name ?? null,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Catalog + dispatch table
// ---------------------------------------------------------------------------

export const dispatch: Record<string, ToolDispatch<never>> = {
  describe_video: describeVideo as ToolDispatch<never>,
  inspect_layers: inspectLayers as ToolDispatch<never>,
  move_layer: moveLayer as ToolDispatch<never>,
  set_pivot: setPivot as ToolDispatch<never>,
  add_keyframe: addKeyframe as ToolDispatch<never>,
  add_keyframes: addKeyframes as ToolDispatch<never>,
  set_keyframes_batch: setKeyframesBatch as ToolDispatch<never>,
  remove_keyframe: removeKeyframe as ToolDispatch<never>,
  shift_track: shiftTrack as ToolDispatch<never>,
  set_track_loop: setTrackLoop as ToolDispatch<never>,
  add_image_layer: addImageLayer as ToolDispatch<never>,
  add_video_layer: addVideoLayer as ToolDispatch<never>,
  add_shape: addShape as ToolDispatch<never>,
  add_curve: addCurve as ToolDispatch<never>,
  duplicate_layer: duplicateLayer as ToolDispatch<never>,
  remove_layer: removeLayer as ToolDispatch<never>,
  reorder_layer: reorderLayer as ToolDispatch<never>,
  set_style: setStyle as ToolDispatch<never>,
  set_layer_fill: setLayerFill as ToolDispatch<never>,
  set_text_background: setTextBackground as ToolDispatch<never>,
  set_group_box: setGroupBox as ToolDispatch<never>,
  add_color_keyframe: addColorKeyframe as ToolDispatch<never>,
  remove_color_keyframe: removeColorKeyframe as ToolDispatch<never>,
  fade_layer: fadeLayer as ToolDispatch<never>,
  set_layer_visible: setLayerVisible as ToolDispatch<never>,
  apply_preset: applyPreset as ToolDispatch<never>,
  apply_preset_stagger: applyPresetStagger as ToolDispatch<never>,
  group_layers: groupLayers as ToolDispatch<never>,
  ungroup_layers: ungroupLayers as ToolDispatch<never>,
  set_group_parent: setGroupParent as ToolDispatch<never>,
  rename_group: renameGroup as ToolDispatch<never>,
  add_to_collection: addToCollection as ToolDispatch<never>,
  remove_from_collection: removeFromCollection as ToolDispatch<never>,
  add_morpha_layer: addMorphaLayer as ToolDispatch<never>,
  add_audio_overlay: addAudioOverlay as ToolDispatch<never>,
  remove_audio_overlay: removeAudioOverlay as ToolDispatch<never>,
  update_audio_overlay: updateAudioOverlay as ToolDispatch<never>,
  set_video_layer_trim: setVideoLayerTrim as ToolDispatch<never>,
  set_layer_block: setLayerBlock as ToolDispatch<never>,
  set_layer_transition: setLayerTransition as ToolDispatch<never>,
  move_band: moveBand as ToolDispatch<never>,
  shift_group: shiftGroup as ToolDispatch<never>,
  set_group_window: setGroupWindow as ToolDispatch<never>,
  set_duration: setDuration as ToolDispatch<never>,
  fit_duration_to_content: fitDurationToContent as ToolDispatch<never>,
  cut_range: cutRange as ToolDispatch<never>,
  set_embed_origins: setEmbedOrigins as ToolDispatch<never>,
  add_embed_origin: addEmbedOrigin as ToolDispatch<never>,
  remove_embed_origin: removeEmbedOrigin as ToolDispatch<never>,
  set_custom_font: setCustomFont as ToolDispatch<never>,
  list_fonts: listFonts as ToolDispatch<never>,
  set_layer_text: setLayerText as ToolDispatch<never>,
  add_text_layer: addTextLayer as ToolDispatch<never>,
  add_caption_track: addCaptionTrack as ToolDispatch<never>,
  split_caption_line: splitCaptionLine as ToolDispatch<never>,
  merge_caption_lines: mergeCaptionLines as ToolDispatch<never>,
  rename_layer: renameLayer as ToolDispatch<never>,
  set_loop: setLoop as ToolDispatch<never>,
  set_image_filename: setImageFilename as ToolDispatch<never>,
  set_video_clip: setVideoClip as ToolDispatch<never>,
  set_video_layer_muted: setVideoLayerMuted as ToolDispatch<never>,
  set_matte_source: setMatteSource as ToolDispatch<never>,
  set_clip_speed: setClipSpeed as ToolDispatch<never>,
  freeze_frame: freezeFrame as ToolDispatch<never>,
  add_speed_keyframe: addSpeedKeyframe as ToolDispatch<never>,
  remove_speed_keyframe: removeSpeedKeyframe as ToolDispatch<never>,
};

// Project-scoped tools operate on the whole pages-only Project (the page list +
// active cursor + every-page resize), not a single composition. Kept in a
// separate table so dispatchOnProject can route them to the record directly
// while content tools run against the active page's projection.
export const projectDispatch: Record<string, ProjectToolDispatch<never>> = {
  set_canvas_size: setCanvasSize as ProjectToolDispatch<never>,
  add_page: addPage as ProjectToolDispatch<never>,
  delete_page: deletePage as ProjectToolDispatch<never>,
  reorder_pages: reorderPages as ProjectToolDispatch<never>,
  select_page: selectPage as ProjectToolDispatch<never>,
};

// True when `name` resolves through dispatchOnProject — a project-scoped tool
// (projectDispatch) or a page-composition tool (dispatch). Transport
// reachability guards must use this, never `dispatch` alone: checking only the
// page-level table 404s the project-scoped tools as "unknown tool".
export const isPureToolName = (name: string): boolean =>
  Boolean(projectDispatch[name] ?? dispatch[name]);

// ---------------------------------------------------------------------------
// Page-aware dispatch
// ---------------------------------------------------------------------------
//
// Every project is pages-only, and content tools edit ONE page — the active
// one. `dispatchOnProject` is the entry point headless surfaces (HTTP
// /api/tool, MCP — both via the worker's dispatchPureTool) and the SDK route
// through: project-scoped tools run on the whole project; every content tool
// runs against a projection of the ACTIVE page (compositionForPage) and folds
// back via writeCompositionBack. describe_video carries a `pages` overview so
// an agent learns multi-page projects have more than one page.

export interface PagesOverview {
  page_count: number;
  active_index: number;
  pages: Array<{
    index: number;
    name: string | null;
    has_video: boolean;
    canvas_width: number;
    canvas_height: number;
  }>;
  note: string;
}

// The agent-facing summary of a project's pages, attached to describe_video's
// data. Pages are addressed by INDEX — page ids are internal storage keys,
// never surfaced. Each page carries its own canvas dims, so they're listed here
// too: an agent that resizes one page must not assume the others followed.
// Omitted for single-page projects (a plain "video").
export const pagesOverview = (project: Project): PagesOverview => ({
  page_count: project.pages.length,
  active_index: clampActiveIndex(project),
  pages: project.pages.map((p, index) => ({
    index,
    name: p.name ?? null,
    has_video: p.video_layers.length > 0,
    canvas_width: p.canvas_width,
    canvas_height: p.canvas_height,
  })),
  note:
    "This project has multiple pages, each with its OWN canvas size. Content tools (layers, keyframes, fills, …) target the ACTIVE page (active_index); use select_page to move between pages, add_page / delete_page / reorder_pages to manage them, and set_canvas_size to resize the active page (siblings keep their size).",
});

// Route one tool call against a pages-only project. Project-scoped tools
// (pages, resize) run on the whole project. Every content tool runs on the
// ACTIVE page's Composition and, when it mutates, folds back via
// writeCompositionBack. describe_video on a multi-page project additionally
// carries the pagesOverview block.
export const dispatchOnProject = (
  project: Project,
  name: string,
  args: Record<string, unknown>,
): ProjectToolOutcome => {
  const projFn = projectDispatch[name] as
    | ProjectToolDispatch<Record<string, unknown>>
    | undefined;
  if (projFn) return projFn(project, args);

  const fn = dispatch[name] as ToolDispatch<Record<string, unknown>> | undefined;
  if (!fn) {
    return { project, result: { ok: false, error: `unknown tool: ${name}` } };
  }
  const index = clampActiveIndex(project);
  const projection = compositionForPage(project, index);
  const { project: edited, result } = fn(projection, args);
  if (name === "describe_video" && result.ok && project.pages.length > 1) {
    const data = result.data as Record<string, unknown>;
    return {
      project,
      result: { ok: true, data: { ...data, pages: pagesOverview(project) } },
    };
  }
  if (!result.ok || edited === projection) return { project, result };
  return { project: writeCompositionBack(project, index, edited), result };
};

// Tools that can repoint a layer at DIFFERENT BYTES — the one edit class where
// the previous state cannot be reconstructed from the project alone, because the
// old asset only exists as a filename the document no longer mentions.
//
// The editor checkpoints a version before any of these run (see
// `checkpointBeforeSourceSwap` in editor/src/store.ts). Listed here, in the pure
// layer, so the store, the prompt-panel adapter and the call-site budget test
// read ONE list rather than three that drift.
//
// `update_audio_overlay` is a general-purpose tool — gain, fades, trim — that
// only sometimes carries a filename. Membership means "can swap a source", not
// "always does", so callers must also check that the args actually change the
// source field: `toolCallSwapsSource(name, args, project)` below.
export const SOURCE_SWAP_TOOLS = [
  "set_image_filename",
  "set_video_clip",
  "update_audio_overlay",
] as const;

const SOURCE_SWAP_TOOL_SET: ReadonlySet<string> = new Set(SOURCE_SWAP_TOOLS);

// Would dispatching this call actually point a layer at a different asset?
// False for a non-swap tool, for a swap tool whose args carry no source field,
// and for one that re-sets the source it already has (a no-op the dispatchers
// themselves early-return on) — so none of those mint a version.
export const toolCallSwapsSource = (
  name: string,
  args: Record<string, unknown>,
  project: Composition,
): boolean => {
  if (!SOURCE_SWAP_TOOL_SET.has(name)) return false;
  if (name === "set_image_filename") {
    const next = args.filename;
    if (typeof next !== "string") return false;
    const layer = project.image_layers.find(
      (l) => `image.${l.id}` === args.elementId,
    );
    return layer !== undefined && layer.filename !== next;
  }
  if (name === "set_video_clip") {
    const next = args.clip;
    if (typeof next !== "string") return false;
    const layer = project.video_layers.find(
      (v) => `video.${v.id}` === args.elementId,
    );
    return layer !== undefined && layer.clip !== next;
  }
  // update_audio_overlay
  const next = args.filename;
  if (typeof next !== "string") return false;
  const overlay = (project.audio_overlays ?? []).find((o) => o.id === args.id);
  return overlay !== undefined && overlay.filename !== next;
};

export const TOOL_DEFINITIONS: ToolFunction[] = [
  {
    type: "function",
    function: {
      name: "describe_video",
      description:
        "Structural OVERVIEW of the composition (the table of contents) — canvas size, duration, the backdrop summary, and a z-ordered tree (top of stack first) of every layer with its elementId, type, name, type label (filename/clip/text/kind), geometry (x/y/width/height), and which properties are animated. Does NOT include keyframe values or styles — those are unbounded. On a multi-page project the tree describes the ACTIVE page and the data carries a `pages` block ({ page_count, active_index, pages: [{ index, name, has_video }] }) — content tools target that active page; use select_page to switch which page they target, add_page / delete_page / reorder_pages to manage the pages. Start here, then call inspect_layers([elementId, …]) for full detail on the specific layers you'll change. Don't guess keyframe/style values from this overview.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_layers",
      description:
        "Full per-element drill-in — the 'open this layer' half of the browser. Returns each named element's COMPLETE record: all of its own fields plus its animation tracks (every keyframe), colour/fill tracks, track-loop (extrapolation) modes, and style. Pass the elementIds you read from describe_video; pull detail only for the handful of layers you're about to mutate, not the whole project.",
      parameters: {
        type: "object",
        properties: {
          elementIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Element ids to inspect (image.<id>, video.<id>, text.<id>, shapes.<id>, group.<id>). Read them from describe_video's tree.",
          },
        },
        required: ["elementIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_layer",
      description:
        "Set a layer's static base transform. Writes x/y/w/h/rotation directly on image.<id>, video.<id>, and shapes.<id>; for group.<id> sets pivotX/pivotY (no width/height/rotation — use add_keyframe for group rotation). Also sets `scale` and `opacity`, which every layer kind carries. Note: when a layer has a keyframe track for a property, the track OVERRIDES the static value at every frame — use add_keyframe to animate, move_layer to set the un-animated default. A scale/opacity write over an existing track is REFUSED for that reason; pass clear_animation:true to replace the animation with the static value.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "video.<id>, image.<id>, shapes.<id>, or group.<id>.",
          },
          x: {
            type: "number",
            description:
              "Centre x in the element's OWN frame. At root that is canvas coords (1080 wide); INSIDE A GROUP it is the group's space, so it is not where the layer sits on the canvas. inspect_layers reports both — write back the `x` it gave you, and read `canvas_x` for the on-canvas position.",
          },
          y: {
            type: "number",
            description:
              "Centre y in the element's OWN frame — canvas coords (1920 tall) at root, the group's space inside a group. See `x`.",
          },
          width: { type: "number", description: "Width in px (must be > 0)." },
          height: { type: "number", description: "Height in px (must be > 0)." },
          rotation: { type: "number", description: "Rotation in degrees, clockwise." },
          scale: {
            type: "number",
            description: "Uniform scale multiplier about the layer's pivot. 1 = natural size. Every layer kind carries it.",
          },
          opacity: {
            type: "number",
            description: "Layer opacity, 0..1 (values outside are allowed and clamp at paint time). Composes with any ancestor group's opacity.",
          },
          clear_animation: {
            type: "boolean",
            description: "Only meaningful when setting `scale` / `opacity` on a layer where that property is animated. true = the static value REPLACES the keyframe track. Omitted / false = the call is refused rather than writing a value the animation would hide.",
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_pivot",
      description:
        "Set the rotation / scale pivot anchor for an image, video, shape, or text leaf. Picks one of the 9 standard bbox anchors — corners, edge midpoints, or centre — so the layer rotates and scales around that point instead of its centre. The pivot is normalized to the bbox, so resizing the layer keeps the pivot anchored to the same corner / edge / centre. Static (not animated). For groups, use move_layer with x/y to set the group's absolute pivotX/pivotY instead.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "image.<id>, video.<id>, shapes.<id>, or text.<id>.",
          },
          anchor: {
            type: "string",
            enum: ["tl", "t", "tr", "l", "c", "r", "bl", "b", "br"],
            description:
              "Which of the 9 bbox anchors to pivot around. tl/t/tr = top row; l/c/r = middle row; bl/b/br = bottom row. c = centre (the default).",
          },
        },
        required: ["elementId", "anchor"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_keyframe",
      description:
        "Add or overwrite a keyframe on a layer's animation track. For leaves (image/video/shape), x/y/rotation keyframes are ABSOLUTE canvas-space values: x and y are the layer centre's pixel position (canvas is 1080×1920), rotation is degrees. For groups, x/y keyframes are translation offsets applied around the group's frozen pivot, and rotation is the group's absolute angle. scale orbits the layer/pivot centre (1 = no change). opacity is 0..1. 30 fps. When a keyframe track is present on a property, it OVERRIDES the layer's static base value at every frame.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "Layer id (video.<id>, image.<id>, shapes.<id>, or group.<id>)." },
          property: {
            type: "string",
            enum: ["x", "y", "width", "height", "scale", "rotation", "opacity", "curve"],
          },
          frame: {
            type: "number",
            description: "Frame number, 0-indexed. 30 fps so frame 30 = 1 second.",
          },
          value: { type: "number", description: "Track value at this frame." },
          easing: {
            type: "string",
            enum: VALID_EASINGS,
            description: "Interpolation to the next keyframe. Default linear.",
          },
        },
        required: ["elementId", "property", "frame", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_keyframes_batch",
      description:
        "Add or overwrite MANY keyframes across MANY layers in ONE call — functionally equivalent to N add_keyframe calls but with one HTTP/MCP round-trip. Pass an array of entries; each entry has the same fields as add_keyframe. Validated atomically: any invalid entry rejects the whole batch. Use this whenever you'd call add_keyframe more than a couple of times (rippling grids, twinkling starfields, staggered text reveals).",
      parameters: {
        type: "object",
        properties: {
          keyframes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                elementId: {
                  type: "string",
                  description:
                    "Layer id (video.<id>, image.<id>, shapes.<id>, text.<id>, or group.<id>).",
                },
                property: {
                  type: "string",
                  enum: ["x", "y", "width", "height", "scale", "rotation", "opacity", "curve"],
                },
                frame: {
                  type: "number",
                  description: "Frame number, 0-indexed (30 fps).",
                },
                value: { type: "number", description: "Track value at this frame." },
                easing: {
                  type: "string",
                  enum: VALID_EASINGS,
                  description: "Interpolation to the next keyframe. Default linear.",
                },
              },
              required: ["elementId", "property", "frame", "value"],
            },
            description: "One or more keyframe entries to apply.",
          },
        },
        required: ["keyframes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_keyframes",
      description:
        "Add many keyframes to ONE element's ONE property in a single call, with an optional loop mode applied in the same call. The idiomatic form when every layer in a multi-element animation gets its own track (ripple dot pulse, snowflake fall, equaliser-bar wave). Factors elementId + property out of the loop body and folds set_track_loop in. Use set_keyframes_batch instead when you need to mix elements/properties in one atomic call.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "Layer id (video.<id>, image.<id>, shapes.<id>, text.<id>, or group.<id>).",
          },
          property: {
            type: "string",
            enum: ["x", "y", "width", "height", "scale", "rotation", "opacity", "curve"],
          },
          keyframes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                frame: { type: "number", description: "Frame number, 0-indexed (30 fps)." },
                value: { type: "number", description: "Track value at this frame." },
                easing: {
                  type: "string",
                  enum: VALID_EASINGS,
                  description: "Interpolation to the next keyframe. Default linear.",
                },
              },
              required: ["frame", "value"],
            },
            description: "Keyframes for this track (one or more).",
          },
          loop: {
            type: "string",
            enum: VALID_LOOP_MODES,
            description:
              "Optional extrapolation mode applied to this track in the same call. Default 'hold'.",
          },
        },
        required: ["elementId", "property", "keyframes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_keyframe",
      description: "Remove the keyframe at frame N on a layer's track. Removing the last keyframe from a track restores the layer's static base value across the timeline.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          property: {
            type: "string",
            enum: ["x", "y", "width", "height", "scale", "rotation", "opacity", "curve"],
          },
          frame: { type: "number" },
        },
        required: ["elementId", "property", "frame"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shift_track",
      description:
        "Bulk-shift every keyframe's VALUE on one property of one layer by `delta`. Mirrors the 'select all keyframes + nudge layer' gesture in After Effects / Premiere / FCP — preserves the relative spacing of the animation but slides the whole curve. Keyframe TIMES are untouched. Use for 'move all x by -30px' on a complex animation, retiming a fade by adjusting its base opacity, rotating an existing wobble by 10°, etc.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          property: {
            type: "string",
            enum: ["x", "y", "width", "height", "scale", "rotation", "opacity", "curve"],
          },
          delta: {
            type: "number",
            description: "Added to every keyframe's value on this track. Negative shifts the curve down/left.",
          },
        },
        required: ["elementId", "property", "delta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_track_loop",
      description:
        "Set the extrapolation mode for one property's animation track. Modes: \"hold\" (default — holds the boundary keyframe's value past the ends), \"loop\" (wraps frames past the last keyframe back to the first, restarting the animation), \"ping-pong\" (alternates direction each cycle, bouncing back and forth), \"cycle\" (wraps like loop but each cycle adds the boundary delta — used for endless rotation or scrolling). Has no effect on tracks with fewer than 2 keyframes.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "Layer id (video/image/shape/group)." },
          property: {
            type: "string",
            enum: ["x", "y", "width", "height", "scale", "rotation", "opacity", "curve"],
          },
          mode: {
            type: "string",
            enum: ["hold", "loop", "ping-pong", "cycle"],
          },
        },
        required: ["elementId", "property", "mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_image_layer",
      description:
        "Add an image layer. The asset must already exist at users/<userId>/assets/<projectId>/<filename> (uploaded via the editor's drag-drop, or POST /api/upload-asset/<projectId> with the raw bytes and an X-Filename header). To duplicate an existing layer, reuse its filename — the editor auto-assigns a fresh id.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Asset filename in the project's assets bucket, e.g. star.png." },
          x: { type: "number", description: "Centre x in 1080-wide base coords." },
          y: { type: "number", description: "Centre y in 1920-tall base coords." },
          width: { type: "number", description: "Width in px (must be > 0)." },
          height: { type: "number", description: "Height in px (must be > 0)." },
          block: {
            type: "object",
            description:
              "OPTIONAL timeline window — {start, duration} in composition frames. OMIT IT (the default) and the layer is ALWAYS PRESENT: a persistent overlay that holds for the whole composition, which is what an agent-placed watermark / lower-third almost always wants. Pass it to place a bounded CLIP instead (what the editor's own add does: 5 s at the playhead). Keyframes on a blocked layer are sampled RELATIVE to `start`.",
            properties: {
              start: { type: "number", description: "First visible composition frame (≥ 0)." },
              duration: { type: "number", description: "Length of the window in frames (≥ 1)." },
            },
            required: ["start", "duration"],
          },
        },
        required: ["filename", "x", "y", "width", "height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_video_layer",
      description:
        "Add a video layer. The clip must already exist at users/<userId>/clips/<projectId>/<clip> (uploaded via /api/upload-clip). To duplicate an existing layer, reuse its clip filename — the editor auto-assigns a fresh id.",
      parameters: {
        type: "object",
        properties: {
          clip: { type: "string", description: "Clip filename in the project's clips bucket, e.g. demo.mp4." },
          x: { type: "number", description: "Centre x in 1080-wide base coords." },
          y: { type: "number", description: "Centre y in 1920-tall base coords." },
          width: { type: "number", description: "Width in px (must be > 0)." },
          height: { type: "number", description: "Height in px (must be > 0)." },
          name: { type: "string", description: "Optional friendly label shown in the Inspector + Timeline." },
        },
        required: ["clip", "x", "y", "width", "height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_shape",
      description: `Add a shape layer. \`kind\` selects the primitive: ${SHAPE_DEFS.map(
        (d) => d.id,
      ).join(
        " | ",
      )}. All are native vector shapes; never substitute an image layer for one. Default-positioned in canvas centre if x/y/w/h omitted.`,
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...SHAPE_IDS],
          },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          color: { type: "string", description: "Fill colour as #rrggbb." },
          block: {
            type: "object",
            description:
              "OPTIONAL timeline window — {start, duration} in composition frames. OMIT IT (the default) and the layer is ALWAYS PRESENT: a persistent overlay that holds for the whole composition, which is what an agent-placed watermark / lower-third almost always wants. Pass it to place a bounded CLIP instead (what the editor's own add does: 5 s at the playhead). Keyframes on a blocked layer are sampled RELATIVE to `start`.",
            properties: {
              start: { type: "number", description: "First visible composition frame (≥ 0)." },
              duration: { type: "number", description: "Length of the window in frames (≥ 1)." },
            },
            required: ["start", "duration"],
          },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_curve",
      description:
        "Draw an editable arrow / curved line — a stroked quadratic bezier with an arrowhead. Specify the two endpoints (x1,y1)→(x2,y2) in canvas pixels; `bend` pushes the midpoint perpendicular (px, 0 = straight line, positive/negative curves either way). `color` #rrggbb, `stroke_width` px, `arrow_head` none|end|both (default end). Use this for callout arrows (e.g. swooping into a link).",
      parameters: {
        type: "object",
        properties: {
          x1: { type: "number", description: "Start x (canvas px)." },
          y1: { type: "number", description: "Start y (canvas px)." },
          x2: { type: "number", description: "End x (canvas px) — the arrowhead end." },
          y2: { type: "number", description: "End y (canvas px)." },
          bend: {
            type: "number",
            description: "Perpendicular bow of the curve in px. 0 = straight.",
          },
          color: { type: "string", description: "Stroke colour as #rrggbb." },
          stroke_width: { type: "number", description: "Line thickness in px." },
          arrow_head: { type: "string", enum: ["none", "end", "both"] },
        },
        required: ["x1", "y1", "x2", "y2"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "duplicate_layer",
      description:
        "Composition primitive: clone a leaf (image.<id> / video.<id> / shapes.<id> / text.<id>) `count` times, applying a cumulative per-step transform — copy i is offset by i·(dx,dy) px, rotated by i·d_rotation°, and scaled by d_scale^i. One call instead of dozens: a circle of stars (dx/dy + d_rotation), a row of chevrons (dx), a fractal (d_scale<1 + d_rotation), a staggered grid. Styles are copied; animate the result afterwards (e.g. group + a cycle-loop track for endless marching).",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "Leaf to clone (e.g. shapes.chevron-1)." },
          count: { type: "number", description: "Number of copies to create." },
          dx: { type: "number", description: "Per-step x offset in px." },
          dy: { type: "number", description: "Per-step y offset in px." },
          d_rotation: { type: "number", description: "Per-step rotation in degrees." },
          d_scale: { type: "number", description: "Per-step size multiplier (1 = no change)." },
        },
        required: ["elementId", "count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_layer",
      description: "Delete a video, image, or shape layer.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "image.<id> or shapes.<id>." },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_layer",
      description:
        "Move a layer within its parent's siblings. newIndex is 0-based among siblings (root list when ungrouped, or the parent group's children when nested). 0 = bottom of that subtree; last = top.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          newIndex: { type: "number", description: "0-based index among siblings of the same parent." },
        },
        required: ["elementId", "newIndex"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_style",
      description:
        "Set style fields on a layer. Only the fields you pass are changed; omit a field to leave it untouched. Covers border/radius/shadow (including borderAlign — inner|center|outer border position) plus image-only fields: fit (stretch|cover|contain), anchorX/anchorY (0..1, where the source anchors when cropping/letterboxing under cover/contain), tintColor (#rrggbb) + tintStrength (0..1) for a colour overlay painted source-atop, and alphaMask (linear gradient — see below) for a multiplicative alpha fade across the layer.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          borderRadius: { type: "number" },
          borderWidth: { type: "number" },
          borderColor: { type: "string", description: "#rrggbb." },
          borderAlign: {
            type: "string",
            enum: ["inner", "center", "outer"],
            description:
              "Where the border sits relative to the layer's edge (design-tool \"border position\"). \"inner\" (default) draws the band INSIDE the box so it eats into the content; \"outer\" draws it entirely OUTSIDE so it frames the content without covering it; \"center\" straddles the edge 50/50. Rectangular boxes (image/video/text) only — shapes always stroke centred on their silhouette and ignore it.",
          },
          boxShadow: {
            type: ["string", "null"],
            description:
              "CSS box-shadow string, e.g. \"0 4px 12px rgba(0,0,0,0.5)\". Pass an empty string \"\" or null to REMOVE the shadow.",
          },
          fit: {
            type: "string",
            enum: ["stretch", "cover", "contain"],
            description:
              "Fit mode (image + video layers). Default: stretch for image layers, cover for video layers.",
          },
          anchorX: {
            type: "number",
            description:
              "Object-position X (0..1). 0=left, 1=right, 0.5=centre. Only meaningful with fit=cover|contain.",
          },
          anchorY: {
            type: "number",
            description:
              "Object-position Y (0..1). 0=top, 1=bottom, 0.5=centre. Only meaningful with fit=cover|contain.",
          },
          tintColor: {
            type: "string",
            description:
              "#rrggbb tint colour painted source-atop over the image (image layers only).",
          },
          tintStrength: {
            type: "number",
            description:
              "Tint blend strength 0..1. 0=no tint, 1=image silhouette filled with tintColor. Default 0 (no tint).",
          },
          alphaMask: {
            description:
              "Linear alpha-mask gradient (image layers). Multiplies the layer's alpha along a gradient line — used to fade a layer out partway across (the front half of a 'sandwich' covering text below it). Object: { type: 'linear', angle: number (deg, CSS-style; 0=to top, 90=to right, 180=to bottom, 270=to left), stops: [{offset:0..1, alpha:0..1}, ...] (≥2 stops, ordered by offset) }. Pass null to clear.",
            oneOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["linear"] },
                  angle: { type: "number" },
                  stops: {
                    type: "array",
                    minItems: 2,
                    items: {
                      type: "object",
                      properties: {
                        offset: { type: "number", minimum: 0, maximum: 1 },
                        alpha: { type: "number", minimum: 0, maximum: 1 },
                      },
                      required: ["offset", "alpha"],
                    },
                  },
                },
                required: ["stops"],
              },
            ],
          },
          chroma_key: {
            description:
              "Green-screen key (video / image layers). Makes pixels near `color` transparent at render time so layers below show through. Object: { color: '#rrggbb' (default '#00ff00'), similarity: 0..1 (match radius, default 0.4), smoothness: 0..1 (edge feather, default 0.1) }. Pass null to clear.",
            oneOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  color: { type: "string" },
                  similarity: { type: "number", minimum: 0, maximum: 1 },
                  smoothness: { type: "number", minimum: 0, maximum: 1 },
                },
              },
            ],
          },
          blend_mode: {
            type: "string",
            enum: [
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
            ],
            description:
              "Photoshop-style layer blend mode (Canvas globalCompositeOperation). 'normal' is the default. Applies to every layer kind; allowed on group.<id> too (the only set_style field that is).",
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_layer_fill",
      description:
        "Set a layer's fill. The canvas backdrop is the pinned is_background image_layer (its element id is exposed via describe_video as background.elementId; the literal 'background.canvas' is also accepted as a synonym); null is rejected on the backdrop. Shapes require a Fill (null/missing is rejected). Image / video / text / group layers accept a Fill object (or `#rrggbb` hex) to paint a backdrop, or `null` to clear it — clearing removes the layer's fill colour keyframes too, so an animated backdrop really does go away. Shapes paint their body; image/video paint behind the bitmap; groups paint a rect centred on the pivot sized by (box_width, box_height). REFUSED on a layer whose fill is ANIMATED (it has colour keyframes): the track wins at every frame, so a plain fill write would be invisible. Change it at a frame with add_color_keyframe, or pass clear_animation:true to replace the animation with this fill.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "shapes.<id> / image.<id> / video.<id> / group.<id>. The pinned is_background image_layer is the canvas backdrop; the literal 'background.canvas' is accepted as a synonym.",
          },
          fill: {
            description:
              'Either \'#rrggbb\' (promoted to solid) or a Fill object: {type:"solid",color} / {type:"linear",stops:[{pos:0..1,color}],angle?} / {type:"radial",stops:[{pos:0..1,color}],cx?,cy?,radius?} / {type:"mask",layer_id,color}. A gradient is ONE fill — don\'t fake it with stacked shapes. null (image/video/text/group only) clears the backdrop, including any fill colour keyframes on it.',
          },
          clear_animation: {
            type: "boolean",
            description:
              "Only meaningful on a layer whose fill is animated. true = this fill REPLACES the colour animation (its keyframes are deleted). Omitted / false = the call is refused rather than writing a fill the animation would hide.",
          },
        },
        required: ["elementId", "fill"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_text_background",
      description:
        "Add or update the rounded background box behind a TEXT layer (text.<id>) in one call — sets the backdrop fill plus the box's padding, corner radius, and optional stroke. Pass only the fields you want to change. New text layers are already text_autofit \"hug\", so padding alone shrink-wraps the box to the text — ideal for caption / sticker chips; set_layer_text(text_autofit:\"hug\") is only needed when adding a box to an OLDER layer still on \"wrap\". THIS IS HOW YOU BUILD A BUTTON: a button / CTA / chip / tag / pill / labelled badge is ONE text layer with a native background, never a rounded-rect shape with a text layer parked on top — padding is what sizes the box around the label, so the two can't drift apart when the text or the scale changes and the user drags one layer instead of two. The one exception: the box is NOT painted on CURVED text (a straight box behind a bent line reads as broken), so an arc-shaped chip genuinely needs a shape behind it. Pass fill null to remove the box. Text layers only; for shapes/images/video use set_layer_fill.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "text.<id>." },
          fill: {
            description:
              "Box fill: '#rrggbb' (promoted to solid) or a Fill object: {type:\"solid\",color} / {type:\"linear\",stops:[{pos:0..1,color}],angle?} / {type:\"radial\",stops:[{pos:0..1,color}],cx?,cy?,radius?} / {type:\"mask\",layer_id,color}. null clears the box; omit to leave the current fill.",
          },
          padding: {
            type: "number",
            description:
              "Uniform inset (canvas px) between the box edge and the text. 0 / omitted ⇒ no explicit padding.",
          },
          cornerRadius: {
            type: "number",
            description: "Corner radius of the box in px. 0 ⇒ square corners.",
          },
          strokeWidth: {
            type: "number",
            description: "Box outline width in px. 0 / omitted ⇒ no outline.",
          },
          strokeColor: {
            type: "string",
            description: "Box outline colour as #rrggbb.",
          },
          clear_animation: {
            type: "boolean",
            description:
              "Only meaningful when `fill` is given AND the layer's backdrop fill is animated. true = the new fill REPLACES the colour animation. Omitted / false = the call is refused rather than writing a fill the animation would hide.",
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_group_box",
      description:
        "Set a group's backdrop rect size. The rect is centred on (pivotX, pivotY) in group-local space and transforms with the group. Either dimension at 0 hides the backdrop entirely.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "group.<id>." },
          box_width: {
            type: "number",
            description: "Backdrop width in px (non-negative).",
          },
          box_height: {
            type: "number",
            description: "Backdrop height in px (non-negative).",
          },
        },
        required: ["elementId", "box_width", "box_height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_color_keyframe",
      description:
        "Add or overwrite a colour keyframe on a fill track. Targets a leaf (shapes.<id>, image.<id>, video.<id>, group.<id>). The canvas backdrop is the pinned is_background image_layer (the literal 'background.canvas' is accepted as a synonym for its element id). The value is a Fill — adjacent keyframes crossfade stop-by-stop. 30 fps; frame is 0-indexed.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "Element id (shapes/image/video/group prefixed). The pinned is_background image_layer is the canvas backdrop; 'background.canvas' is also accepted as a synonym.",
          },
          property: {
            type: "string",
            enum: ["fill"],
            description: "Currently only 'fill' is supported.",
          },
          frame: {
            type: "number",
            description: "Frame number, 0-indexed. 30 fps so frame 30 = 1 second.",
          },
          value: {
            description:
              'Either \'#rrggbb\' (promoted to solid) or a Fill object: {type:"solid",color} / {type:"linear",stops:[{pos:0..1,color}],angle?} / {type:"radial",stops:[{pos:0..1,color}],cx?,cy?,radius?}. Adjacent keyframes crossfade the gradient stop-by-stop.',
          },
          easing: {
            type: "string",
            enum: VALID_EASINGS,
            description: "Interpolation to the next keyframe. Default linear.",
          },
        },
        required: ["elementId", "property", "frame", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_color_keyframe",
      description:
        "Remove the colour keyframe at an exact frame on a fill track. No-op when no track or no matching keyframe exists. Removing the last keyframe drops the track entry.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "Element id. The canvas backdrop is the pinned is_background image_layer; 'background.canvas' is accepted as a synonym.",
          },
          property: {
            type: "string",
            enum: ["fill"],
          },
          frame: { type: "number" },
        },
        required: ["elementId", "property", "frame"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fade_layer",
      description:
        "Fade a layer's opacity between two frames in one call.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          fromFrame: { type: "number" },
          toFrame: { type: "number" },
          fromOpacity: { type: "number", description: "0..1." },
          toOpacity: { type: "number", description: "0..1." },
        },
        required: ["elementId", "fromFrame", "toFrame", "fromOpacity", "toOpacity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_layer_visible",
      description:
        "Show or hide a layer instantly by writing a single opacity keyframe (1 or 0) at frame 0.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          visible: { type: "boolean" },
        },
        required: ["elementId", "visible"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_preset",
      description:
        "Apply a canned animation preset to a layer.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string" },
          preset: { type: "string", enum: VALID_PRESETS },
          startFrame: { type: "number", description: "Frame to anchor on. Default 0." },
        },
        required: ["elementId", "preset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_preset_stagger",
      description:
        "Apply the same preset to a LIST of layers with a per-element startFrame offset — one call instead of N apply_preset calls. For diagonal pop-in grids, sequential list reveals, ring-pulse sweeps. The startFrame for entry i is `startFrame + i * stagger`. Order the elementIds in the visual order you want the animation to cascade.",
      parameters: {
        type: "object",
        properties: {
          elementIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Layers to animate, ordered as the cascade should fire (first id gets startFrame; each next gets +stagger frames).",
          },
          preset: { type: "string", enum: VALID_PRESETS },
          startFrame: {
            type: "number",
            description: "Base frame for the first element. Default 0.",
          },
          stagger: {
            type: "number",
            description: "Frames between successive elements. Default 1.",
          },
        },
        required: ["elementIds", "preset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "group_layers",
      description:
        "Wrap sibling elements in a new group. USE THIS whenever several layers are one thing — a butterfly assembled from wings + body + antennae, an icon built from primitives, a card + its title + badge, a lower-third — and name the group what the thing is; a multi-shape object left as loose siblings is a defect the user has to clean up, and the group's name is their only handle on it. The group composes its x/y/scale/rotation/opacity onto its descendants (so one track flies/spins/fades the whole thing) and pivots rotate/scale at its (pivotX, pivotY), seeded to the centroid of its children at create time. The group's x/y track values are translation offsets applied around the pivot — groups have no static body of their own. All listed elementIds must currently share the same parent (root, or one existing group).",
      parameters: {
        type: "object",
        properties: {
          elementIds: {
            type: "array",
            items: { type: "string" },
            description: "Element ids of the elements to wrap. Must all share the same parent.",
          },
          name: { type: "string", description: "Optional human-readable label." },
        },
        required: ["elementIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ungroup_layers",
      description:
        "Dissolve a group: its children are spliced into the group's parent at the group's old position. The group's animation tracks are discarded — children survive at their last positions but inherit none of the group's keyframes.",
      parameters: {
        type: "object",
        properties: {
          groupId: {
            type: "string",
            description: "Bare group id (no 'group.' prefix), e.g. \"header\" for group.header.",
          },
        },
        required: ["groupId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_group_parent",
      description:
        "Move an element into a group (or out to root). Refuses to place a group inside its own descendants.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "Full element id: video.<id>, image.<id>, shapes.<id>, or group.<id>.",
          },
          parentGroupId: {
            type: ["string", "null"],
            description: "Bare group id of the new parent, or null to move to root.",
          },
          index: {
            type: "number",
            description: "0-based insert position among the new parent's children. Defaults to end.",
          },
        },
        required: ["elementId", "parentGroupId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_group",
      description: "Rename a group. Pure cosmetic — labels appear in the Inspector and describe_video output.",
      parameters: {
        type: "object",
        properties: {
          groupId: { type: "string" },
          name: { type: "string" },
        },
        required: ["groupId", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_collection",
      description:
        "Add a layer to the user's reusable Collection. Pass ANY element id — a leaf (text.<id>, image.<id>, …) or a whole group.<id> (a lower-third, logo sting, brand intro). It then appears in the user's Collection (list_collection), where they — and, if this project is in a workspace, every teammate — can drop a self-contained COPY of it into any other project (add_from_collection). Copies are IMMUTABLE: adding copies the whole subtree + its asset bytes, so editing or deleting this source never changes a copy already placed elsewhere. Works on solo projects too (a personal Collection). Give the layer a clear name first (rename_layer / rename_group) — that name is what shows in the Collection.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "The element id to add — any leaf (text/image/video/shapes.<id>) or a group.<id>.",
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_collection",
      description:
        "Remove a layer from the user's Collection so it's no longer offered for reuse. Pass the element id that was added with add_to_collection. Copies already placed in other projects are unaffected (they're self-contained). No-op if the id isn't in the collection.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "The element id to remove from the Collection.",
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_morpha_layer",
      description:
        "Embed another of the user's projects (\"a morpha\") inside this one as a version-pinned band. The source's layers are inlined into the host as a collapsible group, re-keyed to fresh ids, pinned to one immutable version of the source. Pass the source project's id as source_morpha_id (and optionally a version label); the server resolves and inlines the pinned version. Editing the band's inner layers only affects THIS video — the change is local and never propagates back to the source. To pin the band to a different saved version, re-pin it from the editor's Inspector. describe_video marks an embedded band with morpha:true + source_morpha_id so you can tell it apart from a plain group.",
      parameters: {
        type: "object",
        properties: {
          source_morpha_id: {
            type: "string",
            description: "The id of the project to embed. Must not be this project.",
          },
          version: {
            type: "string",
            description:
              "Optional version label of the source to pin (e.g. \"v3\"). Omit to pin the source's latest saved version.",
          },
        },
        required: ["source_morpha_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_audio_overlay",
      description:
        "Add an audio overlay (mp3/m4a/wav/ogg) scheduled at a frame-aligned start. The asset must already exist at users/<userId>/assets/<projectId>/<filename>. 30 fps; convert seconds with frames = round(s * 30). Plays in the editor preview and is mixed into the MP4 export.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Audio asset filename in the project's assets bucket.",
          },
          startFrame: {
            type: "number",
            description: "Frame at which the overlay starts (0-indexed, 30 fps).",
          },
          gain: {
            type: "number",
            description: "Linear gain 0..2. Default 1.",
          },
          fadeInFrames: {
            type: "number",
            description: "Linear fade-in length in frames. Default 0.",
          },
          fadeOutFrames: {
            type: "number",
            description: "Linear fade-out length in frames. Default 0.",
          },
          endFrame: {
            type: "number",
            description:
              "Optional end frame; omit to play the asset's full natural length from startFrame.",
          },
          sourceLayerId: {
            type: "string",
            description:
              "Optional video layer element id (\"video.<id>\") to weld this overlay to. When set, the editor renders the overlay as a waveform footer on that clip and drags it with the clip instead of showing a standalone bottom row.",
          },
        },
        required: ["filename", "startFrame"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_audio_overlay",
      description: "Delete an audio overlay by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Overlay id (e.g. audio_1)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_audio_overlay",
      description:
        "Patch an existing audio overlay. Only the fields you pass are changed. Pass endFrame:null to clear it (revert to natural-length playback).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          filename: { type: "string" },
          startFrame: { type: "number" },
          gain: { type: "number", description: "Linear gain 0..2." },
          fadeInFrames: { type: "number" },
          fadeOutFrames: { type: "number" },
          endFrame: {
            type: ["number", "null"],
            description: "End frame, or null to clear and use the asset's natural length.",
          },
          sourceLayerId: {
            type: ["string", "null"],
            description:
              "Weld the overlay to a video layer (\"video.<id>\") so it renders as a clip footer and drags with the clip, or null to detach it back into a standalone track.",
          },
          denoiseStrength: {
            type: ["number", "null"],
            description:
              "Clean-strength wet/dry mix 0..1 for an overlay with an AI-cleaned track: 1 = fully cleaned, 0 = fully original, between = blend. null clears it (full clean). Ignored while the Original track is selected.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_video_layer_trim",
      description:
        "Patch a video layer's trim window: source_in_frame (frame in source to start), source_out_frame (frame in source to stop, or null for natural end), timeline_start_frame (where on the project timeline the slice begins). Only the fields you pass are changed. Use this to clip out a segment of a source mp4: duplicate the layer first (in the editor) so you have two pointing at the same clip, then set disjoint source windows.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "video.<id> of the layer to trim.",
          },
          source_in_frame: {
            type: "number",
            description: "Frame in the source mp4 where playback begins (0-indexed, 30 fps).",
          },
          source_out_frame: {
            type: ["number", "null"],
            description:
              "Frame in the source mp4 where playback stops, or null to clear and play to the source's natural end.",
          },
          timeline_start_frame: {
            type: "number",
            description: "Project-timeline frame where this slice begins playing.",
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_layer_block",
      description:
        "Set (or replace) a layer's timeline BLOCK — the [start, start+duration) window it exists for. The layer is drawn ONLY inside that window, and its animation keyframes are sampled RELATIVE to the block start, so moving or trimming the block re-anchors its intro instead of leaving it behind. This is how a layer 'starts' at a point like an iMovie clip rather than being present for the whole composition. Works on any leaf or group. Frames are in the layer's parent timeline (composition frames at root; band-local inside an embedded morpha band). To place a whole embedded reel, use move_band.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "Element id of the layer (image.<id>, video.<id>, text.<id>, shapes.<id>, or group.<id>).",
          },
          start: {
            type: "number",
            description:
              "First frame the layer appears (0-indexed, 30 fps), in its parent timeline.",
          },
          duration: {
            type: "number",
            description:
              "How many frames the layer lasts (≥ 1). Hidden outside [start, start+duration).",
          },
        },
        required: ["elementId", "start", "duration"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_layer_transition",
      description:
        "Set how a layer ENTERS at the start of its on-timeline window and LEAVES at the end, instead of popping. The transition is EDGE-RELATIVE — only a length and a look are stored — so it rides the edge through every later trim, slide or clip retime. Prefer this over fade_layer / apply_preset whenever the intent is 'enters and leaves nicely': those write opacity keyframes at ABSOLUTE frames, which strand themselves the moment the edge moves, and clutter the timeline lanes. A layer created WITH a `block` is born carrying a short fade at each edge — whether you passed the block or the editor minted one — so check `inspect_layers` before adding one, rather than assuming there is none. Layers created before this default existed, and any edge cleared to \"cut\", carry nothing and do need setting. A layer with NO block is always-present, has no edges, and a transition on it is inert. Video clips default to a hard cut, because a hard cut between shots is the grammar of short-form video. kind \"cut\" clears the edge back to a hard cut. The length is a request: when the window is too short to hold both ramps they are squeezed proportionally at render time, and the stored values are left intact.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "Element id of the layer (image.<id>, video.<id>, text.<id>, shapes.<id>, or group.<id>).",
          },
          edge: {
            type: "string",
            enum: ["in", "out", "both"],
            description:
              "Which edge to set. \"in\" is the start of the layer's window, \"out\" the end.",
          },
          kind: {
            type: "string",
            enum: ["cut", "fade", "slide", "pop"],
            description:
              "The look. \"cut\" = hard edge (clears any transition). \"fade\" = opacity ramp. \"slide\" = travels in/out from a direction while fading. \"pop\" = scales up from 80% with an overshoot.",
          },
          frames: {
            type: "number",
            description:
              "Ramp length in frames (30 fps). Default 6. Ignored for kind \"cut\".",
          },
          curve: {
            type: "string",
            description:
              "Optional easing override (linear, easeIn, easeOut, easeInOut, outQuart, outExpo, outBack, inBack, inOutBack). Defaults suit the kind: entries decelerate in, exits accelerate away.",
          },
          direction: {
            type: "string",
            enum: ["left", "right", "up", "down"],
            description:
              "For kind \"slide\" only. On the IN edge this is where the layer comes FROM; on the OUT edge, where it goes TO. Default \"left\".",
          },
        },
        required: ["elementId", "edge", "kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_band",
      description:
        "Place an embedded morpha band on the host timeline: set its TIME ORIGIN (the frame it starts). The band's whole inner reel plays relative to this frame, so its intro animations fire when the band appears instead of at 0:00 (the fix for 'the embedded intro doesn't animate'). Keeps the band's current window length; if it had none, the band spans from start to the composition end. Pass the band group's id (from describe_video — a group with morpha:true).",
      parameters: {
        type: "object",
        properties: {
          bandId: {
            type: "string",
            description:
              "The embedded band's group id (group.<id> or the bare <id>).",
          },
          start: {
            type: "number",
            description:
              "Host-timeline frame where the band begins (0-indexed, 30 fps).",
          },
        },
        required: ["bandId", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shift_group",
      description:
        "MOVE a group and everything inside it along the timeline, keeping its internal timing intact — the 'slide this whole section later' operation. A plain group is a relative CONTAINER: it has no window of its own, so on the timeline it spans the hull of its contents, and moving it slides the whole subtree as one rigid body. `start` is the ABSOLUTE frame the group's window should end up at, not a delta, so calling it twice with the same value is a no-op. Descendants keep their spacing; the move stops when the earliest thing inside reaches frame 0. Welded caption lines are deliberately left behind (they follow their clip's speech, not this group), and an embedded morpha band moves as one unit. Fails when the group is empty or holds an always-present layer — there is no bounded window to move. To CLIP what is shown of a group rather than move it, use set_group_window; for a single layer use set_layer_block.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "The group's id (group.<id> or the bare <id>).",
          },
          start: {
            type: "number",
            description:
              "ABSOLUTE frame the group's window should start at after the move (0-indexed, 30 fps) — not an offset.",
          },
        },
        required: ["elementId", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_group_window",
      description:
        "TRIM a group's own visible window — the [start, start+duration) range over which the group and its subtree are drawn. The contents are NOT moved or deleted: this clips what is shown, so use it to hide the head or tail of a whole section. Writing a window overrides the group's derived contents-hull from then on. Two safety corrections apply automatically: the group's OWN keyframes are compensated for the change in start so its animation doesn't jump (reported as keyframesCompensatedBy), and the duration is grown if needed so the window can never hide one of the group's own authored keyframes (reported as grownToCoverKeyframes). To MOVE the group and its contents instead, use shift_group.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "The group's id (group.<id> or the bare <id>).",
          },
          start: {
            type: "number",
            description:
              "First frame the group is drawn on, in its parent timeline (0-indexed, 30 fps).",
          },
          duration: {
            type: "number",
            description:
              "How many frames the group stays drawn for (≥ 1). Grown automatically if it would hide the group's own keyframes.",
          },
        },
        required: ["elementId", "start", "duration"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_duration",
      description:
        "Author an EXPLICIT composition length in seconds, pinning it (duration_authored=true) so the auto-fit no longer drives it. Morpha normally DERIVES the comp length from content (the furthest keyframe / video window / audio end); this overrides that with a fixed length — the stage becomes a fixed canvas you author into, and content past the end is kept but not played or exported. Clamped to [1, 600] s. Use it to shorten a comp to a target length (e.g. a 15-second cut) or to reserve a longer stage than the current content fills. Call fit_duration_to_content to release the pin.",
      parameters: {
        type: "object",
        properties: {
          seconds: {
            type: "number",
            description:
              "Composition length in seconds (clamped to 1..600). 30 fps; durationInFrames = ceil(seconds*30).",
          },
        },
        required: ["seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fit_duration_to_content",
      description:
        "Clear an authored composition length and return to AUTO-FIT — the comp length tracks the furthest content (keyframe / video window / audio end) again, with a 1-second floor. The inverse of set_duration. NOTE: headless (no loaded media) this can UNDER-fit when a video layer's source_out_frame is null — its natural length is unmeasurable, so it contributes only its start frame; the length self-corrects the next time the project is opened in the editor, where the real clip durations are known.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cut_range",
      description:
        "Ripple-delete a time window [startFrame, endFrame) — remove that span and pull all later content earlier by delta = endFrame - startFrame (the NLE 'ripple delete' / 'close gap'). Shifts every keyframe, colour keyframe, marker, audio overlay, loop region, and start_at through the cut (a speed ramp is anchored to its clip and rides along unchanged), and is SOURCE-AWARE for video layers: a clip that straddles the cut is trimmed, and one whose interior is removed is SPLIT into two layers. Audio overlays interior to the cut are truncated at the seam (overlays have no source-in to bridge the gap). REFUSES to cut across a video layer that carries speed-ramp keyframes — remove them, or cut outside that layer's span, first. The composition length shrinks accordingly (an authored length loses only the overlap with its visible region). Frames are 0-indexed project-timeline frames at 30 fps; endFrame is exclusive and clamped to the composition length.",
      parameters: {
        type: "object",
        properties: {
          startFrame: {
            type: "number",
            description: "First frame of the window to remove (0-indexed, inclusive).",
          },
          endFrame: {
            type: "number",
            description:
              "End frame of the window to remove (0-indexed, EXCLUSIVE). Must be > startFrame; clamped to the composition length.",
          },
        },
        required: ["startFrame", "endFrame"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_embed_origins",
      description:
        "Replace the project's embed allowlist — the hostnames permitted to load this project through the public <morpha-video> embed. Pass the full desired list; it overwrites the previous one. An empty array turns embedding OFF (the public embed endpoint 404s the project). Each entry is normalized to a bare lowercased hostname (scheme, port, and path stripped, e.g. \"https://example.com/x\" → \"example.com\"); duplicates are dropped.",
      parameters: {
        type: "object",
        properties: {
          origins: {
            type: "array",
            items: { type: "string" },
            description:
              "Full desired allowlist. Each entry may be a bare hostname or a URL; it is normalized to a bare lowercased hostname. Empty array disables embedding.",
          },
        },
        required: ["origins"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_embed_origin",
      description:
        "Add one hostname to the project's embed allowlist (the hostnames permitted to load the public <morpha-video> embed). Idempotent — re-adding an existing entry is a no-op. The origin is normalized to a bare lowercased hostname (scheme/port/path stripped).",
      parameters: {
        type: "object",
        properties: {
          origin: {
            type: "string",
            description:
              "Hostname or URL to allow, e.g. \"example.com\" or \"https://example.com\". Normalized to a bare lowercased hostname.",
          },
        },
        required: ["origin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_embed_origin",
      description:
        "Remove one hostname from the project's embed allowlist. Idempotent — removing an entry that isn't present is a no-op. Removing the last entry turns embedding OFF (the public embed endpoint 404s the project).",
      parameters: {
        type: "object",
        properties: {
          origin: {
            type: "string",
            description:
              "Hostname or URL to remove. Normalized the same way as add_embed_origin before matching.",
          },
        },
        required: ["origin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_custom_font",
      description:
        "Register a typeface Morpha does NOT ship, so text layers can use it by family name via font_family (exactly like a built-in family). Families already in the built-in catalogs (anything list_fonts returns from google/bunny/fontshare/fontsource/velvetyne) are REJECTED — they need no registration; just set font_family to them directly. `src` is EITHER a full URL (https://…) OR a font file already uploaded to the project's asset bucket (POST /api/upload-asset/<projectId>, raw bytes + X-Filename header; .woff2/.woff/.ttf/.otf). Like add_image_layer, this does NOT verify an uploaded filename exists. Dedupes by family+weight+style, replacing a matching face. After registering, set a text layer's font_family to this family (add_text_layer / set_layer_text). NOTE: a pasted URL only loads if that host sends permissive CORS headers — uploading the font (served same-origin) is the robust path.",
      parameters: {
        type: "object",
        properties: {
          family: {
            type: "string",
            description:
              "Family name text layers will reference via font_family, e.g. \"Mylius Modern\".",
          },
          src: {
            type: "string",
            description:
              "A full font URL (https://…/font.woff2) OR an uploaded asset filename in the project's bucket.",
          },
          weight: {
            type: "number",
            description:
              "Optional specific weight (1-1000) this src provides. Omit for the 400/normal baseline.",
          },
          style: {
            type: "string",
            enum: ["normal", "italic"],
            description: "Optional face style. Defaults to normal.",
          },
        },
        required: ["family", "src"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_fonts",
      description:
        "List available font families across every source the editor knows about (Google + Bunny + Fontshare + Fontsource + Velvetyne) PLUS the project's user-uploaded custom_fonts (surfaced as source: \"custom\"). Use this to discover families before set_layer_text / add_text_layer when you don't know what to pick. Returns { fonts: [{family, source, weights, italics}], total, returned, sources }. Filter via `q` (case-insensitive substring on family) and/or `source`; cap with `limit` (default 50, max 1000). Picking any returned family in font_family Just Works — the editor's loader dispatches to the right CSS/FontFace endpoint by source.",
      parameters: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description:
              "Case-insensitive substring filter on family name. Omit to list everything.",
          },
          source: {
            type: "string",
            enum: ["google", "bunny", "fontshare", "fontsource", "velvetyne", "custom"],
            description:
              "Restrict to one source. Omit to span every source. \"custom\" returns only the project's uploaded faces.",
          },
          limit: {
            type: "number",
            description: "Max entries to return (default 50, max 1000).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_layer_text",
      description:
        "Edit an existing text layer (text.<id>). Patches its text content, font, size, colour, and full type styling — pass only the fields you want to change. Does NOT create layers and does NOT touch image layers; use add_text_layer to make a new one. `font_family` is a Google Fonts family name (e.g. \"Anton\", \"Bebas Neue\"). `text_size` is the font size in px (omit to keep the current size). `text_color` is #rrggbb. Styling: font_weight (100-900, e.g. 800 for a black/heavy logo look), font_style (italic), text_transform (uppercase/lowercase), letter_spacing (px, may be negative for tight tracking), line_height (multiplier), text_align, text_autofit (\"wrap\" default = fixed size + word-wrap, the size you set is what renders; \"fit\"=auto-size to fill the box, grows and shrinks; \"shrink\"=legacy shrink-only), text_valign (top/middle/bottom block alignment), an outline via stroke_width + stroke_color, and a text_shadow. To make text MASK another layer (video/image-filled letterforms) use set_matte_source with this layer's id as the matte source. Only `elementId` is required.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "Text layer id, text.<id>.",
          },
          text: {
            type: "string",
            description: "The text to render. Newlines are honoured as hard line breaks.",
          },
          text_size: {
            type: "number",
            description: "Font size in px.",
          },
          font_family: {
            type: "string",
            description: "Google Fonts family name, e.g. \"Anton\".",
          },
          text_color: {
            type: "string",
            description: "Text fill colour as #rrggbb.",
          },
          font_weight: {
            type: "number",
            description: "Font weight 100..900 (400 regular, 700 bold, 800 black). Default 400; the canvas synthesizes weights a static font doesn't ship.",
          },
          font_style: {
            type: "string",
            enum: ["normal", "italic"],
            description: "Italic toggle. Default normal.",
          },
          text_transform: {
            type: "string",
            enum: ["none", "uppercase", "lowercase"],
            description: "Case transform applied before layout. Default none.",
          },
          letter_spacing: {
            type: "number",
            description: "Tracking between glyphs in px; may be negative. Default 0.",
          },
          curve: {
            type: "number",
            description:
              "Curve the text onto an arc, in degrees of total sweep. 0 = straight (default). POSITIVE = a SMILE (⌣, ends rise); NEGATIVE = an ARCH (⌒, rainbow). Clamped ±135. A tasteful smile is ~+60. Applies to a SINGLE line — multi-line text is joined to one line while curved (the stored text is untouched, so curve:0 restores it).",
          },
          line_height: {
            type: "number",
            description: "Line height as a multiple of font size (1.2 = 120%).",
          },
          text_align: {
            type: "string",
            enum: ["left", "center", "right"],
            description: "Horizontal alignment of each line. Default center.",
          },
          text_autofit: {
            type: "string",
            enum: ["fit", "shrink", "wrap", "hug"],
            description:
              "How text fits its box. \"hug\" (default for new layers): hold text_size FIXED and DERIVE the box from the measured text plus padding, honouring the literal newlines you pass — the box shrink-wraps the exact content and grows/shrinks live as the text changes, so it can never re-wrap differently between the editor preview and the export (bake your own \"\\n\" breaks; pair with set_text_background for a rounded caption box). \"wrap\": hold text_size FIXED in a fixed-size box and only word-wrap (hard-breaking a single over-wide word), never resize. \"fit\": ignore text_size and auto-size the font BOTH ways (grow and shrink) to the largest size whose wrapped block fills the box — resizing the box resizes the text. \"shrink\" (legacy): word-wrap then auto-shrink the font from text_size until the block fits; never grows.",
          },
          text_valign: {
            type: "string",
            enum: ["top", "middle", "bottom"],
            description:
              "Vertical alignment of the text block within its box. \"middle\" (default) centres it; \"bottom\" pins it to the box floor so extra wrapped lines grow upward from a fixed baseline (captions use this so a wrapped line doesn't shift the others); \"top\" pins the ceiling.",
          },
          stroke_width: {
            type: "number",
            description: "Outline width in px (0 = no outline).",
          },
          stroke_color: {
            type: "string",
            description: "Outline colour as #rrggbb. Defaults to white when a width is set.",
          },
          text_shadow: {
            type: ["object", "null"],
            description: "Drop shadow { offsetX, offsetY, blur, color }; color is any CSS colour (rgba allowed). null clears it.",
            properties: {
              offsetX: { type: "number" },
              offsetY: { type: "number" },
              blur: { type: "number" },
              color: { type: "string" },
            },
          },
          decorations: {
            type: ["object", "null"],
            description:
              "Per-character underline / strikethrough. { underline?: [{start,end}], strikethrough?: [{start,end}] } — each a list of half-open character ranges [start,end) (UTF-16 offsets) into `text`. E.g. underline the first word of \"Big news\": underline:[{start:0,end:3}]. Ranges are normalized (sorted + merged). null clears all decorations; editing `text` in the SAME call re-indexes existing ranges against the new text. Not rendered on curved text.",
            properties: {
              underline: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "number" },
                    end: { type: "number" },
                  },
                },
              },
              strikethrough: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "number" },
                    end: { type: "number" },
                  },
                },
              },
            },
          },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_text_layer",
      description:
        "Create a new text layer — a first-class leaf that animates, groups, and z-orders exactly like an image or shape. The renderer draws live typeset text (multi-line, auto-fit to the box). Defaults: x/y = canvas centre, width 900, height 320, font_family \"Anton\", text_size derived from existing text layers (or ~10% of canvas height). Also accepts full type styling: font_weight (100-900), font_style (italic), text_transform, letter_spacing, line_height, text_align, text_autofit (\"hug\" default = box shrink-wraps the text at the fixed text_size, honouring literal newlines, so it can't re-wrap between preview and export — bake your own \"\\n\" line breaks / \"wrap\"=fixed size + word-wrap to the box / \"fit\"=auto-size to fill the box, grows and shrinks / \"shrink\"=legacy shrink-only), text_valign (top/middle/bottom), an outline (stroke_width + stroke_color), and text_shadow. Returns the new layer's id + element id (text.<id>).",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The text to render. Newlines are honoured as hard line breaks.",
          },
          x: { type: "number", description: "Centre x in canvas px. Defaults to canvas centre." },
          y: { type: "number", description: "Centre y in canvas px. Defaults to canvas centre." },
          width: { type: "number", description: "Box width in px (> 0). Default 900." },
          height: { type: "number", description: "Box height in px (> 0). Default 320." },
          font_family: {
            type: "string",
            description: "Google Fonts family name, e.g. \"Anton\". Default \"Anton\".",
          },
          text_size: {
            type: "number",
            description:
              "Font size in px. Omit to derive from existing text layers (median) or the canvas height.",
          },
          text_color: {
            type: "string",
            description: "Text fill colour as #rrggbb. Defaults to white.",
          },
          font_weight: {
            type: "number",
            description: "Font weight 100..900 (400 regular, 700 bold, 800 black). Default 400.",
          },
          font_style: {
            type: "string",
            enum: ["normal", "italic"],
            description: "Italic toggle. Default normal.",
          },
          text_transform: {
            type: "string",
            enum: ["none", "uppercase", "lowercase"],
            description: "Case transform applied before layout. Default none.",
          },
          letter_spacing: {
            type: "number",
            description: "Tracking between glyphs in px; may be negative. Default 0.",
          },
          curve: {
            type: "number",
            description:
              "Curve the text onto an arc, in degrees of total sweep. 0 = straight (default). POSITIVE = a SMILE (⌣, ends rise); NEGATIVE = an ARCH (⌒, rainbow). Clamped ±135. A tasteful smile is ~+60. Single line only (multi-line is joined while curved).",
          },
          line_height: {
            type: "number",
            description: "Line height as a multiple of font size (1.2 = 120%).",
          },
          text_align: {
            type: "string",
            enum: ["left", "center", "right"],
            description: "Horizontal alignment of each line. Default center.",
          },
          text_autofit: {
            type: "string",
            enum: ["fit", "shrink", "wrap", "hug"],
            description:
              "How text fits its box. \"hug\" (default for new layers): hold text_size FIXED and DERIVE the box from the measured text plus padding, honouring the literal newlines you pass — the box shrink-wraps the exact content and grows/shrinks live as the text changes, so it can never re-wrap differently between the editor preview and the export (bake your own \"\\n\" breaks; pair with set_text_background for a rounded caption box). \"wrap\": hold text_size FIXED in a fixed-size box and only word-wrap (hard-breaking a single over-wide word), never resize. \"fit\": ignore text_size and auto-size the font BOTH ways (grow and shrink) to the largest size whose wrapped block fills the box — resizing the box resizes the text. \"shrink\" (legacy): word-wrap then auto-shrink the font from text_size until the block fits; never grows.",
          },
          text_valign: {
            type: "string",
            enum: ["top", "middle", "bottom"],
            description:
              "Vertical alignment of the text block within its box. \"middle\" (default) centres it; \"bottom\" pins it to the box floor so extra wrapped lines grow upward from a fixed baseline (captions use this so a wrapped line doesn't shift the others); \"top\" pins the ceiling.",
          },
          stroke_width: {
            type: "number",
            description: "Outline width in px (0 = no outline).",
          },
          stroke_color: {
            type: "string",
            description: "Outline colour as #rrggbb. Defaults to white when a width is set.",
          },
          text_shadow: {
            type: ["object", "null"],
            description: "Drop shadow { offsetX, offsetY, blur, color }; color is any CSS colour (rgba allowed). null clears it.",
            properties: {
              offsetX: { type: "number" },
              offsetY: { type: "number" },
              blur: { type: "number" },
              color: { type: "string" },
            },
          },
          decorations: {
            type: ["object", "null"],
            description:
              "Per-character underline / strikethrough. { underline?: [{start,end}], strikethrough?: [{start,end}] } — half-open character ranges [start,end) (UTF-16 offsets) into `text`. E.g. underline the first word of \"Big news\": underline:[{start:0,end:3}]. Ranges are normalized (sorted + merged). Not rendered on curved text.",
            properties: {
              underline: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "number" },
                    end: { type: "number" },
                  },
                },
              },
              strikethrough: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "number" },
                    end: { type: "number" },
                  },
                },
              },
            },
          },
          block: {
            type: "object",
            description:
              "OPTIONAL timeline window — {start, duration} in composition frames. OMIT IT (the default) and the layer is ALWAYS PRESENT: a persistent overlay that holds for the whole composition, which is what an agent-placed watermark / lower-third almost always wants. Pass it to place a bounded CLIP instead (what the editor's own add does: 5 s at the playhead). Keyframes on a blocked layer are sampled RELATIVE to `start`.",
            properties: {
              start: { type: "number", description: "First visible composition frame (≥ 0)." },
              duration: { type: "number", description: "Length of the window in frames (≥ 1)." },
            },
            required: ["start", "duration"],
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_caption_track",
      description:
        "Build a caption track from pre-timed lines (e.g. derived from transcribe_clip's word timings). mode \"line-sync\" (default) creates one text layer per line, each shown only during its [startFrame, endFrame) window via hold-eased opacity keyframes — the active-line karaoke read; mode \"static\" makes a single layer with all lines joined. `style` picks a preset look. Lines default to a lower-third band. The caption layers are always wrapped in a \"captions\" group so they don't clutter the layers list. Returns the created text element ids plus `groupElementId` (the captions group).",
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            description:
              "Caption lines in order. Each: { text, startFrame, endFrame } — frames are 0-indexed at 30fps.",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                startFrame: {
                  type: "number",
                  description: "Project frame the line appears.",
                },
                endFrame: {
                  type: "number",
                  description:
                    "Project frame the line disappears (defaults to startFrame + 30).",
                },
                clip_element_id: {
                  type: "string",
                  description:
                    'Optional per-line weld clip ("video.<id>"), overriding the top-level clip_element_id. Routes THIS line onto a specific lane clip — used to spread one montage\'s lines across the several clips that a single source was split into, so each line rides the clip that shows its words.',
                },
              },
              required: ["text", "startFrame"],
            },
          },
          mode: {
            type: "string",
            enum: ["line-sync", "static"],
            description:
              "\"line-sync\" (default): one timed layer per line. \"static\": one layer with all lines.",
          },
          style: {
            type: "string",
            enum: ["classic", "bold-outline", "word-pop"],
            description: "Caption look preset. Default \"classic\".",
          },
          x: { type: "number", description: "Caption band centre x. Default canvas centre." },
          y: {
            type: "number",
            description: "Caption band centre y. Default lower third (~80% of height).",
          },
          width: { type: "number", description: "Band width. Default ~86% of canvas width." },
          height: { type: "number", description: "Band height. Default ~16% of canvas height." },
          clip_element_id: {
            type: "string",
            description:
              'Optional "video.<id>" to WELD the caption lines to (line-sync mode). When set, each line\'s startFrame/endFrame are treated as its window in the clip\'s OWN source timeline and the on-timeline position is derived live from the clip\'s trim — so trimming or sliding the clip retimes/clips the captions, exactly like the clip\'s welded audio. Omit for fixed project-frame captions.',
          },
        },
        required: ["lines"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "split_caption_line",
      description:
        'Split one caption line into two at a COMPOSITION frame strictly inside its window (in the editor this is the playhead). The right half is a full clone — style, band geometry, weld — and the text divides at the word gap nearest the split point (a single-word line keeps its text on the left; the right half starts empty). A welded line stays welded on both halves (the frame converts to the clip\'s source timeline); a standalone line splits its block. Returns { left, right, splitFrame }. Retime the halves afterwards with set_layer_block; fix the wording with set_layer_text.',
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: 'The caption line to split, "text.<id>".',
          },
          atFrame: {
            type: "number",
            description:
              "Composition frame to split at — must be strictly inside the line's on-timeline window (see describe_video / inspect_layers for windows).",
          },
        },
        required: ["elementId", "atFrame"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_caption_lines",
      description:
        "Merge two or more caption lines into one. The earliest line survives with the union window and the time-ordered texts joined by spaces; the others are removed. All lines must share one flavour — every one welded to the SAME clip, or every one standalone — and no other caption line on that track may sit inside the merged span (move or include it first).",
      parameters: {
        type: "object",
        properties: {
          elementIds: {
            type: "array",
            items: { type: "string" },
            description: 'Two or more caption lines, each "text.<id>".',
          },
        },
        required: ["elementIds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_layer",
      description:
        "Set the human-readable name of a video / image / shape / text layer — the label shown in the Inspector, and the basis for the layer's auto-derived <morpha-video> embed attribute (so renaming a layer to \"caption\" makes the embed attribute `caption`). Pass an empty string to clear the name. For groups use rename_group.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "video.<id>, image.<id>, shapes.<id>, or text.<id>.",
          },
          name: {
            type: "string",
            description:
              "New label. Empty string clears it (callers fall back to the filename stem).",
          },
        },
        required: ["elementId", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_loop",
      description:
        "Set the project's loop section: the whole composition repeats once per value, with one field of one layer varying across the repeats. Builds one pass per value, each setting `field` of `elementId` to that value — e.g. a caption text layer cycling through several strings. Pass an empty `values` array to clear the loop (the comp plays once).",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description:
              "Target layer — text.<id>, image.<id>, shapes.<id>, or video.<id>.",
          },
          field: {
            type: "string",
            description:
              'The layer field each pass overrides — e.g. "text", "text_color", "filename". Defaults to "text".',
          },
          values: {
            type: "array",
            items: { type: "string" },
            description:
              "One value per loop pass. Empty array clears the loop.",
          },
        },
        required: ["elementId", "values"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_canvas_size",
      description:
        "Resize the ACTIVE page's canvas to width × height pixels. The composition is scaled UNIFORMLY to fit the new frame (a single factor s = min(newW/oldW, newH/oldH), so nothing distorts — a circle stays a circle) and then re-centred so the old composition centre maps to the new canvas centre. Every layer's position, size, group pivots, and x/y/width/height keyframes follow this fit+recentre; same-aspect resizes scale exactly, aspect changes letterbox the content centred. Each page owns its size, so this leaves sibling pages untouched — select_page then set_canvas_size again to resize another one. Common sizes: 1080×1920 (9:16 Reels/TikTok/Shorts), 1080×1350 (4:5 Instagram), 1080×1080 (1:1 square), 1920×1080 (16:9 YouTube).",
      parameters: {
        type: "object",
        properties: {
          width: {
            type: "number",
            description: "Canvas width in px (positive integer).",
          },
          height: {
            type: "number",
            description: "Canvas height in px (positive integer).",
          },
        },
        required: ["width", "height"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_image_filename",
      description:
        "Repoint an existing image layer at a different uploaded asset — keeps the layer's id, position, size, animations, and styles; only the bitmap changes. The asset must already exist at users/<userId>/assets/<projectId>/<filename> (uploaded via the editor's drag-drop, or POST /api/upload-asset/<projectId> with the raw bytes and an X-Filename header). Use this to swap a layer's image WITHOUT losing its keyframes — `remove_layer` + `add_image_layer` would mint a new id and drop the animations.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "Image layer id, image.<id>.",
          },
          filename: {
            type: "string",
            description:
              "Asset filename in the project's assets bucket, e.g. drake.png.",
          },
        },
        required: ["elementId", "filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_video_clip",
      description:
        "Repoint an existing video layer at a different uploaded clip — keeps the layer's id, position, size, animations, styles, and trim window; only the source mp4 changes. The clip must already exist at users/<userId>/clips/<projectId>/<clip> (uploaded via the editor's '+ Add video' button or /api/upload-clip). Use this to swap a video layer's source WITHOUT losing its keyframes.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "Video layer id, video.<id>.",
          },
          clip: {
            type: "string",
            description:
              "Clip filename in the project's clips bucket, e.g. mickey-tiktok.mp4.",
          },
        },
        required: ["elementId", "clip"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_matte_source",
      description:
        "Set (or clear) a track matte — the host shows only where the matte source is opaque. The HOST can be a leaf (image.<id>, video.<id>, shapes.<id>, text.<id>) OR a group.<id> (a group is a layer of sorts): a group host clips ALL its composited children to the source shape's path — e.g. a marching chevron strip + black backing shown only inside an arrow / band shape. For a leaf host the source can be any leaf (use a text.<id> source for video-/image-filled letterforms); for a group host the source must be a shape (shapes.<id>). Make the source layer hidden so it acts purely as the stencil. Pass null to clear.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "Host being masked: image/video/shapes/text.<id>, or group.<id>.",
          },
          matte_source_id: {
            type: ["string", "null"],
            description:
              "Element id of the layer whose alpha drives the mask, or null to clear.",
          },
          matte_inverted: {
            type: "boolean",
            description:
              "Optional. Invert the mask (knock-out): the host shows everywhere EXCEPT where the source is opaque — a punch-through / spotlight. Honored on leaf hosts; ignored on group hosts. Omitted = preserve current; clearing the mask resets it.",
          },
        },
        required: ["elementId", "matte_source_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "freeze_frame",
      description:
        "Freeze the picture at a frame: the clip is CUT there and a still of that frame is inserted between the halves, pushing everything after it later (the NLE 'frame hold'). This is how you hold a moment — play, freeze, continue. The still is an ordinary IMAGE layer showing that frame for `holdFrames` (default 150 = 5s at 30fps), so you resize, split, move or delete it like any other layer. `image` is the filename of a PNG of that frame, already uploaded to the project's assets — rendering one needs a browser, so capture and upload it first. The reply's `frozenSourceFrame` is the SOURCE frame that was frozen, which differs from `frame` on a retimed clip. `frame` must be strictly inside the clip.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "video.<id> to freeze." },
          frame: {
            type: "number",
            description:
              "Project-timeline frame to freeze at — must be strictly inside the clip.",
          },
          image: {
            type: "string",
            description:
              "Filename of an already-uploaded PNG of the frozen frame, in the project's assets.",
          },
          holdFrames: {
            type: "number",
            description:
              "How long the still holds, in frames. Defaults to 150 (5s at 30fps), the same default every added clip gets.",
          },
        },
        required: ["elementId", "frame", "image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_clip_speed",
      description:
        "Play a clip slower or faster at a CONSTANT rate — the normal way to retime a clip. 1 = source speed, 0.5 = half speed, 2 = double speed; range [0.1, 8]. The trim is unchanged, so the clip's length on the timeline changes to suit: at 0.5x it occupies twice as many frames, at 2x half as many. Audio is time-stretched with pitch preserved. Use add_speed_keyframe instead only when the rate must CHANGE over the clip (a ramp).",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "video.<id>." },
          speed: {
            type: "number",
            description:
              "Constant playback rate (1 = source speed, 0.5 = half, 2 = double), in [0.1, 8].",
          },
        },
        required: ["elementId", "speed"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_speed_keyframe",
      description:
        "Add or overwrite a speed-ramp (time-remap) keyframe on a video layer, for a rate that CHANGES over the clip. `frame` is a PROJECT-timeline frame and must sit on the clip (at or after its timeline_start_frame); the curve itself is anchored to the clip, so moving the clip carries the ramp with it and never changes its duration. For a constant slower/faster clip use set_clip_speed instead. `rate` is the playback rate at `frame`: 1 = real-time, 0.5 = half-speed, 2 = double-speed. Range: rate in [0.1, 8]. The ramp multiplies the layer's constant speed, and the clip's timeline length is derived from the resulting curve.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "video.<id>." },
          frame: { type: "number", description: "Project-timeline frame number." },
          rate: {
            type: "number",
            description: "Playback rate at this frame (1 = real-time, in [0.1, 8]).",
          },
        },
        required: ["elementId", "frame", "rate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_speed_keyframe",
      description:
        "Remove the speed-ramp keyframe at `frame` (a PROJECT-timeline frame — the same value add_speed_keyframe and inspect_layers report) on a video layer. Removing the last keyframe clears the speed_keyframes array entirely (restoring 1× playback).",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "video.<id>." },
          frame: { type: "number", description: "Project-timeline frame number." },
        },
        required: ["elementId", "frame"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_video_layer_muted",
      description:
        "Mute or unmute a video layer's baked audio (silenced in both preview and export). The processing pipeline's audio-split step sets this true after demuxing the clip's audio into a standalone overlay track (NLE-style linked A/V), so the source audio doesn't double with the overlay. Pass muted:false to restore the baked audio.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "Video layer id, video.<id>." },
          muted: {
            type: "boolean",
            description: "true silences the layer's baked audio; false restores it.",
          },
        },
        required: ["elementId", "muted"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_page",
      description:
        "Append a page to the project — works on any project, turning a single-page video into a multi-page one. Without duplicate_index a blank page is appended, sized to the project's canvas. With duplicate_index the page at that position is deep-copied (a fresh id is minted). There is no limit on page count. The new page becomes the active page; its index is returned.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Optional name for the new page.",
          },
          duplicate_index: {
            type: "number",
            description:
              "Optional. 0-based index of an existing page to deep-copy instead of appending a blank one.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_page",
      description:
        "Remove the page at `index`. Fails on an out-of-range index or when only one page remains — a project must keep at least one page. The active page stays active; when the active page itself is deleted, active_index falls to the neighbouring page (the one that slid into its position, or the new last page).",
      parameters: {
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "0-based index of the page to remove.",
          },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_pages",
      description:
        "Move a page from `from_index` to `to_index`. The remaining pages shift to fill the gap; active_index is rewritten so it keeps pointing at the same page it did before the move. Fails on out-of-range indices.",
      parameters: {
        type: "object",
        properties: {
          from_index: {
            type: "number",
            description: "0-based index of the page to move.",
          },
          to_index: {
            type: "number",
            description: "0-based destination index for the page.",
          },
        },
        required: ["from_index", "to_index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_page",
      description:
        "Switch which page is ACTIVE — the page the content tools target. Subsequent describe_video / inspect_layers / all content tools read and write this page until the active page changes again. Pages are addressed by 0-based index from describe_video's pages block. Selecting the already-active page is a harmless no-op; fails on an out-of-range index.",
      parameters: {
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "0-based index of the page to make active.",
          },
        },
        required: ["index"],
      },
    },
  },
];
