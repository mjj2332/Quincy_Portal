import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Progress } from "./progress";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

describe("reui/progress (Quincy adaptation, #377)", () => {
  it("is a 2px flat track on --surface-sunken filled with the --accent token", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(<Progress value={2} max={4} aria-label="Checklist progress" />); });
    const bar = host.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    const track = bar.firstElementChild as HTMLElement; const indicator = track.firstElementChild as HTMLElement;
    expect(track.className).toContain("h-[2px]"); expect(track.className).toContain("bg-surface-sunken"); expect(track.className).toContain("rounded-none");
    expect(indicator.className).toContain("bg-[var(--accent)]");
    expect(track.className).not.toContain("bg-muted"); expect(indicator.className).not.toContain("bg-primary");
  });
});
