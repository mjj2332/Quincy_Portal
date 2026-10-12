/** The studio's name, email and website as the Client Delivery page's footer shows them (#787 slice 9, #836). The one place any of them is written. */
export const STUDIO_NAME = "Quincy Productions";
export const STUDIO_EMAIL = "info@quincyproductions.com.au";
export const STUDIO_WEBSITE = "https://quincyproductions.com.au";

/** `mailto:` for the footer's email, with the street as the subject so the studio knows which delivery the client means. */
export const studioEmailHref = (street: string): string => `mailto:${STUDIO_EMAIL}?subject=${encodeURIComponent(street)}`;
