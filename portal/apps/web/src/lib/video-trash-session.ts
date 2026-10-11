import { onPrincipalTerminal } from "./principal-terminal";
import { dismissToast, pushToast, type ToastAction, type ToastTone } from "./toast-store";
import { onUploadIdentityChange, uploadIdentityGeneration } from "./video-upload-store";

/**
 * The session a Trash write started under (#776 E). A removal or restore announces itself when the server answers, which can be after the person signed out or another
 * person signed in: that late answer must not name the previous person's film, and its Undo would run with the new person's cookies. A caller captures `trashSession()` when
 * the request starts and announces through `pushTrashToast`, which drops the toast when the session has ended; a session ending also dismisses the toasts already shown.
 * The generation is the upload store's identity generation (a different person or a sign-out) plus every principal-terminal notice (a 401, an access loss).
 */
let ended = 0;
const shown = new Set<number>();
const end = () => { ended += 1; for (const id of shown) dismissToast(id); shown.clear(); };
onPrincipalTerminal(end);
onUploadIdentityChange(end);

export const trashSession = (): string => `${uploadIdentityGeneration()}:${ended}`;

/** Pushes the toast unless the session `started` has ended; resolves with the toast id, or null when dropped. */
export function pushTrashToast(started: string, message: string, tone: ToastTone = "success", options?: { action?: ToastAction; ttlMs?: number }): number | null {
  if (started !== trashSession()) return null;
  const id = pushToast(message, tone, options);
  shown.add(id);
  return id;
}
