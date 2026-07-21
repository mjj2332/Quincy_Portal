import { describe, expect, it } from "vitest";
import { completeDropboxDeltaPage } from "../src/dropbox/delta";

const page = { cursor: "next-cursor", has_more: true, entries: [{ ".tag": "file" as const, name: "frame.jpg", path_lower: "/jobs/one/frame.jpg", id: "id:1", size: 1 }] };
const projects = [{ id: "one", rawFolderPath: "/jobs/one" }];

describe("completeDropboxDeltaPage", () => {
  it("does not advance the cursor when an affected project sync fails", async () => {
    const calls: string[] = [];
    await expect(completeDropboxDeltaPage(page, projects, {
      normalisePath: (path) => path,
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
      normalisePath: (path) => path,
      syncProject: async () => { calls.push("sync"); },
      setAlarm: async () => { calls.push("alarm"); },
      clearAlarm: async () => { calls.push("clear"); },
      persistCursor: async (cursor) => { calls.push(`cursor:${cursor}`); },
    });
    expect(calls).toEqual(["sync", "alarm", "cursor:next-cursor"]);
  });
});
