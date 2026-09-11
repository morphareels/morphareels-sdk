// Public image search, the pure half: the Openverse query, the pick among its
// results, the stored filename and the attribution. No I/O here. Two callers
// run the request on the USER'S side and then hand the chosen URL to
// `upload_image`, which fetches and stores it: the editor's prompt dock (in
// the browser, `editor/src/api.ts`) and the npm SDK (in Node,
// `sdk/src/public-image.ts`).
//
// It used to run in the Worker as `find_public_image` on the MCP and HTTP
// catalog. That put every Morpha user behind one shared Cloudflare egress and
// therefore one anonymous Openverse quota, and it asked for 24 results where
// anonymous callers are capped at 20, so every search answered 401 from the
// day it shipped. The connector surfaces (Claude.ai, ChatGPT, Gemini) have no
// client-side runtime, so they have no search tool: a chat agent finds a
// direct image URL with its own web search and passes it to `upload_image`.

/** Openverse's cap on results per page for a caller with no token. */
export const OPENVERSE_ANONYMOUS_PAGE_SIZE = 20;

/**
 * How long a search may wait. Openverse's search backend has answered 504
 * after a full minute; a person at the prompt dock, or a script, should learn
 * that in seconds rather than sit through it. Shared by the browser and the
 * Node caller so the two cannot disagree on what "unavailable" means.
 */
export const PUBLIC_IMAGE_SEARCH_TIMEOUT_MS = 15_000;

/** A signal that ends at the timeout or when the caller's own signal does. */
export const searchDeadline = (signal?: AbortSignal): AbortSignal =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(PUBLIC_IMAGE_SEARCH_TIMEOUT_MS)])
    : AbortSignal.timeout(PUBLIC_IMAGE_SEARCH_TIMEOUT_MS);

/** The message for a search that hit the deadline rather than the caller's abort. */
export const searchTimedOutMessage = (): string =>
  `public image search timed out (Openverse did not answer within ${
    PUBLIC_IMAGE_SEARCH_TIMEOUT_MS / 1000
  } s)`;

export const OPENVERSE_IMAGES_URL = "https://api.openverse.org/v1/images/";

export type PublicImageLicenseType = "all-cc" | "commercial" | "cc0";

export const normalizeLicenseType = (raw: unknown): PublicImageLicenseType =>
  raw === "cc0" || raw === "commercial" || raw === "all-cc" ? raw : "all-cc";

/** Search URL for `query`, within the anonymous page-size cap. */
export const openverseSearchUrl = (
  query: string,
  licenseType: PublicImageLicenseType = "all-cc",
): string => {
  const url = new URL(OPENVERSE_IMAGES_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(OPENVERSE_ANONYMOUS_PAGE_SIZE));
  url.searchParams.set("license_type", licenseType);
  return url.toString();
};

// Hosts whose files are directly downloadable without auth and served from a
// stable CDN. Anything else Openverse indexes tends to redirect to a page,
// block hot-linking, or answer HTML instead of bytes.
export const PUBLIC_IMAGE_HOSTS = [
  "live.staticflickr.com",
  "upload.wikimedia.org",
  "pd.w.org",
  "images.rawpixel.com",
  "commons.wikimedia.org",
] as const;

export const isDownloadablePublicImage = (url: string): boolean => {
  try {
    return (PUBLIC_IMAGE_HOSTS as readonly string[]).includes(new URL(url).host);
  } catch {
    return false;
  }
};

/** The fields of an Openverse result this module reads. */
export interface OpenverseResult {
  id?: string;
  title?: string;
  url?: string;
  width?: number;
  height?: number;
  license?: string;
  license_version?: string;
  creator?: string;
  creator_url?: string;
  foreign_landing_url?: string;
}

export interface PublicImageAttribution {
  creator: string | null;
  creator_url: string | null;
  title: string | null;
  license: string | null;
  license_version: string | null;
  source_url: string;
}

export interface PublicImagePick {
  /** Direct file URL, to pass to `upload_image`. */
  url: string;
  /** Stored filename to pass alongside it, `cc-<query>-<suffix>.<ext>`. */
  filename: string;
  attribution: PublicImageAttribution;
  dimensions: { width: number | null; height: number | null };
}

/** Default floor on the longer side, so the layer holds up at canvas size. */
export const DEFAULT_MIN_DIMENSION = 800;

const slugify = (s: string, fallback: string): string => {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 40) : fallback;
};

const extensionOf = (url: string): string => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return ".jpg";
    if (path.endsWith(".png")) return ".png";
    if (path.endsWith(".webp")) return ".webp";
    if (path.endsWith(".gif")) return ".gif";
  } catch {
    /* fall through */
  }
  return ".jpg";
};

/**
 * The first result that is downloadable and large enough, shaped for
 * `upload_image`. `suffix` keeps two searches for the same words from
 * overwriting each other's file (`upload_image` overwrites by name).
 */
export const pickPublicImage = (
  results: OpenverseResult[],
  query: string,
  options: { minDimension?: number; suffix?: string } = {},
): PublicImagePick | null => {
  const minDim =
    typeof options.minDimension === "number" && options.minDimension > 0
      ? Math.round(options.minDimension)
      : DEFAULT_MIN_DIMENSION;
  const picked = results.find(
    (r) =>
      typeof r.url === "string" &&
      isDownloadablePublicImage(r.url) &&
      Math.max(r.width ?? 0, r.height ?? 0) >= minDim,
  );
  if (!picked || typeof picked.url !== "string") return null;
  const suffix = options.suffix ?? Math.random().toString(36).slice(2, 8);
  return {
    url: picked.url,
    filename: `cc-${slugify(query, "image")}-${suffix}${extensionOf(picked.url)}`,
    attribution: {
      creator: picked.creator ?? null,
      creator_url: picked.creator_url ?? null,
      title: picked.title ?? null,
      license: picked.license ?? null,
      license_version: picked.license_version ?? null,
      source_url: picked.foreign_landing_url ?? picked.url,
    },
    dimensions: { width: picked.width ?? null, height: picked.height ?? null },
  };
};

/** What an Openverse answer must look like to be read; anything else is a refusal. */
export const openverseResults = (body: unknown): OpenverseResult[] => {
  if (typeof body !== "object" || body === null) return [];
  const results = (body as { results?: unknown }).results;
  return Array.isArray(results) ? (results as OpenverseResult[]) : [];
};
