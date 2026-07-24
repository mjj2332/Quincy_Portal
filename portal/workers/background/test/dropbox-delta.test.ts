import { describe, expect, it } from "vitest";
import { changedProjectIds, completeDropboxDeltaPage } from "../src/dropbox/delta";

const root = "/Tonomo/Raw Files";
const page = { cursor: "next-cursor", has_more: true, entries: [{ ".tag": "file" as const, name: "frame.jpg", path_lower: "/tonomo/raw files/jobs/one/frame.jpg", id: "id:1", size: 1 }] };
const projects = [{ id: "one", rawFolderPath: "/Tonomo/Raw Files/Jobs/One" }];

describe("completeDropboxDeltaPage", () => {
  it("matches only configured, boundary-contained, non-deleted RAW paths and de-duplicates IDs", () => {
    expect(changedProjectIds([
      page.entries[0]!,
      { ".tag": "folder", name: "nested", id: "id:2", path_lower: "/tonomo/raw files/jobs/one/nested" },
      { ".tag": "file", name: "wrong.jpg", id: "id:3", size: 1, path_lower: "/tonomo/raw files 2/jobs/one/wrong.jpg" },
      { ".tag": "file", name: "other.jpg", id: "id:4", size: 1, path_lower: "/autohdr/jobs/one/other.jpg" },
      { ".tag": "deleted", path_lower: "/tonomo/raw files/jobs/one/deleted.jpg" },
    ], [
      ...projects,
      { id: "link-only", rawFolderPath: null },
      { id: "out-of-root", rawFolderPath: "/Tonomo/Raw Files 2/Jobs/One" },
      { id: "sibling-prefix", rawFolderPath: "/Tonomo/Raw Files/Jobs/On" },
    ], root)).toEqual(["one"]);
  });

  it("does not advance the cursor when an affected project sync fails", async () => {
    const calls: string[] = [];
    await expect(completeDropboxDeltaPage(page, projects, {
      watchedRoot: root,
      syncProject: async () => { calls.push("sync"); throw new Error("Dropbox unavailable"); },
      setAlarm: async () => { calls.push("alarm"); },
      clearAlarm: async () => { calls.push("clear"); },
      persistCursor: async () => { calls.push("cursor"); },
    })).rejects.toThrow("Dropbox unavailable");
    expect(calls).toEqual(["sync"]);
  });

  it("commits the cursor only after project sync and the has_more alarm", async () => {
    const calls: string[] = [];
    await completeDropboxDeltaPage(page, projects, {
      watchedRoot: root,
      syncProject: async () => { calls.push("sync"); },
      setAlarm: async () => { calls.push("alarm"); },
      clearAlarm: async () => { calls.push("clear"); },
      persistCursor: async (cursor) => { calls.push(`cursor:${cursor}`); },
    });
    expect(calls).toEqual(["sync", "alarm", "cursor:next-cursor"]);
  });
});
