/**
 * #498 design review: `toggle-group.tsx` shipped with the registry's `group-data-horizontal/toggle-group:` and
 * `data-vertical:` variants, which match nothing under Base UI 1.7.0 (it emits `data-orientation`), so the
 * first/last corner radii and the outline variant's `border-l-0` never applied. Same sweep as
 * `button-group-separator-orientation.dom.test.tsx`. happy-dom has no layout: this pins the class contract
 * against the attribute the rendered group actually carries.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToggleGroup, ToggleGroupItem } from "@/components/reui/toggle-group";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); host.remove(); root = null; });

async function render(orientation: "horizontal" | "vertical") {
  await act(async () => {
    root!.render(
      <ToggleGroup variant="outline" spacing={0} orientation={orientation} aria-label="g">
        <ToggleGroupItem value="a" aria-label="a" />
        <ToggleGroupItem value="b" aria-label="b" />
      </ToggleGroup>,
    );
    await Promise.resolve();
  });
  return { group: host.querySelector<HTMLElement>('[role="group"]')!, item: host.querySelector<HTMLElement>("button[aria-label]")! };
}

describe("toggle-group orientation variants (#498)", () => {
  it("the rendered group carries data-orientation, the attribute the variants must target", async () => {
    const { group } = await render("vertical");
    expect(group.getAttribute("data-orientation")).toBe("vertical");
  });

  it("no dead bare data-horizontal/data-vertical variants remain", async () => {
    const { group, item } = await render("horizontal");
    expect(`${group.className} ${item.className}`).not.toMatch(/data-horizontal|data-vertical/);
  });

  it("corner radii and outline borders target data-[orientation=...]", async () => {
    const { group, item } = await render("horizontal");
    expect(group.className).toContain("data-[orientation=vertical]:flex-col");
    for (const cls of [
      "group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:first:rounded-l-lg",
      "group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:first:rounded-t-lg",
      "group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:last:rounded-r-lg",
      "group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:last:rounded-b-lg",
      "group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0",
      "group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0",
      "group-data-[orientation=horizontal]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l",
      "group-data-[orientation=vertical]/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
    ]) expect(item.className).toContain(cls);
  });
});
