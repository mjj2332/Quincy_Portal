import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Filters, type FilterField, type FilterQuery } from "./filters";

/**
 * #255: the Quincy-added `ruleMenu` option on `<Filters>` (see `filters.tsx`'s header). Upstream
 * always draws Duplicate and Negate in a chip's menu; `ruleMenu={{ duplicate: false, negate: false }}`
 * hides them and leaves Remove. Omitted, the menu is upstream's.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

/** Real-timer poll — Base UI's open-state transition lands a tick removed from the triggering render. */
async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

const fields: FilterField<string[]>[] = [
  {
    id: "stage",
    label: "Stage",
    type: "multiselect",
    options: [{ value: "editing", label: "Editing" }],
    operators: [{ value: "is_any_of", label: "is any of", arity: "many" }],
  },
];

const query: FilterQuery<string[]> = {
  id: "root",
  type: "group",
  combinator: "and",
  rules: [{ id: "r1", type: "rule", path: ["stage"], operator: "is_any_of", value: ["editing"] }],
};

async function openChipMenu() {
  const kebab = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Stage filter options");
  expect(kebab).toBeDefined();
  await act(async () => {
    kebab!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    kebab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    kebab!.click();
    await Promise.resolve();
  });
}

function menuItemNames(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? "");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

describe("Filters `ruleMenu` (#255 Quincy addition)", () => {
  it("draws upstream's Duplicate, Negate and Remove when omitted", async () => {
    await render(<Filters fields={fields} defaultQuery={query} />);
    await openChipMenu();
    await waitFor(() => expect(menuItemNames()).toEqual(["Duplicate", "Negate", "Remove"]));
  });

  it("hides Duplicate and Negate, keeping Remove, when both are off", async () => {
    await render(<Filters fields={fields} defaultQuery={query} ruleMenu={{ duplicate: false, negate: false }} />);
    await openChipMenu();
    await waitFor(() => expect(menuItemNames()).toEqual(["Remove"]));
  });

  it("hides each row independently", async () => {
    await render(<Filters fields={fields} defaultQuery={query} ruleMenu={{ negate: false }} />);
    await openChipMenu();
    await waitFor(() => expect(menuItemNames()).toEqual(["Duplicate", "Remove"]));
  });
});
