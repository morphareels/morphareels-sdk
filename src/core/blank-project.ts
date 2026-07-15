import type { Project } from "./schemas.ts";
import { SCHEMA_VERSION } from "./schemas.ts";
import { blankPage } from "./carousel.ts";

// The single source of truth for "what a blank morpha is". A fresh document the
// user creates via the New flow, and the editor store's boot-time placeholder,
// both come from here — so the empty starting state is defined in exactly one
// place.
//
// A project is a pages-only structure: an ordered list of full compositions
// sharing the project's canvas dims. A blank project is a single blank PAGE (see
// blankPage in carousel.ts) — one pinned `is_background` image_layer and empty
// collections for everything else.

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
    schema_version: SCHEMA_VERSION,
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
    active_index: 0,
    pages: [blankPage(canvasWidth, canvasHeight, opts.name ?? undefined)],
    collection: [],
    current_version_id: null,
    last_modified_at: opts.lastModifiedAt ?? Date.now(),
    embed_origins: [],
    shared_with_emails: [],
    shared_with_editors: [],
    public_properties: [],
    custom_fonts: [],
  };
};
