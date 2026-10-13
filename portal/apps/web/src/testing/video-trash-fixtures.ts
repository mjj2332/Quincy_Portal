import type { VideoDto, VideoVersionDto } from "@quincy/shared";

/** Valid `VideoDto` / `VideoVersionDto` objects for the Video Trash tests (#776 E): every field the strict schemas require, overridable. */
export const FIXTURE_PERSON = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };

export function fixtureVersion(over: Partial<VideoVersionDto> & { assetId: string; version: number }): VideoVersionDto {
  return {
    current: false, reviewStatus: "in_review", uploadedBy: FIXTURE_PERSON, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 120_000_000, fps: { num: 25, den: 1 }, frameCount: 250, durationMs: 10_000,
    width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: 0, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false,
    streamUrl: `/media/video/${over.assetId}`, posterUrl: null, ...over,
  };
}

export function fixtureVideo(over: Partial<VideoDto> & { id: string; versions: VideoVersionDto[] }): VideoDto {
  const newest = [...over.versions].sort((a, b) => b.version - a.version)[0]!;
  return {
    reviewStatus: "in_review", olderPublishedVersion: null, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: newest.assetId, uploading: null, latestNoteCount: null, ...over,
    versions: [...over.versions].sort((a, b) => b.version - a.version).map((version) => ({ ...version, current: version.assetId === (over.currentAssetId ?? newest.assetId) })),
  };
}
