# morphareels-sdk

**The agentic video editor SDK — build, caption, and render short-form video in code.** Compose layers/captions/keyframes programmatically, then render a frame to PNG or export MP4 by driving a real browser. **No ffmpeg.** The official client SDK for [Morpha](https://morphareels.ai) — and the recommended, full-featured way to drive it from code.

```bash
npm i morphareels-sdk
```

Requires **Node ≥ 20**.

## Drive a hosted project — the MCP-equivalent client

`createClient` is the recommended way to drive a hosted Morpha account from code — the programmatic equivalent of an MCP session over the **full** catalog. Every tool you can call over MCP you can call here: the pure mutation tools **plus** the workspace/lifecycle, version, upload, and vision tools (`list_projects`, `create_project`, `save_version`, `upload_clip`, `upload_image`, `find_public_image`, `detect_text_regions`, `safe_zones`, …). Most have a typed convenience method; anything else goes through generic `callTool`.

```ts
import { createClient } from "morphareels-sdk";

const morpha = createClient({ token: process.env.MORPHA_API_KEY }); // origin defaults to https://morphareels.ai

const [{ id }] = await morpha.listProjects();                 // typed workspace tool — no projectId
await morpha.uploadImage(id, { url: "https://example.com/logo.png" }); // ingest, then reference by filename
await morpha.callTool(id, "add_image_layer", { filename: "logo.png", x: 540, y: 600, width: 300, height: 300 });
await morpha.saveVersion(id, { name: "add logo" });          // snapshot the change-set

const png = await morpha.renderFrame(id, 150); // a composited PNG, no ffmpeg
const mp4 = await morpha.renderVideo(id);      // the full composition as MP4, no ffmpeg
```

`createClient` calls the same tool catalog as Morpha's MCP server, over the same Worker endpoints (`GET /api/project/:id`, `GET /api/tools`, `POST /api/tool/:name`) — `callTool` does the load → dispatch → write round-trip server-side. The token is your `mp_…` API key from `/app/settings` (a Standard or Pro subscription mints keys). Pure mutation tools return `{ result, project, editorUrl }`; workspace/upload/vision tools return `{ result }` (no `project`), and the typed methods unwrap `result.data` for you. Cache-backed vision/transcript reads can come back `not-ready` until the clip is opened once in the editor.

## Make a video in code

```ts
import { blankProject, dispatch, projectSchema } from "morphareels-sdk";

let project = blankProject({ projectId: "demo", canvasWidth: 1080, canvasHeight: 1920 });

// Every Morpha tool is a pure (project, args) => { project, result } function:
project = dispatch.add_text_layer(project, { text: "HELLO", x: 540, y: 600, font_family: "Anton" }).project;
project = dispatch.add_caption_track(project, {
  lines: [{ text: "first line", startFrame: 0, endFrame: 30 }],
  style: "bold-outline",
}).project;

projectSchema.parse(project); // it's a valid Morpha project, ready to save or render
```

## Add a video clip (upload **and** process)

Clip ingest is npm-only: `addVideo` uploads the clip **and** runs the full processing pipeline — proxy build, audio split, transcription, OCR, object detection — so the clip is editor-ready and the `transcribeClip` / `detectTextRegions` / `detectObjects` readers light up. (Processing runs in a real local Chrome, like `renderFrame` — install Playwright + Chrome.)

```ts
const morpha = createClient({ token: process.env.MORPHA_API_KEY });

const { filename, processing } = await morpha.addVideo(id, { url: "https://example.com/clip.mp4" });
// processing.steps → { proxy, audio_split, transcript, text_regions, objects }
await morpha.callTool(id, "add_video_layer", { clip: filename, x: 540, y: 960, width: 1080, height: 1920 });

const t = await morpha.transcribeClip(id, filename); // now { status: "ready", data: { words, … } }
```

`addVideo` also takes `{ file }` (a local path; needs `durationSeconds`). To (re)process clips added another way: `processClip(id, clip)` / `processProject(id)`. Check state any time with `clipProcessingStatus(id)`.

## Render a video frame to PNG (no ffmpeg)

```ts
import { renderFrame } from "morphareels-sdk";
import { writeFile } from "node:fs/promises";

const png = await renderFrame({ projectId: "demo", frame: 150, token: process.env.MORPHA_API_KEY });
await writeFile("frame.png", png);
```

Rendering decodes the video and composites every overlay in a **real browser** (Playwright + system Chrome) — pixel-identical to the editor, and **without ffmpeg**. Install Playwright + have Google Chrome for rendering:

```bash
npm i playwright   # optional peer dep; only needed for renderFrame()
```

## Export MP4 without ffmpeg

`renderVideo()` exports the full composition to MP4 — the same in-browser WebCodecs H.264 pipeline the editor's Render button uses, driven by a real local browser. No ffmpeg dependency, no GPL, no server.

```ts
import { renderVideo } from "morphareels-sdk";
import { writeFile } from "node:fs/promises";

const mp4 = await renderVideo({ projectId: "demo", token: process.env.MORPHA_API_KEY });
await writeFile("video.mp4", mp4);
```

Like `renderFrame()`, this needs Playwright + system Chrome (`channel: "chrome"` — Chromium can't encode H.264).

## Auto-caption a clip

Turn a clip's transcript into a synced, styled caption track with `buildCaptionsForClip` / `transcriptToCaptionLines` — one text layer per line, timed to the words.

## HEVC / iPhone video

System Chrome decodes **H.264, VP9, AV1, and HEVC** (HEVC via the OS decoder on macOS/Windows) — so 10-bit iPhone `.MOV` clips render correctly, which headless-Chromium-only tools can't do.

## A programmatic / agentic video editor (Remotion alternative)

Unlike code-as-video frameworks, this is a real **editor project model** (layers, mattes, blend modes, keyframes, captions) you mutate via a typed tool catalog — ideal for **AI agents / LLMs** driving video edits, or any programmatic pipeline. It's the recommended client for driving Morpha programmatically: it calls the same hosted tool catalog as Morpha's MCP server, over the same Worker endpoints, so it's the typed, friendly alternative to wiring up MCP yourself (MCP stays available for MCP-native agents).

## License

MIT © [Morpha](https://morphareels.ai)
