// The razor — ONE resolver for cutting a video clip at a timeline frame.
//
// Splitting a clip is not just arithmetic on two trim fields. The razor that
// shipped in the editor store (`splitVideoLayer`) accreted, one bug at a time,
// everything a cut has to carry along:
//   • a RETIMED cut point — the playhead is a TIMELINE frame, the cut is a
//     SOURCE frame, and they only coincide at speed 1;
//   • speed-ramp rebasing — the right half's clip-relative curve is RESAMPLED
//     at the cut (`rebaseRamp`), not filtered, or the seam jumps;
//   • lane welding — both halves are pieces of ONE take and share a lane_id;
//   • z-placement — the right half lands adjacent to the left in the parent
//     group's `children[]` or in `layer_order`;
//   • welded-audio re-weld — a muted clip's split-out overlay is copied to the
//     right half (fades split across the cut) or that half goes silent;
//   • caption re-anchor — welded caption lines past the cut are repointed to
//     the right half, or the left half's shortened trim culls them.
//
// The freeze tool (`freeze_frame`) IS a split — cut, insert a still, resume —
// and its first version hand-rolled a second razor that silently dropped four
// of those six. Hence this module: the store's `splitVideoLayer` is now a thin
// undo/persistence wrapper over `splitClipAt`, and `freeze_frame` consumes the
// SAME function, so the two surfaces cannot drift. If a cut needs to learn
// something new, teach it here, once.
//
// Pure: no zustand, no browser APIs, no I/O. Mutates the (already-cloned)
// `project` in place, exactly like the other in-place composition surgeries
// (`removeWeldedCaptionLines`, `purgeElementId`).
import {
  rebaseRamp,
  retimedWindowFrames,
  sourceFrameAtTimelineOffset,
  type Composition,
  type VideoLayer,
} from "./schemas.ts";

export type LayerKind = "image" | "video" | "text" | "shapes" | "group";

