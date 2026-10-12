import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../reui/dialog";
import { Sheet, SheetContent, SheetTitle } from "../reui/sheet";
import { SheetCloseButton } from "./SheetCloseButton";

/**
 * #796 — Base UI 1.7.0's modal focus guards redirected focus through a requestAnimationFrame, so a
 * Tab that landed before the next frame walked out of the dialog. `patches/@base-ui+react+1.7.0.patch`
 * makes the redirect synchronous. These assertions run with NO frame or timer flush: on the unpatched
 * package the guard keeps focus and the assertions fail.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
  document.body.replaceChildren();
});

async function renderNestedDialog() {
  await act(async () => {
    root!.render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Project</SheetTitle>
          <button type="button">Sheet control</button>
          <Dialog open onOpenChange={() => {}}>
            <DialogContent showCloseButton={false} data-testid="nested-dialog">
              <DialogTitle>Nested dialog</DialogTitle>
              <input aria-label="First field" />
              <button type="button">Middle</button>
              <SheetCloseButton label="Close dialog" data-testid="dialog-last" />
            </DialogContent>
          </Dialog>
        </SheetContent>
      </Sheet>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function popupAndGuards() {
  const popup = document.querySelector<HTMLElement>('[data-testid="nested-dialog"]');
  expect(popup).not.toBeNull();
  const guards = Array.from(document.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]"));
  const before = guards.filter((g) => popup!.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_PRECEDING && !popup!.contains(g));
  const after = guards.filter((g) => popup!.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING && !popup!.contains(g));
  const inside = guards.filter((g) => popup!.contains(g));
  return { popup: popup!, before, after, inside };
}

describe("modal focus guards redirect synchronously (#796)", () => {
  it("focusing the END guard lands on the first tabbable, with no frame flush", async () => {
    await renderNestedDialog();
    const { popup, before, after, inside } = popupAndGuards();
    const end = inside.at(-1) ?? after[0] ?? before.at(-1);
    expect(end, "an end focus guard exists").toBeDefined();
    const first = popup.querySelector<HTMLElement>('input[aria-label="First field"]')!;
    // Start somewhere definite so a no-op redirect cannot pass by accident.
    end!.focus();
    expect(document.activeElement).toBe(first);
  });

  it("focusing the START guard lands on the last tabbable, with no frame flush", async () => {
    await renderNestedDialog();
    const { inside, before } = popupAndGuards();
    const start = inside[0] ?? before.at(-1);
    expect(start, "a start focus guard exists").toBeDefined();
    const last = document.querySelector<HTMLElement>('[data-testid="dialog-last"]')!;
    start!.focus();
    expect(document.activeElement).toBe(last);
  });
});
