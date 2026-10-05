import { decodeHTMLAttribute } from "entities";
import {
  LINK_PREVIEW_DESCRIPTION_MAX, LINK_PREVIEW_MAX_HTML_BYTES, LINK_PREVIEW_MAX_IMAGE_BYTES, LINK_PREVIEW_MAX_REDIRECTS, LINK_PREVIEW_SITE_NAME_MAX, LINK_PREVIEW_TIMEOUT_MS,
  LINK_PREVIEW_TITLE_MAX, checkPreviewTarget, normalizePreviewText, sniffEmbeddedImageType, type EmbeddedImageContentType,
} from "@quincy/shared";

/**
 * Fetches the page behind a link and reads the card a post shows for it (#497). It runs in the background Worker because that
 * Worker's `global_fetch_strictly_public` flag stops a deployed fetch reaching a private network. Locally there is no such flag, so every
 * address (the first, each redirect hop, the image) goes through `checkPreviewTarget` before it is fetched. The image comes back as
 * bytes: a Workers RPC payload may be 32 MiB and the image is at most 5 MiB.
 */
export type LinkPreviewFetchResult =
  | { ok: true; finalUrl: string; title: string | null; description: string | null; siteName: string | null; image: { bytes: Uint8Array; contentType: EmbeddedImageContentType } | null }
  | { ok: false; reason: "blocked" | "timeout" | "fetch_failed" | "http_status" | "not_html" | "too_many_redirects" | "bad_redirect" | "no_preview" };
export type LinkPreviewFetchDeps = { fetch: typeof fetch; timeoutMs?: number; blockedHosts?: readonly string[] };

type Failure = Extract<LinkPreviewFetchResult, { ok: false }>["reason"];
class Stop extends Error { constructor(readonly reason: Failure) { super(reason); } }

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADERS = { "user-agent": "QuincyPortalLinkPreview/1.0 (+https://quincy.flamingfire.my)" };

/** Rejects when `signal` aborts, whether or not the underlying work notices. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => undefined); return Promise.reject(new Stop("timeout")); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Stop("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** Runs `work` under one deadline that covers every await inside it. */
async function withDeadline<T>(timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await work(controller.signal); } finally { clearTimeout(timer); }
}

const discard = (response: Response) => { void response.body?.cancel().catch(() => undefined); };

/** Fetches `start`, following up to three redirects by hand and checking every hop. */
async function follow(start: string, accept: string, signal: AbortSignal, deps: LinkPreviewFetchDeps): Promise<{ response: Response; finalUrl: string }> {
  let current = start;
  for (let hop = 0; ; hop += 1) {
    const verdict = checkPreviewTarget(current, { blockedHosts: deps.blockedHosts });
    if (!verdict.ok) throw new Stop("blocked");
    let response: Response;
    try { response = await abortable(deps.fetch(verdict.fetchUrl, { redirect: "manual", signal, headers: { ...HEADERS, accept } }), signal); }
    catch (error) { throw error instanceof Stop ? error : new Stop(signal.aborted ? "timeout" : "fetch_failed"); }
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: verdict.fetchUrl };
    const location = response.headers.get("location");
    discard(response);
    if (!location) throw new Stop("bad_redirect");
    if (hop >= LINK_PREVIEW_MAX_REDIRECTS) throw new Stop("too_many_redirects");
    try { current = new URL(location, verdict.fetchUrl).href; } catch { throw new Stop("bad_redirect"); }
  }
}

/** Reads a body through a counting stream. At `max` bytes it stops and cancels: `truncated` says the body went on. */
async function readLimited(response: Response, max: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > max) break;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error instanceof Stop ? error : new Stop(signal.aborted ? "timeout" : "fetch_failed");
  }
  const truncated = total > max;
  if (truncated) void reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset);
    if (take <= 0) break;
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { bytes, truncated };
}

