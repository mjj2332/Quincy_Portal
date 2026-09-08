import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Input } from "@/components/reui/input";

// Replicates the prop matrix at `quincy/QuincyField.dom.test.tsx:38-69` against
// `@/components/reui/input` instead of `@/components/ui/input`, pre-proving slice C's one-token
// repoint of that file: every prop that survives here today must keep surviving once
// `QuincyField.tsx` swaps its `Input` import. Do not edit `QuincyField.dom.test.tsx`.

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

describe("reui/input prop passthrough", () => {
  it("preserves representative native Input props through Base UI's InputPrimitive", async () => {
    const ref = createRef<HTMLInputElement>();
    await render(
      <Input
        ref={ref}
        type="email"
        value="alex@example.test"
        onChange={() => undefined}
        readOnly
        disabled
        required
        inputMode="email"
        autoComplete="email"
        aria-label="Agent email"
        aria-describedby="email-help"
        data-test-input="preserved"
      />,
    );

    const input = ref.current!;
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input.type).toBe("email");
    expect(input.value).toBe("alex@example.test");
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.required).toBe(true);
    expect(input.inputMode).toBe("email");
    expect(input.autocomplete).toBe("email");
    expect(input.getAttribute("aria-label")).toBe("Agent email");
    expect(input.getAttribute("aria-describedby")).toBe("email-help");
    expect(input.getAttribute("data-test-input")).toBe("preserved");
  });
});
