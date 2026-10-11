import { COLLECTION_KINDS, type CollectionKind } from "./media";

/** The Project workspace's tabs: the five Collections, then Project collaboration, then Client Delivery (#787; offered only while its gate is open and the person may view the preview). */
export const WORKSPACE_TABS = [...COLLECTION_KINDS, "collaboration", "delivery"] as const;

/** The Project workspace's selected tab: one of the five Collections, Project collaboration, or Client Delivery. */
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function isCollectionTab(tab: WorkspaceTab): tab is CollectionKind { return (COLLECTION_KINDS as readonly string[]).includes(tab); }
