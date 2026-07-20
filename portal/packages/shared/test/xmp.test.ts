import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { XMP_SCAN_BYTES, parseXmpRating, xmpRatingToStars } from "../src/xmp";

// Resolve from the config's directory, not the test file's directory.
const fixtureDirectory = fileURLToPath(
  new URL("../../../test-data/Test Images with star rating/", new URL("../", import.meta.url)),
);
const fixturesAvailable = existsSync(fixtureDirectory);
const oneStarFilenames = new Set([
  "260624-CR521407.jpg",
  "260624-CR521411.jpg",
  "260624-CR521426.jpg",
  "260624-CR521470.jpg",
  "260624-CR521480.jpg",
  "260624-CR521500.jpg",
  "260624-CR521506.jpg",
  "260624-CR521531.jpg",
]);

if (!fixturesAvailable) {
  console.info(`Skipping XMP JPEG fixtures: ${fixtureDirectory} is not available.`);
}

async function readJpegHeader(filename: string): Promise<Uint8Array> {
  const handle = await open(`${fixtureDirectory}/${filename}`, "r");
  try {
    const buffer = Buffer.allocUnsafe(XMP_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}

describe.skipIf(!fixturesAvailable)("XMP ratings in real Lightroom JPEG exports", () => {
  it("reads only each JPEG header and maps every known rating", async () => {
    const filenames = (await readdir(fixtureDirectory)).filter((filename) => /\.jpg$/i.test(filename));

    for (const filename of filenames) {
      const rating = parseXmpRating(await readJpegHeader(filename));
      expect(xmpRatingToStars(rating), filename).toBe(oneStarFilenames.has(filename) ? 1 : null);
    }
  });
});

const xmpPacket = (content: string) => new TextEncoder().encode(`<x:xmpmeta>${content}</x:xmpmeta>`);

describe("synthetic XMP rating parsing", () => {
  it("parses attribute ratings in either quote style", () => {
    expect(parseXmpRating(xmpPacket(`<rdf:Description xmp:Rating="2" />`))).toBe(2);
    expect(parseXmpRating(xmpPacket(`<rdf:Description xmp:Rating='3' />`))).toBe(3);
  });

  it("parses element ratings", () => {
    expect(parseXmpRating(xmpPacket("<xmp:Rating>4</xmp:Rating>"))).toBe(4);
  });

  it("maps explicit zero and rejected ratings to unrated stars", () => {
    expect(xmpRatingToStars(parseXmpRating(xmpPacket(`<rdf:Description xmp:Rating="0" />`)))).toBeNull();
    expect(xmpRatingToStars(parseXmpRating(xmpPacket(`<rdf:Description xmp:Rating="-1" />`)))).toBeNull();
  });

  it("returns null for missing, incomplete, or malformed packets", () => {
    expect(parseXmpRating(new TextEncoder().encode("not XMP"))).toBeNull();
    expect(parseXmpRating(xmpPacket("<rdf:Description />"))).toBeNull();
    expect(parseXmpRating(xmpPacket(`<rdf:Description xmp:Rating="not-a-number" />`))).toBeNull();
  });
});
