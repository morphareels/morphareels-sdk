// The two coordinate spaces an element lives in, and the exact maps between
// them. PURE — no store, no DOM — so the editor gestures, the pure tool
// dispatchers and the node tests all share one implementation.
//
// ── The spaces ──────────────────────────────────────────────────────────────
// CANVAS space is what the user points at: the 1080×1920 composition, what the
// renderer paints, what a selection box is measured in.
//
// PARENT space is what an element's `x`/`y` are STORED in. For a root-level
// element the two coincide, which is why this distinction went unnoticed for so
// long. Inside a group they do not: the group's own translate / scale / rotation
// sits between them, so a canvas-space value written straight into `x` lands
// somewhere else entirely — measured at 180px of travel for 120px of pointer
// inside a group scaled 1.5×, and diagonal travel inside a rotated one.
//
// ── Why the mistake is now a type error ─────────────────────────────────────
// "Canvas-space value written into a parent-space field" has shipped five times
// in this editor (edge resize, body drag, arrow-key nudge, align, distribute).
// A comment saying "convert first" is a convention, and conventions are what
// failed. So the converters below return BRANDED values, and the store actions
// that consume a delta accept only the branded form — a raw canvas number no
// longer type-checks at the sites where this bug actually lives. Same move as
// `OwnerUserId` in worker/src/project-namespace.ts, which ended the equivalent
// namespace bug after three recurrences.
import { evaluateTrack } from "./animation.ts";
import { edgeTransitionAt } from "./transitions.ts";
import {
  effectiveFrameOffset,
  getAncestorGroupChain,
  layerOf,
  type Composition,
  type TrackProperty,
} from "./schemas.ts";

declare const PARENT_SPACE: unique symbol;
declare const CANVAS_SPACE: unique symbol;

/** A translation in the element's PARENT space — the only thing the store's
 *  translate actions accept. Produced solely by `canvasDeltaToParentSpace`. */
export type ParentDelta = { x: number; y: number; readonly [PARENT_SPACE]: true };

/** A position in the element's PARENT space, i.e. a value `x`/`y` can hold.
 *  Produced solely by `canvasPointToLeafSpace`. */
export type ParentPoint = { x: number; y: number; readonly [PARENT_SPACE]: true };

/** A translation in CANVAS space — what a pointer or an arrow key produces.
 *  `canvasDelta(dx, dy)` is the one way in, so the boundary where the two
 *  spaces meet is named in the types rather than in a comment. */
export type CanvasDelta = { x: number; y: number; readonly [CANVAS_SPACE]: true };

export const canvasDelta = (x: number, y: number): CanvasDelta =>
  ({ x, y }) as CanvasDelta;

const parentDelta = (x: number, y: number): ParentDelta =>
  ({ x, y }) as ParentDelta;

const parentPoint = (x: number, y: number): ParentPoint =>
  ({ x, y }) as ParentPoint;

/** A live gesture's override of an element's own transform, looked up by
 *  element id. The editor supplies the store's `dragOverride`; pure callers
 *  supply nothing. Keeps this module free of any editor import. */
export type OverrideLookup = (elementId: string) => {
  x: number | null;
  y: number | null;
  scale: number | null;
  rotation: number | null;
} | null;

const NO_OVERRIDE: OverrideLookup = () => null;

// Below this, a converted delta component is not a movement — it is the
// floating-point residue of an exactly-axis-aligned gesture inside a rotated
// parent (cos 90° is 6.1e-17, not 0). Zeroing it once, here, is what keeps every
// call site's `if (d.x !== 0)` guard meaning what it says: a pure-x drag inside a
// 90°-rotated group must not write a keyframe on the axis it never moved. 1e-9
// canvas px is a nanometre of a 1080px canvas.
const PARENT_DELTA_EPSILON = 1e-9;

const snapEpsilon = (v: number): number =>
  Math.abs(v) < PARENT_DELTA_EPSILON ? 0 : v;

