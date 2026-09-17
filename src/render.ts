import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { access, constants, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { routeMorphaOrigin } from "./browser-auth.ts";
import { DEFAULT_EXPORT_SCALE, type ExportScale } from "./core/export-scale.ts";
import type { ExportPageGlobals } from "./core/render-export-protocol.ts";

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

/** Wait until `ready` returns true in the page, for at most `timeoutMs`.
 * Playwright's signature is waitForFunction(fn, arg, options): the options go
 * THIRD. Passed second they are taken as `arg`, silently, and the wait falls
 * back to Playwright's 30-second default. Both SDK waits did that, so every
 * render longer than 30 s failed as a timeout whatever timeoutMs said. Every
 * wait goes through here (test/sdk-wait-timeout.test.ts counts the calls). */
export const waitUntilReady = (
  page: Pick<import("playwright").Page, "waitForFunction">,
  ready: () => boolean,
  timeoutMs: number,
): Promise<unknown> => page.waitForFunction(ready, undefined, { timeout: timeoutMs });

/** URL for the /render-canvas headless route (one composited frame). */
export const renderCanvasUrl = (
  origin: string,
  projectId: string,
  frame: number,
  page?: number,
): string =>
  `${origin}/render-canvas?project=${encodeURIComponent(projectId)}&frame=${frame}${pageQuery(page)}`;

/** URL for the /render-export headless route (full MP4 encode), at `scale`
 * (1× the canvas's own size, 2× double it), asking for the chunked handoff
 * writeExportChunks reads. Fail-fast on any other scale, like pageQuery. */
export const renderExportUrl = (
  origin: string,
  projectId: string,
  page?: number,
  scale: ExportScale = DEFAULT_EXPORT_SCALE,
): string => {
  if (scale !== 1 && scale !== 2) {
    throw new Error(`scale must be 1 or 2, got ${scale}`);
  }
  return `${origin}/render-export?project=${encodeURIComponent(projectId)}${pageQuery(page)}&scale=${scale}&transfer=chunks`;
};

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
 * Measured with the published package against the deployed page: 5 frames of a
 * 2 MB clip, 9.2s -> 3.4s (2.7x); 10 frames, 18.8s -> 4.9s (3.9x). The saving
 * grows with the frame count, because what it removes is the fixed per-frame
 * cost — worth reaching for when sampling a strip, not a reason to batch two.
 *
 * Measure this against a deployment that HAS __morphaRenderAt. Against one that
 * does not, the fallback below quietly turns every frame back into a
 * navigation: the pixels still match, so nothing looks wrong, and the numbers
 * describe the fallback rather than the feature. That is how the first set of
 * figures here came to be understated.
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
        await waitUntilReady(
          page,
          () => {
            const w = window as unknown as {
              __morphaRenderStatus?: { done?: boolean };
              __morphaRenderReady?: boolean;
            };
            if (w.__morphaRenderStatus) return w.__morphaRenderStatus.done === true;
            return w.__morphaRenderReady === true;
          },
          timeout,
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

/** Chunk size for pulling a finished MP4 out of the page. Each chunk crosses
 * page.evaluate as its own base64 string, far under V8's 536,870,888-unit
 * string cap, which one whole-file string hits at 383 MiB of MP4. */
export const EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;

/** Pull `size` bytes through `readChunk(offset, length)`, which returns each
 * chunk as base64, into the file at `path`. Each chunk is written at its own
 * offset as it arrives, so no more than one chunk is ever held, whatever the
 * file's size. The file is built beside `path` and renamed into place once
 * every byte has arrived: a chunk shorter than asked for fails the handoff,
 * and a failed handoff leaves nothing at `path`. */
export const writeExportChunks = async (
  readChunk: (offset: number, length: number) => Promise<string>,
  size: number,
  path: string,
  chunkBytes: number = EXPORT_CHUNK_BYTES,
): Promise<void> => {
  const partial = `${path}.partial`;
  const file = await open(partial, "w");
  try {
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const length = Math.min(chunkBytes, size - offset);
      const piece = Buffer.from(await readChunk(offset, length), "base64");
      if (piece.length !== length) {
        throw new Error(
          `Morpha export handoff returned ${piece.length} bytes at offset ${offset} where ${length} were asked for, of ${size}`,
        );
      }
      for (let written = 0; written < length; ) {
        const { bytesWritten } = await file.write(
          piece,
          written,
          length - written,
          offset + written,
        );
        written += bytesWritten;
      }
    }
    await file.close();
    await rename(partial, path);
  } catch (err) {
    await file.close().catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
    throw err;
  }
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
   * Export quality: 2 (the default) renders at double the canvas size,
   * 2160×3840 for a portrait canvas; 1 renders at the canvas's own size. The
   * same choice as the editor's 1×/2× cards, with the same default.
   */
  scale?: ExportScale;
  /**
   * Browser channel. Defaults to system Chrome ("chrome").
   *
   * "chromium" encodes H.264 too: Morpha's own render container drives Chrome
   * for Testing and measured H.264 available and AAC absent. So the channel is
   * not what decides whether an export works — the PLATFORM is. No browser on
   * Linux carries an AAC encoder, whichever channel it runs, and the export
   * page refuses rather than handing back a silent MP4.
   */
  channel?: string;
  /**
   * Milliseconds to wait for the in-browser encode to finish. Default 600000
   * (10 min). On an Apple M5 Pro a 30 s composition of shapes rendered in 8 s
   * at 2× and 5.6 s at 1×; footage, long projects and slow-loading clips need
   * more headroom.
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

export interface RenderVideoToFileOptions extends RenderVideoOptions {
  /** Where to write the MP4. Its directory must exist. The file appears there
   * only once every byte has arrived; a failed render leaves nothing at it. */
  path: string;
}

/**
 * Render a project's FULL composition to an MP4 Buffer using a REAL local
 * browser — the same in-browser WebCodecs H.264 pipeline the editor's Render
 * button uses (no ffmpeg, no server). Drives the `/render-export` page with the
 * project loaded, waits for the encode to finish, and returns the MP4 bytes.
 * Requires `playwright` installed (optional peer dependency) and a browser
 * available (the default `channel: "chrome"`).
 *
 * The Buffer holds the whole file, so a long render at 2× needs that much
 * memory in this process. `renderVideoToFile` writes the same MP4 to disk
 * instead and never holds it.
 *
 * It must run on macOS or Windows. No browser on Linux ships an AAC audio
 * encoder — measured on both Chrome and Chrome for Testing — and the render
 * page refuses to export without one rather than hand back a silent MP4. An
 * agent that has no browser to drive, or runs on Linux, can have Morpha render
 * it instead: the `render_video` tool renders on Morpha's own container, which
 * encodes the audio with ffmpeg beside the browser. It is a subscriber
 * feature, and `render_status` returns the download link.
 */
export const renderVideo = async (opts: RenderVideoOptions): Promise<Buffer> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "morpha-render-video-"));
  try {
    const { path: file } = await renderVideoToFile({
      ...opts,
      path: path.join(dir, "render.mp4"),
    });
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * Render a project's full composition to an MP4 file at `opts.path`, the same
 * render as `renderVideo`. The file comes out of the browser in 8 MiB pieces,
 * each written to disk as it arrives, so this process never holds more than
 * one piece, however long the video. Returns the path and the file's size.
 */
export const renderVideoToFile = async (
  opts: RenderVideoToFileOptions,
): Promise<{ path: string; bytes: number }> => {
  // Before the browser launches, so a render that would have nowhere to go
  // fails now rather than after the encode.
  try {
    await access(path.dirname(opts.path), constants.W_OK);
  } catch {
    throw new Error(
      `renderVideoToFile can't write to ${path.dirname(opts.path)}: the directory must exist and be writable`,
    );
  }
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error(
      "renderVideo() and renderVideoToFile() need Playwright. Install it: `npm i playwright`, and have Google Chrome available.",
    );
  }
  const origin = opts.origin ?? "https://morphareels.ai";
  const timeout = opts.timeoutMs ?? 600_000;
  const scale = opts.scale ?? DEFAULT_EXPORT_SCALE;
  // Built before the browser launches so an invalid page index or scale fails
  // fast.
  const url = renderExportUrl(origin, opts.projectId, opts.page, scale);

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
    // A crash surfaces in the wait below as a generic Playwright error, and
    // reporting it as a timeout sent people to raise timeoutMs, which can't
    // help. The page writes the MP4 to disk as it encodes and mixes the sound
    // a second at a time, so what runs it out of memory is the frames: 2× and
    // many large clips on screen at once.
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    try {
      await waitUntilReady(
        page,
        () =>
          (window as unknown as ExportPageGlobals).__morphaExportReady === true,
        timeout,
      );
    } catch (err) {
      if (crashed) {
        throw new Error(
          `The render page crashed while exporting project ${opts.projectId}. That is usually the browser running out of memory, which frames at 2× make likelier. Try { scale: 1 }.`,
        );
      }
      if (err instanceof pw.errors.TimeoutError) {
        throw new Error(
          `Morpha export timed out after ${Math.round(timeout / 1000)}s for project ${opts.projectId}. Raise timeoutMs for long projects or large clips.`,
        );
      }
      throw new Error(
        `Morpha export failed for project ${opts.projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const status = (await page.evaluate(() => {
      const w = window as unknown as ExportPageGlobals;
      return { status: w.__morphaExportStatus, error: w.__morphaExportError };
    })) as { status?: string; error?: string };
    if (status.status !== "ok") {
      throw new Error(
        `Morpha export failed for project ${opts.projectId}: ${status.error ?? "export reported not-ok"}`,
      );
    }

    const handoff = (await page.evaluate(() => {
      const w = window as unknown as ExportPageGlobals;
      return {
        scale: w.__morphaExportScale,
        size: w.__morphaExportSize,
        chunked: typeof w.__morphaExportChunk === "function",
      };
    })) as { scale?: number; size?: number; chunked: boolean };
    if (!handoff.chunked || typeof handoff.size !== "number") {
      throw new Error(
        `The Morpha deployment at ${origin} predates renderVideo's scale option (morphareels-sdk 0.8), so it can't hand the MP4 over in chunks. Retry once it's updated, or pin morphareels-sdk@0.7 for it.`,
      );
    }
    if (handoff.scale !== scale) {
      throw new Error(
        `Morpha export for project ${opts.projectId} rendered at ${handoff.scale}× where ${scale}× was asked for`,
      );
    }
    if (handoff.size === 0) {
      throw new Error(
        `Morpha export produced an empty MP4 for project ${opts.projectId}`,
      );
    }
    await writeExportChunks(
      (offset, length) =>
        page.evaluate(
          ([o, n]) =>
            (
              window as unknown as Required<
                Pick<ExportPageGlobals, "__morphaExportChunk">
              >
            ).__morphaExportChunk(o, n),
          [offset, length] as [number, number],
        ),
      handoff.size,
      opts.path,
    );
    return { path: opts.path, bytes: (await stat(opts.path)).size };
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
