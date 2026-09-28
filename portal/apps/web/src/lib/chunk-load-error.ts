/**
 * #292: recognises the rejection a lazy `import()` produces when its hashed chunk no longer
 * exists (a deploy or rollback replaced it, and the asset layer's SPA fallback answered with
 * `200 text/html`). Each engine words it differently; match on the stable prefix only, since
 * every one appends the failing URL.
 */
const CHUNK_LOAD_MESSAGES = [
  // Chromium (Chrome, Edge).
  "Failed to fetch dynamically imported module",
  // Safari / WebKit.
  "Importing a module script failed",
  // Firefox / Gecko.
  "error loading dynamically imported module",
  // Vite's own dependency preloader, when a chunk's CSS is gone.
  "Unable to preload CSS",
] as const;

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return CHUNK_LOAD_MESSAGES.some((fragment) => message.includes(fragment));
}