export const evalSpaceProp = (
  project: Composition,
  elementId: string,
  prop: TrackProperty,
  fallback: number,
  frame: number,
): number => {
  const kfs = layerOf(project, elementId)?.animations?.[prop];
  if (!kfs || kfs.length === 0) return fallback;
  const loop = layerOf(project, elementId)?.track_loops?.[prop];
  // Block-local frame, mirroring renderer.ts resolveTrack, so selection/hit
  // geometry tracks the block-relative animation (handles align with paint).
  return evaluateTrack(kfs, frame - effectiveFrameOffset(project, elementId), loop);
};

/** The ancestor-group chain composed into one map from the element's PARENT
 *  space to CANVAS space. Mirrors drawGroup in renderer.ts: each group does
 *  translate(pivot + tx, pivot + ty) → rotate(rot) → scale(sc) → translate(-pivot).
 *  Every group's own transform is its static base overridden per-property by a
 *  keyframe track, by its edge transition, and by a live drag override.
 *
 *  The composition of similarities is a similarity — `apply(v) = L·v + c` with
 *  L = R(Σθ)·Πs — which is what makes both inverses below exact, and what makes
 *  a DELTA convert with L alone. */
export const composeAncestors = (
  project: Composition,
  elementId: string,
  frame: number,
  overrideFor: OverrideLookup = NO_OVERRIDE,
): {
  apply: (p: { x: number; y: number }) => { x: number; y: number };
  scaleProduct: number;
  rotationProduct: number;
} => {
  const chain = getAncestorGroupChain(project, elementId);
  let apply = (p: { x: number; y: number }) => p;
  let scaleProduct = 1;
  let rotationProduct = 0;
  for (const gid of [...chain].reverse()) {
    const g = project.groups.find((x) => x.id === gid);
    if (!g) continue;
    const elId = `group.${gid}`;
    const dg = overrideFor(elId);
    const evalTx = evalSpaceProp(project, elId, "x", g.x, frame);
    const evalTy = evalSpaceProp(project, elId, "y", g.y, frame);
    const evalSc = evalSpaceProp(project, elId, "scale", g.scale, frame);
    const evalRot = evalSpaceProp(project, elId, "rotation", g.rotation, frame);
    // Each ancestor group's own edge transition composes into the chain, the
    // same way drawGroup composes it into the paint — otherwise a child's
    // selection box ignores a transition running on the GROUP above it.
    const gt = edgeTransitionAt(project, elId, frame);
    const tx = (dg && dg.x !== null ? dg.x : evalTx) + gt.dx;
    const ty = (dg && dg.y !== null ? dg.y : evalTy) + gt.dy;
    const sc = (dg && dg.scale !== null ? dg.scale : evalSc) * gt.scale;
    const rot = dg && dg.rotation !== null ? dg.rotation : evalRot;
    const px = g.pivotX;
    const py = g.pivotY;
    const cosR = Math.cos((rot * Math.PI) / 180);
    const sinR = Math.sin((rot * Math.PI) / 180);
    const prev = apply;
    apply = (p) => {
      const child = prev(p);
      const dx = (child.x - px) * sc;
      const dy = (child.y - py) * sc;
      return {
        x: dx * cosR - dy * sinR + px + tx,
        y: dx * sinR + dy * cosR + py + ty,
      };
    };
    scaleProduct *= sc;
    rotationProduct += rot;
  }
  return { apply, scaleProduct, rotationProduct };
};

