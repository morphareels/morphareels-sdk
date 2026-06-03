// Shape registry — the single source of truth for every shape primitive
// Metamorpha can draw. Both the Zod schema (`src/schemas.ts`) and the canvas
// renderer (`editor/src/renderer.ts`) derive from this list, so adding a new
// shape means appending ONE entry here.
//
// Each entry has:
//   - `id`    — the `kind` string stored on a shape layer (and the schema enum).
//   - `label` — the human name shown in pickers / the Inspector.
//   - `trace` — writes a closed canvas path into the 2D context. The caller
//               has already done `ctx.beginPath()`; `trace` must NOT begin or
//               fill the path. All coordinates fit inside the bbox
//               `(0, 0)–(w, h)` (the renderer has moved the origin to the
//               layer's top-left after rotate + scale + flip).
//
// `rect` MUST stay in the set and remain first — older projects depend on the
// schema default `.default("rect")`.

// Minimal structural 2D-context type — just the path-building surface every
// `trace` uses. Defined locally (rather than referencing the ambient
// `CanvasRenderingContext2D`) so this module typechecks in the Worker build,
// whose tsconfig has no DOM lib. Both `CanvasRenderingContext2D` and
// `OffscreenCanvasRenderingContext2D` are structurally assignable to it, so
// `renderer.ts`'s `Ctx2D` union flows in without a cast.
export interface ShapeCtx2D {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void;
}

export interface ShapeDef {
  id: string;
  label: string;
  trace: (ctx: ShapeCtx2D, w: number, h: number) => void;
}

// --- path-building primitives -------------------------------------------------

// Regular polygon inscribed in the bbox. `startAngle` is the angle (radians)
// of the first vertex measured from the centre; subsequent vertices step
// evenly. Default `-PI/2` puts the first vertex straight up (point-up).
const polygon = (
  ctx: ShapeCtx2D,
  w: number,
  h: number,
  sides: number,
  startAngle = -Math.PI / 2,
): void => {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (i * 2 * Math.PI) / sides;
    const px = cx + rx * Math.cos(a);
    const py = cy + ry * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
};