/** Decodes the HTML entities a page may leave in a tag's value (every named one, and numeric ones), as a browser reads an attribute. HTMLRewriter hands values back as written. */
const decodeEntities = (value: string): string => decodeHTMLAttribute(value);

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try { return new TextDecoder(label).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

type Page = { meta: Map<string, string>; title: string | null };

async function parsePage(source: string): Promise<Page> {
  const meta = new Map<string, string>();
  let title = "";
  let titleDone = false;
  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(element) {
        const content = element.getAttribute("content");
        if (content === null) return;
        for (const attribute of ["property", "name"]) {
          const key = element.getAttribute(attribute)?.trim().toLowerCase();
          if (key && !meta.has(key)) meta.set(key, content);
        }
      },
    })
    .on("title", { text(chunk) { if (titleDone) return; title += chunk.text; if (chunk.lastInTextNode) titleDone = true; } });
  await rewriter.transform(new Response(source)).arrayBuffer();
  return { meta, title: titleDone || title ? title : null };
}

async function fetchImage(imageUrl: string, deps: LinkPreviewFetchDeps): Promise<{ bytes: Uint8Array; contentType: EmbeddedImageContentType } | null> {
  try {
    return await withDeadline(deps.timeoutMs ?? LINK_PREVIEW_TIMEOUT_MS, async (signal) => {
      const { response } = await follow(imageUrl, "image/jpeg,image/png,image/webp;q=0.9,image/*;q=0.5", signal, deps);
      if (response.status < 200 || response.status > 299) { discard(response); return null; }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > LINK_PREVIEW_MAX_IMAGE_BYTES) { discard(response); return null; }
      const { bytes, truncated } = await readLimited(response, LINK_PREVIEW_MAX_IMAGE_BYTES, signal);
      if (truncated) return null;
      // The bytes decide, never the declared type. GIF and everything else outside JPEG, PNG and WebP has no image.
      const contentType = sniffEmbeddedImageType(bytes);
      return contentType ? { bytes, contentType } : null;
    });
  } catch { return null; }
}

export async function fetchLinkPreview(url: string, deps: LinkPreviewFetchDeps): Promise<LinkPreviewFetchResult> {
  const timeoutMs = deps.timeoutMs ?? LINK_PREVIEW_TIMEOUT_MS;
  let finalUrl: string;
  let page: Page;
  try {
    ({ finalUrl, page } = await withDeadline(timeoutMs, async (signal) => {
      const fetched = await follow(url, "text/html,application/xhtml+xml;q=0.9", signal, deps);
      const { response } = fetched;
      if (response.status < 200 || response.status > 299) { discard(response); throw new Stop("http_status"); }
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) { discard(response); throw new Stop("not_html"); }
      const { bytes } = await readLimited(response, LINK_PREVIEW_MAX_HTML_BYTES, signal);
      return { finalUrl: fetched.finalUrl, page: await parsePage(decodeBody(bytes, contentType)) };
    }));
  } catch (error) { return { ok: false, reason: error instanceof Stop ? error.reason : "fetch_failed" }; }

  const pick = (...keys: string[]) => keys.map((key) => page.meta.get(key)).find((value) => value !== undefined && normalizePreviewText(decodeEntities(value), 1) !== null);
  const text = (value: string | null | undefined, max: number) => normalizePreviewText(value === null || value === undefined ? null : decodeEntities(value), max);
  const title = text(pick("og:title", "twitter:title") ?? page.title, LINK_PREVIEW_TITLE_MAX);
  const description = text(pick("og:description", "twitter:description", "description"), LINK_PREVIEW_DESCRIPTION_MAX);
  if (!title && !description) return { ok: false, reason: "no_preview" };
  const siteName = text(pick("og:site_name") ?? new URL(finalUrl).hostname.replace(/^www\./, ""), LINK_PREVIEW_SITE_NAME_MAX);

  const imageSource = pick("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src");
  let image: Awaited<ReturnType<typeof fetchImage>> = null;
  if (imageSource) {
    let resolved: string | null = null;
    try { resolved = new URL(decodeEntities(imageSource).trim(), finalUrl).href; } catch { /* a link that is not an address has no image */ }
    if (resolved) image = await fetchImage(resolved, deps);
  }
  return { ok: true, finalUrl, title, description, siteName, image };
}
