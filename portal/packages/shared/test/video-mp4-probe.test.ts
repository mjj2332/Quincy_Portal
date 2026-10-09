import { describe, expect, it } from "vitest";
import {
  MP4_PROBE_LIMITS,
  VIDEO_MAX_BYTES,
  mp4RejectMessage,
  probeMp4,
  type ByteSource,
  type Mp4RejectReason,
} from "../src/video-mp4-probe";
import {
  IDENTITY,
  ROTATE_180,
  ROTATE_270,
  ROTATE_90,
  SKEW,
  box,
  buildMp4,
  concat,
  ftyp,
  moovBody,
  rawBox,
  sourceFrom,
  u32,
  u8,
  u16,
  u64,
  videoTrack,
  type Mp4Spec,
  type TrackSpec,
} from "./fixtures/mp4-builder";

const probeOf = async (spec: Mp4Spec) => {
  const r = await probeMp4(buildMp4(spec));
  if (!r.ok) throw new Error(`rejected: ${r.reason} ${r.detail ?? ""}`);
  return r.probe;
};
const reasonOf = async (src: ByteSource, limits?: Partial<typeof MP4_PROBE_LIMITS>) => {
  const r = await probeMp4(src, limits);
  return r.ok ? "ok" : r.reason;
};
const one = (t: TrackSpec, extra: Partial<Mp4Spec> = {}): Mp4Spec => ({ tracks: [t], ...extra });

describe("probeMp4 happy path", () => {
  it("moov-first probes a 29.97 H.264 file", async () => {
    const p = await probeOf(one(videoTrack(), { tracks: [videoTrack(), { handler: "soun" }] }));
    expect(p).toMatchObject({
      codec: "avc1",
      codecString: "avc1.64001F",
      fps: { num: 30000, den: 1001 },
      mediaTimescale: 30000,
      frameDelta: 1001,
      frameCount: 300,
      durationMs: 10010,
      width: 1920,
      height: 1080,
      startTimecode: null,
      fastStart: true,
      hasAudio: true,
      warnings: [],
    });
  });

  it("moov-last is accepted with a not_fast_start warning", async () => {
    const p = await probeOf(one(videoTrack(), { moovFirst: false }));
    expect(p.fastStart).toBe(false);
    expect(p.warnings).toEqual(["not_fast_start"]);
  });

  it("avc3 sample entries are accepted and keep their prefix", async () => {
    const p = await probeOf(one(videoTrack({ codec: "avc3", avcC: { profile: 0x4d, compat: 0x40, level: 0x28 } })));
    expect(p.codec).toBe("avc3");
    expect(p.codecString).toBe("avc3.4D4028");
  });

  it("a 64-bit mdat with a 2.1 GB virtual size still probes (the size check is the API's)", async () => {
    const src = buildMp4(one(videoTrack(), { mdat: { use64: true, payload: 2_100_000_000 } }));
    expect(src.size).toBeGreaterThan(VIDEO_MAX_BYTES);
    const r = await probeMp4(src);
    expect(r.ok).toBe(true);
    expect(src.reads).toBeLessThanOrEqual(5);
  });

  it("moov-last with a >4 GiB virtual mdat probes", async () => {
    const r = await probeMp4(buildMp4(one(videoTrack(), { moovFirst: false, mdat: { use64: true, payload: 5 * 1024 ** 3 } })));
    expect(r.ok).toBe(true);
  });

  it("a size-0 mdat extends to EOF", async () => {
    expect((await probeMp4(buildMp4(one(videoTrack(), { mdat: { sizeZero: true } })))).ok).toBe(true);
  });

  it("exports the decimal 2 GB cap", () => {
    expect(VIDEO_MAX_BYTES).toBe(2_000_000_000);
  });
});

