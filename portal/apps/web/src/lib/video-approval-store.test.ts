import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { createVideoApprovalStore, versionSlot, videoSlot } from "./video-approval-store";

const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const V = versionSlot("a1"); const F = videoSlot("v1");

describe("video approval store (#741 14-ui-staff)", () => {
  it("an untouched slot is empty and keeps one identity until it changes", () => {
    const store = createVideoApprovalStore("u:p");
    expect(store.getSlot(V)).toBe(store.getSlot(V));
    expect(store.getSlot(V)).toMatchObject({ op: null, problem: null, note: "", paymentRef: "" });
  });

  it("allows one write in flight per slot; a second is refused, not queued, and another slot is free", async () => {
    const store = createVideoApprovalStore("u:p");
    const first = deferred<unknown>();
    const a = store.run(V, "release", () => first.promise);
    expect(store.getSlot(V).op?.kind).toBe("release");
    let sent = 0;
    expect(await store.run(V, "withdraw", () => { sent += 1; return Promise.resolve(); })).toBe("busy");
    expect(sent).toBe(0);
    expect(await store.run(F, "premium", () => Promise.resolve())).toBe("ok");
    first.resolve({});
    expect(await a).toBe("ok");
    expect(store.getSlot(V).op).toBeNull();
  });

  it("a failure records what to tell the person; a success clears the problem and the draft it sent", async () => {
    const store = createVideoApprovalStore("u:p");
    store.setNote(V, "by phone");
    expect(await store.run(V, "decision", () => Promise.reject(new ApiError("x", 409, { code: "decision_conflict" })))).toBe("failed");
    expect(store.getSlot(V).problem).toMatch(/same time/i);
    expect(store.getSlot(V).note).toBe("by phone");
    expect(await store.run(V, "decision", () => Promise.resolve())).toBe("ok");
    expect(store.getSlot(V)).toMatchObject({ problem: null, note: "" });
    store.setPaymentRef(F, "INV-1");
    expect(await store.run(F, "unlock", () => Promise.resolve())).toBe("ok");
    expect(store.getSlot(F).paymentRef).toBe("");
  });

  it("a stale release names the newer decision", async () => {
    const store = createVideoApprovalStore("u:p");
    await store.run(V, "release", () => Promise.reject(new ApiError("x", 409, { code: "release_stale", current: 3 })));
    expect(store.getSlot(V).problem).toMatch(/newer decision/i);
  });

  it("a draft edited while the write is out survives its success", async () => {
    const store = createVideoApprovalStore("u:p");
    store.setNote(V, "first");
    const gate = deferred<unknown>();
    const done = store.run(V, "decision", () => gate.promise);
    store.setNote(V, "second");
    gate.resolve({});
    await done;
    expect(store.getSlot(V).note).toBe("second");
  });

  it("a retired store drops late completions and starts nothing", async () => {
    const store = createVideoApprovalStore("u:p");
    const gate = deferred<unknown>();
    const late = store.run(V, "release", () => gate.promise);
    store.retire();
    gate.reject(new ApiError("x", 403));
    expect(await late).toBe("dropped");
    expect(store.getSlot(V).problem).toBeNull();
    expect(await store.run(V, "release", () => Promise.resolve())).toBe("dropped");
  });

  it("notifies subscribers on change only", async () => {
    const store = createVideoApprovalStore("u:p");
    let calls = 0; store.subscribe(() => { calls += 1; });
    store.setNote(V, "x"); store.setNote(V, "x");
    expect(calls).toBe(1);
  });
});
