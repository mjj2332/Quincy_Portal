import { afterEach, describe, expect, it } from "vitest";
import { hasOpenInnerLayer, hasOpenModalAbove } from "./project-sheet-layers";

/** Builds `<body><popup role=dialog aria-modal>…</popup>…</body>` fixtures by hand. */
function fixture(html: string) {
  document.body.innerHTML = html;
  return {
    popup: document.querySelector<HTMLElement>('[data-fixture="popup"]'),
    slot: document.querySelector<HTMLElement>('[data-fixture="slot"]'),
  };
}
afterEach(() => { document.body.replaceChildren(); });

describe("hasOpenInnerLayer (#366)", () => {
  it("is false with nothing open, and does not count the popup's own dialog role", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
  });

  it("is true for a Lightbox-shaped modal dialog inside the popup", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div role="dialog" aria-modal="true" aria-label="Photo viewer"></div><div data-fixture="slot"></div></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
  });

  it("is true for an open global modal portalled outside the popup", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="dialog" aria-modal="true" data-open data-testid="confirm-modal"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
  });

  it("is true for an open alert dialog (the global confirm, #625), which sets no aria-modal", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="alertdialog" data-open data-testid="confirm-modal"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
  });

  it("is true for an open registry dialog (Base UI sets no aria-modal) portalled outside the popup, e.g. the Review links dialog", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="dialog" data-slot="dialog-content" data-open data-testid="review-links-dialog"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
  });

  it("is false for a closing registry dialog, which no longer carries data-open", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="dialog" data-slot="dialog-content" data-testid="review-links-dialog"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
  });

  it("is false for a closing alert dialog, which no longer carries data-open", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="alertdialog" data-testid="confirm-modal"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
  });

  it("is false for a closing modal, which no longer carries data-open", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="dialog" aria-modal="true" data-testid="confirm-modal"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
  });

  it("is false for a non-modal dialog and when the popup is not mounted", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div role="dialog" aria-label="Notifications"></div><div data-fixture="slot"></div></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
    expect(hasOpenInnerLayer(null, null, document)).toBe(false);
  });

  describe("popup arms (#375)", () => {
    const wrap = (inner: string, where: "popup" | "slot" = "popup") => fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open>${where === "popup" ? inner : ""}<div data-fixture="slot">${where === "slot" ? inner : ""}</div></div>`);
    it.each([
      ["a non-modal popover dialog", `<div role="dialog" data-open></div>`],
      ["a menu", `<div role="menu" data-open></div>`],
      ["a listbox (select / combobox list)", `<div role="listbox" data-open></div>`],
      ["a Quincy-owned floating layer without a role", `<div data-quincy-layer data-open></div>`],
    ])("is true for an open %s in the overlay slot and inside the popup", (_name, html) => {
      const inSlot = wrap(html, "slot");
      expect(hasOpenInnerLayer(inSlot.popup, inSlot.slot, document)).toBe(true);
      const inPopup = wrap(html, "popup");
      expect(hasOpenInnerLayer(inPopup.popup, inPopup.slot, document)).toBe(true);
    });

    it("is true for a Select-shaped popup: data-open on a presentation wrapper, none on the listbox inside", () => {
      const { popup, slot } = wrap(`<div role="presentation" data-open><div role="presentation" data-open><div role="listbox"></div></div></div>`, "slot");
      expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
    });

    it("is false for a closing Select-shaped popup (no data-open) and for a tooltip that wraps no list", () => {
      const closing = wrap(`<div role="presentation"><div role="listbox"></div></div>`, "slot");
      expect(hasOpenInnerLayer(closing.popup, closing.slot, document)).toBe(false);
      const tooltip = wrap(`<div role="presentation" data-open><div role="tooltip">Tip</div></div>`, "slot");
      expect(hasOpenInnerLayer(tooltip.popup, tooltip.slot, document)).toBe(false);
    });

    it("is true while the Project whiteboard is open inside the sheet (#498: Esc belongs to the board)", () => {
      const { popup, slot } = wrap(`<section data-quincy-whiteboard></section>`);
      expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
    });

    it("is true while the mention list is expanded on the editor's combobox", () => {
      const { popup, slot } = wrap(`<div role="combobox" aria-expanded="true"></div>`);
      expect(hasOpenInnerLayer(popup, slot, document)).toBe(true);
    });

    it.each([
      ["an open tooltip (data-open, no role)", `<div data-open></div>`],
      ["a closing popover (no data-open)", `<div role="dialog"></div>`],
      ["a closing menu", `<div role="menu"></div>`],
      ["a collapsed mention combobox", `<div role="combobox" aria-expanded="false"></div>`],
      ["a closing Quincy layer", `<div data-quincy-layer></div>`],
    ])("is false for %s", (_name, html) => {
      const { popup, slot } = wrap(html, "slot");
      expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
      const inPopup = wrap(html, "popup");
      expect(hasOpenInnerLayer(inPopup.popup, inPopup.slot, document)).toBe(false);
    });
  });
});

describe("hasOpenModalAbove (#741 5c-ui)", () => {
  it("is false with nothing else open, and does not count the popup itself or a dialog it sits inside", () => {
    const { popup } = fixture(`<div role="dialog" aria-modal="true" data-open><div data-fixture="popup" role="dialog" aria-modal="true" data-open></div></div>`);
    expect(hasOpenModalAbove(popup, document)).toBe(false);
    expect(hasOpenModalAbove(null, document)).toBe(false);
  });

  it("is true for an open modal dialog portalled outside the popup (the paste dialog)", () => {
    const { popup } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open></div><div role="dialog" aria-modal="true" data-open data-testid="paste-dialog"></div>`);
    expect(hasOpenModalAbove(popup, document)).toBe(true);
  });

  it("is true for a registry dialog, whose Base UI popup sets no aria-modal (only data-slot)", () => {
    const { popup } = fixture(`<div data-fixture="popup" data-slot="dialog-content" role="dialog" data-open></div><div data-slot="dialog-content" role="dialog" data-open data-testid="paste-dialog"></div>`);
    expect(hasOpenModalAbove(popup, document)).toBe(true);
    document.querySelector('[data-testid="paste-dialog"]')!.removeAttribute("data-open");
    expect(hasOpenModalAbove(popup, document)).toBe(false);
  });

  it("is true for a modal rendered inside the popup", () => {
    const { popup } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div role="dialog" aria-modal="true" data-open></div></div>`);
    expect(hasOpenModalAbove(popup, document)).toBe(true);
  });

  it("is false for a modal that sits under the popup (the Project sheet the viewer opened from)", () => {
    const { popup } = fixture(`<div role="dialog" aria-modal="true" data-open data-testid="sheet"></div><div data-fixture="popup" role="dialog" aria-modal="true" data-open></div>`);
    expect(hasOpenModalAbove(popup, document)).toBe(false);
  });

  it("is false for a closing modal, a non-modal dialog and an alert dialog (which has its own arm)", () => {
    const { popup } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open></div><div role="dialog" aria-modal="true"></div><div role="dialog" data-open></div><div role="alertdialog" data-open></div>`);
    expect(hasOpenModalAbove(popup, document)).toBe(false);
  });
});
