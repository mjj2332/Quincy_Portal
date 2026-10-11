import { onPrincipalTerminal } from "./principal-terminal";
import { dismissToast, pushToast, type ToastAction, type ToastTone } from "./toast-store";
import { onUploadIdentityChange, uploadIdentityGeneration } from "./video-upload-store";

/**
 * The session a Trash write started under (#776 E). A removal or restore announces itself when the server answers, which can be after the person signed out or another
 * person signed in: that late answer must not name the previous person's film, and its Undo would run with the new person's cookies. A caller captures `trashSession(queryClient)`
 * when the request starts and announces through `pushTrashToast`, which drops the toast when the session has ended; a session ending also dismisses the toasts already shown.
 *
 * A session is one query client. A principal-terminal notice names the client that saw the 401 (none means everyone), so a retired client's late notice ends only its own session.
 * A different person or a sign-out (the upload store's identity generation) ends every session.
 */
let endedForAll = 0;
const endedByClient = new WeakMap<object, number>();
const shown = new Map<number, object | undefined>();

const dismissWhere = (match: (client: object | undefined) => boolean) => { for (const [id, client] of [...shown]) if (match(client)) { dismissToast(id); shown.delete(id); } };
onPrincipalTerminal((client) => {
  if (client === undefined) { endedForAll += 1; dismissWhere(() => true); return; }
  endedByClient.set(client, (endedByClient.get(client) ?? 0) + 1);
  dismissWhere((owner) => owner === client);
});
onUploadIdentityChange(() => { endedForAll += 1; dismissWhere(() => true); });

export const trashSession = (client: object | undefined): string => `${uploadIdentityGeneration()}:${endedForAll}:${client ? endedByClient.get(client) ?? 0 : 0}`;

/** Pushes the toast unless the session `started` (captured with `trashSession(client)`) has ended; resolves with the toast id, or null when dropped. */
export function pushTrashToast(client: object | undefined, started: string, message: string, tone: ToastTone = "success", options?: { action?: ToastAction; ttlMs?: number }): number | null {
  if (started !== trashSession(client)) return null;
  const id = pushToast(message, tone, options);
  shown.set(id, client);
  return id;
}
