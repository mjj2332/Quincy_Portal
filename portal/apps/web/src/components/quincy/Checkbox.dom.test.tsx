import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox";

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

// Four of the assertions below are the real protection — each would fail against `reui/checkbox`
// (Base UI's `<span role="checkbox">` root, with a hidden `<input>` tucked inside), which is what
// makes them tests rather than a restatement of the component's own source: the root-is-a-real-
// `input[type=checkbox]` assertion, the `.checked`-tracking one, the ref-forwards-to-the-input
// one, and the `event.target.checked` shape one. The `data-slot="checkbox"` and
// `aria-roledescription` assertions below do NOT carry that protection — ReUI's hidden inner
// input also lacks a role-description, and nothing stops `reui/checkbox` from carrying its own
// `data-slot="checkbox"` on its span root. They stay here as documentation of the current output,
// not as regression guards against a vendor swap.
describe("quincy Checkbox", () => {
  it("renders a real input[type=checkbox] at the root, not a span", async () => {
    await render(<Checkbox aria-label="Done" checked={false} onChange={() => undefined} />);
    const node = host.firstElementChild!;
    expect(node.tagName).toBe("INPUT");
    expect((node as HTMLInputElement).type).toBe("checkbox");
  });

  it("tracks the checked prop on the real DOM property", async () => {
    const ref = createRef<HTMLInputElement>();
    await render(<Checkbox ref={ref} aria-label="Done" checked={false} onChange={() => undefined} />);
    expect(ref.current!.checked).toBe(false);
    await render(<Checkbox ref={ref} aria-label="Done" checked onChange={() => undefined} />);
    expect(ref.current!.checked).toBe(true);
  });

  it("passes event.target.checked to onChange, the same shape SubtaskChecklist.tsx:246 reads", async () => {
    // Read `.checked` synchronously inside the handler, not off `mock.calls` afterwards: `target`
    // is a live reference to the real DOM node, and because this checkbox stays controlled at
    // `checked={false}` (nothing here calls setState), React restores the DOM property back to
    // `false` once the batch flushes — a read after the fact would see that restored value, not
    // what the handler actually received.
    let observed: boolean | null = null;
    const ref = createRef<HTMLInputElement>();
    await render(
      <Checkbox ref={ref} aria-label="Done" checked={false} onChange={(event) => { observed = event.target.checked; }} />,
    );
    await act(async () => { ref.current!.click(); });
    expect(observed).toBe(true);
  });

  it("sets the real disabled property, not aria-disabled", async () => {
    const ref = createRef<HTMLInputElement>();
    await render(<Checkbox ref={ref} aria-label="Done" checked={false} onChange={() => undefined} disabled />);
    expect(ref.current!.disabled).toBe(true);
    expect(ref.current!.getAttribute("aria-disabled")).toBeNull();
  });

  it('carries data-slot="checkbox"', async () => {
    await render(<Checkbox aria-label="Done" checked={false} onChange={() => undefined} />);
    expect(host.querySelector('[data-slot="checkbox"]')).not.toBeNull();
  });

  it("carries no aria-roledescription — SubtaskChecklist.dom.test.tsx:232 depends on this", async () => {
    await render(<Checkbox aria-label="Done" checked={false} onChange={() => undefined} />);
    expect(host.querySelector("input")!.getAttribute("aria-roledescription")).toBeNull();
  });
});
