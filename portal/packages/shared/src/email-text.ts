export const MENTION_EMAIL_EXCERPT_MAX_LENGTH = 400;

/** Produces an email-preview-sized plain-text excerpt without splitting a surrogate pair. */
export function truncateForEmail(text: string): string {
  if (text.length <= MENTION_EMAIL_EXCERPT_MAX_LENGTH) return text;
  const prefix = text.slice(0, 399);
  const lastCodeUnit = prefix.charCodeAt(398);
  return `${lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF ? prefix.slice(0, -1) : prefix}…`;
}
