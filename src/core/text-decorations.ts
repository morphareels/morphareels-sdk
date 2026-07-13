// Per-character text decorations (underline / strikethrough) for text layers.
//
// A text layer stores its content as a single flat string (`text`); decorations
// live beside it as sets of half-open character ranges [start, end) in UTF-16
// code units into that string (see `textDecorationsSchema` in schemas.ts). This
// module is the ONE place that manipulates those ranges, shared by the editor
// (store, Inspector, both renderers) and the headless tools, so every surface
// agrees on normalization, toggling, offset rebasing, and how a range set maps
// onto rendered runs/lines. Pure + framework-free: no zustand, no DOM.

import type {
  TextDecorations,
  TextDecorationRange,
} from "./schemas.ts";

export type Range = TextDecorationRange; // { start: number; end: number }

export type DecorationKind = "underline" | "strikethrough";
export const DECORATION_KINDS: readonly DecorationKind[] = [
  "underline",
  "strikethrough",
];

// A contiguous run of text with a fixed decoration state — the unit the DOM
// renderer emits as one <span>.
export type DecorationRun = {
  text: string;
  underline: boolean;
  strikethrough: boolean;
};

// ── Interval-set primitives ─────────────────────────────────────────────────
// A "range list" is always kept normalized: integer offsets ≥ 0, end > start,
// sorted by start, with overlapping OR touching ranges merged into one (so two
// adjacent underlines read as a single continuous rule).

