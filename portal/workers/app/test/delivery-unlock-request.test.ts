import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_CLIENT_OUTBOX_ACTOR, DELIVERY_UNLOCK_NOTIFICATION_EVENT, deliveryUnlockRequestResponseSchema, parseDeliveryUnlockNotificationPayload } from "@quincy/shared";
import { database, ids, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedOpenProject, seedPage, seedUnlock, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { clearGuestRows, freshIp, guestFetch, HYGIENE } from "./guest-support";
import { publicDeliveryTestHooks } from "../src/delivery";

/**
 * A client asks, from the public Delivery page, for one locked item to be unlocked (#787 slice 8): `POST /d/api/pages/:slug/items/:handle/unlock-request`. It only ever notifies: nothing about premium
 * or Unlock state changes. Every miss is the one `/d` stub, validation errors included.
 */
const SLUG = "12-test-street-bcdfgh";
const stubOf = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "server-timing").sort() });
const expectStub = async (response: Response) => expect(await stubOf(response)).toEqual(await stubOf(await guestFetch("/d")));
const unlockUrl = (handle: string, slug = SLUG) => `/d/api/pages/${slug}/items/${handle}/unlock-request`;
const post = (handle: string, init: Parameters<typeof guestFetch>[1] = {}, slug = SLUG) => guestFetch(unlockUrl(handle, slug), { method: "POST", body: {}, ...init });
const handleOf = async (assetId: string) => (await database.DB.prepare("SELECT handle FROM delivery_set_items WHERE asset_id = ? ORDER BY rowid DESC").bind(assetId).first<{ handle: string }>())!.handle;
const lockedPhoto = (extra: { unlocked?: boolean; projectId?: string } = {}) => seedAsset("photo", { deliveryPremium: true, projectId: extra.projectId });
const outbox = async () => (await database.DB.prepare("SELECT id, recipient_id AS recipientId, actor_id AS actorId, source_key AS sourceKey, payload_json AS payload, status, project_id AS projectId FROM notification_outbox WHERE event_type = ? ORDER BY recipient_id").bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT).all<{ id: string; recipientId: string; actorId: string; sourceKey: string; payload: string; status: string; projectId: string }>()).results;
const ledger = async () => (await database.DB.prepare("SELECT channel, status, recipient_id AS recipientId FROM notification_delivery_ledger WHERE event_type = ?").bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT).all<{ channel: string; status: string; recipientId: string }>()).results;
const audits = async () => (await database.DB.prepare("SELECT actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, meta_json AS meta FROM audit_log WHERE action = 'delivery.unlock_request'").all<{ actorId: string | null; action: string; targetType: string; targetId: string; meta: string }>()).results;
const premiumState = async () => JSON.stringify([(await database.DB.prepare("SELECT id, delivery_premium AS p, updated_at AS u FROM assets ORDER BY id").all()).results, (await database.DB.prepare("SELECT * FROM asset_premium_unlocks ORDER BY asset_id").all()).results, (await database.DB.prepare("SELECT id, premium FROM videos ORDER BY id").all()).results]);
const DEACTIVATED_ADMIN = "a7777777-7777-4777-8777-777777777777";

beforeAll(async () => {
  await seedFixture();
  const now = Date.now();
  // The Admin (outside the Project), one more Admin who has left, and a Photographer on the Project; ids.member (editor) and ids.external are already members, ids.other (editor) is not.
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Gone Admin', ?, 1, 'admin', 0, ?, ?)").bind(DEACTIVATED_ADMIN, `${DEACTIVATED_ADMIN}@example.test`, now, now).run();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), ids.project, ids.photographer, now).run();
});
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM notification_delivery_ledger WHERE event_type = ?").bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT), database.DB.prepare("DELETE FROM notification_outbox WHERE event_type = ?").bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT),
    database.DB.prepare("DELETE FROM audit_log WHERE action = 'delivery.unlock_request'"), database.DB.prepare("DELETE FROM asset_renditions"), database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM videos"),
    database.DB.prepare("DELETE FROM assets WHERE r2_key LIKE '%delivery-test%'"),
  ]);
  await clearGuestRows();
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); publicDeliveryTestHooks.beforeServe = undefined; publicDeliveryTestHooks.beforeWrite = undefined; publicDeliveryTestHooks.afterWrite = undefined; publicDeliveryTestHooks.beforeVerify = undefined; });
afterEach(async () => { publicDeliveryTestHooks.beforeServe = undefined; publicDeliveryTestHooks.beforeWrite = undefined; publicDeliveryTestHooks.afterWrite = undefined; publicDeliveryTestHooks.beforeVerify = undefined; await wipe(); await clearDeliveryFlags(); });

