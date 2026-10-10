/**
 * The Cloudflare Email Service error codes that are safe to store and show (#741 13a lifted them out of the admin notification view, which keeps using them). An error message
 * is never one of these: it can carry an address.
 */
export const EMAIL_SEND_ERROR_CODES = [
  "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INVALID_FROM", "E_INVALID_TO", "E_INVALID_EMAIL", "E_DOMAIN_NOT_VERIFIED", "E_SENDER_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED", "E_MESSAGE_TOO_LARGE", "E_INVALID_HEADERS",
] as const;
export type EmailSendErrorCode = (typeof EMAIL_SEND_ERROR_CODES)[number];
