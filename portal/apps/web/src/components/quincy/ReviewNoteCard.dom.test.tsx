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
    const host = await mount(<ReviewNoteCard author="Mia Tan" anchor="00:00:12:05" onClose={() => undefined} onShowInNotes={() => undefined}><p>Lift the shadows here.</p></ReviewNoteCard>);
    const card = host.querySelector<HTMLElement>('[role="region"]')!;
    expect(card.getAttribute("aria-label")).toBe("Note by Mia Tan");
    expect(card.textContent).toContain("Mia Tan");
    expect(card.textContent).toContain("00:00:12:05");
    expect(card.textContent).toContain("Lift the shadows here.");
    expect(card.contains(document.activeElement)).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes, and shows the note in the notes, from its two buttons", async () => {
    const onClose = vi.fn(); const onShow = vi.fn();
    const host = await mount(<ReviewNoteCard author="Mia Tan" anchor="00:00:12:05" onClose={onClose} onShowInNotes={onShow}><p>Body</p></ReviewNoteCard>);
    await act(async () => { host.querySelector<HTMLElement>('[aria-label="Close note"]')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    const show = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show in notes")!;
    await act(async () => { show.click(); });
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("has no Show in notes where there are no notes to go to", async () => {
    const host = await mount(<ReviewNoteCard author="Mia Tan" anchor="00:00:12:05" onClose={() => undefined}><p>Body</p></ReviewNoteCard>);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Show in notes")).toBe(false);
  });
});