describe("probeMp4 box structure", () => {
  const good = () => buildMp4(one(videoTrack()));
  const goodMoov = () => concat(u32(8 + moovBody(one(videoTrack()), 100, 100).length), new TextEncoder().encode("moov"), moovBody(one(videoTrack()), 100, 100));

  it.each<[string, () => ByteSource, Mp4RejectReason]>([
    ["empty file", () => sourceFrom([new Uint8Array(0)]), "not_mp4"],
    ["no ftyp first", () => sourceFrom([box("free", new Uint8Array(8))]), "not_mp4"],
    ["no moov", () => sourceFrom([ftyp(), box("mdat", new Uint8Array(8))]), "moov_missing"],
    ["moof", () => buildMp4(one(videoTrack(), { before: [box("moof", new Uint8Array(8))] })), "fragmented"],
    ["mvex in moov", () => buildMp4(one(videoTrack(), { mvex: true })), "fragmented"],
    ["moov 17 MiB", () => buildMp4(one(videoTrack(), { moovPad: 17 * 1024 * 1024 })), "moov_too_large"],
    ["box size < 8 at top level", () => sourceFrom([ftyp(), rawBox(4, "free", new Uint8Array(8))]), "box_size_invalid"],
    ["box size past EOF at top level", () => sourceFrom([ftyp(), rawBox(1000, "free", new Uint8Array(8))]), "box_size_invalid"],
    ["64-bit size beyond the file", () => sourceFrom([ftyp(), concat(u32(1), new TextEncoder().encode("mdat"), new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]))]), "box_size_invalid"],
    ["moov truncated by EOF", () => { const m = goodMoov(); return sourceFrom([ftyp(), m.subarray(0, m.length - 10)]); }, "box_size_invalid"],
    ["child box past its parent", () => sourceFrom([ftyp(), box("moov", rawBox(500, "mvhd", new Uint8Array(100)))]), "box_size_invalid"],
    ["child box size < 8", () => sourceFrom([ftyp(), box("moov", rawBox(3, "mvhd", new Uint8Array(100)))]), "box_size_invalid"],
  ])("%s -> %s", async (_n, make, reason) => {
    expect(await reasonOf(make())).toBe(reason);
  });

  it("a short read from the source is truncated", async () => {
    const inner = good();
    const short: ByteSource = {
      size: inner.size,
      read: async (o, l) => (l > 100 ? (await inner.read(o, l)).subarray(0, l - 1) : inner.read(o, l)),
    };
    expect(await reasonOf(short)).toBe("truncated");
  });

  it("the read budget is enforced", async () => {
    const boxes = Array.from({ length: 10 }, () => box("free", new Uint8Array(8)));
    const src = sourceFrom([ftyp(), ...boxes]);
    expect(await reasonOf(src, { maxReads: 5 })).toBe("read_budget_exceeded");
    expect(await reasonOf(good(), { maxReads: 2 })).toBe("read_budget_exceeded");
    expect(await reasonOf(good())).toBe("ok");
  });

  it("padding under 8 bytes inside a container is ignored", async () => {
    const body = concat(moovBody(one(videoTrack()), 100, 100), new Uint8Array(4));
    const r = await probeMp4(sourceFrom([ftyp(), concat(u32(8 + body.length), new TextEncoder().encode("moov"), body)]));
    expect(r.ok).toBe(true);
  });
});

describe("probeMp4 tracks and codecs", () => {
  it.each<[string, Mp4Spec, Mp4RejectReason]>([
    ["no video track", { tracks: [{ handler: "soun" }] }, "no_video_track"],
    ["only a disabled video track", one(videoTrack({ enabled: false })), "no_video_track"],
    ["two video tracks", { tracks: [videoTrack(), videoTrack()] }, "multiple_video_tracks"],
    ["hvc1", one(videoTrack({ codec: "hvc1" })), "hevc"],
    ["mp4v", one(videoTrack({ codec: "mp4v" })), "unsupported_codec"],
    ["avc1 without avcC", one(videoTrack({ avcC: false })), "unsupported_codec"],
    ["zero frames", one(videoTrack({ stts: [[0, 1001]] })), "zero_frames"],
  ])("%s -> %s", async (_n, spec, reason) => {
    expect(await reasonOf(buildMp4(spec))).toBe(reason);
  });
});

