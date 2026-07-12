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
// Cross-tree import: the font catalogues live in editor/src/ (the editor is
// their primary consumer); the agent-facing list_fonts tool reuses them so
// every source the picker knows about is also discoverable via MCP.
import {
  allFontEntries,
  getFontEntry,
  type FontSource,
} from "./font-sources.ts";
import { blankPage } from "./carousel.ts";
import { fitCurveBox } from "./curve-bbox.ts";
import {
  clampCurve,
  fillSchema,
  findLayerByElementId,
  findParentGroup,
  getGroupDescendants,
  isMorphaGroup,
  materializeRootLayerOrder,
  projectSchema,
  resolveDefaultTextSize,
  resolveLayerTree,
  type AudioOverlay,
  type ColorKeyframe,
  type Easing,
  type ElementColorTracks,
  type ElementTracks,
  type Fill,
  type Group,
  type ImageLayer,
  type Keyframe,
  type LayerStyle,
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

export type ToolOutcome = {
  project: Project;
  result: ToolResult;
};

export type ToolDispatch<Args = Record<string, unknown>> = (
  project: Project,
  args: Args,
) => ToolOutcome;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const cloneProject = (p: Project): Project =>
  structuredClone(p) as Project;

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
  project: Project,
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
  project: Project,
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
  project: Project,
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
};

// Force project.layer_order to be a complete list of root-level element ids,
// in the same order resolveLayerTree would return. The schema permits the
// resolver to invent missing entries (so old files round-trip cleanly), but
// dispatchers that splice into the root list need a definite ordering — call
// this on the cloned project before any layer_order mutation.
const normalizeRoot = (project: Project): void => {
  project.layer_order = resolveLayerTree(project).map((n) => n.id);
};

// Base-position centre of a child element. Used to seed a new group's pivot.
// Returns null for unknown ids; the caller defaults to the canvas centre.
const childBaseCenter = (
  project: Project,
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

export type LayerKind = "image" | "video" | "text" | "shapes" | "group";

const allLayerIdsForKind = (project: Project, kind: LayerKind): Set<string> => {
  const out = new Set<string>();
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
  for (const l of arr) out.add(l.id);
  return out;
};

export const generateLayerId = (project: Project, kind: LayerKind): string => {
  const existing = allLayerIdsForKind(project, kind);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const buf = new Uint8Array(3);
    crypto.getRandomValues(buf);
    const id = Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!existing.has(id)) return id;
  }
  // 100 collisions in a row on a 16M-id space is astronomically unlikely;
  // throw rather than spin forever if the rng is broken.
  throw new Error(
    `generateLayerId: 100 collisions on ${kind} (existing=${existing.size})`,
  );
};

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
  project: Project,
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
};

