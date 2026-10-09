import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mp4Probe } from "@quincy/shared";

const jobs = vi.hoisted(() => ({ cancels: [] as string[] }));
vi.mock("./video-upload", () => ({
  VideoUpload: class { state = { phase: "uploading", projectId: "p1" }; reserved = new Promise<string | null>(() => undefined); constructor(_id: number, private o: { file: File }) {} start() {} cancel() { jobs.cancels.push(this.o.file.name); return Promise.resolve(null); } retry() {} },
  abortReservation: vi.fn(),
}));

import { ApiError } from "./api";
import { announcePrincipalTerminal } from "./principal-terminal";
import { createQuincyQueryClient } from "./query-client";
import { bindQueryClientPrincipal } from "./principal-terminal";
import { resetVideoUploadStore, startVideoUpload, syncUploadPrincipal } from "./video-upload-store";

afterEach(() => { resetVideoUploadStore(); jobs.cancels.length = 0; });

const begin = (userId: string, name: string, queryClient = createQuincyQueryClient()) =>
  startVideoUpload({ userId, queryClient, projectId: "p1", role: "editor", file: new File([], name), target: { kind: "new", title: name }, probe: {} as Mp4Probe, cautions: [] });

describe("a terminal principal ends film uploads (#741 4d-i)", () => {
  it("an unrelated 401 on that person's client aborts a running upload although no Films panel is mounted", async () => {
    const queryClient = createQuincyQueryClient(); bindQueryClientPrincipal(queryClient, "u1");
    begin("u1", "a.mp4", queryClient);
    expect(jobs.cancels).toEqual([]);
    await queryClient.fetchQuery({ queryKey: ["unrelated"], queryFn: () => Promise.reject(new ApiError("Unauthorized", 401)), retry: false }).catch(() => undefined);
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });
});

describe("the terminal notice names its principal (Sol round 3)", () => {
  it("a retired person's late notice clears nothing the current person owns; the current person's notice clears it", () => {
    begin("old", "old.mp4");
    syncUploadPrincipal("new"); // the person changed (impersonation, sign-in): old.mp4 is aborted
    begin("new", "new.mp4");
    expect(jobs.cancels).toEqual(["old.mp4"]);
    announcePrincipalTerminal("old"); // old's late 401
    expect(jobs.cancels).toEqual(["old.mp4"]);
    announcePrincipalTerminal("new");
    expect(jobs.cancels).toEqual(["old.mp4", "new.mp4"]);
  });

  it("a notice that names no one still clears everything (fail closed)", () => {
    begin("u1", "a.mp4");
    announcePrincipalTerminal();
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });
});
