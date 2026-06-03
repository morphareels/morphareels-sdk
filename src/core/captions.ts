// Auto-caption helpers shared by the editor (client-side enrichment) and the
// worker MCP. Turns a clip's Whisper transcript into a synced caption track and
// nests it with the video: the caption text layers go in a group named
// "captions", and that group is grouped together with the video layer.
//
// Pure — operates on a Project via the shared tool dispatchers in ./tools.ts.
// The transcript itself lives in an R2 side-car (not the project JSON), so the
// I/O layer fetches it and passes the words in.

import { dispatch, type ToolDispatch } from "./tools.ts";
import { findParentGroup, type Project } from "./schemas.ts";

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

const clipStem = (filename: string): string =>
  filename.replace(/\.[^.]+$/, "");

export const videoElementIdForClip = (
  project: Project,
  clip: string,
): string | null => {
  const v = project.video_layers.find((x) => x.clip === clip);
  return v ? `video.${v.id}` : null;
};

// True when this video already sits in a group that contains a "captions"
// group — the idempotency guard so we never double-caption.
export const hasCaptionsForClip = (
  project: Project,
  videoElementId: string,
): boolean => {
  const parentId = findParentGroup(project, videoElementId);
  if (!parentId) return false;
  const parent = project.groups.find((g) => g.id === parentId);
  if (!parent) return false;
  return parent.children.some((cid) => {
    if (!cid.startsWith("group.")) return false;
    const g = project.groups.find((x) => x.id === cid.slice("group.".length));
    return (g?.name ?? "").trim().toLowerCase() === "captions";
  });
};

// Remove the "captions" track for a clip: drop every text layer inside the
// clip's "captions" group, then dissolve the now-empty group. Used by the
// "restart captioning" path so a rebuild regenerates rather than no-op'ing on
// the hasCaptionsForClip guard. No-op (ok: true, removed: 0) when the clip has
// no captions. Pure — mirrors hasCaptionsForClip's lookup.
export const removeCaptionsForClip = (
  project: Project,
  videoElementId: string,
): { project: Project; ok: boolean; removed: number } => {
  const parentId = findParentGroup(project, videoElementId);
  if (!parentId) return { project, ok: true, removed: 0 };
  const parent = project.groups.find((g) => g.id === parentId);
  if (!parent) return { project, ok: true, removed: 0 };
  const capChildId = parent.children.find((cid) => {
    if (!cid.startsWith("group.")) return false;
    const g = project.groups.find((x) => x.id === cid.slice("group.".length));
    return (g?.name ?? "").trim().toLowerCase() === "captions";
  });
  if (!capChildId) return { project, ok: true, removed: 0 };

  const capGroupId = capChildId.slice("group.".length);
  const capGroup = project.groups.find((g) => g.id === capGroupId);
  const childIds = capGroup ? [...capGroup.children] : [];

  const removeLayer = dispatch.remove_layer as ToolDispatch;
  const ungroupLayers = dispatch.ungroup_layers as ToolDispatch;

  let cur = project;
  let removed = 0;
  for (const cid of childIds) {
    const out = removeLayer(cur, { elementId: cid });
    if (out.result.ok) {
      cur = out.project;
      removed += 1;
    }
  }
  // Dissolve the now-empty "captions" group (ungroup takes the bare id).
  const un = ungroupLayers(cur, { groupId: capGroupId });
  if (un.result.ok) cur = un.project;
  return { project: cur, ok: true, removed };
};

export interface BuildCaptionsResult {
  project: Project;
  ok: boolean;
  error?: string;
  captionsGroupId?: string;
  lineCount?: number;
}

// Add a caption track for `clip`, wrap the caption layers in a "captions"
// group, and group that with the video layer. Idempotent + no-op when there's
// nothing to caption. Returns the (possibly unchanged) project.
export const buildCaptionsForClip = (
  project: Project,
  opts: { clip: string; lines: CaptionLine[]; style?: string },
): BuildCaptionsResult => {
  const { clip, lines } = opts;
  const style = opts.style ?? "bold-outline";

  const videoElementId = videoElementIdForClip(project, clip);
  if (!videoElementId) {
    return { project, ok: false, error: `no video layer references clip ${clip}` };
  }
  if (lines.length === 0) {
    return { project, ok: false, error: "no caption lines" };
  }
  if (hasCaptionsForClip(project, videoElementId)) {
    return { project, ok: true, lineCount: 0 }; // already captioned — no-op
  }

  const addCaptionTrack = dispatch.add_caption_track as ToolDispatch;
  const groupLayers = dispatch.group_layers as ToolDispatch;
  const reorderLayer = dispatch.reorder_layer as ToolDispatch;

  // 1. caption text layers (line-sync, lower-third bold-outline by default).
  // Wide band so the short lines render big (~80% of canvas width).
  const track = addCaptionTrack(project, {
    lines,
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
  let cur = track.project;

  // 2. wrap them in a "captions" group.
  const capGroup = groupLayers(cur, { elementIds: captionIds, name: "captions" });
  if (!capGroup.result.ok) {
    return { project: cur, ok: false, error: `group captions failed: ${capGroup.result.error}` };
  }
  const captionsGroupId = (capGroup.result.data as { elementId: string }).elementId;
  cur = capGroup.project;

  // 3. group [video, captions] together — only when they share a parent (both
  // freshly at root is the common case). If the video is already nested, leave
  // the captions group adjacent rather than failing.
  if (findParentGroup(cur, videoElementId) === findParentGroup(cur, captionsGroupId)) {
    const video = cur.video_layers.find((v) => `video.${v.id}` === videoElementId);
    const parentName = (video?.name && video.name.trim()) || clipStem(clip);
    const parent = groupLayers(cur, {
      elementIds: [videoElementId, captionsGroupId],
      name: parentName,
    });
    if (parent.result.ok) cur = parent.project;
  }

  // Captions must sit ABOVE the video — reorder the video to the bottom of its
  // parent so a full-frame clip never hides the captions (correct by
  // construction; index 0 = bottom of the sibling stack).
  const reorder = reorderLayer(cur, { elementId: videoElementId, newIndex: 0 });
  if (reorder.result.ok) cur = reorder.project;

  return { project: cur, ok: true, captionsGroupId, lineCount: lines.length };
};
