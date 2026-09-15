import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isVerifiedTonomoShootDateSource, normaliseAddressKey, parseTonomoDisplayDate, parseTonomoOrder, TonomoParseError, tonomoOrderKey } from "../src/tonomo";

const changedWebhookFixture = {
  action: "changed",
  id: "appointment-event-001",
  orderId: "tonomo-order-001",
  address: {
    street: "Appointment Venue Street",
    formatted_address: "Appointment Venue Street, Exampleville NSW 2000, Australia",
  },
  order: {
    id: "tonomo-order-001",
    property_address: {
      street: "42 Example Street",
      formatted_address: "42 Example Street, Exampleville NSW 2000, Australia",
      city: "Exampleville",
      zipcode: "2000",
    },
  },
} as const;

describe("parseTonomoOrder", () => {
  it("unwraps changed webhook envelopes before parsing the nested order", () => {
    expect(parseTonomoOrder(changedWebhookFixture)).toMatchObject({
      orderId: "tonomo-order-001",
      street: "42 Example Street",
      suburb: "Exampleville",
      postcode: "2000",
    });
  });

  it.each([
    ["order_id", { order_id: "tonomo-order-001" }],
    ["orderId", { orderId: "tonomo-order-001" }],
  ] as const)("accepts the nested %s order identity alias", (_alias, identity) => {
    const order = { ...changedWebhookFixture.order, id: undefined, ...identity };
    expect(parseTonomoOrder({ ...changedWebhookFixture, order })).toMatchObject({
      orderId: "tonomo-order-001",
      street: "42 Example Street",
    });
  });

  it("rejects malformed changed envelopes without a nested order", () => {
    expect(() => parseTonomoOrder({ action: "changed", id: "appointment-event-001", orderId: "tonomo-order-001" }))
      .toThrow(TonomoParseError);
    expect(() => parseTonomoOrder({ ...changedWebhookFixture, order: null }))
      .toThrow(TonomoParseError);
  });

  it("rejects changed envelopes with conflicting order identities", () => {
    expect(() => parseTonomoOrder({
      ...changedWebhookFixture,
      order: { ...changedWebhookFixture.order, id: "different-order" },
    })).toThrow(/conflicts with nested order id/);
    expect(() => parseTonomoOrder({
      ...changedWebhookFixture,
      order: { ...changedWebhookFixture.order, orderId: "different-order" },
    })).toThrow(/conflicting nested order ids/);
  });

  it("does not unwrap an arbitrary order property on a direct payload", () => {
    expect(parseTonomoOrder({
      id: "direct-order",
      street: "1 Direct Street",
      order: { id: "nested-order", street: "2 Nested Street" },
    }).orderId).toBe("direct-order");
  });

  it("uses the normalized nested order identity for changed payloads", () => {
    expect(tonomoOrderKey(changedWebhookFixture)).toBe("tonomo-order-001");
    expect(tonomoOrderKey({
      id: "direct-order",
      street: "1 Direct Street",
      order: { id: "nested-order" },
    })).toBe("direct-order");
  });

  it("parses a snake_case order with string services", () => {
    expect(parseTonomoOrder({
      order_id: 42, order_no: "Q-42", street: "4 McGowen Ave", suburb: "Richmond", postcode: "3121",
      agent_name: "Ava Agent", agent_email: "ava@example.test", agent_phone: "0400000000", agency_name: "Quincy Realty",
      shoot_date: "2026-07-20", time_window: "9–11am", invoice_amount: 450, payment_status: "paid", notes: "Gate is open",
      services: ["Photography", "Video", "Floor Plan", "Copywriting"],
    })).toMatchObject({
      orderId: "42", orderNo: "Q-42", street: "4 McGowen Ave", suburb: "Richmond", postcode: "3121",
      services: [{ kind: "raw" }, { kind: "video" }, { kind: "floorplan" }, { kind: "copy" }],
    });
  });

  it("parses camelCase services with delivery links", () => {
    const order = parseTonomoOrder({
      orderId: "order-7", reference: "REF-7", address: "1 River Road", agentName: "Ava", agency: "Quincy",
      shootDate: "tomorrow", timeWindow: "AM", amount: 99.5,
      items: [{ service: "video", delivery_url: "https://example.test/video" }, { name: "floorplan", link: "https://example.test/plan" }],
    });
    expect(order).toMatchObject({
      orderId: "order-7", street: "1 River Road", suburb: null, postcode: null,
      services: [{ kind: "video", url: "https://example.test/video" }, { kind: "floorplan", url: "https://example.test/plan" }],
    });
  });

  it("uses property_address formatted_address when street is missing", () => {
    const order = parseTonomoOrder({
      order_id: "formatted-address",
      property_address: {
        formatted_address: "17 Oxford St, Bondi Junction NSW 2022, Australia",
        city: "Bondi Junction",
        zipcode: "2022",
      },
    });
    expect(order).toMatchObject({
      street: "17 Oxford St, Bondi Junction NSW 2022, Australia",
      suburb: "Bondi Junction",
      postcode: "2022",
    });
  });

  it("collects unknown services without rejecting the order", () => {
    expect(parseTonomoOrder({ id: "7", street: "7 Test St", line_items: ["Photography", "Drone"] })).toMatchObject({
      services: [{ kind: "raw" }], unrecognisedServices: ["Drone"],
    });
  });

  it("strips unsafe service and deliverable URLs", () => {
    const order = parseTonomoOrder({
      id: "unsafe-url", street: "1 Test St",
      services: [{ service: "video", delivery_url: "javascript:alert(1)" }],
      deliverablesLinks: [{ type: "Floor Plan", name: "Floor plan", url: "javascript:alert(1)" }],
    });
    expect(order.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "video", url: null }),
      expect.objectContaining({ kind: "floorplan", url: null }),
    ]));
  });

  it("rejects an order without an id or street", () => {
    expect(() => parseTonomoOrder({ street: "1 Test St" })).toThrow(TonomoParseError);
    expect(() => parseTonomoOrder({ id: "7" })).toThrow(TonomoParseError);
  });

  it("parses the captured Tonomo payloads", async () => {
    const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    const withRawFolder = JSON.parse(await readFile(`${repoRoot}/test-data/tonomo/order-with-raw-folder.json`, "utf8"));
    const first = parseTonomoOrder(withRawFolder);
    expect(first).toMatchObject({
      orderId: "HJbb9eBGIJrGFG3elwwF",
      street: "17 Oxford Street",
      suburb: "Bondi Junction",
      postcode: "2022",
      agentName: "Stephanie Farah",
      agentEmail: "stephanie@ngfarah.com.au",
      agencyName: "NG Farah",
      invoiceAmount: 1366.85,
      paymentStatus: "unpaid",
      shootDate: "2026-06-12",
      rawFolderLink: "https://www.dropbox.com/scl/fo/p4o7e98ecwkbisx80vody/AKU76O9OJgTonStLkJ4LN3M?rlkey=0xzztznpigxqdulk44failmt5&dl=0",
      rawFolderPath: "/tonomo/raw files/igor melo/12-06-2026/17 oxford st, bondi junction nsw 2022, australia",
      photographerEmails: ["igor@quincyproductions.com.au"],
    });
    expect(first.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "raw" }),
      expect.objectContaining({ kind: "floorplan", url: "https://www.dropbox.com/scl/fo/f3vpc5i64cr35vkllodwk/ADiegClFsGduYz2oBKsFh8g?rlkey=82uz4gqnpv8z2p36kinvec1mt&dl=1" }),
      expect.objectContaining({ kind: "copy" }),
    ]));
    expect(first.services.some((service) => service.label?.includes("Listing Images - Full-Size"))).toBe(false);
    expect(first.services.some((service) => service.url?.includes("aotv95r25y0n7zr79j4bc"))).toBe(false);

    const withoutRawFolder = JSON.parse(await readFile(`${repoRoot}/test-data/tonomo/order-delivered.json`, "utf8"));
    const second = parseTonomoOrder(withoutRawFolder);
    expect(second).toMatchObject({
      orderId: "dPLBzV433abICLEJf5Jr",
      street: "29 Bay Street",
      suburb: "Mosman",
      postcode: "2088",
      invoiceAmount: 3076.43,
      shootDate: "2026-05-21",
      rawFolderLink: null,
      rawFolderPath: null,
      photographerEmails: ["andrew@quincyproductions.com.au", "igor@quincyproductions.com.au"],
    });
    expect(second.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "video", label: "Social Media Cut/Reel" }),
      expect.objectContaining({ kind: "video", label: "Dusk/Dawn Footage" }),
      expect.objectContaining({ kind: "floorplan", url: "https://www.dropbox.com/scl/fo/990wbknuzl7qawbglkbh3/AIuiBPHnNTwV28Zr26NefM0?rlkey=zvdu39lcbhsyf2w0dch912r3y&dl=1" }),
      expect.objectContaining({ kind: "video", url: "https://www.dropbox.com/scl/fi/agvrjq2eaatt4x4h9xe45/2026.05.21_-_ray_white_lower_north_shore_group_-_29_bay_street-_mosman_2088_-_master_-_v1.6q_v11-1080p.mp4?rlkey=wku1aqgoxym6qrgncyjwp3rkk&dl=1" }),
      expect.objectContaining({ kind: "video", url: "https://www.dropbox.com/scl/fi/3rl5u2zwofd3vjpkerhbx/2026.05.21_-_ray_white_lower_north_shore_group_-_29_bay_street-_mosman_2088_-_reel_-_v1.73q_v4-1080p.mp4?rlkey=j13parpjrekmnrfpho6q02gch&dl=1" }),
      expect.objectContaining({ kind: "copy", url: "https://www.dropbox.com/scl/fi/9iong8gw92gguhgcpsvep/29-Bay-Street-Mosman.pdf?rlkey=vthpan072i4c9z6ea60ypigli&dl=1" }),
    ]));
    // The reel is listed twice under distinct share links with one content_hash —
    // exactly two video URLs (master + reel) must survive the dedupe.
    expect(second.services.filter((service) => service.kind === "video" && service.url).map((service) => service.url))
      .toHaveLength(2);
    expect(second.unrecognisedServices).not.toEqual(expect.arrayContaining([
      "Cinematic Videography",
      "Social Media Cut/Reel",
      "Dusk/Dawn Footage",
    ]));
    expect(second.notes).toContain("Listing Agent Contact Details + Site Agent Contact Details: Bernard Ryan and Benoit Guittonneau");
  });

  it("keeps omitted money fields distinct from explicit nulls", () => {
    expect(parseTonomoOrder({ id: "absent", street: "1 Test St" }).invoiceAmount).toBeUndefined();
    expect(parseTonomoOrder({ id: "null", street: "1 Test St", invoice_amount: null, paymentStatus: null }))
      .toMatchObject({ invoiceAmount: null, paymentStatus: null });
  });

  it("uses the street portion of order_name only as the final address fallback", () => {
    expect(parseTonomoOrder({ id: "fallback", order_name: "29 Bay St, Mosman NSW 2088, Australia - Henriette Solheim" }).street)
      .toBe("29 Bay St");
  });
});

