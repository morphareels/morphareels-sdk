// Edge transitions — how a layer enters at the start of its on-timeline window
// and leaves at the end, instead of popping.
//
// WHY THIS IS NOT KEYFRAMES. `fade_layer` and `apply_preset`'s fade-in/fade-out
// write opacity keyframes at ABSOLUTE frames. They are destructive (they
// overwrite whatever opacity the user authored), they clutter the Timeline
// lanes with dots the user didn't place, and — the fatal one — they do not move
// when the edge moves. Trim the clip and the fade is stranded mid-shot. An edge
// transition stores only a LENGTH and a LOOK, and resolves against whatever
// window the layer has at sample time, so it rides every trim, slide and (for a
// welded caption) clip retime for free.
//
// WHY IT IS A MULTIPLIER. `edgeTransitionAt` returns factors that compose ON TOP
// of the layer's own sampled transform, never a replacement. A layer animated
// to 0.5 opacity that also fades in ramps 0 → 0.5, not 0 → 1. The same reason
// makes the group case fall out for free: a group's factors are applied to the
// group's own transform, which every descendant already composes through, so a
// group fade dims its subtree as one unit without any per-child bookkeeping.
//
// SINGLE CALL SITE. This is applied in exactly one place — `evalStyle` in
// editor/src/renderer.ts — which is what both the canvas draw path and
// `sampleLayerTransformAtFrame` (and therefore the DOM preview, the export, and
// `paintedOpacityAt`'s hit-testing) read. Applying it anywhere else, or in more
// than one place, is how pixels and hit-boxes drift apart. Pinned by
// test/transition-call-site.test.ts.
import { easeUnit } from "./animation.ts";
import {
  ALWAYS_PRESENT_DURATION,
  ancestorBandOriginSum,
  effectiveWindowOf,
  layerOf,
  type Composition,
  type EdgeTransition,
  type Easing,
  type TransitionDirection,
  type TransitionKind,
} from "./schemas.ts";

/**
 * How long a "to playhead" ramp on this edge would be — or `null` if the
 * gesture can't apply here.
 *
 * ONE ANSWER, TWO CONSUMERS. The store action applies it; the Inspector's
 * button enables on it. They must not each decide, because "enabled" and
 * "would actually do something" disagreeing is a click that visibly does
 * nothing — and this codebase has just been bitten by the same class one layer
 * down (two components computing a bar edge's ownership and silently
 * disagreeing, see editor/src/bar-edge-geometry.ts).
 *
 * The non-obvious refusal is the last one. The two ramps can't jointly outgrow
 * the window — past that the renderer squeezes both, so the result wouldn't be
 * the one the playhead promised — and the Inspector's own Length field lets the
 * OTHER edge take the whole window. So a perfectly legal panel state can leave
 * no room here at all, with the playhead sitting comfortably inside the layer.
 *
 * Pure, so the SDK and the worker can ask it too.
 */
export const fadeToPlayheadFrames = (
  project: Composition,
  elementId: string,
  currentFrame: number,
  edge: "in" | "out",
): number | null => {
  const layer = layerOf(project, elementId);
  if (!layer) return null;
  // effectiveWindowOf, not blockOf: a video clip carries no block and its edges
  // come from the trim. The wrong resolver hands back an ALWAYS_PRESENT window
  // for exactly the layer class whose edges get faded most.
  const win = effectiveWindowOf(project, elementId);
  if (!Number.isFinite(win.duration) || win.duration <= 0) return null;
  const end = win.start + win.duration;
  // Strictly inside: ON an edge the ramp would be zero-length (a cut), and past
  // it the ramp would outlive the layer.
  if (currentFrame <= win.start || currentFrame >= end) return null;
  const other = edge === "in" ? layer.transition_out : layer.transition_in;
  const otherFrames = other && other.kind !== "cut" ? other.frames : 0;
  const max = Math.max(0, Math.floor(win.duration) - otherFrames);
  const frames = Math.min(
    Math.round(edge === "in" ? currentFrame - win.start : end - currentFrame),
    max,
  );
  return frames > 0 ? frames : null;
};

