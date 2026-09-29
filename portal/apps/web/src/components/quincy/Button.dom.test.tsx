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
    // Each cva variant is fingerprinted by the classes only it adds: its own output minus what
    // every variant shares. A fragment would not do — `ghost` is a strict subset of `outline`
    // (#239 removed its one distinctive class, a dead `dark:` variant) — so the mapped variant is
    // the one whose whole fingerprint is present, and no larger fingerprint is.
    const CVA_VARIANTS = ["default", "outline", "destructive", "ghost"] as const;
    const tokens = (classes: string) => new Set(classes.split(/\s+/).filter(Boolean));
    const shared = CVA_VARIANTS.map((v) => tokens(buttonVariants({ variant: v }))).reduce((a, b) => new Set([...a].filter((t) => b.has(t))));
    const fingerprint = Object.fromEntries(
      CVA_VARIANTS.map((v) => [v, [...tokens(buttonVariants({ variant: v }))].filter((t) => !shared.has(t))]),
    ) as Record<(typeof CVA_VARIANTS)[number], string[]>;
    for (const v of CVA_VARIANTS) expect(fingerprint[v].length, v).toBeGreaterThan(0);

    const MAPPING: [ButtonVariant, (typeof CVA_VARIANTS)[number]][] = [
      ["primary", "default"],
      ["secondary", "outline"],
      ["danger", "destructive"],
      ["text", "ghost"],
    ];
    for (const [variant, cvaVariant] of MAPPING) {
      const classes = tokens(buttonClasses(variant));
      const present = CVA_VARIANTS.filter((v) => fingerprint[v].every((t) => classes.has(t)));
      const widest = present.reduce((a, b) => (fingerprint[b].length > fingerprint[a].length ? b : a));
      expect(widest, variant).toBe(cvaVariant);
    }
  });

  it("carries no-underline, load-bearing for the <a> case via InternalLink", () => {
    expect(buttonClasses()).toContain("no-underline");
  });
});

// The `insetFocus` suite that stood here is DELETED, not weakened. It asserted that
// `buttonClasses` could zero nova's focus ring per variant; `reui/button.tsx` divergence 5 removed
// that ring from the cva base, so the option had nothing left to neutralise and went with it. An
// assertion about a mechanism that no longer exists cannot fail, and #56 deletes guards that have
// become unfalsifiable rather than editing them to keep passing.
//
// What replaces it guards the fact the deletion depends on: the ring must stay absent.
// `tokens/base.css:25` paints a global `:focus-visible` outline on every focusable element, so
// nova's ring is a SECOND indicator, in a different CSS property group (`box-shadow`/`border-color`
// vs `outline`) that tailwind-merge cannot collapse — every control wearing `buttonVariants` gets a
// doubled ring. Re-fetching `button` from the ReUI registry silently reintroduces it.
describe("buttonClasses focus ring", () => {
  const VARIANTS: ButtonVariant[] = ["primary", "secondary", "danger", "text"];

  it("emits no ring of its own on any variant — the global :focus-visible outline is the indicator", () => {
    for (const variant of VARIANTS) {
      const classes = buttonClasses(variant);
      expect(classes, variant).not.toContain("focus-visible:ring-3");
      expect(classes, variant).not.toContain("focus-visible:ring-ring");
      expect(classes, variant).not.toContain("focus-visible:border-ring");
    }
  });

  it("keeps the ring out of the vendored cva base and the destructive variant", () => {
    for (const variant of ["default", "outline", "secondary", "ghost", "destructive", "link"] as const) {
      const classes = buttonVariants({ variant });
      expect(classes, variant).not.toContain("focus-visible:ring");
      expect(classes, variant).not.toContain("focus-visible:border-ring");
    }
  });

  // `aria-invalid`'s ring is a different affordance and is deliberately retained: it paints on an
  // invalid control whether or not that control is focused. Asserted so a future sweep for
  // "remove the rings" does not take this one too.
  it("retains the aria-invalid ring, which is an error affordance and not a focus indicator", () => {
    expect(buttonVariants({ variant: "default" })).toContain("aria-invalid:ring-3");
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