describe("normaliseAddressKey", () => {
  it("collapses casing, punctuation and whitespace", () => {
    expect(normaliseAddressKey("4 McGowen Ave ", "3121")).toBe(normaliseAddressKey("4 mcgowen ave", "3121"));
  });

  it("keeps punctuation-separated address components distinct", () => {
    expect(normaliseAddressKey("1/23 Smith St", null)).not.toBe(normaliseAddressKey("123 Smith St", null));
  });
});

describe("parseTonomoDisplayDate", () => {
  it.each([
    ["Thursday, 15 Jan, 2026", "2026-01-15"],
    ["Saturday, 14 Feb, 2026", "2026-02-14"],
    ["Tuesday, 17 Mar, 2026", "2026-03-17"],
    ["Monday, 20 Apr, 2026", "2026-04-20"],
    ["Thursday, 21 May, 2026", "2026-05-21"],
    ["Friday, 12 Jun, 2026", "2026-06-12"],
    ["Saturday, 04 Jul, 2026", "2026-07-04"],
    ["Saturday, 08 Aug, 2026", "2026-08-08"],
    ["Thursday, 17 Sep, 2026", "2026-09-17"],
    ["Saturday, 31 Oct, 2026", "2026-10-31"],
    ["Thursday, 26 Nov, 2026", "2026-11-26"],
    ["Friday, 25 Dec, 2026", "2026-12-25"],
  ])("parses %s as %s", (display, iso) => {
    expect(parseTonomoDisplayDate(display)).toBe(iso);
  });

  it("rejects a weekday that does not match the calendar date", () => {
    expect(parseTonomoDisplayDate("Monday, 17 Sep, 2026")).toBeNull();
  });

  it("rejects a single-digit day", () => {
    expect(parseTonomoDisplayDate("Thursday, 7 Sep, 2026")).toBeNull();
  });

  it("rejects a lowercase month abbreviation", () => {
    expect(parseTonomoDisplayDate("Thursday, 17 sep, 2026")).toBeNull();
  });

  it("rejects free text", () => {
    expect(parseTonomoDisplayDate("tomorrow")).toBeNull();
  });
});

