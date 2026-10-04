import { z } from "zod";

/**
 * Link previews (#497): the card a post shows for a link inside it. The limits and the target checks live here so the
 * app worker and the background worker (which does the fetching) agree on them. The checks are load-bearing: Cloudflare's
 * `global_fetch_strictly_public` flag stops a deployed Worker reaching a private network, but local development has no such
 * protection, so a blocked address is refused before any fetch.
 */
export const LINK_PREVIEW_MAX_PER_POST = 3;
export const LINK_PREVIEW_TIMEOUT_MS = 5_000;
export const LINK_PREVIEW_MAX_REDIRECTS = 3;
/** Only the start of a page is read: the tags a preview needs sit in `<head>`. */
export const LINK_PREVIEW_MAX_HTML_BYTES = 1024 * 1024;
export const LINK_PREVIEW_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const LINK_PREVIEW_TITLE_MAX = 300;
export const LINK_PREVIEW_DESCRIPTION_MAX = 500;
export const LINK_PREVIEW_SITE_NAME_MAX = 100;
export const LINK_PREVIEW_URL_MAX = 2048;
/** Fetches one person may start in a rolling hour, counted from the preview rows they requested. */
export const LINK_PREVIEW_RATE_LIMIT_PER_HOUR = 30;
export const LINK_PREVIEW_RATE_WINDOW_MS = 60 * 60 * 1000;

/** What a card shows. It never carries an object key: the browser addresses the image by id alone. */
export const linkPreviewCardSchema = z.object({
  previewId: z.string().uuid(),
  url: z.string().max(LINK_PREVIEW_URL_MAX),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
  imageMediaId: z.string().uuid().nullable(),
}).strict();
export type LinkPreviewCard = z.infer<typeof linkPreviewCardSchema>;

/** The response of a preview request: a card, or null when the page could not be previewed (the link stays a plain link). */
export const linkPreviewResponseSchema = z.object({ preview: linkPreviewCardSchema.nullable() }).strict();
export type LinkPreviewResponse = z.infer<typeof linkPreviewResponseSchema>;
export const linkPreviewRequestSchema = z.object({ url: z.string().min(1).max(LINK_PREVIEW_URL_MAX + 1) }).strict();

/** Control, zero-width and bidirectional-override characters, which never belong in a card. */
const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** Trims a scraped value to one line of readable text, or null when nothing is left. */
export function normalizePreviewText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export type PreviewTargetReason = "invalid_url" | "scheme" | "credentials" | "port" | "private_address" | "blocked_host" | "too_long";
export type PreviewTargetVerdict = { ok: true; url: string; fetchUrl: string } | { ok: false; reason: PreviewTargetReason };

const blocked = (reason: PreviewTargetReason): PreviewTargetVerdict => ({ ok: false, reason });

/** [network, prefix length] blocks of IPv4 space a preview must never reach. */
const BLOCKED_IPV4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function ipv4Blocked(value: number): boolean {
  return BLOCKED_IPV4.some(([network, bits]) => (value >>> (32 - bits)) === (network >>> (32 - bits)));
}

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/** Eight 16-bit groups of an IPv6 literal (brackets removed), or null if it is not one. */
function parseIpv6(host: string): number[] | null {
  let text = host.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = parseIpv4(tail[1]!);
    if (v4 === null) return null;
    text = `${text.slice(0, -tail[1]!.length)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  const numbers = all.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  return numbers.length === 8 && numbers.every((n) => !Number.isNaN(n)) ? numbers : null;
}

function ipv6Blocked(g: number[]): boolean {
  const [a, b, c, d, e, f, gg, h] = g as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => ipv4Blocked(((hi << 16) | lo) >>> 0);
  if (g.every((n) => n === 0) || (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && gg === 0 && h === 1)) return true; // :: and ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return embedded(gg, h); // ::ffff:a.b.c.d and the deprecated ::a.b.c.d
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return embedded(gg, h); // NAT64 64:ff9b::/96
  if (a === 0x2002) return embedded(b, c); // 6to4 embeds an IPv4 address
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return true; // link-local and the old site-local
  if ((a & 0xff00) === 0xff00) return true; // multicast
  return a === 0x2001 && b === 0x0db8; // documentation
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp", ".private"];

/**
 * Decides whether the server may fetch a URL for a preview. It runs after the platform URL parser has normalised the address
 * (which rewrites a decimal, hex or octal IPv4 into dotted form), allows only http and https on their default ports with no
 * credentials, and refuses loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses (an IPv4 address
 * written inside an IPv6 one included), local and single-label names, and any host in `blockedHosts` (the Portal's own).
 * Returns the normalised URL as the author typed it (`url`, fragment kept, the card's target) and the same address without its fragment
 * (`fetchUrl`, what is fetched and what the attempt is keyed on).
 */
export function checkPreviewTarget(raw: string, options: { blockedHosts?: readonly string[] } = {}): PreviewTargetVerdict {
  if (typeof raw !== "string" || raw.length > LINK_PREVIEW_URL_MAX) return blocked(typeof raw === "string" && raw.length > 0 ? "too_long" : "invalid_url");
  let url: URL;
  try { url = new URL(raw); } catch { return blocked("invalid_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return blocked("scheme");
  if (url.username || url.password) return blocked("credentials");
  if (url.port !== "") return blocked("port");
  let host = url.hostname.toLowerCase();
  if (!host) return blocked("invalid_url");
  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = parseIpv6(host.slice(1, -1));
    if (!groups || ipv6Blocked(groups)) return blocked("private_address");
  } else {
    while (host.endsWith(".")) host = host.slice(0, -1);
    const v4 = parseIpv4(host);
    if (v4 !== null) { if (ipv4Blocked(v4)) return blocked("private_address"); }
    else if (/^[0-9.x]+$/i.test(host)) return blocked("private_address"); // a numeric host the parser did not turn into dotted form
    else {
      if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes(".")) return blocked("blocked_host");
      if ((options.blockedHosts ?? []).some((own) => own.toLowerCase().replace(/\.$/, "") === host)) return blocked("blocked_host");
    }
  }
  const href = url.href;
  url.hash = "";
  const fetchUrl = url.href;
  return href.length > LINK_PREVIEW_URL_MAX ? blocked("too_long") : { ok: true, url: href, fetchUrl };
}
