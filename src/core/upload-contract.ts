// How a file enters a project: the wire contract shared by the Worker
// (worker/src/routes/upload.ts), the editor (editor/src/api.ts) and the SDK
// (sdk/src/client.ts).
//
// A project's files used to be stored under the name the uploader sent, so the
// name WAS the file's identity and two uploads under one name overwrote each
// other. Now the Worker mints every stored name, exactly as it mints a
// project's id:
//
//   filename  the file's id: `<uuid>.<ext>` for a new upload, or the name a
//             derived file's owner implies (derived-file-names.ts). Layers,
//             tracks and fonts reference it. Never shown to a person.
//   name      what the person called the file. Only a label, kept on whatever
//             references the file (a layer's or track's `name`).
//
// Every upload returns { filename, name }. The caller references `filename`.

/** The display name the uploader chose, sent on the asset byte POST. */
export const UPLOAD_NAME_HEADER = "X-Upload-Name";

/** A ticket from an init call, sent on the asset byte POST. */
export const UPLOAD_TICKET_HEADER = "X-Upload-Ticket";

/** A derived file's request (JSON of DerivedFileRequest), sent on the asset
 *  byte POST when the bytes are a derived file and there was no init. */
export const DERIVED_FILE_HEADER = "X-Derived-File";

/**
 * A file whose name the Worker computes from what it belongs to, instead of
 * minting one. The base must already exist where one is named.
 *
 *   preview           a clip's preview copy, `<clip>.preview.mp4` (clip upload)
 *   audio-companion   a clip's split audio, `<clip stem>.mp3` (asset upload)
 *   cleaned-audio     its denoised sibling, `<clip stem>.cleaned.mp3`
 *   version-thumb     a saved version's thumbnail for one page (asset upload)
 *   collection-thumb  a Collection item's thumbnail (asset upload)
 *   post-media        a Post tab upload, `scheduled-<uuid>.<jpg|mp4>`
 */
export type DerivedFileRequest =
  | { kind: "preview"; clip: string }
  | { kind: "audio-companion"; clip: string }
  | { kind: "cleaned-audio"; clip: string }
  | { kind: "version-thumb"; versionId: string; pageId: string }
  | { kind: "collection-thumb"; elementId: string }
  | { kind: "post-media" };

export type DerivedFileKind = DerivedFileRequest["kind"];

/** What every upload answers with. */
export interface UploadedFile {
  /** The stored file's id. Reference this. */
  filename: string;
  /** The display name. */
  name: string;
}

/**
 * The refusal an old client gets: one that still sends a stored name
 * (`X-Filename` or a `filename` field) expecting it to be kept. Answering it
 * with a minted id would be worse than refusing: the old client ignores the
 * id and references a file that does not exist.
 */
export const OUTDATED_UPLOAD_CLIENT = {
  status: 409,
  code: "upload-client-outdated",
  error:
    "This upload used the old contract, where the uploader chose the stored filename. " +
    "Reload the Morpha editor, or update morphareels-sdk: every upload now returns the " +
    "stored `filename` to reference, and takes the name people see as `name`.",
} as const;

/** The extensions an asset upload takes: images, audio, and custom typefaces
 *  (project.custom_fonts, loaded with the FontFace API). */
export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".aac",
  ".woff2",
  ".woff",
  ".ttf",
  ".otf",
]);

/** The extensions a clip upload takes. */
export const CLIP_EXTENSIONS: ReadonlySet<string> = new Set([".mp4", ".mov", ".webm"]);

/** The lowercased extension of a name's basename, with its dot, or "". */
export const extensionOf = (name: string): string => {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};

const MAX_DISPLAY_NAME = 200;

/**
 * The display name kept for an upload: the basename of what the uploader sent,
 * with control characters removed and the length capped. Never empty.
 */
export const displayNameOf = (raw: string | undefined | null, fallback = "file"): string => {
  const base = (raw ?? "").slice(Math.max((raw ?? "").lastIndexOf("/"), (raw ?? "").lastIndexOf("\\")) + 1);
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, MAX_DISPLAY_NAME);
  return clean.length > 0 ? clean : fallback;
};

/** A display name without its media extension, for a layer or track label.
 *  Only an extension an upload takes is dropped, so "Dr. Smith" or "take 1.5"
 *  keep their dots. */
export const labelOf = (name: string): string => {
  const ext = extensionOf(name);
  return (ASSET_EXTENSIONS.has(ext) || CLIP_EXTENSIONS.has(ext)) && name.length > ext.length
    ? name.slice(0, name.length - ext.length)
    : name;
};

// A stored name the Worker minted starts with a v4-shaped UUID: `<uuid>.png`
// for a new upload, or a file derived from one (`<uuid>.mp3`,
// `<uuid>.preview.mp4`). It is the file's id, and an id is never a label.
const MINTED_ID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.|$)/iu;

/** Whether a stored filename is an id the Worker minted, rather than a legacy
 *  name a person chose. */
export const isStoredFileId = (filename: string): boolean =>
  MINTED_ID_PREFIX.test(filename.split("/").pop() ?? filename);

/**
 * The label a person sees for a file a layer or track references: its display
 * `name`, else the stem of a legacy filename (from before the Worker minted
 * ids, when the stored name was the uploader's), else `fallback`. A minted id
 * is never returned. The editor's labels, the embed's property names, a
 * download's filename and the Worker's Collection labels all read this.
 */
export const fileLabel = (
  name: string | null | undefined,
  filename: string | null | undefined,
  fallback: string,
): string => {
  if (name && name.trim().length > 0) return labelOf(name.trim());
  if (filename && !isStoredFileId(filename)) {
    const base = filename.split("/").pop() ?? filename;
    return labelOf(base);
  }
  return fallback;
};

/**
 * The name a layer or track keeps when its file is swapped and the swap names
 * none: its own name, or, for an unnamed one, the label its legacy filename
 * gave it, so repointing it at a minted id leaves what people see unchanged.
 * Null when it has no label to keep. A swap never takes a name a person typed.
 */
export const nameKeptAcrossSwap = (
  name: string | null | undefined,
  previousFilename: string | null | undefined,
): string | null => {
  if (name && name.trim().length > 0) return name;
  if (previousFilename && !isStoredFileId(previousFilename)) {
    return labelOf(previousFilename.split("/").pop() ?? previousFilename);
  }
  return null;
};
