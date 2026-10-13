import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryPageDtoSchema, guestNoteListResponseSchema, guestVideoListResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, wipeDelivery } from "./delivery-support";
import { addMember, clearGuestRows, guestFetch, linkPath, linkWithSession, openGuestGate } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion } from "./video-review-support";

/**
 * Review status is staff-only (#863, ADR 0021 section 7: guests see public content only). With a Version stored as Approved (internal), no payload a guest or the public
 * Delivery page can read may carry the word, the key or the column. The guard tests keep the SOURCE of the guest and Delivery code clean, this holds the BYTES.
 */
const FORBIDDEN = ["approved_internal", "in_review", "reviewStatus", "review_status", "olderPublishedVersion", "Approved (internal)"] as const;
const expectClean = (label: string, text: string) => { for (const word of FORBIDDEN) expect(text, `${label} carries ${word}`).not.toContain(word); };

beforeAll(async () => { await seedFixture(); await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run(); });
const wipe = async () => {
  await clearGuestRows(); await clearVideoNotes(); await wipeDelivery();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM guest_notification_digest"), database.DB.prepare("DELETE FROM guest_link_members"), database.DB.prepare("DELETE FROM guest_reviewers"),
    database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"), database.DB.prepare("DELETE FROM client_links"),
    database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); await openGuestGate(); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); await clearVideoFlags(); });

describe("guest and public payloads never carry Review status", () => {
  it("a Review link's video list and notes, and the public Delivery page with its review entry, are clean while the Version is approved internally and published", async () => {
    const v = await seedVideoVersion({ title: "Hero", poster: true });
    await database.DB.prepare("UPDATE video_version_meta SET review_status = 'approved_internal' WHERE asset_id = ?").bind(v.assetId).run();
    await seedVideoNote({ assetId: v.assetId, guest: true, body: "Looks great" });
    const session = await linkWithSession();
    await addMember(session.id, v.videoId, [v.assetId]);
    const videos = await guestFetch(linkPath(session.id, "/videos"), { cookie: session.cookie }); expect(videos.status).toBe(200);
    const videosText = await videos.text(); expect(guestVideoListResponseSchema.parse(JSON.parse(videosText)).videos).toHaveLength(1); expectClean("guest videos", videosText);
    const notes = await guestFetch(linkPath(session.id, `/versions/${v.assetId}/notes`), { cookie: session.cookie }); expect(notes.status).toBe(200);
    const notesText = await notes.text(); expect(guestNoteListResponseSchema.parse(JSON.parse(notesText)).notes.length).toBeGreaterThan(0); expectClean("guest notes", notesText);
    // Publish the film (the staff route), so the Video reads Published for staff, then read the public page and the review entry it carries.
    expect((await request(`/api/projects/${ids.project}/delivery/publish`, "admin", "POST", { assetIds: [v.assetId], expectedLatestSet: null, operationId: crypto.randomUUID() })).ok).toBe(true);
    const staff = await (await request(`/api/projects/${ids.project}/videos`, "admin")).json() as { videos: Array<{ reviewStatus: string }> };
    expect(staff.videos[0]!.reviewStatus).toBe("published"); // staff do see it: the sweep below is not vacuous
    const slug = (await database.DB.prepare("SELECT slug FROM delivery_pages WHERE project_id = ?").bind(ids.project).first<{ slug: string }>())!.slug;
    const page = await guestFetch(`/d/api/pages/${slug}`); expect(page.status).toBe(200);
    const pageText = await page.text(); expect(deliveryPageDtoSchema.parse(JSON.parse(pageText)).items.some((item) => item.kind === "video")).toBe(true); expectClean("public Delivery page", pageText);
  });
});
