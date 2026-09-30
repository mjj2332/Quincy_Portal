import { afterEach, describe, expect, it } from "vitest";
import { hasOpenInnerLayer } from "./project-sheet-layers";

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

  it("is false for a closing modal, which no longer carries data-open", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div data-fixture="slot"></div></div><div role="dialog" aria-modal="true" data-testid="confirm-modal"></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
  });

  it("is false for a non-modal dialog and when the popup is not mounted", () => {
    const { popup, slot } = fixture(`<div data-fixture="popup" role="dialog" aria-modal="true" data-open><div role="dialog" aria-label="Notifications"></div><div data-fixture="slot"></div></div>`);
    expect(hasOpenInnerLayer(popup, slot, document)).toBe(false);
    expect(hasOpenInnerLayer(null, null, document)).toBe(false);
  });
});