async function lockedPage(slug = SLUG) {
  const asset = await lockedPhoto(); await seedPage({ slug, assetIds: [asset.id] });
  return { asset, handle: await handleOf(asset.id) };
}

describe("a request that lands", () => {
  it("answers 202 requested with hygiene headers, writes one audit (no actor, no raw address) and notifies Admins and Project Editors in app only", async () => {
    const { asset, handle } = await lockedPage(); const ip = freshIp(); const before = await premiumState();
    const response = await post(handle, { ip });
    expect(response.status).toBe(202);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    expect(deliveryUnlockRequestResponseSchema.parse(await response.json())).toEqual({ status: "requested" });
    const [audit, ...extra] = await audits(); expect(extra).toEqual([]);
    expect(audit).toMatchObject({ actorId: null, action: "delivery.unlock_request", targetType: "project", targetId: ids.project });
    const meta = JSON.parse(audit!.meta) as Record<string, unknown>;
    expect(meta).toMatchObject({ handle, label: "Photo 01", setNumber: 1, ipBucket: expect.stringMatching(/^unlock:ip:[0-9a-f]{64}$/) });
    const rows = await outbox();
    // Every active Admin (the fixture Admin is not on the Project) and the Editor member; not the other Editor, the External, the Photographer or the deactivated Admin.
    const admins = (await database.DB.prepare("SELECT id FROM user WHERE role = 'admin' AND active = 1").all<{ id: string }>()).results.map((row) => row.id);
    expect(admins).toContain(ids.admin); expect(admins).not.toContain(DEACTIVATED_ADMIN);
    expect(rows.map((row) => row.recipientId).sort()).toEqual([...admins, ids.member].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ actorId: DELIVERY_CLIENT_OUTBOX_ACTOR, projectId: ids.project, status: expect.stringMatching(/^(pending|queued)$/) });
      expect(row.sourceKey).toBe(`delivery_unlock_request:${(await database.DB.prepare("SELECT id FROM audit_log WHERE action = 'delivery.unlock_request'").first<{ id: string }>())!.id}`);
      const payload = parseDeliveryUnlockNotificationPayload(JSON.parse(row.payload))!; expect(payload).not.toBeNull(); expect(payload.delivery.setNumber).toBe(1);
      expect(payload.delivery).toMatchObject({ projectId: ids.project, assetId: asset.id, handle, label: "Photo 01" });
      expect(payload.event.recipientId).toBe(row.recipientId);
      expect(payload.authorizationAtOccurrence.kind).toBe(admins.includes(row.recipientId) ? "admin" : "project_member");
    }
    expect(await ledger()).toEqual(expect.arrayContaining([{ channel: "in_app", status: "pending", recipientId: ids.admin }, { channel: "in_app", status: "pending", recipientId: ids.member }]));
    expect((await ledger()).filter((row) => row.channel !== "in_app")).toEqual([]);
    // Nothing a client sent or the network saw is stored raw.
    const stored = JSON.stringify([await audits(), rows, await ledger()]);
    expect(stored).not.toContain(ip); expect(stored).not.toContain(`${asset.id}.bin`);
    // It only notifies.
    expect(await premiumState()).toBe(before);
  });

  it("does not change premium or Unlock state, and does not unlock", async () => {
    const { asset, handle } = await lockedPage();
    const state = await premiumState();
    await post(handle);
    expect(await premiumState()).toBe(state);
    expect((await database.DB.prepare("SELECT count(*) AS n FROM asset_premium_unlocks WHERE asset_id = ?").bind(asset.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("covers a locked Floorplan or Copy document too, labelled as the page shows it", async () => {
    const plan = await seedAsset("floorplan_pdf", { deliveryPremium: true, versionGroupId: crypto.randomUUID() }); await seedPage({ slug: SLUG, assetIds: [plan.id] });
    expect((await post(await handleOf(plan.id))).status).toBe(202);
    expect(JSON.parse((await audits())[0]!.meta).label).toBe("Floorplan 01");
  });

  it("an archived Project's page keeps accepting the request", async () => {
    const projectId = await seedOpenProject({ archived: true }); const asset = await lockedPhoto({ projectId });
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, ids.member, Date.now()).run();
    await seedPage({ projectId, slug: "9-archived-road-cdfghj", assetIds: [asset.id] });
    expect((await post(await handleOf(asset.id), {}, "9-archived-road-cdfghj")).status).toBe(202);
    // The studio is still told: an archived Project does not veto the notification.
    const recipients = (await outbox()).map((row) => row.recipientId);
    expect(recipients).toContain(ids.admin); expect(recipients).toContain(ids.member);
  });

  it("with no one to tell it still lands (the audit row is the record) and writes no notification", async () => {
    await database.DB.prepare("UPDATE user SET active = 0 WHERE role IN ('admin', 'editor')").run();
    try {
      const { handle } = await lockedPage();
      expect((await post(handle)).status).toBe(202);
      expect(await audits()).toHaveLength(1); expect(await outbox()).toEqual([]);
    } finally { await database.DB.prepare("UPDATE user SET active = 1 WHERE id <> ?").bind(DEACTIVATED_ADMIN).run(); }
  });
});

describe("a request that is not a request", () => {
  it("answers 409 not_locked for a free item, an unlocked item and a Video that is not premium, and writes nothing", async () => {
    const free = await seedAsset("photo"); const paid = await lockedPhoto(); await seedUnlock(paid.id);
    await seedPage({ slug: SLUG, assetIds: [free.id, paid.id] });
    for (const asset of [free, paid]) {
      const response = await post(await handleOf(asset.id));
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "not_locked" });
    }
    expect(await audits()).toEqual([]); expect(await outbox()).toEqual([]);
  });

  it("answers the one /d stub for every miss, whatever the body or the Origin", async () => {
    const { asset, handle } = await lockedPage();
    const cases: Array<[string, Response]> = [];
    cases.push(["unknown slug", await post(handle, {}, "unknown-page-bcdfgh")]);
    cases.push(["unknown handle", await post("0123456789abcdef")]);
    cases.push(["malformed handle", await post("NOT-A-HANDLE")]);
    cases.push(["unknown slug, hostile body", await post(handle, { body: { name: "x" } }, "unknown-page-bcdfgh")]);
    cases.push(["unknown slug, no Origin", await post(handle, { origin: null }, "unknown-page-bcdfgh")]);
    cases.push(["unknown slug, text body", await post(handle, { contentType: "text/plain", body: "x" }, "unknown-page-bcdfgh")]);
    cases.push(["a trailing slash", await guestFetch(`${unlockUrl(handle)}/`, { method: "POST", body: {} })]);
    cases.push(["an encoded segment", await guestFetch(unlockUrl(handle).replace("unlock-request", "unlock%2Drequest"), { method: "POST", body: {} })]);
    await database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run();
    cases.push(["page off", await post(handle)]); cases.push(["page off, hostile body", await post(handle, { body: [1, 2] })]);
    await database.DB.prepare("UPDATE delivery_pages SET enabled = 1").run();
    await clearDeliveryFlags();
    cases.push(["gate shut", await post(handle)]); cases.push(["gate shut, no Origin", await post(handle, { origin: null })]);
    for (const [name, response] of cases) { expect(response.status, name).toBe(404); await expectStub(response); }
    expect(await audits()).toEqual([]); expect(await outbox()).toEqual([]);
    expect(asset.id).toBeTruthy();
  });

  it("answers GET and HEAD on the unlock path with the stub", async () => {
    const { handle } = await lockedPage();
    await expectStub(await guestFetch(unlockUrl(handle)));
    expect(await stubOf(await guestFetch(unlockUrl(handle), { method: "HEAD" }))).toEqual(await stubOf(await guestFetch("/d", { method: "HEAD" })));
    for (const method of ["PUT", "PATCH", "DELETE"]) await expectStub(await guestFetch(unlockUrl(handle), { method, body: {} }));
  });

  it("answers 403 invalid_origin for a wrong or missing Origin and a non-JSON content type (after the page resolves), and writes nothing", async () => {
    const { handle } = await lockedPage();
    for (const init of [{ origin: null }, { origin: "https://evil.test" }, { contentType: "text/plain", body: "{}" }, { contentType: null }] as const) {
      const response = await post(handle, init as never); expect(response.status, JSON.stringify(init)).toBe(403); expect(await response.json()).toEqual({ error: "invalid_origin" });
    }
    expect(await audits()).toEqual([]);
  });

  it("answers 400 invalid_request for any field or a body that is not an object, and 413 for a large body; neither lands", async () => {
    const { handle } = await lockedPage();
    for (const body of [{ name: "Ada" }, { email: "ada@example.com" }, { message: "hi" }, [], "x", "not json {", 5]) {
      const response = await post(handle, { body: typeof body === "string" && body.startsWith("not") ? body : body }); expect(response.status, JSON.stringify(body)).toBe(400); expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const big = await post(handle, { body: JSON.stringify({ message: "x".repeat(4096) }) }); expect(big.status).toBe(413); expect(await big.json()).toEqual({ error: "payload_too_large" });
    expect(await audits()).toEqual([]); expect(await outbox()).toEqual([]);
  });

  it("accepts a bodyless-looking {} and ignores nothing else: an empty body is invalid, an empty object is the request", async () => {
    const { handle } = await lockedPage();
    expect((await post(handle, { body: "" })).status).toBe(400);
    expect((await post(handle, { body: "{}" })).status).toBe(202);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After on the sixth request from one address in 15 minutes, even for different items and an invalid body", async () => {
    const assets = [];
    for (let index = 0; index < 6; index += 1) assets.push(await lockedPhoto());
    await seedPage({ slug: SLUG, assetIds: assets.map((asset) => asset.id) });
    const ip = freshIp(); const results: number[] = [];
    for (const asset of assets.slice(0, 4)) results.push((await post(await handleOf(asset.id), { ip })).status);
    results.push((await post(await handleOf(assets[4]!.id), { ip, body: { bad: 1 } })).status);
    const limited = await post(await handleOf(assets[5]!.id), { ip });
    expect(results).toEqual([202, 202, 202, 202, 400]);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "too_many_attempts", retryAfterSeconds: expect.any(Number) });
    // Another address is not limited.
    expect((await post(await handleOf(assets[5]!.id))).status).toBe(202);
  });

  it("answers 429 when a page has had 30 requests in a day, across addresses", async () => {
    const { handle } = await lockedPage();
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) statuses.push((await post(handle)).status);
    expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("answers 202 already_requested for a second request for the same item the same day, from anywhere, and writes nothing", async () => {
    const { handle } = await lockedPage();
    expect(deliveryUnlockRequestResponseSchema.parse(await (await post(handle)).json())).toEqual({ status: "requested" });
    const recipientsAfterFirst = (await outbox()).length;
    const again = await post(handle);
    expect(again.status).toBe(202); expect(deliveryUnlockRequestResponseSchema.parse(await again.json())).toEqual({ status: "already_requested" });
    expect(await audits()).toHaveLength(1); expect((await outbox()).length).toBe(recipientsAfterFirst); expect(recipientsAfterFirst).toBeGreaterThan(1);
  });

  it("lets a different item through, and two simultaneous requests for one item land exactly once", async () => {
    const first = await lockedPhoto(); const second = await lockedPhoto(); await seedPage({ slug: SLUG, assetIds: [first.id, second.id] });
    const handleA = await handleOf(first.id); const handleB = await handleOf(second.id);
    const answers = await Promise.all([post(handleA), post(handleA), post(handleA), post(handleB)]);
    const bodies = await Promise.all(answers.map(async (response) => (await response.json()) as { status: string }));
    expect(answers.map((response) => response.status)).toEqual([202, 202, 202, 202]);
    expect(bodies.filter((body) => body.status === "requested")).toHaveLength(2);
    expect(await audits()).toHaveLength(2);
  });

  it("a request refused by the IP or page bucket does not spend the item's daily slot, and an invalid body does not either", async () => {
    const { handle } = await lockedPage(); const ip = freshIp();
    expect((await post(handle, { ip, body: { bad: 1 } })).status).toBe(400);
    expect((await post(handle, { ip })).status).toBe(202);
  });
});

