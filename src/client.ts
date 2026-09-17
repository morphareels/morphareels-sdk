// A thin, typed HTTP client for a hosted Morpha account — the recommended,
// full-featured way to drive Morpha from code. It wraps the same Worker
// endpoints the MCP server uses:
//
//   GET  /api/project/:id      -> fetch a project's JSON
//   GET  /api/tools            -> the tool catalog
//   POST /api/tool/:name       -> load -> dispatch one tool -> write back
//
// plus renderFrame()/renderVideo() (a real browser, no ffmpeg — see ./render.ts)
// which MCP and raw HTTP can't do. Auth is a Bearer API key (mp_…).
//
// The catalog is the SAME superset MCP exposes: the pure mutation tools PLUS the
// server tools (list/create/duplicate/rename/delete projects, save/list/restore/
// rename/delete versions, upload clips + images, and the OCR/safe-zones/
// transcript readers). Every one is callable here, either via the generic
// `callTool` or a typed convenience method below. `findPublicImage` is not a
// catalog tool: it searches Openverse from THIS machine and stores the pick
// through `upload_image`.
//
// Every upload here follows the contract in src/upload-contract.ts: Morpha
// names each stored file itself (an opaque id such as `3f2a9c1e-….png`) and
// answers with `{ filename, name }`. Reference `filename`; `name` is only what
// people see. The SDK never sends a stored name of its own.

import { migrateProject, projectSchema, type Project } from "./core/schemas.ts";
import type { ToolFunction } from "./core/tools.ts";
import type { PublicImagePick } from "./core/public-image.ts";
import {
  UPLOAD_NAME_HEADER,
  ASSET_EXTENSIONS,
  CLIP_EXTENSIONS,
  displayNameOf,
  extensionOf,
  type UploadedFile,
} from "./core/upload-contract.ts";
import { searchPublicImage, type FindPublicImageOptions } from "./public-image.ts";
import {
  renderFrame,
  renderFrames,
  renderVideo,
  renderVideoToFile,
  type RenderFrameOptions,
  type RenderFramesOptions,
  type RenderVideoOptions,
} from "./render.ts";
import {
  processClip as processClipHeadless,
  processClips as processClipsHeadless,
  type ProcessClipOutcome,
  type OptionalProcessStep,
} from "./process.ts";

/** The options every upload source shares. */
export interface UploadSourceOptions {
  /** What people see for this file, such as `"Beach intro.mp4"`. Display only:
   *  Morpha names the stored file itself and returns that as `filename`.
   *  Defaults to the URL's or the local file's own name. Keep the extension,
   *  which is how Morpha knows the file's type; a `name` for a local file that
   *  has none gets the file's. */
  name?: string;
  /** Removed in 0.11. The caller no longer chooses the stored name, and a
   *  file can no longer be replaced by uploading under the same name. Pass
   *  `name`, and reference the `filename` the call returns. */
  filename?: never;
}

/** Where the bytes for `addVideo` come from: a public URL the worker fetches
 *  (no duration needed — it's parsed from the header), or a LOCAL file path the
 *  SDK uploads (small files via init→PUT→finalize, large files via chunked
 *  multipart; requires `durationSeconds`). */
export type AddVideoSource =
  | (UploadSourceOptions & { url: string; durationSeconds?: number })
  | (UploadSourceOptions & { file: string; durationSeconds: number });

/** Where the bytes for `uploadImage` / `uploadAudio` come from: a public URL
 *  the worker fetches, or a local file path the SDK sends. */
export type UploadAssetSource =
  | (UploadSourceOptions & { url: string })
  | (UploadSourceOptions & { file: string });

/** Per-clip processing status from `clipProcessingStatus`. */
export interface ClipProcessingStatus {
  clips: Array<{
    clip: string;
    processed: boolean;
    /** `proxy`, `audio_split`, `transcript`, `text_regions`. `audio_split`
     *  stays "pending" until the user splits the clip's audio in the editor
     *  or the `audio_split` step runs; an unsplit clip plays its own sound. */
    steps: Record<string, string>;
  }>;
  allProcessed: boolean;
}

export interface MorphaClientOptions {
  /** API origin. Default https://morphareels.ai */
  origin?: string;
  /** Bearer API key (mp_…), sent as `Authorization: Bearer <token>`. Required
   *  against a hosted account; omit only when pointing at a dev origin whose
   *  auth is bypassed. */
  token?: string;
  /** Custom fetch implementation (tests, proxies, Node <18). Defaults to the
   *  global `fetch`. */
  fetch?: typeof fetch;
}

/** A tool result over the wire. `ok:false` is a normal, non-throwing tool-level
 *  failure the caller inspects. `status`/`note` are populated by the cache-backed
 *  vision/transcribe tools (`"not-ready"` until the clip is opened in the editor). */
export type ToolResultEnvelope =
  | { ok: true; data?: unknown; status?: "ready" | "not-ready"; note?: string }
  | { ok: false; error: string };