/** Ramp length written onto a newly added overlay layer. ~0.2 s at 30 fps —
 * long enough to read as motion, short enough that it never feels like a
 * transition the user has to wait through on a 6-second video. */
export const DEFAULT_OVERLAY_TRANSITION_FRAMES = 6;

/** Ramp length a video clip gets when the user turns a transition ON. Longer
 * than an overlay's: a shot dissolving reads as deliberate, and 1/3 s is the
 * conventional dissolve length. Video clips ship with NO transition (see
 * `bornLayerDefaults`) — this is only the length the first click picks. */
export const DEFAULT_VIDEO_TRANSITION_FRAMES = 10;

/** How far a "slide" travels, as a fraction of the canvas's long edge. */
const SLIDE_TRAVEL_FRACTION = 0.12;

/** "pop" scales up from this factor to 1 (and back down on the way out). */
const POP_FROM_SCALE = 0.8;

// Per-kind default curves. Entries decelerate into place (outQuart / outBack);
// exits accelerate away (easeInOut / inBack) — the standard asymmetry, and the
// same curves apply_preset's fade-in/fade-out already use, so a preset and an
// edge transition of the same name look alike.
const DEFAULT_CURVE_IN: Record<TransitionKind, Easing> = {
  cut: "linear",
  fade: "outQuart",
  slide: "outQuart",
  pop: "outBack",
};

const DEFAULT_CURVE_OUT: Record<TransitionKind, Easing> = {
  cut: "linear",
  fade: "easeInOut",
  slide: "easeInOut",
  pop: "inBack",
};

/** The factors an edge transition contributes at one frame. Identity when no
 * transition applies, so callers can multiply unconditionally. */
export interface TransitionFactors {
  opacity: number;
  scale: number;
  dx: number;
  dy: number;
}

const IDENTITY: TransitionFactors = { opacity: 1, scale: 1, dx: 0, dy: 0 };

/** A transition that contributes nothing — an explicit cut, or a zero-length
 * ramp. Both mean "hard edge", and both must be honoured: `kind: "cut"` is how
 * the UI records a deliberate hard cut, and `frames: 0` is how dragging the
 * Timeline handle all the way back to the edge records the same intent. */
const isInert = (t: EdgeTransition | undefined): boolean =>
  !t || t.kind === "cut" || t.frames <= 0;

/**
 * The ramp lengths actually used at `windowFrames`, after the proportional
 * squeeze.
 *
 * A transition is a REQUEST. When the window is too short to hold both ramps,
 * they are scaled down together — preserving their ratio, so a long in + short
 * out stays a long in + short out — rather than one eating the other or the
 * trim being refused. Crucially this happens at SAMPLE time and never writes
 * back, so trimming a layer to 4 frames and back out to 60 restores the ramps
 * the user asked for. A destructive clamp would have quietly deleted them.
 *
 * Sub-2-frame windows get no ramp at all: there is no room for one, and a
 * 1-frame "fade" is just a dimmer frame.
 */
export const resolveEdgeFrames = (
  inFrames: number,
  outFrames: number,
  windowFrames: number,
): { inFrames: number; outFrames: number } => {
  const a = Math.max(0, Math.floor(inFrames));
  const b = Math.max(0, Math.floor(outFrames));
  if (a + b === 0) return { inFrames: 0, outFrames: 0 };
  if (!Number.isFinite(windowFrames) || windowFrames >= a + b) {
    return { inFrames: a, outFrames: b };
  }
  if (windowFrames < 2) return { inFrames: 0, outFrames: 0 };
  const k = windowFrames / (a + b);
  // Floor, then floor each to at least 1 when it was non-zero, so a squeezed
  // transition never silently becomes a cut while the UI still shows a ramp.
  const sa = a === 0 ? 0 : Math.max(1, Math.floor(a * k));
  const sb = b === 0 ? 0 : Math.max(1, Math.floor(b * k));
  // The two floors can still overshoot by one on a tight window; take it off
  // the longer ramp so the shorter one keeps its (already minimal) presence.
  const over = sa + sb - windowFrames;
  if (over <= 0) return { inFrames: sa, outFrames: sb };
  return sa >= sb
    ? { inFrames: Math.max(0, sa - over), outFrames: sb }
    : { inFrames: sa, outFrames: Math.max(0, sb - over) };
};

