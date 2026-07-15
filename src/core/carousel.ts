import { pageCompositionSchema } from "./schemas.ts";
import type { Composition, PageComposition, Project } from "./schemas.ts";

// Pure conversions between a project's PAGES and the flat single-composition
// VIEW the renderer and the pure tools operate on.
//
// A project is pages-only: `{ …meta, canvas_width, canvas_height, active_index,
// pages[≥1] }`. To render or mutate ONE page we PROJECT it into a `Composition`
// (compositionForPage) — the page's composition plus the project-level render
// context (id, canvas dims, fonts, collection, embed) — and fold the result
// back (writeCompositionBack). These are pure selectors, NOT stored state:
// there is exactly one canonical Project and one save path. (This replaces the
// old stateful pageToProject/projectToPage projection, which kept a second
// carousel record with its own writer and suppressed autosave — the source of
// the half-migrated states this model removes.) No I/O, no React, no zustand.

export const clampActiveIndex = (project: Project): number =>
  Math.min(Math.max(0, project.active_index), project.pages.length - 1);

// Build the flat Composition for page `index`: the page's composition fields
// plus the project-level context the renderer/tools read as `project.<field>`.
export const compositionForPage = (
  project: Project,
  index: number,
): Composition => {
  const page = project.pages[index];
  return {
    project_id: project.project_id,
    ...(project.name !== undefined ? { name: project.name } : {}),
    ...(project.org_id !== undefined ? { org_id: project.org_id } : {}),
    schema_version: project.schema_version,
    canvas_width: project.canvas_width,
    canvas_height: project.canvas_height,
    custom_fonts: project.custom_fonts,
    collection: project.collection,
    embed_origins: project.embed_origins,
    public_properties: project.public_properties,
    shared_with_emails: project.shared_with_emails,
    shared_with_editors: project.shared_with_editors,
    current_version_id: project.current_version_id,
    last_modified_at: project.last_modified_at,
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
  };
};

export const activeComposition = (project: Project): Composition =>
  compositionForPage(project, clampActiveIndex(project));

// Wrap a flat Composition into a single-page Project (the inverse of
// activeComposition on a 1-page project). Used where a caller holds a
// composition but needs a whole Project — e.g. the test harness, and any
// surface that builds one page then persists it.
export const singlePageProject = (comp: Composition): Project => ({
  project_id: comp.project_id,
  ...(comp.name !== undefined ? { name: comp.name } : {}),
  ...(comp.org_id !== undefined ? { org_id: comp.org_id } : {}),
  schema_version: comp.schema_version,
  canvas_width: comp.canvas_width,
  canvas_height: comp.canvas_height,
  custom_fonts: comp.custom_fonts,
  collection: comp.collection,
  embed_origins: comp.embed_origins,
  public_properties: comp.public_properties,
  shared_with_emails: comp.shared_with_emails,
  shared_with_editors: comp.shared_with_editors,
  current_version_id: comp.current_version_id,
  last_modified_at: comp.last_modified_at,
  active_index: 0,
  pages: [
    {
      id: crypto.randomUUID(),
      ...(comp.name !== undefined ? { name: comp.name } : {}),
      image_layers: comp.image_layers,
      video_layers: comp.video_layers,
      text_layers: comp.text_layers,
      shapes: comp.shapes,
      groups: comp.groups,
      layer_order: comp.layer_order,
      audio_overlays: comp.audio_overlays,
      duration_seconds: comp.duration_seconds,
      duration_authored: comp.duration_authored,
      start_at: comp.start_at,
      markers: comp.markers,
      loop: comp.loop,
      loop_start_frame: comp.loop_start_frame,
      loop_end_frame: comp.loop_end_frame,
    },
  ],
});

// Fold an edited Composition back into `pages[index]`, carrying the project-
// level fields a content tool may legitimately mutate (collection / embed /
// public_properties / custom_fonts). Canvas dims, name, sharing, and versions
// stay project-authoritative — their own tools/endpoints own them.
export const writeCompositionBack = (
  project: Project,
  index: number,
  comp: Composition,
): Project => {
  const prev = project.pages[index];
  const nextPage: PageComposition = {
    ...prev,
    image_layers: comp.image_layers,
    video_layers: comp.video_layers,
    text_layers: comp.text_layers,
    shapes: comp.shapes,
    groups: comp.groups,
    layer_order: comp.layer_order,
    audio_overlays: comp.audio_overlays,
    duration_seconds: comp.duration_seconds,
    duration_authored: comp.duration_authored,
    start_at: comp.start_at,
    markers: comp.markers,
    loop: comp.loop,
    loop_start_frame: comp.loop_start_frame,
    loop_end_frame: comp.loop_end_frame,
  };
  return {
    ...project,
    pages: project.pages.map((p, i) => (i === index ? nextPage : p)),
    collection: comp.collection,
    embed_origins: comp.embed_origins,
    public_properties: comp.public_properties,
    custom_fonts: comp.custom_fonts,
  };
};

// A fresh empty page sized to the given canvas dims: one pinned `is_background`
// image layer filling the canvas (the renderer paints its fill across the whole
// canvas) and empty everything else — it renders as a still until the user adds
// video. `id` is a new v4 UUID. Parsed through `pageCompositionSchema` so the
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
