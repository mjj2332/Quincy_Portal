import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewNoteCard } from "./ReviewNoteCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren(); });
async function mount(node: React.ReactNode) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root!.render(node); }); return host; }

describe("ReviewNoteCard (#880)", () => {
  it("is a named region with the author, the anchor and the body, and takes no focus", async () => {
    const host = await mount(<ReviewNoteCard author="Mia Tan" anchor="00:00:12:05" onClose={() => undefined}><p>Lift the shadows here.</p></ReviewNoteCard>);
    const card = host.querySelector<HTMLElement>('[role="region"]')!;
    expect(card.getAttribute("aria-label")).toBe("Note by Mia Tan");
    expect(card.textContent).toContain("Mia Tan");
    expect(card.textContent).toContain("00:00:12:05");
    expect(card.textContent).toContain("Lift the shadows here.");
    expect(card.contains(document.activeElement)).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes from its one button; F3 has no Show in notes (Full screen has no notes list, D13; owner decision, #880 review 11)", async () => {
    const onClose = vi.fn();
    const host = await mount(<ReviewNoteCard author="Mia Tan" anchor="00:00:12:05" onClose={onClose}><p>Body</p></ReviewNoteCard>);
    expect([...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Close note"]);
    await act(async () => { host.querySelector<HTMLElement>('[aria-label="Close note"]')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
