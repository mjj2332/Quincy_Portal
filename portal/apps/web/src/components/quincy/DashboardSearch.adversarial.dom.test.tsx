import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardSearch } from "./DashboardSearch";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  setDashboardSearchUrlWriter,
} from "../../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

async function render(value: ReactNode) {
  await act(async () => { root.render(value); await Promise.resolve(); });
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  __resetDashboardSearchStoreForTest();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  __resetDashboardSearchStoreForTest();
});

/** Reduced by #427 from `ShellSearch`'s rail/sheet mode matrix: there is one mode now, a toolbar field. */
describe("DashboardSearch adversarial probes (#217, #427)", () => {
  it("renders a usable search surface: an inline input and nothing else to open", async () => {
    await render(<DashboardSearch principalId="principal-a" />);
    expect(host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="shell-search-trigger"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("uses the normalized, encoded committed value for Enter: whitespace collapsed, handed to the Dashboard's writer", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await render(<DashboardSearch principalId="principal-a" />);
    const input = host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;
    await inputValue(input, "  smith   + co  ");
    await keydown(input, { key: "Enter" });
    // #217 build, step 5 (sanctioned): the committed value used to be read back from the store's
    // own `.query`; the writer call IS the commit now, so this asserts on it directly.
    expect(writes).toEqual(["smith + co"]);
    unregister();
  });

  it("clears a non-empty draft on Escape with no dialog or popover to close", async () => {
    await render(<DashboardSearch principalId="principal-a" />);
    const input = host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;
    await inputValue(input, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    await keydown(input, { key: "Escape" });
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "" });
    expect(input.value).toBe("");
  });

  it("keeps the input element itself across typing and clearing, so a focus request never lands on a stale node", async () => {
    await render(<DashboardSearch principalId="principal-a" />);
    const input = host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;
    await inputValue(input, "smith");
    await keydown(input, { key: "Escape" });
    expect(host.querySelector('[data-testid="dashboard-search"]')).toBe(input);
  });
});
