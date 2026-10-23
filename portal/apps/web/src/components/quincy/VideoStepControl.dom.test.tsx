import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoStepControl, useVideoStepKeys, type StepVia, type VideoStepControlProps } from "./VideoStepControl";

/**
 * #935: the one previous / next control ("‹ n of N ›" and the `[` / `]` keys) the guest viewer, the staff viewer and the delivery film player share.
 * The guest's own behaviour stays pinned by `guest/GuestApp.dom.test.tsx`, `GuestSocial` and `GuestNotesWrite`; this file covers the control's own contract.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement;
const extras: HTMLElement[] = [];

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}
async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}
const button = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name);
const keyFrom = async (target: EventTarget, key: string, init: KeyboardEventInit & { keyCode?: number } = {}) => {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    target.dispatchEvent(event);
  });
};
const keyDown = (key: string, init?: KeyboardEventInit & { keyCode?: number }) => keyFrom(document.body, key, init);
/** A node beside the control (a portalled popup or a field elsewhere on the page). */
const addToBody = (html: string) => {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  extras.push(wrap);
  return wrap.firstElementChild as HTMLElement;
};

function control(props: Partial<VideoStepControlProps> & { onStep: VideoStepControlProps["onStep"] }) {
  return <VideoStepControl position={1} total={3} canPrev canNext noun="video" {...props} />;
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
  for (const node of extras.splice(0)) node.remove();
});

describe("VideoStepControl: buttons and position", () => {
  it("names the buttons by noun, shows 'n of N' and steps on click, saying it came from a button", async () => {
    const onStep = vi.fn<(delta: -1 | 1, via: StepVia) => void>();
    await render(control({ onStep, noun: "film", position: 1, total: 4, positionTestId: "film-position" }));
    expect(document.querySelector('[data-testid="film-position"]')?.textContent).toBe("2 of 4");
    await act(async () => { button("Next film")!.click(); });
    await act(async () => { button("Previous film")!.click(); });
    expect(onStep.mock.calls).toEqual([[1, "button"], [-1, "button"]]);
  });

  it("disables each end's button and never steps past it", async () => {
    const onStep = vi.fn();
    await render(control({ onStep, position: 0, canPrev: false, canNext: true }));
    expect(button("Previous video")!.disabled).toBe(true);
    expect(button("Next video")!.disabled).toBe(false);
    await keyDown("[");
    expect(onStep).not.toHaveBeenCalled();
    await render(control({ onStep, position: 2, canPrev: true, canNext: false }));
    expect(button("Next video")!.disabled).toBe(true);
    await keyDown("]");
    expect(onStep).not.toHaveBeenCalled();
  });

  it("shows no position for a film outside the list, says so to a screen reader, and can disable both buttons", async () => {
    await render(control({ onStep: vi.fn(), position: null, total: 5, canPrev: false, canNext: false }));
    expect(document.querySelector('[data-testid="video-step-position"]')).toBeNull();
    expect(host.textContent).not.toMatch(/of 5/);
    expect(host.textContent).toBe("Not in the current list");
    expect(button("Previous video")!.disabled).toBe(true);
    expect(button("Next video")!.disabled).toBe(true);
  });

  it("draws icons only when compact, with 44px targets, and leaves the position to its host", async () => {
    await render(control({ onStep: vi.fn(), compact: true }));
    expect(host.textContent).not.toMatch(/of 3/);
    for (const name of ["Previous video", "Next video"]) {
      expect(button(name)!.className, name).toContain("min-h-11");
      expect(button(name)!.className, name).toContain("min-w-11");
    }
  });

  it("names each button's key for assistive tech and in its tooltip", async () => {
    await render(control({ onStep: vi.fn() }));
    expect(button("Previous video")!.getAttribute("aria-keyshortcuts")).toBe("[");
    expect(button("Next video")!.getAttribute("aria-keyshortcuts")).toBe("]");
    await act(async () => { button("Next video")!.focus(); });
    await waitFor(() => {
      // The tooltip is the one place a `<kbd>` is drawn; its popup is the kbd's parent.
      const kbd = document.querySelector("kbd");
      expect(kbd?.textContent).toBe("]");
      expect(kbd?.parentElement?.textContent).toContain("Next video");
    });
  });
});

