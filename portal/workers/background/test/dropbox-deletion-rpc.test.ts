import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/dropbox/client")>();
  return { ...actual, deleteBatch: vi.fn(), deleteBatchCheck: vi.fn() };
});

import type { Env } from "../src/env";
import QuincyBackground from "../src/index";
import { deleteBatch, deleteBatchCheck } from "../src/dropbox/client";

type FakeDatabase = { prepare: ReturnType<typeof vi.fn> };

function worker(renewResults: boolean[]) {
  const db: FakeDatabase = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({ meta: { changes: renewResults.shift() ? 1 : 0 } })) })) })) };
  const instance = Object.create(QuincyBackground.prototype) as QuincyBackground;
  Object.defineProperty(instance, "env", { value: { DB: db } as unknown as Env });
  return { instance, db };
}

beforeEach(() => { vi.mocked(deleteBatch).mockReset(); vi.mocked(deleteBatchCheck).mockReset(); });

describe("Dropbox asset deletion RPC claim renewal", () => {
  it("renews before the initial delete_batch and returns a distinct claimLost result", async () => {
    const { instance, db } = worker([false]);
    vi.mocked(deleteBatch).mockResolvedValue({ ".tag": "complete", entries: [{ ".tag": "success" }] });
    await expect(instance.deleteDropboxSourceFile("/Raw/file.jpg", "claim", "job")).resolves.toEqual({ outcome: "claimLost" });
    expect(db.prepare).toHaveBeenCalledTimes(1); expect(deleteBatch).not.toHaveBeenCalled();
  });

  it("renews on every poll and distinguishes renewal loss from an ordinary Dropbox failure", async () => {
    const lost = worker([true, false]);
    vi.mocked(deleteBatch).mockResolvedValue({ ".tag": "async_job_id", async_job_id: "async" });
    await expect(lost.instance.deleteDropboxSourceFile("/Raw/file.jpg", "claim", "job")).resolves.toEqual({ outcome: "claimLost" });
    expect(deleteBatchCheck).not.toHaveBeenCalled();

    const failed = worker([true, true]);
    vi.mocked(deleteBatch).mockResolvedValue({ ".tag": "async_job_id", async_job_id: "async" });
    vi.mocked(deleteBatchCheck).mockResolvedValue({ ".tag": "failed" });
    await expect(failed.instance.deleteDropboxSourceFile("/Raw/file.jpg", "claim", "job")).resolves.toEqual({ outcome: "failed", reason: "Dropbox delete_batch failed" });
    expect(failed.db.prepare).toHaveBeenCalledTimes(2);
  });
});
