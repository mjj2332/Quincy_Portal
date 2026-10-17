/**
 * The link's address (#741 12b). A Review link is `/d/review?link=<linkId>#t=<token>`: the link id is not secret and stays in the query, the token is the credential and
 * lives in the fragment, which the browser never sends. `takeLinkToken` reads the token and scrubs the fragment with `history.replaceState` (path and query kept verbatim, because the
 * Worker accepts exactly one `link` parameter), so it is out of the address bar, the history entry and any later copy of the URL before the page makes a request. This is the one
 * place under `guest/` allowed to touch `history`; nothing here navigates.
 *
 * The one thing kept past the scrub is `p`, the Delivery page to return to (#882, D34): it goes to `sessionStorage` under the link id, so an ordinary reload (which arrives with no fragment) still has
 * its Back link. The slug is not a credential for the review (the token is, and is never stored), but it is the address of a page, so it stays in this tab's session rather than in the bar where a copied
 * review URL would carry it. Storage that is missing or throws (a private window, blocked site data) only costs the Back link after a reload.
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

const pageKey = (linkId: string) => `quincy.guest.page.${linkId}`;

/** The stored page for this link, or null when there is none, it is not a Delivery address, or storage is unavailable. */
function storedPage(linkId: string | null): string | null {
  if (linkId === null) return null;
  try {
    const page = window.sessionStorage.getItem(pageKey(linkId));
    return page !== null && SLUG.test(page) ? page : null;
  } catch { return null; }
}

/** A fresh open of the link decides the page: kept when it came with one, forgotten when it did not (an emailed link has no Delivery page to return to). */
function storePage(linkId: string | null, page: string | null): void {
  if (linkId === null) return;
  try {
    if (page === null) window.sessionStorage.removeItem(pageKey(linkId));
    else window.sessionStorage.setItem(pageKey(linkId), page);
  } catch { /* No storage: the Back link lasts until a reload. */ }
}

/**
 * Reads `#t=<token>` (and an optional `&v=<videoId>` and `&p=<pageSlug>`) and removes the whole fragment from the address. The caller keeps them in memory. With no fragment (an ordinary reload) the
 * page to return to comes from this tab's session for the link, as the last fresh open left it.
 */
export function takeLinkToken(): LinkFragment {
  const { hash, pathname, search } = window.location;
  const linkId = readLinkId(search);
  if (hash === "") return { token: null, videoId: null, pageSlug: storedPage(linkId) };
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("t");
  const video = params.get("v");
  const page = params.get("p");
  window.history.replaceState(window.history.state, "", pathname + search);
  const pageSlug = page !== null && SLUG.test(page) ? page : null;
  storePage(linkId, pageSlug);
  return { token: token !== null && token !== "" ? token : null, videoId: video !== null && UUID.test(video) ? video : null, pageSlug };
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
