// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { shellChromeBottom } from "./shell-chrome";

/** #528 — the sticky shell header's bottom edge, which a viewport-measured popup must stay below. */
function header(bottom: number) {
  const el = document.createElement("header");
  el.className = "shell-header";
  el.getBoundingClientRect = () => ({ bottom, top: 0, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.append(el);
}

afterEach(() => document.body.replaceChildren());

describe("shellChromeBottom (#528)", () => {
  it("is 0 when there is no shell header", () => {
    expect(shellChromeBottom()).toBe(0);
  });
  it("is the header's bottom edge", () => {
    header(50);
    expect(shellChromeBottom()).toBe(50);
  });
  it("includes the impersonation banner offset (the header sits lower while impersonating)", () => {
    header(92);
    expect(shellChromeBottom()).toBe(92);
  });
  it("never goes negative", () => {
    header(-4);
    expect(shellChromeBottom()).toBe(0);
  });
});
