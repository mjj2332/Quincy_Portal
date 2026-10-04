import { describe, expect, it } from "vitest";
import { fetchLinkPreview, type LinkPreviewFetchDeps } from "../src/link-preview-fetch";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const MiB = 1024 * 1024;

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
/** A stub fetch that records every URL it was asked for, and answers from `routes` (by exact URL) or `fallback`. */
function stub(routes: Record<string, Handler | Response>, fallback?: Handler) {
  const calls: string[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (route instanceof Response) return route;
    if (route) return route(url, init);
    if (fallback) return fallback(url, init);
    return new Response("not found", { status: 404 });
  };
  return { calls, deps: { fetch: fetchStub, timeoutMs: 80 } satisfies LinkPreviewFetchDeps };
}
const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const page = (head: string) => `<!doctype html><html><head>${head}</head><body><p>hi</p></body></html>`;
const png = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
/** A response whose body never ends until it is cancelled. */
function endless(prefix: string, headers: Record<string, string> = { "content-type": "text/html" }) {
  const state = { sent: 0, cancelled: false };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { const first = encoder.encode(prefix); state.sent += first.length; controller.enqueue(first); },
    pull(controller) { const chunk = new Uint8Array(64 * 1024).fill(0x20); state.sent += chunk.length; controller.enqueue(chunk); },
    cancel() { state.cancelled = true; },
  });
  return { state, response: new Response(body, { status: 200, headers }) };
}

describe("fetchLinkPreview: what it reads", () => {
  it("reads Open Graph tags, decodes entities, resolves a relative image and copies the image bytes", async () => {
    const { deps, calls } = stub({
      "https://example.com/post": html(page(`
        <title>Plain title</title>
        <meta property="og:title" content="Fish &amp; Chips &#8212; &quot;best&quot; &#x26; more">
        <meta property="og:description" content="A &lt;great&gt; place">
        <meta property="og:site_name" content="Example &amp; Co">
        <meta property="og:image" content="/img/cover.png">`)),
      "https://example.com/img/cover.png": png(),
    });
    const result = await fetchLinkPreview("https://example.com/post", deps);
    expect(result).toMatchObject({ ok: true, finalUrl: "https://example.com/post", title: "Fish & Chips — \"best\" & more", description: "A <great> place", siteName: "Example & Co" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.image?.contentType).toBe("image/png");
    expect([...result.image!.bytes]).toEqual([...PNG]);
    expect(calls).toEqual(["https://example.com/post", "https://example.com/img/cover.png"]);
  });

  it("falls back from Open Graph to Twitter card tags, then to the title and meta description, then to the host", async () => {
    const twitter = stub({ "https://example.com/a": html(page(`<meta name="twitter:title" content="Tw title"><meta name="twitter:description" content="Tw desc"><meta name="twitter:image" content="https://cdn.example.com/t.png">`)), "https://cdn.example.com/t.png": png() });
    expect(await fetchLinkPreview("https://example.com/a", twitter.deps)).toMatchObject({ ok: true, title: "Tw title", description: "Tw desc", siteName: "example.com", image: { contentType: "image/png" } });
    const plain = stub({ "https://www.example.com/b": html(page(`<title>  Only   a\n title </title><meta name="description" content="Meta desc">`)) });
    expect(await fetchLinkPreview("https://www.example.com/b", plain.deps)).toMatchObject({ ok: true, title: "Only a title", description: "Meta desc", siteName: "example.com", image: null });
  });

  it("prefers og:image over og:image:secure_url over twitter:image, and caps the text lengths", async () => {
    const { deps, calls } = stub({
      "https://example.com/c": html(page(`<meta property="og:title" content="${"T".repeat(400)}"><meta property="og:description" content="${"D".repeat(700)}"><meta name="twitter:image" content="https://example.com/third.png"><meta property="og:image:secure_url" content="https://example.com/second.png"><meta property="og:image" content="https://example.com/first.png">`)),
      "https://example.com/first.png": png(),
    });
    const result = await fetchLinkPreview("https://example.com/c", deps);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.title).toHaveLength(300);
    expect(result.description).toHaveLength(500);
    expect(calls).toEqual(["https://example.com/c", "https://example.com/first.png"]);
  });

  it("ignores a meta tag it cannot read and a page with nothing to preview is a failure", async () => {
    expect(await fetchLinkPreview("https://example.com/empty", stub({ "https://example.com/empty": html("<html><body>nothing</body></html>") }).deps)).toMatchObject({ ok: false, reason: "no_preview" });
  });

  it("refuses a non-2xx page", async () => {
    expect(await fetchLinkPreview("https://example.com/x", stub({ "https://example.com/x": new Response("no", { status: 500, headers: { "content-type": "text/html" } }) }).deps)).toMatchObject({ ok: false, reason: "http_status" });
  });
});