describe("state that changes between admission and the write", () => {
  it("a page switched off in the gap writes nothing and answers the stub", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { await database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run(); };
    await expectStub(await post(handle));
    expect(await audits()).toEqual([]); expect(await outbox()).toEqual([]);
  });

  it("gives the item's daily slot back when the write found nothing, so the same request lands once the page is back on", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { await database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run(); };
    await expectStub(await post(handle));
    publicDeliveryTestHooks.beforeWrite = undefined; await database.DB.prepare("UPDATE delivery_pages SET enabled = 1").run();
    expect(deliveryUnlockRequestResponseSchema.parse(await (await post(handle)).json())).toEqual({ status: "requested" });
    expect(await audits()).toHaveLength(1);
  });

  it("a read that throws before the write leaves the item's daily slot free: the retry lands and notifies", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { throw new Error("boom"); };
    expect((await post(handle)).status).toBe(500);
    publicDeliveryTestHooks.beforeWrite = undefined;
    expect(await audits()).toEqual([]);
    expect(deliveryUnlockRequestResponseSchema.parse(await (await post(handle)).json())).toEqual({ status: "requested" });
    expect((await outbox()).length).toBeGreaterThan(0);
  });

  it("a batch that rolls back leaves the item's daily slot free: nothing is stored, the retry lands and notifies", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { await database.DB.exec("CREATE TRIGGER unlock_fault BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, 'forced outbox fault'); END;"); };
    try { expect((await post(handle)).status).toBe(500); } finally { publicDeliveryTestHooks.beforeWrite = undefined; await database.DB.exec("DROP TRIGGER IF EXISTS unlock_fault;"); }
    expect(await audits()).toEqual([]); expect(await outbox()).toEqual([]);
    expect(deliveryUnlockRequestResponseSchema.parse(await (await post(handle)).json())).toEqual({ status: "requested" });
    expect((await outbox()).length).toBeGreaterThan(0);
  });

  it("a batch that committed but whose reply was lost keeps the slot: the client gets 202, the retry is already_requested, and staff are told exactly once", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.afterWrite = async () => { throw new Error("reply lost"); };
    const first = await post(handle);
    publicDeliveryTestHooks.afterWrite = undefined;
    expect(first.status).toBe(202); expect(deliveryUnlockRequestResponseSchema.parse(await first.json())).toEqual({ status: "requested" });
    const told = (await outbox()).length; expect(told).toBeGreaterThan(0); expect(await audits()).toHaveLength(1);
    expect(deliveryUnlockRequestResponseSchema.parse(await (await post(handle)).json())).toEqual({ status: "already_requested" });
    expect(await audits()).toHaveLength(1); expect((await outbox()).length).toBe(told);
  });

  it("a verification read that throws keeps the slot and answers 500: the retry is already_requested, never a second notification", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.afterWrite = async () => { throw new Error("reply lost"); };
    publicDeliveryTestHooks.beforeVerify = async () => { throw new Error("verify down"); };
    expect((await post(handle)).status).toBe(500);
    publicDeliveryTestHooks.afterWrite = undefined; publicDeliveryTestHooks.beforeVerify = undefined;
    const told = (await outbox()).length;
    expect(deliveryUnlockRequestResponseSchema.parse(await (await post(handle)).json())).toEqual({ status: "already_requested" });
    expect((await outbox()).length).toBe(told);
  });

  it("the Client Delivery gate shut in the gap writes nothing and answers the stub", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { await clearDeliveryFlags(); };
    await expectStub(await post(handle));
    expect(await audits()).toEqual([]);
  });

  it("a republish that dropped the item in the gap writes nothing and answers the stub", async () => {
    const { asset, handle } = await lockedPage(); const other = await lockedPhoto();
    publicDeliveryTestHooks.beforeWrite = async () => {
      const setId = crypto.randomUUID();
      await database.DB.batch([
        database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 2, ?, ?, ?)").bind(setId, ids.project, crypto.randomUUID().slice(0, 32), ids.admin, Date.now()),
        database.DB.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) VALUES (?, ?, ?, 0)").bind(setId, other.id, "fedcba9876543210"),
        database.DB.prepare("UPDATE delivery_pages SET latest_set_number = 2"),
      ]);
    };
    await expectStub(await post(handle));
    expect(await audits()).toEqual([]); expect(asset.id).toBeTruthy();
  });

  it("an item unlocked in the gap writes nothing and answers 409 not_locked", async () => {
    const { asset, handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { await seedUnlock(asset.id); };
    const response = await post(handle);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "not_locked" });
    expect(await audits()).toEqual([]); expect(await outbox()).toEqual([]);
  });

  it("the Admin who left in the gap is not told (recipients are read in the same statement as the write)", async () => {
    const { handle } = await lockedPage();
    publicDeliveryTestHooks.beforeWrite = async () => { await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(ids.admin).run(); };
    try { expect((await post(handle)).status).toBe(202); } finally { await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(ids.admin).run(); }
    const recipients = (await outbox()).map((row) => row.recipientId);
    expect(recipients).toContain(ids.member); expect(recipients).not.toContain(ids.admin);
  });
});

