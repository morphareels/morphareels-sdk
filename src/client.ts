// A thin, typed HTTP client for a hosted Morpha account — the programmatic
// equivalent of driving Morpha over MCP. It wraps the same Worker endpoints
// the MCP server and editor use:
//
//   GET  /api/project/:id      -> fetch a project's JSON
//   GET  /api/tools            -> the tool catalog
//   POST /api/tool/:name       -> load -> dispatch one tool -> write back
//
// plus renderFrame() (a real browser, no ffmpeg — see ./render.ts). Auth is a
// Bearer API key (mp_…). Every tool you can call over MCP, you can call here
// with `client.callTool(projectId, name, args)` — same catalog, same effects.

import { migrateProject, projectSchema, type Project } from "./core/schemas.ts";
import type { ToolFunction, ToolResult } from "./core/tools.ts";
import {
  renderFrame,
  renderVideo,
  type RenderFrameOptions,
  type RenderVideoOptions,
} from "./render.ts";

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

/** The outcome of a `callTool` round-trip. `result.ok` may be `false` for a
 *  tool-level failure (e.g. a missing asset) — that is a normal, non-throwing
 *  outcome the caller inspects; only transport/HTTP errors throw. */
export interface ToolCallResult {
  result: ToolResult;
  /** The project AFTER the tool ran (the server has already persisted it when
   *  `result.ok` and the tool changed anything). */
  project: Project;
  /** Tappable link that opens this project in the editor. */
  editorUrl?: string;
}

export interface MorphaClient {
  /** Fetch a hosted project's JSON (migrated + schema-validated). */
  getProject(projectId: string): Promise<Project>;
  /** The hosted tool catalog (same set you can `callTool`) — OpenAI tool shape:
   *  each entry is `{ type: "function", function: { name, description, parameters } }`. */
  listTools(): Promise<ToolFunction[]>;
  /**
   * Call one tool against a hosted project — the HTTP equivalent of an MCP
   * `tools/call`. The server loads the project, dispatches the tool, and writes
   * the result back. Returns `{ result, project, editorUrl }`. Throws only on
   * transport/HTTP errors; a tool-level failure comes back as `result.ok:false`.
   */
  callTool(
    projectId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  /**
   * Render one composited frame of a hosted project to a PNG (real browser, no
   * ffmpeg). Convenience wrapper over the standalone `renderFrame()` with this
   * client's `origin`/`token` applied; pass `opts` to override width/height/
   * channel/timeoutMs.
   */
  renderFrame(
    projectId: string,
    frame?: number,
    opts?: Omit<RenderFrameOptions, "projectId" | "frame">,
  ): Promise<Buffer>;
  /**
   * Render a hosted project's FULL composition to an MP4 (real local browser,
   * same WebCodecs pipeline as the editor's Render button — no ffmpeg, no
   * server). Convenience wrapper over the standalone `renderVideo()` with this
   * client's `origin`/`token` applied; pass `opts` to override channel/timeoutMs.
   */
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
 * MCP, you can do here:
 *
 * ```ts
 * import { createClient } from "morphareels-sdk";
 * const morpha = createClient({ token: process.env.MORPHA_API_KEY });
 * await morpha.callTool("my-project", "add_text_layer", { text: "HELLO", x: 540, y: 600 });
 * const png = await morpha.renderFrame("my-project", 150);
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

  const callTool = async (
    projectId: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult> => {
    const res = await doFetch(`${origin}/api/tool/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ projectId, args }),
    });
    const json = (await res.json().catch(() => null)) as
      | (Partial<ToolCallResult> & { error?: string })
      | null;
    if (!res.ok) {
      const msg =
        json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      throw new Error(`callTool(${name}) failed: ${msg}`);
    }
    if (!json || !json.result || !json.project) {
      throw new Error(`callTool(${name}) returned an unexpected response shape`);
    }
    return json as ToolCallResult;
  };

  const renderFrameForProject = (
    projectId: string,
    frame = 0,
    opts: Omit<RenderFrameOptions, "projectId" | "frame"> = {},
  ): Promise<Buffer> =>
    renderFrame({ origin, token, ...opts, projectId, frame });

  const renderVideoForProject = (
    projectId: string,
    opts: Omit<RenderVideoOptions, "projectId"> = {},
  ): Promise<Buffer> =>
    renderVideo({ origin, token, ...opts, projectId });

  return {
    getProject,
    listTools,
    callTool,
    renderFrame: renderFrameForProject,
    renderVideo: renderVideoForProject,
  };
};
