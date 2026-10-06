import { afterEach, describe, expect, it } from "vitest";
import { findMoreFor } from "./calendar-more-anchor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function day(date: string, ids: string[]): HTMLButtonElement {
  const button = document.createElement("button");
  const marker = document.createElement("span");
  marker.setAttribute("data-more-event-ids", ids.join(" "));
  marker.setAttribute("data-more-day", date);
  button.append(marker);
  document.body.append(button);
  return button;
}

afterEach(() => { document.body.replaceChildren(); });

describe("findMoreFor (#583)", () => {
  it("picks the button of the named day when a multi-day item sits in several overflow lists", () => {
    const first = day("2026-08-12", ["a", "multi"]);
    const second = day("2026-08-13", ["multi", "b"]);
    expect(findMoreFor("multi", "2026-08-12")).toBe(first);
    expect(findMoreFor("multi", "2026-08-13")).toBe(second);
  });
  it("is null with no day, for a day that does not hold the item, or when nothing is folded", () => {
    day("2026-08-12", ["a"]);
    expect(findMoreFor("a", null)).toBeNull();
    expect(findMoreFor("multi", "2026-08-12")).toBeNull();
    expect(findMoreFor("a", "2026-08-20")).toBeNull();
  });
});
