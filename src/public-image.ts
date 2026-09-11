// Public image search from Node, the SDK's half of `findPublicImage`. The
// Openverse request runs on the caller's machine, so the anonymous quota it
// spends is the caller's, exactly as `renderVideo` spends the caller's Chrome.
// The pick is then stored through the hosted `upload_image` tool, which fetches
// the file with Morpha's User-Agent (Wikimedia refuses a blank one) and
// returns the stored filename.
import {
  openverseResults,
  openverseSearchUrl,
  pickPublicImage,
  searchDeadline,
  searchTimedOutMessage,
  type PublicImageLicenseType,
  type PublicImagePick,
} from "./core/public-image.ts";

export interface FindPublicImageOptions {
  /** "all-cc" (default), "commercial" (no NC licences), or "cc0". */
  licenseType?: PublicImageLicenseType;
  /** Floor on the longer side in px; default 800. */
  minDimension?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** The SDK identifies itself to Openverse, as its policy asks of tools. */
export const SDK_USER_AGENT = "morphareels-sdk (+https://morphareels.ai)";

/**
 * Search Openverse for `query` and return the first downloadable, large-enough
 * result shaped for `upload_image`, or null when the first page has none.
 * Throws when Openverse does not answer 200, or does not answer within
 * PUBLIC_IMAGE_SEARCH_TIMEOUT_MS: its search backend has been seen answering
 * 504 after a full minute, and a caller should learn that in seconds rather
 * than get an empty result late.
 */
export const searchPublicImage = async (
  query: string,
  options: FindPublicImageOptions = {},
): Promise<PublicImagePick | null> => {
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(openverseSearchUrl(query, options.licenseType), {
      headers: { accept: "application/json", "user-agent": SDK_USER_AGENT },
      signal: searchDeadline(),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(searchTimedOutMessage());
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`public image search is unavailable (Openverse answered ${res.status})`);
  }
  return pickPublicImage(openverseResults(await res.json()), query, {
    minDimension: options.minDimension,
  });
};
