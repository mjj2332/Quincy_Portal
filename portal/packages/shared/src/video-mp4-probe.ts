import { rational, rationalToNumber, type Rational } from "./video-rational";

/** Where the bytes come from: File.slice in the browser, R2 range reads on the server. */
export type ByteSource = { size: number; read(offset: number, length: number): Promise<Uint8Array> };

/** Decimal 2 GB. The API enforces it (`too_large`); the probe only reads what it needs. */
export const VIDEO_MAX_BYTES = 2_000_000_000;
export const MP4_PROBE_LIMITS = { maxReads: 64, maxMoovBytes: 16 * 1024 * 1024 };

export type Mp4RejectReason =
  | "too_large"
  | "not_mp4"
  | "truncated"
  | "box_size_invalid"
  | "moov_missing"
  | "moov_too_large"
  | "read_budget_exceeded"
  | "fragmented"
  | "no_video_track"
  | "multiple_video_tracks"
  | "hevc"
  | "unsupported_codec"
  | "variable_frame_rate"
  | "unsupported_frame_rate"
  | "unsupported_edit_list"
  | "unsupported_transform"
  | "zero_frames";

export type Mp4ProbeWarning = "not_fast_start" | "timecode_rate_mismatch";

export type Mp4Probe = {
  codec: "avc1" | "avc3";
  codecString: string;
  /** Exact reduced mediaTimescale / frameDelta. */
  fps: Rational;
  mediaTimescale: number;
  frameDelta: number;
  /** After the edit-list trim. */
  frameCount: number;
  durationMs: number;
  /** After rotation. */
  width: number;
  height: number;
  startTimecode: { frames: number; dropFrame: boolean; nominalFps: number } | null;
  fastStart: boolean;
  hasAudio: boolean;
  warnings: Mp4ProbeWarning[];
};

export type Mp4ProbeResult = { ok: true; probe: Mp4Probe } | { ok: false; reason: Mp4RejectReason; detail?: string };

const REJECT_MESSAGES: Record<Mp4RejectReason, string> = {
  too_large: "This video is over 2 GB. Export it at a lower bitrate or a shorter length, then upload it again.",
  not_mp4: "This is not an MP4 file. Export it as an H.264 .mp4 and upload it again.",
  truncated: "The file ends early or could not be read in full. Export it again and re-upload it.",
  box_size_invalid: "The MP4 structure is damaged. Export it again as H.264 .mp4 and re-upload it.",
  moov_missing: "The MP4 has no index. Export it again as H.264 .mp4 and re-upload it.",
  moov_too_large: "The MP4 index is unusually large. Export it again as H.264 with standard settings.",
  read_budget_exceeded: "The MP4 structure is too fragmented to read. Export it again as a standard H.264 .mp4.",
  fragmented: "Fragmented MP4 is not supported. Export as a standard (non-fragmented) H.264 .mp4.",
  no_video_track: "The file has no video track. Export a video as H.264 .mp4 and upload it again.",
  multiple_video_tracks: "The file has more than one video track. Export with a single video track.",
  hevc: "HEVC (H.265) video is not supported. Export as H.264.",
  unsupported_codec: "This video codec is not supported. Export as H.264 (AVC) in an .mp4.",
  variable_frame_rate: "Variable frame rate is not supported. Export as H.264 with a constant frame rate.",
  unsupported_frame_rate: "This frame rate is not supported. Export at a standard rate such as 24, 25, 29.97, 30, 50 or 60 fps.",
  unsupported_edit_list: "This video has a complex edit list. Export it again as a single, untrimmed clip.",
  unsupported_transform: "This video has an unsupported rotation or skew. Export it upright, or rotated in 90 degree steps only.",
  zero_frames: "The video has no frames. Export it again and re-upload it.",
};

/** The plain re-export instruction shown to the uploader. */
export function mp4RejectMessage(reason: Mp4RejectReason): string {
  return REJECT_MESSAGES[reason];
}

class ProbeReject extends Error {
  constructor(
    readonly reason: Mp4RejectReason,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}
const reject = (reason: Mp4RejectReason, detail?: string) => new ProbeReject(reason, detail);

const MAX_DEPTH = 12;

type MBox = { type: string; start: number; end: number }; // payload [start, end)

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
}

/** Child boxes in [start, end). Every size is bounded by the parent. Fewer than 8 trailing bytes are padding
 *  (QuickTime's 4-byte udta terminator). */
