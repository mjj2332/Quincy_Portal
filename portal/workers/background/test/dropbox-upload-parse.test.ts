import { describe, expect, it } from "vitest";
import { parseFileMetadata } from "../src/dropbox/client";

// Regression: `/files/upload` returns a bare FileMetadata with NO `.tag`. Parsing it with the
// list-entry parser threw "Dropbox response is missing .tag" AFTER the file was written, which
// killed the AutoHDR send workflow on its first file (only 1 of N copied). See docs/lessons.md.
describe("parseFileMetadata (files/upload response)", () => {
  it("parses a tag-less FileMetadata as a file", () => {
    const uploaded = {
      name: "se.CR527897_3.33 EV_20Jul.jpg",
      path_lower: "/autohdr/4 mcgowen ave.../01-raw-photos/se.cr527897_3.33 ev_20jul.jpg",
      path_display: "/AutoHDR/4 McGowen Ave.../01-RAW-Photos/se.CR527897_3.33 EV_20Jul.jpg",
      id: "id:abc123",
      size: 12345678,
      content_hash: "deadbeef",
    };
    const file = parseFileMetadata(uploaded);
    expect(file[".tag"]).toBe("file");
    expect(file.name).toBe("se.CR527897_3.33 EV_20Jul.jpg");
    expect(file.size).toBe(12345678);
    expect(file.content_hash).toBe("deadbeef");
    expect(file.path_display).toBe(uploaded.path_display);
  });

  it("tolerates a missing content_hash / path_display", () => {
    const file = parseFileMetadata({ name: "a.jpg", path_lower: "/x/a.jpg", id: "id:1", size: 10 });
    expect(file.content_hash).toBeUndefined();
    expect(file.path_display).toBeUndefined();
  });

  it("rejects a non-object response", () => {
    expect(() => parseFileMetadata(null)).toThrow("invalid upload response");
  });
});
