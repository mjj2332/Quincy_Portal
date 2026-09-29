import type { CollectionKind } from "@quincy/shared";

/** The Project workspace's selected tab: one of the five Collections, or Project collaboration. */
export type WorkspaceTab = CollectionKind | "collaboration";

export function isCollectionTab(tab: WorkspaceTab): tab is CollectionKind { return tab !== "collaboration"; }
