import { describe, expect, it } from "vitest";
import { createChangeTracker } from "./whiteboard-changes";

const el = (id: string, version: number, versionNonce: number) => ({ id, version, versionNonce });
const hashOf = (scene: ReadonlyArray<{ id: string; version: number; versionNonce: number }>) => scene.reduce((sum, e) => sum + e.version, 0);

/** The change event handler as the canvas runs it: dirty only when the tracker says the change is the person's own. */
function board() {
  const tracker = createChangeTracker();
  let saves = 0;
  const onChange = (scene: ReturnType<typeof el>[]) => { if (tracker.classify(scene, hashOf(scene)) === "local") saves += 1; };
  const applyRemote = (scene: ReturnType<typeof el>[], taken: ReturnType<typeof el>[]) => tracker.remoteApplied(hashOf(scene), scene, taken);
  return { tracker, onChange, applyRemote, saves: () => saves };
}

describe("change classification (#499, Sol round 10 finding 1)", () => {
  it("a remote batch alone is not an edit", () => {
    const b = board();
    b.tracker.seed([el("a", 1, 1)]);
    const scene = [el("a", 1, 1), el("r", 1, 9)];
    b.applyRemote(scene, [el("r", 1, 9)]);
    b.onChange(scene);
    expect(b.saves()).toBe(0);
  });

  it("a local edit not yet reported, then a remote batch, then the change event: exactly one save", () => {
    const b = board();
    b.tracker.seed([el("a", 1, 1)]);
    // The person edits "a" (version 2); Excalidraw has not fired onChange yet. The remote batch lands first.
    const scene = [el("a", 2, 5), el("r", 1, 9)];
    b.applyRemote(scene, [el("r", 1, 9)]);
    b.onChange(scene);
    expect(b.saves()).toBe(1);
  });

  it("the same ordering with the edit on an element the remote batch also touched is still one save", () => {
    const b = board();
    b.tracker.seed([el("a", 1, 1), el("b", 1, 2)]);
    const scene = [el("a", 2, 5), el("b", 2, 7)];
    b.applyRemote(scene, [el("b", 2, 7)]);
    b.onChange(scene);
    expect(b.saves()).toBe(1);
  });
});
