import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Filters, type FilterField, type FilterQuery } from "./filters";

/**
 * #461: the Quincy-added `canAddRule` / `canAddGroup` options on `<Filters>` (see `filters.tsx`'s
 * header). Upstream disables the panel footer's Add filter / Add group and a group footer's Add
 * filter only for a disabled bar; these let a consumer cap the query (rule count, depth) and are
 * asked with the CURRENT query and the parent the node would join (the root's id for the panel
 * footer). Omitted, every button is enabled exactly as upstream.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
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
  rules: [
    { id: "r1", type: "rule", path: ["stage"], operator: "is_any_of", value: ["editing"] },
    { id: "g1", type: "group", combinator: "or", rules: [{ id: "r2", type: "rule", path: ["stage"], operator: "is_any_of", value: ["editing"] }] },
  ],
};

const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);

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

describe("Filters `canAddRule` / `canAddGroup` (#461 Quincy addition)", () => {
  it("enables every Add button when omitted, exactly as upstream", async () => {
    await render(<Filters variant="advanced" advancedMode="inline" fields={fields} defaultQuery={query} />);
    expect(button("Add filter")?.disabled).toBe(false);
    expect(button("Add group")?.disabled).toBe(false);
    expect(button("Add filter to this group")?.disabled).toBe(false);
  });

  it("disables the panel footer's and each group footer's Add filter, and Add group, as the predicates say", async () => {
    await render(<Filters variant="advanced" advancedMode="inline" fields={fields} defaultQuery={query} canAddRule={() => false} canAddGroup={() => false} />);
    expect(button("Add filter")?.disabled).toBe(true);
    expect(button("Add group")?.disabled).toBe(true);
    expect(button("Add filter to this group")?.disabled).toBe(true);
  });

  it("asks with the current query and the parent: the root for the footer, the group for its own", async () => {
    const asked: Array<[string, string, number]> = [];
    const canAddRule = (current: FilterQuery<string[]>, parentId: string) => { asked.push(["rule", parentId, current.rules.length]); return parentId !== "g1"; };
    const canAddGroup = (_current: FilterQuery<string[]>, parentId: string) => { asked.push(["group", parentId, 0]); return parentId === "root"; };
    await render(<Filters variant="advanced" advancedMode="inline" fields={fields} defaultQuery={query} canAddRule={canAddRule} canAddGroup={canAddGroup} />);
    expect(button("Add filter")?.disabled).toBe(false);
    expect(button("Add group")?.disabled).toBe(false);
    expect(button("Add filter to this group")?.disabled).toBe(true);
    expect(asked.some(([kind, parent, size]) => kind === "rule" && parent === "root" && size === 2)).toBe(true);
    expect(asked.some(([kind, parent]) => kind === "rule" && parent === "g1")).toBe(true);
  });
});