export const normalizeRanges = (ranges: readonly Range[]): Range[] => {
  const valid = ranges
    .map((r) => ({
      start: Math.max(0, Math.floor(r.start)),
      end: Math.floor(r.end),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    // `<=` merges touching ranges (last.end === r.start) as well as overlaps.
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
};

// Union in a new range.
export const addRange = (list: readonly Range[], a: number, b: number): Range[] =>
  b <= a ? normalizeRanges(list) : normalizeRanges([...list, { start: a, end: b }]);

// Cut [a, b) out of every range, leaving the left/right remainders.
export const subtractRange = (
  list: readonly Range[],
  a: number,
  b: number,
): Range[] => {
  if (b <= a) return normalizeRanges(list);
  const out: Range[] = [];
  for (const r of normalizeRanges(list)) {
    if (r.end <= a || r.start >= b) {
      out.push(r); // no overlap
      continue;
    }
    if (r.start < a) out.push({ start: r.start, end: a }); // left remainder
    if (r.end > b) out.push({ start: b, end: r.end }); // right remainder
  }
  return out;
};

// Is every character in [a, b) covered by the union of `list`?
export const isFullyCovered = (
  list: readonly Range[],
  a: number,
  b: number,
): boolean => {
  if (b <= a) return false;
  let cursor = a;
  for (const r of normalizeRanges(list)) {
    if (r.end <= cursor) continue;
    if (r.start > cursor) return false; // a gap before we reached `cursor`
    cursor = r.end;
    if (cursor >= b) return true;
  }
  return cursor >= b;
};

// Toggle [a, b): if fully covered → remove it; otherwise → add it. Matches the
// Google-Docs / Word convention for a decoration button acting on a selection.
export const toggleRange = (
  list: readonly Range[],
  a: number,
  b: number,
): Range[] =>
  b <= a
    ? normalizeRanges(list)
    : isFullyCovered(list, a, b)
      ? subtractRange(list, a, b)
      : addRange(list, a, b);

// ── Whole-object helpers (both kinds at once) ───────────────────────────────

// Normalize both lists and drop the field entirely when nothing remains, so a
// cleared layer stores no `decorations` key (keeps project JSON minimal and
// round-trips through the .strict() schema cleanly).
export const normalizeDecorations = (
  decorations: TextDecorations | null | undefined,
): TextDecorations | undefined => {
  if (!decorations) return undefined;
  const underline = normalizeRanges(decorations.underline ?? []);
  const strikethrough = normalizeRanges(decorations.strikethrough ?? []);
  if (underline.length === 0 && strikethrough.length === 0) return undefined;
  const out: TextDecorations = {};
  if (underline.length) out.underline = underline;
  if (strikethrough.length) out.strikethrough = strikethrough;
  return out;
};

// Remap a range's endpoints across a single-diff text edit described by (p,
// oldEnd, delta): the common-prefix length `p`, the end of the changed region in
// the OLD string `oldEnd`, and the length change `delta`. A range's endpoints
// carry OPPOSITE gravity at the edit boundary so a decorated word stays exactly
// decorated while text pre-/appended right against it stays plain:
//  • START has right-gravity — text inserted at the start boundary lands OUTSIDE
//    the range, so a boundary at/after the edit shifts (prepends push the start
//    right; the prepended text is not decorated).
//  • END has left-gravity — text inserted at the end boundary also lands OUTSIDE,
//    so a boundary at/before the edit stays put (appends don't extend it).
// Endpoints strictly inside a replaced span collapse to the edit (their
// characters are gone), so a range whose text was deleted normalizes away.
const remapStart = (o: number, p: number, oldEnd: number, delta: number): number =>
  o < p ? o : o >= oldEnd ? o + delta : oldEnd + delta;
const remapEnd = (o: number, p: number, oldEnd: number, delta: number): number =>
  o <= p ? o : o >= oldEnd ? o + delta : p;

const rebaseRanges = (
  list: readonly Range[],
  p: number,
  oldEnd: number,
  delta: number,
  newLen: number,
): Range[] =>
  normalizeRanges(
    list.map((r) => ({
      start: Math.min(newLen, remapStart(r.start, p, oldEnd, delta)),
      end: Math.min(newLen, remapEnd(r.end, p, oldEnd, delta)),
    })),
  );

// Rebase decoration offsets when a text layer's `text` changes, treating the
// change as a single contiguous replacement (which is what a <textarea> emits
// per keystroke / paste / delete). Common prefix + suffix pin the unchanged
// ends; the middle is remapped. Typing inside a decorated word extends it;
// deleting a decorated span removes its decoration.
export const rebaseDecorations = (
  oldText: string,
  newText: string,
  decorations: TextDecorations | null | undefined,
): TextDecorations | undefined => {
  if (!decorations) return undefined;
  if (oldText === newText) return normalizeDecorations(decorations);
  const oldLen = oldText.length;
  const newLen = newText.length;
  // Common prefix length.
  let p = 0;
  const maxP = Math.min(oldLen, newLen);
  while (p < maxP && oldText[p] === newText[p]) p++;
  // Common suffix length, not overlapping the prefix.
  let s = 0;
  const maxS = Math.min(oldLen, newLen) - p;
  while (
    s < maxS &&
    oldText[oldLen - 1 - s] === newText[newLen - 1 - s]
  )
    s++;
  const oldEnd = oldLen - s; // end of the changed region in the old string
  const delta = newLen - oldLen;
  const underline = rebaseRanges(
    decorations.underline ?? [],
    p,
    oldEnd,
    delta,
    newLen,
  );
  const strikethrough = rebaseRanges(
    decorations.strikethrough ?? [],
    p,
    oldEnd,
    delta,
    newLen,
  );
  return normalizeDecorations({ underline, strikethrough });
};

// True when a layer carries any decoration at all (for renderer fast-paths).
export const hasDecorations = (
  decorations: TextDecorations | null | undefined,
): boolean =>
  !!decorations &&
  ((decorations.underline?.length ?? 0) > 0 ||
    (decorations.strikethrough?.length ?? 0) > 0);

// ── Renderer mappings ───────────────────────────────────────────────────────

// Whitespace runs sitting at the end of a line — i.e. immediately before a
// "\n" or the end of the string. `[^\S\n]` = any whitespace except the
// newline itself, so blank lines survive as line breaks.
const TRAILING_LINE_WS = /[^\S\n]+(?=\n|$)/g;

// Strip trailing whitespace from every line of `text`. Trailing spaces have
// no ink, but both CSS (`white-space: pre`/`pre-wrap` before a forced break)
// and canvas fillText count them toward the line's advance width — which
// visibly shifts center- and right-aligned lines off the ink the user sees
// ("text alignment doesn't apply to multiple lines"). Every render surface
// aligns on this stripped model; the STORED text is never touched, so the
// caret / editing round-trip keeps the user's spaces.
export const stripLineTrailingWhitespace = (text: string): string =>
  text.replace(TRAILING_LINE_WS, "");

// stripLineTrailingWhitespace + decoration ranges remapped into the stripped
// string. Offsets after a removed span shift left by its length; an offset
// INSIDE a removed span collapses to the span's start (its characters are
// gone, so a decoration covering only trailing spaces normalizes away).
export const stripLineTrailingWhitespaceWithDecorations = (
  text: string,
  decorations: TextDecorations | null | undefined,
): { text: string; decorations: TextDecorations | undefined } => {
  const removed: Range[] = [];
  let m: RegExpExecArray | null;
  TRAILING_LINE_WS.lastIndex = 0;
  while ((m = TRAILING_LINE_WS.exec(text)) !== null) {
    removed.push({ start: m.index, end: m.index + m[0].length });
  }
  if (removed.length === 0) {
    return { text, decorations: normalizeDecorations(decorations) };
  }
  const stripped = stripLineTrailingWhitespace(text);
  const shift = (o: number): number => {
    let d = 0;
    for (const s of removed) {
      if (o <= s.start) break;
      d += Math.min(o, s.end) - s.start;
    }
    return o - d;
  };
  const remap = (list: readonly Range[] | undefined): Range[] =>
    (list ?? []).map((r) => ({ start: shift(r.start), end: shift(r.end) }));
  return {
    text: stripped,
    decorations: normalizeDecorations({
      underline: remap(decorations?.underline),
      strikethrough: remap(decorations?.strikethrough),
    }),
  };
};

const coversAt = (list: readonly Range[], offset: number): boolean =>
  list.some((r) => r.start <= offset && r.end > offset);

// Split `text` into consecutive runs, each with a fixed (underline,
// strikethrough) state — the DOM renderer maps each run to one <span>. Always
// returns at least one run (the whole string, undecorated, when there are no
// decorations).
export const splitRuns = (
  text: string,
  decorations: TextDecorations | null | undefined,
): DecorationRun[] => {
  const u = normalizeRanges(decorations?.underline ?? []);
  const s = normalizeRanges(decorations?.strikethrough ?? []);
  if (u.length === 0 && s.length === 0) {
    return [{ text, underline: false, strikethrough: false }];
  }
  const bounds = new Set<number>([0, text.length]);
  for (const r of [...u, ...s]) {
    if (r.start > 0 && r.start < text.length) bounds.add(r.start);
    if (r.end > 0 && r.end < text.length) bounds.add(r.end);
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const runs: DecorationRun[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const lo = cuts[i];
    const hi = cuts[i + 1];
    if (hi <= lo) continue;
    const underline = coversAt(u, lo);
    const strikethrough = coversAt(s, lo);
    const last = runs[runs.length - 1];
    if (
      last &&
      last.underline === underline &&
      last.strikethrough === strikethrough
    ) {
      last.text += text.slice(lo, hi);
    } else {
      runs.push({ text: text.slice(lo, hi), underline, strikethrough });
    }
  }
  return runs.length
    ? runs
    : [{ text, underline: false, strikethrough: false }];
};

// Intersect a range list with one rendered line's source span [lineStart,
// lineEnd) and return the overlapping sub-ranges as offsets RELATIVE to
// lineStart (i.e. character indices into the line's substring), so the canvas
// renderer can measure prefix widths directly. Returns [] when nothing on the
// line is decorated.
export const lineDecorationSegments = (
  lineStart: number,
  lineEnd: number,
  ranges: readonly Range[] | undefined,
): Range[] => {
  if (!ranges || ranges.length === 0 || lineEnd <= lineStart) return [];
  const out: Range[] = [];
  for (const r of ranges) {
    const s = Math.max(r.start, lineStart);
    const e = Math.min(r.end, lineEnd);
    if (e > s) out.push({ start: s - lineStart, end: e - lineStart });
  }
  return out;
};