describe("probeMp4 frame rate", () => {
  it.each<[string, TrackSpec["stts"], number, Mp4RejectReason | "ok"]>([
    ["two deltas (VFR)", [[100, 1001], [100, 2002]], 30000, "variable_frame_rate"],
    ["zero delta", [[100, 0]], 30000, "variable_frame_rate"],
    ["a final entry with count 1 is exempt", [[299, 1001], [1, 700]], 30000, "ok"],
    ["a final entry with count 2 is not exempt", [[299, 1001], [2, 700]], 30000, "variable_frame_rate"],
    ["a non-final count-1 entry is not exempt", [[1, 700], [299, 1001]], 30000, "variable_frame_rate"],
    ["12.4 fps is unsupported", [[100, 41]], 508, "unsupported_frame_rate"],
    ["1000/41 is unsupported", [[100, 41]], 1000, "unsupported_frame_rate"],
  ])("%s", async (_n, stts, timescale, expected) => {
    expect(await reasonOf(buildMp4(one(videoTrack({ stts, timescale }))))).toBe(expected);
  });

  it.each<[string, number, number, number, number]>([
    ["23.976 as 24000/1001", 24000, 1001, 24000, 1001],
    ["24 fps", 24, 1, 24, 1],
    ["25 fps as 12800/512", 12800, 512, 25, 1],
    ["29.97 as 30000/1001", 30000, 1001, 30000, 1001],
    ["29.97 as 2997/100", 2997, 100, 2997, 100],
    ["59.94", 60000, 1001, 60000, 1001],
    ["120 fps", 12000, 100, 120, 1],
  ])("%s keeps the exact reduced rational", async (_n, timescale, delta, num, den) => {
    const p = await probeOf(one(videoTrack({ timescale, stts: [[100, delta]] })));
    expect(p.fps).toEqual({ num, den });
    expect(p.mediaTimescale).toBe(timescale);
    expect(p.frameDelta).toBe(delta);
  });
});

describe("probeMp4 edit lists", () => {
  const e = (mediaTime: number, over: Record<string, number> = {}) => ({ segmentDuration: 0, mediaTime, ...over });

  it("a B-frame edit (media_time = 2 * delta) is accepted and trims the frame count", async () => {
    const p = await probeOf(one(videoTrack({ elst: [e(2002)] })));
    expect(p.frameCount).toBe(298);
  });

  it("segment_duration also bounds the frame count (rounded to the nearest frame)", async () => {
    // 296 frames at 30000/1001 in a 1000 timescale = 9876.5 -> 9877
    const p = await probeOf(one(videoTrack({ elst: [{ segmentDuration: 9877, mediaTime: 2002 }] }), { movieTimescale: 1000 }));
    expect(p.frameCount).toBe(296);
    expect(p.durationMs).toBe(Math.round((296 * 1001 * 1000) / 30000));
  });

  it("a version 1 elst is read", async () => {
    const p = await probeOf(one(videoTrack({ elstVersion: 1, elst: [e(1001)] })));
    expect(p.frameCount).toBe(299);
  });

  it("an elst with zero entries means no edit", async () => {
    expect((await probeOf(one(videoTrack({ elst: [] })))).frameCount).toBe(300);
  });

  it.each<[string, TrackSpec["elst"]]>([
    ["empty edit (media_time -1)", [e(-1)]],
    ["two entries", [e(0), e(1001)]],
    ["non-aligned media_time", [e(1500)]],
    ["rate 0.5", [e(0, { rateInt: 0, rateFrac: 0x8000 })]],
    ["rate 2.0", [e(0, { rateInt: 2 })]],
  ])("%s -> unsupported_edit_list", async (_n, elst) => {
    expect(await reasonOf(buildMp4(one(videoTrack({ elst }))))).toBe("unsupported_edit_list");
  });

  it("an edit that removes every frame -> zero_frames", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack({ elst: [e(300 * 1001)] }))))).toBe("zero_frames");
  });
});

