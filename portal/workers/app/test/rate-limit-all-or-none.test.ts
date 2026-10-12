import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GUEST_WINDOW_MS, refundAttempt, reserveAllOrNone, windowStart } from "../src/guest/rate-limit";
import { database, seedFixture } from "./embedded-media-support";

/** The two-bucket reservation of the delivery zips (#787 slice 7): one batch, both rows move or neither, and a refund gives back exactly one. */
const NOW = 1_900_000_000_000;
const START = windowStart(NOW);
const put = (bucket: string, count: number) => database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, ?)").bind(bucket, START, count).run();
const used = async (bucket: string) => (await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ? AND window_start = ?").bind(bucket, START).first<{ count: number }>())?.count ?? 0;
const both = (ipLimit = 10, pageLimit = 60) => reserveAllOrNone(database.DB, [{ bucket: "ip", limit: ipLimit }, { bucket: "page", limit: pageLimit }], NOW);

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await database.DB.prepare("DELETE FROM guest_rate_limits").run(); });

describe("reserveAllOrNone", () => {
  it("charges both buckets when both have room (this also proves changes() chains the statements inside a D1 batch)", async () => {
    expect((await both()).limited).toBe(false);
    expect([await used("ip"), await used("page")]).toEqual([1, 1]);
  });
  it("a request refused by the address limit changes neither row and keeps earlier usage", async () => {
    await put("ip", 10); await put("page", 7);
    const refused = await both();
    expect(refused.limited).toBe(true); expect(refused.retryAfterSeconds).toBe(Math.ceil((START + GUEST_WINDOW_MS - NOW) / 1000));
    expect([await used("ip"), await used("page")]).toEqual([10, 7]);
  });
  it("a request refused by the page limit changes neither row", async () => {
    await put("ip", 1); await put("page", 60);
    expect((await both()).limited).toBe(true);
    expect([await used("ip"), await used("page")]).toEqual([1, 60]);
  });
  it("an exhausted address never takes the page's last slot, so an eligible request after it still fits (59/60)", async () => {
    await put("ip", 10); await put("page", 59);
    expect((await both()).limited).toBe(true);
    expect(await used("page")).toBe(59);
    const eligible = await reserveAllOrNone(database.DB, [{ bucket: "ip2", limit: 10 }, { bucket: "page", limit: 60 }], NOW);
    expect(eligible.limited).toBe(false);
    expect(await used("page")).toBe(60);
  });
  it("the batch is one unit: two eligible requests at 59/60 admit exactly one", async () => {
    await put("page", 59);
    const results = await Promise.all([
      reserveAllOrNone(database.DB, [{ bucket: "a", limit: 10 }, { bucket: "page", limit: 60 }], NOW),
      reserveAllOrNone(database.DB, [{ bucket: "b", limit: 10 }, { bucket: "page", limit: 60 }], NOW),
    ]);
    expect(results.filter((r) => !r.limited)).toHaveLength(1);
    expect(await used("page")).toBe(60);
    expect(await used("a") + await used("b")).toBe(1);
  });
});

describe("refundAttempt", () => {
  it("gives back exactly one: 2 becomes 1, never erased", async () => {
    await put("ip", 2);
    await refundAttempt(database.DB, "ip", NOW);
    expect(await used("ip")).toBe(1);
  });
  it("deletes the row when the count is 1", async () => {
    await put("ip", 1);
    await refundAttempt(database.DB, "ip", NOW);
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket = 'ip'").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
