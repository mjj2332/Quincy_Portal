import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientDeliveryGate } from "../src/lib/client-delivery-gate";
import { database, ids, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, setDeliveryFlags } from "./delivery-support";

/** The Client Delivery gate (#787): `feature_flags` rows, the Project scope, and a missing row is off. */
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearDeliveryFlags(); });
const open = (projectId = ids.project) => clientDeliveryGate(database.DB, projectId);

describe("client delivery gate truth table", () => {
  it("is closed with no rows, and a missing row is off", async () => { expect(await open()).toBe(false); });

  it("is closed with the master flag alone: no scope names this Project", async () => {
    await setDeliveryFlags("client_delivery");
    expect(await open()).toBe(false);
  });

  it("is closed when only a scope is set", async () => {
    await setDeliveryFlags("client_delivery_all_projects", `client_delivery_pilot:${ids.project}`);
    expect(await open()).toBe(false);
  });

  it("is open with the master flag and the Project's pilot row", async () => {
    await setDeliveryFlags("client_delivery", `client_delivery_pilot:${ids.project}`);
    expect(await open()).toBe(true);
  });

  it("ignores a pilot row for another Project, and a pilot row that is present but off", async () => {
    await setDeliveryFlags("client_delivery", `client_delivery_pilot:${ids.otherProject}`);
    expect(await open()).toBe(false);
    expect(await open(ids.otherProject)).toBe(true);
    await setDeliveryFlags([`client_delivery_pilot:${ids.otherProject}`, false]);
    expect(await open(ids.otherProject)).toBe(false);
  });

  it("opens every Project with client_delivery_all_projects, but still needs the master flag, and a master row that is off closes it", async () => {
    await setDeliveryFlags("client_delivery_all_projects");
    expect(await open()).toBe(false);
    await setDeliveryFlags("client_delivery");
    expect(await open(ids.project)).toBe(true);
    expect(await open(ids.otherProject)).toBe(true);
    await setDeliveryFlags(["client_delivery", false]);
    expect(await open()).toBe(false);
  });

  it("does not share rows with the video review gate", async () => {
    await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review', 1, 1), ('video_review_all_projects', 1, 1)").run();
    expect(await open()).toBe(false);
    await database.DB.prepare("DELETE FROM feature_flags WHERE key LIKE 'video_review%'").run();
  });
});
