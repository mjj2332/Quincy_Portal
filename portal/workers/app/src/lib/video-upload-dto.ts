import { ROLE_LABELS, VIDEO_UPLOAD_ACTIVE_STATUSES, videoDtoSchema, type Role, type VideoDto, type VideoVersionDto } from "@quincy/shared";

/**
 * The Video and Version shapes the upload completion answers with (#741 PR 4b), rebuilt from rows so a repeated completion
 * returns the same body. The list route (4c) reuses these shapes.
 */
type PersonRow = { personId: string; personName: string; personRole: Role; personActive: number };
type VersionRow = PersonRow & {
  videoTitle: string; videoPremium: number; videoPosition: number; videoCreatedAt: number;
  assetId: string; version: number; supersededAt: number | null; assetCreatedAt: number; originalFilename: string; bytes: number;
  fpsNum: number; fpsDen: number; frameCount: number; durationMs: number; width: number; height: number; codec: "avc1" | "avc3";
  startTcFrames: number | null; tcNominalFps: number; tcDropFrame: number; fastStart: number; hasAudio: number; posterKey: string | null;
};

const iso = (epochMs: number) => new Date(Number(epochMs)).toISOString();
const person = (row: PersonRow) => ({ id: row.personId, name: row.personName, roleLabel: ROLE_LABELS[row.personRole] ?? row.personRole, isExternal: row.personRole === "external_editor", active: Boolean(row.personActive) });

function versionOf(row: VersionRow): VideoVersionDto {
  return {
    assetId: row.assetId, version: Number(row.version), current: row.supersededAt === null, uploadedBy: person(row), createdAt: iso(row.assetCreatedAt),
    originalFilename: row.originalFilename, bytes: Number(row.bytes), fps: { num: Number(row.fpsNum), den: Number(row.fpsDen) }, frameCount: Number(row.frameCount),
    durationMs: Number(row.durationMs), width: Number(row.width), height: Number(row.height), codec: row.codec,
    startTimecodeFrames: row.startTcFrames === null ? null : Number(row.startTcFrames), tcNominalFps: Number(row.tcNominalFps), tcDropFrame: Boolean(row.tcDropFrame),
    fastStart: Boolean(row.fastStart), hasAudio: Boolean(row.hasAudio), hasPoster: row.posterKey !== null,
    streamUrl: `/media/video/${row.assetId}`, posterUrl: row.posterKey === null ? null : `/media/video/${row.assetId}/poster`,
  };
}

/** One Video with every Version (newest first) and its active upload, or null when the Video is not in the Project. */
export async function loadVideoDto(db: D1Database, projectId: string, videoId: string): Promise<{ video: VideoDto; versions: Map<string, VideoVersionDto> } | null> {
  const rows = (await db.prepare(`
    SELECT v.title AS videoTitle, v.premium AS videoPremium, v.position AS videoPosition, v.created_at AS videoCreatedAt,
      a.id AS assetId, a.version, a.superseded_at AS supersededAt, a.created_at AS assetCreatedAt, a.original_filename AS originalFilename, a.bytes,
      m.fps_num AS fpsNum, m.fps_den AS fpsDen, m.frame_count AS frameCount, m.duration_ms AS durationMs, m.width, m.height, m.codec,
      m.start_tc_frames AS startTcFrames, m.tc_nominal_fps AS tcNominalFps, m.tc_drop_frame AS tcDropFrame, m.fast_start AS fastStart, m.has_audio AS hasAudio, m.poster_key AS posterKey,
      u.id AS personId, u.name AS personName, u.role AS personRole, u.active AS personActive
    FROM videos v
    JOIN assets a ON a.version_group_id = v.id AND a.kind = 'video'
    JOIN video_version_meta m ON m.asset_id = a.id
    JOIN user u ON u.id = m.uploaded_by
    WHERE v.id = ? AND v.project_id = ?
    ORDER BY a.version DESC
  `).bind(videoId, projectId).all<VersionRow>()).results;
  const head = rows[0]; if (!head) return null;
  const versions = rows.map(versionOf);
  const active = await db.prepare(`
    SELECT r.version, r.expires_at AS expiresAt, u.id AS personId, u.name AS personName, u.role AS personRole, u.active AS personActive
    FROM video_upload_reservations r JOIN user u ON u.id = r.created_by
    WHERE r.video_id = ? AND r.status IN (${VIDEO_UPLOAD_ACTIVE_STATUSES.map(() => "?").join(", ")}) LIMIT 1
  `).bind(videoId, ...VIDEO_UPLOAD_ACTIVE_STATUSES).first<PersonRow & { version: number; expiresAt: number }>();
  const current = versions.find((version) => version.current) ?? versions[0]!;
  const video = videoDtoSchema.parse({
    id: videoId, title: head.videoTitle, premium: Boolean(head.videoPremium), position: Number(head.videoPosition), createdAt: iso(head.videoCreatedAt), currentAssetId: current.assetId,
    uploading: active ? { version: Number(active.version), uploader: person(active), expiresAt: iso(active.expiresAt) } : null, versions,
  });
  return { video, versions: new Map(versions.map((version) => [version.assetId, version])) };
}
