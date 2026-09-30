import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

const parts = (host: HTMLElement) => ({
  box: host.querySelector<HTMLElement>('[data-slot="empty-state"]')!,
  title: host.querySelector<HTMLElement>("strong")!,
});

describe("EmptyState size", () => {
  it("compact drops the h3 title scale, the centred padding and the title margin", async () => {
    const host = await mount(<EmptyState size="compact" title="No comments yet." />);
    const { box, title } = parts(host);
    expect(title.className).not.toContain("--type-h3");
    expect(title.className).toContain("text-foreground-secondary");
    expect(title.className).not.toMatch(/\bmb-/);
    expect(box.className).toContain("text-left");
    expect(box.className).not.toContain("text-center");
    expect(box.className).toContain("px-0");
    expect(box.className).not.toContain("py-[var(--space-8)]");
  });

  it("default output is byte-identical to before the size prop (empty tone)", async () => {
    const host = await mount(<EmptyState title="Nothing" />);
    const { box, title } = parts(host);
    expect(box.className).toBe("px-[var(--space-6)] py-[var(--space-8)] text-center");
    expect(title.className).toBe("block mb-[var(--space-3)] font-[var(--weight-regular)] tracking-[var(--tracking-tight)] [font:var(--type-h3)] text-foreground-secondary");
  });

  it("default output is byte-identical to before the size prop (error tone)", async () => {
    const host = await mount(<EmptyState tone="error" title="Broke" />);
    const { box, title } = parts(host);
    expect(box.className).toBe("px-[var(--space-6)] py-[var(--space-8)] text-left ps-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive");
    expect(title.className).toBe("block mb-[var(--space-3)] font-[var(--weight-regular)] tracking-[var(--tracking-tight)] [font:var(--type-h3)] text-destructive");
  });
});
