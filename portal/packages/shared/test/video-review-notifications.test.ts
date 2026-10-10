import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_OUTBOX_EVENT_TYPES, NOTIFICATION_TYPES, NOTIFICATION_WORKSPACE_TAB, EXTERNAL_LEGACY_NOTIFICATION_POLICY, NOTIFICATION_ENRICHMENT, externalNotificationChannels, externalNotificationCopy,
  VIDEO_REVIEW_NOTIFICATION_EVENT, VIDEO_REVIEW_NOTIFICATION_TYPES, parseVideoReviewNotificationPayload, videoReviewNotificationSourceKey,
} from "../src";

/** #741 15a: the staff video-review notification transport. */
const ID = "11111111-1111-4111-8111-111111111111";
const payload = (kind: string = "video_note") => ({
  schemaVersion: 1,
  event: { type: VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey: `video_note:${ID}`, recipientId: ID },
  authorizationAtOccurrence: { kind: "project_member", membershipIds: [ID] },
  video: { kind, projectId: ID, videoId: ID, assetId: ID, sourceId: ID },
});

describe("video review notification transport", () => {
  it("names one outbox event and exactly four notification types", () => {
    expect(NOTIFICATION_OUTBOX_EVENT_TYPES.projectVideoReview).toBe("project.video_review.notification");
    expect(VIDEO_REVIEW_NOTIFICATION_EVENT).toBe("project.video_review.notification");
    expect([...VIDEO_REVIEW_NOTIFICATION_TYPES]).toEqual(["video_version_uploaded", "video_note", "video_reply", "video_decision"]);
    for (const type of VIDEO_REVIEW_NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TYPES).toContain(type);
      expect(NOTIFICATION_WORKSPACE_TAB[type]).toBe("video");
      expect(EXTERNAL_LEGACY_NOTIFICATION_POLICY[type]).toEqual({ decision: "allowed", durableEvent: VIDEO_REVIEW_NOTIFICATION_EVENT });
      expect(NOTIFICATION_ENRICHMENT[type]).toMatchObject({ actor: "none", subject: [], asset: false, title: "unchanged", body: "unchanged" });
      expect(externalNotificationChannels(type)).toEqual(["in_app", "email"]);
      expect(externalNotificationCopy({ type })).not.toBeNull();
    }
  });

  it("builds the source keys the plan names", () => {
    expect(videoReviewNotificationSourceKey("video_version_uploaded", ID)).toBe(`video_version:${ID}`);
    expect(videoReviewNotificationSourceKey("video_note", ID)).toBe(`video_note:${ID}`);
    expect(videoReviewNotificationSourceKey("video_reply", ID)).toBe(`video_reply:${ID}`);
    expect(videoReviewNotificationSourceKey("video_decision", ID)).toBe(`video_decision:${ID}`);
  });

  it("parses the strict payload and refuses anything else", () => {
    expect(parseVideoReviewNotificationPayload(payload())).toEqual(payload());
    expect(parseVideoReviewNotificationPayload({ ...payload(), authorizationAtOccurrence: { kind: "admin" } })).not.toBeNull();
    expect(parseVideoReviewNotificationPayload({ ...payload(), extra: 1 })).toBeNull();
    expect(parseVideoReviewNotificationPayload({ ...payload(), video: { ...payload().video, body: "note text" } })).toBeNull();
    expect(parseVideoReviewNotificationPayload(payload("video_nope"))).toBeNull();
    expect(parseVideoReviewNotificationPayload({ ...payload(), schemaVersion: 2 })).toBeNull();
    expect(parseVideoReviewNotificationPayload({ ...payload(), event: { ...payload().event, type: "project.comment.mentioned" } })).toBeNull();
    expect(parseVideoReviewNotificationPayload("{}")).toBeNull();
    expect(parseVideoReviewNotificationPayload(null)).toBeNull();
  });
});
