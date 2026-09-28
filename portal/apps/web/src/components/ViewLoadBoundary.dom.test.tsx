import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewLoadBoundary } from "./ViewLoadBoundary";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHUNK_MESSAGE = "Failed to fetch dynamically imported module: https://quincy.test/assets/ProductionGantt-OLD.js";

let root: Root;
let host: HTMLElement;

async function render(value: ReactNode) {
  await act(async () => { root.render(value); await Promise.resolve(); });
}

function Thrower({ error }: { error: unknown }): ReactNode {
  throw error;
}

function reloadButton() {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reload");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ViewLoadBoundary (#292)", () => {
  it("renders its children when nothing throws", async () => {
    const reload = vi.fn();
    await render(<ViewLoadBoundary viewLabel="Gantt" reload={reload}><div data-testid="child">ok</div></ViewLoadBoundary>);
    expect(host.querySelector('[data-testid="child"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="view-load-error"]')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows the update notice for a stale chunk, and reloads only on click", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    await render(<ViewLoadBoundary viewLabel="Gantt" reload={reload}><Thrower error={new TypeError(CHUNK_MESSAGE)} /></ViewLoadBoundary>);
    const notice = host.querySelector<HTMLElement>('[data-testid="view-load-error"]');
    expect(notice).toBeTruthy();
    expect(notice?.getAttribute("data-kind")).toBe("chunk");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("The Portal may have been updated. Reload to open the Gantt.");
    expect(consoleError).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    await act(async () => { reloadButton()!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows the generic error state for any other error, with the same Reload", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    await render(<ViewLoadBoundary viewLabel="calendar" reload={reload}><Thrower error={new Error("boom")} /></ViewLoadBoundary>);
    const notice = host.querySelector<HTMLElement>('[data-testid="view-load-error"]');
    expect(notice?.getAttribute("data-kind")).toBe("error");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("The calendar could not load.");
    expect(consoleError).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    await act(async () => { reloadButton()!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
