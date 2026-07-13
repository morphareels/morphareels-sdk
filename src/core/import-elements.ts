// Cross-project element import — the PURE half of `import_from_project`.
//
// Copying a layer/group from project A into project B is two concerns: moving
// the asset BYTES across R2 namespaces (I/O — done by the worker's
// /api/copy-project-files route) and grafting the layer DATA into B's JSON with
// fresh, collision-free ids (pure — done here). This module is the pure half:
// no zustand, no fetch, no R2. The editor dispatcher in llm-tools.ts wires the
// two together (collect assets → copy bytes → insert with the resulting
// renames).
//
//   collectImportAssets(source, ids)  → which files the bytes-copy must move
//   insertImportedElements(dest, …)   → graft the layers into dest, remapped
//
// "Involved" = the requested ids plus, for any requested group, all of its
// descendants (recursively). Every cross-element reference that rides inside
// the imported subtree is remapped to the new ids; references that point OUT of
// the subtree (a matte/mask source that wasn't imported) are dropped rather
// than left dangling.

import type { CustomFont, Fill, Project } from "./schemas.ts";

export type LayerKind = "image" | "video" | "text" | "shapes" | "group";

export interface ImportAsset {
  kind: "asset" | "clip";
  filename: string;
}

const KIND_PREFIX: Record<LayerKind, string> = {
  image: "image.",
  video: "video.",
  text: "text.",
  shapes: "shapes.",
  group: "group.",
};

const kindOf = (fullId: string): LayerKind | null => {
  for (const kind of Object.keys(KIND_PREFIX) as LayerKind[]) {
    if (fullId.startsWith(KIND_PREFIX[kind])) return kind;
  }
  return null;
};

const bareOf = (fullId: string): string => fullId.slice(fullId.indexOf(".") + 1);

// Loosely-typed layer record — every kind shares id and the optional reference
// fields we remap; the specifics (filename/clip/font_family/children) are read
// defensively.
type AnyLayer = {
  id: string;
  matte_source_id?: string | null;
  fill?: Fill | null;
  children?: string[];
  filename?: string;
  clip?: string;
  font_family?: string;
};

// The five layer arrays a composition carries — satisfied by both a full
// Project and a carousel PageComposition, so element lookup works on either.
export type CompositionLayers = Pick<
  Project,
  "image_layers" | "video_layers" | "text_layers" | "shapes" | "groups"
>;

const layerArray = (
  composition: CompositionLayers,
  kind: LayerKind,
): AnyLayer[] => {
  switch (kind) {
    case "image":
      return composition.image_layers as unknown as AnyLayer[];
    case "video":
      return composition.video_layers as unknown as AnyLayer[];
    case "text":
      return composition.text_layers as unknown as AnyLayer[];
    case "shapes":
      return composition.shapes as unknown as AnyLayer[];
    case "group":
      return composition.groups as unknown as AnyLayer[];
  }
};

export const findLayer = (
  composition: CompositionLayers,
  fullId: string,
): { kind: LayerKind; layer: AnyLayer } | null => {
  const kind = kindOf(fullId);
  if (!kind) return null;
  const bare = bareOf(fullId);
  const layer = layerArray(composition, kind).find((l) => l.id === bare);
  return layer ? { kind, layer } : null;
};

// Requested ids + (recursively) every descendant of any requested group, in a
// stable order, skipping ids that don't resolve in `source`.
const collectInvolved = (source: Project, requestedIds: string[]): string[] => {
  const involved: string[] = [];
  const seen = new Set<string>();
  const visit = (fullId: string): void => {
    if (seen.has(fullId)) return;
    const found = findLayer(source, fullId);
    if (!found) return;
    seen.add(fullId);
    involved.push(fullId);
    if (found.kind === "group") {
      for (const child of found.layer.children ?? []) visit(child);
    }
  };
  for (const id of requestedIds) visit(id);
  return involved;
};

const isRemoteFontSrc = (src: string): boolean =>
  /^(https?:|data:|\/\/)/i.test(src);

// The font families referenced by the involved layers (text layers + text-mode
// image layers both carry `font_family`).
const usedFamilies = (source: Project, involved: string[]): Set<string> => {
  const fams = new Set<string>();
  for (const fullId of involved) {
    const fam = findLayer(source, fullId)?.layer.font_family;
    if (typeof fam === "string" && fam.trim().length > 0) fams.add(fam.trim());
  }
  return fams;
};

// Which asset/clip/font files the byte-copy must move so the imported layers
// render in the destination. Filenames are SOURCE-namespace names; the copy
// route returns the (possibly de-collided) destination names.
export const collectImportAssets = (
  source: Project,
  requestedIds: string[],
): { assets: ImportAsset[]; fonts: CustomFont[] } => {
  const involved = collectInvolved(source, requestedIds);
  const assets: ImportAsset[] = [];
  const seenFiles = new Set<string>();
  const push = (kind: "asset" | "clip", filename: string): void => {
    const key = `${kind}:${filename}`;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    assets.push({ kind, filename });
  };
  for (const fullId of involved) {
    const found = findLayer(source, fullId);
    if (!found) continue;
    if (found.kind === "image" && found.layer.filename) {
      push("asset", found.layer.filename);
    }
    if (found.kind === "video" && found.layer.clip) {
      push("clip", found.layer.clip);
    }
  }
  const fams = usedFamilies(source, involved);
  const fonts: CustomFont[] = [];
  for (const font of source.custom_fonts ?? []) {
    if (!fams.has(font.family)) continue;
    fonts.push(font);
    if (!isRemoteFontSrc(font.src)) push("asset", font.src);
  }
  return { assets, fonts };
};