describe("probeMp4 transform", () => {
  it("identity and 180 keep dimensions", async () => {
    expect(await probeOf(one(videoTrack({ matrix: IDENTITY })))).toMatchObject({ width: 1920, height: 1080 });
    expect(await probeOf(one(videoTrack({ matrix: ROTATE_180 })))).toMatchObject({ width: 1920, height: 1080 });
  });
  it.each([
    ["90", ROTATE_90],
    ["270", ROTATE_270],
  ])("%s degrees swaps width and height", async (_n, matrix) => {
    expect(await probeOf(one(videoTrack({ matrix })))).toMatchObject({ width: 1080, height: 1920 });
  });
  it("a skew matrix is rejected", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack({ matrix: SKEW }))))).toBe("unsupported_transform");
  });
  it("a scaling matrix is rejected", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack({ matrix: [0x20000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000] }))))).toBe("unsupported_transform");
  });
});

describe("probeMp4 timecode", () => {
  const tmcd = (over: Partial<NonNullable<TrackSpec["tmcd"]>> = {}): TrackSpec => ({
    handler: "tmcd",
    timescale: 30000,
    tmcd: { flags: 1, timescale: 30000, frameDuration: 1001, numberOfFrames: 30, startFrame: 107892, ...over },
  });

  it("drop-frame 29.97 with start sample 107892", async () => {
    const p = await probeOf({ tracks: [videoTrack(), tmcd()] });
    expect(p.startTimecode).toEqual({ frames: 107892, dropFrame: true, nominalFps: 30 });
    expect(p.warnings).toEqual([]);
  });

  it("flags bit 0 clear means non-drop", async () => {
    const p = await probeOf({ tracks: [videoTrack(), tmcd({ flags: 0 })] });
    expect(p.startTimecode).toMatchObject({ dropFrame: false });
  });

  it("a mismatched nominal rate drops the timecode with a warning", async () => {
    const p = await probeOf({ tracks: [videoTrack(), tmcd({ numberOfFrames: 25 })] });
    expect(p.startTimecode).toBeNull();
    expect(p.warnings).toEqual(["timecode_rate_mismatch"]);
  });

  it("co64 chunk offsets past 4 GiB are followed", async () => {
    const p = await probeOf({
      tracks: [videoTrack(), { ...tmcd(), co64: true }],
      moovFirst: false,
      mdat: { use64: true, payload: 5 * 1024 ** 3, tmcdAtEnd: true },
    });
    expect(p.startTimecode?.frames).toBe(107892);
  });

  it("a tref-referenced tmcd track wins over another", async () => {
    const other = tmcd({ numberOfFrames: 25 }); // would warn if it were chosen
    const p = await probeOf({
      tracks: [{ ...videoTrack(), tref: [3] }, { ...other, id: 2 }, { ...tmcd(), id: 3 }],
    });
    expect(p.startTimecode?.frames).toBe(107892);
    expect(p.warnings).toEqual([]);
  });

  it("two tmcd tracks without a tref give no timecode", async () => {
    const p = await probeOf({ tracks: [videoTrack(), tmcd(), tmcd()] });
    expect(p.startTimecode).toBeNull();
  });
});

