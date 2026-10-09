import type { ByteSource } from "../../src/video-mp4-probe";

/** Test-only MP4 builder. Nothing is checked in as a binary: files are assembled here, and `mdat` (and
 *  any padding) is a sparse virtual region whose reads return zeros, so multi-GB files cost nothing. */

const enc = new TextEncoder();

export function u8(...v: number[]): Uint8Array {
  return Uint8Array.from(v);
}
export function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff);
  return b;
}
export function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
export function u64(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(v)));
  return b;
}
export function fixed16_16(v: number): Uint8Array {
  return u32(Math.round(v * 65536));
}
export function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(8 + body.length), enc.encode(type), body);
}
export function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);
}
/** A header with an arbitrary (possibly lying) 32-bit size field, for malformed-box tests. */
export function rawBox(size: number, type: string, ...parts: Uint8Array[]): Uint8Array {
  return concat(u32(size), enc.encode(type), ...parts);
}

export type Segment = Uint8Array | { zeros: number };

export type BuiltSource = ByteSource & { reads: number };

/** A ByteSource over real byte segments and virtual zero runs. Short only at EOF (like R2/File.slice). */
export function sourceFrom(segments: Segment[]): BuiltSource {
  const starts: number[] = [];
  let size = 0;
  for (const s of segments) {
    starts.push(size);
    size += s instanceof Uint8Array ? s.length : s.zeros;
  }
  const src: BuiltSource = {
    size,
    reads: 0,
    async read(offset, length) {
      src.reads++;
      const end = Math.min(offset + length, size);
      const out = new Uint8Array(Math.max(0, end - offset));
      segments.forEach((s, i) => {
        if (!(s instanceof Uint8Array)) return;
        const a = Math.max(offset, starts[i]);
        const b = Math.min(end, starts[i] + s.length);
        if (a < b) out.set(s.subarray(a - starts[i], b - starts[i]), a - offset);
      });
      return out;
    },
  };
  return src;
}

export type TrackSpec = {
  id?: number;
  handler: "vide" | "soun" | "tmcd";
  enabled?: boolean;
  timescale?: number;
  /** [sampleCount, sampleDelta] runs. */
  stts?: Array<[number, number]>;
  /** Sample entry fourcc for vide (default avc1). */
  codec?: string;
  avcC?: { profile: number; compat: number; level: number } | false;
  width?: number;
  height?: number;
  /** Nine raw int32 matrix values (a b u c d v x y w). Default identity. */
  matrix?: number[];
  elst?: Array<{ segmentDuration: number; mediaTime: number; rateInt?: number; rateFrac?: number }>;
  elstVersion?: 0 | 1;
  /** tref/tmcd: ids of the timecode tracks this track references. */
  tref?: number[];
  tmcd?: { flags: number; timescale: number; frameDuration: number; numberOfFrames: number; startFrame: number };
  co64?: boolean;
};

export type Mp4Spec = {
  tracks: TrackSpec[];
  movieTimescale?: number;
  moovFirst?: boolean;
  mvex?: boolean;
  /** Extra declared bytes inside moov (a virtual `free` box), to make moov large. */
  moovPad?: number;
  mdat?: { payload?: number; use64?: boolean; sizeZero?: boolean; tmcdAtEnd?: boolean };
  /** Raw top-level boxes placed after ftyp (before moov/mdat). */
  before?: Uint8Array[];
  /** Raw top-level boxes placed at the very end. */
  after?: Uint8Array[];
};

export const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
export const ROTATE_90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];
export const ROTATE_180 = [-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000];
export const ROTATE_270 = [0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000];
export const SKEW = [0x10000, 0x4000, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

export function ftyp(): Uint8Array {
  return box("ftyp", enc.encode("isom"), u32(512), enc.encode("isomavc1"));
}

function trak(t: TrackSpec, i: number, chunkOffset: number): Uint8Array {
  const id = t.id ?? i + 1;
  const timescale = t.timescale ?? (t.handler === "soun" ? 48000 : 30000);
  const matrix = t.matrix ?? IDENTITY;
  const tkhd = fullBox(
    "tkhd",
    0,
    t.enabled === false ? 0 : 3,
    u32(0), u32(0), u32(id), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0),
    ...matrix.map((m) => u32(m)),
    fixed16_16(t.width ?? 1920),
    fixed16_16(t.height ?? 1080),
  );
  const elstVersion = t.elstVersion ?? 0;
  const edts = t.elst
    ? box(
        "edts",
        fullBox(
          "elst",
          elstVersion,
          0,
          u32(t.elst.length),
          ...t.elst.map((e) =>
            concat(
              elstVersion === 1 ? u64(e.segmentDuration) : u32(e.segmentDuration),
              elstVersion === 1 ? u64(e.mediaTime) : u32(e.mediaTime),
              u16(e.rateInt ?? 1),
              u16(e.rateFrac ?? 0),
            ),
          ),
        ),
      )
    : new Uint8Array(0);
  const tref = t.tref ? box("tref", box("tmcd", ...t.tref.map((x) => u32(x)))) : new Uint8Array(0);
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), enc.encode(t.handler), zeros(12), u8(0));
  let entry: Uint8Array;
  if (t.handler === "vide") {
    const a = t.avcC === undefined ? { profile: 0x64, compat: 0, level: 0x1f } : t.avcC;
    entry = box(
      t.codec ?? "avc1",
      zeros(6), u16(1), zeros(16), u16(t.width ?? 1920), u16(t.height ?? 1080),
      u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff),
      a ? box("avcC", u8(1, a.profile, a.compat, a.level, 0xff, 0xe0, 0)) : new Uint8Array(0),
    );
  } else if (t.handler === "tmcd") {
    const c = t.tmcd ?? { flags: 0, timescale: 30, frameDuration: 1, numberOfFrames: 30, startFrame: 0 };
    entry = box("tmcd", zeros(6), u16(1), u32(0), u32(c.flags), u32(c.timescale), u32(c.frameDuration), u8(c.numberOfFrames, 0));
  } else {
    entry = box("mp4a", zeros(6), u16(1), zeros(20));
  }
  const stts = t.stts ?? (t.handler === "tmcd" ? [[1, 1]] : [[300, 1001]]);
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), entry),
    fullBox("stts", 0, 0, u32(stts.length), ...stts.map(([c, d]) => concat(u32(c), u32(d)))),
    fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox("stsz", 0, 0, u32(4), u32(1)),
    t.co64 ? fullBox("co64", 0, 0, u32(1), u64(chunkOffset)) : fullBox("stco", 0, 0, u32(1), u32(chunkOffset)),
  );
  return box("trak", tkhd, edts, tref, box("mdia", mdhd, hdlr, box("minf", stbl)));
}

