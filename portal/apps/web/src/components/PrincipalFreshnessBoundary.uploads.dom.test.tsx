import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mp4Probe } from "@quincy/shared";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const jobs = vi.hoisted(() => ({ cancels: [] as string[] }));
vi.mock("../lib/video-upload", () => ({
  abortReservation: vi.fn(),
  VideoUpload: class { state = { phase: "uploading", projectId: "p1" }; reserved = new Promise<string | null>(() => undefined); constructor(_id: number, private o: { file: File }) {} start() {} cancel() { jobs.cancels.push(this.o.file.name); return Promise.resolve(null); } retry() {} },
}));
vi.mock("../lib/api", () => ({ apiGet: () => new Promise(() => undefined) }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ refetch: vi.fn() }) }));

import { PrincipalFreshnessBoundary } from "./PrincipalFreshnessBoundary";
import { resetVideoUploadStore, startVideoUpload } from "../lib/video-upload-store";

const start = (userId: string, name: string) => startVideoUpload({ userId, queryClient: undefined, projectId: "p1", role: "editor", file: new File([], name), target: { kind: "new", title: name }, probe: {} as Mp4Probe, cautions: [] });

describe("video uploads follow the signed-in person at the app's identity boundary (#741 4d-i)", () => {
  let root: Root | null = null; let host: HTMLElement;
  const render = async (principalId: string | null) => {
    if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
    await act(async () => { root!.render(principalId ? createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PrincipalFreshnessBoundary, { principalId, role: "editor", authorizationEpoch: 0, children: createElement("div") })) : null); });
  };
  afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); jobs.cancels.length = 0; document.body.replaceChildren(); });

  it("signing out aborts a running upload although no Films panel is mounted", async () => {
    await render("u1");
    start("u1", "a.mp4");
    expect(jobs.cancels).toEqual([]);
    await render(null);
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });

  it("switching the principal (impersonation) aborts the previous person's upload with the panel unmounted", async () => {
    await render("u1");
    start("u1", "a.mp4");
    await render("u2");
    expect(jobs.cancels).toEqual(["a.mp4"]);
  });
});
