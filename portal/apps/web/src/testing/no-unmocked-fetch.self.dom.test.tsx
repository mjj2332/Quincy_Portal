/**
 * Self-test for the DOM suite's network guard — prove the gate can fail before trusting it
 * (docs/lessons.md, "A grep gate that cannot fail is not a gate").
 *
 * `no-unmocked-fetch.ts` is a setup file: if a later edit broke `install()`, all 94 DOM files would
 * still pass and nothing would say otherwise. These tests make that a build failure instead.
 *
 * They are the only place allowed to call `fetch` without a stub. `drainAttemptsForSelfTest()`
 * clears what the guard recorded so its own `afterEach` doesn't then fail this file for the
 * requests it deliberately made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainAttemptsForSelfTest } from "./no-unmocked-fetch";

describe("DOM suite network guard", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("refuses a relative request and records it", async () => {
    await expect(fetch("/api/self-test")).rejects.toThrow(/Unmocked fetch in a DOM test/);
    expect(drainAttemptsForSelfTest()).toEqual(["GET /api/self-test"]);
  });

  it("refuses an absolute request to the happy-dom origin", async () => {
    await expect(fetch("http://localhost:3000/api/auth/get-session")).rejects.toThrow(/Unmocked fetch/);
    expect(drainAttemptsForSelfTest()).toEqual(["GET http://localhost:3000/api/auth/get-session"]);
  });

  it("records the method, so a write is distinguishable from a poll", async () => {
    await expect(fetch("/api/self-test", { method: "POST" })).rejects.toThrow(/Unmocked fetch/);
    expect(drainAttemptsForSelfTest()).toEqual(["POST /api/self-test"]);
  });

  it("survives vi.unstubAllGlobals() and vi.restoreAllMocks() in a previous test's teardown", async () => {
    // The afterEach above has already run twice by now; if it had restored the real fetch, this
    // would open a socket instead of rejecting.
    await expect(fetch("/api/self-test")).rejects.toThrow(/Unmocked fetch/);
    expect(drainAttemptsForSelfTest()).toEqual(["GET /api/self-test"]);
  });
});
