import { pushToast } from "./toast-store";

/**
 * Copies a string the caller already holds and toasts the outcome (#866). Call it inside the press handler: a clipboard write after an
 * awaited fetch loses the user activation in Safari. A missing `navigator.clipboard` or a rejected write toasts the failure rather than
 * throwing or going quiet (the registry's `use-copy-to-clipboard` does both; see `quincy/CopyProjectLinkButton`).
 */
export function copyText(text: string, { success = "Link copied.", failure = "Couldn't copy the link." }: { success?: string; failure?: string } = {}): void {
  if (!navigator.clipboard?.writeText) { pushToast(failure, "error"); return; }
  navigator.clipboard.writeText(text).then(() => pushToast(success), () => pushToast(failure, "error"));
}
