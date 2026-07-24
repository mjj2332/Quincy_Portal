import { describe, expect, it } from "vitest";
import { fanOutDropboxKicks } from "../src/dropbox/webhook";

describe("fanOutDropboxKicks", () => {
  it("continues kicking healthy connections and reports failures afterwards", async () => {
    const kicked: string[] = [];
    await expect(fanOutDropboxKicks(["one:raw", "one:autohdr", "two:raw"], async (id) => {
      kicked.push(id);
      if (id === "one:raw") throw new Error("DO unavailable");
    })).rejects.toThrow("1 Dropbox webhook kick(s) failed");
    expect(kicked).toEqual(["one:raw", "one:autohdr", "two:raw"]);
  });
});
