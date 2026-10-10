import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createReviewLinkStore } from "./review-link-form-store";

const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("review link form store (#741 11b)", () => {
  it("keeps a selection across dialog opens and prunes Videos that are gone", () => {
    const store = createReviewLinkStore("u:p");
    store.toggleSelect(A); store.toggleSelect(B);
    expect([...store.getState().selection]).toEqual([A, B]);
    store.toggleSelect(A);
    expect([...store.getState().selection]).toEqual([B]);
    store.pruneSelection([A]);
    expect(store.getState().selection.size).toBe(0);
  });

  it("holds the create draft while the dialog closes and reopens", () => {
    const store = createReviewLinkStore("u:p");
    store.openCreate();
    store.patchCreate({ label: "Smith family", passcode: "hunter22", expiryDay: "2026-12-01", allow: { comments: true, approve: false, download: true } });
    store.setGrant(A, ["x", "y"]);
    store.closeDialog();
    expect(store.getState().view.kind).toBe("closed");
    store.openCreate();
    const draft = store.getState().create;
    expect(draft).toMatchObject({ label: "Smith family", passcode: "hunter22", expiryDay: "2026-12-01", allow: { approve: false } });
    expect(draft.grants[A]).toEqual(["x", "y"]);
  });

  it("holds a link's unsaved detail edits per link", () => {
    const store = createReviewLinkStore("u:p");
    store.patchDetail(A, { label: "New name" });
    store.patchDetail(B, { removePasscode: true });
    store.openDetail(A); store.closeDialog();
    expect(store.getState().details[A]?.label).toBe("New name");
    expect(store.getState().details[B]?.removePasscode).toBe(true);
    store.resetDetail(A);
    expect(store.getState().details[A]).toBeUndefined();
  });

  it("run: pending while out, success applies, and a second run on the same scope is refused", async () => {
    const store = createReviewLinkStore("u:p");
    const first = deferred<string>();
    const ok = vi.fn();
    const sent = store.run("create", () => first.promise, ok);
    expect(store.getState().pending.has("create")).toBe(true);
    expect(await store.run("create", () => Promise.resolve("again"), ok)).toBe(false);
    first.resolve("done");
    expect(await sent).toBe(true);
    expect(ok).toHaveBeenCalledWith("done");
    expect(store.getState().pending.has("create")).toBe(false);
  });

  it("run: a failure leaves a classified problem on the scope and clears it on the next attempt", async () => {
    const store = createReviewLinkStore("u:p");
    expect(await store.run("revoke:a", () => Promise.reject(new ApiError("x", 409, { error: "x", code: "link_revoked" })), vi.fn())).toBe(false);
    expect(store.getState().problems["revoke:a"]).toMatchObject({ action: "refetch" });
    const again = deferred<void>();
    void store.run("revoke:a", () => again.promise, vi.fn());
    expect(store.getState().problems["revoke:a"]).toBeUndefined();
    again.resolve();
  });

  it("closing the dialog does not cancel a create in flight: the reveal still lands, so the one-time URL is not lost", async () => {
    const store = createReviewLinkStore("u:p");
    store.openCreate();
    const out = deferred<{ url: string }>();
    void store.run("create", () => out.promise, (result) => store.showReveal({ url: result.url, linkId: A, label: null, origin: "create" }));
    store.closeDialog();
    out.resolve({ url: "https://x.test/d/review?link=a#t=tok" });
    await Promise.resolve(); await Promise.resolve();
    expect(store.getState().view.kind).toBe("reveal");
    expect(store.getState().reveal?.url).toContain("#t=tok");
  });

  it("showReveal clears the selection and the create draft; dismissing it clears the URL and lands on the link's detail", () => {
    const store = createReviewLinkStore("u:p");
    store.toggleSelect(A); store.openCreate(); store.patchCreate({ label: "Smith", passcode: "secret1" });
    store.showReveal({ url: "https://x.test/d/review?link=a#t=tok", linkId: A, label: "Smith", origin: "create" });
    expect(store.getState().selection.size).toBe(0);
    expect(store.getState().create.label).toBe("");
    expect(store.getState().create.passcode).toBe("");
    store.dismissReveal();
    expect(store.getState().reveal).toBeNull();
    expect(store.getState().view).toEqual({ kind: "detail", linkId: A });
  });

  it("closing the dialog on the reveal step discards the URL", () => {
    const store = createReviewLinkStore("u:p");
    store.showReveal({ url: "https://x.test/d/review?link=a#t=tok", linkId: A, label: null, origin: "replace" });
    store.closeDialog();
    expect(store.getState().reveal).toBeNull();
    expect(store.getState().view.kind).toBe("closed");
  });

  it("cancelAll resets everything and a completion that was in flight changes nothing; retire does the same for good", async () => {
    const store = createReviewLinkStore("u:p");
    store.toggleSelect(A);
    const out = deferred<string>(); const ok = vi.fn();
    void store.run("create", () => out.promise, ok);
    store.cancelAll();
    out.resolve("late");
    await Promise.resolve(); await Promise.resolve();
    expect(ok).not.toHaveBeenCalled();
    expect(store.getState().selection.size).toBe(0);
    expect(store.getState().pending.size).toBe(0);
    const listener = vi.fn(); store.subscribe(listener);
    store.retire();
    store.toggleSelect(B);
    expect(store.getState().selection.size).toBe(0);
  });

  it("notifies subscribers and hands React a stable snapshot until something changes", () => {
    const store = createReviewLinkStore("u:p");
    const listener = vi.fn(); const off = store.subscribe(listener);
    const before = store.getState();
    expect(store.getState()).toBe(before);
    store.toggleSelect(A);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).not.toBe(before);
    off();
  });

  it("settleDetail clears only what was submitted: a field edited during the request survives", () => {
    const store = createReviewLinkStore("u:p");
    store.patchDetail(A, { label: "Sent", passcode: "old-code", allow: { download: false, comments: false } });
    const submitted = store.getState().details[A]!;
    store.patchDetail(A, { passcode: "typed-meanwhile", allow: { ...submitted.allow, comments: true } });
    store.settleDetail(A, submitted);
    const left = store.getState().details[A]!;
    expect(left.label).toBeNull();
    expect(left.passcode).toBe("typed-meanwhile");
    expect(left.allow).toEqual({ comments: true });
  });

  it("settleDetail removes the entry when everything sent is still what is there", () => {
    const store = createReviewLinkStore("u:p");
    store.patchDetail(A, { label: "Sent" });
    store.settleDetail(A, store.getState().details[A]!);
    expect(store.getState().details[A]).toBeUndefined();
  });

  it("a created link clears only the ticks and fields it was made from; later edits and ticks survive", () => {
    const store = createReviewLinkStore("u:p");
    store.toggleSelect(A); store.openCreate();
    store.patchCreate({ label: "Smith", passcode: "secret1" });
    store.setGrant(A, ["x"]);
    const submitted = { videoIds: [A], draft: store.getState().create };
    store.toggleSelect(B); store.patchCreate({ passcode: "changed-meanwhile" }); store.setGrant(B, ["y"]);
    store.showReveal({ url: "https://x.test/d/review?link=a#t=tok", linkId: A, label: "Smith", origin: "create" }, submitted);
    const s = store.getState();
    expect([...s.selection]).toEqual([B]);
    expect(s.create.label).toBe("");
    expect(s.create.passcode).toBe("changed-meanwhile");
    expect(s.create.grants[A]).toBeUndefined();
    expect(s.create.grants[B]).toEqual(["y"]);
  });

  it("one write per lock: a second write under the same lock is refused whatever its scope, and a different lock goes ahead", async () => {
    const store = createReviewLinkStore("u:p");
    const first = deferred<void>();
    void store.run(`grants:${A}:v1`, () => first.promise, vi.fn(), undefined, A);
    expect(await store.run(`patch:${A}`, () => Promise.resolve(), vi.fn(), undefined, A)).toBe(false);
    expect(await store.run(`revoke:${B}`, () => Promise.resolve(), vi.fn(), undefined, B)).toBe(true);
    first.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(await store.run(`patch:${A}`, () => Promise.resolve(), vi.fn(), undefined, A)).toBe(true);
  });

  it("one-time URLs queue: a second never overwrites the first, and each goes only when dismissed", () => {
    const store = createReviewLinkStore("u:p");
    store.showReveal({ url: "https://x.test/d/review?link=a#t=first", linkId: A, label: "A", origin: "replace" });
    store.showReveal({ url: "https://x.test/d/review?link=b#t=second", linkId: B, label: "B", origin: "create" });
    expect(store.getState().reveals.map((r) => r.url)).toEqual(["https://x.test/d/review?link=a#t=first", "https://x.test/d/review?link=b#t=second"]);
    expect(store.getState().reveal?.url).toContain("#t=first");
    store.dismissReveal();
    expect(store.getState().view.kind).toBe("reveal");
    expect(store.getState().reveal?.url).toContain("#t=second");
    store.dismissReveal();
    expect(store.getState().reveals).toEqual([]);
    expect(store.getState().view).toEqual({ kind: "detail", linkId: B });
  });

  it("closing the dialog on a reveal drops only the one on screen", () => {
    const store = createReviewLinkStore("u:p");
    store.showReveal({ url: "https://x.test/d/review?link=a#t=first", linkId: A, label: null, origin: "replace" });
    store.showReveal({ url: "https://x.test/d/review?link=b#t=second", linkId: B, label: null, origin: "replace" });
    store.closeDialog();
    expect(store.getState().reveal?.url).toContain("#t=second");
    expect(store.getState().view.kind).toBe("reveal");
    store.closeDialog();
    expect(store.getState().reveals).toEqual([]);
    expect(store.getState().view.kind).toBe("closed");
  });

  it("three mixed writes on one link started together: only the first goes out, so there is no reverse-order answer to apply", async () => {
    const store = createReviewLinkStore("u:p");
    const sent: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const start = (scope: string, i: number) => store.run(scope, () => { sent.push(scope); return gates[i]!.promise; }, vi.fn(), undefined, A);
    const results = [start(`grants:${A}:v1`, 0), start(`remove:${A}:v2`, 1), start(`patch:${A}`, 2)];
    gates[2]!.resolve(); gates[1]!.resolve(); gates[0]!.resolve();
    expect(await Promise.all(results)).toEqual([true, false, false]);
    expect(sent).toEqual([`grants:${A}:v1`]);
  });
});
