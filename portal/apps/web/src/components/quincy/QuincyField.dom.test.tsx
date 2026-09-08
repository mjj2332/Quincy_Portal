import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Input } from "@/components/reui/input";
import { QuincyField } from "./QuincyField";

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

describe("QuincyField primitives", () => {
  it("passes a React 19 ref through to the native input and focuses it", async () => {
    const ref = createRef<HTMLInputElement>();
    await render(<QuincyField ref={ref} id="test-field" label="Test field" value="value" onChange={() => undefined} />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    ref.current!.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it("preserves representative native Input props without adding them to the production fields", async () => {
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
