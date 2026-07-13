// Attach the account bearer token to SAME-ORIGIN requests only.
//
// A context-wide `setExtraHTTPHeaders()` injects `Authorization` into EVERY
// request the page makes — including cross-origin ones. That leaks the
// caller's API token to third-party hosts, and it breaks fonts: @font-face
// glyph fetches are CORS requests, the injected header forces a preflight,
// and font CDNs don't allow `authorization` — so the render page paints (and
// its font-readiness gate fails on) a system fallback even though the fonts
// are perfectly reachable. Routing only the Morpha origin keeps auth on the
// page/API/asset fetches that need it and leaves third-party requests
// untouched (also preserving the persistent profile's HTTP cache for them,
// since unrouted requests bypass interception).

/** True only for URLs whose origin equals the configured Morpha origin
 *  (exact scheme + host + port). Exported for unit tests. */
export const originMatcher = (origin: string): ((url: URL) => boolean) => {
  const target = new URL(origin).origin;
  return (url) => url.origin === target;
};

export const scopeAuthHeaderToOrigin = async (
  ctx: import("playwright").BrowserContext,
  origin: string,
  token: string,
): Promise<void> => {
  // route.continue() forwards the request natively (streaming intact) —
  // fetch()+fulfill() would buffer video range responses whole.
  await ctx.route(originMatcher(origin), async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        Authorization: `Bearer ${token}`,
      },
    });
  });
};
