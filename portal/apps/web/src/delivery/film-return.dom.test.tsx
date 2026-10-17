import { describe, expect, it } from "vitest";
import { film, handle, page, photo } from "../testing/delivery-fixtures";
import { tabsOf } from "./delivery-model";
import { deliveryPageAddress, returnFilmOf, returnTargetOf } from "./film-return";

const SLUG = "12-example-st-23456b";
const vid = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
const review = (n: number) => ({ url: `/d/review?link=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#t=secret&v=${vid(n)}` });

describe("deliveryPageAddress", () => {
  it("names the film being watched in the page's fragment", () => {
    expect(deliveryPageAddress(SLUG, vid(3))).toBe(`/d/${SLUG}#v=${vid(3)}`);
  });
  it("is the bare page with no film, or with anything that is not a Video id", () => {
    expect(deliveryPageAddress(SLUG, null)).toBe(`/d/${SLUG}`);
    expect(deliveryPageAddress(SLUG, "../admin")).toBe(`/d/${SLUG}`);
  });
});

describe("returnFilmOf", () => {
  it("reads the Video id from the page's own fragment, round-tripping the address", () => {
    expect(returnFilmOf(new URL(deliveryPageAddress(SLUG, vid(3)), "https://x.test").hash)).toBe(vid(3));
  });
  it("is null for no fragment, a fragment with no film, or a film that is not a UUID", () => {
    expect(returnFilmOf("")).toBeNull();
    expect(returnFilmOf("#t=secret")).toBeNull();
    expect(returnFilmOf("#v=nope")).toBeNull();
  });
});

describe("returnTargetOf", () => {
  it("finds the tab and handle of the tile whose review opens that film", () => {
    const tabs = tabsOf(page([photo(1), film(2, { review: review(2) }), film(3, { review: review(3) })]));
    expect(returnTargetOf(tabs, vid(3))).toEqual({ tab: "film", handle: handle(3) });
  });
  it("finds an unlocked Premium film on the Premium tab", () => {
    const tabs = tabsOf(page([photo(1), film(2, { premium: true, review: review(2) })]));
    expect(returnTargetOf(tabs, vid(2))).toEqual({ tab: "premium", handle: handle(2) });
  });
  it("is null when no tile opens that film (gone, or no review on the page)", () => {
    const tabs = tabsOf(page([film(2, { review: review(2) }), film(3)]));
    expect(returnTargetOf(tabs, vid(9))).toBeNull();
    expect(returnTargetOf(tabs, null)).toBeNull();
  });
});
