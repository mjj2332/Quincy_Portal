import type { ReactNode } from "react";
import type { Role } from "@quincy/shared";
import { useSession } from "../../lib/auth";
import { useOptionalProjectQueryClient } from "../../lib/project-data";
import { ReviewLinksDialogHost } from "./ReviewLinksDialogHost";
import { ReviewLinkStoreContext, useReviewLinkStore } from "./use-review-links-ui";

/**
 * The Project-level home of Review links (#741 11b): the form/operation store and the dialog (so the one-time reveal) live here, ABOVE the
 * Collection tab switch. A create or replace answered after the person left the Video tab still reveals its URL; the Video tab only
 * reads the store (`VideoCollectionPanel`). Mounted once by `ProjectWorkspace`'s `WorkspaceBody`. Operations are cancelled only when the
 * principal is terminated or the person or Project changes (see `useReviewLinkStore`), never by a tab switch.
 */
export function ReviewLinksScope({ projectId, role, archived, children }: { projectId: string; role: Role; archived: boolean; children: ReactNode }) {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const store = useReviewLinkStore({ projectId, userId, queryClient: useOptionalProjectQueryClient() });
  return <ReviewLinkStoreContext.Provider value={store}>
    {children}
    <ReviewLinksDialogHost store={store} projectId={projectId} role={role} archived={archived} />
  </ReviewLinkStoreContext.Provider>;
}
