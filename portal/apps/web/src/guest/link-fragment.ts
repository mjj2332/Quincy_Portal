/**
 * The link's address (#741 12b). A Review link is `/d/review?link=<linkId>#t=<token>`: the link id is not secret and stays in the query, the token is the credential and
 * lives in the fragment, which the browser never sends. `takeLinkToken` reads the token and scrubs the fragment with `history.replaceState` (path and query kept verbatim, because the
 * Worker accepts exactly one `link` parameter), so it is out of the address bar, the history entry and any later copy of the URL before the page makes a request. This is the one
 * place under `guest/` allowed to touch `history`; nothing here navigates.
 */
import { DELIVERY_SLUG_PATTERN } from "@quincy/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The link id from `?link=`, or null unless it is the only parameter and a UUID. */
export function readLinkId(search: string = window.location.search): string | null {
  const params = [...new URLSearchParams(search)];
  return params.length === 1 && params[0]![0] === "link" && UUID.test(params[0]![1]) ? params[0]![1] : null;
}

const SLUG = new RegExp(`^${DELIVERY_SLUG_PATTERN}$`);

/** What the fragment carried: the credential, the film to open (a Delivery page's tile, #847), and `pageSlug` (#882, D34): the Delivery page the visitor came from, so Back can return to it. `videoId` is a UUID and `pageSlug` a valid Delivery address, else null. */
export type LinkFragment = { token: string | null; videoId: string | null; pageSlug: string | null };

/** Reads `#t=<token>` (and an optional `&v=<videoId>`) and removes the whole fragment from the address. The caller keeps both in memory. */
export function takeLinkToken(): LinkFragment {
  const { hash, pathname, search } = window.location;
  if (hash === "") return { token: null, videoId: null, pageSlug: null };
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("t");
  const video = params.get("v");
  const page = params.get("p");
  window.history.replaceState(window.history.state, "", pathname + search);
  return { token: token !== null && token !== "" ? token : null, videoId: video !== null && UUID.test(video) ? video : null, pageSlug: page !== null && SLUG.test(page) ? page : null };
}

/**
 * The full reload behind the chunk-failure screen's Reload. `takeLinkToken` already scrubbed the fragment, so a plain `location.reload()` would arrive without the credential. This puts
 * the address back exactly as the visitor opened it (`?link=<id>#t=<token>`) with `history.replaceState`, so no history entry is added, then reloads; the fresh page scrubs it
 * again on boot. (`location.replace` would not do: a URL that differs only in its fragment is a same-document navigation, so nothing reloads and the token is simply back in the bar.) A retry of
 * the dynamic import in place would not do: the browser caches a rejected import by URL, and after a deploy the old hashed chunk is gone for good.
 */
export function reopenWithToken(token: string | null, videoId: string | null = null, pageSlug: string | null = null): void {
  if (token === null) { window.location.reload(); return; }
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}#t=${encodeURIComponent(token)}${videoId !== null ? `&v=${videoId}` : ""}${pageSlug !== null ? `&p=${pageSlug}` : ""}`);
  window.location.reload();
}
