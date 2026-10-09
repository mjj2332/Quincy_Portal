import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mp4Probe } from "@quincy/shared";

const jobs = vi.hoisted(() => ({ cancels: [] as string[] }));
vi.mock("./video-upload", () => ({
  VideoUpload: class { state = { phase: "uploading", projectId: "p1" }; constructor(_id: number, private o: { file: File }) {} start() {} cancel() { jobs.cancels.push(this.o.file.name); } retry() {} },
}));

import { ApiError } from "./api";
import { createQuincyQueryClient } from "./query-client";
import { resetVideoUploadStore, startVideoUpload } from "./video-upload-store";

afterEach(() => { resetVideoUploadStore(); jobs.cancels.length = 0; });

describe("a terminal principal ends film uploads (#741 4d-i, Sol round 2)", () => {
  it("an unrelated 401 aborts a running upload although no Films panel is mounted", async () => {
    const queryClient = createQuincyQueryClient();
    startVideoUpload({ userId: "u1", queryClient, projectId: "p1", role: "editor", file: new File([], "a.mp4"), target: { kind: "new", title: "A" }, probe: {} as Mp4Probe, cautions: [] });
    expect(jobs.cancels).toEqual([]);
    await queryClient.fetchQuery({ queryKey: ["unrelated"], queryFn: () => Promise.reject(new ApiError("Unauthorized", 401)), retry: false }).catch(() => undefined);
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });
});
