/**
 * #367 — Copy link copies the link for the SHOWN Workspace tab and announces the outcome through
 * the shared toast live region. Query by `data-testid`, role and text only.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyProjectLinkButton } from "./CopyProjectLinkButton";
import { ToastViewport } from "./ToastViewport";
import { clearToasts } from "../../lib/toast-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
let root: Root; let host: HTMLElement;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function mount(node: React.ReactElement) { await act(async () => { root.render(node); await Promise.resolve(); }); }
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="copy-project-link"]')!;
async function click() { await act(async () => { button().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await Promise.resolve(); await Promise.resolve(); }); }
const live = () => host.querySelector('[aria-live="polite"]')?.textContent ?? "";
function setClipboard(value: unknown) { Object.defineProperty(navigator, "clipboard", { value, configurable: true }); }
const ui = (tab: "raw" | "collaboration" = "raw") => <><CopyProjectLinkButton projectId={PROJECT_ID} tab={tab} /><ToastViewport /></>;

beforeEach(() => { vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearToasts(); vi.useRealTimers(); setClipboard(undefined); });

describe("CopyProjectLinkButton (#367)", () => {
  it("copies the shown tab's link, announces it, shows Copied, then reverts after 2s", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await mount(ui("raw"));
    expect(button().textContent).toContain("Copy link");
    await click();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/${PROJECT_ID}?tab=raw`);
    expect(live()).toContain("Link copied.");
    expect(button().textContent).toContain("Copied");
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(button().textContent).toContain("Copy link");
  });

  it("copies Collaboration's frozen ?collaboration=open spelling", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await mount(ui("collaboration"));
    await click();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/${PROJECT_ID}?collaboration=open`);
  });

  it("announces a failure and never claims success when the clipboard rejects", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    await mount(ui());
    await click(); await flush();
    expect(live()).toContain("Couldn't copy the link.");
    expect(live()).not.toContain("Link copied.");
    expect(button().textContent).toContain("Copy link");
  });

  it("announces a failure without throwing where the clipboard API is unavailable", async () => {
    setClipboard(undefined);
    await mount(ui());
    await expect(click()).resolves.toBeUndefined();
    expect(live()).toContain("Couldn't copy the link.");
    expect(live()).not.toContain("Link copied.");
  });
});