describe("fetchLinkPreview: what it refuses to read", () => {
  it("never fetches a blocked address", async () => {
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://localhost/", "ftp://example.com/", "https://user:pw@example.com/", "http://example.com:8080/", "https://quincy.flamingfire.my/x"]) {
      const { deps, calls } = stub({}, () => html(page(`<title>x</title>`)));
      expect(await fetchLinkPreview(url, { ...deps, blockedHosts: ["quincy.flamingfire.my"] }), url).toMatchObject({ ok: false, reason: "blocked" });
      expect(calls, url).toEqual([]);
    }
  });

  it("gives up on a page that never answers, and on one that stops mid-body, within the deadline", async () => {
    const hang = stub({ "https://example.com/hang": (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
    expect(await fetchLinkPreview("https://example.com/hang", hang.deps)).toMatchObject({ ok: false, reason: "timeout" });
    const stall = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("<html><head>")); } });
    const mid = stub({ "https://example.com/mid": new Response(stall, { headers: { "content-type": "text/html" } }) });
    expect(await fetchLinkPreview("https://example.com/mid", mid.deps)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("refuses a page that is not HTML without reading its body", async () => {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { state.cancelled = true; } });
    const { deps } = stub({ "https://example.com/f.pdf": new Response(body, { headers: { "content-type": "application/pdf" } }) });
    expect(await fetchLinkPreview("https://example.com/f.pdf", deps)).toMatchObject({ ok: false, reason: "not_html" });
    expect(state.cancelled).toBe(true);
  });

  it("reads at most the first megabyte of a page that never ends, and still uses the tags it found", async () => {
    const stream = endless(`<html><head><meta property="og:title" content="Early title"></head><body>`);
    const { deps } = stub({ "https://example.com/big": stream.response });
    const result = await fetchLinkPreview("https://example.com/big", { ...deps, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, title: "Early title" });
    expect(stream.state.cancelled).toBe(true);
    expect(stream.state.sent).toBeLessThanOrEqual(MiB + 128 * 1024);
  });

  it("does not use a tag that sits after the first megabyte", async () => {
    const late = `<html><head><title>Early</title>${" ".repeat(MiB)}<meta property="og:title" content="Late"></head></html>`;
    expect(await fetchLinkPreview("https://example.com/late", stub({ "https://example.com/late": html(late, { "content-length": String(late.length) }) }).deps)).toMatchObject({ ok: true, title: "Early" });
  });
});

describe("fetchLinkPreview: redirects", () => {
  const chain = (hops: number) => {
    const routes: Record<string, Response> = {};
    for (let index = 0; index < hops; index += 1) routes[`https://example.com/r${index}`] = redirect(`https://example.com/r${index + 1}`, index % 2 ? 301 : 302);
    routes[`https://example.com/r${hops}`] = html(page(`<title>Arrived</title>`));
    return stub(routes);
  };

  it("follows three redirects and reports the final address", async () => {
    const { deps, calls } = chain(3);
    expect(await fetchLinkPreview("https://example.com/r0", deps)).toMatchObject({ ok: true, finalUrl: "https://example.com/r3", title: "Arrived" });
    expect(calls).toHaveLength(4);
  });

  it("refuses the fourth redirect", async () => {
    const { deps, calls } = chain(4);
    expect(await fetchLinkPreview("https://example.com/r0", deps)).toMatchObject({ ok: false, reason: "too_many_redirects" });
    expect(calls).toHaveLength(4);
  });

  it("resolves a relative Location against the current URL", async () => {
    const { deps } = stub({ "https://example.com/a/b": redirect("../c"), "https://example.com/c": html(page(`<title>C</title>`)) });
    expect(await fetchLinkPreview("https://example.com/a/b", deps)).toMatchObject({ ok: true, finalUrl: "https://example.com/c" });
  });

  it("refuses a redirect to a private or non-http address without fetching it", async () => {
    for (const target of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "ftp://example.com/file", "http://[::1]/", "http://localhost:8787/", "http://2130706433/"]) {
      const { deps, calls } = stub({ "https://example.com/start": redirect(target) }, () => html(page(`<title>reached</title>`)));
      expect(await fetchLinkPreview("https://example.com/start", deps), target).toMatchObject({ ok: false, reason: "blocked" });
      expect(calls, target).toEqual(["https://example.com/start"]);
    }
  });

  it("refuses a redirect with no Location", async () => {
    expect(await fetchLinkPreview("https://example.com/s", stub({ "https://example.com/s": new Response(null, { status: 302 }) }).deps)).toMatchObject({ ok: false });
  });
});

