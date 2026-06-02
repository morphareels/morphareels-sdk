# morpha-studio-sdk

**The agentic video editor SDK — build, caption, and render short-form video in code.** Drive [Morpha](https://morphastudio.ai) with the same tool catalog as MCP, render a composited frame to PNG, and build projects programmatically — **no ffmpeg**.

```bash
npm i morpha-studio-sdk
```

- 📦 npm: https://www.npmjs.com/package/morpha-studio-sdk
- 📖 Docs: https://morphastudio.ai/docs/sdk
- 🎬 Morpha: https://morphastudio.ai

## Drive a hosted project (the MCP-equivalent client)

```ts
import { createClient } from "morpha-studio-sdk";

const morpha = createClient({ token: process.env.MORPHA_TOKEN }); // origin defaults to https://morphastudio.ai

const project = await morpha.getProject("my-project");
const { result, editorUrl } = await morpha.callTool("my-project", "add_text_layer", {
  text: "HELLO", x: 540, y: 600, font_family: "Anton",
});
const png = await morpha.renderFrame("my-project", 150); // a composited PNG, no ffmpeg
```

`createClient` calls the same Worker endpoints as Morpha's MCP server (`GET /api/project/:id`, `GET /api/tools`, `POST /api/tool/:name`); `callTool` does the load → dispatch → write round-trip server-side. The token is your `mp_…` API key from [`/app/settings`](https://morphastudio.ai/app).

## Render a frame to PNG (no ffmpeg)

```ts
import { renderFrame } from "morpha-studio-sdk";
import { writeFile } from "node:fs/promises";

const png = await renderFrame({ projectId: "demo", frame: 150, token: process.env.MORPHA_TOKEN });
await writeFile("frame.png", png);
```

Rendering composites the whole project in a real browser (Playwright + system Chrome), so it's pixel-identical to the editor and decodes **HEVC / iPhone `.MOV`**. Needs Playwright + Chrome locally:

```bash
npm i playwright   # optional peer dependency; only for renderFrame()
```

## Build a project offline (pure core)

```ts
import { blankProject, dispatch, projectSchema } from "morpha-studio-sdk";

let project = blankProject({ projectId: "demo", canvasWidth: 1080, canvasHeight: 1920 });
project = dispatch.add_text_layer(project, { text: "HELLO", x: 540, y: 600 }).project;
projectSchema.parse(project); // a valid Morpha project
```

`dispatch.<tool>(project, args)` is pure and local (no persistence); `callTool` is the hosted path. See the [full docs](https://morphastudio.ai/docs/sdk) for the complete API, captioning helpers, and types.

## Repository layout

The published package lives in [`sdk/`](sdk). The sibling [`src/`](src) and [`editor/src/`](editor/src) directories are the shared Morpha core the package is built from (bundled into `sdk/dist` at publish time, so installs are self-contained). This repo is an npm workspace so a single install wires everything up.

```bash
npm install        # at the repo root (installs the workspace)
npm run build      # builds the sdk/ package (tsup → dist)
```

## License

MIT © [Morpha Studio](https://morphastudio.ai)
