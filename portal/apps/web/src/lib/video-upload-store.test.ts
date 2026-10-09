import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

type Opts = { onSettled: (r: { outcome: string; title: string; version?: number }) => void };
const made = vi.hoisted(() => ({ opts: [] as unknown[] }));
vi.mock("./video-upload", () => ({
  VideoUpload: class { state = { phase: "uploading", projectId: "p1" }; constructor(_id: number, o: unknown) { made.opts.push(o); } start() {} cancel() {} retry() {} },
}));
const invalidate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./project-data", () => ({ invalidateProjectSurfaces: invalidate, terminatePrincipalOnUnauthorized: vi.fn() }));
vi.mock("./toast-store", () => ({ pushToast: vi.fn() }));

import { resetVideoUploadStore, startVideoUpload } from "./video-upload-store";

const start = () => startVideoUpload({ userId: "u1", queryClient: {} as QueryClient, projectId: "p1", role: "editor", file: new File([], "a.mp4"), target: { kind: "new", title: "Film" }, probe: {} as never, cautions: [] });
const resourcesOf = () => (invalidate.mock.calls.at(-1) as unknown as [unknown, { resources: { kind: string }[] }])[1].resources.map((r) => r.kind);

afterEach(() => { resetVideoUploadStore(); invalidate.mockClear(); made.opts.length = 0; });

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
