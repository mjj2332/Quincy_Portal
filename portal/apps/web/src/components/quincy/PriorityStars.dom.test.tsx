import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriorityStars, type PriorityStarsProps } from "./PriorityStars";

/**
 * Colocated DOM test for the Quincy-owned priority star control (#81).
 *
 * ## The false green this file is designed against
 *
 * A test that asserts glyph counts, or `getByLabelText("3 stars")`, or that a click fires the
 * callback, passes just as happily against five inert `<span>`s with no role, no tab stop and no
 * key handling — which is to say, **against the vendored ReUI `Rating` this ticket exists to
 * replace.** Click coverage proves nothing about #81 on its own.
 *
 * So every keyboard assertion below dispatches on `document.activeElement` and then asserts where
 * focus actually landed. Dispatching on the group instead would pass even if the handler were
 * bound to the wrong element and focus never moved, because the event bubbles either way.
 *
 * ## What is deliberately not asserted here
 *
 * The 44px coarse-pointer contract. happy-dom has no layout engine and does not resolve
 * `pointer-coarse:`, so `expect(className).toContain("size-11")` would be a source-text assertion
 * wearing a behaviour test's clothes — it would keep passing after someone added a `!w-8`
 * override. That contract belongs in a real-browser pass, not here. Asserting it in this file
 * would be a reassuring lie.
 */

let host: HTMLElement;
let root: Root;

function baseProps(overrides: Partial<PriorityStarsProps> = {}): PriorityStarsProps {
  return {
    priority: null,
    street: "12 Smith Street",
    canPrioritize: true,
    pending: false,
    onPriorityChange: vi.fn(),
    ...overrides,
  };
}

async function render(overrides: Partial<PriorityStarsProps> = {}) {
  const props = baseProps(overrides);
  const { act } = await import("react");
  await act(async () => { root.render(createElement(PriorityStars, props)); await Promise.resolve(); });
  return props;
}

async function rerender(props: PriorityStarsProps) {
  const { act } = await import("react");
  await act(async () => { root.render(createElement(PriorityStars, props)); await Promise.resolve(); });
}

const group = () => host.querySelector('[role="radiogroup"]');
const radios = () => Array.from(host.querySelectorAll('[role="radio"]'));
/** The ternary is hoisted out of the selector: `test-seam.guard` reads selector literals at the
 *  call site, and a ternary inside the template hides the shape from it. */
const star = (n: number) => {
  const label = n === 1 ? "1 star" : `${n} stars`;
  return host.querySelector(`[role="radio"][aria-label="${label}"]`) as HTMLElement | null;
};
const focusedName = () => document.activeElement?.getAttribute("aria-label") ?? null;

