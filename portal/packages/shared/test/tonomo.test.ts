import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normaliseAddressKey, parseTonomoOrder, TonomoParseError } from "../src/tonomo";

describe("parseTonomoOrder", () => {
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

  it("collects unknown services without rejecting the order", () => {
    expect(parseTonomoOrder({ id: "7", street: "7 Test St", line_items: ["Photography", "Drone"] })).toMatchObject({
      services: [{ kind: "raw" }], unrecognisedServices: ["Drone"],
    });
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
