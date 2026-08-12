// Pure track evaluator. scale and rotation are applied with center transform-origin.
import type {
  ColorKeyframe,
  Easing,
  Fill,
  FillStop,
  Keyframe,
  LinearGradient,
  LoopMode,
  RadialGradient,
  SolidFill,
  TrackProperty,
} from "./schemas.ts";

export type TrackSet = Partial<Record<TrackProperty, Keyframe[]>>;

const linear = (t: number): number => t;
const easeIn = (t: number): number => t * t * t;
const easeOut = (t: number): number => {
  const u = 1 - t;
  return 1 - u * u * u;
};
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Standard CSS cubic-bezier(p1x, p1y, p2x, p2y) — endpoints fixed at (0,0) and (1,1).
// Solves for t given x via Newton's method, then evaluates y(t).
export const cubicBezier = (
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  x: number,
): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDerivX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;

  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const xEst = sampleX(t) - x;
    if (Math.abs(xEst) < 1e-6) return sampleY(t);
    const d = sampleDerivX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= xEst / d;
  }
  // bisection fallback
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 16; i += 1) {
    const xEst = sampleX(t);
    if (Math.abs(xEst - x) < 1e-6) break;
    if (xEst < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
};

// CSS-equivalent named bezier presets. Coords from easings.net — battle-tested
// values that designers tune for. The "back" family overshoots: y > 1 in the
// second control point pushes the value past the target before settling, which
// is what gives spring-like pop without a true spring solver.
const NAMED_BEZIER: Record<string, [number, number, number, number]> = {
  outQuart: [0.165, 0.84, 0.44, 1],
  outExpo: [0.19, 1, 0.22, 1],
  outBack: [0.34, 1.56, 0.64, 1],
  inBack: [0.36, 0, 0.66, -0.56],
  inOutBack: [0.68, -0.6, 0.32, 1.6],
};

// Eases by the keyframe's own `easing` field (the segment ENDING at this
// keyframe). Numeric and colour keyframes share the same easing shape, so
// this only reads what's common to both.
type EasedKeyframe = Pick<Keyframe, "easing" | "bezier">;
const applyEasing = (kf: EasedKeyframe, t: number): number => {
  switch (kf.easing) {
    case "linear":
      return linear(t);
    case "easeIn":
      return easeIn(t);
    case "easeOut":
      return easeOut(t);
    case "easeInOut":
      return easeInOut(t);
    case "cubicBezier": {
      const b = kf.bezier ?? [0.42, 0, 0.58, 1];
      return cubicBezier(b[0], b[1], b[2], b[3], t);
    }
    case "hold":
      // Step-end. Eased ramp is 0 across the whole interior of the segment,
      // 1 only at the right edge — so the resolved value is the previous
      // keyframe's value everywhere except exactly at this keyframe's frame,
      // where it jumps to this keyframe's value. AE / Premiere / FCP all
      // model a hold keyframe identically.
      return t < 1 ? 0 : 1;
    default: {
      const b = NAMED_BEZIER[kf.easing];
      if (b) return cubicBezier(b[0], b[1], b[2], b[3], t);
      return linear(t);
    }
  }
};

/** Shape a 0..1 ramp by a named easing — the same curve table keyframes use,
 * for consumers that have a progress value rather than a keyframe pair (edge
 * transitions). Sharing the table is the point: a "pop" entry transition and a
 * hand-authored outBack keyframe must not drift apart. */
export const easeUnit = (easing: Easing, t: number): number =>
  applyEasing({ easing }, t < 0 ? 0 : t > 1 ? 1 : t);

// Easing applies to the segment ENDING at that keyframe (i.e. the easing function
// of keyframe[i] shapes interpolation across [keyframe[i-1], keyframe[i]]).
//
// `loop` controls extrapolation past the boundary keyframes. Default (or
// undefined) is "hold": before the first keyframe, holds the first value;
// past the last, holds the last. The other modes wrap the requested frame
// into the keyframe span and recurse:
//   - "loop"      — frame wraps modulo (cycleLen). Animation restarts.
//   - "ping-pong" — wraps modulo 2*cycleLen; the second half is mirrored.
//   - "cycle"     — like "loop" but each completed cycle adds the boundary
//                   delta to the resolved value, so a finite curve becomes
//                   an endless ramp (used for scrolling text, etc.).
// Does this track's value actually CHANGE over time? A track needs two
// keyframes to vary at all, and a run of keyframes that all hold the same
// value is a redundant hold — `evaluateTrack` returns a constant for both, so
// neither is animation no matter how many dots the Timeline draws. The single
// source for every "is this layer animated?" indicator; deriving it inline
// twice is how two surfaces end up disagreeing about the same track.
export const trackVaries = (keyframes: Keyframe[]): boolean =>
  keyframes.length >= 2 &&
  keyframes.some((k) => k.value !== keyframes[0].value);

// Empty keyframe list: returns 0 (caller should usually short-circuit before this).
export const evaluateTrack = (
  keyframes: Keyframe[],
  frame: number,
  loop?: LoopMode,
): number => {
  if (keyframes.length === 0) return 0;
  if (keyframes.length === 1) return keyframes[0].value;

  const sorted =
    keyframes.every((k, i) => i === 0 || k.frame >= keyframes[i - 1].frame)
      ? keyframes
      : [...keyframes].sort((a, b) => a.frame - b.frame);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const mode = loop ?? "hold";

  if (frame >= first.frame && frame <= last.frame) {
    return sampleInside(sorted, frame);
  }

  // Out of the keyframe span — apply extrapolation.
  if (mode === "hold") {
    return frame < first.frame ? first.value : last.value;
  }
  const cycleLen = last.frame - first.frame;
  if (cycleLen <= 0) {
    // Degenerate: all keyframes at the same frame. Hold the last value.
    return last.value;
  }
  if (mode === "loop") {
    // ((frame - first) mod cycleLen + cycleLen) mod cycleLen — keeps the
    // wrap positive for frames before `first` too.
    const offset = ((frame - first.frame) % cycleLen + cycleLen) % cycleLen;
    return sampleInside(sorted, first.frame + offset);
  }
  if (mode === "ping-pong") {
    const period = cycleLen * 2;
    const offset = ((frame - first.frame) % period + period) % period;
    const phase = offset <= cycleLen ? offset : period - offset;
    return sampleInside(sorted, first.frame + phase);
  }
  // cycle: like loop, but each completed cycle adds (last - first) to the
  // value so the curve "continues" past the boundary in either direction.
  const rel = frame - first.frame;
  const cycles = Math.floor(rel / cycleLen);
  const within = rel - cycles * cycleLen;
  const wrapped = sampleInside(sorted, first.frame + within);
  return wrapped + cycles * (last.value - first.value);
};

// Interpolate inside the keyframe span. Assumes `keyframes` is sorted and
// `frame` is in [first.frame, last.frame]. Branched out of evaluateTrack so
// the loop-mode wrappers can recurse without re-entering the boundary
// short-circuits.
const sampleInside = (keyframes: Keyframe[], frame: number): number => {
  if (frame <= keyframes[0].frame) return keyframes[0].value;
  if (frame >= keyframes[keyframes.length - 1].frame)
    return keyframes[keyframes.length - 1].value;
  for (let i = 1; i < keyframes.length; i += 1) {
    const a = keyframes[i - 1];
    const b = keyframes[i];
    if (frame <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.value;
      const t = (frame - a.frame) / span;
      const eased = applyEasing(b, t);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return keyframes[keyframes.length - 1].value;
};

// ---------------------------------------------------------------------------
// Colour (Fill) interpolation
// ---------------------------------------------------------------------------
//
// Same time + easing semantics as `evaluateTrack`. The value type is a Fill
// (solid / linear / radial) and the inner segment lerp is structural:
//
//   - same kind, equal-shape gradients  → lerp stops position-by-position,
//     lerp angle / cx / cy / radius linearly.
//   - same kind, different stop counts  → resample both to the UNION of
//     stop positions (sampleGradient below), then lerp stop-by-stop.
//   - solid → gradient (or vice versa) → promote the solid to a 2-stop
//     same-colour gradient of the destination kind and lerp normally.
//   - linear → radial (or vice versa)  → step at t < 0.5. Mixing gradient
//     geometries mid-animation is unusual and the lerp has no good
//     interpretation; users animate within a kind in practice.
//
// `loop` controls extrapolation past the boundary keyframes. "cycle" is
// treated the same as "loop" for colour tracks — the boundary-delta concept
// has no meaning for colours.

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const parseHexChannel = (hex: string, offset: number): number =>
  parseInt(hex.slice(offset, offset + 2), 16);

const toHexByte = (v: number): string => {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return n.toString(16).padStart(2, "0");
};

const lerpColor = (a: string, b: string, t: number): string => {
  const ar = parseHexChannel(a, 1);
  const ag = parseHexChannel(a, 3);
  const ab = parseHexChannel(a, 5);
  const br = parseHexChannel(b, 1);
  const bg = parseHexChannel(b, 3);
  const bb = parseHexChannel(b, 5);
  return `#${toHexByte(ar + (br - ar) * t)}${toHexByte(ag + (bg - ag) * t)}${toHexByte(ab + (bb - ab) * t)}`;
};

const lerpStop = (a: FillStop, b: FillStop, t: number): FillStop => ({
  pos: a.pos + (b.pos - a.pos) * t,
  color: lerpColor(a.color, b.color, t),
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});

// Sample a sorted stops array at a position in 0..1. Walks the segments;
// before the first stop returns the first stop's colour, after the last
// returns the last stop's. Stop opacity is interpolated alongside colour.
const sampleGradient = (stops: FillStop[], pos: number): FillStop => {
  if (stops.length === 0) {
    return { pos, color: "#000000", opacity: 1 };
  }
  const sorted =
    stops.every((s, i) => i === 0 || s.pos >= stops[i - 1].pos)
      ? stops
      : [...stops].sort((a, b) => a.pos - b.pos);
  if (pos <= sorted[0].pos) return { ...sorted[0], pos };
  if (pos >= sorted[sorted.length - 1].pos) {
    return { ...sorted[sorted.length - 1], pos };
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (pos <= b.pos) {
      const span = b.pos - a.pos;
      const t = span <= 0 ? 1 : (pos - a.pos) / span;
      return {
        pos,
        color: lerpColor(a.color, b.color, t),
        opacity: a.opacity + (b.opacity - a.opacity) * t,
      };
    }
  }
  return { ...sorted[sorted.length - 1], pos };
};

// Build the sorted union of positions from two stops arrays. Used to
// resample two gradients to a common stop schedule before lerping.
const unionStopPositions = (a: FillStop[], b: FillStop[]): number[] => {
  const set = new Set<number>();
  for (const s of a) set.add(clamp01(s.pos));
  for (const s of b) set.add(clamp01(s.pos));
  // Ensure both endpoints are always represented so the gradient covers the
  // full 0..1 range even when neither input has an explicit endpoint stop.
  set.add(0);
  set.add(1);
  return [...set].sort((x, y) => x - y);
};

const solidToStops = (s: SolidFill): FillStop[] => [
  { pos: 0, color: s.color, opacity: s.opacity },
  { pos: 1, color: s.color, opacity: s.opacity },
];

const promoteToLinear = (s: SolidFill, target: LinearGradient): LinearGradient => ({
  type: "linear",
  stops: solidToStops(s),
  angle: target.angle,
});

const promoteToRadial = (s: SolidFill, target: RadialGradient): RadialGradient => ({
  type: "radial",
  stops: solidToStops(s),
  cx: target.cx,
  cy: target.cy,
  radius: target.radius,
});

// Linear interpolation between two Fills. See block comment above for the
// per-kind rules. Returns a freshly constructed Fill — caller owns it.
export const lerpFill = (a: Fill, b: Fill, t: number): Fill => {
  if (t <= 0) return a;
  if (t >= 1) return b;

  // Mask fills crossfade only with each other when they reference the same
  // source layer (in which case we lerp colour + opacity). Any other mix —
  // mask↔solid, mask↔linear, mask↔radial, or two masks against different
  // source layers — has no meaningful blend; step at t=0.5.
  if (a.type === "mask" && b.type === "mask") {
    if (a.layer_id === b.layer_id) {
      return {
        type: "mask",
        layer_id: a.layer_id,
        color: lerpColor(a.color, b.color, t),
        opacity: a.opacity + (b.opacity - a.opacity) * t,
      };
    }
    return t < 0.5 ? a : b;
  }
  if (a.type === "mask" || b.type === "mask") {
    return t < 0.5 ? a : b;
  }

  // Cross-kind gradient mix (linear ↔ radial): no meaningful blend; step.
  if (
    (a.type === "linear" && b.type === "radial") ||
    (a.type === "radial" && b.type === "linear")
  ) {
    return t < 0.5 ? a : b;
  }

  // Promote solid to a 2-stop gradient of the other side's kind so the
  // crossfade has a gradient to walk through.
  if (a.type === "solid" && b.type === "linear") {
    return lerpFill(promoteToLinear(a, b), b, t);
  }
  if (a.type === "linear" && b.type === "solid") {
    return lerpFill(a, promoteToLinear(b, a), t);
  }
  if (a.type === "solid" && b.type === "radial") {
    return lerpFill(promoteToRadial(a, b), b, t);
  }
  if (a.type === "radial" && b.type === "solid") {
    return lerpFill(a, promoteToRadial(b, a), t);
  }

  if (a.type === "solid" && b.type === "solid") {
    return {
      type: "solid",
      color: lerpColor(a.color, b.color, t),
      opacity: a.opacity + (b.opacity - a.opacity) * t,
    };
  }

  // Same kind, same number / different number of stops: resample to a
  // common position union and lerp pairwise.
  if (a.type === "linear" && b.type === "linear") {
    const positions = unionStopPositions(a.stops, b.stops);
    const stops: FillStop[] = positions.map((pos) =>
      lerpStop(sampleGradient(a.stops, pos), sampleGradient(b.stops, pos), t),
    );
    return {
      type: "linear",
      stops,
      angle: a.angle + (b.angle - a.angle) * t,
    };
  }
  if (a.type === "radial" && b.type === "radial") {
    const positions = unionStopPositions(a.stops, b.stops);
    const stops: FillStop[] = positions.map((pos) =>
      lerpStop(sampleGradient(a.stops, pos), sampleGradient(b.stops, pos), t),
    );
    return {
      type: "radial",
      stops,
      cx: a.cx + (b.cx - a.cx) * t,
      cy: a.cy + (b.cy - a.cy) * t,
      radius: a.radius + (b.radius - a.radius) * t,
    };
  }
  // Unreachable — every (a.type, b.type) pair is handled above.
  return b;
};

// Same wrapping logic as evaluateTrack: clamps / wraps the frame into the
// keyframe span by loop mode, then lerps within the surrounding segment.
// "cycle" is treated as "loop" — no boundary delta concept applies to fills.
export const evaluateColorTrack = (
  keyframes: ColorKeyframe[],
  frame: number,
  loop?: LoopMode,
): Fill | null => {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) return keyframes[0].value;

  const sorted =
    keyframes.every((k, i) => i === 0 || k.frame >= keyframes[i - 1].frame)
      ? keyframes
      : [...keyframes].sort((a, b) => a.frame - b.frame);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const mode = loop ?? "hold";

  let effectiveFrame = frame;
  if (frame < first.frame || frame > last.frame) {
    if (mode === "hold") {
      return frame < first.frame ? first.value : last.value;
    }
    const cycleLen = last.frame - first.frame;
    if (cycleLen <= 0) return last.value;
    if (mode === "ping-pong") {
      const period = cycleLen * 2;
      const offset = ((frame - first.frame) % period + period) % period;
      effectiveFrame =
        first.frame + (offset <= cycleLen ? offset : period - offset);
    } else {
      // loop / cycle (cycle has no meaning for fills — fall through to loop).
      const offset =
        ((frame - first.frame) % cycleLen + cycleLen) % cycleLen;
      effectiveFrame = first.frame + offset;
    }
  }

  return sampleColorInside(sorted, effectiveFrame);
};

const sampleColorInside = (
  keyframes: ColorKeyframe[],
  frame: number,
): Fill => {
  if (frame <= keyframes[0].frame) return keyframes[0].value;
  if (frame >= keyframes[keyframes.length - 1].frame) {
    return keyframes[keyframes.length - 1].value;
  }
  for (let i = 1; i < keyframes.length; i += 1) {
    const a = keyframes[i - 1];
    const b = keyframes[i];
    if (frame <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.value;
      const t = (frame - a.frame) / span;
      const eased = applyEasing(b, t);
      return lerpFill(a.value, b.value, eased);
    }
  }
  return keyframes[keyframes.length - 1].value;
};
