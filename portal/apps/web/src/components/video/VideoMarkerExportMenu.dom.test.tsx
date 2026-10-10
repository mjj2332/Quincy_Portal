import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../testing/dom-polyfills";
import { DEFAULT_MARKER_EXPORT_OPTIONS } from "../../lib/video-marker-export";
import { Menu } from "../quincy/menu";
import { MarkerExportMenuItems, MarkerExportNotices, type MarkerExport } from "./VideoMarkerExportMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });

const exportOf = (over: Partial<MarkerExport> = {}): MarkerExport => ({
  enabled: true, options: DEFAULT_MARKER_EXPORT_OPTIONS, setOptions: vi.fn(), phase: { kind: "idle" }, pending: false, count: 3, title: "Film", version: 1, start: vi.fn(async () => undefined), ...over,
});
async function render(exp: MarkerExport) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<><Menu triggerLabel="Notes actions" label="Notes actions" defaultOpen trigger={<span>⋯</span>}><MarkerExportMenuItems exp={exp} /></Menu><MarkerExportNotices exp={exp} /></>); });
  await act(async () => { await Promise.resolve(); });
}
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("EDL marker limit in the menu (#741 9)", () => {
  it("disables Resolve EDL above 999 with a hint, and leaves FCPXML available", async () => {
    const exp = exportOf({ count: 1000 });
    await render(exp);
    expect(tid("video-export-edl")!.getAttribute("aria-disabled")).toBe("true");
    expect(tid("video-export-edl-hint")!.textContent).toContain("up to 999 markers (1000 selected)");
    expect(tid("video-export-edl")!.getAttribute("aria-describedby")).toBe("video-export-edl-hint");
    expect(tid("video-export-fcpxml")!.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => { tid("video-export-edl")!.click(); });
    expect(exp.start).not.toHaveBeenCalled();
    await act(async () => { tid("video-export-fcpxml")!.click(); });
    expect(exp.start).toHaveBeenCalledWith("fcpxml", DEFAULT_MARKER_EXPORT_OPTIONS);
  });
  it("999 markers is still allowed, with no hint", async () => {
    await render(exportOf({ count: 999 }));
    expect(tid("video-export-edl")!.getAttribute("aria-disabled")).not.toBe("true");
    expect(tid("video-export-edl-hint")).toBeNull();
  });
  it("an unknown count (notes still loading) leaves both formats available: the server's 422 covers it", async () => {
    await render(exportOf({ count: null }));
    expect(tid("video-export-count")!.textContent).toBe("Counting markers…");
    expect(tid("video-export-edl")!.getAttribute("aria-disabled")).not.toBe("true");
  });
});