/** The moov body (everything after its 8-byte header). Chunk offsets are written as `tmcdOffset`. */
export function moovBody(spec: Mp4Spec, mdatPayloadOffset: number, tmcdOffset: number): Uint8Array {
  const mvhd = fullBox(
    "mvhd", 0, 0,
    u32(0), u32(0), u32(spec.movieTimescale ?? 1000), u32(0), u32(0x10000), u16(0x100), zeros(10),
    ...IDENTITY.map((m) => u32(m)),
    zeros(24), u32(spec.tracks.length + 1),
  );
  return concat(
    mvhd,
    ...spec.tracks.map((t, i) => trak(t, i, t.handler === "tmcd" ? tmcdOffset : mdatPayloadOffset)),
    spec.mvex ? box("mvex", fullBox("trex", 0, 0, zeros(20))) : new Uint8Array(0),
  );
}

function moovSegments(spec: Mp4Spec, mdatPayloadOffset: number, tmcdOffset: number): Segment[] {
  const body = moovBody(spec, mdatPayloadOffset, tmcdOffset);
  const pad = spec.moovPad ?? 0;
  if (pad === 0) return [concat(u32(8 + body.length), enc.encode("moov"), body)];
  return [concat(u32(8 + body.length + pad), enc.encode("moov"), body, u32(pad), enc.encode("free")), { zeros: pad - 8 }];
}
const segLen = (segs: Segment[]) => segs.reduce((n, s) => n + (s instanceof Uint8Array ? s.length : s.zeros), 0);

/** Assembles ftyp, moov and a sparse virtual mdat. A tmcd track's start frame sits in the mdat. */
export function buildMp4(spec: Mp4Spec): BuiltSource {
  const moovFirst = spec.moovFirst ?? true;
  const m = spec.mdat ?? {};
  const payload = m.payload ?? 1000;
  const use64 = m.use64 ?? false;
  const headerLen = use64 ? 16 : 8;
  const before = spec.before ?? [];
  const after = spec.after ?? [];
  const startFrame = spec.tracks.find((t) => t.handler === "tmcd")?.tmcd?.startFrame ?? 0;
  const lead = segLen([ftyp(), ...before]);
  const moovLen = segLen(moovSegments(spec, 0, 0));
  const payloadOffset = lead + (moovFirst ? moovLen : 0) + headerLen;
  const tmcdOffset = m.tmcdAtEnd ? payloadOffset + payload - 4 : payloadOffset;
  const mdatSize = headerLen + payload;
  const mdatHeader = m.sizeZero
    ? concat(u32(0), enc.encode("mdat"))
    : use64
      ? concat(u32(1), enc.encode("mdat"), u64(mdatSize))
      : concat(u32(mdatSize), enc.encode("mdat"));
  const sample = u32(startFrame);
  const mdatSegs: Segment[] = m.tmcdAtEnd
    ? [mdatHeader, { zeros: payload - 4 }, sample]
    : [mdatHeader, sample, { zeros: payload - 4 }];
  const moov = moovSegments(spec, payloadOffset, tmcdOffset);
  return sourceFrom([
    ftyp(),
    ...before,
    ...(moovFirst ? moov : []),
    ...mdatSegs,
    ...(moovFirst ? [] : moov),
    ...after,
  ]);
}

/** A 30000/1001 H.264 video track, 300 frames, 1920x1080: the baseline every test varies. */
export function videoTrack(over: Partial<TrackSpec> = {}): TrackSpec {
  return { handler: "vide", timescale: 30000, stts: [[300, 1001]], ...over };
}
