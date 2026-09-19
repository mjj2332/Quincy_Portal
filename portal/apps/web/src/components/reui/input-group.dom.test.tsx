import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group";

/**
 * #217 design-fix round 2, item 2. `InputGroup`'s own `focus-within:` outline used to fire on ANY
 * focused descendant, including an `InputGroupButton` (the Combobox trigger/clear) -- so a
 * focused BUTTON painted both its own global `:focus-visible` outline (unsuppressed on `Button`,
 * `reui/button.tsx`'s own divergence 5) and the wrapper's `focus-within` outline at once: two
 * indicators on one focused control. The fix scopes the wrapper's own treatment to
 * `has-[input:focus-visible]:`, so it only activates for the INPUT specifically, leaving a
 * focused button showing only its own indicator.
 *
 * Class-level assertions, not computed-style ones: jsdom does not apply the real stylesheet
 * (`:focus-visible { outline: … }` lives in `tokens/base.css`, never loaded here), so the only
 * thing a DOM test CAN prove is which class strings ended up on which element.
 */
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

describe("InputGroup — exactly one focus indicator (#217 design-fix round 2, item 2)", () => {
  it("scopes its own focus treatment to the input, not to any focused descendant", async () => {
    await render(
      <InputGroup data-testid="group">
        <InputGroupInput data-testid="input" aria-label="Search" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton data-testid="button">Clear</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );

    const group = host.querySelector('[data-testid="group"]')!;
    expect(group.className).toContain("has-[input:focus-visible]:border-primary");
    expect(group.className).toContain("has-[input:focus-visible]:outline-solid");
    expect(group.className).toContain("has-[input:focus-visible]:outline-ring");
    expect(group.className).toContain("has-[input:focus-visible]:outline-offset-2");
    // The old, over-broad selector must be gone, not just superseded.
    expect(group.className).not.toContain("focus-within:border-primary");
    expect(group.className).not.toContain("focus-within:outline");
  });

  it("suppresses only the input's own global focus-visible outline, leaving the button's untouched", async () => {
    await render(
      <InputGroup>
        <InputGroupInput data-testid="input" aria-label="Search" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton data-testid="button">Clear</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );

    const input = host.querySelector('[data-testid="input"]')!;
    const button = host.querySelector('[data-testid="button"]')!;
    expect(input.className).toContain("focus-visible:!outline-none");
    // The button relies on the SAME global `:focus-visible` rule the group now defers to for the
    // input's own box -- it must carry no local suppressor of its own.
    expect(button.className).not.toContain("outline-none");
  });
});
