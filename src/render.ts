import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { routeMorphaOrigin } from "./browser-auth.ts";

export interface RenderFrameOptions {
  /** Project id, served at `${origin}/api/project/<id>`. */
  projectId: string;
  /** Composition frame (0-indexed, 30 fps). Default 0. */
  frame?: number;
  /** 0-based page index for multi-page projects. Default: the project's
   * active page. Out of range is the caller's error — the render reports it. */
  page?: number;
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
  /**
   * Directory for the persistent Chromium profile that caches THIRD-PARTY
   * assets (web fonts) across calls. Defaults to
   * `<os.tmpdir()>/morpha-render-cache`, with a per-project subdirectory. A
   * warm profile fetches each web font once and serves it from disk on later
   * renders, so repeated renders don't re-fetch (and aren't blocked by a slow
   * font CDN). Morpha's own responses are deliberately never reused from it —
   * a render always reads current project state, images and clips. Set this to
   * relocate or isolate the cache.
   */
  cacheDir?: string;
}

/** `&page=N` query fragment, or "" when no page was asked for. Fail-fast on a
 * non-index value — the headless routes treat out-of-range as caller error,
 * so a fractional or negative index should never reach the wire. */
const pageQuery = (page: number | undefined): string => {
  if (page === undefined) return "";
  if (!Number.isInteger(page) || page < 0) {
    throw new Error(`page must be a 0-based page index, got ${page}`);
  }
  return `&page=${page}`;
};

/** URL for the /render-canvas headless route (one composited frame). */
export const renderCanvasUrl = (
  origin: string,
  projectId: string,
  frame: number,
  page?: number,
): string =>
  `${origin}/render-canvas?project=${encodeURIComponent(projectId)}&frame=${frame}${pageQuery(page)}`;

/** URL for the /render-export headless route (full MP4 encode). */
export const renderExportUrl = (
  origin: string,
  projectId: string,
  page?: number,
): string =>
  `${origin}/render-export?project=${encodeURIComponent(projectId)}${pageQuery(page)}`;

/**
 * Render one composited frame to a PNG Buffer. The video frame is decoded and
 * every overlay (captions/shapes/text) composited by a REAL browser — no
 * ffmpeg. With the default `channel: "chrome"`, HEVC/AV1/H.264 all decode (HEVC
 * needs the OS decoder, i.e. macOS/Windows). Requires `playwright` installed
 * (optional peer dependency) and Google Chrome available on the machine.
 */
export interface RenderFramesOptions extends Omit<RenderFrameOptions, "frame"> {
  /** Composition frames (0-indexed, 30 fps), rendered in the order given. */
  frames: number[];
}

/**
 * Render SEVERAL frames of one project, in one browser, with one project fetch
 * and one clip load.
 *
 * `renderFrame` in a loop pays for a browser launch, a document load, a project
 * fetch, a font load and a full clip download PER FRAME. Here the page loads
 * once and is asked to re-seek, so the second and subsequent frames cost a seek
 * and a repaint.
 *
 * Measured against production, batch first so a warm profile could not flatter
 * the comparison: 5 frames of a 2 MB clip, 8.3s -> 5.5s (1.5x); 10 frames of an
 * 8 MB clip, 18.8s -> 9.9s (1.9x). The seek itself is the floor and both paths
 * pay it, so the saving is the fixed per-frame cost and grows with the number
 * of frames — worth reaching for when sampling a strip, not a reason to batch
 * two.
 *
 * Falls back to a per-frame navigation when the page cannot re-seek — an older
 * deployment that predates `__morphaRenderAt`, or a layer served by an injected
 * frame image, which is one frame by construction. The result is identical
 * either way; only the time differs.
 */
export const renderFrames = async (
  opts: RenderFramesOptions,
): Promise<Buffer[]> => {
  // Before the Playwright import: no frames is no work, and a caller should
  // not need a browser installed to be told so.
  if (opts.frames.length === 0) return [];
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error(
      "renderFrames() needs Playwright. Install it: `npm i playwright`, and have Google Chrome available.",
    );
  }
  const origin = opts.origin ?? "https://morphareels.ai";
  const frames = opts.frames.map((f) => Math.max(0, Math.round(f)));
  const width = Math.max(64, Math.round(opts.width ?? 1080));
  const height = Math.max(64, Math.round(opts.height ?? 1920));
  const timeout = opts.timeoutMs ?? 90_000;
  // Built before the browser launches so an invalid page index fails fast.
  const urls = frames.map((f) => renderCanvasUrl(origin, opts.projectId, f, opts.page));

  const ctx = await launchRenderContext(pw, {
    channel: opts.channel ?? "chrome",
    viewport: { width, height },
    projectId: opts.projectId,
    cacheDir: opts.cacheDir,
  });
  try {
    await routeMorphaOrigin(ctx, origin, opts.token);
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    const shot = (): Promise<Buffer> =>
      page.locator("canvas").first().screenshot({ type: "png" });

    // Load the page for the first frame, then re-seek for the rest.
    const load = async (url: string, frame: number): Promise<void> => {
      // `domcontentloaded`, not `networkidle`: a <video preload="auto">
      // streaming a large non-faststart clip keeps the network busy well past
      // the 500ms idle window, which would block (or time out) goto before the
      // page can paint. The page's structured readiness flag is the real sync
      // point.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      try {
        await page.waitForFunction(
          () => {
            const w = window as unknown as {
              __morphaRenderStatus?: { done?: boolean };
              __morphaRenderReady?: boolean;
            };
            if (w.__morphaRenderStatus) return w.__morphaRenderStatus.done === true;
            return w.__morphaRenderReady === true;
          },
          { timeout },
        );
      } catch {
        throw new Error(
          `Morpha render timed out after ${Math.round(timeout / 1000)}s for project ${opts.projectId} frame ${frame} — the clip may still be loading; raise timeoutMs for very large clips.`,
        );
      }
      assertRenderOk(
        (await page.evaluate(
          () =>
            (window as unknown as { __morphaRenderStatus?: unknown })
              .__morphaRenderStatus ?? null,
        )) as RenderStatus | null,
        opts.projectId,
        frame,
        timeout,
      );
    };

    await load(urls[0], frames[0]);
    const out: Buffer[] = [await shot()];

    for (let i = 1; i < frames.length; i++) {
      const status = (await page.evaluate(
        (f) =>
          (
            window as unknown as {
              __morphaRenderAt?: (n: number) => Promise<unknown>;
            }
          ).__morphaRenderAt?.(f) ?? null,
        frames[i],
      )) as RenderStatus | null;
      if (status === null) {
        // The page cannot re-seek (older build, or an injected frame image).
        // Navigating produces the same pixels, just slower.
        await load(urls[i], frames[i]);
      } else {
        assertRenderOk(status, opts.projectId, frames[i], timeout);
      }
      out.push(await shot());
    }
    return out;
  } finally {
    await ctx.close();
  }
};

