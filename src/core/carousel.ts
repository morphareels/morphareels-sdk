import { SCHEMA_VERSION, pageCompositionSchema, projectSchema } from "./schemas.ts";
import type { PageComposition, Project } from "./schemas.ts";

// Pure conversions between a carousel's inline `PageComposition` records and the
// full `Project` the single-composition editor understands. A page is a FULL
// composition (video OR image): the carousel controller edits one page at a time
// by PROJECTING it into a transient Project (`pageToProject`) and committing
// edits back (`projectToPage`), carrying the page's whole timeline
// (video/audio/duration/loop/markers) so a video page's timeline works. Every
// page shares the carousel's own `canvas_width`/`canvas_height` — changeable
// like any video, never a locked aspect. `blankCarousel` mints a fresh carousel
// morpha; `wrapAsCarousel` turns a single-page video morpha into a carousel
// whose page 1 is its current top-level composition. No I/O, no React, no
// zustand, no DOM.

// Build a full Project from one carousel page. The parent carousel's
// `project_id` flows through so uploaded assets resolve to the ONE carousel
// bucket; its `org_id` flows through too so the editor scopes the TopNav project
// picker to the carousel's workspace — without it a workspace carousel's
// projection looks personal, the picker can't find the project in the (personal)
// summaries, and the header label falls back to "Untitled". `org_id` is
// display-only here (the projection is never persisted — carousel saves go
// through the controller's own record; `projectToPage` never reads it back), so
// carrying it can't corrupt a page. The parent's project-level context —
// `custom_fonts`, `collection`, `embed_origins` — flows through too so it
// keeps working while a page is open; unlike `org_id` the user can MUTATE
// those three on the projection, and the controller merges them back onto the
// record's top level on commit (`projectToPage` itself stays a pure page-field
// whitelist). Canvas dims come from the parent's own
// `canvas_width`/`canvas_height`; the page's whole composition
// (video/audio/duration/start/loop/markers) is carried through so its timeline
// plays. Parsed through `projectSchema` so every other field lands at its
// default and the shape is guaranteed valid.
export const pageToProject = (
  carouselProject: Project,
  page: PageComposition,
): Project =>
  projectSchema.parse({
    project_id: carouselProject.project_id,
    org_id: carouselProject.org_id ?? null,
    // Project-level, projection-carried: custom_fonts so a page's text layers
    // resolve and verify custom faces (editor preview + the still-export font
    // gate); collection so Add to Collection sees + extends the real list;
    // embed_origins so the allowlist actions edit the real allowlist.
    // `projectToPage` never reads them back — the carousel controller's
    // commitActive folds edits to these onto the RECORD's top level, so page
    // slots never grow project-level fields.
    custom_fonts: carouselProject.custom_fonts,
    collection: carouselProject.collection,
    embed_origins: carouselProject.embed_origins,
    ...(page.name ? { name: page.name } : {}),
    schema_version: SCHEMA_VERSION,
    image_layers: page.image_layers,
    video_layers: page.video_layers,
    text_layers: page.text_layers,
    shapes: page.shapes,
    groups: page.groups,
    layer_order: page.layer_order,
    audio_overlays: page.audio_overlays,
    duration_seconds: page.duration_seconds,
    duration_authored: page.duration_authored,
    start_at: page.start_at,
    markers: page.markers,
    loop: page.loop,
    loop_start_frame: page.loop_start_frame,
    loop_end_frame: page.loop_end_frame,
    canvas_width: carouselProject.canvas_width,
    canvas_height: carouselProject.canvas_height,
    mode: "video",
    carousel: null,
  });

// Extract the FULL `PageComposition` from an edited page projection — the
// inverse of `pageToProject`. Keeps the caller-supplied `pageId` (the
// projection's own `project_id` is the parent carousel's, not the page's).
export const projectToPage = (
  pageId: string,
  project: Project,
): PageComposition => ({
  id: pageId,
  ...(project.name ? { name: project.name } : {}),
  image_layers: project.image_layers,
  video_layers: project.video_layers,
  text_layers: project.text_layers,
  shapes: project.shapes,
  groups: project.groups,
  layer_order: project.layer_order,
  audio_overlays: project.audio_overlays,
  duration_seconds: project.duration_seconds,
  duration_authored: project.duration_authored,
  start_at: project.start_at,
  markers: project.markers,
  loop: project.loop,
  loop_start_frame: project.loop_start_frame,
  loop_end_frame: project.loop_end_frame,
});

// A fresh empty page sized to the given canvas dims: one pinned `is_background`
// image layer filling the canvas (mirrors `blankProject`'s backdrop) and empty
// everything else — it renders as a still until the user adds video. `id` is a
// new v4 UUID. Parsed through `pageCompositionSchema` so the full-composition
// timeline fields land at their defaults.
export const blankPage = (
  canvasWidth: number,
  canvasHeight: number,
  name?: string,
): PageComposition =>
  pageCompositionSchema.parse({
    id: crypto.randomUUID(),
    ...(name ? { name } : {}),
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
  });

// Mint a fresh carousel morpha: `mode:"carousel"` with a single blank page,
// sized to the given canvas dims (default portrait 4:5). A new v4 UUID id;
// validated through `projectSchema` so every other field lands at its default.
export const blankCarousel = (
  name?: string,
  canvasWidth = 1080,
  canvasHeight = 1350,
): Project =>
  projectSchema.parse({
    project_id: crypto.randomUUID(),
    ...(name ? { name } : {}),
    schema_version: SCHEMA_VERSION,
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
    mode: "carousel",
    carousel: {
      active_index: 0,
      pages: [blankPage(canvasWidth, canvasHeight, name)],
    },
  });

// Convert a single-page (video-mode) morpha into a carousel whose page 1 IS the
// project's current top-level composition — the primitive behind "add page" on
// a plain morpha. The top-level composition arrays are emptied (in carousel
// mode content lives in the pages, matching `blankCarousel`); all project-level
// metadata (id, name, canvas dims, versions, sharing, fonts, …) is preserved.
// Returns a 1-page carousel; callers append their own blank page(s) and select.
export const wrapAsCarousel = (project: Project): Project =>
  projectSchema.parse({
    ...project,
    image_layers: [],
    video_layers: [],
    text_layers: [],
    shapes: [],
    groups: [],
    layer_order: [],
    audio_overlays: [],
    markers: [],
    loop: [],
    loop_start_frame: 0,
    loop_end_frame: null,
    duration_seconds: 1,
    duration_authored: false,
    start_at: null,
    mode: "carousel",
    carousel: {
      active_index: 0,
      pages: [projectToPage(crypto.randomUUID(), project)],
    },
  });
