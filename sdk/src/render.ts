export interface RenderFrameOptions {
  /** Project id, served at `${origin}/api/project/<id>`. */
  projectId: string;
  /** Composition frame (0-indexed, 30 fps). Default 0. */
  frame?: number;
  /** Origin serving /render-canvas + /api/project + /clips. Default https://morphastudio.ai */
  origin?: string;
  /** Bearer token for the Morpha account (forwarded to the project/clip fetches). */
  token?: string;
  /** Canvas width in px. Default 1080. */
  width?: number;
  /** Canvas height in px. Default 1920. */
  height?: number;
  /**
   * Browser channel. Defaults to system Chrome ("chrome") so HEVC decodes via
   * the OS decoder (macOS/Windows). Use "chromium" for H.264/VP9/AV1 only.
   */
  channel?: string;
  /**
   * Milliseconds to wait for page load + the render-ready flag. Default 90000.
   * The render page can spend up to ~60s loading + seeking a large
   * non-faststart 4K/HEVC clip on a cold cache (it must read to the moov),
   * so this default leaves headroom above that; raise it for very large clips.
   */
  timeoutMs?: number;
}

/**
 * Render one composited frame to a PNG Buffer. The video frame is decoded and
 * every overlay (captions/shapes/text) composited by a REAL browser — no
 * ffmpeg. With the default `channel: "chrome"`, HEVC/AV1/H.264 all decode (HEVC
 * needs the OS decoder, i.e. macOS/Windows). Requires `playwright` installed
 * (optional peer dependency) and Google Chrome available on the machine.
 */
export const renderFrame = async (opts: RenderFrameOptions): Promise<Buffer> => {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error(
      "renderFrame() needs Playwright. Install it: `npm i playwright`, and have Google Chrome available.",
    );
  }
  const origin = opts.origin ?? "https://morphastudio.ai";
  const frame = Math.max(0, Math.round(opts.frame ?? 0));
  const width = Math.max(64, Math.round(opts.width ?? 1080));
  const height = Math.max(64, Math.round(opts.height ?? 1920));
  const timeout = opts.timeoutMs ?? 90_000;

  const browser = await pw.chromium.launch({
    channel: opts.channel ?? "chrome",
    headless: true,
  });
  try {
    const ctx = await browser.newContext({ viewport: { width, height } });
    if (opts.token) {
      await ctx.setExtraHTTPHeaders({ Authorization: `Bearer ${opts.token}` });
    }
    const page = await ctx.newPage();
    const url = `${origin}/render-canvas?project=${encodeURIComponent(opts.projectId)}&frame=${frame}`;
    // `domcontentloaded`, not `networkidle`: a <video preload="auto"> streaming
    // a large non-faststart clip keeps the network busy well past the 500ms
    // idle window, which would block (or time out) goto before the page can
    // paint. The page's structured readiness flag is the real sync point.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // Wait for a terminal state. New page: __morphaRenderStatus.done. Old page
    // (legacy build): the bare __morphaRenderReady boolean. Either resolves.
    try {
      await page.waitForFunction(
        () => {
          const w = window as unknown as {
            __morphaRenderStatus?: { done?: boolean };
            __morphaRenderReady?: boolean;
          };
          if (w.__morphaRenderStatus) {
            return w.__morphaRenderStatus.done === true;
          }
          return w.__morphaRenderReady === true;
        },
        { timeout },
      );
    } catch {
      throw new Error(
        `Morpha render timed out after ${Math.round(timeout / 1000)}s for project ${opts.projectId} frame ${frame} — the clip may still be loading; raise timeoutMs for very large clips.`,
      );
    }

    // Read the structured status. null on older deployments that only set the
    // legacy boolean — there we can't distinguish black from good, so return
    // the buffer exactly as before (no regression).
    const status = (await page.evaluate(() => {
      return (
        (window as unknown as { __morphaRenderStatus?: unknown })
          .__morphaRenderStatus ?? null
      );
    })) as {
      ok?: boolean;
      error?: string;
      videoLayersExpected?: number;
      videoLayersFailed?: number;
    } | null;

    if (status && status.ok === false) {
      const expected = status.videoLayersExpected ?? 0;
      const failed = status.videoLayersFailed ?? 0;
      throw new Error(
        `Morpha render incomplete for project ${opts.projectId} frame ${frame}: ` +
          (status.error ?? "render reported not-ok") +
          (expected
            ? ` (${failed}/${expected} video layer(s) failed to decode within ${Math.round(
                timeout / 1000,
              )}s — raise timeoutMs for very large clips)`
            : ""),
      );
    }

    return await page.locator("canvas").first().screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
};
