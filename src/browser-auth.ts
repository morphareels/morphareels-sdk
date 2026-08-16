// How the headless render/process browser talks to the Morpha origin — and
// ONLY the Morpha origin.
//
// Two jobs, one route, because both are properties of "requests to Morpha":
//
// 1. Auth. A context-wide `setExtraHTTPHeaders()` injects `Authorization` into
//    EVERY request the page makes — including cross-origin ones. That leaks the
//    caller's API token to third-party hosts, and it breaks fonts: @font-face
//    glyph fetches are CORS requests, the injected header forces a preflight,
//    and font CDNs don't allow `authorization` — so the render page paints (and
//    its font-readiness gate fails on) a system fallback even though the fonts
//    are perfectly reachable.
//
// 2. Freshness. `renderFrame`/`renderVideo` reuse a PERSISTENT per-project
//    Chromium profile, so its HTTP disk cache outlives a render. Project JSON
//    revalidates on its own, but `/assets/:p/:f` is served `immutable,
//    max-age=3600` and `/clips/:p/:f` `max-age=300` — replace an image or clip
//    under the same filename and a warm profile will paint the OLD bytes,
//    with no request to the server at all, for up to an hour. So every
//    Morpha-origin request is routed (Playwright routing bypasses the HTTP
//    cache) AND carries an explicit `cache-control: no-cache`, which is the
//    part that does not depend on that Playwright behaviour staying true.
//
// Both jobs need the route scoped to exactly one origin: third-party requests
// stay unrouted, so fonts keep their token-free CORS fetch AND stay cached in
// the persistent profile across renders — which is what that profile is for.

/** True only for URLs whose origin equals the configured Morpha origin
 *  (exact scheme + host + port). Exported for unit tests. */
export const originMatcher = (origin: string): ((url: URL) => boolean) => {
  const target = new URL(origin).origin;
  return (url) => url.origin === target;
};

/**
 * Route every request to `origin` (and nothing else) so it authenticates as the
 * caller and is never answered from a stale cache. `token` is optional: a dev
 * origin whose auth is bypassed still needs the freshness half, and a render
 * that silently paints last hour's asset is the same bug whether or not a token
 * was involved.
 */
export const routeMorphaOrigin = async (
  ctx: import("playwright").BrowserContext,
  origin: string,
  token?: string,
): Promise<void> => {
  // route.continue() forwards the request natively (streaming intact) —
  // fetch()+fulfill() would buffer video range responses whole.
  await ctx.route(originMatcher(origin), async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        // Lower-case keys deliberately: `request.headers()` returns them
        // lower-cased, and these are object keys, so a capitalised
        // `Authorization` here would ADD a second entry beside a spread
        // `authorization` rather than replace it.
        // Revalidate rather than reuse: see (2) above.
        "cache-control": "no-cache",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  });
};