const allLayerIdsForKind = (project: Composition, kind: LayerKind): Set<string> => {
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

export const generateLayerId = (project: Composition, kind: LayerKind): string => {
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

// Insert `newEid` directly after `afterEid` in whichever container orders it:
// the parent group's `children[]` when `afterEid` is nested, else `layer_order`.
// When `afterEid` isn't listed anywhere (fallback canonical order in use),
// append to `layer_order` so the new element has a deterministic place. The
// single placement rule for anything a split inserts adjacent to its source.
export const insertElementAfter = (
  project: Composition,
  afterEid: string,
  newEid: string,
): void => {
  for (const g of project.groups) {
    const cIdx = g.children.indexOf(afterEid);
    if (cIdx >= 0) {
      g.children = [
        ...g.children.slice(0, cIdx + 1),
        newEid,
        ...g.children.slice(cIdx + 1),
      ];
      return;
    }
  }
  const order = project.layer_order ?? [];
  const lIdx = order.indexOf(afterEid);
  project.layer_order =
    lIdx >= 0
      ? [...order.slice(0, lIdx + 1), newEid, ...order.slice(lIdx + 1)]
      : [...order, newEid];
};

export type ClipSplitOutcome =
  | { ok: true; leftEid: string; rightEid: string; cutSourceFrame: number }
  | { ok: false; error: string };

/**
 * Cut `elementId` at timeline frame `atTimelineFrame` (iMovie / FCP / Premiere
 * razor). The left half is the existing layer with `source_out_frame` shortened
 * to the cut; the right half is a brand-new layer that picks up where the left
 * ended (in SOURCE time) and starts at `atTimelineFrame` (in project time).
 * Everything else — clip, position, size, rotation, fill — is shared so the cut
 * is visually seamless until the user moves one of the halves.
 *
 * `naturalEndFrames` is the clip's source end in SOURCE frames when it is
 * knowable: a finite `source_out_frame`, or (in the editor) the decoded video's
 * duration for a natural-end clip. Pass `null` when it is unknowable — a
 * headless caller cutting a natural-end clip — and the clip is treated as
 * unbounded on the right (same convention as `cut_range`), so only the left
 * edge is guarded.
 *
 * Mutates `project` in place; on `ok: false` nothing has been touched.
 */
export const splitClipAt = (
  project: Composition,
  elementId: string,
  atTimelineFrame: number,
  naturalEndFrames: number | null,
): ClipSplitOutcome => {
  if (!elementId.startsWith("video.")) {
    return { ok: false, error: `elementId must be video.<id>: ${elementId}` };
  }
  const id = elementId.slice("video.".length);
  const idx = project.video_layers.findIndex((v) => v.id === id);
  if (idx < 0) {
    return { ok: false, error: `video layer not found: ${elementId}` };
  }
  const layer = project.video_layers[idx];

  const startT = Math.max(0, layer.timeline_start_frame);
  // RETIMED length — a 2x clip ends halfway along its source span, so a 1:1
  // end would allow a cut over frames the clip no longer covers. Unknown end
  // (null) ⇒ unbounded: only the left edge can be checked.
  const endT =
    naturalEndFrames === null
      ? Infinity
      : startT + retimedWindowFrames(layer, naturalEndFrames - layer.source_in_frame);
  // Reject when the cut is at or outside either edge (1-frame buffer so we
  // always leave something on each side).
  if (!Number.isFinite(atTimelineFrame) || atTimelineFrame <= startT) {
    return {
      ok: false,
      error: `frame ${atTimelineFrame} is not inside ${elementId} (starts at ${startT})`,
    };
  }
  if (atTimelineFrame >= endT) {
    return {
      ok: false,
      error: `frame ${atTimelineFrame} is past the end of ${elementId} (ends at ${endT})`,
    };
  }

  // The cut is a TIMELINE frame; the trim fields are SOURCE frames. Convert at
  // the clip's rate or a retimed clip cuts at the wrong content AND the halves
  // no longer meet (the left's retimed length wouldn't reach the cut).
  const cutSourceFrame = sourceFrameAtTimelineOffset(layer, atTimelineFrame - startT);
  const rightSourceIn = cutSourceFrame;
  const rightSourceOut = layer.source_out_frame; // original (may be null)
  const rightTimelineStart = atTimelineFrame;

  // Pick a fresh opaque id for the right half of the split. Both halves are
  // pieces of ONE take → they share a lane (track). Mint a lane from the
  // original's id if it somehow lacks one, and stamp it on both halves so they
  // read as a single track laid end-to-end.
  const rightId = generateLayerId(project, "video");
  const laneId = layer.lane_id ?? id;
  const leftLayer: VideoLayer = {
    ...layer,
    lane_id: laneId,
    source_out_frame: cutSourceFrame,
  };
  // Speed keyframes are CLIP-RELATIVE, so the right half's curve is rebased
  // onto its own start. `rebaseRamp` RESAMPLES at the cut — it seeds offset 0
  // with the rate the curve actually had there — rather than filtering to the
  // surviving keyframes. Filtering loses the head rate: with every keyframe
  // before the cut the ramp empties (and an empty ramp is 1x, not the held
  // tail), and with one straddling the cut the next keyframe's rate holds
  // backwards, so the seam jumps. The LEFT half keeps its post-cut keyframes
  // untouched — they are the interpolation target that makes its integrated
  // length land exactly on the cut.
  const cutOffset = atTimelineFrame - startT;
  const originalRamp = layer.speed_keyframes;
  const rightRamp = rebaseRamp(originalRamp ?? [], cutOffset);
  const rightLayer: VideoLayer = {
    ...layer,
    id: rightId,
    lane_id: laneId,
    ...(originalRamp ? { speed_keyframes: rightRamp } : {}),
    source_in_frame: rightSourceIn,
    source_out_frame: rightSourceOut,
    timeline_start_frame: rightTimelineStart,
  };
  project.video_layers = [
    ...project.video_layers.slice(0, idx),
    leftLayer,
    rightLayer,
    ...project.video_layers.slice(idx + 1),
  ];

  // Insert the new layer immediately after the left half in the parent group's
  // `children[]` or in `layer_order`. The new layer inherits no animation
  // tracks / styles — keeping those on the LEFT half preserves the existing
  // per-frame behaviour without doubling.
  const rightEid = `video.${rightId}`;
  const leftEid = elementId;
  insertElementAfter(project, leftEid, rightEid);

  // Belt-and-braces for a LEGACY clip whose split-out audio never got welded
  // (preprocessProject heals these to a footer on load, but an in-memory /
  // fixture project split before a reload could still carry a standalone
  // stem-matching overlay): weld it to the left half FIRST so the copy-to-right
  // logic below then welds BOTH halves and no orphan lane is left behind. Same
  // demux signature as the reconcile — a MUTED clip whose stem prefixes the
  // overlay's filename — so genuine music/voiceover is never captured.
  if (
    leftLayer.muted === true &&
    !(project.audio_overlays ?? []).some((o) => o.sourceLayerId === leftEid)
  ) {
    const stem = leftLayer.clip.replace(/\.[^.]+$/, "");
    const legacyIdx = (project.audio_overlays ?? []).findIndex(
      (o) => !o.sourceLayerId && stem.length > 0 && o.filename.startsWith(stem),
    );
    if (legacyIdx >= 0) {
      project.audio_overlays = project.audio_overlays.map((o, i) =>
        i === legacyIdx ? { ...o, sourceLayerId: leftEid } : o,
      );
    }
  }

  // A welded (split-out) audio overlay must survive the razor on BOTH sides:
  // the video layer itself is muted once its audio was split out, so without
  // this the right half is silent. Weld a copy of the overlay to the right
  // half — playback timing is DERIVED from each half's trim window
  // (weldedAudioTiming), so both copies automatically play the correct slice
  // of the same file. The fade-out belongs to the piece that actually ends the
  // sound (the right half); no new fades appear at the cut, matching every
  // NLE's razor.
  const weldIdx = (project.audio_overlays ?? []).findIndex(
    (o) => o.sourceLayerId === leftEid,
  );
  if (weldIdx >= 0) {
    const src = project.audio_overlays[weldIdx];
    const existingIds = new Set(project.audio_overlays.map((o) => o.id));
    let n = project.audio_overlays.length + 1;
    let overlayId = `audio_${n}`;
    while (existingIds.has(overlayId)) {
      n += 1;
      overlayId = `audio_${n}`;
    }
    project.audio_overlays = [
      ...project.audio_overlays.slice(0, weldIdx),
      { ...src, fadeOutFrames: 0 },
      {
        ...src,
        id: overlayId,
        sourceLayerId: rightEid,
        // Vestigial while welded (timing derives from the clip), but keep it
        // sensible for a later detach: the right half's file-time origin.
        startFrame: Math.max(0, rightTimelineStart - rightSourceIn),
        fadeInFrames: 0,
      },
      ...project.audio_overlays.slice(weldIdx + 1),
    ];
  }

  // Captions welded to this clip follow the razor. A caption line whose source
  // window begins at/after the cut belongs to the RIGHT half — the left half's
  // source_out now ends at the cut, so leaving it there would cull it
  // (deriveCaptionWindow clamps it to nothing). Repoint those to the right
  // half; earlier / straddling lines stay on the left (original id). Source
  // frames are unchanged — both halves share the same source file.
  for (const tl of project.text_layers) {
    const cs = tl.caption_source;
    if (
      cs &&
      cs.clip_element_id === leftEid &&
      cs.source_start_frame >= rightSourceIn
    ) {
      tl.caption_source = { ...cs, clip_element_id: rightEid };
    }
  }

  return { ok: true, leftEid, rightEid, cutSourceFrame };
};