// Star / burst: `points` outer spikes alternating with `points` inner valleys.
// `innerRatio` is the inner radius as a fraction of the outer radius.
const starPath = (
  ctx: ShapeCtx2D,
  w: number,
  h: number,
  points: number,
  innerRatio: number,
  startAngle = -Math.PI / 2,
): void => {
  const cx = w / 2;
  const cy = h / 2;
  const outerX = w / 2;
  const outerY = h / 2;
  const steps = points * 2;
  for (let i = 0; i < steps; i++) {
    const ratio = i % 2 === 0 ? 1 : innerRatio;
    const a = startAngle + (i * Math.PI) / points;
    const px = cx + ratio * outerX * Math.cos(a);
    const py = cy + ratio * outerY * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
};

// Trace a polyline of [x, y] fractions of the bbox and close it.
const poly = (
  ctx: ShapeCtx2D,
  w: number,
  h: number,
  pts: ReadonlyArray<readonly [number, number]>,
): void => {
  for (let i = 0; i < pts.length; i++) {
    const px = pts[i][0] * w;
    const py = pts[i][1] * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
};

// Rounded rectangle clamped so the radius never exceeds half the shorter side.
const roundRectPath = (
  ctx: ShapeCtx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
};

// --- the registry -------------------------------------------------------------

// The `as const` keeps every `id` / `label` as a string literal (so `ShapeKind`
// is a precise union); `satisfies` still structurally checks each entry against
// `ShapeDef`. `trace` callbacks keep their inferred function types either way.
export const SHAPE_DEFS = [
  // --- the historic 8 ---------------------------------------------------------
  {
    id: "rect",
    label: "Rectangle",
    trace: (ctx, w, h) => {
      ctx.rect(0, 0, w, h);
    },
  },
  {
    id: "ellipse",
    label: "Ellipse",
    trace: (ctx, w, h) => {
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    },
  },
  {
    id: "triangle",
    label: "Triangle",
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.5, 0],
        [1, 1],
        [0, 1],
      ]);
    },
  },
  {
    id: "star",
    label: "Star",
    // Classic 5-point star, point-up; inner radius 0.4 of the outer.
    trace: (ctx, w, h) => starPath(ctx, w, h, 5, 0.4),
  },
  {
    id: "pentagon",
    label: "Pentagon",
    trace: (ctx, w, h) => polygon(ctx, w, h, 5),
  },
  {
    id: "hexagon",
    label: "Hexagon",
    // Flat-top: first vertex offset 30° from straight-up.
    trace: (ctx, w, h) => polygon(ctx, w, h, 6, -Math.PI / 2 + Math.PI / 6),
  },
  {
    id: "arrow",
    label: "Arrow",
    // Right-pointing block arrow: shaft on the left at half-height, triangular
    // head spanning the right 40% at full height.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0, 0.25],
        [0.6, 0.25],
        [0.6, 0],
        [1, 0.5],
        [0.6, 1],
        [0.6, 0.75],
        [0, 0.75],
      ]);
    },
  },
  {
    id: "heart",
    label: "Heart",
    trace: (ctx, w, h) => {
      const topY = h * 0.28;
      ctx.moveTo(w / 2, topY);
      ctx.bezierCurveTo(w * 0.4, h * -0.05, w * -0.18, h * 0.32, w / 2, h);
      ctx.bezierCurveTo(w * 1.18, h * 0.32, w * 0.6, h * -0.05, w / 2, topY);
      ctx.closePath();
    },
  },

  // --- geometric --------------------------------------------------------------
  {
    id: "rounded-rect",
    label: "Rounded Rectangle",
    trace: (ctx, w, h) => {
      roundRectPath(ctx, 0, 0, w, h, Math.min(w, h) * 0.18);
    },
  },
  {
    id: "diamond",
    label: "Diamond",
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 0.5],
      ]);
    },
  },
  {
    id: "parallelogram",
    label: "Parallelogram",
    // Top edge shifted right, bottom edge shifted left — 25% skew.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.25, 0],
        [1, 0],
        [0.75, 1],
        [0, 1],
      ]);
    },
  },
  {
    id: "trapezoid",
    label: "Trapezoid",
    // Wide base, narrower top inset 25% on each side.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.25, 0],
        [0.75, 0],
        [1, 1],
        [0, 1],
      ]);
    },
  },
  {
    id: "semicircle",
    label: "Semicircle",
    // Flat side on the bottom; the arc fills the upper bbox.
    trace: (ctx, w, h) => {
      ctx.moveTo(0, h);
      ctx.lineTo(0, h);
      ctx.ellipse(w / 2, h, w / 2, h, 0, Math.PI, 2 * Math.PI);
      ctx.lineTo(0, h);
      ctx.closePath();
    },
  },
  {
    id: "ring",
    label: "Ring",
    // Donut: outer ellipse + an inner ellipse wound the opposite direction so
    // the non-zero fill rule punches a hole. Hole radius 0.5 of the outer.
    trace: (ctx, w, h) => {
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.moveTo(w / 2 + w * 0.25, h / 2);
      ctx.ellipse(w / 2, h / 2, w * 0.25, h * 0.25, 0, 0, Math.PI * 2, true);
    },
  },
  {
    id: "pill",
    label: "Pill",
    // Horizontal capsule. Height is clamped so it always reads as a pill — a
    // full-bbox capsule collapses to a plain circle in a square bbox.
    trace: (ctx, w, h) => {
      const ph = Math.min(h, w * 0.6);
      const py = (h - ph) / 2;
      roundRectPath(ctx, 0, py, w, ph, ph / 2);
    },
  },
  {
    id: "cross",
    label: "Cross",
    // Plus / cross: arms one-third of the bbox thick.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [1 / 3, 0],
        [2 / 3, 0],
        [2 / 3, 1 / 3],
        [1, 1 / 3],
        [1, 2 / 3],
        [2 / 3, 2 / 3],
        [2 / 3, 1],
        [1 / 3, 1],
        [1 / 3, 2 / 3],
        [0, 2 / 3],
        [0, 1 / 3],
        [1 / 3, 1 / 3],
      ]);
    },
  },

  // --- polygons ---------------------------------------------------------------
  {
    id: "heptagon",
    label: "Heptagon",
    trace: (ctx, w, h) => polygon(ctx, w, h, 7),
  },
  {
    id: "octagon",
    label: "Octagon",
    // Flat-top: first vertex offset half a step so top + bottom run flat.
    trace: (ctx, w, h) => polygon(ctx, w, h, 8, -Math.PI / 2 + Math.PI / 8),
  },

  // --- stars / bursts ---------------------------------------------------------
  {
    id: "star-4",
    label: "4-Point Star",
    trace: (ctx, w, h) => starPath(ctx, w, h, 4, 0.38),
  },
  {
    id: "star-6",
    label: "6-Point Star",
    trace: (ctx, w, h) => starPath(ctx, w, h, 6, 0.5),
  },
  {
    id: "sparkle",
    label: "Sparkle",
    // Four-point sparkle with concave waist — a slim inner ratio gives the
    // pinched, glinting look.
    trace: (ctx, w, h) => starPath(ctx, w, h, 4, 0.18),
  },
  {
    id: "burst",
    label: "Burst",
    // Many-point starburst / explosion badge.
    trace: (ctx, w, h) => starPath(ctx, w, h, 12, 0.68),
  },

  // --- arrows -----------------------------------------------------------------
  {
    id: "arrow-left",
    label: "Arrow Left",
    // Mirror of `arrow`.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [1, 0.25],
        [0.4, 0.25],
        [0.4, 0],
        [0, 0.5],
        [0.4, 1],
        [0.4, 0.75],
        [1, 0.75],
      ]);
    },
  },
  {
    id: "double-arrow",
    label: "Double Arrow",
    // A head at each horizontal end joined by a central shaft.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0, 0.5],
        [0.25, 0],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0],
        [1, 0.5],
        [0.75, 1],
        [0.75, 0.75],
        [0.25, 0.75],
        [0.25, 1],
      ]);
    },
  },
  {
    id: "chevron",
    label: "Chevron",
    // Right-pointing chevron (an open arrowhead with a notched back).
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0, 0],
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 1],
        [0.5, 0.5],
      ]);
    },
  },
  {
    id: "block-arrow-up",
    label: "Block Arrow Up",
    // Up-pointing block arrow: triangular head over a centred shaft.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.5, 0],
        [1, 0.45],
        [0.7, 0.45],
        [0.7, 1],
        [0.3, 1],
        [0.3, 0.45],
        [0, 0.45],
      ]);
    },
  },
  {
    id: "curve",
    label: "Arrow / Curve",
    // A stroked quadratic bezier with an arrowhead — the editable line/arrow
    // primitive. Its real geometry lives in the shape's `points` (control
    // points), stroke_width and arrow_head, and the renderer STROKES it (this
    // trace is only the picker glyph + a fallback when no points are stored):
    // a filled curved-arrow silhouette swooping up to a head on the right.
    trace: (ctx, w, h) => {
      const X = (f: number) => f * w;
      const Y = (f: number) => f * h;
      ctx.moveTo(X(0.08), Y(0.8));
      ctx.bezierCurveTo(X(0.3), Y(0.3), X(0.54), Y(0.24), X(0.72), Y(0.34));
      ctx.lineTo(X(0.68), Y(0.14));
      ctx.lineTo(X(0.98), Y(0.44));
      ctx.lineTo(X(0.62), Y(0.6));
      ctx.lineTo(X(0.66), Y(0.46));
      ctx.bezierCurveTo(X(0.5), Y(0.4), X(0.32), Y(0.48), X(0.2), Y(0.88));
      ctx.closePath();
    },
  },

  // --- symbols ----------------------------------------------------------------
  {
    id: "lightning",
    label: "Lightning Bolt",
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.55, 0],
        [0.1, 0.55],
        [0.42, 0.55],
        [0.32, 1],
        [0.85, 0.4],
        [0.5, 0.4],
        [0.72, 0],
      ]);
    },
  },
  {
    id: "speech-bubble",
    label: "Speech Bubble",
    // Rounded body occupying the top 78% + a tail dropping from the lower-left.
    trace: (ctx, w, h) => {
      const bodyH = h * 0.78;
      const r = Math.min(w, bodyH) * 0.22;
      const rr = Math.max(0, Math.min(r, w / 2, bodyH / 2));
      ctx.moveTo(rr, 0);
      ctx.lineTo(w - rr, 0);
      ctx.arcTo(w, 0, w, rr, rr);
      ctx.lineTo(w, bodyH - rr);
      ctx.arcTo(w, bodyH, w - rr, bodyH, rr);
      // tail
      ctx.lineTo(w * 0.4, bodyH);
      ctx.lineTo(w * 0.2, h);
      ctx.lineTo(w * 0.24, bodyH);
      ctx.lineTo(rr, bodyH);
      ctx.arcTo(0, bodyH, 0, bodyH - rr, rr);
      ctx.lineTo(0, rr);
      ctx.arcTo(0, 0, rr, 0, rr);
      ctx.closePath();
    },
  },
  {
    id: "location-pin",
    label: "Location Pin",
    // Map marker: a circular head that tapers to a point at the bottom centre.
    trace: (ctx, w, h) => {
      const cx = w / 2;
      const cy = h * 0.36;
      const r = Math.min(w / 2, h * 0.36);
      // start at the bottom tip, sweep up around the head, back to the tip
      ctx.moveTo(cx, h);
      ctx.bezierCurveTo(
        cx - r * 0.55,
        cy + r * 0.95,
        cx - r,
        cy + r * 0.45,
        cx - r,
        cy,
      );
      ctx.arc(cx, cy, r, Math.PI, 0, false);
      ctx.bezierCurveTo(
        cx + r,
        cy + r * 0.45,
        cx + r * 0.55,
        cy + r * 0.95,
        cx,
        h,
      );
      ctx.closePath();
    },
  },
  {
    id: "checkmark",
    label: "Checkmark",
    // A tick stroke given thickness — a two-segment polyline outlined.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.0, 0.55],
        [0.16, 0.4],
        [0.4, 0.62],
        [0.84, 0.12],
        [1.0, 0.28],
        [0.4, 0.92],
      ]);
    },
  },
  {
    id: "x-mark",
    label: "X Mark",
    // A thick cross / multiplication mark.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0.15, 0.0],
        [0.5, 0.32],
        [0.85, 0.0],
        [1.0, 0.15],
        [0.68, 0.5],
        [1.0, 0.85],
        [0.85, 1.0],
        [0.5, 0.68],
        [0.15, 1.0],
        [0.0, 0.85],
        [0.32, 0.5],
        [0.0, 0.15],
      ]);
    },
  },
  {
    id: "shield",
    label: "Shield",
    // Crest: flat shoulders, sides curving inward to a point at the bottom.
    trace: (ctx, w, h) => {
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w, h * 0.15);
      ctx.lineTo(w, h * 0.5);
      ctx.bezierCurveTo(w, h * 0.8, w * 0.75, h * 0.95, w / 2, h);
      ctx.bezierCurveTo(w * 0.25, h * 0.95, 0, h * 0.8, 0, h * 0.5);
      ctx.lineTo(0, h * 0.15);
      ctx.closePath();
    },
  },
  {
    id: "cloud",
    label: "Cloud",
    // Union of a soft-cornered base slab and three puff circles — every
    // subpath is wound the same way, so the non-zero fill merges them into
    // one cloud silhouette (rounded flat base from the slab, bumpy top from
    // the puffs). The slab's bottom edge is the lowest point.
    trace: (ctx, w, h) => {
      const TAU = Math.PI * 2;
      const puff = (px: number, py: number, r: number): void => {
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, TAU);
      };
      roundRectPath(ctx, w * 0.14, h * 0.5, w * 0.72, h * 0.34, Math.min(w, h) * 0.16);
      puff(w * 0.32, h * 0.54, w * 0.2); // left bump
      puff(w * 0.52, h * 0.38, w * 0.26); // tall middle bump
      puff(w * 0.72, h * 0.52, w * 0.22); // right bump
    },
  },
  {
    id: "crescent",
    label: "Crescent Moon",
    // Lune traced as two arcs meeting at the horns: the outer rim (the long
    // way round a disc) then the inner bite (a same-radius disc offset right).
    // Tracing only the real boundary avoids the stray fill a full-circle
    // subtraction leaves where the cutting disc pokes past the outer rim.
    trace: (ctx, w, h) => {
      const R = Math.min(w, h) / 2;
      const cx = w / 2;
      const cy = h / 2;
      const d = R * 0.5; // cutting-disc offset → crescent thickness
      const u = d / 2; // x of the two circle intersections, relative to cx
      const yi = Math.sqrt(Math.max(0, R * R - u * u));
      // outer rim: top horn → (round the left) → bottom horn
      ctx.arc(cx, cy, R, Math.atan2(-yi, u), Math.atan2(yi, u), true);
      // inner bite: bottom horn → (round the left of the offset disc) → top horn
      ctx.arc(cx + d, cy, R, Math.atan2(yi, u - d), Math.atan2(-yi, u - d), false);
      ctx.closePath();
    },
  },
  {
    id: "teardrop",
    label: "Teardrop",
    // Round at the bottom, tapering to a point at the top centre.
    trace: (ctx, w, h) => {
      const cx = w / 2;
      const cy = h * 0.62;
      const r = Math.min(w / 2, h * 0.38);
      ctx.moveTo(cx, 0);
      ctx.bezierCurveTo(cx + r * 0.95, cy - r * 0.7, cx + r, cy, cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI, false);
      ctx.bezierCurveTo(cx - r, cy, cx - r * 0.95, cy - r * 0.7, cx, 0);
      ctx.closePath();
    },
  },
  {
    id: "banner",
    label: "Banner",
    // Ribbon: a horizontal band with V-notched ends.
    trace: (ctx, w, h) => {
      poly(ctx, w, h, [
        [0, 0.15],
        [0.85, 0.15],
        [1, 0.5],
        [0.85, 0.85],
        [0, 0.85],
        [0.15, 0.5],
      ]);
    },
  },
] as const satisfies readonly ShapeDef[];

// The shape kind — a string union of every registry id. Derived from the
// `as const` `SHAPE_DEFS` literal so adding an entry above widens it for free.
export type ShapeKind = (typeof SHAPE_DEFS)[number]["id"];

// Stable lookup by id. Built once at module load.
export const SHAPE_DEF_BY_ID: Readonly<Record<ShapeKind, ShapeDef>> =
  Object.fromEntries(SHAPE_DEFS.map((d) => [d.id, d])) as Record<
    ShapeKind,
    ShapeDef
  >;

// Readonly non-empty tuple of every shape id, for `z.enum`. `rect` is first so
// the schema default (`.default("rect")`) lines up with element [0]. The cast
// preserves the literal union while satisfying `z.enum`'s tuple constraint.
export const SHAPE_IDS = SHAPE_DEFS.map((d) => d.id) as [
  ShapeKind,
  ...ShapeKind[],
];
