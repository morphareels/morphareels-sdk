import type { Project } from "./schemas.ts";

// The single source of truth for "what a blank morpha is". A fresh document the
// user creates via the New flow, and the editor store's boot-time placeholder,
// both come from here — so the empty starting state is defined in exactly one
// place.
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
    mode: "video",
    carousel: null,
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
    layer_order: [],
    groups: [],
    collection: [],
    // Derived from content (see src/content-duration.ts) — a blank project has
    // no time-based content yet, so this seeds at the 1s floor and grows as
    // content is added. Editor + worker re-fit it on every change.
    duration_seconds: 1,
    // A fresh project auto-fits its length to content until the user drags the
    // timeline end handle (which flips this to true). See schemas.ts.
    duration_authored: false,
    start_at: null,
    audio_overlays: [],
    markers: [],
    loop: [],
    loop_start_frame: 0,
    loop_end_frame: null,
    current_version_id: null,
    last_modified_at: opts.lastModifiedAt ?? Date.now(),
    embed_origins: [],
    shared_with_emails: [],
    shared_with_editors: [],
    public_properties: [],
    custom_fonts: [],
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
  };
};
