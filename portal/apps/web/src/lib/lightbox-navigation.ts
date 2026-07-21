export function cycleLightboxIndex(index: number, change: number, assetCount: number) {
  return (index + change + assetCount) % assetCount;
}
