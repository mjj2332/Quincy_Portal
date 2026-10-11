import { describe, expect, it } from "vitest";
import { PROJECT_ACTIVITY_REGISTRY, PROJECT_ACTIVITY_TYPES, parseProjectActivityIntent, projectActivityDeepLink, renderProjectActivityNotification } from "../src/project-activity";
import { EXTERNAL_PROJECT_ACTIVITY_POLICY } from "../src/external-project-policy";
import { externalNotificationChannels, externalNotificationCopy } from "../src/external-notification";

/** The Delivery Publish activity type (#787 slice 5): internal only, in-app only, email off, never an External's. */
const TYPE = "project.delivery.published" as const;
const project = "11111111-1111-4111-8111-111111111111"; const set = "22222222-2222-4222-8222-222222222222"; const actor = "33333333-3333-4333-8333-333333333333";
const intent = (payload: unknown) => ({ schemaVersion: 1, activity: { id: set, type: TYPE, projectId: project, actorId: actor, actorKind: "user", occurredAt: 1_700_000_000_000, source: { kind: "project_delivery", id: set, key: `project-delivery:${set}:published` }, safePayload: payload, deepLink: projectActivityDeepLink(TYPE, project) }, broadDelivery: { registryKey: TYPE, sourceActivityId: set, coalesce: null } });

describe("project.delivery.published", () => {
  it("is a live type registered as internal, in-app only, email off, deep-linking to the Project", () => {
    expect(PROJECT_ACTIVITY_TYPES).toContain(TYPE);
    expect(PROJECT_ACTIVITY_REGISTRY[TYPE]).toMatchObject({ audience: "internal", channels: ["in_app"], emailDefault: "off", deepLinkKind: "project", cutover: "live", actorRule: "user" });
    expect(projectActivityDeepLink(TYPE, project).kind).toBe("project");
  });
  it("takes exactly { setNumber, itemCount, firstPublish } and one source key per set", () => {
    expect(parseProjectActivityIntent(intent({ setNumber: 2, itemCount: 14, firstPublish: false }))).not.toBeNull();
    for (const bad of [{}, { setNumber: 0, itemCount: 1, firstPublish: true }, { setNumber: 1, itemCount: 1, firstPublish: true, extra: 1 }, { setNumber: 1, itemCount: 1 }]) expect(parseProjectActivityIntent(intent(bad)), JSON.stringify(bad)).toBeNull();
    const wrongKey = intent({ setNumber: 1, itemCount: 1, firstPublish: true }); wrongKey.activity.source.key = `project-delivery:${project}:published`;
    expect(parseProjectActivityIntent(wrongKey)).toBeNull();
  });
  it("is denied to External editors: no policy allowance, no copy, no channel", () => {
    expect(EXTERNAL_PROJECT_ACTIVITY_POLICY[TYPE].decision).toBe("suppressed");
    expect(externalNotificationCopy({ type: TYPE } as never)).toBeNull();
    expect(externalNotificationChannels(TYPE)).toEqual([]);
  });
  it("renders a notification that names no item, address or contact", () => {
    const copy = renderProjectActivityNotification(TYPE, { setNumber: 2, itemCount: 14, firstPublish: false }, "12 Test Street", "Ada");
    expect(copy.title).toMatch(/delivery/i); expect(copy.body).toContain("12 Test Street");
  });
});
