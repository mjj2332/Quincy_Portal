import { COLLECTION_KINDS, isCollectionTab, type CollectionKind, type WorkspaceTab } from "@quincy/shared";

/** The Project workspace's selected tab: one of the five Collections, or Project collaboration. */
export { isCollectionTab, type WorkspaceTab };

/** The Collection tabs the Workspace strip renders: every Collection for a role that can view
 * Edited, only RAW otherwise, minus any Collection the server has denied. The arrival resolver
 * below reads the same list, so a notification can never select a tab the strip does not show. */
export function availableCollectionTabs(canViewEdited: boolean, denied: ReadonlySet<CollectionKind>): CollectionKind[] {
  return (canViewEdited ? [...COLLECTION_KINDS] : ["raw" as const]).filter((kind) => !denied.has(kind));
}

/** #337: the tab a notification arrival actually selects -- its target when the strip offers it,
 * otherwise Collaboration (always present in the full workspace). */
export function resolveArrivalTab(tab: WorkspaceTab, canViewEdited: boolean, denied: ReadonlySet<CollectionKind>): WorkspaceTab {
  if (!isCollectionTab(tab)) return tab;
  return availableCollectionTabs(canViewEdited, denied).includes(tab) ? tab : "collaboration";
}