describe("fetchLinkPreview: the image", () => {
  const withImage = (image: Response | Handler, head = `<meta property="og:title" content="T"><meta property="og:image" content="https://img.example.com/i.png">`) =>
    stub({ "https://example.com/p": html(page(head)), "https://img.example.com/i.png": image as Handler });

  it("gives a card with no image when the image is over five megabytes, by its declared size or its stream", async () => {
    const declared = withImage(new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(6 * MiB) } }));
    expect(await fetchLinkPreview("https://example.com/p", declared.deps)).toMatchObject({ ok: true, title: "T", image: null });
    const state = { cancelled: false, sent: 0 };
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(PNG); }, pull(controller) { const chunk = new Uint8Array(256 * 1024); state.sent += chunk.length; controller.enqueue(chunk); }, cancel() { state.cancelled = true; } });
    const streamed = withImage(new Response(stream, { headers: { "content-type": "image/png" } }));
    expect(await fetchLinkPreview("https://example.com/p", { ...streamed.deps, timeoutMs: 5_000 })).toMatchObject({ ok: true, image: null });
    expect(state.cancelled).toBe(true);
    expect(state.sent).toBeLessThanOrEqual(5 * MiB + 512 * 1024);
  });

  it("gives a card with no image for an HTML page, an unsniffable file, a GIF or a missing file", async () => {
    for (const image of [html("<html></html>"), new Response(new Uint8Array(32).fill(7), { headers: { "content-type": "image/png" } }), new Response(new TextEncoder().encode("GIF89a......"), { headers: { "content-type": "image/gif" } }), new Response("gone", { status: 404 })]) {
      expect(await fetchLinkPreview("https://example.com/p", withImage(image).deps)).toMatchObject({ ok: true, title: "T", image: null });
    }
  });

  it("trusts the bytes and not the declared type", async () => {
    const result = await fetchLinkPreview("https://example.com/p", withImage(new Response(PNG, { headers: { "content-type": "image/jpeg" } })).deps);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.image?.contentType).toBe("image/png");
  });

  it("gives a card with no image when the image redirects to a private address, and never fetches it", async () => {
    const { deps, calls } = stub({ "https://example.com/p": html(page(`<meta property="og:title" content="T"><meta property="og:image" content="https://img.example.com/i.png">`)), "https://img.example.com/i.png": redirect("http://169.254.169.254/latest/meta-data/") }, () => png());
    expect(await fetchLinkPreview("https://example.com/p", deps)).toMatchObject({ ok: true, title: "T", image: null });
    expect(calls).toEqual(["https://example.com/p", "https://img.example.com/i.png"]);
  });

  it("does not fetch an og:image that points at a private address or a non-http scheme", async () => {
    for (const image of ["http://127.0.0.1/i.png", "data:image/png;base64,AAAA", "ftp://example.com/i.png", "javascript:alert(1)"]) {
      const { deps, calls } = stub({ "https://example.com/p": html(page(`<meta property="og:title" content="T"><meta property="og:image" content="${image}">`)) }, () => png());
      expect(await fetchLinkPreview("https://example.com/p", deps), image).toMatchObject({ ok: true, image: null });
      expect(calls, image).toEqual(["https://example.com/p"]);
    }
  });

  it("gives an image fetch its own deadline", async () => {
    const hang: Handler = (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    expect(await fetchLinkPreview("https://example.com/p", withImage(hang).deps)).toMatchObject({ ok: true, title: "T", image: null });
  });
});

describe("the QuincyBackground RPC method", () => {
  it("is exposed, and refuses a private address before any network use", async () => {
    const { default: QuincyBackground } = await import("../src/index");
    const instance = Object.create(QuincyBackground.prototype) as InstanceType<typeof QuincyBackground>;
    expect(await instance.fetchLinkPreview("http://169.254.169.254/latest/meta-data/")).toEqual({ ok: false, reason: "blocked" });
    expect(await instance.fetchLinkPreview("https://quincy.flamingfire.my/x", ["quincy.flamingfire.my"])).toEqual({ ok: false, reason: "blocked" });
  });
});