/** Dispatch on whatever really has focus — see the header note on bubbling. */
async function pressKey(key: string) {
  const { act } = await import("react");
  const target = document.activeElement;
  if (!target) throw new Error("nothing focused");
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function click(el: HTMLElement) {
  const { act } = await import("react");
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
}

describe("PriorityStars (#81)", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    const { act } = await import("react");
    await act(async () => root.unmount());
    host.remove();
  });

  it("exposes a radiogroup named for its Project, with five radios and an unset state of nothing checked", async () => {
    await render({ priority: null });
    expect(group()?.getAttribute("aria-label")).toBe("Priority for 12 Smith Street");
    expect(radios()).toHaveLength(5);
    expect(radios().every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("checks exactly the set star, and keeps the group's name stable as the value changes", async () => {
    const props = await render({ priority: 3 });
    expect(star(3)?.getAttribute("aria-checked")).toBe("true");
    expect(radios().filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);

    await rerender({ ...props, priority: 5 });
    expect(star(5)?.getAttribute("aria-checked")).toBe("true");
    expect(group()?.getAttribute("aria-label")).toBe("Priority for 12 Smith Street");
  });

  it("puts exactly one star in the tab order, and it is the checked one when a priority is set", async () => {
    await render({ priority: 4 });
    const tabbable = radios().filter((radio) => radio.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.getAttribute("aria-label")).toBe("4 stars");
  });

  it("falls back to the first star as the tab stop when unset", async () => {
    await render({ priority: null });
    const tabbable = radios().filter((radio) => radio.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.getAttribute("aria-label")).toBe("1 star");
  });

  // THE test in this file. Automatic selection (arrow commits) would fire a write per arrow, and
  // Dashboard.tsx's `pendingOrdering` guard silently drops all but the first — landing the card on
  // the wrong value with no error. See the component's header comment.
  it("moves focus on arrow keys WITHOUT committing, then commits once on Space", async () => {
    const props = await render({ priority: null });
    star(1)?.focus();
    expect(focusedName()).toBe("1 star");

    await pressKey("ArrowRight");
    expect(focusedName()).toBe("2 stars");
    await pressKey("ArrowRight");
    expect(focusedName()).toBe("3 stars");
    expect(props.onPriorityChange).not.toHaveBeenCalled();

    await pressKey(" ");
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    expect(props.onPriorityChange).toHaveBeenCalledWith(3);
  });

  it("commits on Enter as well as Space", async () => {
    const props = await render({ priority: null });
    star(1)?.focus();
    await pressKey("ArrowRight");
    await pressKey("Enter");
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    expect(props.onPriorityChange).toHaveBeenCalledWith(2);
  });

  it("traverses backwards, and Home/End jump to the ends", async () => {
    await render({ priority: 3 });
    star(3)?.focus();
    await pressKey("ArrowLeft");
    expect(focusedName()).toBe("2 stars");
    await pressKey("ArrowUp");
    expect(focusedName()).toBe("1 star");
    await pressKey("End");
    expect(focusedName()).toBe("5 stars");
    await pressKey("Home");
    expect(focusedName()).toBe("1 star");
  });

  // Wrapping would turn "one arrow past 5" into priority 1 — the worst wrong value this control
  // can produce.
  it("clamps at both ends rather than wrapping", async () => {
    await render({ priority: 5 });
    star(5)?.focus();
    await pressKey("ArrowRight");
    expect(focusedName()).toBe("5 stars");

    await pressKey("Home");
    expect(focusedName()).toBe("1 star");
    await pressKey("ArrowLeft");
    expect(focusedName()).toBe("1 star");
  });

  it("clears to null when the currently-set star is re-activated by keyboard", async () => {
    const props = await render({ priority: 3 });
    star(3)?.focus();
    await pressKey(" ");
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    expect(props.onPriorityChange).toHaveBeenCalledWith(null);
  });

  it("clears to null when the currently-set star is clicked", async () => {
    const props = await render({ priority: 3 });
    await click(star(3)!);
    expect(props.onPriorityChange).toHaveBeenCalledWith(null);
  });

  it("clears to null on Delete and on Backspace", async () => {
    const deleteProps = await render({ priority: 4 });
    star(4)?.focus();
    await pressKey("Delete");
    expect(deleteProps.onPriorityChange).toHaveBeenCalledWith(null);

    const backspaceProps = await render({ priority: 4 });
    star(4)?.focus();
    await pressKey("Backspace");
    expect(backspaceProps.onPriorityChange).toHaveBeenCalledWith(null);
  });

  it("does not clear an already-unset priority", async () => {
    const props = await render({ priority: null });
    star(1)?.focus();
    await pressKey("Delete");
    expect(props.onPriorityChange).not.toHaveBeenCalled();
  });

  it("sets a priority on click", async () => {
    const props = await render({ priority: null });
    await click(star(4)!);
    expect(props.onPriorityChange).toHaveBeenCalledWith(4);
  });

  it("follows the priority prop after a rollback, proving it holds no shadow value state", async () => {
    const props = await render({ priority: 2 });
    await click(star(5)!);
    // The coordinator rejected the write and restored the old value.
    await rerender({ ...props, priority: 2 });
    expect(star(2)?.getAttribute("aria-checked")).toBe("true");
    expect(star(5)?.getAttribute("aria-checked")).toBe("false");
  });

  describe("while a write is in flight", () => {
    it("marks the group busy and the radios aria-disabled, and ignores commits", async () => {
      const props = await render({ priority: 2, pending: true });
      expect(group()?.getAttribute("aria-busy")).toBe("true");
      expect(radios().every((radio) => radio.getAttribute("aria-disabled") === "true")).toBe(true);

      await click(star(4)!);
      star(4)?.focus();
      await pressKey(" ");
      await pressKey("Delete");
      expect(props.onPriorityChange).not.toHaveBeenCalled();
    });

    it("keeps the radios focusable so focus survives the round trip", async () => {
      await render({ priority: 2, pending: true });
      star(2)?.focus();
      expect(focusedName()).toBe("2 stars");
      // aria-disabled, not `disabled` — a disabled element would drop focus and lose the user's
      // place mid-write.
      expect(radios().some((radio) => radio.hasAttribute("disabled"))).toBe(false);
    });
  });

  describe("non-Admin", () => {
    it("renders a static, non-focusable image with the value in its name — never a radiogroup", async () => {
      await render({ canPrioritize: false, priority: 3 });
      expect(group()).toBeNull();
      expect(radios()).toHaveLength(0);
      const readOnly = host.querySelector('[role="img"]');
      // Anchored: proves the control rendered at all, so the two nulls above mean "not a
      // radiogroup" rather than "nothing rendered".
      expect(readOnly?.getAttribute("aria-label")).toBe("Priority 3 of 5 stars");
      expect(host.querySelector("[tabindex]")).toBeNull();
    });

    it("cannot change a priority by click, Space, or Delete", async () => {
      const props = await render({ canPrioritize: false, priority: 3 });
      const readOnly = host.querySelector('[role="img"]') as HTMLElement;
      await click(readOnly);
      const { act } = await import("react");
      for (const key of [" ", "Enter", "Delete", "Backspace"]) {
        await act(async () => {
          readOnly.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          await Promise.resolve();
        });
      }
      expect(props.onPriorityChange).not.toHaveBeenCalled();
    });

    // ~90% of live Projects are unset, so this is the common case: a row of a control they could
    // never use would be the Board's dominant visual (#76 user story 7).
    it("renders nothing at all on an unset Project", async () => {
      await render({ canPrioritize: false, priority: null });
      expect(host.textContent).toBe("");
      expect(host.querySelector('[role="img"]')).toBeNull();
      expect(group()).toBeNull();
    });
  });

  describe("Admin ghost row", () => {
    it("is present, focusable and traversable on an unset Project", async () => {
      await render({ canPrioritize: true, priority: null });
      expect(group()).not.toBeNull();
      star(1)?.focus();
      await pressKey("ArrowRight");
      expect(focusedName()).toBe("2 stars");
    });
  });
});
