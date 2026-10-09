import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

type Opts = { onSettled: (r: { outcome: string; title: string; version?: number }) => void };
const made = vi.hoisted(() => ({ opts: [] as unknown[], jobs: [] as { state: Record<string, unknown> }[] }));
vi.mock("./video-upload", () => ({
  VideoUpload: class { state = { phase: "uploading", projectId: "p1" }; constructor(_id: number, o: unknown) { made.opts.push(o); made.jobs.push(this); } start() {} cancel() {} retry() {} },
}));
const invalidate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./project-data", () => ({ invalidateProjectSurfaces: invalidate, terminatePrincipalOnUnauthorized: vi.fn() }));
vi.mock("./toast-store", () => ({ pushToast: vi.fn() }));

import { VIDEO_CLIENT_MAX_ACTIVE, resetVideoUploadStore, startVideoUpload } from "./video-upload-store";

const start = () => startVideoUpload({ userId: "u1", queryClient: {} as QueryClient, projectId: "p1", role: "editor", file: new File([], "a.mp4"), target: { kind: "new", title: "Film" }, probe: {} as never, cautions: [] });
const resourcesOf = () => (invalidate.mock.calls.at(-1) as unknown as [unknown, { resources: { kind: string }[] }])[1].resources.map((r) => r.kind);

afterEach(() => { resetVideoUploadStore(); invalidate.mockClear(); made.opts.length = 0; made.jobs.length = 0; });

describe("video upload store invalidation (#741 4d-i)", () => {
  it("a completed upload refreshes the Project detail (the Video tab count), the activity feed and the videos list", () => {
    start();
    (made.opts[0] as Opts).onSettled({ outcome: "done", title: "Film", version: 1 });
    expect(resourcesOf().sort()).toEqual(["activity", "detail", "videos"]);
  });
  it("a failed or cancelled upload refreshes only the videos list", () => {
    start();
    (made.opts[0] as Opts).onSettled({ outcome: "failed", title: "Film" });
    expect(resourcesOf()).toEqual(["videos"]);
  });
});

describe("the cap (#741 4d-i, Sol round 2)", () => {
  it("counts a cancelled upload until the server has confirmed it dropped the reservation", () => {
    for (let i = 0; i < VIDEO_CLIENT_MAX_ACTIVE; i += 1) expect(start()).not.toBeNull();
    expect(start()).toBeNull();
    made.jobs[0]!.state = { phase: "cancelled", projectId: "p1", cleaning: true };
    expect(start()).toBeNull();
    made.jobs[0]!.state = { phase: "cancelled", projectId: "p1", cleaning: false };
    expect(start()).not.toBeNull();
  });
});