/** The outcome of a `callTool` round-trip. */
export interface ToolCallResult {
  result: ToolResultEnvelope;
  /** The project AFTER the tool ran. Present for pure mutation tools (the server
   *  has already persisted it when `result.ok`); ABSENT for server tools that
   *  don't mutate a single project (e.g. `list_projects`, `upload_image`). */
  project?: Project;
  /** Tappable link that opens this project in the editor (pure mutation tools). */
  editorUrl?: string;
}

/** Discriminated result of a cache-backed vision/transcribe read. `not-ready`
 *  means the side-car cache doesn't exist yet — open the clip in the editor to
 *  produce it, then retry. Never throws on `not-ready`. */
export interface CacheReadResult {
  status: "ready" | "not-ready";
  data: unknown;
  note?: string;
}

export interface MorphaClient {
  /** Fetch a hosted project's JSON (migrated + schema-validated). */
  getProject(projectId: string): Promise<Project>;
  /**
   * Give people access to a project by email address. `editors` is the subset
   * of `emails` that may also edit; everyone else on the list is read-only.
   * Both lists REPLACE what was there, so pass the full set each time.
   *
   * To hand an ANONYMOUS account's work to a person, give them the `claimUrl`
   * from {@link registerAccount} instead. They sign in or sign up, and the
   * project moves into their own account: sharing only lends it to them, and
   * the claim link makes it theirs.
   */
  shareProject(
    projectId: string,
    emails: string[],
    editors?: string[],
  ): Promise<void>;
  /** The hosted tool catalog (the full superset — pure tools + server tools),
   *  OpenAI tool shape: `{ type: "function", function: { name, description, parameters } }`. */
  listTools(): Promise<ToolFunction[]>;
  /**
   * Call any tool by name — the HTTP equivalent of an MCP `tools/call`, against
   * the same catalog. For pure mutation tools the server loads the project,
   * dispatches, and writes it back, returning `{ result, project, editorUrl }`.
   * For server tools it returns `{ result }` (no `project`). Throws only on
   * transport/HTTP errors; a tool-level failure comes back as `result.ok:false`.
   * Prefer the typed methods below where one exists.
   */
  callTool(
    projectId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult>;

  // ── Workspace & lifecycle ─────────────────────────────────────────────────
  /** Projects as `{ id, name, editorUrl }`. With no argument, the caller's OWN
   *  personal projects (those not in a workspace). Pass `{ workspaceId }` (from
   *  `listWorkspaces`) to list that workspace's projects instead — including
   *  teammates', each with the owner's `ownerEmail`. */
  listProjects(opts?: {
    workspaceId?: string;
  }): Promise<
    Array<{ id: string; name: string; editorUrl: string; ownerEmail?: string | null }>
  >;
  /** The workspaces (shared team spaces) the account belongs to. `role` is the
   *  caller's role; only owner/admin/editor can add projects. Use `id` as the
   *  `workspaceId` argument to `createProject` / `moveProjectToWorkspace` /
   *  `listProjects`; show the user the `name`. Empty when the account has no
   *  email (membership is email-based). */
  listWorkspaces(): Promise<
    Array<{ id: string; name: string; role: string; memberCount: number }>
  >;
  /** A deep link that opens a project in the editor. */
  openProject(projectId: string): Promise<{ name: string; editorUrl: string }>;
  /** Create a new project (optionally cloning `fromProjectId`, or placing it in
   *  a workspace via `workspaceId`). The id is an opaque v4 UUID minted
   *  server-side and returned as `projectId` — you never choose it; refer to the
   *  project by its `name`. */
  createProject(opts?: {
    fromProjectId?: string;
    name?: string;
    workspaceId?: string;
  }): Promise<{
    projectId: string;
    fromProjectId: string | null;
    workspaceId: string | null;
    assetsCopied: number;
    clipsCopied: number;
    editorUrl: string;
  }>;
  /** Move a project into a workspace (`workspaceId` from `listWorkspaces`), or
   *  back to the caller's personal space (`workspaceId: null`). Needs an
   *  edit-capable role in the target workspace and write access to the project. */
  moveProjectToWorkspace(
    projectId: string,
    workspaceId: string | null,
  ): Promise<{
    projectId: string;
    workspaceId: string | null;
    name: string | null;
    editorUrl: string;
  }>;
  /** Duplicate `sourceProjectId` into a brand-new project (fresh opaque id). */
  duplicateProject(
    sourceProjectId: string,
    opts?: { name?: string },
  ): Promise<{
    projectId: string;
    fromProjectId: string | null;
    name: string | null;
    assetsCopied: number;
    clipsCopied: number;
    editorUrl: string;
  }>;
  /** Update a project's picker label (empty string reverts to the id). */
  renameProject(projectId: string, name: string): Promise<{ projectId: string; name: string }>;
  /** Re-key a project losslessly to a new v4 UUID (omit `newId` to mint one). */
  reidProject(
    projectId: string,
    newId?: string,
  ): Promise<{
    oldId: string;
    newId: string;
    versionsMoved: number;
    assetsMoved: number;
    clipsMoved: number;
  }>;
  /** Permanently delete a project. Requires edit access (owner, workspace
   * editor+, or direct-share editor); deleting your last project is allowed. */
  deleteProject(projectId: string): Promise<{ projectId: string } & Record<string, unknown>>;

  // ── Versions ──────────────────────────────────────────────────────────────
  saveVersion(
    projectId: string,
    opts?: { name?: string },
  ): Promise<{ id: string; name: string; timestamp: number; version_number?: number }>;
  listVersions(projectId: string): Promise<Array<Record<string, unknown>>>;
  restoreVersion(
    projectId: string,
    versionId: string,
    opts?: {
      /** 0-based index into the project's CURRENT pages. Restores only that
       * page from the version (matched by stable page id); omit to restore
       * the whole project (which auto-checkpoints the overwritten state). */
      pageIndex?: number;
    },
  ): Promise<{ restored: string; name: string; version_number?: number }>;
  renameVersion(
    projectId: string,
    versionId: string,
    name: string,
  ): Promise<Record<string, unknown>>;
  deleteVersion(
    projectId: string,
    versionId: string,
  ): Promise<{ deleted: boolean; versionId: string }>;

  // ── Ingest ────────────────────────────────────────────────────────────────
  // Every upload returns `{ filename, name }`. `filename` is the stored file's
  // id, which Morpha mints: reference it in every later call, and never show
  // it to a person. `name` is what people see. Two uploads under one name are
  // two files with two ids.

  /** Add a video: upload it AND run the processing pipeline (proxy, audio
   *  split, transcription, OCR) in one call. This is the ONLY way to put a clip
   *  in a project through the SDK (the raw upload routes are not exposed here
   *  or over MCP/HTTP, so a clip cannot arrive without its preview proxy being
   *  attempted). Returns the stored `filename`, which you pass to
   *  `add_video_layer` as `clip` (and `name` as its `name`), plus the
   *  `processing` outcome; `processing.ok` is true only once the mandatory
   *  proxy landed. `steps` narrows the OPTIONAL steps only. A `{ url }` source
   *  is fetched server-side; a `{ file }` source is a local path streamed from
   *  disk (needs `durationSeconds`). Processing drives a real local Chrome
   *  (Playwright), so install it and have Chrome available. */
  addVideo(
    projectId: string,
    source: AddVideoSource,
    opts?: { channel?: string; timeoutMs?: number; steps?: OptionalProcessStep[] },
  ): Promise<Record<string, unknown> & UploadedFile & { processing: ProcessClipOutcome }>;
  /** Upload an image into a project. `{ url }` fetches a public http(s) link
   *  server-side (the `upload_image` tool); `{ file }` streams a local path to
   *  the raw asset route, the same way `uploadAudio({ file })` does. Returns
   *  `{ filename, name }`: pass the returned `filename` to `add_image_layer`
   *  or `set_image_filename`, and `name` as the layer's `name`. Accepts
   *  .png/.jpg/.jpeg/.gif/.webp/.svg; capped at 16 MB. */
  uploadImage(
    projectId: string,
    source: UploadAssetSource,
  ): Promise<Record<string, unknown> & UploadedFile>;
  /** Search Openverse's Creative Commons / public-domain pool for `query`
   *  FROM THIS MACHINE (the quota is yours, not one shared through Morpha),
   *  store the first downloadable, large-enough result in the project through
   *  `upload_image`, and return `{ filename, name, attribution, dimensions }`.
   *  Pass the returned `filename` to `add_image_layer`. Returns null when the
   *  first page held nothing usable; throws when Openverse itself does not
   *  answer. The connector surfaces (MCP / HTTP) have no equivalent: there an
   *  agent finds a URL with its own web search and calls `uploadImage`. */
  findPublicImage(
    projectId: string,
    query: string,
    opts?: FindPublicImageOptions,
  ): Promise<
    | (Record<string, unknown> &
        UploadedFile & {
          attribution: PublicImagePick["attribution"];
          dimensions: PublicImagePick["dimensions"];
        })
    | null
  >;
  /** Upload an audio track into a project, the only way to get audio bytes in
   *  programmatically. `{ url }` fetches a public http(s) link server-side (the
   *  `upload_audio` tool); `{ file }` streams a local path to the raw asset
   *  route. Returns `{ filename, name }`: pass the returned `filename` to
   *  `add_audio_overlay` (add a second track) or `update_audio_overlay`
   *  `{ id, filename }` (replace an existing track's file; find the `id` in
   *  `describe_video`'s `audio_overlays`), with `name` as the track's `name`.
   *  Accepts .mp3/.m4a/.wav/.ogg/.aac; capped at 50 MB. */
  uploadAudio(
    projectId: string,
    source: UploadAssetSource,
  ): Promise<Record<string, unknown> & UploadedFile>;
  /** Register a typeface Morpha does NOT ship, so text layers can reference it
   *  by `font_family`. Families already in the built-in catalogs (anything
   *  list_fonts returns from google/bunny/fontshare/fontsource/velvetyne) are
   *  REJECTED — they need no registration; just set font_family to the name.
   *  `src` is a full font URL (https://…/font.woff2) OR the `filename` a font
   *  upload into the project returned (.woff2/.woff/.ttf/.otf). Dedupes by
   *  family+weight+style. Returns the project's full custom-font list. */
  setCustomFont(
    projectId: string,
    opts: {
      family: string;
      src: string;
      weight?: number;
      style?: "normal" | "italic";
    },
  ): Promise<
    Array<{ family: string; src: string; weight?: number; style?: string }>
  >;

  // ── Vision / transcription (cache-backed; may be not-ready) ────────────────
  detectTextRegions(
    projectId: string,
    target: { clip: string } | { image: string },
  ): Promise<CacheReadResult>;
  safeZones(
    projectId: string,
    opts: { clip: string; bandHeight?: number; occupancyThreshold?: number; minConfidence?: number },
  ): Promise<CacheReadResult>;
  transcribeClip(projectId: string, clip: string): Promise<CacheReadResult>;
  /** Whether a clip — or every video clip in the project, if `clip` is omitted —
   *  has been processed (proxy / audio split / transcription / OCR).
   *  Pure read; doesn't run anything. */
  clipProcessingStatus(
    projectId: string,
    clip?: string,
  ): Promise<ClipProcessingStatus>;

  // ── Processing (real local browser, no ffmpeg, no server) ─────────────────
  /** Run the full processing pipeline for one already-uploaded clip (drives
   *  local Chrome). Use to backfill a clip that was added some other way. */
  processClip(
    projectId: string,
    clip: string,
    opts?: { channel?: string; timeoutMs?: number; steps?: OptionalProcessStep[] },
  ): Promise<ProcessClipOutcome>;
  /** Process every (unique) video clip in the project — including every
   *  carousel page's clips — reusing one browser. */
  processProject(
    projectId: string,
    opts?: { clips?: string[]; channel?: string; timeoutMs?: number; steps?: OptionalProcessStep[] },
  ): Promise<ProcessClipOutcome[]>;

  // ── Rendering (real local browser, no ffmpeg, no server) ──────────────────
  renderFrame(
    projectId: string,
    frame?: number,
    opts?: Omit<RenderFrameOptions, "projectId" | "frame">,
  ): Promise<Buffer>;
  /** Several frames of one project, in one browser with ONE project fetch and
   *  ONE clip load — the clip is the expensive part, and `renderFrame` in a
   *  loop pays for it every time. Returns one PNG per frame, in order. */
  renderFrames(
    projectId: string,
    frames: number[],
    opts?: Omit<RenderFramesOptions, "projectId" | "frames">,
  ): Promise<Buffer[]>;
  renderVideo(
    projectId: string,
    opts?: Omit<RenderVideoOptions, "projectId">,
  ): Promise<Buffer>;
  /** The same MP4 as `renderVideo`, written to `path` as it comes out of the
   *  browser, so this process never holds the file. For long renders. */
  renderVideoToFile(
    projectId: string,
    path: string,
    opts?: Omit<RenderVideoOptions, "projectId">,
  ): Promise<{ path: string; bytes: number }>;
}

const safeText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return "";
  }
};

