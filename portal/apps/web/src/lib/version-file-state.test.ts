import { describe, expect, it } from "vitest";
import { createVersionFileState } from "./version-file-state";

const deferred = () => { let resolve!: (value: string | null) => void; let reject!: (error: unknown) => void; const promise = new Promise<string | null>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createVersionFileState (#939)", () => {
  it("checks, then keeps the refusal for that film only, and a new send clears it", async () => {
    const store = createVersionFileState();
    let changes = 0; store.subscribe(() => { changes += 1; });
    const first = deferred();
    store.send("a", () => first.promise);
    expect(store.get("a")).toEqual({ checking: true, message: null });
    expect(store.get("b")).toEqual({ checking: false, message: null });
    first.resolve("Not an MP4.");
    await settle();
    expect(store.get("a")).toEqual({ checking: false, message: "Not an MP4." });
    expect([...store.all().keys()]).toEqual(["a"]);
    const second = deferred();
    store.send("a", () => second.promise);
    expect(store.get("a")).toEqual({ checking: true, message: null });
    second.resolve(null);
    await settle();
    expect(store.all().size).toBe(0);
    expect(changes).toBe(4);
  });

  it("an older send that answers late writes nothing over the newer one", async () => {
    const store = createVersionFileState();
    const older = deferred(); const newer = deferred();
    store.send("a", () => older.promise);
    store.send("a", () => newer.promise);
    older.resolve("Too big.");
    await settle();
    expect(store.get("a")).toEqual({ checking: true, message: null });
    newer.resolve(null);
    await settle();
    expect(store.get("a")).toEqual({ checking: false, message: null });
  });

  it("a check that throws leaves the film idle, and the rejection is not swallowed", async () => {
    const store = createVersionFileState();
    const failing = deferred();
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => { seen.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      store.send("a", () => failing.promise);
      failing.reject(new Error("offline"));
      await settle(); await settle();
      expect(store.get("a")).toEqual({ checking: false, message: null });
      expect(seen).toHaveLength(1);
    } finally { process.off("unhandledRejection", onRejection); }
  });
});