/** Slide offset for a direction, at eased progress `e` (1 = in position). */
const slideOffset = (
  direction: TransitionDirection | undefined,
  travel: number,
  e: number,
): { dx: number; dy: number } => {
  const d = (1 - e) * travel;
  switch (direction ?? "left") {
    case "left":
      return { dx: -d, dy: 0 };
    case "right":
      return { dx: d, dy: 0 };
    case "up":
      return { dx: 0, dy: -d };
    case "down":
      return { dx: 0, dy: d };
  }
};

/** Factors for one edge at eased progress `e` (0 = fully out, 1 = fully in). */
const factorsFor = (
  t: EdgeTransition,
  e: number,
  project: Composition,
): TransitionFactors => {
  switch (t.kind) {
    case "cut":
      return IDENTITY;
    case "fade":
      return { opacity: e, scale: 1, dx: 0, dy: 0 };
    case "pop":
      // Opacity ramps with the scale so the overshoot of outBack reads as a
      // pop rather than a solid block jumping size.
      return {
        opacity: Math.min(1, Math.max(0, e)),
        scale: POP_FROM_SCALE + (1 - POP_FROM_SCALE) * e,
        dx: 0,
        dy: 0,
      };
    case "slide": {
      const travel =
        Math.max(project.canvas_width, project.canvas_height) * SLIDE_TRAVEL_FRACTION;
      const { dx, dy } = slideOffset(t.direction, travel, e);
      return { opacity: Math.min(1, Math.max(0, e)), scale: 1, dx, dy };
    }
  }
};

/**
 * The transition factors for `elementId` at composition `frame`.
 *
 * `frame` is the RAW composition frame; the layer's window is expressed in its
 * PARENT timeline, so the ancestor band origin is subtracted first — the same
 * convention `frameOutsideOwnBlock` uses. Getting this wrong would put the
 * ramps at the wrong end of every layer inside an embedded morpha band.
 *
 * Returns identity — never null — so the call site can multiply unconditionally
 * with no branch.
 */
export const edgeTransitionAt = (
  project: Composition,
  elementId: string,
  frame: number,
): TransitionFactors => {
  // `layerOf` is the per-Project-identity cached index — this runs for every
  // element on every frame, so the O(n) scan is not an option.
  const layer = layerOf(project, elementId);
  if (!layer) return IDENTITY;
  const tIn = layer.transition_in;
  const tOut = layer.transition_out;
  if (isInert(tIn) && isInert(tOut)) return IDENTITY;

  const win = effectiveWindowOf(project, elementId);
  // An always-present layer has no edges to transition at. Treating its start
  // as frame 0 would make every legacy blockless layer suddenly fade in at the
  // top of the composition — a retroactive render change, which is exactly what
  // this feature promises not to do.
  if (!Number.isFinite(win.duration) || win.duration === ALWAYS_PRESENT_DURATION) {
    return IDENTITY;
  }
  if (win.duration <= 0) return IDENTITY;

  const { inFrames, outFrames } = resolveEdgeFrames(
    isInert(tIn) ? 0 : (tIn as EdgeTransition).frames,
    isInert(tOut) ? 0 : (tOut as EdgeTransition).frames,
    win.duration,
  );

  const local = frame - ancestorBandOriginSum(project, elementId) - win.start;
  if (local < 0 || local >= win.duration) return IDENTITY;

  if (inFrames > 0 && local < inFrames && tIn) {
    // t = 0 on the window's first frame (fully out) and reaches 1 exactly when
    // the ramp ends — so the layer is at rest for every frame after it.
    const e = easeUnit(tIn.curve ?? DEFAULT_CURVE_IN[tIn.kind], local / inFrames);
    return factorsFor(tIn, e, project);
  }
  const fromEnd = win.duration - local;
  if (outFrames > 0 && fromEnd <= outFrames && tOut) {
    const e = easeUnit(tOut.curve ?? DEFAULT_CURVE_OUT[tOut.kind], fromEnd / outFrames);
    return factorsFor(tOut, e, project);
  }
  return IDENTITY;
};