// The LINEAR part of the chain, inverted: undo the rotation, undo the scale.
// Both converters below are this plus (for a point) the affine constants, so
// "a delta is a point without the origin and the transition" is true by
// construction rather than by two copies of the trigonometry agreeing.
const inverseAncestorLinear = (anc: {
  scaleProduct: number;
  rotationProduct: number;
}): ((x: number, y: number) => { x: number; y: number }) => {
  const rad = (-anc.rotationProduct * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // A collapsed ancestor (scale 0) paints nothing and has no invertible map;
  // returning zero refuses to move it rather than producing Infinity/NaN.
  const inv = anc.scaleProduct !== 0 ? 1 / anc.scaleProduct : 0;
  return (x, y) => ({
    x: (x * cos - y * sin) * inv,
    y: (x * sin + y * cos) * inv,
  });
};

/** A CANVAS-space translation → the same translation in the element's PARENT
 *  space, ready to add to `x`/`y` (or to a keyframe value).
 *
 *  Works for LEAVES AND GROUPS with no branch: for `group.<id>` the chain is
 *  the one ABOVE that group, which is exactly the space its own offset lives in.
 *
 *  A delta needs only the linear part, so the origin drops out and — the part
 *  worth knowing — SO DOES THE EDGE TRANSITION: it does not depend on x/y, so
 *  it cancels in the difference. That is why a gesture mid-`slide` doesn't bake
 *  the ramp's travel into the layer's stored position. */
export const canvasDeltaToParentSpace = (
  project: Composition,
  elementId: string,
  frame: number,
  /** The live gesture's override lookup; omit outside the editor. */
  overrideFor: OverrideLookup = NO_OVERRIDE,
  delta: CanvasDelta,
): ParentDelta => {
  const inv = inverseAncestorLinear(
    composeAncestors(project, elementId, frame, overrideFor),
  );
  const d = inv(delta.x, delta.y);
  return parentDelta(snapEpsilon(d.x), snapEpsilon(d.y));
};

/** A CANVAS-space point → the value a LEAF's `x`/`y` must hold to put its
 *  unrotated box centre there. The exact inverse of the map `leafBoxOnCanvas`
 *  uses, so it must undo everything that map applies:
 *
 *   • the ancestor chain (above);
 *   • the element's edge transition offset, which the forward map ADDS on top
 *     of the sampled x/y — leave it in and a gesture mid-ramp bakes the
 *     transition's travel into the stored position;
 *   • the pivot term: the box centre is the PIVOT POINT stepped back by
 *     `scale · pivotOffset`, and the offset is a FRACTION OF THE SIZE — so a
 *     gesture that resizes must invert against the size it is about to write,
 *     which is what `baseSize` is for.
 *
 *  LEAVES only. A group's x/y is a translation offset about its frozen pivot,
 *  not a centre; pin a canvas point through a group's own transform with
 *  `pinnedGroupOffset` in CanvasOverlay instead. */
export const canvasPointToLeafSpace = (
  project: Composition,
  elementId: string,
  frame: number,
  overrideFor: OverrideLookup,
  point: { x: number; y: number },
  baseSize: { w: number; h: number },
  ownScale: number,
): ParentPoint => {
  const anc = composeAncestors(project, elementId, frame, overrideFor);
  const t = edgeTransitionAt(project, elementId, frame);
  const off = pivotOffset(leafPivotOf(project, elementId), baseSize.w, baseSize.h);
  const flip = leafFlipOf(project, elementId);
  // Undo the consumer's rotate-and-scale-about-the-pivot step to recover the
  // pivot point, which is what the ancestor chain actually maps.
  const scTotal = ownScale * t.scale * anc.scaleProduct;
  const pivotCanvasX = point.x + scTotal * off.x * flip.x;
  const pivotCanvasY = point.y + scTotal * off.y * flip.y;
  const origin = anc.apply({ x: 0, y: 0 });
  const local = inverseAncestorLinear(anc)(
    pivotCanvasX - origin.x,
    pivotCanvasY - origin.y,
  );
  return parentPoint(local.x - off.x - t.dx, local.y - off.y - t.dy);
};

/** Translate an element's STATIC BASE by a parent-space delta, in place.
 *
 *  This is the write half of the brand: it accepts a `ParentDelta` and nothing
 *  else, so the only way to move a layer's base is to have converted a canvas
 *  delta first — the mistake stops compiling rather than being caught in review.
 *  Leaves and groups both (a group's x/y is its own translation offset).
 *
 *  Returns whether anything changed, so callers can keep their "did this do
 *  anything" bookkeeping. Mutates `comp` in place: the callers are gestures
 *  working on an already-cloned project inside one undo bracket, so an action
 *  that set() per element would break the single-entry contract. */
export const translateLayerBase = (
  comp: Composition,
  elementId: string,
  delta: ParentDelta,
): boolean => {
  if (delta.x === 0 && delta.y === 0) return false;
  const move = <T extends { x: number; y: number }>(
    arr: T[],
    id: string,
  ): boolean => {
    const idx = arr.findIndex((l) => (l as unknown as { id: string }).id === id);
    if (idx < 0) return false;
    const cur = arr[idx];
    arr[idx] = { ...cur, x: cur.x + delta.x, y: cur.y + delta.y };
    return true;
  };
  if (elementId.startsWith("group.")) {
    return move(comp.groups as unknown as Array<{ x: number; y: number }>, elementId.slice("group.".length));
  }
  if (elementId.startsWith("image.")) {
    return move(comp.image_layers, elementId.slice("image.".length));
  }
  if (elementId.startsWith("video.")) {
    return move(comp.video_layers, elementId.slice("video.".length));
  }
  if (elementId.startsWith("shapes.")) {
    return move(comp.shapes, elementId.slice("shapes.".length));
  }
  if (elementId.startsWith("text.")) {
    return move(comp.text_layers, elementId.slice("text.".length));
  }
  return false;
};

/** A single-axis parent delta — for the paths that route x and y separately
 *  because each axis picks base-vs-keyframe on its own. */
export const parentDeltaAxis = (
  delta: ParentDelta,
  axis: "x" | "y",
): ParentDelta => parentDelta(axis === "x" ? delta.x : 0, axis === "y" ? delta.y : 0);

// ---------------------------------------------------------------------------
// Pivot primitives — one model, shared by the renderer and the geometry.
// ---------------------------------------------------------------------------

/** Offset from a leaf's rect CENTRE to its rotation/scale pivot, in UNSCALED
 *  parent-frame units — exactly the `offX`/`offY` of renderer.ts applyTransform.
 *  The pivot point `(x, y) + pivotOffset(...)` is the fixed point of BOTH scale
 *  and rotation, which is what `set_pivot` promises ("rotates and scales around
 *  that point") and what the export paints. */
export const pivotOffset = (
  pivot: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } => ({
  x: (pivot.x - 0.5) * width,
  y: (pivot.y - 0.5) * height,
});

/** The rect centre implied by a pivot point: step back from the pivot by the
 *  scaled (and flipped, and optionally rotated) pivot offset. Pass
 *  `rotationDeg: 0` for the UNROTATED centre a `Box` carries; pass the real
 *  rotation for the PAINTED centre the DOM sampler carries. */
export const centreFromPivot = (
  pivotCanvas: { x: number; y: number },
  off: { x: number; y: number },
  scale: number,
  rotationDeg: number,
  flip: { x: number; y: number },
): { x: number; y: number } => {
  const vx = scale * off.x * flip.x;
  const vy = scale * off.y * flip.y;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: pivotCanvas.x - (vx * cos - vy * sin),
    y: pivotCanvas.y - (vx * sin + vy * cos),
  };
};

