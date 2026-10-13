import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedUploadTray } from "./EmbeddedUploadTray";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });
async function render(phase: "preparing" | "failed") {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<EmbeddedUploadTray uploads={[{ key: 1, name: "IMG_1.HEIC", percent: 0, kind: "image", phase }]} errors={[]} onCancel={vi.fn()} onRetry={vi.fn()} />); });
  return host;
}

describe("EmbeddedUploadTray row layout (#495)", () => {
  it("Retry and Remove in the failed Notice are padding-free text buttons", async () => {
    const host = await render("failed");
    for (const label of ["Retry preparing IMG_1.HEIC", "Remove IMG_1.HEIC"]) {
      const cls = host.querySelector(`button[aria-label="${label}"]`)!.className;
      expect(cls).toContain("px-0");
    }
  });
  it("the preparing row top-aligns its spinner to the first text line and Remove matches", async () => {
    const host = await render("preparing");
    const status = host.querySelector('[role="status"]')!;
    expect(status.className).toContain("items-start");
    expect(status.className).not.toContain("items-center");
    expect(host.querySelector('button[aria-label="Remove IMG_1.HEIC"]')!.className).toContain("px-0");
  });
});

describe("EmbeddedUploadTray Cancel vs Remove (#556)", () => {
  it("routes Remove on preparing and failed rows to onRemove, and Cancel on a running video to onCancel", async () => {
    const onCancel = vi.fn(); const onRemove = vi.fn();
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<EmbeddedUploadTray uploads={[
      { key: 1, name: "a.HEIC", percent: 0, kind: "image", phase: "preparing" },
      { key: 2, name: "b.HEIC", percent: 0, kind: "image", phase: "failed" },
      { key: 3, name: "c.mp4", percent: 10, kind: "video" },
    ]} errors={[]} onCancel={onCancel} onRemove={onRemove} onRetry={vi.fn()} />); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Remove a.HEIC"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Remove b.HEIC"]')!.click(); });
    expect(onRemove.mock.calls).toEqual([[1], [2]]); expect(onCancel).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Cancel upload of c.mp4"]')!.click(); });
    expect(onCancel.mock.calls).toEqual([[3]]);
  });
});

describe("EmbeddedUploadTray finished entries with a shared caution (#845)", () => {
  const CAUTION = "This file isn't fast-start.";
  const done = (key: number, name: string, cautions: string[] = [CAUTION]) => ({ key, name, percent: 100, kind: "video" as const, phase: "done" as const, cautions });
  async function mountTray(uploads: ReturnType<typeof done>[], onRemove = vi.fn(), pluralCaution?: (c: string) => string) {
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<EmbeddedUploadTray uploads={uploads} errors={[]} onCancel={vi.fn()} onRemove={onRemove} {...(pluralCaution ? { pluralCaution } : {})} />); });
    return host;
  }
  const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); };

  it("a lone finished entry keeps its own panel", async () => {
    const host = await mountTray([done(1, "Kitchen cut 1.mp4")]);
    expect(host.textContent).toContain("Kitchen cut 1.mp4 uploaded, with a warning.");
    expect(host.querySelectorAll('button[aria-label^="Dismiss warning"]')).toHaveLength(1);
  });

  it("two or more finished entries sharing a caution make one Notice naming the films, with one Dismiss that dismisses all of them", async () => {
    const onRemove = vi.fn();
    const host = await mountTray([done(1, "Kitchen cut 1.mp4"), done(2, "Kitchen cut 2.mp4"), done(3, "Hall.mp4", ["Only this one."])], onRemove, (c) => c.replace("This file isn't", "These files aren't"));
    const text = host.textContent!;
    expect(text).toContain("Kitchen cut 1.mp4, Kitchen cut 2.mp4 uploaded.");
    expect(text.split("fast-start").length - 1).toBe(1);
    expect(text).toContain("These files aren't fast-start.");
    expect(text).toContain("Hall.mp4 uploaded, with a warning.");
    const dismisses = [...host.querySelectorAll('button')].filter((b) => b.textContent === "Dismiss");
    expect(dismisses).toHaveLength(2);
    await click(dismisses[0]!);
    expect(onRemove.mock.calls.map(([key]) => key).sort()).toEqual([1, 2]);
  });
});
