export type AutoHdrSentFileForRemoval = {
  assetId: string;
  dropboxPathKey: string;
};

export type AutoHdrSelectedAssetForRemoval = {
  assetId: string;
  filename: string;
};

/**
 * Returns only assets that this generation recorded as successfully written and that are no
 * longer selected. A recorded path whose filename is now selected is deliberately excluded:
 * the copy step may have skipped the new asset because it collided with that existing filename.
 */
export function computeRemovalAssetIds(
  sentFiles: readonly AutoHdrSentFileForRemoval[],
  selectedAssets: readonly AutoHdrSelectedAssetForRemoval[],
): string[] {
  const selectedIds = new Set(selectedAssets.map((asset) => asset.assetId));
  const selectedFilenames = new Set(selectedAssets.map((asset) => asset.filename.toLowerCase()));
  const ids = sentFiles
    .filter((file) => !selectedIds.has(file.assetId))
    .filter((file) => {
      const filename = file.dropboxPathKey.split("/").filter(Boolean).at(-1)?.toLowerCase();
      return filename ? !selectedFilenames.has(filename) : false;
    })
    .map((file) => file.assetId);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}
