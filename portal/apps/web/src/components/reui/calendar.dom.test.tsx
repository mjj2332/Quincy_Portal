import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Calendar } from "./calendar";

/**
 * #581 — day-state class contract. happy-dom has no layout, no hover and no `:focus-visible`
 * heuristics, so these tests pin the class strings / attributes that produce the behaviour in a
 * real browser (verified there by the browser pass), not the rendered pixels.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); await Promise.resolve(); });
}

const month = new Date(2026, 9, 1);

describe("Calendar day states (#581)", () => {
  it("selected single day keeps the primary-foreground number on hover, with the default variant's hover fill", async () => {
    await render(<Calendar mode="single" month={month} selected={new Date(2026, 9, 14)} />);
    const btn = host.querySelector<HTMLButtonElement>('button[data-selected-single="true"]')!;
    expect(btn).toBeTruthy();
    const cls = btn.className;
    expect(cls).toContain("data-[selected-single=true]:hover:!text-primary-foreground");
    expect(cls).toContain("data-[selected-single=true]:hover:bg-primary/80");
  });

  it("range start and end keep the primary-foreground number on hover", async () => {
    await render(<Calendar mode="range" month={month} selected={{ from: new Date(2026, 9, 10), to: new Date(2026, 9, 14) }} />);
    const start = host.querySelector<HTMLButtonElement>('button[data-range-start="true"]')!;
    const end = host.querySelector<HTMLButtonElement>('button[data-range-end="true"]')!;
    for (const [btn, key] of [[start, "range-start"], [end, "range-end"]] as const) {
      expect(btn.className).toContain(`data-[${key}=true]:hover:!text-primary-foreground`);
      expect(btn.className).toContain(`data-[${key}=true]:hover:bg-primary/80`);
    }
  });

  it("paints no data-focused ring; focus is the global :focus-visible outline", async () => {
    await render(<Calendar mode="single" month={month} selected={new Date(2026, 9, 14)} />);
    const all = Array.from(host.querySelectorAll("button, td")).map((e) => e.className).join(" ");
    expect(all).not.toMatch(/data-\[focused=true\]/);
    expect(all).not.toMatch(/ring-\[3px\]|ring-ring\/50/);
    // Keyboard focus lands on the day button itself (react-day-picker focus management), so the
    // global unlayered `:focus-visible` outline in tokens/base.css has an element to paint.
    const btn = host.querySelector<HTMLButtonElement>('button[data-selected-single="true"]')!;
    act(() => btn.focus());
    expect(document.activeElement).toBe(btn);
  });

  it("row-edge corner overrides skip a selected single day, so its corners stay equal", async () => {
    await render(<Calendar mode="single" month={month} selected={new Date(2026, 9, 14)} />);
    const btn = host.querySelector<HTMLButtonElement>('button[data-selected-single="true"]')!;
    expect(btn.className).toContain("data-[selected-single=true]:rounded-(--cell-radius)");
    const td = btn.closest("td")!;
    expect(td.className).toContain(":not([data-selected-single=true])]:rounded-r-(--cell-radius)");
    expect(td.className).toContain("[&:first-child[data-selected=true]_button:not([data-selected-single=true])]:rounded-l-(--cell-radius)");
    expect(td.className).not.toContain("_button]:rounded-l");
  });

  it("a selected today's cell goes transparent instead of showing a square muted cell", async () => {
    const today = new Date();
    await render(<Calendar mode="single" month={new Date(today.getFullYear(), today.getMonth(), 1)} selected={today} />);
    const btn = host.querySelector<HTMLButtonElement>('button[data-selected-single="true"]')!;
    const td = btn.closest("td")!;
    expect(td.className).toContain("data-[selected=true]:bg-transparent");
    expect(td.className).not.toContain("data-[selected=true]:rounded-none");
  });
});
