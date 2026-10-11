import { onPrincipalTerminal } from "./principal-terminal";

/**
 * The Publish a person started and has not had a definite answer to (#787 slice 10 round 6): its operation id and the exact body it was sent with. It belongs to the signed-in session (one query
 * client per session, so a different person never sees it) and the Project, not to the Delivery tab or the Project sheet, so closing and reopening the sheet keeps it and a Retry
 * sends the same id. Only a definite answer or an explicit Discard releases it; the session ending (a 401, an access loss) drops everything that session held.
 * See docs/lessons.md "Form lifetime is not component lifetime".
 */
export type PendingPublish = { id: string; body: { assetIds: string[]; coverAssetId: string | null; expectedLatestSet: number | null } };
let bySession = new WeakMap<object, Map<string, PendingPublish>>();
export const readPendingPublish = (session: object, projectId: string): PendingPublish | null => bySession.get(session)?.get(projectId) ?? null;
export function writePendingPublish(session: object, projectId: string, pending: PendingPublish | null): void {
  let projects = bySession.get(session);
  if (!pending) { projects?.delete(projectId); return; }
  if (!projects) { projects = new Map(); bySession.set(session, projects); }
  projects.set(projectId, pending);
}
// A notice with no session ends every session this tab held.
onPrincipalTerminal((session) => { if (session) bySession.delete(session); else bySession = new WeakMap(); });