/** The structured terminal status the render page publishes. */
type RenderStatus = {
  ok?: boolean;
  error?: string;
  videoLayersExpected?: number;
  videoLayersFailed?: number;
  fontsFailed?: number;
  degradedFonts?: Array<{ family?: string; weight?: number; italic?: boolean }>;
} | null;

// Throw on a frame the page itself says is not trustworthy. `null` is an older
// deployment that only sets the legacy boolean — there we cannot tell black
// from good, so it passes through exactly as it always did (no regression).
const assertRenderOk = (
  status: RenderStatus,
  projectId: string,
  frame: number,
  timeout: number,
): void => {
  if (!status || status.ok !== false) return;
  const expected = status.videoLayersExpected ?? 0;
  const failed = status.videoLayersFailed ?? 0;
  const fontsFailed = status.fontsFailed ?? 0;
  throw new Error(
    `Morpha render incomplete for project ${projectId} frame ${frame}: ` +
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
};

/**
 * Render one composited frame to a PNG Buffer. The video frame is decoded and
 * every overlay (captions/shapes/text) composited by a REAL browser — no
 * ffmpeg. With the default `channel: "chrome"`, HEVC/AV1/H.264 all decode (HEVC
 * needs the OS decoder, i.e. macOS/Windows). Requires `playwright` installed
 * (optional peer dependency) and Google Chrome available on the machine.
 *
 * For several frames of one project use `renderFrames`, which shares the
 * browser AND the clip load across them.
 */
export const renderFrame = async (opts: RenderFrameOptions): Promise<Buffer> => {
  const [png] = await renderFrames({ ...opts, frames: [opts.frame ?? 0] });
  return png;
};

export interface RenderVideoOptions {
  /** Project id, served at `${origin}/render-export?project=<id>`. */
  projectId: string;
  /** 0-based page index for multi-page projects — loop the pages to get one
   * MP4 per page (the editor's "Videos" export card, scripted). Default: the
   * project's active page. Out of range is the caller's error — the render
   * reports it. */
  page?: number;
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
  /**
   * Directory for the persistent Chromium profile (see RenderFrameOptions).
   * Defaults to `<os.tmpdir()>/morpha-render-cache` with a per-project
   * subdirectory, so fonts and clips are cached across exports rather than
   * re-fetched cold on every call.
   */
  cacheDir?: string;
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
  // Built before the browser launches so an invalid page index fails fast.
  const url = renderExportUrl(origin, opts.projectId, opts.page);

  const ctx = await launchRenderContext(pw, {
    channel: opts.channel ?? "chrome",
    viewport: { width: 1080, height: 1920 },
    projectId: opts.projectId,
    cacheDir: opts.cacheDir,
  });
  try {
    // Unconditional — same reason as renderFrame above.
    await routeMorphaOrigin(ctx, origin, opts.token);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
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
    await ctx.close();
  }
};

// Launch a persistent Chromium context so the on-disk HTTP cache is reused
// across renders instead of re-fetched on every call — a cold browser per
// render is why repeated renders of a project kept re-downloading CDN-hosted
// fonts and intermittently failing when that CDN was slow. That third-party
// cache is the whole benefit: Morpha-origin requests are routed (see
// browser-auth.ts) and so deliberately never served from this profile, because
// a project's assets and clips are mutable at a fixed URL and a warm profile
// would paint the previous ones. Keyed per project; if the profile is locked
// (a concurrent render of the same project holds Chromium's SingletonLock) it
// falls back to a private dir so the render still runs — just without the
// shared warm cache.
const launchRenderContext = async (
  pw: typeof import("playwright"),
  opts: {
    channel: string;
    viewport: { width: number; height: number };
    projectId: string;
    cacheDir?: string;
  },
): Promise<import("playwright").BrowserContext> => {
  const base = opts.cacheDir ?? path.join(os.tmpdir(), "morpha-render-cache");
  const profileDir = path.join(
    base,
    opts.projectId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default",
  );
  const launch = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    return pw.chromium.launchPersistentContext(dir, {
      channel: opts.channel,
      headless: true,
      viewport: opts.viewport,
    });
  };
  try {
    return await launch(profileDir);
  } catch {
    return launch(`${profileDir}-${process.pid}-${Date.now()}`);
  }
};
