import { DELIVERY_HANDLE_LENGTH, DELIVERY_SLUG_ALPHABET, DELIVERY_SLUG_SUFFIX_LENGTH } from "@quincy/shared";

/** The longest the readable part of an address may be; the random suffix and its hyphen come after it. */
export const DELIVERY_SLUG_BASE_MAX = 60;
const HANDLE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * The readable part of a Delivery address (#787, ADR 0022): street and suburb, NFKD-folded with the combining marks dropped, lower-cased, every run of anything but a-z and 0-9 a single
 * hyphen, cut to 60 characters and trimmed again, `property` when nothing is left. The suffix is added by the caller and the whole slug is never recomputed.
 */
export function deliverySlugBase(street: string, suburb: string | null): string {
  const folded = `${street} ${suburb ?? ""}`.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return folded.slice(0, DELIVERY_SLUG_BASE_MAX).replace(/-+$/g, "") || "property";
}

/** `length` characters of `alphabet`, uniformly: bytes at or above the largest multiple of the alphabet size are rejected, so no character is favoured. */
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/** Six characters of the 27-character alphabet: about 387 million suffixes per readable base. */
export const randomSlugSuffix = (): string => randomString(DELIVERY_SLUG_ALPHABET, DELIVERY_SLUG_SUFFIX_LENGTH);
/** The 16-character public id of one item of one set. */
export const randomItemHandle = (): string => randomString(HANDLE_ALPHABET, DELIVERY_HANDLE_LENGTH);
