/** Assembles minimal PNG byte streams with real CRCs so the overlay inspector is tested without an encoder or node:zlib. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
export function chunk(type: string, data: number[] = [], badCrc = false): number[] {
  const body = [...ascii(type), ...data];
  const crc = crc32(Uint8Array.from(body));
  return [...u32(data.length), ...body, ...u32(badCrc ? (crc ^ 1) >>> 0 : crc)];
}
export type PngSpec = {
  w?: number; h?: number; colourType?: number; bitDepth?: number; compression?: number; filter?: number; interlace?: number;
  trns?: boolean; trnsLen?: number; trnsAfterIdat?: boolean; plteEntries?: number; plteOn?: number;
  actl?: boolean; badCrc?: boolean; noIdat?: boolean; ihdrSecond?: boolean; truncate?: number; noIend?: boolean; trailing?: number[]; iendWithData?: boolean;
};
const TRNS_LENGTH: Record<number, number> = { 0: 2, 2: 6, 3: 1 };
export function pngBytes(spec: PngSpec = {}): Uint8Array {
  const { w = 1080, h = 1920, colourType = 6 } = spec;
  const bitDepth = spec.bitDepth ?? (colourType === 3 ? 8 : colourType === 0 ? 8 : 8);
  const ihdr = chunk("IHDR", [...u32(w), ...u32(h), bitDepth, colourType, spec.compression ?? 0, spec.filter ?? 0, spec.interlace ?? 0], spec.badCrc);
  const parts: number[][] = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]];
  if (spec.ihdrSecond) parts.push(chunk("tEXt", ascii("a\0b")));
  parts.push(ihdr);
  if (spec.actl) parts.push(chunk("acTL", [...u32(2), ...u32(0)]));
  const plteEntries = spec.plteEntries ?? (colourType === 3 ? 2 : 0);
  if (plteEntries > 0) parts.push(chunk("PLTE", Array.from({ length: plteEntries * 3 }, (_, i) => i & 255)));
  if (spec.trns) parts.push(chunk("tRNS", Array.from({ length: spec.trnsLen ?? TRNS_LENGTH[colourType] ?? 2 }, () => 0)));
  if (!spec.noIdat) parts.push(chunk("IDAT", [0x78, 0x9c, 0, 0, 0, 0, 0, 0, 0, 1]));
  if (spec.trnsAfterIdat) parts.push(chunk("tRNS", [0, 0]));
  if (!spec.noIend) parts.push(chunk("IEND", spec.iendWithData ? [1] : []));
  if (spec.trailing) parts.push(spec.trailing);
  const all = Uint8Array.from(parts.flat());
  return spec.truncate === undefined ? all : all.slice(0, spec.truncate);
}
