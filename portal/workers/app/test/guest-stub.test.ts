import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedFixture } from "./embedded-media-support";
import { clearGuestRows, guestFetch, HYGIENE, linkPath, openGuestGate, seedGuestLink } from "./guest-support";
import { clearVideoFlags } from "./video-review-support";

/** Every `/d` miss is one response (#741 12a, §5): the `/d/*` fallback, a closed gate, an unknown link and a bad credential cannot be told apart. */
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await clearVideoFlags(); });

const snapshot = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "server-timing").sort() });

describe("the /d stub", () => {
  it("is byte-identical for the fallback, /d/review, the session door and every unknown /d/api path, with the hygiene headers on all of them", async () => {
    const reference = await snapshot(await guestFetch("/d"));
    expect(reference.status).toBe(404);
    for (const [name, value] of Object.entries(HYGIENE)) expect(Object.fromEntries(reference.headers)[name], name).toBe(value);
    const unknown = crypto.randomUUID();
    const probes: Array<[string, Parameters<typeof guestFetch>[1]?]> = [
      ["/d/"], ["/d/review"], [`/d/review?link=${unknown}`], ["/d/api/session"], ["/d/api/x"], ["/d/api"], [linkPath(unknown, "/session")], [linkPath(unknown, "/videos")],
      [linkPath(unknown, "/session"), { method: "POST", body: { token: "A".repeat(43) } }], [linkPath(unknown, "/session"), { method: "DELETE" }], [`/d/api/links/${unknown}`], ["/d/api/links/not-a-uuid/session"],
      [`/d/api/links/${unknown}/versions/${unknown}/stream`], [`/d/api/links/${unknown}/notes/${unknown}/markup`], ["/d/something/else"],
    ];
    for (const [path, init] of probes) expect(await snapshot(await guestFetch(path, init)), path).toEqual(reference);
  });

  it("stays the same with the gate wholly closed, even for a real link", async () => {
    const link = await seedGuestLink(); const reference = await snapshot(await guestFetch("/d"));
    await clearVideoFlags();
    for (const [path, init] of [[`/d/review?link=${link.id}`], [linkPath(link.id, "/session")], [linkPath(link.id, "/session"), { method: "POST", body: { token: link.token } }]] as Array<[string, Parameters<typeof guestFetch>[1]?]>) {
      expect(await snapshot(await guestFetch(path, init)), path).toEqual(reference);
    }
  });

  it("does not answer an unsafe method on a read route, and does not route /d/api/links/:id/session to anything but the stub on other methods", async () => {
    const link = await seedGuestLink(); const reference = await snapshot(await guestFetch("/d"));
    expect(await snapshot(await guestFetch(linkPath(link.id, "/videos"), { method: "POST", body: {} }))).toEqual(reference);
    expect(await snapshot(await guestFetch(linkPath(link.id, "/session"), { method: "PUT", body: {} }))).toEqual(reference);
  });
});
