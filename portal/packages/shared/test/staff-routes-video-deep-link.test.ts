import { describe, expect, it } from "vitest";
import { parseStaffLocation, safeStaffDestination, staffPathFor, type StaffRoute } from "../src/staff-routes";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const videoId = "9b2f6c1e-7a3d-4e5f-8a1b-2c3d4e5f6a7b";
const base = `/projects/${projectId}`;

describe("#819 video deep link", () => {
  it("round-trips ?tab=video&video=<uuid>[&version=N]", () => {
    const withVersion = `${base}?tab=video&video=${videoId}&version=2`;
    const without = `${base}?tab=video&video=${videoId}`;
    expect(parseStaffLocation(withVersion)).toEqual({
      kind: "project", projectId, arrivalTab: "video", video: { id: videoId, version: 2 },
    });
    expect(parseStaffLocation(without)).toEqual({
      kind: "project", projectId, arrivalTab: "video", video: { id: videoId },
    });
    for (const location of [withVersion, without]) {
      const route = parseStaffLocation(location) as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>;
      expect(staffPathFor(route)).toBe(location);
      expect(safeStaffDestination(location)).toBe(location);
    }
    expect(staffPathFor({ kind: "project", projectId, arrivalTab: "video", video: { id: videoId, version: 999999 } }))
      .toBe(`${base}?tab=video&video=${videoId}&version=999999`);
  });

  it("rejects every non-canonical spelling", () => {
    const bad = [
      `${base}?video=${videoId}&tab=video`,
      `${base}?tab=video&version=2&video=${videoId}`,
      `${base}?tab=video&video=${videoId}&video=${videoId}`,
      `${base}?tab=video&video=${videoId}&version=2&version=2`,
      `${base}?tab=video&video=${videoId}&`,
      `${base}?tab=video&video=${videoId}&version=`,
      `${base}?tab=video&version=2`,
      `${base}?tab=video&video=`,
      `${base}?video=${videoId}`,
      `${base}?video=${videoId}&version=2`,
      `${base}?tab=raw&video=${videoId}`,
      `${base}?tab=edited&video=${videoId}&version=1`,
      `${base}?collaboration=open&video=${videoId}`,
      `${base}?whiteboard=open&video=${videoId}`,
      `${base}?tab=video&video=${videoId.toUpperCase()}`,
      `${base}?tab=video&video=not-a-uuid`,
      `${base}?tab=video&video=${videoId}&version=0`,
      `${base}?tab=video&video=${videoId}&version=02`,
      `${base}?tab=video&video=${videoId}&version=1000000`,
      `${base}?tab=video&video=${videoId}&version=-1`,
      `${base}?tab=video&video=${videoId}&version=1.5`,
      `${base}?tab=video&video=${videoId}&version=abc`,
      `${base}?tab=video&video=${videoId}&version=2&extra=1`,
      `${base}?tab=video&video=${videoId}&extra=1`,
      `${base}?tab=video&video=%39b2f6c1e-7a3d-4e5f-8a1b-2c3d4e5f6a7b`,
    ];
    for (const location of bad) {
      expect(parseStaffLocation(location).kind, location).toBe("not-found");
      expect(safeStaffDestination(location), location).toBeNull();
    }
  });

  it("keeps existing project outputs byte-identical", () => {
    expect(staffPathFor({ kind: "project", projectId, arrivalTab: "video" })).toBe(`${base}?tab=video`);
    expect(staffPathFor({ kind: "project", projectId, arrivalTab: "collaboration" })).toBe(`${base}?collaboration=open`);
    expect(staffPathFor({ kind: "project", projectId, whiteboard: true })).toBe(`${base}?whiteboard=open`);
    expect(staffPathFor({ kind: "project", projectId })).toBe(base);
  });

  it("safeStaffDestination keeps the full path and query", () => {
    const location = `${base}?tab=video&video=${videoId}&version=2`;
    expect(safeStaffDestination(location)).toBe(location);
  });
});

describe("#835 note deep link", () => {
  const noteId = "5b2f6c1e-7a3d-4e5f-8a1b-2c3d4e5f6a7b";
  it("round-trips &note=<uuid> after the version", () => {
    const location = `${base}?tab=video&video=${videoId}&version=2&note=${noteId}`;
    expect(parseStaffLocation(location)).toEqual({ kind: "project", projectId, arrivalTab: "video", video: { id: videoId, version: 2, note: noteId } });
    const route = parseStaffLocation(location) as Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>;
    expect(staffPathFor(route)).toBe(location);
    expect(safeStaffDestination(location)).toBe(location);
  });
  it("needs a version and rejects non-canonical spellings", () => {
    for (const bad of [
      `${base}?tab=video&video=${videoId}&note=${noteId}`,
      `${base}?tab=video&video=${videoId}&note=${noteId}&version=2`,
      `${base}?tab=video&video=${videoId}&version=2&note=`,
      `${base}?tab=video&video=${videoId}&version=2&note=not-a-uuid`,
      `${base}?tab=video&video=${videoId}&version=2&note=${noteId.toUpperCase()}`,
      `${base}?tab=video&video=${videoId}&version=2&note=${noteId}&`,
    ]) expect(parseStaffLocation(bad)).toEqual({ kind: "not-found" });
  });
});
