import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/reui/button";
import { Button, buttonClasses, type ButtonVariant } from "./Button";

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

describe("buttonClasses", () => {
  it('resolves "text" to a 32px box, not the cva default\'s 38px, while keeping the shared touch-target modifier', () => {
    // Pins twMerge's variant-key semantics — the fact `Admin.tsx:91-96` asserts in prose and
    // nothing checks. TEXT_BUTTON's `min-h-[32px]` must win the merge over the cva base's
    // `min-h-[38px]` (same utility key), while `max-[721px]:min-h-[44px]` (a different, prefixed
    // key) survives untouched.
    const classes = buttonClasses("text");
    expect(classes).toContain("min-h-[32px]");
    expect(classes).not.toContain("min-h-[38px]");
    expect(classes).toContain("max-[721px]:min-h-[44px]");
  });

  it("lets a call-site className beat the variant on a conflicting utility", () => {
    const classes = buttonClasses("primary", { className: "px-0" });
    expect(classes).toContain("px-0");
    expect(classes).not.toMatch(/\bpx-2\.5\b/);
  });

  it("maps each legacy variant name to the cva variant it must resolve to, not a transposition", () => {
    // Pins the mapping's semantics, not just its cardinality: swapping two keys in VARIANT_MAP
    // (e.g. primary<->danger) keeps a "four distinct strings" assertion green while destructive
    // confirmations render as primary buttons. Each fragment below is asserted to actually come
    // from `buttonVariants`' own output for that cva variant, so this test can't silently drift
    // from `reui/button.tsx` either.
    const DISTINCTIVE: Record<"default" | "outline" | "destructive" | "ghost", string> = {
      default: "bg-primary",
      outline: "bg-background",
      destructive: "bg-destructive/10",
      ghost: "dark:hover:bg-muted/50",
    };
    for (const [cvaVariant, fragment] of Object.entries(DISTINCTIVE) as [keyof typeof DISTINCTIVE, string][]) {
      expect(buttonVariants({ variant: cvaVariant })).toContain(fragment);
    }

    const MAPPING: [ButtonVariant, keyof typeof DISTINCTIVE][] = [
      ["primary", "default"],
      ["secondary", "outline"],
      ["danger", "destructive"],
      ["text", "ghost"],
    ];
    for (const [variant, cvaVariant] of MAPPING) {
      const classes = buttonClasses(variant);
      expect(classes).toContain(DISTINCTIVE[cvaVariant]);
      for (const [otherCvaVariant, otherFragment] of Object.entries(DISTINCTIVE)) {
        if (otherCvaVariant !== cvaVariant) expect(classes).not.toContain(otherFragment);
      }
    }
  });

  it("carries no-underline, load-bearing for the <a> case via InternalLink", () => {
    expect(buttonClasses()).toContain("no-underline");
  });
});

describe("buttonClasses insetFocus", () => {
  // Inlined literally rather than imported from `AnchoredPopover.tsx` — this test must not create
  // an import edge from `quincy/` into a consumer.
  const RING_IN =
    "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
    "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]";

  const VARIANTS: ButtonVariant[] = ["primary", "secondary", "danger", "text"];

  it("RING_IN alone leaves ReUI's outward ring in the merged string — the defect this fix addresses", () => {
    for (const variant of VARIANTS) {
      expect(buttonClasses(variant, { className: RING_IN })).toContain("focus-visible:ring-3");
    }
  });

  it("insetFocus drops ReUI's ring on every variant while RING_IN's inward outline survives intact", () => {
    for (const variant of VARIANTS) {
      const classes = buttonClasses(variant, { className: RING_IN, insetFocus: true });
      expect(classes, variant).toContain("focus-visible:ring-0");
      expect(classes, variant).not.toContain("focus-visible:ring-3");
      expect(classes, variant).not.toContain("focus-visible:border-ring");
      expect(classes, variant).toContain("focus-visible:!outline-[length:var(--border-width-bold)]");
      expect(classes, variant).toContain("focus-visible:!outline-[var(--focus-ring)]");
      expect(classes, variant).toContain("focus-visible:!outline-offset-[-2px]");
    }
  });

  // The border half of the fix is variant-sensitive, and this is the assertion that would have
  // caught the slice C defect Sol found: `secondary` maps to ReUI's `outline` variant, which RESTS
  // on `border-border` (`reui/button.tsx:37`). Blanking it to transparent on focus deletes a real
  // border instead of restoring resting paint. Every other variant does rest on the cva base's
  // `border-transparent`, so transparent is right for them.
  it("keeps secondary's resting border while focused, and only blanks the border on variants that rest transparent", () => {
    expect(buttonClasses("secondary", { className: RING_IN, insetFocus: true }))
      .toContain("focus-visible:border-border");
    expect(buttonClasses("secondary", { className: RING_IN, insetFocus: true }))
      .not.toContain("focus-visible:border-transparent");

    for (const variant of ["primary", "danger", "text"] as ButtonVariant[]) {
      const classes = buttonClasses(variant, { className: RING_IN, insetFocus: true });
      expect(classes, variant).toContain("focus-visible:border-transparent");
      expect(classes, variant).not.toContain("focus-visible:border-border");
    }
  });

  it("adds nothing when insetFocus is not requested", () => {
    for (const variant of VARIANTS) {
      const classes = buttonClasses(variant);
      expect(classes, variant).not.toContain("focus-visible:ring-0");
      expect(classes, variant).toContain("focus-visible:ring-3");
    }
  });
});

describe("Button", () => {
  it("renders a real <button> and forwards type, disabled and a ref", async () => {
    const ref = createRef<HTMLButtonElement>();
    await render(<Button ref={ref} type="submit" disabled>Save</Button>);
    const button = host.querySelector("button")!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.disabled).toBe(true);
    expect(ref.current).toBe(button);
  });

  it("defaults to the primary variant", async () => {
    await render(<Button>Save</Button>);
    const button = host.querySelector("button")!;
    expect(button.className).toBe(buttonClasses("primary"));
  });
});
