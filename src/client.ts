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
// rename/delete versions, upload clips + images, find public images, and the
// OCR/objects/safe-zones/transcript readers). Every one is callable here, either
// via the generic `callTool` or a typed convenience method below.

import { migrateProject, projectSchema, type Project } from "./core/schemas.ts";
import type { ToolFunction } from "./core/tools.ts";
import {
  renderFrame,
  renderVideo,
  type RenderFrameOptions,
  type RenderVideoOptions,
} from "./render.ts";
import {
  processClip as processClipHeadless,
  processClips as processClipsHeadless,
  type ProcessClipOutcome,
} from "./process.ts";

/** Where the bytes for `addVideo` come from: a public URL the worker fetches
 *  (no duration needed — it's parsed from the header), or a LOCAL file path the
 *  SDK streams via presign→PUT→finalize (which requires `durationSeconds`). */
export type AddVideoSource =
  | { url: string; filename?: string; durationSeconds?: number }
  | { file: string; filename?: string; durationSeconds: number };

/** Per-clip processing status from `clipProcessingStatus`. */
export interface ClipProcessingStatus {
  clips: Array<{
    clip: string;
    processed: boolean;
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
   *  don't mutate a single project (e.g. `list_projects`, `upload_clip`). */
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
    Array<{ id: string; name: string | null; editorUrl: string; ownerEmail?: string | null }>
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
  openProject(projectId: string): Promise<{ name: string | null; editorUrl: string }>;
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
  /** Permanently delete a project (refuses to leave the workspace empty). */
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
  /** Add a video: upload it AND run the full processing pipeline (proxy, audio
   *  split, transcription, OCR, object detection) in one call — the sole agent
   *  upload path (the raw upload tools aren't exposed over MCP/HTTP). Returns the
   *  stored `filename` (pass it to `add_video_layer`) plus the `processing`
   *  outcome. A `{ url }` source is fetched server-side; a `{ file }` source is a
   *  local path streamed from disk (needs `durationSeconds`). Processing drives a
   *  real local Chrome (Playwright) — install it and have Chrome available. */
  addVideo(
    projectId: string,
    source: AddVideoSource,
    opts?: { channel?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown> & { filename: string; processing: ProcessClipOutcome }>;
  /** Low-level: upload a clip from a public URL (worker-fetched). Does NOT
   *  process — prefer `addVideo`. */
  uploadClip(
    projectId: string,
    opts: { url: string; filename?: string; durationSeconds?: number },
  ): Promise<Record<string, unknown>>;
  /** Low-level: presign a direct-to-R2 PUT for a local clip. `durationSeconds`
   *  is required (the editor always knows it before uploading). */
  uploadClipPresign(
    projectId: string,
    opts: { filename: string; durationSeconds: number },
  ): Promise<{ uploadUrl: string; key: string; filename: string; contentType: string; expiresInSeconds: number }>;
  /** Low-level: finalize a presigned upload. Does NOT process — prefer `addVideo`. */
  uploadClipFinalize(
    projectId: string,
    opts: { filename: string; durationSeconds: number },
  ): Promise<Record<string, unknown>>;
  uploadImage(
    projectId: string,
    opts: { url: string; filename?: string },
  ): Promise<Record<string, unknown>>;
  /** Register a custom (non-Google) typeface so text layers can reference it by
   *  `font_family`. `src` is a full font URL (https://…/font.woff2) OR a font
   *  filename already uploaded to the project's asset bucket (.woff2/.woff/.ttf/
   *  .otf). Dedupes by family+weight+style. Returns the project's full custom-
   *  font list. (Registering the real face is the robust cure for the editor
   *  faux-synthesizing a weight a font ships no real cut for.) */
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
  findPublicImage(
    projectId: string,
    query: string,
    opts?: { licenseType?: "all-cc" | "commercial" | "cc0"; minDimension?: number },
  ): Promise<{ filename: string; attribution: unknown; dimensions: unknown }>;

  // ── Vision / transcription (cache-backed; may be not-ready) ────────────────
  detectTextRegions(
    projectId: string,
    target: { clip: string } | { image: string },
  ): Promise<CacheReadResult>;
  detectObjects(projectId: string, clip: string): Promise<CacheReadResult>;
  safeZones(
    projectId: string,
    opts: { clip: string; bandHeight?: number; occupancyThreshold?: number; minConfidence?: number },
  ): Promise<CacheReadResult>;
  transcribeClip(projectId: string, clip: string): Promise<CacheReadResult>;
  /** Whether a clip — or every video clip in the project, if `clip` is omitted —
   *  has been processed (proxy / audio split / transcription / OCR / objects).
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
    opts?: { channel?: string; timeoutMs?: number },
  ): Promise<ProcessClipOutcome>;
  /** Process every (unique) video clip in the project, reusing one browser. */
  processProject(
    projectId: string,
    opts?: { clips?: string[]; channel?: string; timeoutMs?: number },
  ): Promise<ProcessClipOutcome[]>;

  // ── Rendering (real local browser, no ffmpeg, no server) ──────────────────
  renderFrame(
    projectId: string,
    frame?: number,
    opts?: Omit<RenderFrameOptions, "projectId" | "frame">,
  ): Promise<Buffer>;
  renderVideo(
    projectId: string,
    opts?: Omit<RenderVideoOptions, "projectId">,
  ): Promise<Buffer>;
}

const safeText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return "";
  }
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

  const headers = (extra?: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
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
    return projectSchema.parse(migrateProject(await res.json()));
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

  // Upload a local file via presign → PUT → finalize. Shared by addVideo's
  // `{ file }` branch.
  const uploadLocalFile = async (
    projectId: string,
    filePath: string,
    durationSeconds: number,
    overrideName?: string,
  ): Promise<Record<string, unknown>> => {
    const [{ readFile }, { basename }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const bytes = await readFile(filePath);
    const filename = overrideName ?? basename(filePath);
    const presign = (await postRaw("/api/upload-clip/init", {
      projectId,
      filename,
      durationSeconds,
      fileSize: bytes.byteLength,
    })) as { uploadUrl: string; filename: string; contentType: string };
    const put = await doFetch(presign.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": presign.contentType },
      body: bytes,
    });
    if (!put.ok) {
      throw new Error(`addVideo: PUT to R2 failed: HTTP ${put.status}`);
    }
    return postRaw("/api/upload-clip/finalize", {
      projectId,
      filename: presign.filename,
      durationSeconds,
    });
  };

  return {
    getProject,
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
          name: string | null;
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
        name: string | null;
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
    restoreVersion: async (projectId, versionId) =>
      (await serverData("restore_version", projectId, { versionId })) as {
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
      const uploaded =
        "url" in source
          ? await postRaw("/api/upload-clip/from-url", {
              projectId,
              url: source.url,
              filename: source.filename,
              durationSeconds: source.durationSeconds,
            })
          : await uploadLocalFile(
              projectId,
              source.file,
              source.durationSeconds,
              source.filename,
            );
      const filename = String(uploaded.filename ?? source.filename ?? "");
      if (!filename) {
        throw new Error("addVideo: upload did not return a filename");
      }
      const processing = await processClipHeadless({
        origin,
        token,
        projectId,
        clip: filename,
        channel: opts.channel,
        timeoutMs: opts.timeoutMs,
      });
      return { ...uploaded, filename, processing };
    },
    uploadClip: async (projectId, opts) =>
      postRaw("/api/upload-clip/from-url", { projectId, ...opts }),
    uploadClipPresign: async (projectId, opts) => {
      const data = (await postRaw("/api/upload-clip/init", {
        projectId,
        ...opts,
      })) as { uploadUrl: string; key: string; filename: string; contentType: string };
      return { ...data, expiresInSeconds: 15 * 60 };
    },
    uploadClipFinalize: async (projectId, opts) =>
      postRaw("/api/upload-clip/finalize", { projectId, ...opts }),
    uploadImage: async (projectId, opts) =>
      (await serverData("upload_image", projectId, { ...opts })) as Record<string, unknown>,
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
    findPublicImage: async (projectId, query, opts = {}) =>
      (await serverData("find_public_image", projectId, {
        query,
        license_type: opts.licenseType,
        min_dimension: opts.minDimension,
      })) as { filename: string; attribution: unknown; dimensions: unknown },

    detectTextRegions: (projectId, target) =>
      cacheRead("detect_text_regions", projectId, { ...target }),
    detectObjects: (projectId, clip) => cacheRead("detect_objects", projectId, { clip }),
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
        clips = [...new Set(project.video_layers.map((v) => v.clip))];
      }
      return processClipsHeadless({ origin, token, projectId, ...opts, clips });
    },

    renderFrame: (projectId, frame = 0, opts = {}) =>
      renderFrame({ origin, token, ...opts, projectId, frame }),
    renderVideo: (projectId, opts = {}) =>
      renderVideo({ origin, token, ...opts, projectId }),
  };
};
