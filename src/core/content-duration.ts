// Content-derived composition duration.
//
// Morpha's composition length is NOT a user input — it is a *derived* value
// that always fits the content. `computeContentDurationFrames` walks every
// time-based thing in a project (keyframes, video windows, audio overlays) and
// returns the smallest `durationInFrames` (30 fps) that contains all of it,
// never below a floor. The editor recomputes this after every mutation (and
// again as media metadata loads); the worker recomputes it on every write-back.
//
// `duration_seconds` stays a stored field — it's just kept in sync with this
// function rather than being set by hand. The drag handle / time-pill / the
// `set_duration` tool that used to write it have all been retired.

import type { AnyLayer, Composition, VideoLayer, AudioOverlay } from "./schemas.ts";
import { effectiveFrameOffset, videoWindow } from "./schemas.ts";

const FPS = 30;
const DEFAULT_FLOOR_SECONDS = 1;

export interface ContentDurationOptions {
  // Natural source length (seconds) of a video layer's clip, when known. In
  // the editor this comes from the loaded <video> (store `videoDurations`); in
  // headless contexts it's usually unknown — return undefined and we fall back
  // to what the trim window alone reveals.
  videoNaturalSeconds?: (layer: VideoLayer) => number | undefined;
  // Natural decoded length (seconds) of an audio overlay's asset, when known.
  audioNaturalSeconds?: (overlay: AudioOverlay) => number | undefined;
  // Minimum composition length. Defaults to 1s (the historical hard-clamp
  // minimum) so a content-less / static-only project doesn't collapse to zero.
  floorSeconds?: number;
}

// The last project-timeline frame (exclusive end / a frame *count*) reached by
// a video layer. Reuses `videoWindow` so the trim math has exactly one home.
const videoEndFrames = (
  layer: VideoLayer,
  natural: number | undefined,
): number => {
  // `videoWindow` clamps the out-point to floor(sourceDurationSeconds * fps),
  // so we must hand it a duration that doesn't truncate the real window:
  //   - natural known        → use it (editor path; exact)
  //   - natural unknown + explicit out → the out-point itself bounds the window
  //   - natural unknown + null  out    → end is genuinely unknown; the window
  //                                      collapses to zero and the layer
  //                                      contributes only its start frame.
  let sourceSeconds: number;
  if (natural !== undefined && Number.isFinite(natural) && natural > 0) {
    sourceSeconds = natural;
  } else if (layer.source_out_frame !== null) {
    sourceSeconds = layer.source_out_frame / FPS;
  } else {
    sourceSeconds = layer.source_in_frame / FPS;
  }
  return videoWindow(layer, sourceSeconds).endFrame;
};

// The exclusive end frame (a frame count) reached by an audio overlay.
const audioEndFrames = (
  overlay: AudioOverlay,
  natural: number | undefined,
): number => {
  if (overlay.endFrame !== undefined) return overlay.endFrame;
  if (natural !== undefined && Number.isFinite(natural) && natural > 0) {
    return overlay.startFrame + Math.ceil(natural * FPS);
  }
  return overlay.startFrame;
};

// Smallest `durationInFrames` (an integer frame *count*, 30 fps) that contains
// all of the project's content, clamped up to the floor. Frames run
// 0..(count - 1), so a keyframe at frame N needs a count of N + 1 to be
// playable; video/audio ends are already exclusive counts.
export const computeContentDurationFrames = (
  project: Composition,
  opts: ContentDurationOptions = {},
): number => {
  const floorSeconds = opts.floorSeconds ?? DEFAULT_FLOOR_SECONDS;
  let frames = Math.max(1, Math.ceil(floorSeconds * FPS));

  // Numeric animation tracks (layer.animations[property] = Keyframe[]) and
  // fill-valued colour tracks (layer.color_tracks[property] = ColorKeyframe[])
  // now live nested on each layer record. Walk all five layer arrays. Keyframes
  // are BLOCK-LOCAL for a blocked layer, so their absolute end is
  // effectiveFrameOffset (block start + ancestor band origins) + kf.frame + 1;
  // a blockless layer has offset 0 ⇒ absolute frames (unchanged). A block also
  // bounds the layer's extent by its end (offset + block.duration).
  const kinded: Array<[string, readonly AnyLayer[]]> = [
    ["image", project.image_layers],
    ["video", project.video_layers],
    ["text", project.text_layers],
    ["shapes", project.shapes],
    ["group", project.groups],
  ];
  for (const [kind, layers] of kinded) {
    for (const layer of layers) {
      const offset = effectiveFrameOffset(project, `${kind}.${layer.id}`);
      for (const keyframes of Object.values(layer.animations ?? {})) {
        for (const kf of keyframes ?? []) {
          if (offset + kf.frame + 1 > frames) frames = offset + kf.frame + 1;
        }
      }
      for (const keyframes of Object.values(layer.color_tracks ?? {})) {
        for (const kf of keyframes ?? []) {
          if (offset + kf.frame + 1 > frames) frames = offset + kf.frame + 1;
        }
      }
      if (layer.block && offset + layer.block.duration > frames) {
        frames = offset + layer.block.duration;
      }
    }
  }

  // Video layers: trim windows + their speed-ramp keyframes.
  for (const layer of project.video_layers ?? []) {
    const end = videoEndFrames(layer, opts.videoNaturalSeconds?.(layer));
    if (end > frames) frames = end;
    for (const sk of layer.speed_keyframes ?? []) {
      if (sk.frame + 1 > frames) frames = sk.frame + 1;
    }
  }

  // Audio overlays.
  for (const overlay of project.audio_overlays ?? []) {
    const end = audioEndFrames(overlay, opts.audioNaturalSeconds?.(overlay));
    if (end > frames) frames = end;
  }

  return frames;
};

// Same as `computeContentDurationFrames` but in seconds — the unit
// `project.duration_seconds` stores.
export const computeContentDurationSeconds = (
  project: Composition,
  opts: ContentDurationOptions = {},
): number => computeContentDurationFrames(project, opts) / FPS;