/**
 * The window AND the edge transitions a newly created layer is born with.
 *
 * ONE FUNCTION FOR BOTH, because the transitions DEPEND on the window and
 * getting one without the other is precisely the bug this replaced. It returns
 * a fragment to spread into the new layer record.
 *
 * BORN WITH A BLOCK ⇒ FADES. A layer with a window has edges, and a bounded
 * overlay that pops on and off reads as broken. A layer with NO window is
 * always-present: `edgeTransitionAt` returns IDENTITY for it (see above —
 * treating its start as frame 0 would retroactively fade every legacy blockless
 * layer), so writing transitions onto one would be pure invisible state,
 * rendering differently from the data that describes it. The rule is the same
 * in the editor and in the pure tool catalog; only the source of the window
 * differs — the editor mints one from the playhead, an agent passes one or not.
 *
 * READ THAT CONDITION PRECISELY: born with a `block`, not "bounded". Two layer
 * classes are bounded by something OTHER than a block, and both deliberately
 * stay hard-edged:
 *
 *   • a WELDED CAPTION LINE, whose window `blockOf` derives live from its
 *     clip's trim (deriveCaptionWindow). Captions are speech-timed, and a fade
 *     on every line smears every cut;
 *   • a GROUP, whose window is its contents-hull unless one is set explicitly.
 *     Its children carry their own transitions; fading the wrapper too would
 *     double-dim them, since a group's factors compose through every
 *     descendant.
 *
 * If you add a layer class that is bounded by derivation, it does NOT get these
 * defaults for free, and that is the intended answer rather than an oversight.
 *
 * This asymmetry is why the two paths silently diverged before: the editor
 * always creates BOUNDED layers, so its layers always faded; the pure tools
 * default to always-present, so theirs never did — and an agent that DID pass a
 * block got a bounded layer that popped, where the identical layer made by
 * clicking faded. Same tool, same product, different born state.
 *
 * MATERIALIZED, not implicit. Written into the layer record at creation rather
 * than applied as a sampler fallback, because the project JSON is Morpha's
 * agent API: an agent reading `inspect_layers` has to be able to see why the
 * render fades, and a user opening the Inspector has to see a value they can
 * change or clear.
 *
 * It applies ONLY going forward — existing projects carry no transitions, so
 * nothing already exported changes under anyone. There is deliberately no
 * migration, and a block assigned LATER (`set_layer_block`) does not
 * retroactively add fades: this is the born state, not an invariant.
 *
 * VIDEO CLIPS ARE NOT A CASE HERE, and the absence is the point. A clip carries
 * no block at all — its window is its trim — so no add path routes one through
 * this, and it takes no `block` argument to route. The previous version of this
 * function branched on a `video.` prefix; that branch was unreachable, and an
 * unreachable branch describing a rule is worse than no branch, because the
 * next reader believes clip defaults live here. They live in the clip's own
 * absence of a transition, which `edgeTransitionAt` reads as a hard cut — the
 * grammar of short-form video, and a content judgement rather than an oversight.
 */
export const bornLayerDefaults = (
  block: { start: number; duration: number } | undefined,
): {
  block?: { start: number; duration: number };
  transition_in?: EdgeTransition;
  transition_out?: EdgeTransition;
} => {
  if (!block) return {};
  return {
    block,
    transition_in: { kind: "fade", frames: DEFAULT_OVERLAY_TRANSITION_FRAMES },
    transition_out: { kind: "fade", frames: DEFAULT_OVERLAY_TRANSITION_FRAMES },
  };
};
