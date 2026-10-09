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
import { resetVideoUploadStore, startVideoUpload, syncUploadPrincipal } from "./video-upload-store";

afterEach(() => { resetVideoUploadStore(); jobs.cancels.length = 0; });

const begin = (userId: string, name: string, queryClient = createQuincyQueryClient()) =>
  startVideoUpload({ userId, queryClient, projectId: "p1", role: "editor", file: new File([], name), target: { kind: "new", title: name }, probe: {} as Mp4Probe, cautions: [] });

describe("a terminal notice ends film uploads (#741 4d-i)", () => {
  it("an unrelated 401 on the client an upload started under aborts it although no Films panel is mounted", async () => {
    const queryClient = createQuincyQueryClient();
    begin("u1", "a.mp4", queryClient);
    expect(jobs.cancels).toEqual([]);
    await queryClient.fetchQuery({ queryKey: ["unrelated"], queryFn: () => Promise.reject(new ApiError("Unauthorized", 401)), retry: false }).catch(() => undefined);
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });
});

describe("the terminal notice names the query client it came from (Sol round 4)", () => {
  it("signing out and back in as the SAME account: the retired client's late notice clears nothing of the fresh client's", () => {
    const retired = createQuincyQueryClient(); const fresh = createQuincyQueryClient();
    begin("u1", "old.mp4", retired);
    syncUploadPrincipal(null); // sign-out
    expect(jobs.cancels).toEqual(["old.mp4"]);
    begin("u1", "new.mp4", fresh); // same account, new session
    announcePrincipalTerminal(retired); // the old session's late 401
    expect(jobs.cancels).toEqual(["old.mp4"]);
    announcePrincipalTerminal(fresh);
    expect(jobs.cancels).toEqual(["old.mp4", "new.mp4"]);
  });

  it("a notice that names no client still clears everything (fail closed)", () => {
    begin("u1", "a.mp4");
    announcePrincipalTerminal();
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });
});
