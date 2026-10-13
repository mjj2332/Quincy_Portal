import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

type Opts = { onDone: (r: { title: string; version?: number }) => void };
const made = vi.hoisted(() => ({
  opts: [] as unknown[],
  jobs: [] as { id: number; state: Record<string, unknown>; cancelAnswer: string | null; refuse: (message: string | null) => void }[],
  check: (file: File): unknown => file.name.endsWith(".mkv") ? { ok: false, message: "not an mp4" } : { ok: true, probe: { fps: { num: 25, den: 1 } }, cautions: [] },
}));
vi.mock("./video-upload", () => ({
  VideoUpload: class {
    state: Record<string, unknown> = { phase: "uploading", projectId: "p1" };
    cancelAnswer: string | null = null;
    refuse!: (message: string | null) => void;
    reserved = new Promise<string | null>((resolve) => { this.refuse = resolve; });
    id = 0;
    constructor(id: number, o: unknown) { this.id = id; made.opts.push(o); made.jobs.push(this); }
    start() {} retry() {}
    cancel() { return Promise.resolve(this.cancelAnswer); }
  },
  abortReservation: vi.fn(async () => null),
  checkVideoFile: async (file: File) => made.check(file),
}));
const invalidate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./project-data", () => ({ invalidateProjectSurfaces: invalidate, terminatePrincipalOnUnauthorized: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("./toast-store", () => ({ pushToast: toast }));

import { abortReservation } from "./video-upload";
import { abortVideoReservation, addNewFilms, cancelVideoUpload, newFilmBatchSnapshot, removeNewFilm, removeVideoUpload, resetVideoUploadStore, retryNewFilm, startVideoUpload, syncUploadPrincipal, uploadNewFilms } from "./video-upload-store";

const queryClient = {} as QueryClient;
const start = () => startVideoUpload({ userId: "u1", queryClient, projectId: "p1", role: "editor", file: new File([], "a.mp4"), target: { kind: "new" }, probe: {} as never, cautions: [] })!;
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

describe("Remove on a failed row (Sol round 4)", () => {
  it("drops the row at once, aborts, then re-reads videos and detail like Cancel", async () => {
    const { id } = start();
    made.jobs[0]!.state = { phase: "failed", projectId: "p1" };
    made.jobs[0]!.cancelAnswer = "Cancelling is pending. Try again in a moment.";
    removeVideoUpload(id);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
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

describe("a batch of new films (#845)", () => {
  const films = (n: number, ext = "mp4") => Array.from({ length: n }, (_, i) => new File([], `film${i}.${ext}`));
  const add = async (files: File[]) => { addNewFilms({ userId: "u1", queryClient, projectId: "p1", role: "editor", files }); await vi.waitFor(() => expect(newFilmBatchSnapshot("u1", "p1").every((e) => e.status !== "checking")).toBe(true)); };
  const rows = () => newFilmBatchSnapshot("u1", "p1");
  const go = () => uploadNewFilms("u1", "p1");
  const change = (index: number, state: Record<string, unknown>) => { made.jobs[index]!.state = { projectId: "p1", ...state }; (made.opts[index] as { onChange: (s: unknown) => void }).onChange(made.jobs[index]!.state); };

  it("shows each file as checking, then ready with its probe, or rejected with the reason; a rejected file never reserves", async () => {
    await add([...films(2), new File([], "cut.mkv")]);
    expect(rows().map((r) => r.status)).toEqual(["ready", "ready", "rejected"]);
    expect(rows()[2]!.message).toBe("not an mp4");
    go();
    expect(made.jobs).toHaveLength(2);
  });

  it("runs three at a time and starts the next only when one has truly finished", async () => {
    await add(films(5)); go();
    expect(made.jobs).toHaveLength(3);
    change(0, { phase: "uploading" });
    await Promise.resolve(); await Promise.resolve();
    expect(made.jobs).toHaveLength(3);
    change(0, { phase: "done" });
    await vi.waitFor(() => expect(made.jobs).toHaveLength(4));
  });

  it("a failure parked for a retry keeps its lane; a terminal failure frees it", async () => {
    await add(films(4)); go();
    change(0, { phase: "failed", retry: "upload" });
    await new Promise((r) => setTimeout(r, 5));
    expect(made.jobs).toHaveLength(3);
    change(1, { phase: "failed", retry: null });
    await vi.waitFor(() => expect(made.jobs).toHaveLength(4));
  });

  it("a cancelled job (its row gone) frees its lane", async () => {
    await add(films(4)); go();
    made.jobs[0]!.state = { phase: "uploading", projectId: "p1" };
    await cancelVideoUpload(made.jobs[0]!.id, queryClient);
    await vi.waitFor(() => expect(made.jobs).toHaveLength(4));
  });

  it("a refused reserve comes back as a refused row with the server's words, and Retry reserves it again", async () => {
    await add(films(1)); go();
    made.jobs[0]!.refuse("You already have three uploads in progress in this project. Finish or cancel one first.");
    await vi.waitFor(() => expect(rows()[0]!.status).toBe("refused"));
    expect(rows()[0]!.message).toMatch(/three uploads/);
    expect(made.jobs).toHaveLength(1);
    retryNewFilm(rows()[0]!.key);
    expect(made.jobs).toHaveLength(2);
    expect(rows()).toHaveLength(0);
  });

  it("a started file leaves the list; Remove drops an unstarted row, and its late check applies nothing", async () => {
    made.check = () => new Promise(() => undefined);
    addNewFilms({ userId: "u1", queryClient, projectId: "p1", role: "editor", files: films(1) });
    expect(rows()[0]!.status).toBe("checking");
    removeNewFilm(rows()[0]!.key);
    expect(rows()).toHaveLength(0);
    made.check = () => ({ ok: true, probe: {}, cautions: [] });
  });

  it("another person empties the batch, and a check still running then applies nothing", async () => {
    let finish!: (v: unknown) => void;
    made.check = () => new Promise((resolve) => { finish = resolve; });
    addNewFilms({ userId: "u1", queryClient, projectId: "p1", role: "editor", files: films(1) });
    syncUploadPrincipal("u2");
    finish({ ok: true, probe: {}, cautions: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(newFilmBatchSnapshot("u1", "p1")).toHaveLength(0);
    expect(newFilmBatchSnapshot("u2", "p1")).toHaveLength(0);
    made.check = () => ({ ok: true, probe: {}, cautions: [] });
  });
});
