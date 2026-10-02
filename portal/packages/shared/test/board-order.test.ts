import { describe, expect, it } from "vitest";
import { compareBoardCards, type BoardCardOrderKey } from "../src";

function card(id: string, over: Partial<BoardCardOrderKey> = {}): BoardCardOrderKey {
  return { id, street: "1 Alpha St", priority: null, shootDate: null, ...over };
}
function order(cards: BoardCardOrderKey[], priorityVisible = true) {
  return [...cards].sort((a, b) => compareBoardCards(a, b, { priorityVisible })).map((c) => c.id);
}

describe("compareBoardCards", () => {
  it("orders priority 5 down to 1, then unset, ahead of shoot date", () => {
    const cards = [
      card("none-early", { shootDate: "2026-01-01" }),
      card("p1", { priority: 1, shootDate: "2026-01-02" }),
      card("p5", { priority: 5, shootDate: "2026-12-31" }),
      card("p3", { priority: 3, shootDate: "2026-06-01" }),
    ];
    expect(order(cards)).toEqual(["p5", "p3", "p1", "none-early"]);
  });

  it("orders the oldest shoot date first within a priority tier", () => {
    const cards = [
      card("late", { priority: 2, shootDate: "2026-03-10" }),
      card("early", { priority: 2, shootDate: "2026-03-02" }),
      card("mid", { priority: 2, shootDate: "2026-03-05" }),
    ];
    expect(order(cards)).toEqual(["early", "mid", "late"]);
  });

  it("puts missing and invalid shoot dates last within a tier", () => {
    const cards = [
      card("null", { priority: 4, shootDate: null, street: "1 Alpha St" }),
      card("invalid", { priority: 4, shootDate: "2025-02-29", street: "2 Beta St" }),
      card("garbage", { priority: 4, shootDate: "tomorrow", street: "3 Gamma St" }),
      card("valid", { priority: 4, shootDate: "2024-02-29", street: "9 Zulu St" }),
    ];
    expect(order(cards)).toEqual(["valid", "null", "invalid", "garbage"]);
  });

  it("falls back to street then id", () => {
    const cards = [
      card("b", { street: "2 Beta St", shootDate: "2026-01-01" }),
      card("a2", { street: "1 Alpha St", shootDate: "2026-01-01" }),
      card("a1", { street: "1 Alpha St", shootDate: "2026-01-01" }),
    ];
    expect(order(cards)).toEqual(["a1", "a2", "b"]);
  });

  it("ignores priority entirely when it is not visible to the viewer", () => {
    const cards = [
      card("late-p5", { priority: 5, shootDate: "2026-09-01" }),
      card("early-none", { priority: null, shootDate: "2026-01-01" }),
      card("mid-p1", { priority: 1, shootDate: "2026-05-01" }),
    ];
    expect(order(cards, false)).toEqual(["early-none", "mid-p1", "late-p5"]);
  });

  it("is independent of input permutation", () => {
    const cards = [
      card("a", { priority: 5, shootDate: "2026-02-01" }),
      card("b", { priority: 5, shootDate: "2026-01-01" }),
      card("c", { priority: null, shootDate: "2026-01-01" }),
      card("d", { priority: 1 }),
    ];
    const expected = ["b", "a", "d", "c"];
    expect(order(cards)).toEqual(expected);
    expect(order([...cards].reverse())).toEqual(expected);
    expect(order([cards[2]!, cards[0]!, cards[3]!, cards[1]!])).toEqual(expected);
  });
});