describe("probeMp4 sample descriptions and short boxes", () => {
  const avc = { profile: 0x4d, compat: 0x40, level: 0x28 };

  it("an unused avc1 entry 1 with a referenced hvc1 entry 2 is hevc", async () => {
    const t = videoTrack({ stsdExtra: [{ codec: "hvc1" }], stscDesc: 2 });
    expect(await reasonOf(buildMp4(one(t)))).toBe("hevc");
  });

  it("an unused hvc1 entry 1 with a referenced avc1 entry 2 is accepted, codecString from entry 2", async () => {
    const t = videoTrack({ codec: "hvc1", stsdExtra: [{ codec: "avc1", avcC: avc }], stscDesc: 2 });
    const p = await probeOf(one(t));
    expect(p.codecString).toBe("avc1.4D4028");
  });

  it("an stsc index past the stsd entry count is box_size_invalid", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack({ stscDesc: 3 }))))).toBe("box_size_invalid");
  });

  it("more than one referenced description is unsupported_codec", async () => {
    // Two stsc entries referencing descriptions 1 and 2.
    const t = videoTrack({ stsdExtra: [{ codec: "avc1" }] });
    const src = buildMp4(one(t));
    const bytes = await src.read(0, src.size);
    // Rewrite the single stsc entry into two by patching: find "stsc" and rebuild is awkward, so build via raw moov.
    const stsc = box("stsc", u8(0, 0, 0, 0), u32(2), u32(1), u32(1), u32(1), u32(2), u32(1), u32(2));
    const idx = bytes.findIndex((_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === "stsc") - 4;
    expect(idx).toBeGreaterThan(0);
    const oldLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(idx);
    const patched = concat(bytes.subarray(0, idx), stsc, bytes.subarray(idx + oldLen));
    // Fix up enclosing box sizes (stbl, minf, mdia, trak, moov) by growing each by the delta.
    const delta = stsc.length - oldLen;
    const dvp = new DataView(patched.buffer, patched.byteOffset);
    for (const type of ["stbl", "minf", "mdia", "trak", "moov"]) {
      const at = patched.findIndex((_, i) => String.fromCharCode(...patched.subarray(i, i + 4)) === type) - 4;
      dvp.setUint32(at, dvp.getUint32(at) + delta);
    }
    const r = await probeMp4(sourceFrom([patched]));
    expect(r).toMatchObject({ ok: false, reason: "unsupported_codec", detail: "multiple sample descriptions" });
  });

  const v1 = (type: string, len: number) => box(type, u8(1, 0, 0, type === "tkhd" ? 3 : 0), new Uint8Array(len - 4));
  it("a 20-byte version 1 mvhd is box_size_invalid", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack(), { mvhdRaw: v1("mvhd", 20) })))).toBe("box_size_invalid");
  });
  it("a 92-byte version 1 tkhd is box_size_invalid", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack({ tkhdRaw: v1("tkhd", 92) }))))).toBe("box_size_invalid");
  });
  it("a short version 1 mdhd is box_size_invalid", async () => {
    expect(await reasonOf(buildMp4(one(videoTrack({ mdhdRaw: v1("mdhd", 20) }))))).toBe("box_size_invalid");
  });
  it("an stts count larger than its payload is box_size_invalid", async () => {
    const sttsRaw = box("stts", u8(0, 0, 0, 0), u32(1000), u32(300), u32(1001));
    expect(await reasonOf(buildMp4(one(videoTrack({ sttsRaw }))))).toBe("box_size_invalid");
  });

  const tmcdT = (over: Partial<TrackSpec> = {}): TrackSpec => ({
    handler: "tmcd",
    timescale: 30000,
    tmcd: { flags: 1, timescale: 30000, frameDuration: 1001, numberOfFrames: 30, startFrame: 5 },
    ...over,
  });
  const z = u8(0, 0, 0, 0);
  it.each<[string, TrackSpec]>([
    ["video stco declaring 1000 entries", videoTrack({ stcoRaw: box("stco", z, u32(1000), u32(100)) })],
    ["video co64 declaring 1000 entries", videoTrack({ stcoRaw: box("co64", z, u32(1000), u64(100)) })],
    ["video variable stsz declaring 1000 sizes", videoTrack({ stszRaw: box("stsz", z, u32(0), u32(1000)) })],
    ["video stsc declaring 1000 entries", videoTrack({ stscRaw: box("stsc", z, u32(1000), u32(1), u32(1), u32(1)) })],
  ])("%s -> box_size_invalid", async (_n, v) => {
    expect(await reasonOf(buildMp4(one(v)))).toBe("box_size_invalid");
  });
  it.each<[string, TrackSpec]>([
    ["timecode stsc declaring 1000 entries", tmcdT({ stscRaw: box("stsc", z, u32(1000), u32(1), u32(1), u32(1)) })],
    ["timecode stco declaring 1000 entries", tmcdT({ stcoRaw: box("stco", z, u32(1000), u32(100)) })],
    ["timecode variable stsz declaring 1000 sizes", tmcdT({ stszRaw: box("stsz", z, u32(0), u32(1000)) })],
    ["timecode stts declaring 1000 entries", tmcdT({ sttsRaw: box("stts", z, u32(1000), u32(1), u32(1)) })],
    ["tmcd entry of size 20", tmcdT({ entryRaw: box("tmcd", new Uint8Array(12)) })],
    ["tmcd entry overrunning stsd", tmcdT({ entryRaw: rawBox(500, "tmcd", new Uint8Array(40)) })],
  ])("%s -> box_size_invalid", async (_n, tc) => {
    expect(await reasonOf(buildMp4({ tracks: [videoTrack(), tc] }))).toBe("box_size_invalid");
  });
  const tmcdEntry = (flags: number, frames: number) => box("tmcd", zeros6(), u16(1), u32(0), u32(flags), u32(30000), u32(1001), u8(frames, 0));
  const zeros6 = () => new Uint8Array(6);
  const scDesc = (i: number) => box("stsc", z, u32(1), u32(1), u32(1), u32(i));
  it("a tmcd track whose stsc references description 2 reads that description", async () => {
    const tc = tmcdT({ entryRaw: tmcdEntry(0, 25), stsdExtraRaw: [tmcdEntry(1, 30)], stscRaw: scDesc(2) });
    const p = await probeOf({ tracks: [videoTrack(), tc] });
    expect(p.startTimecode).toEqual({ frames: 5, dropFrame: true, nominalFps: 30 });
    expect(p.warnings).toEqual([]);
  });
  it("a tmcd stsc description index out of range -> box_size_invalid", async () => {
    const tc = tmcdT({ stscRaw: scDesc(3) });
    expect(await reasonOf(buildMp4({ tracks: [videoTrack(), tc] }))).toBe("box_size_invalid");
  });
  it("a fixed-size stsz declaring 1000 samples is fine", async () => {
    const v = videoTrack({ stszRaw: box("stsz", z, u32(4), u32(1000)) });
    expect((await probeMp4(buildMp4(one(v)))).ok).toBe(true);
  });
  it("an unknown-type timecode entry still gives no timecode", async () => {
    const p = await probeOf({ tracks: [videoTrack(), tmcdT({ entryRaw: box("xxxx", new Uint8Array(40)) })] });
    expect(p.startTimecode).toBeNull();
  });

  it("truncating a valid moov at every byte offset never throws", async () => {
    const spec = { tracks: [videoTrack({ elst: [{ segmentDuration: 0, mediaTime: 2002 }] }), { handler: "tmcd" as const }] } as unknown as Mp4Spec;
    const body = moovBody(spec, 100, 100);
    const moov = concat(u32(8 + body.length), new TextEncoder().encode("moov"), body);
    expect((await probeMp4(sourceFrom([ftyp(), moov]))).ok).toBe(true);
    for (let n = 8; n <= moov.length; n++) {
      const cut = moov.subarray(0, n);
      // Keep the declared size consistent with the cut so the inner parser, not the top-level check, sees short boxes.
      const fixed = concat(u32(cut.length), cut.subarray(4));
      await expect(probeMp4(sourceFrom([ftyp(), fixed]))).resolves.toBeDefined();
    }
  });
});

describe("mp4RejectMessage", () => {
  it("gives a plain instruction for every reason", () => {
    const reasons: Mp4RejectReason[] = [
      "too_large", "not_mp4", "truncated", "box_size_invalid", "moov_missing", "moov_too_large", "read_budget_exceeded",
      "fragmented", "no_video_track", "multiple_video_tracks", "hevc", "unsupported_codec", "variable_frame_rate",
      "unsupported_frame_rate", "unsupported_edit_list", "unsupported_transform", "zero_frames",
    ];
    for (const r of reasons) expect(mp4RejectMessage(r).length).toBeGreaterThan(20);
    expect(mp4RejectMessage("variable_frame_rate")).toContain("constant frame rate");
  });
});
