/**
 * The link's address (#741 12b). A Review link is `/d/review?link=<linkId>#t=<token>`: the link id is not secret and stays in the query, the token is the credential and
 * lives in the fragment, which the browser never sends. `takeLinkToken` reads the token and scrubs the fragment with `history.replaceState` (path and query kept verbatim, because the
 * Worker accepts exactly one `link` parameter), so it is out of the address bar, the history entry and any later copy of the URL before the page makes a request. This is the one
 * place under `guest/` allowed to touch `history`; nothing here navigates.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The link id from `?link=`, or null unless it is the only parameter and a UUID. */
export function readLinkId(search: string = window.location.search): string | null {
  const params = [...new URLSearchParams(search)];
  return params.length === 1 && params[0]![0] === "link" && UUID.test(params[0]![1]) ? params[0]![1] : null;
}

/** Reads `#t=<token>` and removes the whole fragment from the address. Returns the token (kept in memory by the caller), or null when there was none. */
export function takeLinkToken(): string | null {
  const { hash, pathname, search } = window.location;
  if (hash === "") return null;
  const token = new URLSearchParams(hash.slice(1)).get("t");
  window.history.replaceState(window.history.state, "", pathname + search);
  return token !== null && token !== "" ? token : null;
}

/**
 * The full reload behind the chunk-failure screen's Reload. `takeLinkToken` already scrubbed the fragment, so a plain `location.reload()` would arrive without the credential. This puts
 * the address back exactly as the visitor opened it (`?link=<id>#t=<token>`) with `history.replaceState`, so no history entry is added, then reloads; the fresh page scrubs it
 * again on boot. (`location.replace` would not do: a URL that differs only in its fragment is a same-document navigation, so nothing reloads and the token is simply back in the bar.) A retry of
 * the dynamic import in place would not do: the browser caches a rejected import by URL, and after a deploy the old hashed chunk is gone for good.
 */
export function reopenWithToken(token: string | null): void {
  if (token === null) { window.location.reload(); return; }
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}#t=${encodeURIComponent(token)}`);
  window.location.reload();
}
