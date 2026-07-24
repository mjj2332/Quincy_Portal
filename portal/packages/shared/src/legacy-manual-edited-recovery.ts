export const LEGACY_MANUAL_EDITED_RECOVERY_JOB_KIND = "legacy_manual_edited_recovery" as const;

export type LegacyManualEditedRecoveryCandidate = {
  collectionKind: string;
  source: string;
  publishStatus: string | null;
  sourcePath: string | null;
  archivedAt: Date | string | number | null;
  renditionCount: number;
};

/**
 * This narrow predicate intentionally describes only pre-publication legacy rows. It must not
 * become a second path through normal ManualEditedPublish, which writes a Dropbox source_path.
 */
export function isLegacyManualEditedRecoveryCandidate(row: LegacyManualEditedRecoveryCandidate): boolean {
  return row.collectionKind === "edited"
    && row.source === "upload"
    && row.publishStatus === "ready"
    && row.sourcePath === null
    && row.archivedAt === null
    && row.renditionCount === 0;
}

export function legacyManualEditedRecoveryCorrelationId(assetId: string): string {
  return `${LEGACY_MANUAL_EDITED_RECOVERY_JOB_KIND}:${assetId}`;
}
