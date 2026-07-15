// A `curve` shape's bounding box is DERIVED data — it should always hug the
// ink the renderer actually strokes, never drift larger. This module is the
// single source of truth for that geometry, shared by:
//   - add_curve            (create a curve already hugging its ink)
//   - the editor edit path (re-tighten after a control-point drag)
//   - the editor load path (heal legacy curves whose stored box is loose)
//
// A curve stores three control points [start, bend(control), end] as FRACTIONS
// of its bbox and strokes a quadratic bezier through them. A quadratic bezier
// never reaches its control point — its furthest bulge travels only halfway
// there (bend/2). Bounding the raw control point (as add_curve once did, and as
// every pre-fix curve still has baked into its stored width/height) reserves
// empty box on the bend side, so the visible arrow floats off toward the
// opposite corner, sitting well inside an oversized selection rectangle. The
// tight box below removes that dead space.
//
// NOTE: the box only affects the EDITOR (selection rect + hit-box). The curve
// renders into its bbox as a viewBox with the fraction points scaling to
// whatever size the box is, so re-tightening the box while re-expressing the
// points as fractions of it leaves the rendered pixels identical.

import type { Shape, Project } from "./schemas.ts";

export type CurvePoint = { x: number; y: number };

// Exact axis-aligned [min, max] of a quadratic bezier component over t∈[0,1]:
// the two endpoints plus the interior extremum at t* = (a-c)/(a-2c+b) when it
// falls strictly inside the segment. (a = start, c = control, b = end.)
const bezierExtent = (a: number, c: number, b: number): [number, number] => {
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  const denom = a - 2 * c + b;
  if (denom !== 0) {
    const t = (a - c) / denom;
    if (t > 0 && t < 1) {
      const v = (1 - t) * (1 - t) * a + 2 * t * (1 - t) * c + t * t * b;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo, hi];
};

export type FittedCurveBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  // The same three control points, re-expressed as fractions of the returned
  // box. The bend point's fraction can legitimately fall outside [0,1] (the
  // control point sits beyond the ink) — that's the bezier handle poking past
  // the box, exactly as vector editors draw it.
  points: [CurvePoint, CurvePoint, CurvePoint];
};

// Tight ink-hugging bbox for a curve, given its three ABSOLUTE control points
// [start, bend, end] and stroke width. `pad` covers the round stroke cap +
// arrowhead (arrowhead size is max(sw*1.9, 14), so sw*2 / 30 clears it) so the
// ink sits comfortably inside the box.
export const fitCurveBox = (
  pts: [CurvePoint, CurvePoint, CurvePoint],
  strokeWidth: number,
): FittedCurveBox => {
  const [p0, c, p2] = pts;
  const [exMinX, exMaxX] = bezierExtent(p0.x, c.x, p2.x);
  const [exMinY, exMaxY] = bezierExtent(p0.y, c.y, p2.y);
  const pad = Math.max(strokeWidth * 2, 30);
  const minX = exMinX - pad;
  const maxX = exMaxX + pad;
  const minY = exMinY - pad;
  const maxY = exMaxY + pad;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const frac = (px: number, py: number): CurvePoint => ({
    x: (px - minX) / w,
    y: (py - minY) / h,
  });
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: w,
    height: h,
    points: [frac(p0.x, p0.y), frac(c.x, c.y), frac(p2.x, p2.y)],
  };
};

