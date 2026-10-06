import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { EmailText } from "./format-email";

function render(email: string): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<EmailText email={email} />));
  return host;
}

describe("EmailText", () => {
  it("keeps the text content identical so copy/paste and getByText still work", () => {
    expect(render("jane.doe@qa550.test").textContent).toBe("jane.doe@qa550.test");
  });

  it("offers break opportunities after @ and before each dot, nowhere else", () => {
    const host = render("jane.doe@qa550.test");
    const parts: string[] = [];
    host.childNodes.forEach((n) => parts.push(n.nodeName === "WBR" ? "|" : (n.textContent ?? "")));
    expect(parts.join("")).toBe("jane|.doe@|qa550|.test");
  });

  it("renders a plain address with no wbr when there is nothing to break at", () => {
    expect(render("x").querySelectorAll("wbr")).toHaveLength(0);
  });
});