const mintId = (reserved: Set<string>): string => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const buf = new Uint8Array(3);
    crypto.getRandomValues(buf);
    const id = Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!reserved.has(id)) {
      reserved.add(id);
      return id;
    }
  }
  throw new Error("mintId: 100 id collisions in a row");
};

// Shapes require a non-null fill (every other kind's fill is nullable); use a
// neutral solid when an imported shape's mask source was left behind.
const FALLBACK_SOLID_FILL: Fill = { type: "solid", color: "#888888", opacity: 1 };

const remapClone = (
  clone: AnyLayer,
  kind: LayerKind,
  newFullId: string,
  idMap: Map<string, string>,
  fileRenames: Record<string, string>,
): void => {
  clone.id = bareOf(newFullId);

  // matte source: remap if imported, drop if it pointed outside the subtree.
  if (clone.matte_source_id) {
    clone.matte_source_id = idMap.get(clone.matte_source_id) ?? null;
  }

  // mask fill: remap if imported; if its source wasn't imported, drop the fill
  // (null) — except shapes, whose fill is non-nullable, where we fall back to a
  // neutral solid so the result stays schema-valid.
  if (clone.fill && clone.fill.type === "mask") {
    const mapped = idMap.get(clone.fill.layer_id);
    if (mapped) clone.fill.layer_id = mapped;
    else clone.fill = kind === "shapes" ? { ...FALLBACK_SOLID_FILL } : null;
  }

  // group children: every child is in the involved set, so always remapped.
  if (Array.isArray(clone.children)) {
    clone.children = clone.children
      .map((c) => idMap.get(c))
      .filter((c): c is string => typeof c === "string");
  }

  // asset filenames: rewrite to the destination names the copy route returned.
  if (typeof clone.filename === "string" && fileRenames[clone.filename]) {
    clone.filename = fileRenames[clone.filename];
  }
  if (typeof clone.clip === "string" && fileRenames[clone.clip]) {
    clone.clip = fileRenames[clone.clip];
  }
};

const mergeFonts = (
  dest: Project,
  source: Project,
  involved: string[],
  fileRenames: Record<string, string>,
): void => {
  const fams = usedFamilies(source, involved);
  for (const font of source.custom_fonts ?? []) {
    if (!fams.has(font.family)) continue;
    if (dest.custom_fonts.some((f) => f.family === font.family)) continue;
    const copy: CustomFont = { ...font };
    if (!isRemoteFontSrc(copy.src) && fileRenames[copy.src]) {
      copy.src = fileRenames[copy.src];
    }
    dest.custom_fonts.push(copy);
  }
};

// Graft the requested elements (+ group descendants) from `source` into a clone
// of `dest`, minting fresh ids and remapping every in-subtree reference.
// `fileRenames` maps each source asset/clip filename to its final name in the
// destination namespace (identity when no collision). Returns the new project
// and the new full ids of the TOP-LEVEL imported elements (those appended to
// layer_order — group descendants stay nested in their group's children).
export const insertImportedElements = (
  dest: Project,
  source: Project,
  requestedIds: string[],
  fileRenames: Record<string, string>,
): { project: Project; newElementIds: string[] } => {
  const involved = collectInvolved(source, requestedIds);
  if (involved.length === 0) {
    throw new Error("no importable elements found for the given ids");
  }

  const next = structuredClone(dest);

  // Reserve id space per kind, seeded from the destination's existing ids so
  // minted ids never collide with dest or with each other.
  const reserved = new Map<LayerKind, Set<string>>();
  const reservedFor = (kind: LayerKind): Set<string> => {
    let set = reserved.get(kind);
    if (!set) {
      set = new Set(layerArray(next, kind).map((l) => l.id));
      reserved.set(kind, set);
    }
    return set;
  };

  const idMap = new Map<string, string>();
  for (const oldFull of involved) {
    const kind = kindOf(oldFull);
    if (!kind) continue;
    idMap.set(oldFull, `${KIND_PREFIX[kind]}${mintId(reservedFor(kind))}`);
  }

  // A descendant of another involved group is NOT a top-level import — it stays
  // inside its group's children and must not be appended to layer_order.
  const childIds = new Set<string>();
  for (const oldFull of involved) {
    const found = findLayer(source, oldFull);
    if (found?.kind === "group") {
      for (const child of found.layer.children ?? []) {
        if (idMap.has(child)) childIds.add(child);
      }
    }
  }

  for (const oldFull of involved) {
    const found = findLayer(source, oldFull);
    if (!found) continue;
    const newFull = idMap.get(oldFull);
    if (!newFull) continue;
    const clone = structuredClone(found.layer);
    remapClone(clone, found.kind, newFull, idMap, fileRenames);
    layerArray(next, found.kind).push(clone);
  }

  const newElementIds: string[] = [];
  for (const oldFull of involved) {
    if (childIds.has(oldFull)) continue;
    const newFull = idMap.get(oldFull);
    if (!newFull) continue;
    next.layer_order.push(newFull);
    newElementIds.push(newFull);
  }

  mergeFonts(next, source, involved, fileRenames);

  return { project: next, newElementIds };
};
