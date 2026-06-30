// Headless clip PROCESSING via a real browser — the agent-flow counterpart to
// render.ts. Drives the editor's /process-clip route with Playwright + system
// Chrome to run a clip's full pipeline (proxy build, audio split, transcription,
// OCR, object detection); the artifacts + side-cars land in R2, and the readers
// (transcribeClip / detectTextRegions / detectObjects) light up afterward.
//
// Processing never runs on the worker (no server-side AI), so an agent that
// uploads a clip MUST process it through this path or by opening the editor.
// Requires `playwright` (optional peer dependency) and Google Chrome available.

export interface ProcessClipOutcome {
  clip: string;
  /** false when the route reported a fatal error or timed out. Individual steps
   *  can still be "unavailable"/"error" on an otherwise ok run (e.g. a clip with
   *  no audio track) — inspect `steps`. */
  ok: boolean;
  steps?: Record<string, string>;
  error?: string;
}

export interface ProcessClipOptions {
  projectId: string;
  clip: string;
  /** Origin serving /process-clip + /api/* + /clips. Default https://morphareels.ai */
  origin?: string;
  /** Bearer token for the Morpha account (forwarded to every fetch the page makes). */
  token?: string;
  /** Browser channel. Default system Chrome ("chrome"). */
  channel?: string;
  /** Per-clip deadline. Default 300000 — proxy transcode + WASM-fallback Whisper
   *  in headless Chrome is much slower than a render; raise for long clips. */
  timeoutMs?: number;
}

export interface ProcessClipsOptions extends Omit<ProcessClipOptions, "clip"> {
  /** Clips to process, in order. They share one browser (one launch). */
  clips: string[];
}

// The pipeline runs transcript → OCR/objects → proxy → audio split serially,
// each step time-bounded; 10 min covers a long clip's full run end-to-end. (The
// transcript lands first, so even a clip that overruns this still gets captions.)
const PROCESS_DEFAULT_TIMEOUT = 600_000;

const loadPlaywright = async (): Promise<typeof import("playwright")> => {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "processClip() needs Playwright. Install it: `npm i playwright`, and have Google Chrome available.",
    );
  }
};

// WebGPU + GPU launch flags. Not required for correctness (the page is allowed
// to block; see runOne) — they just let Whisper/OCR run on the GPU when the
// machine has one, which is much faster than single-thread WASM. Harmless when
// no GPU is available (transformers.js falls back to WASM).
const GPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--disable-dev-shm-usage",
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Read the clip's enrichment-manifest `updatedAt` from the SERVER (0 if none).
// processClipHeadless rewrites this manifest at the END of a run, so a newer
// `updatedAt` is the completion signal — observed from outside the page, so it
// survives the page's main thread being blocked by the WASM models for minutes.
const readManifest = async (
  origin: string,
  token: string | undefined,
  projectId: string,
  clip: string,
): Promise<{ updatedAt: number; steps?: Record<string, string> }> => {
  const res = await fetch(
    `${origin}/api/clips/${encodeURIComponent(projectId)}/${encodeURIComponent(clip)}/enrichment`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  ).catch(() => null);
  if (!res || !res.ok) return { updatedAt: 0 };
  const j = (await res.json().catch(() => null)) as {
    data?: {
      updatedAt?: number;
      passes?: Record<string, { status?: string }>;
      proxy?: { status?: string };
      audio_split?: { status?: string };
    };
  } | null;
  const m = j?.data;
  if (!m) return { updatedAt: 0 };
  const steps = m.passes
    ? {
        transcript: m.passes.transcript?.status ?? "pending",
        text_regions: m.passes.text_regions?.status ?? "pending",
        objects: m.passes.objects?.status ?? "pending",
        proxy: m.proxy?.status ?? "pending",
        audio_split: m.audio_split?.status ?? "pending",
      }
    : undefined;
  return {
    updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0,
    steps,
  };
};

// Drive one clip on an already-open page. Shared by processClip + processClips.
//
// We do NOT wait on the page (`waitForFunction`): the transformers.js WASM
// models block the page's main thread for minutes, and Playwright's in-page eval
// can't survive that (its protocol call times out after ~30s and the page reads
// as unresponsive). Instead we navigate to start the work, let the page run in
// the background, and POLL THE SERVER for the manifest the page writes when it
// finishes. The browser stays open the whole time so the work completes.
const runOne = async (
  page: import("playwright").Page,
  origin: string,
  token: string | undefined,
  projectId: string,
  clip: string,
  timeout: number,
): Promise<ProcessClipOutcome> => {
  // Baseline so we detect THIS run's manifest rewrite, not a stale prior one.
  const baseline = (await readManifest(origin, token, projectId, clip)).updatedAt;

  await page
    .goto(
      `${origin}/process-clip?project=${encodeURIComponent(projectId)}&clip=${encodeURIComponent(clip)}`,
      { waitUntil: "commit", timeout: 60_000 },
    )
    .catch(() => {});

  const deadline = Date.now() + timeout;
  let last: { updatedAt: number; steps?: Record<string, string> } = {
    updatedAt: baseline,
  };
  while (Date.now() < deadline) {
    await sleep(5_000);
    last = await readManifest(origin, token, projectId, clip);
    if (last.updatedAt > baseline) {
      return { clip, ok: true, steps: last.steps };
    }
  }
  return {
    clip,
    ok: false,
    steps: last.steps,
    error: `processing did not finish within ${Math.round(timeout / 1000)}s for clip ${clip} — raise timeoutMs`,
  };
};

export const processClip = async (
  opts: ProcessClipOptions,
): Promise<ProcessClipOutcome> => {
  const origin = (opts.origin ?? "https://morphareels.ai").replace(/\/+$/, "");
  const timeout = opts.timeoutMs ?? PROCESS_DEFAULT_TIMEOUT;
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    channel: opts.channel ?? "chrome",
    headless: true,
    args: GPU_ARGS,
  });
  try {
    const ctx = await browser.newContext();
    if (opts.token) {
      await ctx.setExtraHTTPHeaders({ Authorization: `Bearer ${opts.token}` });
    }
    const page = await ctx.newPage();
    return await runOne(page, origin, opts.token, opts.projectId, opts.clip, timeout);
  } finally {
    await browser.close();
  }
};

export const processClips = async (
  opts: ProcessClipsOptions,
): Promise<ProcessClipOutcome[]> => {
  const origin = (opts.origin ?? "https://morphareels.ai").replace(/\/+$/, "");
  const timeout = opts.timeoutMs ?? PROCESS_DEFAULT_TIMEOUT;
  if (opts.clips.length === 0) return [];
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    channel: opts.channel ?? "chrome",
    headless: true,
    args: GPU_ARGS,
  });
  try {
    const ctx = await browser.newContext();
    if (opts.token) {
      await ctx.setExtraHTTPHeaders({ Authorization: `Bearer ${opts.token}` });
    }
    const page = await ctx.newPage();
    const out: ProcessClipOutcome[] = [];
    // Sequential: each clip saturates CPU/GPU (transcode + WASM models), so
    // running them in parallel pages would just thrash.
    for (const clip of opts.clips) {
      out.push(await runOne(page, origin, opts.token, opts.projectId, clip, timeout));
    }
    return out;
  } finally {
    await browser.close();
  }
};
