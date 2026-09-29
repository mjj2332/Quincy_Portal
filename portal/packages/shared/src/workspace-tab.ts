import { COLLECTION_KINDS, type CollectionKind } from "./media";

/** The Project workspace's tabs: the five Collections, then Project collaboration. */
export const WORKSPACE_TABS = [...COLLECTION_KINDS, "collaboration"] as const;

/** The Project workspace's selected tab: one of the five Collections, or Project collaboration. */
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function isCollectionTab(tab: WorkspaceTab): tab is CollectionKind { return tab !== "collaboration"; }
