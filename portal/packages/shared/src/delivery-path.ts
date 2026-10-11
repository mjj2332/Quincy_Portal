import { DELIVERY_SLUG_ALPHABET, DELIVERY_SLUG_SUFFIX_LENGTH } from "./client-delivery";

/**
 * The Client Delivery page address (#787): `/d/<address>-<suffix>`. One definition for the Worker (its shell route and API paths) and the SPA (its mount choice), so the two cannot disagree about which path is a page.
 * Matching is on the RAW path: no decoding, no case folding, no trailing slash, no extra segment.
 */
export const DELIVERY_SLUG_PATTERN = `[a-z0-9]+(?:-[a-z0-9]+)*-[${DELIVERY_SLUG_ALPHABET}]{${DELIVERY_SLUG_SUFFIX_LENGTH}}`;
const PAGE_PATH = new RegExp(`^/d/(${DELIVERY_SLUG_PATTERN})$`);

/** The slug in a page path, or null when the path is not exactly a page address. */
export const deliverySlugOfPath = (pathname: string): string | null => PAGE_PATH.exec(pathname)?.[1] ?? null;
export const isDeliveryPagePath = (pathname: string): boolean => PAGE_PATH.test(pathname);
