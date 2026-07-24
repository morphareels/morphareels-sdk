// Auto-caption helpers shared by the editor (client-side enrichment) and the
// worker MCP. Turns a clip's Whisper transcript into a synced caption track and
// nests it with the video: the caption text layers go in a group named
// "captions", and that group is grouped together with the video layer.
//
// Pure — operates on a Project via the shared tool dispatchers in ./tools.ts.
// The transcript itself lives in an R2 side-car (not the project JSON), so the
// I/O layer fetches it and passes the words in.

import { dispatch, type ToolDispatch } from "./tools.ts";
import {
  findParentGroup,
  isCaptionsGroup,
  type Composition,
} from "./schemas.ts";

export interface CaptionLine {
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface TranscriptWordLike {
  word: string;
  start: number;
  end: number;
}

const FPS = 30;
// Chunking bounds — short, punchy lines that fill the caption band at a big
// size (TikTok/Reels style). Smaller = bigger on-screen text.
const MAX_CHARS = 18;
const MAX_WORDS = 3;
const PAUSE_SECONDS = 0.6;
// Caption band as a fraction of canvas width — big, ~80%-filling text.
const BAND_WIDTH_FRACTION = 0.82;

// Join transcript word tokens into display text. Whisper emits punctuation /
// hyphen continuations as their own tokens ("-class", ",", "'s"); attach those
// to the preceding word instead of inserting a space, so captions read
// "working-class", not "working -class".
const joinWords = (ws: ReadonlyArray<{ word: string }>): string =>
  ws
    .reduce((acc, x) => {
      const w = (x.word ?? "").trim();
      if (!w) return acc;
      if (!acc) return w;
      if (/^[-'’.,!?;:%)\]]/.test(w)) return acc + w;
      return `${acc} ${w}`;
    }, "")
    .replace(/\s+/g, " ")
    .trim();

// Group a flat word-timed transcript into caption lines. Breaks on
// sentence-ending punctuation, a char/word cap, or a speech gap. Line windows
// are gapless (each line holds until the next appears; the last gets a short
// tail), matching the line-sync caption read.
export const transcriptToCaptionLines = (
  words: ReadonlyArray<TranscriptWordLike>,
  fps: number = FPS,
): CaptionLine[] => {
  const clean = (words ?? []).filter(
    (w) =>
      w &&
      typeof w.word === "string" &&
      Number.isFinite(w.start) &&
      Number.isFinite(w.end),
  );
  if (clean.length === 0) return [];

  const groups: TranscriptWordLike[][] = [];
  let cur: TranscriptWordLike[] = [];
  const flush = () => {
    if (cur.length) {
      groups.push(cur);
      cur = [];
    }
  };
  for (let i = 0; i < clean.length; i++) {
    const w = clean[i];
    cur.push(w);
    const text = joinWords(cur);
    const endsSentence = /[.?!]["')\]]?$/.test(w.word.trim());
    const next = clean[i + 1];
    const gap = next ? next.start - w.end : 0;
    if (
      endsSentence ||
      cur.length >= MAX_WORDS ||
      text.length >= MAX_CHARS ||
      (next && gap > PAUSE_SECONDS)
    ) {
      flush();
    }
  }
  flush();

  const lines: CaptionLine[] = groups.map((g) => {
    const first = g[0];
    const last = g[g.length - 1];
    return {
      text: joinWords(g),
      startFrame: Math.max(0, Math.round(first.start * fps)),
      endFrame: Math.round(last.end * fps),
    };
  });

  // Gapless windows: a line stays up until the next one starts; the last line
  // gets a ~0.4s tail. Guarantee endFrame > startFrame.
  for (let i = 0; i < lines.length; i++) {
    lines[i].endFrame =
      i < lines.length - 1
        ? lines[i + 1].startFrame
        : lines[i].endFrame + Math.round(0.4 * fps);
    if (lines[i].endFrame <= lines[i].startFrame) {
      lines[i].endFrame = lines[i].startFrame + 1;
    }
  }
  return lines.filter((l) => l.text.length > 0);
};

export const videoElementIdForClip = (
  project: Composition,
  clip: string,
): string | null => {
  const v = project.video_layers.find((x) => x.clip === clip);
  return v ? `video.${v.id}` : null;
};

// True when any caption line is already welded to a clip of this video's LANE
// (its source split into one or more clips) — the idempotency guard so we never
// double-caption. Keyed on the welded `caption_source` anchor, not on grouping:
// captions are attached to their clip, not nested in a group with it.
export const hasCaptionsForClip = (
  project: Composition,
  videoElementId: string,
): boolean => {
  const v = project.video_layers.find((x) => `video.${x.id}` === videoElementId);
  if (!v) return false;
  const laneEids = new Set(
    project.video_layers
      .filter((x) => x.clip === v.clip)
      .map((x) => `video.${x.id}`),
  );
  return (project.text_layers ?? []).some(
    (t) => t.caption_source != null && laneEids.has(t.caption_source.clip_element_id),
  );
};

// Remove the caption track welded to a clip's LANE: drop every caption line
// anchored to any clip of that lane, then dissolve any now-empty "captions"
// group. Used by the "restart captioning" / re-add path so a rebuild regenerates
// rather than no-op'ing on the hasCaptionsForClip guard. No-op (ok: true,
// removed: 0) when the lane has no captions. Pure — mirrors hasCaptionsForClip.
export const removeCaptionsForClip = (
  project: Composition,
  videoElementId: string,
): { project: Composition; ok: boolean; removed: number } => {
  const v = project.video_layers.find((x) => `video.${x.id}` === videoElementId);
  if (!v) return { project, ok: true, removed: 0 };
  const laneEids = new Set(
    project.video_layers
      .filter((x) => x.clip === v.clip)
      .map((x) => `video.${x.id}`),
  );
  const targetEids = (project.text_layers ?? [])
    .filter(
      (t) => t.caption_source != null && laneEids.has(t.caption_source.clip_element_id),
    )
    .map((t) => `text.${t.id}`);
  if (targetEids.length === 0) return { project, ok: true, removed: 0 };

  // Note the groups these lines live in, so we can dissolve any left empty.
  const parentGroupIds = new Set<string>();
  for (const eid of targetEids) {
    const gid = findParentGroup(project, eid);
    if (gid) parentGroupIds.add(gid);
  }

  const removeLayer = dispatch.remove_layer as ToolDispatch;
  const ungroupLayers = dispatch.ungroup_layers as ToolDispatch;

  let cur = project;
  let removed = 0;
  for (const eid of targetEids) {
    const out = removeLayer(cur, { elementId: eid });
    if (out.result.ok) {
      cur = out.project;
      removed += 1;
    }
  }
  // Dissolve any now-empty "captions" group (ungroup takes the bare id).
  for (const gid of parentGroupIds) {
    const g = cur.groups.find((x) => x.id === gid);
    if (g && isCaptionsGroup(g) && g.children.length === 0) {
      const un = ungroupLayers(cur, { groupId: gid });
      if (un.result.ok) cur = un.project;
    }
  }
  return { project: cur, ok: true, removed };
};

export interface BuildCaptionsResult {
  project: Composition;
  ok: boolean;
  error?: string;
  captionsGroupId?: string;
  lineCount?: number;
}

// Weld a caption track to a clip's LANE — the caption analog of the clip's
// welded audio. The clip may be a montage: one source split into several lane
// clips laid end-to-end (each showing a different slice of the source). Each
// caption line's [startFrame, endFrame) is a window in the SOURCE timeline
// (Whisper word timings), so we route it onto whichever lane clip actually shows
// those words (max source-window overlap) and store a `caption_source` anchor on
// it; its on-timeline window then derives live from that clip's trim. Lines that
// fall entirely in a cut GAP (no clip shows them) are dropped — those words
// aren't spoken in the visible edit. The lines are wrapped in a "captions" group
// for the layer list but are NOT nested with the video: they attach to the clip
// via the anchor and the timeline draws them as a strip on the clip bar, never a
// separate lane. Idempotent + no-op when there's nothing to caption.
export const buildCaptionsForClip = (
  project: Composition,
  opts: { clip: string; lines: CaptionLine[]; style?: string },
): BuildCaptionsResult => {
  const { clip, lines } = opts;
  const style = opts.style ?? "bold-outline";

  const laneClips = project.video_layers.filter((v) => v.clip === clip);
  if (laneClips.length === 0) {
    return { project, ok: false, error: `no video layer references clip ${clip}` };
  }
  if (lines.length === 0) {
    return { project, ok: false, error: "no caption lines" };
  }
  if (hasCaptionsForClip(project, `video.${laneClips[0].id}`)) {
    return { project, ok: true, lineCount: 0 }; // already captioned — no-op
  }

  // Route each line onto the lane clip whose SOURCE window overlaps it most;
  // drop lines with no overlap (their words landed in a cut gap).
  const assigned: (CaptionLine & { clip_element_id: string })[] = [];
  for (const line of lines) {
    let bestClipId: string | null = null;
    let bestOverlap = 0;
    for (const v of laneClips) {
      const cin = Math.max(0, v.source_in_frame);
      const cout = v.source_out_frame ?? Number.POSITIVE_INFINITY;
      const overlap = Math.min(line.endFrame, cout) - Math.max(line.startFrame, cin);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestClipId = v.id;
      }
    }
    if (bestClipId && bestOverlap > 0) {
      assigned.push({ ...line, clip_element_id: `video.${bestClipId}` });
    }
  }
  if (assigned.length === 0) {
    return {
      project,
      ok: false,
      error: "no caption lines fall within the clip's visible ranges",
    };
  }

  const addCaptionTrack = dispatch.add_caption_track as ToolDispatch;
  // Wide band so the short lines render big (~80% of canvas width). Each line
  // carries its own clip_element_id → welded to the right montage piece.
  const track = addCaptionTrack(project, {
    lines: assigned,
    mode: "line-sync",
    style,
    width: Math.round(project.canvas_width * BAND_WIDTH_FRACTION),
  });
  if (!track.result.ok) {
    return { project, ok: false, error: `add_caption_track failed: ${track.result.error}` };
  }
  const captionIds = (track.result.data as { elementIds?: string[] }).elementIds ?? [];
  if (captionIds.length === 0) {
    return { project, ok: false, error: "caption track produced no layers" };
  }
  const captionsGroupId = (track.result.data as { groupElementId?: string }).groupElementId;
  // The "captions" group is created at root and floats to the top of the z-stack
  // (unlisted layers render on top), so the caption text sits above the clip on
  // the canvas — no explicit reorder needed.
  return {
    project: track.project,
    ok: true,
    captionsGroupId,
    lineCount: assigned.length,
  };
};
