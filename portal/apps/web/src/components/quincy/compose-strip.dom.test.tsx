import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRestPlaceholder } from "./compose-strip";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The pill's rest placeholder (#879 PR 3a): measured on the field the host holds (the rich field's root carries `data-placeholder`), with the field's computed font, in the room
 * between its inline paddings; refitted when the host resizes and when the field arrives late (the editor's chunk). Compose mode keeps the full text.
 */
const observers: Array<() => void> = [];
let root: Root | null = null; let host: HTMLElement;
const measured: string[] = [];
beforeEach(() => {
  observers.length = 0; measured.length = 0;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observers.push(cb); } observe() {} unobserve() {} disconnect() {} });
  // 8px a character, under whatever font was set.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({ font: "", measureText: (text: string) => { measured.push(text); return { width: text.length * 8 }; } })) as never);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function Field({ full, atRest, field = true }: { full: string; atRest: boolean; field?: boolean }) {
  const rest = useRestPlaceholder(full, atRest);
  return <div ref={rest.ref} data-testid="host">{field && <div data-testid="field" data-placeholder={rest.text} style={{ paddingLeft: "12px", paddingRight: "12px" }} />}</div>;
}
const field = () => document.querySelector<HTMLElement>('[data-testid="field"]')!;
const widen = (width: number) => { Object.defineProperty(field(), "clientWidth", { configurable: true, get: () => width }); };
const render = (props: { full: string; atRest: boolean; field?: boolean }) => act(async () => { root!.render(<Field {...props} />); });
const resize = () => act(async () => { observers.forEach((cb) => { cb(); }); });

describe("useRestPlaceholder (#879 PR 3a)", () => {
  it("at rest, a placeholder too wide for the field's text room ends at a word with one ellipsis", async () => {
    await render({ full: "Add a note with this drawing…", atRest: true });
    // 160px less 24px of padding = 136px = 17 characters: "Add a note with…" (16) fits, "Add a note with this…" (21) does not.
    widen(160); await resize();
    expect(field().getAttribute("data-placeholder")).toBe("Add a note with…");
    widen(400); await resize();
    expect(field().getAttribute("data-placeholder")).toBe("Add a note with this drawing…");
  });

  it("in compose mode the full text stays, and measuring stops", async () => {
    await render({ full: "Add a note with this drawing…", atRest: true });
    widen(160); await resize();
    await render({ full: "Add a note with this drawing…", atRest: false });
    expect(field().getAttribute("data-placeholder")).toBe("Add a note with this drawing…");
  });

  it("a field with no layout (no width yet) keeps the full text and is never measured", async () => {
    await render({ full: "Add a note with this drawing…", atRest: true });
    expect(field().getAttribute("data-placeholder")).toBe("Add a note with this drawing…");
    expect(measured).toEqual([]);
  });

  it("a field that arrives after the host (the editor's chunk) is fitted when it lands", async () => {
    await render({ full: "Add a note with this drawing…", atRest: true, field: false });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return (this as HTMLElement).dataset.testid === "field" ? 160 : 0; } });
    try {
      await render({ full: "Add a note with this drawing…", atRest: true, field: true });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(field().getAttribute("data-placeholder")).toBe("Add a note with…");
    } finally { delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth; }
  });
});
