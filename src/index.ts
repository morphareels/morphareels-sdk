// morphareels-sdk — the Morpha SDK.
//
// Build, caption, and render short-form video projects in code. The project-
// building half is pure (no browser, no ffmpeg); renderFrame() drives a real
// browser to render a composited frame (no ffmpeg — see ./render.ts).

// ── Pure project core (no browser, no ffmpeg) ───────────────────────────────
// Every Morpha tool as a pure (project, args) => { project, result } function,
// plus the catalog metadata. `dispatchOnProject` is the carousel-aware entry
// point (the one the hosted HTTP/MCP surfaces route through): on a carousel
// project it targets the active page for content tools and the record for page
// management; on a video project it is byte-identical to `dispatch[name]`.
export { dispatch, dispatchOnProject, TOOL_DEFINITIONS } from "./core/tools.ts";
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
// in-browser WebCodecs pipeline the editor's Share → Download uses), and
// renderVideoToFile → that MP4 written to disk as it arrives.
export { renderFrame, renderFrames, renderVideo, renderVideoToFile } from "./render.ts";
export type {
  RenderFrameOptions,
  RenderFramesOptions,
  RenderVideoOptions,
  RenderVideoToFileOptions,
} from "./render.ts";

// ── Processing (real local browser) — proxy / audio split / transcription /
// OCR / object detection for an uploaded clip. The agent-flow way to make a
// clip's caches + artifacts exist without opening the editor.
export { processClip, processClips, outcomeFromManifest } from "./process.ts";
export type {
  ProcessClipOptions,
  ProcessClipsOptions,
  ProcessClipOutcome,
  ProcessStep,
  OptionalProcessStep,
} from "./process.ts";

// ── Public image search (runs here, on the caller's quota) ──────────────────
// The client's findPublicImage wraps this and stores the pick via upload_image.
export { searchPublicImage, SDK_USER_AGENT } from "./public-image.ts";
export type { FindPublicImageOptions } from "./public-image.ts";
export type {
  PublicImagePick,
  PublicImageAttribution,
  PublicImageLicenseType,
} from "./core/public-image.ts";

// ── Registration (no browser, no human) ─────────────────────────────────────
// The way in for an agent holding no credential at all: mint a fresh account
// and get an `mp_…` key back, then hand it straight to createClient({ token }).
export { registerAccount } from "./register.ts";
export type { RegisterAccountOptions, RegisteredAccount } from "./register.ts";

// ── Hosted client (the programmatic equivalent of driving Morpha over MCP) ───
// createClient({ token }) → getProject / listTools / callTool / addVideo /
// processClip / renderFrame.
export { createClient, projectClips } from "./client.ts";
export type {
  MorphaClient,
  MorphaClientOptions,
  ToolCallResult,
  ToolResultEnvelope,
  CacheReadResult,
  AddVideoSource,
  ClipProcessingStatus,
} from "./client.ts";
