/** The studio's name and address as the Client Delivery page's footer and "Ask the studio" link show them (#787 slice 9). The one place either is written. */
export const STUDIO_NAME = "Quincy Productions";
export const STUDIO_EMAIL = "info@quincyproductions.com.au";
export const STUDIO_FOOTER = `${STUDIO_NAME} · ${STUDIO_EMAIL}`;

/** `mailto:` for "Ask the studio", with the street as the subject so the studio knows which delivery the client means. */
export const askTheStudioHref = (street: string): string => `mailto:${STUDIO_EMAIL}?subject=${encodeURIComponent(street)}`;