function boxes(buf: Uint8Array, dv: DataView, start: number, end: number, depth: number): MBox[] {
  if (depth > MAX_DEPTH) throw reject("box_size_invalid", "nesting too deep");
  const out: MBox[] = [];
  let p = start;
  while (end - p >= 8) {
    let size = dv.getUint32(p);
    const type = fourcc(buf, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (end - p < 16) throw reject("box_size_invalid", `${type} largesize`);
      const big = dv.getBigUint64(p + 8);
      if (big > BigInt(end - p)) throw reject("box_size_invalid", `${type} past parent`);
      size = Number(big);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || size > end - p) throw reject("box_size_invalid", `${type} size ${size}`);
    out.push({ type, start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

function need(b: MBox, n: number): void {
  if (b.end - b.start < n) throw reject("box_size_invalid", `${b.type} too short`);
}

function exactSafe(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw reject("box_size_invalid", `${what} out of range`);
  }
  return Number(v);
}

type TrackLight = { id: number; enabled: boolean; handler: string; kids: MBox[]; tkhd: MBox; mdia: MBox };

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

/** True when ts/delta is within 0.1% of n or n*1000/1001 for some n in 1..120 (exact integer arithmetic). */
function isSupportedRate(ts: number, delta: number): boolean {
  const T = BigInt(ts);
  const D = BigInt(delta);
  for (let n = 1; n <= 120; n++) {
    for (const [p, q] of [
      [BigInt(n), 1n],
      [BigInt(n) * 1000n, 1001n],
    ] as const) {
      const diff = T * q - p * D;
      if ((diff < 0n ? -diff : diff) * 1000n <= p * D) return true;
    }
  }
  return false;
}

export async function probeMp4(src: ByteSource, limits: Partial<typeof MP4_PROBE_LIMITS> = {}): Promise<Mp4ProbeResult> {
  const maxReads = limits.maxReads ?? MP4_PROBE_LIMITS.maxReads;
  const maxMoovBytes = limits.maxMoovBytes ?? MP4_PROBE_LIMITS.maxMoovBytes;
  let reads = 0;
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    if (reads >= maxReads) throw reject("read_budget_exceeded");
    reads++;
    const data = await src.read(offset, length);
    if (data.length < length) throw reject("truncated", `read ${offset}+${length} returned ${data.length}`);
    return data.length > length ? data.subarray(0, length) : data;
  };
  try {
    return { ok: true, probe: await run(src, read, maxMoovBytes) };
  } catch (e) {
    if (e instanceof ProbeReject) return { ok: false, reason: e.reason, ...(e.detail ? { detail: e.detail } : {}) };
    throw e;
  }
}

async function run(
  src: ByteSource,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  maxMoovBytes: number,
): Promise<Mp4Probe> {
  const size = src.size;
  if (!Number.isSafeInteger(size) || size < 8) throw reject("not_mp4", "too small");

  // Top level: headers only. mdat is never read.
  let offset = 0;
  let first = true;
  let moov: { offset: number; size: number; hdr: number } | null = null;
  let firstMdat: number | null = null;
  while (offset < size) {
    const remaining = size - offset;
    if (remaining < 8) throw reject("box_size_invalid", "trailing bytes");
    const h = await read(offset, Math.min(16, remaining));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let boxSize = dv.getUint32(0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (first && type !== "ftyp") throw reject("not_mp4", "no ftyp");
    first = false;
    if (boxSize === 1) {
      if (remaining < 16) throw reject("box_size_invalid", `${type} largesize`);
      const big = dv.getBigUint64(8);
      if (big > BigInt(remaining)) throw reject("box_size_invalid", `${type} past EOF`);
      boxSize = Number(big);
      hdr = 16;
    } else if (boxSize === 0) {
      boxSize = remaining;
    }
    if (boxSize < hdr || boxSize > remaining) throw reject("box_size_invalid", `${type} size ${boxSize}`);
    if (type === "moof") throw reject("fragmented");
    if (type === "moov" && !moov) moov = { offset, size: boxSize, hdr };
    if (type === "mdat" && firstMdat === null) firstMdat = offset;
    offset += boxSize;
  }
  if (!moov) throw reject("moov_missing");
  if (moov.size > maxMoovBytes) throw reject("moov_too_large", `${moov.size} bytes`);
  const fastStart = firstMdat === null || moov.offset < firstMdat;

  // moov: one read, parsed in memory.
  const buf = await read(moov.offset + moov.hdr, moov.size - moov.hdr);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = boxes(buf, dv, 0, buf.length, 1);
  if (top.some((b) => b.type === "mvex")) throw reject("fragmented", "mvex");

  const mvhd = top.find((b) => b.type === "mvhd");
  if (!mvhd) throw reject("moov_missing", "mvhd");
  need(mvhd, 20);
  const movieTimescale = dv.getUint32(mvhd.start + (dv.getUint8(mvhd.start) === 1 ? 20 : 12));

  const tracks: TrackLight[] = top
    .filter((b) => b.type === "trak")
    .map((trak) => {
      const kids = boxes(buf, dv, trak.start, trak.end, 2);
      const tkhd = kids.find((b) => b.type === "tkhd");
      const mdia = kids.find((b) => b.type === "mdia");
      if (!tkhd || !mdia) throw reject("moov_missing", "trak without tkhd/mdia");
      need(tkhd, 4);
      const v1 = dv.getUint8(tkhd.start) === 1;
      need(tkhd, v1 ? 92 : 84);
      const enabled = (dv.getUint8(tkhd.start + 3) & 1) === 1;
      const id = dv.getUint32(tkhd.start + (v1 ? 20 : 12));
      const mkids = boxes(buf, dv, mdia.start, mdia.end, 3);
      const hdlr = mkids.find((b) => b.type === "hdlr");
      if (!hdlr) throw reject("moov_missing", "hdlr");
      need(hdlr, 12);
      return { id, enabled, handler: fourcc(buf, hdlr.start + 8), kids, tkhd, mdia };
    });

  const videos = tracks.filter((t) => t.handler === "vide" && t.enabled);
  const hasAudio = tracks.some((t) => t.handler === "soun");
  if (videos.length === 0) throw reject("no_video_track");
  if (videos.length > 1) throw reject("multiple_video_tracks");
  const video = videos[0]!;

  const media = parseMedia(buf, dv, video);

  // Codec
  if (media.entryType === "hvc1" || media.entryType === "hev1" || media.entryType === "dvh1" || media.entryType === "dvhe") {
    throw reject("hevc");
  }
  if ((media.entryType !== "avc1" && media.entryType !== "avc3") || !media.avcC) {
    throw reject("unsupported_codec", media.entryType);
  }
  const codec = media.entryType;

  // Constant frame rate from stts alone. Ctts (B-frames) is irrelevant.
  const { entries } = media;
  let totalSamples = 0;
  let delta = -1;
  for (let i = 0; i < entries.length; i += 2) {
    const count = entries[i]!;
    const d = entries[i + 1]!;
    totalSamples += count;
    const isFinalSingle = i === entries.length - 2 && entries.length > 2 && count === 1;
    if (d === 0) throw reject("variable_frame_rate", "zero delta");
    if (isFinalSingle) continue;
    if (delta === -1) delta = d;
    else if (d !== delta) throw reject("variable_frame_rate", `deltas ${delta} and ${d}`);
  }
  if (totalSamples === 0 || delta === -1) throw reject("zero_frames");
  const ts = media.timescale;
  if (!isSupportedRate(ts, delta)) throw reject("unsupported_frame_rate", `${ts}/${delta}`);
  const fps = rational(ts, delta);

  // Edit list: none, or exactly one plain entry.
  let skip = 0;
  let frameCount = totalSamples;
  const elst = video.kids.find((b) => b.type === "edts");
  if (elst) {
    const ekids = boxes(buf, dv, elst.start, elst.end, 3);
    const e = ekids.find((b) => b.type === "elst");
    if (e) {
      need(e, 8);
      const v1 = dv.getUint8(e.start) === 1;
      const count = dv.getUint32(e.start + 4);
      const entrySize = v1 ? 20 : 12;
      if (count > Math.floor((e.end - e.start - 8) / entrySize)) throw reject("box_size_invalid", "elst entries");
      if (count > 1) throw reject("unsupported_edit_list", "multiple entries");
      if (count === 1) {
        const at = e.start + 8;
        const segDur = v1 ? exactSafe(dv.getBigUint64(at), "segment_duration") : dv.getUint32(at);
        const mediaTime = v1 ? exactSafe(dv.getBigInt64(at + 8), "media_time") : dv.getInt32(at + 4);
        const rateAt = at + (v1 ? 16 : 8);
        if (dv.getInt16(rateAt) !== 1 || dv.getInt16(rateAt + 2) !== 0) throw reject("unsupported_edit_list", "rate");
        if (mediaTime < 0) throw reject("unsupported_edit_list", "empty edit");
        if (mediaTime % delta !== 0) throw reject("unsupported_edit_list", "media_time not frame aligned");
        skip = mediaTime / delta;
        frameCount = totalSamples - skip;
        if (segDur > 0 && movieTimescale > 0) {
          // segment_duration is in movie timescale; round to the nearest frame to absorb its rounding.
          const num = BigInt(segDur) * BigInt(ts);
          const den = BigInt(movieTimescale) * BigInt(delta);
          const frames = Number((2n * num + den) / (2n * den));
          frameCount = Math.min(frameCount, frames);
        }
      }
    }
  }
  if (frameCount <= 0) throw reject("zero_frames");

  // Transform
  const m = media.matrix;
  const [a, b, u, c, d, v, , , w] = m;
  if (u !== 0 || v !== 0 || w !== 0x40000000) throw reject("unsupported_transform", "projective");
  let swap: boolean;
  if (a === 0x10000 && b === 0 && c === 0 && d === 0x10000) swap = false;
  else if (a === -0x10000 && b === 0 && c === 0 && d === -0x10000) swap = false;
  else if (a === 0 && d === 0 && ((b === 0x10000 && c === -0x10000) || (b === -0x10000 && c === 0x10000))) swap = true;
  else throw reject("unsupported_transform", "matrix");
  const width = swap ? media.height : media.width;
  const height = swap ? media.width : media.height;

  const durationMs = Number((BigInt(frameCount) * BigInt(delta) * 1000n * 2n + BigInt(ts)) / (2n * BigInt(ts)));

  const warnings: Mp4ProbeWarning[] = [];
  if (!fastStart) warnings.push("not_fast_start");

  // Timecode
  let startTimecode: Mp4Probe["startTimecode"] = null;
  const refIds = readTmcdRefs(buf, dv, video);
  const tmcdTracks = tracks.filter((t) => t.handler === "tmcd");
  const tmcdTrack = tmcdTracks.find((t) => refIds.includes(t.id)) ?? (tmcdTracks.length === 1 ? tmcdTracks[0] : undefined);
  if (tmcdTrack) {
    const tc = parseTmcd(buf, dv, tmcdTrack);
    if (tc) {
      if (tc.numberOfFrames !== Math.round(rationalToNumber(fps))) {
        warnings.push("timecode_rate_mismatch");
      } else if (tc.sampleOffset !== null && tc.sampleOffset + 4 <= src.size) {
        const s = await read(tc.sampleOffset, 4);
        startTimecode = {
          frames: new DataView(s.buffer, s.byteOffset, 4).getUint32(0),
          dropFrame: (tc.flags & 1) === 1,
          nominalFps: tc.numberOfFrames,
        };
      }
    }
  }

  return {
    codec,
    codecString: `${codec}.${hex2(media.avcC[0]!)}${hex2(media.avcC[1]!)}${hex2(media.avcC[2]!)}`,
    fps,
    mediaTimescale: ts,
    frameDelta: delta,
    frameCount,
    durationMs,
    width,
    height,
    startTimecode,
    fastStart,
    hasAudio,
    warnings,
  };
}

type Media = {
  timescale: number;
  entryType: string;
  avcC: Uint8Array | null;
  width: number;
  height: number;
  matrix: number[];
  /** Flattened [count, delta, count, delta, ...]. */
  entries: number[];
};

function stblOf(buf: Uint8Array, dv: DataView, t: TrackLight): { mdhd: MBox; stbl: MBox[] } {
  const mkids = boxes(buf, dv, t.mdia.start, t.mdia.end, 3);
  const mdhd = mkids.find((b) => b.type === "mdhd");
  const minf = mkids.find((b) => b.type === "minf");
  if (!mdhd || !minf) throw reject("moov_missing", "mdhd/minf");
  const stbl = boxes(buf, dv, minf.start, minf.end, 4).find((b) => b.type === "stbl");
  if (!stbl) throw reject("moov_missing", "stbl");
  return { mdhd, stbl: boxes(buf, dv, stbl.start, stbl.end, 5) };
}

function mdhdTimescale(dv: DataView, mdhd: MBox): number {
  need(mdhd, 4);
  const v1 = dv.getUint8(mdhd.start) === 1;
  need(mdhd, v1 ? 24 : 16);
  const ts = dv.getUint32(mdhd.start + (v1 ? 20 : 12));
  if (ts === 0) throw reject("box_size_invalid", "mdhd timescale 0");
  return ts;
}

function parseMedia(buf: Uint8Array, dv: DataView, t: TrackLight): Media {
  const { mdhd, stbl } = stblOf(buf, dv, t);
  const timescale = mdhdTimescale(dv, mdhd);

  const stsd = stbl.find((b) => b.type === "stsd");
  if (!stsd) throw reject("moov_missing", "stsd");
  need(stsd, 16);
  const entryStart = stsd.start + 8;
  const entrySize = dv.getUint32(entryStart);
  if (entrySize < 8 || entryStart + entrySize > stsd.end) throw reject("box_size_invalid", "sample entry");
  const entryType = fourcc(buf, entryStart + 4);
  let avcC: Uint8Array | null = null;
  let sw = 0;
  let sh = 0;
  if (entrySize >= 86) {
    sw = dv.getUint16(entryStart + 32);
    sh = dv.getUint16(entryStart + 34);
    for (const k of boxes(buf, dv, entryStart + 86, entryStart + entrySize, 6)) {
      if (k.type === "avcC" && k.end - k.start >= 4) avcC = buf.subarray(k.start + 1, k.start + 4);
    }
  }

  const sttsBox = stbl.find((b) => b.type === "stts");
  if (!sttsBox) throw reject("moov_missing", "stts");
  need(sttsBox, 8);
  const n = dv.getUint32(sttsBox.start + 4);
  if (n > Math.floor((sttsBox.end - sttsBox.start - 8) / 8)) throw reject("box_size_invalid", "stts entries");
  const entries: number[] = [];
  for (let i = 0; i < n; i++) {
    entries.push(dv.getUint32(sttsBox.start + 8 + i * 8), dv.getUint32(sttsBox.start + 12 + i * 8));
  }

  const tkhd = t.tkhd;
  const v1 = dv.getUint8(tkhd.start) === 1;
  const mAt = tkhd.start + (v1 ? 52 : 40);
  const matrix: number[] = [];
  for (let i = 0; i < 9; i++) matrix.push(dv.getInt32(mAt + i * 4));
  const width = dv.getUint32(mAt + 36) >>> 16 || sw;
  const height = dv.getUint32(mAt + 40) >>> 16 || sh;
  return { timescale, entryType, avcC, width, height, matrix, entries };
}

function readTmcdRefs(buf: Uint8Array, dv: DataView, t: TrackLight): number[] {
  const tref = t.kids.find((b) => b.type === "tref");
  if (!tref) return [];
  const ids: number[] = [];
  for (const k of boxes(buf, dv, tref.start, tref.end, 3)) {
    if (k.type !== "tmcd") continue;
    for (let p = k.start; p + 4 <= k.end; p += 4) ids.push(dv.getUint32(p));
  }
  return ids;
}

/** Timecode track description plus the file offset of its first sample (null when it cannot be located). */
function parseTmcd(
  buf: Uint8Array,
  dv: DataView,
  t: TrackLight,
): { flags: number; numberOfFrames: number; sampleOffset: number | null } | null {
  const { stbl } = stblOf(buf, dv, t);
  const stsd = stbl.find((b) => b.type === "stsd");
  if (!stsd) return null;
  need(stsd, 16);
  const es = stsd.start + 8;
  const esize = dv.getUint32(es);
  if (esize < 34 || es + esize > stsd.end || fourcc(buf, es + 4) !== "tmcd") return null;
  const flags = dv.getUint32(es + 20);
  const numberOfFrames = dv.getUint8(es + 32);

  let firstChunk = 1;
  const stsc = stbl.find((b) => b.type === "stsc");
  if (stsc) {
    need(stsc, 8);
    if (dv.getUint32(stsc.start + 4) >= 1) {
      need(stsc, 12);
      firstChunk = dv.getUint32(stsc.start + 8);
    }
  }
  let sampleOffset: number | null = null;
  const co = stbl.find((b) => b.type === "stco" || b.type === "co64");
  if (co && firstChunk >= 1) {
    need(co, 8);
    const wide = co.type === "co64";
    const count = dv.getUint32(co.start + 4);
    const w = wide ? 8 : 4;
    if (firstChunk <= count && co.start + 8 + firstChunk * w <= co.end) {
      const at = co.start + 8 + (firstChunk - 1) * w;
      sampleOffset = wide ? exactSafe(dv.getBigUint64(at), "co64") : dv.getUint32(at);
    }
  }
  return { flags, numberOfFrames, sampleOffset };
}
