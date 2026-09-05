/**
 * Resolve public asset paths against the deploy base.
 *
 * GitHub Pages serves a project site from a subpath — `/RTSVR/` — so a URL
 * fetched at runtime cannot carry a leading slash. Vite rewrites the URLs it
 * emits itself, but it never touches string literals inside the code, and this
 * game asks for a hundred assets by literal path. Measured before the fix: the
 * page and bundle returned 200 under a `/RTSVR/` prefix while every
 * `/gltf/...` and `/images/...` returned 404.
 *
 * Vite exposes the deploy base as `import.meta.env.BASE_URL`. With this
 * project's `base: "./"` that compiles to the string `"./"`, so `assetUrl`
 * produces `./gltf/x.glb` — resolved against the document, and therefore
 * correct at a subpath and at the root. Under `base: "/"` it produces
 * `/gltf/x.glb`, exactly what the literals said before.
 *
 * Same shape as `vr_examples/brushspace/src/app/asset-url.ts`, the one example
 * in that collection that actually ships to Pages.
 */

/**
 * The deploy base with any trailing slash removed, so callers can concatenate a
 * leading-slash path without producing a double slash.
 *
 * The `env?.` guard is not defensive noise: the node test runner has no
 * `import.meta.env` at all, and without the fallback every catalog that calls
 * `assetUrl` at module load would throw on import. Under node this resolves to
 * `""`, which returns each path unchanged — so tests see exactly the strings
 * they saw before this file existed.
 */
const BASE_URL = (
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ??
  "/"
).replace(/\/$/, "");

/** Resolve a root-relative public asset path against the deploy base. */
export function assetUrl(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The inverse: recover the leading-slash path from a URL {@link assetUrl} made.
 *
 * For the places that key a lookup table on the logical path rather than the
 * fetched URL — `tabletThumbnails.ts` keys its aspect table this way, and its
 * test reads `public/<key>` off disk, so the keys have to stay filesystem
 * paths. Without this the table would silently miss every lookup on a subpath
 * deploy and every thumbnail would fall back to a square box: a visual
 * regression with no error attached to it.
 */
export function assetKey(url: string): string {
  return BASE_URL !== "" && url.startsWith(BASE_URL)
    ? url.slice(BASE_URL.length)
    : url;
}
