// Headless clip PROCESSING via a real browser — the agent-flow counterpart to
// render.ts. Drives the editor's /process-clip route with Playwright + system
// Chrome to run a clip's full pipeline (proxy build, audio split, transcription,
// OCR); the artifacts + side-cars land in R2, and the readers
// (transcribeClip / detectTextRegions) light up afterward.
//
// Processing never runs on the worker (no server-side AI), so an agent that
// uploads a clip MUST process it through this path or by opening the editor.
// Requires `playwright` (optional peer dependency) and Google Chrome available.

import { routeMorphaOrigin } from "./browser-auth.ts";

/** The OPTIONAL processing steps a run may be restricted to. `transcript` +
 *  `audio_split` are the audio-only steps the caption flow needs;
 *  `text_regions` decodes video frames (slow in headless Chrome). The preview
 *  proxy is NOT on this list: it is mandatory and runs on every processing
 *  run, because it is what makes the clip usable in the editor. (The source of
 *  these two types is editor/src/processing/process-clip-headless.ts; this
 *  file mirrors them because the SDK cannot import editor code.) */
export type OptionalProcessStep = "audio_split" | "transcript" | "text_regions";
/** Every step a run reports on, the mandatory proxy included. */
export type ProcessStep = "proxy" | OptionalProcessStep;

export interface ProcessClipOutcome {
  clip: string;
  /** true only when the run finished AND the mandatory proxy landed
   *  (`steps.proxy === "ready"`). false when the page reported a fatal error,
   *  the run timed out, or the proxy could not be built — `error` says which.
   *  OPTIONAL steps can still be "unavailable"/"error" on an ok run (e.g. a
   *  clip with no audio track) — inspect `steps` / `reasons`. */
  ok: boolean;
  steps?: Record<string, string>;
  /** Per-step failure reason (from each pass's `error`), when the page recorded
   *  one — lets a caller tell "no audio track" from "worker didn't initialize"
   *  rather than reading a bare "unavailable". */
  reasons?: Record<string, string>;
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
  /** Restrict the OPTIONAL steps to these (default: all of them). The fast
   *  caption path is `["transcript", "audio_split"]` — it skips the slow per-
   *  frame OCR pass. The proxy runs regardless; it cannot be named here. */
  steps?: OptionalProcessStep[];
}

export interface ProcessClipsOptions extends Omit<ProcessClipOptions, "clip"> {
  /** Clips to process, in order. They share one browser (one launch). */
  clips: string[];
}

// The pipeline runs transcript → OCR → proxy → audio split serially,
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
): Promise<{
  updatedAt: number;
  steps?: Record<string, string>;
  reasons?: Record<string, string>;
}> => {
  const res = await fetch(
    `${origin}/api/clips/${encodeURIComponent(projectId)}/${encodeURIComponent(clip)}/enrichment`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  ).catch(() => null);
  if (!res || !res.ok) return { updatedAt: 0 };
  const j = (await res.json().catch(() => null)) as {
    data?: {
      updatedAt?: number;
      passes?: Record<string, { status?: string; error?: string }>;
      proxy?: { status?: string; error?: string };
      audio_split?: { status?: string; error?: string };
    };
  } | null;
  const m = j?.data;
  if (!m) return { updatedAt: 0 };
  const byStep: Record<string, { status?: string; error?: string } | undefined> = {
    transcript: m.passes?.transcript,
    text_regions: m.passes?.text_regions,
    proxy: m.proxy,
    audio_split: m.audio_split,
  };
  const steps = m.passes
    ? {
        transcript: byStep.transcript?.status ?? "pending",
        text_regions: byStep.text_regions?.status ?? "pending",
        proxy: byStep.proxy?.status ?? "pending",
        audio_split: byStep.audio_split?.status ?? "pending",
      }
    : undefined;
  const reasons: Record<string, string> = {};
  for (const [step, state] of Object.entries(byStep)) {
    if (state?.error) reasons[step] = state.error;
  }
  return {
    updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0,
    steps,
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
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
  steps?: OptionalProcessStep[],
): Promise<ProcessClipOutcome> => {
  // Baseline so we detect THIS run's manifest rewrite, not a stale prior one.
  const baseline = (await readManifest(origin, token, projectId, clip)).updatedAt;

  const stepsParam =
    steps && steps.length > 0 ? `&steps=${encodeURIComponent(steps.join(","))}` : "";
  await page
    .goto(
      `${origin}/process-clip?project=${encodeURIComponent(projectId)}&clip=${encodeURIComponent(clip)}${stepsParam}`,
      { waitUntil: "commit", timeout: 60_000 },
    )
    .catch(() => {});

  const deadline = Date.now() + timeout;
  let last: {
    updatedAt: number;
    steps?: Record<string, string>;
    reasons?: Record<string, string>;
  } = { updatedAt: baseline };
  while (Date.now() < deadline) {
    await sleep(5_000);
    last = await readManifest(origin, token, projectId, clip);
    if (last.updatedAt > baseline) break;
  }
  return outcomeFromManifest(clip, last, baseline, timeout);
};

/** One run's outcome, judged from the manifest the page writes at the END of
 *  its run. Finished = the manifest's `updatedAt` advanced past the baseline
 *  read before navigation. `ok` requires BOTH that and the mandatory proxy
 *  being ready — an agent that only checks `ok` cannot leave a clip
 *  un-optimised without noticing. Optional-step failures are reported in
 *  `steps` / `reasons` and do not fail the run. Pure; exported for tests. */
export const outcomeFromManifest = (
  clip: string,
  manifest: {
    updatedAt: number;
    steps?: Record<string, string>;
    reasons?: Record<string, string>;
  },
  baseline: number,
  timeoutMs: number,
): ProcessClipOutcome => {
  const base = { clip, steps: manifest.steps, reasons: manifest.reasons };
  if (!(manifest.updatedAt > baseline)) {
    return {
      ...base,
      ok: false,
      error: `processing did not finish within ${Math.round(timeoutMs / 1000)}s for clip ${clip} — raise timeoutMs`,
    };
  }
  if (manifest.steps?.proxy === "ready") return { ...base, ok: true };
  return {
    ...base,
    ok: false,
    error: `proxy not built: ${manifest.reasons?.proxy ?? "unknown"}`,
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
    // Token-only: this context is EPHEMERAL (browser.newContext, discarded
    // with the browser), so it has no cache old enough to go stale — routing it
    // unconditionally would only cost the render bundle a re-fetch per clip.
    if (opts.token) {
      await routeMorphaOrigin(ctx, origin, opts.token);
    }
    const page = await ctx.newPage();
    return await runOne(
      page,
      origin,
      opts.token,
      opts.projectId,
      opts.clip,
      timeout,
      opts.steps,
    );
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
    // Token-only: this context is EPHEMERAL (browser.newContext, discarded
    // with the browser), so it has no cache old enough to go stale — routing it
    // unconditionally would only cost the render bundle a re-fetch per clip.
    if (opts.token) {
      await routeMorphaOrigin(ctx, origin, opts.token);
    }
    const page = await ctx.newPage();
    const out: ProcessClipOutcome[] = [];
    // Sequential: each clip saturates CPU/GPU (transcode + WASM models), so
    // running them in parallel pages would just thrash.
    for (const clip of opts.clips) {
      out.push(
        await runOne(page, origin, opts.token, opts.projectId, clip, timeout, opts.steps),
      );
    }
    return out;
  } finally {
    await browser.close();
  }
};
