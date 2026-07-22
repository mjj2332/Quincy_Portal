import { describe, expect, it } from "vitest";
import { sectionForDropboxFile, SKIP_DROPBOX_SECTION } from "../src/dropbox/sync";

function file(pathLower: string, pathDisplay = pathLower) { return { ".tag": "file" as const, id: "id:frame", name: "frame.jpg", path_lower: pathLower, path_display: pathDisplay, size: 1 }; }

describe("sectionForDropboxFile", () => {
  it("keeps root images in Captures and preserves Dropbox casing across two folder levels", () => {
    expect(sectionForDropboxFile(file("/jobs/42/frame.jpg", "/Jobs/42/Frame.jpg"), "/Jobs/42")).toBeNull();
    expect(sectionForDropboxFile(file("/jobs/42/extras/frame.jpg", "/Jobs/42/EXTRAS/Frame.jpg"), "/Jobs/42")).toBe("EXTRAS");
    expect(sectionForDropboxFile(file("/jobs/42/kitchen/frame.jpg", "/Jobs/42/Kitchen/Frame.jpg"), "/Jobs/42")).toBe("Kitchen");
    expect(sectionForDropboxFile(file("/jobs/42/kitchen/day/frame.jpg", "/Jobs/42/Kitchen/Day/Frame.jpg"), "/Jobs/42")).toBe("Kitchen/Day");
  });

  it("skips folders deeper than two levels and files outside the configured root", () => {
    expect(sectionForDropboxFile(file("/jobs/42/kitchen/day/retouched/frame.jpg"), "/Jobs/42")).toBe(SKIP_DROPBOX_SECTION);
    expect(sectionForDropboxFile(file("/jobs/420/frame.jpg"), "/Jobs/42")).toBe(SKIP_DROPBOX_SECTION);
  });
});