// ── Local-clip upload transport ──────────────────────────────────────────────
// Mirrors the editor's own uploadClipSmart (editor/src/api.ts): 10 MiB parts,
// multipart for anything larger. A single multi-minute PUT trips undici's
// default ~300s headersTimeout (the reported UND_ERR_HEADERS_TIMEOUT); bounded
// parts never hold one request open that long.
const MULTIPART_CHUNK_BYTES = 10 * 1024 * 1024;
const MULTIPART_CONCURRENCY = 4;
const MULTIPART_RETRIES = 3;

// Best-effort no-timeout undici dispatcher for the upload PUTs only. Node's
// global fetch is undici, whose default headersTimeout/bodyTimeout (~300s)
// aborts a slow upload before R2's response headers arrive. We disable them on
// the upload path (belt-and-suspenders alongside multipart, which also covers
// slow-link parts). Resolved lazily + cached; returns undefined when `undici`
// isn't importable — the report's confirmed `setGlobalDispatcher(new Agent({
// headersTimeout: 0, bodyTimeout: 0 }))` workaround, folded into the SDK so
// callers don't need it.
let uploadDispatcherPromise: Promise<unknown> | undefined;
const getUploadDispatcher = (): Promise<unknown> => {
  if (!uploadDispatcherPromise) {
    // Non-literal specifier: `undici` is an OPTIONAL runtime dependency (Node's
    // own fetch backend), not an SDK dependency, so we must NOT let TS/esbuild
    // try to resolve or bundle it at build time. Widening to `string` makes the
    // dynamic import resolve at runtime only — present in most Node apps, absent
    // is fine (we fall back to no dispatcher).
    const undiciSpecifier: string = "undici";
    uploadDispatcherPromise = import(undiciSpecifier)
      .then((u: { Agent?: new (o: unknown) => unknown }) => {
        const Agent = u.Agent;
        return Agent
          ? new Agent({
              headersTimeout: 0,
              bodyTimeout: 0,
              connect: { timeout: 60_000 },
            })
          : undefined;
      })
      .catch(() => undefined);
  }
  return uploadDispatcherPromise;
};

