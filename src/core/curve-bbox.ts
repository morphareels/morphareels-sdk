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
// absolute on-canvas position. Idempotent — an already-tight curve is returned
// unchanged (same reference), so callers can cheaply skip no-op work.
//
// Skipped (returned unchanged) when re-basing the fraction points would move
// the rendered curve:
//   - non-curve / missing points   — nothing to fit.
//   - rotation ≠ 0                  — the box rotates about its own centre;
//                                     moving the centre would swing the ink.
//   - a size track (width/height/scale) — fractions are relative to the base
//                                     box, so re-basing them distorts the
//                                     animated curve at any driven frame.
// An x/y track is fine: those override the base centre absolutely, so shifting
// the (unread) base centre is inert.
export const healCurveShape = (shape: Shape): Shape => {
  if (shape.kind !== "curve") return shape;
  if (!shape.points || shape.points.length < 3) return shape;
  if (shape.rotation !== 0) return shape;
  const tracks = shape.animations;
  if (
    tracks &&
    ((tracks.width?.length ?? 0) > 0 ||
      (tracks.height?.length ?? 0) > 0 ||
      (tracks.scale?.length ?? 0) > 0)
  ) {
    return shape;
  }

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

  // No meaningful drift → keep the existing reference (no churn, and the reload
  // poll's deep-diff stays clean).
  if (
    Math.abs(fit.x - shape.x) < 0.5 &&
    Math.abs(fit.y - shape.y) < 0.5 &&
    Math.abs(fit.width - shape.width) < 0.5 &&
    Math.abs(fit.height - shape.height) < 0.5
  ) {
    return shape;
  }

  return {
    ...shape,
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
    points: fit.points,
  };
};

// Heal every curve shape in a project — the top-level composition AND every
// carousel page. Returns the same project reference when nothing changed so
// it's cheap to run on every load / poll tick without tripping identity-based
// re-renders or the reload poll's deep-diff.
export const healCurveBboxes = (project: Project): Project => {
  let changed = false;

  const healShapes = (shapes: Shape[]): Shape[] => {
    let touched = false;
    const next = shapes.map((s) => {
      const healed = healCurveShape(s);
      if (healed !== s) touched = true;
      return healed;
    });
    return touched ? next : shapes;
  };

  const shapes = healShapes(project.shapes);
  if (shapes !== project.shapes) changed = true;

  let carousel = project.carousel;
  if (carousel) {
    const pages = carousel.pages.map((page) => {
      const pageShapes = healShapes(page.shapes);
      return pageShapes === page.shapes ? page : { ...page, shapes: pageShapes };
    });
    if (pages.some((p, i) => p !== carousel!.pages[i])) {
      carousel = { ...carousel, pages };
      changed = true;
    }
  }

  return changed ? { ...project, shapes, carousel } : project;
};
