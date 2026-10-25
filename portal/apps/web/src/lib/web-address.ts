import { isHttpUrl } from "@quincy/shared";

/** A web address found in a run of text: where it sits (`from` inclusive, `to` exclusive, in UTF-16 units) and the link it becomes. */
export type WebAddress = { from: number; to: number; href: string };

// A candidate starts with a scheme or `www.` and runs to the next space or angle bracket. Its tail is trimmed below.
const CANDIDATE = /(?:https?:\/\/|www\.)[^\s<>]*/giu;
// A candidate glued to the end of a word, an email's local part or another address is not one (`ops@www.example.com`, `nowww.x.y`).
const GLUED = /[\p{L}\p{N}_@.\-/:+]/u;
// What a sentence puts after an address: never part of it.
const TRAILING = /[.,;:!?'"‘’“”*]/u;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
// `www.` takes at least two more labels (`www.example.com`), so `www.example` and `www.` stay text.
const WWW_HOST = /^www\.[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:[/?#:]|$)/iu;

const count = (text: string, char: string) => text.split(char).length - 1;

/** Drops the sentence's punctuation and any closing bracket the address did not open (`(see https://x.test/a)`; `.../A_(b)` keeps its own). */
function trimTail(text: string): string {
  let end = text.length;
  for (;;) {
    const last = text[end - 1];
    if (last === undefined) return "";
    const opener = CLOSERS[last];
    if (TRAILING.test(last) || (opener !== undefined && count(text.slice(0, end), last) > count(text.slice(0, end), opener))) end -= 1;
    else return text.slice(0, end);
  }
}

/**
 * Every web address in `text`, in order (#947, #948): `http://`, `https://` and `www.` only, `www.` normalised to `https://`.
 * Bare domains and email addresses are never addresses, which is why the editor detects its own links instead of Tiptap's autolink.
 * A repeated address is returned each time it appears; the caller dedupes.
 */
export function findWebAddresses(text: string): WebAddress[] {
  const found: WebAddress[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const from = match.index;
    if (from > 0 && GLUED.test(text[from - 1]!)) continue;
    const written = trimTail(match[0]);
    const www = /^www\./i.test(written);
    if (www && !WWW_HOST.test(written)) continue;
    const href = www ? `https://${written}` : written;
    if (!isHttpUrl(href) || !new URL(href).hostname) continue;
    found.push({ from, to: from + written.length, href });
  }
  return found;
}
