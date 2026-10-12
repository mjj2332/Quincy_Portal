import { describe, expect, it } from "vitest";
import type { DeliveryItemDto, DeliveryPageDto } from "@quincy/shared";
import { aspectOf, formatDelivered, formatDuration, heroMetaOf, heroOf, isExtra, tabsOf } from "./delivery-model";
import { STUDIO_EMAIL, STUDIO_WEBSITE, studioEmailHref } from "./studio";

const handle = (n: number) => `h${String(n).padStart(15, "0")}`;
const item = (n: number, over: Partial<DeliveryItemDto> = {}): DeliveryItemDto => ({ handle: handle(n), kind: "photo", label: `Photo ${String(n).padStart(2, "0")}`, position: n, locked: false, premium: false, width: 6000, height: 4000, durationMs: null, url: `/m/${n}`, thumbUrl: `/t/${n}`, ...over });
const page = (items: DeliveryItemDto[], coverHandle: string | null = null): DeliveryPageDto => ({ property: { street: "12 Example St", suburb: "Suburbia", postcode: "2030", agency: "Harbour Realty" }, setNumber: 1, publishedAt: 1_760_000_000_000, coverHandle, items });

describe("tabsOf", () => {
  it("orders tabs Gallery, Film, Floorplan, Premium, Copywriting, keeps published order and hides empty tabs", () => {
    const tabs = tabsOf(page([item(1, { kind: "copy", url: "/c" }), item(2), item(3, { kind: "video" }), item(4, { kind: "floorplan" }), item(5)]));
    expect(tabs.map((tab) => tab.id)).toEqual(["photos", "film", "floorplan", "description"]);
    expect(tabs[0]!.items.map((i) => i.handle)).toEqual([handle(2), handle(5)]);
  });
  it("puts every extra, locked or unlocked, of every kind on Premium and out of its kind tab", () => {
    const tabs = tabsOf(page([item(1), item(2, { premium: true, locked: true }), item(3, { premium: true }), item(4, { kind: "floorplan", premium: true, locked: true, url: null, thumbUrl: null })]));
    expect(tabs.map((tab) => tab.id)).toEqual(["photos", "premium"]);
    expect(tabs[1]!.items.map((i) => i.handle)).toEqual([handle(2), handle(3), handle(4)]);
    expect(tabs[0]!.items.map((i) => i.handle)).toEqual([handle(1)]);
  });
  it("keeps Premium after an unlock (locked false, premium true) and hides a kind tab left empty", () => {
    const tabs = tabsOf(page([item(1, { premium: true, locked: false })]));
    expect(tabs.map((tab) => tab.id)).toEqual(["premium"]);
  });
  it("puts Premium before Copywriting when both have items", () => {
    const tabs = tabsOf(page([item(1), item(2, { kind: "copy", url: "/c" }), item(3, { premium: true })]));
    expect(tabs.map((tab) => tab.id)).toEqual(["photos", "premium", "description"]);
  });
  it("treats a locked item as an extra even if the flag were missing", () => { expect(isExtra(item(1, { locked: true }))).toBe(true); });
  it("is empty for an empty page", () => { expect(tabsOf(page([]))).toEqual([]); });
});

describe("tab labels", () => {
  it("name the Gallery and Copywriting tabs as the prototype does, with the ids unchanged", () => {
    const tabs = tabsOf(page([item(1), item(2, { kind: "copy", url: "/c" })]));
    expect(tabs.map((tab) => [tab.id, tab.label])).toEqual([["photos", "Gallery"], ["description", "Copywriting"]]);
  });
});

describe("heroMetaOf", () => {
  it("is the eyebrow parts (suburb, postcode, delivered date), the agency, and the counts", () => {
    expect(heroMetaOf(page([item(1), item(2), item(3, { kind: "video" })]))).toEqual({ eyebrow: ["Suburbia", "2030", "9 October 2025"], agency: "Harbour Realty", frames: 2, films: 1 });
  });
  it("leaves paid-extra photos out of the frames and counts every film, premium or not", () => {
    const meta = heroMetaOf(page([item(1), item(2, { premium: true, locked: true }), item(3, { premium: true }), item(4, { kind: "video", premium: true, locked: true, url: null }), item(5, { kind: "video" })]));
    expect(meta).toMatchObject({ frames: 1, films: 2 });
  });
  it("drops what is missing: no suburb, no postcode, no date in a Preview, no agency", () => {
    const base = page([item(1)]);
    const meta = heroMetaOf({ ...base, publishedAt: null, property: { street: "12 Example St", suburb: null, postcode: null, agency: null } });
    expect(meta).toEqual({ eyebrow: [], agency: null, frames: 1, films: 0 });
    expect(heroMetaOf({ ...base, publishedAt: null }).eyebrow).toEqual(["Suburbia", "2030"]);
  });
});

describe("heroOf", () => {
  it("is the cover when the cover is a photo the client may see in full", () => { expect(heroOf(page([item(1), item(2)], handle(2)))?.handle).toBe(handle(2)); });
  it("falls back to the first unlocked photo when the cover is locked, null or not a photo", () => {
    expect(heroOf(page([item(1, { locked: true, premium: true }), item(2)], handle(1)))?.handle).toBe(handle(2));
    expect(heroOf(page([item(1), item(2)], null))?.handle).toBe(handle(1));
    expect(heroOf(page([item(1, { kind: "video" }), item(2)], handle(1)))?.handle).toBe(handle(2));
    expect(heroOf(page([item(1), item(2)], "ffffffffffffffff"))?.handle).toBe(handle(1));
  });
  it("is null when there is no usable photo (text-only hero)", () => {
    expect(heroOf(page([item(1, { locked: true, url: null, thumbUrl: null }), item(2, { kind: "video" })]))).toBeNull();
    expect(heroOf(page([]))).toBeNull();
  });
});

describe("formatting", () => {
  it("aspect from dimensions, 3 / 2 when unknown", () => { expect(aspectOf({ width: 6000, height: 4000 })).toBe("6000 / 4000"); expect(aspectOf({ width: null, height: null })).toBe("3 / 2"); });
  it("delivered date in the studio's time zone, null for a Preview", () => {
    expect(formatDelivered(Date.UTC(2026, 9, 10, 14, 30))).toBe("11 October 2026");
    expect(formatDelivered(null)).toBeNull();
  });
  it("duration", () => { expect(formatDuration(62_000)).toBe("1:02"); expect(formatDuration(3_723_000)).toBe("1:02:03"); expect(formatDuration(null)).toBeNull(); });
  it("studio email link, with the street as the subject, and website", () => {
    expect(STUDIO_EMAIL).toBe("info@quincyproductions.com.au");
    expect(STUDIO_WEBSITE).toBe("https://quincyproductions.com.au");
    expect(studioEmailHref("12 Example St & Co")).toBe("mailto:info@quincyproductions.com.au?subject=12%20Example%20St%20%26%20Co");
  });
});
