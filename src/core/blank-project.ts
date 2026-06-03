import type { Project } from "./schemas.ts";

// The single source of truth for "what a blank project is". A fresh project
// the user creates via the editor's New button, and the editor store's
// boot-time placeholder, both come from here — so the empty starting state is
// defined in exactly one place.
//
// The body mirrors the minimal valid project the schema accepts: a single
// pinned `is_background` image_layer (the canvas backdrop — the renderer paints
// its fill across the whole canvas and ignores x/y/width/height, but the schema
// still requires them) and empty collections for everything else.

export type BlankProjectOpts = {
  projectId: string;
  name?: string | null;
  /** Defaults to now. The editor placeholder passes 0 as a sentinel. */
  lastModifiedAt?: number;
  canvasWidth?: number;
  canvasHeight?: number;
};

export const blankProject = (opts: BlankProjectOpts): Project => {
  const canvasWidth = opts.canvasWidth ?? 1080;
  const canvasHeight = opts.canvasHeight ?? 1920;
  return {
    project_id: opts.projectId,
    ...(opts.name ? { name: opts.name } : {}),
    schema_version: 2,
    image_layers: [
      {
        id: "background",
        x: canvasWidth / 2,
        y: canvasHeight / 2,
        width: canvasWidth,
        height: canvasHeight,
        rotation: 0,
        pivotX: 0.5,
        pivotY: 0.5,
        fill: { type: "solid", color: "#000000", opacity: 1 },
        pinned: true,
        is_background: true,
      },
    ],
    video_layers: [],
    text_layers: [],
    shapes: [],
    animations: {},
    styles: {},
    layer_order: [],
    groups: [],
    duration_seconds: 30,
    start_at: null,
    audio_overlays: [],
    markers: [],
    loop: [],
    loop_start_frame: 0,
    loop_end_frame: null,
    track_loops: {},
    color_tracks: {},
    current_version_id: null,
    last_modified_at: opts.lastModifiedAt ?? Date.now(),
    embed_origins: [],
    shared_with_emails: [],
    public_properties: [],
    custom_fonts: [],
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
  };
};
