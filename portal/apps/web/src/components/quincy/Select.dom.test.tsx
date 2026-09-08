import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./Select";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); });
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

const OPTIONS: readonly SelectOption<"a" | "b" | "c">[] = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
  { value: "c", label: "Option C" },
];

describe("quincy Select — kept light: Base UI's positioner under happy-dom is the flaky spot", () => {
  it("puts ariaLabel on the trigger", async () => {
    await render(<Select value="a" onValueChange={() => undefined} options={OPTIONS} ariaLabel="Sort" />);
    expect(host.querySelector('[aria-label="Sort"]')).not.toBeNull();
  });

  it("gives the trigger ReUI-derived secondary (outline) classes, not legacy ui/button's", async () => {
    // The one line this slice actually changes: the trigger's `buttonClasses` now comes from
    // `@/components/quincy/Button`, not `@/components/ui/button`. Every other test in this file
    // stays green if that import were reverted — this one would not.
    await render(<Select value="a" onValueChange={() => undefined} options={OPTIONS} ariaLabel="Sort" />);
    const trigger = host.querySelector('[aria-label="Sort"]')!;
    expect(trigger.className).toContain("bg-background");
    expect(trigger.className).not.toContain("bg-card");
    expect(trigger.className).not.toContain("border-[length:var(--border-width-hair)]");
  });

  it("reaches the trigger with disabled", async () => {
    await render(<Select value="a" onValueChange={() => undefined} options={OPTIONS} ariaLabel="Sort" disabled />);
    const trigger = host.querySelector('[aria-label="Sort"]')!;
    expect(trigger.getAttribute("disabled")).not.toBeNull();
  });

  it("opens and lists exactly the passed options, then calls onValueChange with the selected value", async () => {
    const onValueChange = vi.fn();
    await render(<Select value="a" onValueChange={onValueChange} options={OPTIONS} ariaLabel="Sort" />);
    const trigger = host.querySelector<HTMLElement>('[aria-label="Sort"]')!;
    await act(async () => { trigger.click(); await Promise.resolve(); });

    const list = document.querySelector('[role="listbox"]');
    expect(list).not.toBeNull();
    const items = list!.querySelectorAll('[role="option"]');
    expect(items).toHaveLength(OPTIONS.length);
    expect([...items].map((item) => item.textContent)).toEqual(["Option A", "Option B", "Option C"]);

    const target = [...items].find((item) => item.textContent === "Option B") as HTMLElement;
    await act(async () => { target.click(); await Promise.resolve(); });
    expect(onValueChange).toHaveBeenCalledWith("b");
  });
});
