import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestLoadFailure } from "./GuestLoadFailure";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; host?.remove(); host = null; });

describe("GuestLoadFailure", () => {
  it("shows a visible message and a Reload button that the user presses", async () => {
    const reload = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<GuestLoadFailure reload={reload} />); });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reload");
    expect(button).toBeDefined();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => { button!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