describe("leak sweep", () => {
  it("no response, audit row, outbox row or ledger row carries a raw address, an Asset id, an original filename, a staff name or an email", async () => {
    const asset = await lockedPhoto(); await database.DB.prepare("UPDATE assets SET original_filename = 'SECRET-ORIGINAL-NAME.jpg' WHERE id = ?").bind(asset.id).run();
    await seedPage({ slug: SLUG, assetIds: [asset.id] }); const handle = await handleOf(asset.id); const ip = freshIp();
    const responses = [await post(handle, { ip }), await post(handle, { ip }), await post(handle, { ip, body: { x: 1 } }), await post("0123456789abcdef", { ip })];
    const secrets = [ip, "SECRET-ORIGINAL-NAME.jpg", asset.id, ids.admin, ids.member, ids.project, "Admin Person", "Member Person", "example.test"];
    for (const response of responses) {
      const haystack = `${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await response.text()}`;
      for (const secret of secrets) expect(haystack, `response leaks ${secret}`).not.toContain(secret);
    }
    // Stored rows may name the Project and the recipient (they are internal), but never the client's address or the original filename.
    const stored = JSON.stringify([await audits(), (await outbox()).map((row) => row.payload), await ledger()]);
    for (const secret of [ip, "SECRET-ORIGINAL-NAME.jpg", "Admin Person", "example.test"]) expect(stored, `stored rows leak ${secret}`).not.toContain(secret);
  });
});
