import { describe, expect, it } from "vitest";
import {
  AUTOHDR_ROOT,
  TONOMO_RAW_ROOT,
  dropboxPathKey,
  monitorName,
  normalisePath,
  parseDropboxMonitorIdentity,
  pathEqualsOrIsBelow,
} from "../src/dropbox/paths";

describe("Dropbox path and monitor contracts", () => {
  it("normalises display/Finder paths once and matches with a slash boundary", () => {
    expect(normalisePath("\\Volumes\\Disk\\Quincy Productions Dropbox\\Tonomo\\\\Raw Files\\A\\"))
      .toBe("/Tonomo/Raw Files/A");
    expect(dropboxPathKey("/Tonomo/RAW Files/A")).toBe("/tonomo/raw files/a");
    expect(pathEqualsOrIsBelow("/Tonomo/Raw Files/A/frame.jpg", TONOMO_RAW_ROOT)).toBe(true);
    expect(pathEqualsOrIsBelow("/Tonomo/Raw Files 2/A", TONOMO_RAW_ROOT)).toBe(false);
    expect(pathEqualsOrIsBelow("/AutoHDR-backup/A", AUTOHDR_ROOT)).toBe(false);
  });

  it("decodes bare connection identity once and rejects legacy/malformed names", () => {
    expect(monitorName("connection-1", "raw")).toBe("connection-1:raw");
    expect(parseDropboxMonitorIdentity("connection-1:raw")).toEqual({
      connectionId: "connection-1", scope: "raw", watchedRoot: TONOMO_RAW_ROOT,
    });
    expect(parseDropboxMonitorIdentity("connection-1:autohdr")).toEqual({
      connectionId: "connection-1", scope: "autohdr", watchedRoot: AUTOHDR_ROOT,
    });
    for (const malformed of [undefined, "", "connection-1", "connection-1:legacy", ":raw", "a:b:raw", "a/raw"]) {
      expect(parseDropboxMonitorIdentity(malformed)).toBeNull();
    }
  });
});
