import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

type Opts = { onDone: (r: { title: string; version?: number }) => void };
const made = vi.hoisted(() => ({
  opts: [] as unknown[],
  jobs: [] as { state: Record<string, unknown>; cancelAnswer: string | null; refuse: (message: string | null) => void }[],
}));
vi.mock("./video-upload", () => ({
  VideoUpload: class {
    state: Record<string, unknown> = { phase: "uploading", projectId: "p1" };
    cancelAnswer: string | null = null;
    refuse!: (message: string | null) => void;
    reserved = new Promise<string | null>((resolve) => { this.refuse = resolve; });
    constructor(_id: number, o: unknown) { made.opts.push(o); made.jobs.push(this); }
    start() {} retry() {}
    cancel() { return Promise.resolve(this.cancelAnswer); }
  },
  abortReservation: vi.fn(async () => null),
}));
const invalidate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./project-data", () => ({ invalidateProjectSurfaces: invalidate, terminatePrincipalOnUnauthorized: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("./toast-store", () => ({ pushToast: toast }));

import { abortReservation } from "./video-upload";
import { abortVideoReservation, cancelVideoUpload, resetVideoUploadStore, startVideoUpload } from "./video-upload-store";

const queryClient = {} as QueryClient;
const start = () => startVideoUpload({ userId: "u1", queryClient, projectId: "p1", role: "editor", file: new File([], "a.mp4"), target: { kind: "new", title: "Film" }, probe: {} as never, cautions: [] })!;
const resourcesOf = () => (invalidate.mock.calls.at(-1) as unknown as [unknown, { resources: { kind: string }[] }])[1].resources.map((r) => r.kind);

afterEach(() => { resetVideoUploadStore(); invalidate.mockClear(); toast.mockClear(); made.opts.length = 0; made.jobs.length = 0; });

describe("video upload store invalidation (#741 4d-i)", () => {
  it("a completed upload refreshes the Project detail (the Video tab count), the activity feed and the videos list", () => {
    start();
    (made.opts[0] as Opts).onDone({ title: "Film", version: 1 });
    expect(resourcesOf().sort()).toEqual(["activity", "detail", "videos"]);
  });
});

describe("Cancel leaves the reservation to the server (#751)", () => {
  it.each([
    ["204", null],
    ["409 upload_completed", null],
    ["503 abort_pending", "Cancelling is pending. Try again in a moment."],
    ["a network failure", "Couldn't reach the server to cancel."],
  ])("after %s the videos and detail are refreshed, and the message (if any) is a toast", async (_label, answer) => {
    const { id } = start();
    made.jobs[0]!.cancelAnswer = answer;
    await cancelVideoUpload(id, queryClient);
    expect(resourcesOf().sort()).toEqual(["detail", "videos"]);
    if (answer) expect(toast).toHaveBeenCalledWith(answer); else expect(toast).not.toHaveBeenCalled();
    // The row is gone: a second cancel finds nothing and asks nothing.
    invalidate.mockClear();
    await cancelVideoUpload(id, queryClient);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("the refresh waits for the abort's answer", async () => {
    const { id } = start();
    let answer!: (message: string | null) => void;
    (made.jobs[0] as unknown as { cancel: () => Promise<string | null> }).cancel = () => new Promise((resolve) => { answer = resolve; });
    const done = cancelVideoUpload(id, queryClient);
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();
    answer(null); await done;
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("a reservation this tab has no job for is aborted by id, then the list is refreshed; a pending answer is a toast", async () => {
    vi.mocked(abortReservation).mockResolvedValueOnce("Cancelling is pending. Try again in a moment.");
    await abortVideoReservation(queryClient, "p1", "r1");
    expect(abortReservation).toHaveBeenCalledWith("p1", "r1");
    expect(resourcesOf().sort()).toEqual(["detail", "videos"]);
    expect(toast).toHaveBeenCalledWith("Cancelling is pending. Try again in a moment.");
  });
});

describe("a refused reserve (#751)", () => {
  it("resolves the server's reason, and the row is gone so the caller keeps the person's file and title", async () => {
    const started = start();
    made.jobs[0]!.refuse("You already have three uploads in progress in this project. Finish or cancel one first.");
    expect(await started.reserved).toMatch(/three uploads/);
  });
  it("resolves null once the server holds the upload", async () => {
    const started = start();
    made.jobs[0]!.refuse(null);
    expect(await started.reserved).toBeNull();
  });
  it("does not count: a fourth start is not refused by the client", () => {
    for (let i = 0; i < 4; i += 1) expect(start()).not.toBeNull();
  });
});
