// morpha-studio-sdk — the Morpha SDK.
//
// Build, caption, and render short-form video projects in code. The project-
// building half is pure (no browser, no ffmpeg); renderFrame() drives a real
// browser to render a composited frame (no ffmpeg — see ./render.ts).

// ── Pure project core (no browser, no ffmpeg) ───────────────────────────────
// Every Morpha tool as a pure (project, args) => { project, result } function,
// plus the catalog metadata.
export { dispatch, TOOL_DEFINITIONS } from "./core/tools.ts";
export type { ToolFunction, ToolResult, ToolDispatch } from "./core/tools.ts";

// A blank, schema-valid project to start from.
export { blankProject } from "./core/blank-project.ts";
export type { BlankProjectOpts } from "./core/blank-project.ts";

// Schema: validate + migrate project JSON, and the project/layer types.
export { projectSchema, migrateProject } from "./core/schemas.ts";
export type {
  Project,
  ImageLayer,
  VideoLayer,
  TextLayer,
  LayerStyle,
  Easing,
} from "./core/schemas.ts";

// Captioning: transcript words -> synced caption track.
export {
  transcriptToCaptionLines,
  buildCaptionsForClip,
  hasCaptionsForClip,
  removeCaptionsForClip,
  videoElementIdForClip,
} from "./core/captions.ts";
export type { CaptionLine, TranscriptWordLike } from "./core/captions.ts";

// ── Rendering (real local browser, no ffmpeg, no server) ────────────────────
// renderFrame → one composited PNG; renderVideo → the full MP4 (the same
// in-browser WebCodecs pipeline the editor's Render button uses).
export { renderFrame, renderVideo } from "./render.ts";
export type { RenderFrameOptions, RenderVideoOptions } from "./render.ts";

// ── Hosted client (the programmatic equivalent of driving Morpha over MCP) ───
// createClient({ token }) → getProject / listTools / callTool / renderFrame.
export { createClient } from "./client.ts";
export type {
  MorphaClient,
  MorphaClientOptions,
  ToolCallResult,
} from "./client.ts";
