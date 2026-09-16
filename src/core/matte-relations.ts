// Track-matte (mask) relationships: the ONLY walk of the matte graph.
//
// Pure: it reads one Composition and nothing else, so it lives in src/ where
// every consumer can reach it. The render pipeline derives which stencils to
// skip painting (collectMatteSourceIds), the Layers panel and the Timeline
// derive which rows are a host or a consumed stencil, and describe_video
// reports the same relation to agents. One walk, so no two surfaces can ever
// call different layers a mask. Pinned by test/matte-relations.test.ts.

import type { Composition } from "./schemas.ts";

// Element ids used as another layer's track-matte (mask) SOURCE. A mask source
// is a stencil: it drives the host's alpha but must never paint as a visible
// layer of its own — otherwise the mask shape covers the very layer it's
// masking. Both the canvas renderer and the DOM tree skip painting these;
// applyMatte still renders the source into its private offscreen to build the
// stencil. Derived from collectMatteRelations — the stencils are exactly the
// keys of its sourceToHost view — so the render pipeline and the Layers panel
// read the SAME matte graph and can never call different layers a mask.
// Pinned by test/matte-relations.test.ts.
export const collectMatteSourceIds = (project: Composition): Set<string> =>
  new Set(collectMatteRelations(project).sourceToHost.keys());

// Track-matte (mask) relationships across a composition — the ONLY walk of the
// matte graph. Both consumers derive from it: the render pipeline via
// collectMatteSourceIds (which stencils to skip painting) and the Layers panel
// via hostToSource / sourceToHost (which rows to badge as host / mask). A valid
// source is a non-backdrop leaf (image / video / shapes / text); unset,
// self-referencing, and dangling pointers are ignored (defensive against
// hand-edited / migrated JSON). A group host's stencil must be a `shapes.` id.
// Ported from #158; page-aware (operates on one Composition).
export const collectMatteRelations = (
  project: Composition,
): {
  hostToSource: Map<string, string>;
  sourceToHost: Map<string, string>;
} => {
  const valid = new Set<string>();
  for (const l of project.image_layers)
    if (!l.is_background) valid.add(`image.${l.id}`);
  for (const v of project.video_layers) valid.add(`video.${v.id}`);
  for (const s of project.shapes) valid.add(`shapes.${s.id}`);
  for (const t of project.text_layers) valid.add(`text.${t.id}`);

  const hostToSource = new Map<string, string>();
  const sourceToHost = new Map<string, string>();
  const add = (hostId: string, raw: string | null | undefined) => {
    if (!raw || raw === hostId) return; // unset or self-reference
    if (!valid.has(raw)) return; // dangling / backdrop / group-targeted
    hostToSource.set(hostId, raw);
    if (!sourceToHost.has(raw)) sourceToHost.set(raw, hostId);
  };
  for (const l of project.image_layers)
    if (!l.is_background) add(`image.${l.id}`, l.matte_source_id);
  for (const v of project.video_layers) add(`video.${v.id}`, v.matte_source_id);
  for (const s of project.shapes) add(`shapes.${s.id}`, s.matte_source_id);
  for (const t of project.text_layers) add(`text.${t.id}`, t.matte_source_id);
  for (const g of project.groups) {
    const ms = g.matte_source_id;
    if (ms && ms.startsWith("shapes.") && valid.has(ms)) add(`group.${g.id}`, ms);
  }
  return { hostToSource, sourceToHost };
};
