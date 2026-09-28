/**
 * 2026-09-28 — the rest of the `data-horizontal:` / `data-vertical:` sweep under `components/reui/`
 * (`reui/tabs.tsx` item 4 in #202, then `scroll-area.tsx` and `separator.tsx`). Those variants match
 * nothing under Base UI 1.7.0, which emits `data-orientation="horizontal|vertical"`. See the
 * headers in `button-group.tsx` (item 4), `sidebar.tsx` (`SidebarSeparator`) and `field.tsx`, same
 * date.
 *
 * happy-dom has no layout, so widths cannot be measured here. What this pins is the class contract
 * against the real rendered DOM: every orientation variant targets the attribute the element
 * actually carries, and the wrappers' width overrides are written so tailwind-merge (not CSS
 * specificity) resolves them against `Separator`'s own `data-[orientation=horizontal]:w-full`.
 * The "no `w-full` survives" assertions are load-bearing because `reui/separator.tsx`'s own
 * variants are now live too; and since both wrappers render `Separator`, the dead-variant
 * assertion also fails if its registry `data-horizontal:` classes ever come back.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ButtonGroupSeparator } from "@/components/reui/button-group";
import { Field, FieldDescription } from "@/components/reui/field";
import { SidebarSeparator } from "@/components/reui/sidebar";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

/** Selected by Base UI's own attribute - the one every variant must be written against. */
function separatorWith(orientation: "horizontal" | "vertical") {
  const separator = host.querySelector<HTMLElement>(`[data-orientation="${orientation}"]`);
  expect(separator).not.toBeNull();
  expect(separator!.getAttribute("role")).toBe("separator");
  expect(separator!.getAttribute("aria-orientation")).toBe(orientation);
  // Base UI emits data-orientation, never a bare data-horizontal/data-vertical attribute
  expect(separator!.hasAttribute(`data-${orientation}`)).toBe(false);
  return separator!.className.split(/\s+/);
}

const deadVariant = /(^|[-:])data-(horizontal|vertical)[:/]/;

describe("ButtonGroupSeparator orientation variants match the attribute Base UI emits (2026-09-28)", () => {
  it("defaults to vertical, and its insets target data-orientation=vertical", async () => {
    await render(<ButtonGroupSeparator />);
    const classes = separatorWith("vertical");
    expect(classes.filter((c) => deadVariant.test(c))).toEqual([]);
    expect(classes).toContain("data-[orientation=vertical]:my-px");
    expect(classes).toContain("data-[orientation=vertical]:h-auto");
  });

  it("horizontal: its w-auto replaces Separator's w-full through tailwind-merge", async () => {
    await render(<ButtonGroupSeparator orientation="horizontal" />);
    const classes = separatorWith("horizontal");
    expect(classes.filter((c) => deadVariant.test(c))).toEqual([]);
    expect(classes).toContain("data-[orientation=horizontal]:mx-px");
    expect(classes).toContain("data-[orientation=horizontal]:w-auto");
    expect(classes).not.toContain("data-[orientation=horizontal]:w-full");
  });
});

describe("SidebarSeparator's width override is a tailwind-merge conflict, not a specificity loss (2026-09-28)", () => {
  it("carries data-[orientation=horizontal]:w-auto and no w-full beside its mx-2", async () => {
    await render(<SidebarSeparator />);
    const classes = separatorWith("horizontal");
    expect(classes.filter((c) => deadVariant.test(c))).toEqual([]);
    expect(classes).toContain("mx-2");
    expect(classes).toContain("data-[orientation=horizontal]:w-auto");
    // a bare w-auto would lose to the variant on specificity (0,1,0 vs 0,2,0)
    expect(classes).not.toContain("w-auto");
    expect(classes).not.toContain("data-[orientation=horizontal]:w-full");
  });
});

describe("FieldDescription's text-balance targets data-orientation (2026-09-28)", () => {
  it("is written against the attribute Field emits", async () => {
    await render(
      <Field orientation="horizontal">
        <FieldDescription>Shown beside the control</FieldDescription>
      </Field>,
    );
    const field = host.querySelector<HTMLElement>('[data-orientation="horizontal"]');
    expect(field).not.toBeNull();
    expect(field!.hasAttribute("data-horizontal")).toBe(false);
    const description = field!.querySelector<HTMLElement>("p");
    expect(description?.textContent).toBe("Shown beside the control");
    const classes = description!.className.split(/\s+/);
    expect(classes.filter((c) => deadVariant.test(c))).toEqual([]);
    expect(classes).toContain("group-has-data-[orientation=horizontal]/field:text-balance");
  });
});
