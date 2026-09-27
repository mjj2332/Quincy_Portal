/**
 * 2026-09-28 — `reui/separator.tsx`'s registry variants were written as `data-horizontal:` /
 * `data-vertical:`, which match nothing under Base UI 1.7.0, so every separator rendered with no
 * size (the account menu's separator was 0px tall). See the header in `separator.tsx`, same date.
 *
 * happy-dom has no layout, so the 1px rule cannot be measured here (that is the browser pass's
 * job). What this pins is the class contract the fix rests on, against the real rendered DOM:
 * every orientation variant is written against the attribute Base UI actually emits
 * (`data-orientation="horizontal|vertical"`), and the element carries it.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Separator } from "@/components/reui/separator";

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

describe("Separator orientation variants match the attribute Base UI emits (2026-09-28)", () => {
  for (const orientation of ["horizontal", "vertical"] as const) {
    it(`a ${orientation} separator's variants all target data-orientation=${orientation}, which it carries`, async () => {
      await render(<Separator orientation={orientation} />);
      // selected by Base UI's own attribute - the one every variant must be written against
      const separator = host.querySelector<HTMLElement>(`[data-orientation="${orientation}"]`);
      expect(separator).not.toBeNull();
      expect(separator!.getAttribute("role")).toBe("separator");
      expect(separator!.getAttribute("aria-orientation")).toBe(orientation);
      // Base UI emits data-orientation, never a bare data-horizontal/data-vertical attribute
      expect(separator!.hasAttribute(`data-${orientation}`)).toBe(false);
      const classes = separator!.className.split(/\s+/);
      expect(classes.filter((c) => /^data-(horizontal|vertical):/.test(c))).toEqual([]);
      if (orientation === "horizontal") {
        expect(classes).toContain("data-[orientation=horizontal]:h-px");
        expect(classes).toContain("data-[orientation=horizontal]:w-full");
      } else {
        expect(classes).toContain("data-[orientation=vertical]:w-px");
        expect(classes).toContain("data-[orientation=vertical]:self-stretch");
      }
    });
  }

  it("defaults to horizontal", async () => {
    await render(<Separator />);
    expect(host.querySelector('[data-orientation="horizontal"]')).not.toBeNull();
  });
});
