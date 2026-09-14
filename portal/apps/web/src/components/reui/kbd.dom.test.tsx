import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kbd, KbdGroup } from "./kbd";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host.remove();
});

describe("Kbd / KbdGroup", () => {
  it("renders a real kbd element with its children", async () => {
    await render(<Kbd data-testid="kbd-solo">⌘K</Kbd>);
    const kbd = host.querySelector('[data-testid="kbd-solo"]')!;
    expect(kbd.tagName).toBe("KBD");
    expect(kbd.textContent).toBe("⌘K");
  });

  it("wraps multiple keys in KbdGroup", async () => {
    await render(
      <KbdGroup data-testid="kbd-group">
        <Kbd data-testid="kbd-first">⌘</Kbd>
        <Kbd data-testid="kbd-second">K</Kbd>
      </KbdGroup>,
    );
    const group = host.querySelector('[data-testid="kbd-group"]')!;
    expect(group.tagName).toBe("KBD"); // the primitive itself renders a <kbd>, not a <div>
    expect(host.querySelector('[data-testid="kbd-first"]')?.tagName).toBe("KBD");
    expect(host.querySelector('[data-testid="kbd-second"]')?.tagName).toBe("KBD");
    expect(group.textContent).toBe("⌘K");
  });
});