// R2 returns bare ETags; some S3-compatible impls quote them. Strip quotes so
// the multipart /complete call gets a clean value either way.
const unquoteEtag = (raw: string): string => {
  const v = raw.trim();
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
};

/** Refuse a source that still carries `filename`. Under the old contract that
 *  option chose the stored name, and uploading under a name that was already
 *  there replaced the file. Morpha now mints every stored name, so the option
 *  would be ignored and the caller would go on referencing a file that does
 *  not exist. Plain JavaScript gets no compile error, so it gets this one. */
const refuseChosenFilename = (method: string, source: object): void => {
  if ((source as { filename?: unknown }).filename !== undefined) {
    throw new Error(
      `${method}: \`filename\` is no longer an option, because Morpha names every stored file itself. ` +
        "Pass `name` (what people see) and reference the `filename` this call returns.",
    );
  }
};

const takesExtension = (ext: string): boolean =>
  ASSET_EXTENSIONS.has(ext) || CLIP_EXTENSIONS.has(ext);

/** The display name a local file is sent under: the caller's `name`, or the
 *  file's own name. The server takes the stored file's type from this name's
 *  extension, so a `name` without a media extension Morpha takes ("Company
 *  logo", "Dr. Smith") gets the file's own. */
export const localUploadName = (filePath: string, name?: string): string => {
  const own = displayNameOf(filePath);
  if (name === undefined) return own;
  if (takesExtension(extensionOf(name))) return name;
  const ownExt = extensionOf(own);
  return takesExtension(ownExt) ? `${name}${own.slice(own.length - ownExt.length)}` : name;
};

