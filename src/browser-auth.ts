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
//    and `/assets/:p/:f` revalidate on their own (`private, no-cache`), but
//    `/clips/:p/:f` is served `private, max-age=300` — replace a clip under
//    the same filename and a warm profile will paint the OLD bytes, with no
//    request to the server at all, for up to five minutes. So every
//    Morpha-origin request is routed (Playwright routing bypasses the HTTP
//    cache) AND carries an explicit `cache-control: no-cache`, which is the
//    part that does not depend on that Playwright behaviour staying true.
//
// Both jobs need the route scoped to exactly one origin: third-party requests
// stay unrouted, so fonts keep their token-free CORS fetch AND stay cached in
// the persistent profile across renders — which is what that profile is for.

/**
 * What this needs of a browser context: the ability to route requests.
 *
 * Structural on purpose. Morpha's render container drives Chrome from its own
 * Playwright install while this file lives in the SDK, which has another, and
 * TypeScript treats two installs' `BrowserContext` as different types even at
 * the same version. Naming the capability instead of the package lets one
 * implementation serve both.
 */
export interface RoutableContext {
  route(
    url: (url: URL) => boolean,
    handler: (route: {
      request(): { headers(): Record<string, string> };
      continue(options: { headers: Record<string, string> }): Promise<void>;
    }) => Promise<void>,
    // Playwright's own route() resolves to a Disposable, so the result is
    // deliberately unconstrained: this says nothing about what it returns.
  ): Promise<unknown>;
}

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
 *
 * `headers` is for a caller that authenticates some other way: Morpha's render
 * container sends a render pass instead of a token (render-container/server.ts).
 * It goes through here rather than a second route of its own, so there stays one
 * place deciding what a Morpha-origin request carries.
 */
export const routeMorphaOrigin = async (
  ctx: RoutableContext,
  origin: string,
  token?: string,
  headers?: Record<string, string>,
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
        ...(headers ?? {}),
      },
    });
  });
};