describe("parseTonomoOrder shootDate normalisation", () => {
  it("normalises a Tonomo display date to ISO", () => {
    const order = parseTonomoOrder({ id: "display-date", street: "1 Test St", shoot_date: "Thursday, 17 Sep, 2026" });
    expect(order.shootDate).toBe("2026-09-17");
  });

  it("passes an already-ISO shoot date through unchanged", () => {
    const order = parseTonomoOrder({ id: "iso-date", street: "1 Test St", shoot_date: "2026-09-17" });
    expect(order.shootDate).toBe("2026-09-17");
  });

  it("keeps unrecognised shoot date text as-is", () => {
    const order = parseTonomoOrder({ id: "unknown-date", street: "1 Test St", shoot_date: "Monday, 17 Sep, 2026" });
    expect(order.shootDate).toBe("Monday, 17 Sep, 2026");
  });

  it("prefers when.start_time (integer epoch seconds) over a conflicting date field", () => {
    const order = parseTonomoOrder({
      id: "start-time-integer",
      street: "1 Test St",
      date: "Monday, 17 Sep, 2026",
      when: { start_time: 1_789_516_800 },
      property_address: { timezone: "UTC" },
    });
    expect(order.shootDate).toBe("2026-09-16");
  });

  it("prefers when.start_time (numeric string epoch seconds) over a conflicting date field", () => {
    const order = parseTonomoOrder({
      id: "start-time-string",
      street: "1 Test St",
      date: "Monday, 17 Sep, 2026",
      when: { start_time: "1789516800" },
      property_address: { timezone: "UTC" },
    });
    expect(order.shootDate).toBe("2026-09-16");
  });

  it("names where the shoot date came from, and trusts only sources that identify a calendar date", () => {
    const source = (order: Record<string, unknown>) => parseTonomoOrder({ id: "source", street: "1 Test St", ...order }).shootDateSource;
    expect(source({ when: { start_time: 1_789_516_800 }, property_address: { timezone: "UTC" } })).toBe("start_time");
    expect(source({ shoot_date: "2026-09-17" })).toBe("iso");
    expect(source({ shoot_date: "Thursday, 17 Sep, 2026" })).toBe("display");
    expect(source({ shoot_date: "Monday, 17 Sep, 2026" })).toBe("text");
    expect(source({ when: { start_time: 1_789_516_800 }, property_address: { timezone: "Not/AZone" }, date: "Thursday, 17 Sep, 2026" })).toBe("display");
    expect(source({})).toBeNull();
    expect(["start_time", "iso", "display"].every((value) => isVerifiedTonomoShootDateSource(value as never))).toBe(true);
    expect(isVerifiedTonomoShootDateSource("text")).toBe(false);
    expect(isVerifiedTonomoShootDateSource(null)).toBe(false);
  });
});