/** The `{ filename, name }` an upload answered with. A response with no
 *  `filename` is an error: the SDK has no name of its own to fall back to,
 *  and referencing anything else points at no file. `sentName`, the display
 *  name the SDK sent, stands in for a missing `name`; the id never does,
 *  because an id is never shown to a person. */
const uploadedFileOf = (
  what: string,
  data: Record<string, unknown>,
  sentName?: string,
): Record<string, unknown> & UploadedFile => {
  const { filename } = data;
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : sentName;
  if (typeof filename !== "string" || filename.length === 0 || name === undefined) {
    throw new Error(
      `${what}: the upload did not answer with { filename, name }. ` +
        "This morphareels-sdk expects a Morpha server that names stored files itself.",
    );
  }
  return { ...data, filename, name };
};

/** Every unique clip filename a project references. A project is pages-only —
 *  its content lives on `pages[]` — so discovery sweeps every page's video
 *  layers, deduping across (and within) pages. */
export const projectClips = (project: Project): string[] => {
  const clips = project.pages.flatMap((p) => p.video_layers.map((v) => v.clip));
  return [...new Set(clips)];
};

/**
 * Create a typed client for a hosted Morpha account. Everything you can do over
 * MCP, you can do here — same catalog, same effects — plus local `renderFrame` /
 * `renderVideo`:
 *
 * ```ts
 * import { createClient } from "morphareels-sdk";
 * const morpha = createClient({ token: process.env.MORPHA_API_KEY });
 * const projects = await morpha.listProjects();
 * await morpha.callTool(projects[0].id, "add_text_layer", { text: "HELLO", x: 540, y: 600 });
 * await morpha.saveVersion(projects[0].id, { name: "add title" });
 * const png = await morpha.renderFrame(projects[0].id, 150);
 * ```
 */
