import { describe, expect, it } from "vitest";
import {
  LINK_PREVIEW_MAX_HTML_BYTES, LINK_PREVIEW_MAX_IMAGE_BYTES, LINK_PREVIEW_MAX_PER_POST, LINK_PREVIEW_MAX_REDIRECTS, LINK_PREVIEW_RATE_LIMIT_PER_HOUR, LINK_PREVIEW_TIMEOUT_MS,
  checkPreviewTarget, linkPreviewCardSchema, normalizePreviewText,
} from "../src/link-preview";

describe("link preview limits (#497)", () => {
  it("states the agreed numbers", () => {
    expect(LINK_PREVIEW_MAX_PER_POST).toBe(3);
    expect(LINK_PREVIEW_TIMEOUT_MS).toBe(5_000);
    expect(LINK_PREVIEW_MAX_REDIRECTS).toBe(3);
    expect(LINK_PREVIEW_MAX_HTML_BYTES).toBe(1024 * 1024);
    expect(LINK_PREVIEW_MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(LINK_PREVIEW_RATE_LIMIT_PER_HOUR).toBe(30);
  });
});

describe("checkPreviewTarget", () => {
  const ok = (value: string) => checkPreviewTarget(value, { blockedHosts: ["quincy.flamingfire.my"] });

  it("accepts an ordinary http or https URL and returns the normalised address as typed, and the same address without its fragment to fetch", () => {
    expect(ok("https://Example.com/a/b?x=1#frag")).toEqual({ ok: true, url: "https://example.com/a/b?x=1#frag", fetchUrl: "https://example.com/a/b?x=1" });
    expect(ok("http://example.com")).toEqual({ ok: true, url: "http://example.com/", fetchUrl: "http://example.com/" });
    expect(ok("https://example.com:443/")).toEqual({ ok: true, url: "https://example.com/", fetchUrl: "https://example.com/" });
    expect(ok("https://news.example.co.uk/")).toMatchObject({ ok: true });
    expect(ok("https://[2606:4700:4700::1111]/")).toMatchObject({ ok: true });
    expect(ok("http://8.8.8.8/")).toMatchObject({ ok: true });
    expect(ok("http://100.63.255.255/")).toMatchObject({ ok: true });
  });

  it("refuses what is not an absolute http(s) URL", () => {
    for (const value of ["", "not a url", "/relative", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "gopher://example.com/", "ws://example.com/", "//example.com/"]) {
      expect(ok(value), value).toMatchObject({ ok: false });
    }
  });

  it("refuses credentials and non-default ports", () => {
    expect(ok("https://user:pw@example.com/")).toMatchObject({ ok: false, reason: "credentials" });
    expect(ok("https://user@example.com/")).toMatchObject({ ok: false, reason: "credentials" });
    expect(ok("http://example.com:8080/")).toMatchObject({ ok: false, reason: "port" });
    expect(ok("https://example.com:8443/")).toMatchObject({ ok: false, reason: "port" });
    expect(ok("http://example.com:443/")).toMatchObject({ ok: false, reason: "port" });
    expect(ok("https://example.com:80/")).toMatchObject({ ok: false, reason: "port" });
  });

  it("refuses IPv4 loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses", () => {
    for (const host of [
      "0.0.0.0", "0.1.2.3", "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255",
      "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1",
      "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) expect(ok(`http://${host}/`), host).toMatchObject({ ok: false, reason: "private_address" });
    expect(ok("http://172.15.0.1/")).toMatchObject({ ok: true });
    expect(ok("http://172.32.0.1/")).toMatchObject({ ok: true });
  });

  it("refuses an IPv4 address written as a decimal, hex, octal or short number, which the URL parser normalises", () => {
    for (const host of ["2130706433", "0x7f000001", "0x7f.1", "017700000001", "127.1", "127.0.1", "0177.0.0.1", "3232235521", "2852039166"]) {
      expect(ok(`http://${host}/`), host).toMatchObject({ ok: false, reason: "private_address" });
    }
  });

  it("refuses IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation and site-local addresses", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[fec0::1]", "[ff02::1]", "[2001:db8::1]"]) {
      expect(ok(`http://${host}/`), host).toMatchObject({ ok: false, reason: "private_address" });
    }
  });

  it("refuses IPv4 smuggled inside IPv6", () => {
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[::ffff:169.254.169.254]", "[::127.0.0.1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "[2002:a9fe:a9fe::1]", "[::ffff:c0a8:1]"]) {
      expect(ok(`http://${host}/`), host).toMatchObject({ ok: false, reason: "private_address" });
    }
    expect(ok("http://[::ffff:8.8.8.8]/")).toMatchObject({ ok: true });
  });

  it("refuses local names, single-label names and the Portal's own host", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "a.b.localhost", "printer.local", "db.internal", "svc.cluster.internal", "intranet", "router", "my.localdomain", "x.home.arpa", "quincy.flamingfire.my", "QUINCY.flamingfire.my"]) {
      expect(ok(`https://${host}/`), host).toMatchObject({ ok: false });
    }
    expect(checkPreviewTarget("https://example.com/")).toMatchObject({ ok: true });
  });

  it("refuses an address that is too long", () => {
    expect(ok(`https://example.com/${"a".repeat(2100)}`)).toMatchObject({ ok: false, reason: "too_long" });
  });
});

describe("normalizePreviewText", () => {
  it("collapses whitespace, strips control characters and caps the length", () => {
    expect(normalizePreviewText("  Hello \n\t  world\u0000​ ", 300)).toBe("Hello world");
    expect(normalizePreviewText("x".repeat(400), 300)).toHaveLength(300);
    expect(normalizePreviewText("   ", 300)).toBeNull();
    expect(normalizePreviewText(undefined, 300)).toBeNull();
  });
});

describe("linkPreviewCardSchema", () => {
  const card = { previewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", url: "https://example.com/", title: "T", description: null, siteName: "Example", imageMediaId: null };
  it("accepts a card and refuses extra keys, which keeps the object key off the wire", () => {
    expect(linkPreviewCardSchema.parse(card)).toEqual(card);
    expect(() => linkPreviewCardSchema.parse({ ...card, originalKey: "projects/p/x" })).toThrow();
    expect(() => linkPreviewCardSchema.parse({ ...card, previewId: "nope" })).toThrow();
  });
});
