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
  enabled: true, options: DEFAULT_MARKER_EXPORT_OPTIONS, setOptions: vi.fn(), phase: { kind: "idle" }, pending: false, count: 3, noteCount: 3, title: "Film", version: 1, start: vi.fn(async () => undefined), ...over,
});
async function render(exp: MarkerExport, separated = false) {
  if (root) { await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); }
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<><Menu triggerLabel="Notes actions" label="Notes actions" defaultOpen trigger={<span>⋯</span>}><MarkerExportMenuItems exp={exp} separated={separated} /></Menu><MarkerExportNotices exp={exp} /></>); });
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

describe("Menu content (#741 9 design review)", () => {
  it("says so when notes merged onto one frame, and is plain otherwise", async () => {
    await render(exportOf({ count: 2, noteCount: 3 }));
    expect(tid("video-export-count")!.textContent).toBe("2 markers · 3 notes");
  });
  it("is just the marker count when every note has its own", async () => {
    await render(exportOf({ count: 3, noteCount: 3 }));
    expect(tid("video-export-count")!.textContent).toBe("3 markers");
  });
  it("singular forms", async () => {
    await render(exportOf({ count: 1, noteCount: 2 }));
    expect(tid("video-export-count")!.textContent).toBe("1 marker · 2 notes");
  });
  it("draws a hairline above the group only when asked (copy items present)", async () => {
    await render(exportOf({}));
    expect(tid("video-export-separator")).toBeNull();
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
  });
  it("labels the group and the radios, and a filename preview carries its full name as a title", async () => {
    await render(exportOf({}), true);
    expect(tid("video-export-separator")).not.toBeNull();
    const eyebrow = [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((g) => g.textContent?.startsWith("Export markers"))!;
    const label = eyebrow.firstElementChild as HTMLElement;
    expect(label.textContent).toBe("Export markers");
    expect(tid("video-export-status-label")!.textContent).toBe("Status");
    expect(tid("video-export-edl-name")!.getAttribute("title")).toBe("Film-v1-notes-all-public.edl");
  });
  it("shows an empty outlined box when the internal checkbox is unticked, and the check when ticked", async () => {
    await render(exportOf({}));
    const box = tid("video-export-internal-box")!;
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.querySelector("svg")).toBeNull();
    await render(exportOf({ options: { includeInternal: true, status: "all" } }));
    expect(tid("video-export-internal-box")!.querySelector("svg")).not.toBeNull();
  });
});