// Re-tighten one curve shape's bbox to hug its ink, preserving the curve's
// absolute on-canvas position AT EVERY FRAME. Idempotent — an already-fitted
// curve is returned unchanged (same reference), so callers can cheaply skip
// no-op work.
//
// The heal must be render-neutral under whatever transforms the layer carries,
// so it picks its strategy from them (scale/rotation orbit the pivot, which for
// every path here must be the bbox centre):
//   - static rotation only        — fit tight in the local frame; the centre
//                                   moves by δ locally, so place the new centre
//                                   at old + Rθ·δ (the rotated image of the new
//                                   local centre) and the ink is exactly
//                                   preserved while the rotated box hugs it.
//   - x/y tracks                  — a track REPLACES the centre, so re-basing
//                                   the fractions alone would shift the ink at
//                                   every driven frame by the centre delta;
//                                   shift each keyframe's VALUE by the same
//                                   world delta and the whole animation stays
//                                   rigidly on the new box.
//   - scale / rotation TRACKS     — no single centre move is right for every
//                                   frame, so keep the centre PINNED and grow
//                                   the box symmetrically about it. Offsets
//                                   from the centre are preserved exactly, so
//                                   any per-frame scale/rotation about it
//                                   renders identically. (The box is symmetric
//                                   rather than minimal — contained, not tight.)
//
// Skipped (returned unchanged) only when no re-base can be render-neutral:
//   - non-curve / missing points  — nothing to fit.
//   - width/height tracks         — fractions multiply the per-frame animated
//                                   dims, so any re-base distorts driven frames.
//   - pivot off-centre while rotation/scale orbit it — preserving the pivot's
//                                   absolute position would need fractions
//                                   outside the schema's [0,1].
export const healCurveShape = (shape: Shape): Shape => {
  if (shape.kind !== "curve") return shape;
  if (!shape.points || shape.points.length < 3) return shape;
  const tracks = shape.animations;
  const has = (p: "x" | "y" | "width" | "height" | "scale" | "rotation") =>
    (tracks?.[p]?.length ?? 0) > 0;
  if (has("width") || has("height")) return shape;
  const pinned = has("scale") || has("rotation");
  const pivotCentred =
    Math.abs(shape.pivotX - 0.5) < 1e-6 && Math.abs(shape.pivotY - 0.5) < 1e-6;
  if (!pivotCentred && (pinned || shape.rotation !== 0)) return shape;

  const left = shape.x - shape.width / 2;
  const top = shape.y - shape.height / 2;
  const abs = (p: CurvePoint): CurvePoint => ({
    x: left + p.x * shape.width,
    y: top + p.y * shape.height,
  });
  const p0 = abs(shape.points[0]);
  const c = abs(shape.points[1]);
  const p2 = abs(shape.points[2]);
  const fit = fitCurveBox([p0, c, p2], shape.stroke_width ?? 10);

  let next: {
    x: number;
    y: number;
    width: number;
    height: number;
    points: [CurvePoint, CurvePoint, CurvePoint];
  };
  let animations = shape.animations;

  if (pinned) {
    // Centre-pinned symmetric box: widest padded reach from the (fixed) centre
    // per axis. Fractions re-based about the same centre keep every offset —
    // and therefore every scale/rotation-driven frame — identical.
    const fitLeft = fit.x - fit.width / 2;
    const fitRight = fit.x + fit.width / 2;
    const fitTop = fit.y - fit.height / 2;
    const fitBottom = fit.y + fit.height / 2;
    const halfW = Math.max(shape.x - fitLeft, fitRight - shape.x, 0.5);
    const halfH = Math.max(shape.y - fitTop, fitBottom - shape.y, 0.5);
    const w = halfW * 2;
    const h = halfH * 2;
    const frac = (p: CurvePoint): CurvePoint => ({
      x: (p.x - (shape.x - halfW)) / w,
      y: (p.y - (shape.y - halfH)) / h,
    });
    next = {
      x: shape.x,
      y: shape.y,
      width: w,
      height: h,
      points: [frac(p0), frac(c), frac(p2)],
    };
  } else {
    // Tight fit. Under a static rotation the box orbits its own centre, so the
    // new centre must land on the rotated image of the fitted local centre for
    // the ink to stay put (θ = 0 reduces to placing it at the fit centre).
    const dx = fit.x - shape.x;
    const dy = fit.y - shape.y;
    const rad = (shape.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dwx = dx * cos - dy * sin;
    const dwy = dx * sin + dy * cos;
    next = {
      x: shape.x + dwx,
      y: shape.y + dwy,
      width: fit.width,
      height: fit.height,
      points: fit.points,
    };
    // An x/y track replaces the centre at driven frames — carry the animation
    // along by the same world delta so the re-based fractions stay rigid.
    if ((has("x") || has("y")) && tracks) {
      const shift = (
        kfs: NonNullable<typeof tracks.x>,
        delta: number,
      ): NonNullable<typeof tracks.x> =>
        delta === 0 ? kfs : kfs.map((k) => ({ ...k, value: k.value + delta }));
      animations = {
        ...tracks,
        ...(has("x") ? { x: shift(tracks.x!, dwx) } : {}),
        ...(has("y") ? { y: shift(tracks.y!, dwy) } : {}),
      };
    }
  }

  // No meaningful drift → keep the existing reference (no churn, and the reload
  // poll's deep-diff stays clean).
  if (
    Math.abs(next.x - shape.x) < 0.5 &&
    Math.abs(next.y - shape.y) < 0.5 &&
    Math.abs(next.width - shape.width) < 0.5 &&
    Math.abs(next.height - shape.height) < 0.5
  ) {
    return shape;
  }

  return { ...shape, ...next, animations };
};

// Heal every curve shape in a project — across every page. Returns the same
// project reference when nothing changed so it's cheap to run on every load /
// poll tick without tripping identity-based re-renders or the reload poll's
// deep-diff.
export const healCurveBboxes = (project: Project): Project => {
  const healShapes = (shapes: Shape[]): Shape[] => {
    let touched = false;
    const next = shapes.map((s) => {
      const healed = healCurveShape(s);
      if (healed !== s) touched = true;
      return healed;
    });
    return touched ? next : shapes;
  };

  const pages = project.pages.map((page) => {
    const pageShapes = healShapes(page.shapes);
    return pageShapes === page.shapes ? page : { ...page, shapes: pageShapes };
  });
  const changed = pages.some((p, i) => p !== project.pages[i]);
  return changed ? { ...project, pages } : project;
};
