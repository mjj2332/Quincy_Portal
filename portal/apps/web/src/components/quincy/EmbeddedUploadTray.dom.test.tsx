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
