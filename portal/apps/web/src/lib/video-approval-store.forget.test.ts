import { describe, expect, it } from "vitest";
import { createVideoApprovalStore, versionSlot, videoSlot } from "./video-approval-store";

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((a) => { resolve = a; }); return { promise, resolve }; };

describe("approval store forget (#776 E)", () => {
  it("drops one slot's draft and write state, leaving others", () => {
    const store = createVideoApprovalStore("u:p");
    store.setNote(versionSlot("removed"), "an unsent note");
    store.setNote(versionSlot("kept"), "keep me");
    store.forget(versionSlot("removed"));
    expect(store.getSlot(versionSlot("removed")).note).toBe("");
    expect(store.getSlot(versionSlot("kept")).note).toBe("keep me");
  });

  it("a write that settles after its slot was forgotten is dropped and writes nothing back", async () => {
    const store = createVideoApprovalStore("u:p");
    const held = deferred<unknown>();
    const running = store.run(versionSlot("removed"), "release", () => held.promise);
    store.forget(versionSlot("removed"));
    held.resolve({});
    expect(await running).toBe("dropped");
    expect(store.getSlot(versionSlot("removed")).op).toBeNull();
    expect(store.getSlot(videoSlot("v"))).toBe(store.getSlot(versionSlot("removed")));
  });

  it("notifies subscribers", () => {
    const store = createVideoApprovalStore("u:p");
    store.setNote(versionSlot("a"), "x");
    let seen = 0;
    store.subscribe(() => { seen += 1; });
    store.forget(versionSlot("a"));
    expect(seen).toBe(1);
  });
});