export const createClient = (options: MorphaClientOptions = {}): MorphaClient => {
  const origin = (options.origin ?? "https://morphareels.ai").replace(/\/+$/, "");
  const token = options.token;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error(
      "No fetch available — pass options.fetch (Node <18) or run on Node >=18.",
    );
  }
  // The no-timeout upload dispatcher only applies to Node's global fetch (undici);
  // a custom options.fetch owns its own transport, so we don't attach it there.
  const usingDefaultFetch = options.fetch === undefined;

  const headers = (extra?: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  const shareProject = async (
    projectId: string,
    emails: string[],
    editors: string[] = [],
  ): Promise<void> => {
    const res = await doFetch(
      `${origin}/api/project/${encodeURIComponent(projectId)}/share`,
      {
        method: "PUT",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ emails, editors }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `shareProject failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
      );
    }
  };

  const getProject = async (projectId: string): Promise<Project> => {
    const res = await doFetch(
      `${origin}/api/project/${encodeURIComponent(projectId)}`,
      { headers: headers() },
    );
    if (!res.ok) {
      throw new Error(
        `getProject(${projectId}) failed: HTTP ${res.status} ${await safeText(res)}`.trim(),
      );
    }
    const raw = migrateProject(await res.json());
    const parsed = projectSchema.safeParse(raw);
    if (!parsed.success) {
      // The strict schema rejects fields newer than this SDK build (the server
      // evolves ahead of installed clients) — say so instead of surfacing a
      // bare ZodError that reads like corrupt data.
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(
        `getProject(${projectId}): the project JSON doesn't match this SDK's schema (${issues}). ` +
          `This usually means the server is newer than your installed morphareels-sdk — ` +
          `update it (npm i morphareels-sdk@latest) and retry.`,
      );
    }
    return parsed.data;
  };

  const listTools = async (): Promise<ToolFunction[]> => {
    const res = await doFetch(`${origin}/api/tools`, { headers: headers() });
    if (!res.ok) {
      throw new Error(`listTools failed: HTTP ${res.status} ${await safeText(res)}`.trim());
    }
    const json = (await res.json()) as { tools?: ToolFunction[] };
    return json.tools ?? [];
  };

  // One POST to /api/tool/:name. `body` is `{ projectId?, args }`. Throws only on
  // transport/HTTP errors; tool-level failures return with `result.ok:false`.
  const postTool = async (
    name: string,
    body: { projectId?: string; args: Record<string, unknown> },
  ): Promise<ToolCallResult> => {
    const res = await doFetch(`${origin}/api/tool/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | (Partial<ToolCallResult> & { error?: string })
      | null;
    if (!res.ok) {
      const msg =
        json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      throw new Error(`callTool(${name}) failed: ${msg}`);
    }
    if (!json || !json.result) {
      throw new Error(`callTool(${name}) returned an unexpected response shape`);
    }
    return json as ToolCallResult;
  };

  const callTool = (
    projectId: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult> => postTool(name, { projectId, args });

  // Run a server tool and return its `data` (or throw on a tool-level failure).
  // `projectId` omitted for workspace-level tools (e.g. list_projects).
  const serverData = async (
    name: string,
    projectId: string | undefined,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const { result } = await postTool(
      name,
      projectId === undefined ? { args } : { projectId, args },
    );
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
    return result.data;
  };

  // Cache-backed read: returns `{ status, data, note }` without throwing on a
  // cold cache (`not-ready`); only a tool-level error (bad args) throws.
  const cacheRead = async (
    name: string,
    projectId: string,
    args: Record<string, unknown>,
  ): Promise<CacheReadResult> => {
    const { result } = await postTool(name, { projectId, args });
    if (!result.ok) throw new Error(`${name} failed: ${result.error}`);
    return { status: result.status ?? "ready", data: result.data ?? null, note: result.note };
  };

  // POST a raw worker route (the upload transport — NOT the tool catalog, which
  // no longer exposes upload tools to agents). Throws on a non-ok response.
  const postRaw = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const res = await doFetch(`${origin}${path}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | (Record<string, unknown> & { ok?: boolean; error?: string })
      | null;
    if (!res.ok || !json || json.ok === false) {
      const msg = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      throw new Error(`${path} failed: ${msg}`);
    }
    const { ok: _ok, ...data } = json;
    return data;
  };

  // PUT bytes at a presigned R2 URL and return the response (for its ETag).
  // Retries transient failures; attaches the no-timeout dispatcher when on the
  // default global fetch so a slow upload doesn't hit undici's headersTimeout.
  const putToR2 = async (
    uploadUrl: string,
    body: Uint8Array,
    contentType?: string,
    retries = MULTIPART_RETRIES,
  ): Promise<Response> => {
    const dispatcher = usingDefaultFetch ? await getUploadDispatcher() : undefined;
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "PUT",
      body: body as unknown as BodyInit,
      ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    };
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(uploadUrl, init);
        if (res.ok) return res;
        lastErr = new Error(`R2 PUT failed: HTTP ${res.status}`);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error("R2 PUT failed");
  };

  // POST raw bytes to the asset route (`/api/upload-asset/:projectId`, the
  // display name in the X-Upload-Name header, Content-Type derived
  // server-side). One call: the server mints the stored name itself, the same
  // as an init would, and answers `{ filename, name }`. The transport behind
  // the `{ file }` branch of uploadImage and uploadAudio; the editor uses the
  // same route.
  const uploadAssetBytes = async (
    projectId: string,
    bytes: Uint8Array,
    name: string,
  ): Promise<Record<string, unknown> & UploadedFile> => {
    const dispatcher = usingDefaultFetch ? await getUploadDispatcher() : undefined;
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers: headers({ [UPLOAD_NAME_HEADER]: encodeURIComponent(name) }),
      body: bytes as unknown as BodyInit,
      ...(dispatcher ? { dispatcher } : {}),
    };
    const res = await doFetch(
      `${origin}/api/upload-asset/${encodeURIComponent(projectId)}`,
      init,
    );
    const json = (await res.json().catch(() => null)) as
      | (Record<string, unknown> & { error?: string })
      | null;
    if (!res.ok || !json || json.ok === false) {
      const msg = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      throw new Error(`upload-asset failed: ${msg}`);
    }
    const { ok: _ok, ...data } = json;
    return uploadedFileOf("upload-asset", data, name);
  };

  // A local image or audio file, read from disk and sent through the asset
  // route above. Behind both `uploadImage({ file })` and `uploadAudio({ file })`.
  const uploadLocalAsset = async (
    projectId: string,
    source: { file: string; name?: string },
  ): Promise<Record<string, unknown> & UploadedFile> => {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(source.file);
    return uploadAssetBytes(projectId, bytes, localUploadName(source.file, source.name));
  };

  // Upload a large local clip via R2 multipart — many bounded part PUTs instead
  // of one held-open request, so a big clip on a slow uplink can't trip undici's
  // headersTimeout. Mirrors editor/src/api.ts `uploadClipMultipart`. The init
  // mints the stored name and issues a ticket; complete and abort present the
  // ticket, so they can only act on the file this init named.
  const uploadLocalFileMultipart = async (
    projectId: string,
    bytes: Uint8Array,
    name: string,
    durationSeconds: number,
  ): Promise<Record<string, unknown>> => {
    const totalBytes = bytes.byteLength;
    const init = (await postRaw("/api/upload-clip/multipart/init", {
      projectId,
      name,
      durationSeconds,
      totalBytes,
      partSize: MULTIPART_CHUNK_BYTES,
    })) as {
      uploadId: string;
      ticket: string;
      partSize: number;
      parts: Array<{ partNumber: number; uploadUrl: string }>;
    };
    const parts = init.parts;
    const results: Array<{ partNumber: number; etag: string } | null> = new Array(
      parts.length,
    ).fill(null);

    // A shared cursor feeds a small worker pool — each worker grabs the next
    // part index and PUTs it, so at most MULTIPART_CONCURRENCY are in flight.
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= parts.length) return;
        const part = parts[idx];
        const start = (part.partNumber - 1) * init.partSize;
        const end = Math.min(part.partNumber * init.partSize, totalBytes);
        const res = await putToR2(part.uploadUrl, bytes.subarray(start, end));
        const raw = res.headers.get("ETag") ?? res.headers.get("etag");
        if (!raw) throw new Error("R2 part PUT response missing ETag header");
        results[idx] = { partNumber: part.partNumber, etag: unquoteEtag(raw) };
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(MULTIPART_CONCURRENCY, parts.length) }, () =>
          worker(),
        ),
      );
    } catch (err) {
      // Release the parts already in R2 so a failed upload doesn't dangle.
      await postRaw("/api/upload-clip/multipart/abort", {
        projectId,
        ticket: init.ticket,
        uploadId: init.uploadId,
      }).catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    }

    const completedParts = results
      .filter((r): r is { partNumber: number; etag: string } => r !== null)
      .sort((a, b) => a.partNumber - b.partNumber);
    return postRaw("/api/upload-clip/multipart/complete", {
      projectId,
      ticket: init.ticket,
      uploadId: init.uploadId,
      durationSeconds,
      parts: completedParts,
    });
  };

  // Upload a local file: single init→PUT→finalize for small clips, chunked
  // multipart for large ones. Shared by addVideo's `{ file }` branch. The init
  // mints the stored name and issues a ticket, and finalize presents the
  // ticket rather than a name.
  const uploadLocalFile = async (
    projectId: string,
    filePath: string,
    durationSeconds: number,
    name?: string,
  ): Promise<Record<string, unknown> & UploadedFile> => {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(filePath);
    const displayName = localUploadName(filePath, name);
    if (bytes.byteLength > MULTIPART_CHUNK_BYTES) {
      return uploadedFileOf(
        "addVideo",
        await uploadLocalFileMultipart(projectId, bytes, displayName, durationSeconds),
        displayName,
      );
    }
    const presign = (await postRaw("/api/upload-clip/init", {
      projectId,
      name: displayName,
      durationSeconds,
      fileSize: bytes.byteLength,
    })) as { uploadUrl: string; ticket: string; contentType: string };
    await putToR2(presign.uploadUrl, bytes, presign.contentType);
    return uploadedFileOf(
      "addVideo",
      await postRaw("/api/upload-clip/finalize", {
        projectId,
        ticket: presign.ticket,
        durationSeconds,
      }),
      displayName,
    );
  };

  return {
    getProject,
    shareProject,
    listTools,
    callTool,

    listProjects: async (opts = {}) => {
      const data = (await serverData(
        "list_projects",
        undefined,
        opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
      )) as {
        projects: Array<{
          id: string;
          name: string;
          editorUrl: string;
          ownerEmail?: string | null;
        }>;
      };
      return data.projects;
    },
    listWorkspaces: async () => {
      const data = (await serverData("list_workspaces", undefined)) as {
        workspaces: Array<{
          id: string;
          name: string;
          role: string;
          memberCount: number;
        }>;
      };
      return data.workspaces;
    },
    openProject: async (projectId) =>
      (await serverData("open_project", projectId)) as {
        name: string;
        editorUrl: string;
      },
    createProject: async (opts = {}) =>
      (await serverData("create_project", undefined, {
        fromProjectId: opts.fromProjectId,
        name: opts.name,
        workspaceId: opts.workspaceId,
      })) as {
        projectId: string;
        fromProjectId: string | null;
        workspaceId: string | null;
        assetsCopied: number;
        clipsCopied: number;
        editorUrl: string;
      },
    moveProjectToWorkspace: async (projectId, workspaceId) =>
      (await serverData("move_project_to_workspace", projectId, {
        workspaceId,
      })) as {
        projectId: string;
        workspaceId: string | null;
        name: string | null;
        editorUrl: string;
      },
    duplicateProject: async (sourceProjectId, opts = {}) =>
      (await serverData("duplicate_project", sourceProjectId, { name: opts.name })) as {
        projectId: string;
        fromProjectId: string | null;
        name: string | null;
        assetsCopied: number;
        clipsCopied: number;
        editorUrl: string;
      },
    renameProject: async (projectId, name) =>
      (await serverData("rename_project", projectId, { name })) as {
        projectId: string;
        name: string;
      },
    reidProject: async (projectId, newId) =>
      (await serverData("reid_project", projectId, newId ? { newId } : {})) as {
        oldId: string;
        newId: string;
        versionsMoved: number;
        assetsMoved: number;
        clipsMoved: number;
      },
    deleteProject: async (projectId) =>
      (await serverData("delete_project", projectId)) as {
        projectId: string;
      } & Record<string, unknown>,

    saveVersion: async (projectId, opts = {}) =>
      (await serverData("save_version", projectId, { name: opts.name })) as {
        id: string;
        name: string;
        timestamp: number;
        version_number?: number;
      },
    listVersions: async (projectId) => {
      const data = (await serverData("list_versions", projectId)) as {
        versions: Array<Record<string, unknown>>;
      };
      return data.versions;
    },
    restoreVersion: async (projectId, versionId, opts) =>
      (await serverData("restore_version", projectId, {
        versionId,
        ...(opts?.pageIndex !== undefined ? { page_index: opts.pageIndex } : {}),
      })) as {
        restored: string;
        name: string;
        version_number?: number;
      },
    renameVersion: async (projectId, versionId, name) =>
      (await serverData("rename_version", projectId, { versionId, name })) as Record<
        string,
        unknown
      >,
    deleteVersion: async (projectId, versionId) =>
      (await serverData("delete_version", projectId, { versionId })) as {
        deleted: boolean;
        versionId: string;
      },

    addVideo: async (projectId, source, opts = {}) => {
      refuseChosenFilename("addVideo", source);
      const uploaded =
        "url" in source
          ? uploadedFileOf(
              "addVideo",
              await postRaw("/api/upload-clip/from-url", {
                projectId,
                url: source.url,
                name: source.name,
                durationSeconds: source.durationSeconds,
              }),
              source.name,
            )
          : await uploadLocalFile(projectId, source.file, source.durationSeconds, source.name);
      const processing = await processClipHeadless({
        origin,
        token,
        projectId,
        clip: uploaded.filename,
        channel: opts.channel,
        timeoutMs: opts.timeoutMs,
        steps: opts.steps,
      });
      return { ...uploaded, processing };
    },
    uploadImage: async (projectId, source) => {
      refuseChosenFilename("uploadImage", source);
      if ("url" in source) {
        const data = (await serverData("upload_image", projectId, {
          url: source.url,
          name: source.name,
        })) as Record<string, unknown>;
        return uploadedFileOf("uploadImage", data, source.name);
      }
      return uploadLocalAsset(projectId, source);
    },
    findPublicImage: async (projectId, query, opts) => {
      const pick = await searchPublicImage(query, opts);
      if (!pick) return null;
      const stored = (await serverData("upload_image", projectId, {
        url: pick.url,
        name: pick.filename,
      })) as Record<string, unknown>;
      return {
        ...uploadedFileOf("findPublicImage", stored, pick.filename),
        attribution: pick.attribution,
        dimensions: pick.dimensions,
      };
    },
    uploadAudio: async (projectId, source) => {
      refuseChosenFilename("uploadAudio", source);
      if ("url" in source) {
        const data = (await serverData("upload_audio", projectId, {
          url: source.url,
          name: source.name,
        })) as Record<string, unknown>;
        return uploadedFileOf("uploadAudio", data, source.name);
      }
      return uploadLocalAsset(projectId, source);
    },
    setCustomFont: async (projectId, opts) => {
      const data = (await serverData("set_custom_font", projectId, {
        ...opts,
      })) as {
        custom_fonts: Array<{
          family: string;
          src: string;
          weight?: number;
          style?: string;
        }>;
      };
      return data.custom_fonts;
    },

    detectTextRegions: (projectId, target) =>
      cacheRead("detect_text_regions", projectId, { ...target }),
    safeZones: (projectId, opts) => cacheRead("safe_zones", projectId, { ...opts }),
    transcribeClip: (projectId, clip) => cacheRead("transcribe_clip", projectId, { clip }),
    clipProcessingStatus: async (projectId, clip) =>
      (await serverData(
        "clip_processing_status",
        projectId,
        clip ? { clip } : {},
      )) as ClipProcessingStatus,

    processClip: (projectId, clip, opts = {}) =>
      processClipHeadless({ origin, token, projectId, clip, ...opts }),
    processProject: async (projectId, opts = {}) => {
      let clips = opts.clips;
      if (!clips) {
        const project = await getProject(projectId);
        clips = projectClips(project);
      }
      return processClipsHeadless({ origin, token, projectId, ...opts, clips });
    },

    renderFrame: (projectId, frame = 0, opts = {}) =>
      renderFrame({ origin, token, ...opts, projectId, frame }),
    renderFrames: (projectId, frames, opts = {}) =>
      renderFrames({ origin, token, ...opts, projectId, frames }),
    renderVideo: (projectId, opts = {}) =>
      renderVideo({ origin, token, ...opts, projectId }),
    renderVideoToFile: (projectId, path, opts = {}) =>
      renderVideoToFile({ origin, token, ...opts, projectId, path }),
  };
};
