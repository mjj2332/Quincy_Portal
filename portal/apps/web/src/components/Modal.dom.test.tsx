import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "./Modal";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });

async function renderModal() {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<Modal open title="Payload" testId="m" onClose={() => {}}><pre>{"x".repeat(900)}</pre></Modal>); await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  return { scrim: document.querySelector<HTMLElement>('[data-testid="modal-scrim"]')!, panel: document.querySelector<HTMLElement>('[data-testid="m"]')! };
}

describe("Modal sizing at phone width (#670)", () => {
  it("gives the scrim a minmax(0,1fr) column so wide content cannot widen the implicit auto track", async () => {
    const { scrim } = await renderModal();
    expect(scrim.className).toContain("grid-cols-[minmax(0,1fr)]");
  });
  it("lets the panel shrink (min-w-0) and fill, not escape, the track on a phone", async () => {
    const { panel } = await renderModal();
    expect(panel.className).toContain("min-w-0");
    expect(panel.className).toContain("max-[721px]:max-w-full");
    expect(panel.className).not.toContain("max-[721px]:max-w-none");
  });
  it("keeps the desktop width caps", async () => {
    const { panel } = await renderModal();
    expect(panel.className).toContain("max-w-[460px]");
  });
});
