import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusPill, type StatusTone } from "./StatusPill";
import { META_TRIGGER } from "./icon-button";

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

describe("StatusPill", () => {
  it('carries data-slot="status-pill" even nested inside a META_TRIGGER button', async () => {
    // `reui/badge.tsx` calls `mergeProps(defaultProps, props)`, so a caller-supplied prop (here,
    // `StatusPill`'s own `data-slot="status-pill"` passed down as `...props` to `Badge`) wins over
    // Badge's own default `data-slot="badge"`. Nothing checks that argument order today: if a
    // vendor re-install ever flipped it to `mergeProps(props, defaultProps)`, `Badge`'s own
    // `data-slot="badge"` would win instead, `META_TRIGGER`'s
    // `[&>[data-slot=status-pill]]:min-w-0` truncation rule would silently stop matching, and a
    // long schedule string would overflow a 390px row with nothing failing to say so.
    await render(
      <button className={META_TRIGGER}>
        <StatusPill>Awaiting RAW · 12 photos</StatusPill>
      </button>,
    );
    const button = host.querySelector("button")!;
    expect(button.querySelector('[data-slot="status-pill"]')).not.toBeNull();
    expect(button.querySelector('[data-slot="status-pill"]')).toBe(button.firstElementChild);
  });

  it("renders each tone with its own signal token, not merely five distinct strings", async () => {
    // Pins the mapping's semantics: exchanging `positive` and `critical` in `PILL_TONE` kept a
    // "five distinct strings" assertion green while shipping a green critical pill and a red
    // positive one. Each tone is asserted against its actual signal token, and against the
    // absence of every other tone's token.
    const TOKEN: Record<StatusTone, string> = {
      positive: "text-signal-positive",
      caution: "text-signal-caution-text",
      critical: "text-signal-critical",
      info: "text-signal-info",
      neutral: "text-foreground-secondary",
    };
    for (const [tone, token] of Object.entries(TOKEN) as [StatusTone, string][]) {
      await render(<StatusPill tone={tone}>Label</StatusPill>);
      const classes = host.querySelector('[data-slot="status-pill"]')!.className;
      expect(classes).toContain(token);
      for (const [otherTone, otherToken] of Object.entries(TOKEN)) {
        if (otherTone !== tone) expect(classes).not.toContain(otherToken);
      }
    }
  });
});
