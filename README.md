# morpha-studio-sdk

**The agentic video editor SDK — build, caption, and render short-form video in code.** Compose layers/captions/keyframes programmatically, then render a frame to PNG or export MP4 by driving a real browser. **No ffmpeg.** The client SDK for [Morpha Studio](https://morphastudio.ai).

```bash
npm i morpha-studio-sdk
```

## Drive a hosted project — the MCP-equivalent client

`createClient` is the recommended way to drive a hosted Morpha account from code — the programmatic equivalent of an MCP session. Every tool you can call over MCP, you call here.

```ts
import { createClient } from "morpha-studio-sdk";

const morpha = createClient({ token: process.env.MORPHA_TOKEN }); // origin defaults to https://morphastudio.ai

const project = await morpha.getProject("my-project");
const { result, editorUrl } = await morpha.callTool("my-project", "add_text_layer", {
  text: "HELLO", x: 540, y: 600, font_family: "Anton",
});
const png = await morpha.renderFrame("my-project", 150); // a composited PNG, no ffmpeg
const mp4 = await morpha.renderVideo("my-project");      // the full composition as MP4, no ffmpeg
```

`createClient` calls the same tool catalog as Morpha's MCP server, over the same Worker endpoints (`GET /api/project/:id`, `GET /api/tools`, `POST /api/tool/:name`) — `callTool` does the load → dispatch → write round-trip server-side. The token is your `mp_…` API key from `/app/settings`.

## Make a video in code

```ts
import { blankProject, dispatch, projectSchema } from "morpha-studio-sdk";

let project = blankProject({ projectId: "demo", canvasWidth: 1080, canvasHeight: 1920 });

// Every Morpha tool is a pure (project, args) => { project, result } function:
project = dispatch.add_text_layer(project, { text: "HELLO", x: 540, y: 600, font_family: "Anton" }).project;
project = dispatch.add_caption_track(project, {
  lines: [{ text: "first line", startFrame: 0, endFrame: 30 }],
  style: "bold-outline",
}).project;

projectSchema.parse(project); // it's a valid Morpha project, ready to save or render
```

## Render a video frame to PNG (no ffmpeg)

```ts
import { renderFrame } from "morpha-studio-sdk";
import { writeFile } from "node:fs/promises";

const png = await renderFrame({ projectId: "demo", frame: 150, token: process.env.MORPHA_TOKEN });
await writeFile("frame.png", png);
```

Rendering decodes the video and composites every overlay in a **real browser** (Playwright + system Chrome) — pixel-identical to the editor, and **without ffmpeg**. Install Playwright + have Google Chrome for rendering:

```bash
npm i playwright   # optional peer dep; only needed for renderFrame()
```

## Export MP4 without ffmpeg

`renderVideo()` exports the full composition to MP4 — the same in-browser WebCodecs H.264 pipeline the editor's Render button uses, driven by a real local browser. No ffmpeg dependency, no GPL, no server.

```ts
import { renderVideo } from "morpha-studio-sdk";
import { writeFile } from "node:fs/promises";

const mp4 = await renderVideo({ projectId: "demo", token: process.env.MORPHA_TOKEN });
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

MIT © [Morpha Studio](https://morphastudio.ai)
