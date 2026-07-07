export interface RenderFrameOptions {
  /** Project id, served at `${origin}/api/project/<id>`. */
  projectId: string;
  /** Composition frame (0-indexed, 30 fps). Default 0. */
  frame?: number;
  /** Origin serving /render-canvas + /api/project + /clips. Default https://morphareels.ai */
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
  const origin = opts.origin ?? "https://morphareels.ai";
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
      fontsFailed?: number;
      degradedFonts?: Array<{ family?: string; weight?: number; italic?: boolean }>;
    } | null;

    if (status && status.ok === false) {
      const expected = status.videoLayersExpected ?? 0;
      const failed = status.videoLayersFailed ?? 0;
      const fontsFailed = status.fontsFailed ?? 0;
      throw new Error(
        `Morpha render incomplete for project ${opts.projectId} frame ${frame}: ` +
          (status.error ?? "render reported not-ok") +
          (expected
            ? ` (${failed}/${expected} video layer(s) failed to decode within ${Math.round(
                timeout / 1000,
              )}s — raise timeoutMs for very large clips)`
            : "") +
          (fontsFailed
            ? ` (${fontsFailed} web font(s) failed to load within ${Math.round(
                timeout / 1000,
              )}s — the render page couldn't fetch the font; check the machine's network egress to the font CDN, or raise timeoutMs)`
            : ""),
      );
    }

    return await page.locator("canvas").first().screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
};

export interface RenderVideoOptions {
  /** Project id, served at `${origin}/render-export?project=<id>`. */
  projectId: string;
  /** Origin serving /render-export + /api/project + /clips. Default https://morphareels.ai */
  origin?: string;
  /** Bearer token for the Morpha account (forwarded to the project/clip fetches). */
  token?: string;
  /**
   * Browser channel. Defaults to system Chrome ("chrome") so the WebCodecs
   * H.264 encoder is available. Do NOT use "chromium" — it ships without the
   * proprietary codec and the export will fail.
   */
  channel?: string;
  /**
   * Milliseconds to wait for the in-browser encode to finish. Default 600000
   * (10 min). A 30 s 1080×1920 composition encodes in well under a minute on a
   * modern machine; long projects or slow-loading clips need more headroom.
   */
  timeoutMs?: number;
}

/**
 * Render a project's FULL composition to an MP4 Buffer using a REAL local
 * browser — the same in-browser WebCodecs H.264 pipeline the editor's Render
 * button uses (no ffmpeg, no server). Drives the `/render-export` page with the
 * project loaded, waits for the encode to finish, and returns the MP4 bytes.
 * Requires `playwright` installed (optional peer dependency) and Google Chrome
 * available (the default `channel: "chrome"` — Chromium can't encode H.264).
 */
export const renderVideo = async (opts: RenderVideoOptions): Promise<Buffer> => {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error(
      "renderVideo() needs Playwright. Install it: `npm i playwright`, and have Google Chrome available.",
    );
  }
  const origin = opts.origin ?? "https://morphareels.ai";
  const timeout = opts.timeoutMs ?? 600_000;

  const browser = await pw.chromium.launch({
    channel: opts.channel ?? "chrome",
    headless: true,
  });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
    });
    if (opts.token) {
      await ctx.setExtraHTTPHeaders({ Authorization: `Bearer ${opts.token}` });
    }
    const page = await ctx.newPage();
    const url = `${origin}/render-export?project=${encodeURIComponent(opts.projectId)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    try {
      await page.waitForFunction(
        () =>
          (window as unknown as { __morphaExportReady?: boolean })
            .__morphaExportReady === true,
        { timeout },
      );
    } catch {
      throw new Error(
        `Morpha export timed out after ${Math.round(timeout / 1000)}s for project ${opts.projectId} — raise timeoutMs for long projects or large clips.`,
      );
    }

    const status = (await page.evaluate(() => {
      const w = window as unknown as {
        __morphaExportStatus?: string;
        __morphaExportError?: string;
      };
      return { status: w.__morphaExportStatus, error: w.__morphaExportError };
    })) as { status?: string; error?: string };
    if (status.status !== "ok") {
      throw new Error(
        `Morpha export failed for project ${opts.projectId}: ${status.error ?? "export reported not-ok"}`,
      );
    }

    const base64 = (await page.evaluate(
      () =>
        (window as unknown as { __morphaExportBase64?: string })
          .__morphaExportBase64 ?? "",
    )) as string;
    if (!base64) {
      throw new Error(
        `Morpha export produced an empty MP4 for project ${opts.projectId}`,
      );
    }
    return Buffer.from(base64, "base64");
  } finally {
    await browser.close();
  }
};
