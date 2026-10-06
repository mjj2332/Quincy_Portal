import { describe, expect, it } from "vitest";
import { isAlertDialogPress } from "./alert-dialog-press";

describe("isAlertDialogPress (#625)", () => {
  it("is true for the panel, anything inside it, and the portal's overlay and focus guards", () => {
    document.body.innerHTML = `<div role="alertdialog"><button id="in">x</button></div><div data-slot="alert-dialog-portal"><span data-base-ui-focus-guard id="scrim"></span></div><button id="out">y</button>`;
    expect(isAlertDialogPress(document.getElementById("in"))).toBe(true);
    expect(isAlertDialogPress(document.getElementById("scrim"))).toBe(true);
    expect(isAlertDialogPress(document.querySelector('[role="alertdialog"]'))).toBe(true);
    expect(isAlertDialogPress(document.getElementById("out"))).toBe(false);
    expect(isAlertDialogPress(null)).toBe(false);
    expect(isAlertDialogPress(window)).toBe(false);
  });
});
