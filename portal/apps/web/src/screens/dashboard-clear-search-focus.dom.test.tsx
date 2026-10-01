import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardSearch } from "../components/quincy/DashboardSearch";
import { __resetDashboardSearchStoreForTest, setDashboardSearchDraft } from "../lib/dashboard-search-store";

/**
 * #217, rewritten by #427. The old chip's Clear button unmounted itself, so focus had to be handed
 * to a control that survived (`focusTargetAfterClearingSearch`, now deleted). The in-field clear
 * button instead keeps focus in the INPUT, which survives the clear, so there is nothing to hand
 * over: focus never leaves the search field, and never falls back to `document.body`.
 */
let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  __resetDashboardSearchStoreForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  __resetDashboardSearchStoreForTest();
});

describe("clearing the Dashboard search (#427)", () => {
  it("the in-field Clear button empties the draft, removes itself, and focus stays in the input", async () => {
    await act(async () => { root!.render(<DashboardSearch principalId="u1" />); });
    await act(async () => { setDashboardSearchDraft("smith", "u1"); });
    const input = host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;
    expect(input.value).toBe("smith");
    const clear = host.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!;
    clear.focus();
    await act(async () => { clear.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
    expect(input.value).toBe("");
    expect(host.querySelector('[aria-label="Clear search"]')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("no Clear button while the field is empty", async () => {
    await act(async () => { root!.render(<DashboardSearch principalId="u1" />); });
    expect(host.querySelector('[aria-label="Clear search"]')).toBeNull();
  });
});