// Drop every dangling reference to `elementId` once its primary layer object
// has been spliced out by the caller. The deletion-mirror of rekeyElementId —
// it MUST cover the same reference sites (2–7; site 1, the layer's own record,
// is the caller's splice, which also carries off its per-element animations /
// style / track_loops / color_tracks). When a reference site is added to
// rekeyElementId, add it here too.
const purgeElementId = (project: Project, elementId: string): void => {
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
  project: Project,
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
  host: Project,
  source: Project,
  opts: InlineMorphaOptions,
): ToolOutcome => {
  if (!opts.sourceMorphaId) {
    return { project: host, result: { ok: false, error: "sourceMorphaId is required" } };
  }
  if (opts.sourceMorphaId === host.project_id) {
    return { project: host, result: { ok: false, error: "a morpha can't embed itself" } };
  }

  const next = cloneProject(host);
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
  const displayName = opts.sourceName ?? src.name ?? "";
  next.groups = [
    ...next.groups,
    {
      id: bandId,
      name: displayName,
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
  project: Project,
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

// Add `delta` to a group's frame-0 x/y translation (groups have no static base
// position, so a paste offset lives on the translation track). Mirrors the
// store's group-nudge so a pasted group can be dragged clear of the original.
const bumpGroupFrameZero = (
  project: Project,
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
  dest: Project,
  bundle: SubtreeBundle,
  opts: { sourceProjectId: string; offset?: number },
): { project: Project; rootElementId: string; pendingMedia: PendingMedia[] } => {
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
  } as unknown as Project;

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
  let source: Project;
  try {
    source = projectSchema.parse(args.source_project);
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
  host: Project,
  bandGroupId: string,
  freshSource: Project,
  pin: InlineMorphaOptions,
): ToolOutcome => {
  const old = host.groups.find((g) => g.id === bandGroupId);
  if (!old || !isMorphaGroup(old)) {
    return { project: host, result: { ok: false, error: "not an embedded morpha band" } };
  }
  const oldEid = `group.${bandGroupId}`;
  const oldIdx = host.layer_order.indexOf(oldEid);

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
  stripped.layer_order = stripped.layer_order.filter((id) => !toRemove.has(id));

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
  // Restore the band's original z-order slot (inlineMorpha appended it at end).
  inlined.layer_order = inlined.layer_order.filter((id) => id !== data.elementId);
  const idx = oldIdx >= 0 ? Math.min(oldIdx, inlined.layer_order.length) : inlined.layer_order.length;
  inlined.layer_order.splice(idx, 0, data.elementId);

  return { project: inlined, result };
};

// ---------------------------------------------------------------------------
// describe_video
// ---------------------------------------------------------------------------

// Locate the canvas-backdrop image_layer id ("background" by convention,
// but tolerant of migrated projects where the id may differ). Returns null
// only for a project that's never been through `projectSchema.parse` — the
// preprocess guarantees one exists.
const findBackgroundLayer = (project: Project): ImageLayer | null => {
  for (const l of project.image_layers) {
    if (l.is_background) return l;
  }
  return null;
};
const backgroundElementId = (project: Project): string | null => {
  const l = findBackgroundLayer(project);
  return l ? `image.${l.id}` : null;
};
// Resolve the agent-facing alias `"background.canvas"` to the actual
// element id (`"image.<bgId>"`). Agents written against the previous
// schema keep working — they pass "background.canvas" and the dispatcher
// rewrites it on the fly. Everything else passes through unchanged.
const resolveBackgroundAlias = (
  project: Project,
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
const animatedProps = (project: Project, elementId: string): string[] => {
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
  project: Project,
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
    layer_count: layerCount,
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
  project: Project,
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
  return {
    elementId,
    type,
    ...layer,
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
};

const moveLayer: ToolDispatch<MoveLayerArgs> = (project, args) => {
  const { elementId, x, y, width, height, rotation } = args;
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

  const next = cloneProject(project);

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
  const next = cloneProject(project);
  const id = generateLayerId(next, "image");
  const layer: ImageLayer = {
    id,
    filename,
    x,
    y,
    width,
    height,
    rotation: 0,
    pivotX: 0.5,
    pivotY: 0.5,
    fill: null,
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
  const next = cloneProject(project);
  const id = generateLayerId(next, "shapes");
  const w = width ?? DEFAULT_SHAPE_W;
  const h = height ?? DEFAULT_SHAPE_H;
  const shape: Shape = {
    id,
    kind: kind as ShapeKind,
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
  next: Project,
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

type SetLayerFillArgs = { elementId: string; fill: unknown };

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
  if (coercedFill !== undefined) layer.fill = coercedFill;
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
const isValidColorTarget = (project: Project, elementId: string): boolean => {
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
  // Slide / shake values are DELTAS from the layer's base x/y; applyPreset
  // bakes the layer's base in at apply time so the keyframes that land on
  // the project are absolute canvas-space positions.
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
  const base = baseForElement(next, elementId);
  const writes: Array<{ property: TrackProperty; frame: number; value: number }> = [];
  for (const t of tuples) {
    const frame = Math.max(0, Math.round(sf + t.frame));
    const value =
      t.property === "x"
        ? base.x + t.value
        : t.property === "y"
          ? base.y + t.value
          : t.value;
    upsertKeyframe(next, elementId, t.property, frame, value, t.easing ?? "easeInOut");
    writes.push({ property: t.property, frame, value });
  }
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
    const base = baseForElement(next, elementId);
    for (const t of tuples) {
      const frame = Math.max(0, Math.round(sf + t.frame));
      const value =
        t.property === "x"
          ? base.x + t.value
          : t.property === "y"
            ? base.y + t.value
            : t.value;
      upsertKeyframe(next, elementId, t.property, frame, value, t.easing ?? "easeInOut");
    }
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
  const { filename, startFrame, gain, fadeInFrames, fadeOutFrames, endFrame } =
    args;
  if (!filename || typeof filename !== "string") {
    return { project, result: { ok: false, error: "filename is required" } };
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
  } = args;
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
  if (endFrame === null) {
    delete merged.endFrame;
  } else if (endFrame !== undefined) {
    merged.endFrame = Math.round(endFrame);
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
  target.block = { start: Math.round(start), duration: Math.round(duration) };
  return {
    project: next,
    result: { ok: true, data: { elementId, block: target.block } },
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
const clampLoopRegionToLength = (project: Project, endFrame: number): void => {
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

  // Timeline window [ws, we) a video layer occupies. we = Infinity for a
  // null (natural-end) out-point — its real length is unmeasurable headless.
  const videoWs = (l: VideoLayer): number => l.timeline_start_frame;
  const videoWe = (l: VideoLayer): number =>
    l.source_out_frame === null
      ? Infinity
      : l.timeline_start_frame + (l.source_out_frame - l.source_in_frame);

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

  const remapSpeedKeyframes = (
    layer: VideoLayer,
    pick: <T extends { frame: number }>(arr: T[]) => T[],
  ): void => {
    if (!layer.speed_keyframes || layer.speed_keyframes.length === 0) return;
    const kept = pick(layer.speed_keyframes);
    if (kept.length > 0) layer.speed_keyframes = kept;
    else delete layer.speed_keyframes;
  };

  // 1. Non-video layers: numeric + colour keyframe tracks.
  for (const layer of [
    ...next.image_layers,
    ...next.text_layers,
    ...next.shapes,
    ...next.groups,
  ]) {
    remapLayerTracks(layer, shiftKeyframes);
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
      remapSpeedKeyframes(layer, shiftKeyframes);
      continue;
    }
    if (finiteEnd && start >= we) {
      // Entirely before the cut → untouched (its frames are all < start).
      remapLayerTracks(layer, shiftKeyframes);
      remapSpeedKeyframes(layer, shiftKeyframes);
      continue;
    }
    // Overlap (ovStart < ovEnd). Speed-ramped overlaps were refused above.
    if (ovStart === ws && finiteEnd && ovEnd === we) {
      // Whole window inside the cut → delete the layer.
      deletedVideoIds.push(`video.${layer.id}`);
      continue;
    }
    if (ovStart > ws && finiteEnd && ovEnd === we) {
      // Tail-trim: keep [ws, ovStart).
      layer.source_out_frame = layer.source_in_frame + (ovStart - ws);
      remapLayerTracks(layer, shiftKeyframes);
      remapSpeedKeyframes(layer, shiftKeyframes);
      pruneIfEmptyVideo(layer);
      continue;
    }
    if (ovStart === ws && ovEnd < we) {
      // Head-trim: drop the front; content from ovEnd now plays at ovEnd-delta.
      layer.source_in_frame = layer.source_in_frame + (ovEnd - ws);
      layer.timeline_start_frame = ovEnd - delta;
      remapLayerTracks(layer, shiftKeyframes);
      remapSpeedKeyframes(layer, shiftKeyframes);
      pruneIfEmptyVideo(layer);
      continue;
    }
    // Interior split: ws < start, end < we. Left keeps [ws, ovStart); right
    // plays [ovEnd, we) at ovEnd-delta.
    const rightId = generateLayerId(next, "video");
    const right: VideoLayer = {
      ...structuredClone(layer),
      id: rightId,
      source_in_frame: layer.source_in_frame + (ovEnd - ws),
      timeline_start_frame: ovEnd - delta,
      // source_out_frame inherited (may be null → keeps the natural end).
    };
    remapLayerTracks(right, rightKeyframes);
    remapSpeedKeyframes(right, rightKeyframes);
    // Left: tail-trim + keep only the pre-cut tracks.
    layer.source_out_frame = layer.source_in_frame + (ovStart - ws);
    remapLayerTracks(layer, leftKeyframes);
    remapSpeedKeyframes(layer, leftKeyframes);
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
// /api/upload-asset). Like add_image_layer this does NOT verify an uploaded
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
  const f = Math.round(frame);
  const existing = list.findIndex((k) => k.frame === f);
  if (existing >= 0) list[existing] = { frame: f, rate };
  else list.push({ frame: f, rate });
  list.sort((a, b) => a.frame - b.frame);
  next.video_layers[idx] = { ...cur, speed_keyframes: list };
  return { project: next, result: { ok: true, data: { elementId, frame: f, rate } } };
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
  const f = Math.round(frame);
  const list = (cur.speed_keyframes ?? []).filter((k) => k.frame !== f);
  if (list.length === (cur.speed_keyframes ?? []).length) {
    return { project, result: { ok: false, error: `no speed keyframe at frame ${f} on ${elementId}` } };
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

  const next = cloneProject(project);
  const id = generateLayerId(next, "text");

  // Default text_size: shared with the editor's addTextLayer so editor- and
  // agent-created text get the SAME explicit size (see resolveDefaultTextSize).
  const resolvedTextSize =
    typeof text_size === "number" ? text_size : resolveDefaultTextSize(next);

  const layer: TextLayer = {
    id,
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
};
type AddCaptionTrackArgs = {
  lines?: unknown;
  mode?: unknown;
  style?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
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

// Shared marker prefix for caption layers (the editor's EnrichmentPanel checks
// for it to flip "Add captions" → "Captions added").
export const CAPTION_LAYER_NAME = "Captions";

const addCaptionTrack: ToolDispatch<AddCaptionTrackArgs> = (project, args) => {
  if (!Array.isArray(args.lines) || args.lines.length === 0) {
    return {
      project,
      result: { ok: false, error: "lines must be a non-empty array" },
    };
  }
  const lines: { text: string; startFrame: number; endFrame: number }[] = [];
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
    lines.push({ text, startFrame, endFrame: Math.max(startFrame + 1, endRaw) });
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
  const setName = (proj: Project, elementId: string, name: string) => {
    const id = elementId.slice("text.".length);
    const tl = proj.text_layers.find((t) => t.id === id);
    if (tl) tl.name = name;
  };
  const setBlock = (
    proj: Project,
    elementId: string,
    block: { start: number; duration: number },
  ) => {
    const id = elementId.slice("text.".length);
    const tl = proj.text_layers.find((t) => t.id === id);
    if (tl) tl.block = block;
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
      // The caption line's on-timeline window is a BLOCK: it exists only during
      // [startFrame, endFrame). No opacity envelope — the block IS the
      // visibility, so a 40-line track is 40 blocks, not 120 hold keyframes.
      setBlock(cur, elementId, {
        start: line.startFrame,
        duration: Math.max(1, line.endFrame - line.startFrame),
      });
    }
  }

  // Always wrap the caption layers in a "captions" group so a track never
  // clutters the layers list — the user collapses one group instead of wading
  // through every line. The layers were all just created at root, so they share
  // a parent (the group_layers same-parent invariant holds). buildCaptionsForClip
  // consumes the returned groupElementId rather than grouping a second time.
  let groupElementId: string | undefined;
  const grouped = groupLayers(cur, { elementIds: created, name: "captions" });
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
// Resize the composition canvas with a "fit + recenter" reflow: the whole
// composition is scaled by a SINGLE uniform factor s = min(newW/oldW,
// newH/oldH) — so nothing distorts (a circle stays a circle) — then recentred
// so the old composition centre maps to the new canvas centre. On a
// same-aspect resize the recentre term cancels and this reduces to a plain
// uniform scale. Mirrors the editor's CanvasSizePill behaviour — both the
// editor store and this tool call reflowComposition.

// Reflow a composition into a new canvas size. Pure: clones, never mutates the
// input. Leaf x/y are absolute positions (affine-mapped about the centre);
// width/height scale uniformly. A group's pivot is an absolute point (mapped
// like a position) but its x/y keyframes are TRANSLATION OFFSETS around that
// pivot, so they only scale. scale/rotation/opacity tracks are left untouched.
export const reflowComposition = (
  project: Project,
  newW: number,
  newH: number,
): Project => {
  const oldW = project.canvas_width;
  const oldH = project.canvas_height;
  const next = cloneProject(project);
  next.canvas_width = newW;
  next.canvas_height = newH;
  const s = Math.min(newW / oldW, newH / oldH);
  const mapX = (v: number): number => (v - oldW / 2) * s + newW / 2;
  const mapY = (v: number): number => (v - oldH / 2) * s + newH / 2;

  const reflowLeaf = (r: {
    x: number;
    y: number;
    width: number;
    height: number;
    animations?: ElementTracks;
  }): void => {
    r.x = mapX(r.x);
    r.y = mapY(r.y);
    r.width *= s;
    r.height *= s;
    const t = r.animations;
    if (!t) return;
    if (t.x) for (const kf of t.x) kf.value = mapX(kf.value);
    if (t.y) for (const kf of t.y) kf.value = mapY(kf.value);
    if (t.width) for (const kf of t.width) kf.value *= s;
    if (t.height) for (const kf of t.height) kf.value *= s;
  };
  for (const l of next.image_layers) {
    if (l.is_background) {
      // The pinned backdrop always covers the canvas — the renderer ignores
      // its stored rect, but keep it coherent with the new frame.
      l.x = newW / 2;
      l.y = newH / 2;
      l.width = newW;
      l.height = newH;
      continue;
    }
    reflowLeaf(l);
  }
  next.video_layers.forEach(reflowLeaf);
  next.shapes.forEach(reflowLeaf);
  next.text_layers.forEach(reflowLeaf);

  for (const g of next.groups) {
    g.pivotX = mapX(g.pivotX);
    g.pivotY = mapY(g.pivotY);
    g.box_width *= s;
    g.box_height *= s;
    const t = g.animations;
    if (!t) continue;
    // x/y are offsets from the pivot — scale only, no recentre.
    for (const prop of ["x", "y", "width", "height"] as const) {
      const kfs = t[prop];
      if (!kfs) continue;
      for (const kf of kfs) kf.value *= s;
    }
  }

  return next;
};

type SetCanvasSizeArgs = { width?: unknown; height?: unknown };

const setCanvasSize: ToolDispatch<SetCanvasSizeArgs> = (project, args) => {
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
  if (project.canvas_width === width && project.canvas_height === height) {
    return {
      project,
      result: {
        ok: true,
        data: { canvas_width: width, canvas_height: height },
      },
    };
  }
  const next = reflowComposition(project, width, height);
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
// add_page
// ---------------------------------------------------------------------------
//
// Append a page to a carousel. With duplicate_index, deep-clones that page
// (minting a fresh id); otherwise appends a blank page sized to the locked
// aspect. Sets active_index to the new page and returns its index.

type AddPageArgs = { name?: unknown; duplicate_index?: unknown };

const addPage: ToolDispatch<AddPageArgs> = (project, args) => {
  if (project.mode !== "carousel" || !project.carousel) {
    return {
      project,
      result: {
        ok: false,
        error: "add_page requires a carousel morpha",
      },
    };
  }
  const { name, duplicate_index } = args;
  if (name !== undefined && typeof name !== "string") {
    return {
      project,
      result: { ok: false, error: "name must be a string" },
    };
  }
  const pages = project.carousel.pages;
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
    page = blankPage(project.canvas_width, project.canvas_height, name);
  }
  const next = cloneProject(project);
  const carousel = next.carousel;
  if (!carousel) {
    return {
      project,
      result: { ok: false, error: "carousel record missing after clone" },
    };
  }
  carousel.pages.push(page);
  const index = carousel.pages.length - 1;
  carousel.active_index = index;
  return {
    project: next,
    result: { ok: true, data: { index, page_count: carousel.pages.length } },
  };
};

// ---------------------------------------------------------------------------
// delete_page
// ---------------------------------------------------------------------------
//
// Remove a page from a carousel. Refuses to drop below 1 page. The active
// page is tracked by id across the splice — deleting a page before it must
// not silently retarget active_index at a different page. Only when the
// active page itself is deleted does active_index fall to the page that slid
// into its position (or the new last page).

type DeletePageArgs = { index?: unknown };

const deletePage: ToolDispatch<DeletePageArgs> = (project, args) => {
  if (project.mode !== "carousel" || !project.carousel) {
    return {
      project,
      result: {
        ok: false,
        error: "delete_page requires a carousel morpha",
      },
    };
  }
  const { index } = args;
  const pages = project.carousel.pages;
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
      result: { ok: false, error: "a carousel must keep at least 1 page" },
    };
  }
  const next = cloneProject(project);
  const carousel = next.carousel;
  if (!carousel) {
    return {
      project,
      result: { ok: false, error: "carousel record missing after clone" },
    };
  }
  const activePageId = carousel.pages[carousel.active_index]?.id;
  carousel.pages.splice(index, 1);
  const survivingIndex = carousel.pages.findIndex(
    (p) => p.id === activePageId,
  );
  carousel.active_index =
    survivingIndex >= 0
      ? survivingIndex
      : Math.min(index, carousel.pages.length - 1);
  return {
    project: next,
    result: {
      ok: true,
      data: {
        index,
        active_index: carousel.active_index,
        page_count: carousel.pages.length,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// reorder_pages
// ---------------------------------------------------------------------------
//
// Move a page from one position to another. active_index is rewritten so it
// keeps pointing at the same page it did before the move.

type ReorderPagesArgs = { from_index?: unknown; to_index?: unknown };

const reorderPages: ToolDispatch<ReorderPagesArgs> = (project, args) => {
  if (project.mode !== "carousel" || !project.carousel) {
    return {
      project,
      result: {
        ok: false,
        error: "reorder_pages requires a carousel morpha",
      },
    };
  }
  const { from_index, to_index } = args;
  const pages = project.carousel.pages;
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
  const carousel = next.carousel;
  if (!carousel) {
    return {
      project,
      result: { ok: false, error: "carousel record missing after clone" },
    };
  }
  const activeId = carousel.pages[carousel.active_index].id;
  const [moved] = carousel.pages.splice(from_index, 1);
  carousel.pages.splice(to_index, 0, moved);
  carousel.active_index = carousel.pages.findIndex((p) => p.id === activeId);
  return {
    project: next,
    result: {
      ok: true,
      data: {
        from_index,
        to_index,
        active_index: carousel.active_index,
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
  move_band: moveBand as ToolDispatch<never>,
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
  rename_layer: renameLayer as ToolDispatch<never>,
  set_loop: setLoop as ToolDispatch<never>,
  set_canvas_size: setCanvasSize as ToolDispatch<never>,
  set_image_filename: setImageFilename as ToolDispatch<never>,
  set_video_clip: setVideoClip as ToolDispatch<never>,
  set_video_layer_muted: setVideoLayerMuted as ToolDispatch<never>,
  set_matte_source: setMatteSource as ToolDispatch<never>,
  add_speed_keyframe: addSpeedKeyframe as ToolDispatch<never>,
  remove_speed_keyframe: removeSpeedKeyframe as ToolDispatch<never>,
  add_page: addPage as ToolDispatch<never>,
  delete_page: deletePage as ToolDispatch<never>,
  reorder_pages: reorderPages as ToolDispatch<never>,
};

export const TOOL_DEFINITIONS: ToolFunction[] = [
  {
    type: "function",
    function: {
      name: "describe_video",
      description:
        "Structural OVERVIEW of the composition (the table of contents) — canvas size, duration, the backdrop summary, and a z-ordered tree (top of stack first) of every layer with its elementId, type, name, type label (filename/clip/text/kind), geometry (x/y/width/height), and which properties are animated. Does NOT include keyframe values or styles — those are unbounded. Start here, then call inspect_layers([elementId, …]) for full detail on the specific layers you'll change. Don't guess keyframe/style values from this overview.",
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
        "Set static position/size/rotation of a layer. Writes x/y/w/h/rotation directly on image.<id>, video.<id>, and shapes.<id>; for group.<id> sets pivotX/pivotY (no width/height/rotation — use add_keyframe for group rotation). Note: when a layer has an x / y / rotation keyframe track, the track OVERRIDES the static value at every frame with a keyframe — use add_keyframe to animate, move_layer to set the un-animated default.",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "video.<id>, image.<id>, shapes.<id>, or group.<id>.",
          },
          x: { type: "number", description: "Centre x in 1080-wide base coords." },
          y: { type: "number", description: "Centre y in 1920-tall base coords." },
          width: { type: "number", description: "Width in px (must be > 0)." },
          height: { type: "number", description: "Height in px (must be > 0)." },
          rotation: { type: "number", description: "Rotation in degrees, clockwise." },
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
        "Add an image layer. The asset must already exist at users/<userId>/assets/<projectId>/<filename> (uploaded via the editor's drag-drop or /api/upload-asset). To duplicate an existing layer, reuse its filename — the editor auto-assigns a fresh id.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Asset filename in the project's assets bucket, e.g. star.png." },
          x: { type: "number", description: "Centre x in 1080-wide base coords." },
          y: { type: "number", description: "Centre y in 1920-tall base coords." },
          width: { type: "number", description: "Width in px (must be > 0)." },
          height: { type: "number", description: "Height in px (must be > 0)." },
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
        "Set a layer's fill. The canvas backdrop is the pinned is_background image_layer (its element id is exposed via describe_video as background.elementId; the literal 'background.canvas' is also accepted as a synonym); null is rejected on the backdrop. Shapes require a Fill (null/missing is rejected). Image / video / group layers accept a Fill object (or `#rrggbb` hex) to paint a backdrop, or `null` to clear it. Shapes paint their body; image/video paint behind the bitmap; groups paint a rect centred on the pivot sized by (box_width, box_height).",
      parameters: {
        type: "object",
        properties: {
          elementId: {
            type: "string",
            description: "shapes.<id> / image.<id> / video.<id> / group.<id>. The pinned is_background image_layer is the canvas backdrop; the literal 'background.canvas' is accepted as a synonym.",
          },
          fill: {
            description:
              'Either \'#rrggbb\' (promoted to solid) or a Fill object: {type:"solid",color} / {type:"linear",stops:[{pos:0..1,color}],angle?} / {type:"radial",stops:[{pos:0..1,color}],cx?,cy?,radius?} / {type:"mask",layer_id,color}. A gradient is ONE fill — don\'t fake it with stacked shapes. null (image/video/group only) clears the backdrop.',
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
        "Add or update the rounded background box behind a TEXT layer (text.<id>) in one call — sets the backdrop fill plus the box's padding, corner radius, and optional stroke. Pass only the fields you want to change. Pair with text_autofit \"hug\" (via set_layer_text) so the box shrink-wraps the text instead of using the layer's fixed frame — ideal for caption / sticker chips. Pass fill null to remove the box. Text layers only; for shapes/images/video use set_layer_fill.",
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
        "Wrap sibling elements in a new group. The group composes its x/y/scale/rotation/opacity onto its descendants and pivots rotate/scale at its (pivotX, pivotY), seeded to the centroid of its children at create time. The group's x/y track values are translation offsets applied around the pivot — groups have no static body of their own. All listed elementIds must currently share the same parent (root, or one existing group).",
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
        "Ripple-delete a time window [startFrame, endFrame) — remove that span and pull all later content earlier by delta = endFrame - startFrame (the NLE 'ripple delete' / 'close gap'). Shifts every keyframe, colour keyframe, speed keyframe, marker, audio overlay, loop region, and start_at through the cut, and is SOURCE-AWARE for video layers: a clip that straddles the cut is trimmed, and one whose interior is removed is SPLIT into two layers. Audio overlays interior to the cut are truncated at the seam (overlays have no source-in to bridge the gap). REFUSES to cut across a video layer that carries speed-ramp keyframes — remove them, or cut outside that layer's span, first. The composition length shrinks accordingly (an authored length loses only the overlap with its visible region). Frames are 0-indexed project-timeline frames at 30 fps; endFrame is exclusive and clamped to the composition length.",
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
        "Register a typeface Morpha does NOT ship, so text layers can use it by family name via font_family (exactly like a built-in family). Families already in the built-in catalogs (anything list_fonts returns from google/bunny/fontshare/fontsource/velvetyne) are REJECTED — they need no registration; just set font_family to them directly. `src` is EITHER a full URL (https://…) OR a font file already uploaded to the project's asset bucket (/api/upload-asset; .woff2/.woff/.ttf/.otf). Like add_image_layer, this does NOT verify an uploaded filename exists. Dedupes by family+weight+style, replacing a matching face. After registering, set a text layer's font_family to this family (add_text_layer / set_layer_text). NOTE: a pasted URL only loads if that host sends permissive CORS headers — uploading the font (served same-origin) is the robust path.",
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
        },
        required: ["lines"],
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
        "Resize the composition canvas to width × height pixels. The composition is scaled UNIFORMLY to fit the new frame (a single factor s = min(newW/oldW, newH/oldH), so nothing distorts — a circle stays a circle) and then re-centred so the old composition centre maps to the new canvas centre. Every layer's position, size, group pivots, and x/y/width/height keyframes follow this fit+recentre; same-aspect resizes scale exactly, aspect changes letterbox the content centred. Common sizes: 1080×1920 (9:16 Reels/TikTok/Shorts), 1080×1350 (4:5 Instagram), 1080×1080 (1:1 square), 1920×1080 (16:9 YouTube).",
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
        "Repoint an existing image layer at a different uploaded asset — keeps the layer's id, position, size, animations, and styles; only the bitmap changes. The asset must already exist at users/<userId>/assets/<projectId>/<filename> (uploaded via the editor's drag-drop or /api/upload-asset). Use this to swap a layer's image WITHOUT losing its keyframes — `remove_layer` + `add_image_layer` would mint a new id and drop the animations.",
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
      name: "add_speed_keyframe",
      description:
        "Add or overwrite a speed-ramp (time-remap) keyframe on a video layer. `rate` is the playback rate at `frame`: 1 = real-time, 0.5 = half-speed, 2 = double-speed. Range: rate in [0.1, 8].",
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
        "Remove the speed-ramp keyframe at `frame` on a video layer. Removing the last keyframe clears the speed_keyframes array entirely (restoring 1× playback).",
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
        "Append a page to the carousel (carousel mode only). Without duplicate_index a blank page is appended, sized to the project's canvas. With duplicate_index the page at that position is deep-copied (a fresh id is minted). There is no limit on page count. The new page becomes the active page; its index is returned.",
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
        "Remove the page at `index` from the carousel (carousel mode only). Fails on an out-of-range index or when only one page remains — a carousel must keep at least one page. The active page stays active; when the active page itself is deleted, active_index falls to the neighbouring page (the one that slid into its position, or the new last page).",
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
        "Move a page from `from_index` to `to_index` within the carousel (carousel mode only). The remaining pages shift to fill the gap; active_index is rewritten so it keeps pointing at the same page it did before the move. Fails on out-of-range indices.",
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
];