/** A leaf's normalized rotation/scale pivot; centre for groups and anything
 *  unresolvable (a group's pivot is absolute canvas coords, a different field
 *  with different semantics). */
export const leafPivotOf = (
  project: Composition,
  elementId: string,
): { x: number; y: number } => {
  if (elementId.startsWith("group.")) return { x: 0.5, y: 0.5 };
  const layer = layerOf(project, elementId) as
    | { pivotX?: number; pivotY?: number }
    | null;
  if (!layer || typeof layer.pivotX !== "number" || typeof layer.pivotY !== "number") {
    return { x: 0.5, y: 0.5 };
  }
  return { x: layer.pivotX, y: layer.pivotY };
};

/** Content mirroring as ±1 multipliers. Flip sits INSIDE the pivot bracket in
 *  applyTransform, so a flipped layer with an off-centre pivot has a displaced
 *  rect — the geometry has to know. Text is always unflipped: drawTextLayer
 *  passes no flip at all, and geometry that disagreed would put a text box
 *  where nothing is painted. */
export const leafFlipOf = (
  project: Composition,
  elementId: string,
): { x: number; y: number } => {
  if (elementId.startsWith("text.") || elementId.startsWith("group.")) {
    return { x: 1, y: 1 };
  }
  const style = (layerOf(project, elementId) as { style?: { flipX?: boolean; flipY?: boolean } } | null)?.style;
  return { x: style?.flipX ? -1 : 1, y: style?.flipY ? -1 : 1 };
};