describe("VideoStepControl: the [ and ] keys", () => {
  it("steps with ] and [ from the page, saying it came from a key", async () => {
    const onStep = vi.fn();
    await render(control({ onStep }));
    await keyDown("]");
    await keyDown("[");
    expect(onStep.mock.calls).toEqual([[1, "key"], [-1, "key"]]);
  });

  it("still steps while a step button's tooltip is open", async () => {
    const onStep = vi.fn();
    await render(control({ onStep }));
    await act(async () => { button("Next video")!.focus(); });
    await waitFor(() => { expect(document.querySelector("kbd")).not.toBeNull(); });
    await keyFrom(button("Next video")!, "]");
    expect(onStep).toHaveBeenCalledWith(1, "key");
  });

  it("leaves the keys to a text field, a select, a combobox and a list", async () => {
    const onStep = vi.fn();
    await render(control({ onStep }));
    for (const html of ["<input />", "<textarea></textarea>", "<select><option>a</option></select>", '<div contenteditable="true"></div>', '<div role="combobox" tabindex="0"></div>', '<div role="listbox" tabindex="0"></div>']) {
      await keyFrom(addToBody(html), "]");
    }
    expect(onStep).not.toHaveBeenCalled();
  });

  it("ignores a key with Ctrl, Cmd or Alt held, while composing text, or already handled", async () => {
    const onStep = vi.fn();
    await render(control({ onStep }));
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) await keyDown("]", init);
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true });
      event.preventDefault();
      document.body.dispatchEvent(event);
    });
    expect(onStep).not.toHaveBeenCalled();
  });

  it("leaves the keys to a dialog, alert dialog or menu that is not its own", async () => {
    const onStep = vi.fn();
    await render(control({ onStep }));
    for (const role of ["dialog", "alertdialog", "menu"]) {
      const layer = addToBody(`<div role="${role}"><button type="button">Inside</button></div>`);
      await keyFrom(layer.querySelector("button")!, "]");
    }
    expect(onStep).not.toHaveBeenCalled();
  });

  it("does nothing while a confirm or a modal dialog is open, even with focus left on the page", async () => {
    const onStep = vi.fn();
    await render(control({ onStep }));
    const confirm = addToBody('<div role="alertdialog" data-open=""></div>');
    await keyDown("]");
    confirm.remove();
    const modal = addToBody('<div role="dialog" data-slot="dialog-content" data-open=""></div>');
    await keyDown("]");
    modal.remove();
    expect(onStep).not.toHaveBeenCalled();
    await keyDown("]");
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("owns the keys inside the dialog that hosts it, but not inside a menu, a field or a modal above that dialog", async () => {
    const onStep = vi.fn();
    await render(<div role="dialog" data-slot="dialog-content" data-open="">
      <button type="button" data-testid="in-host">Play</button>
      <input data-testid="host-field" />
      <div role="menu"><button type="button" data-testid="host-menu-item">Item</button></div>
      {control({ onStep })}
    </div>);
    await keyFrom(host.querySelector('[data-testid="in-host"]')!, "]");
    await keyDown("[");
    expect(onStep.mock.calls).toEqual([[1, "key"], [-1, "key"]]);
    onStep.mockClear();
    await keyFrom(host.querySelector('[data-testid="host-field"]')!, "]");
    await keyFrom(host.querySelector('[data-testid="host-menu-item"]')!, "]");
    const above = addToBody('<div role="dialog" data-slot="dialog-content" data-open=""><button type="button">Above</button></div>');
    await keyFrom(above.querySelector("button")!, "]");
    await keyFrom(host.querySelector('[data-testid="in-host"]')!, "]");
    expect(onStep).not.toHaveBeenCalled();
  });

  it("does not own the keys with keys={false}", async () => {
    const onStep = vi.fn();
    await render(control({ onStep, keys: false }));
    await keyDown("]");
    expect(onStep).not.toHaveBeenCalled();
    await act(async () => { button("Next video")!.click(); });
    expect(onStep).toHaveBeenCalledWith(1, "button");
  });
});

describe("useVideoStepKeys", () => {
  function Keys({ onStep, enabled }: { onStep: (delta: -1 | 1, via: StepVia) => void; enabled: boolean }) {
    useVideoStepKeys(onStep, { enabled });
    return null;
  }

  it("steps from the page while enabled, for a host that renders no control (the guest's phone bar)", async () => {
    const onStep = vi.fn();
    await render(<Keys onStep={onStep} enabled />);
    await keyDown("]");
    expect(onStep).toHaveBeenCalledWith(1, "key");
    await render(<Keys onStep={onStep} enabled={false} />);
    await keyDown("[");
    expect(onStep).toHaveBeenCalledTimes(1);
  });
});
