import { afterEach, describe, expect, it, vi } from "vitest";
import { reopenWithToken, takeLinkToken } from "./link-fragment";

const LINK = "0b9e0c4e-6a3f-4b1e-9a51-1f5c2f0b7d10";
const FILM = "11111111-1111-4111-8111-000000000001";

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("reopenWithToken: the chunk-failure Reload", () => {
  it("puts ?link=<id>#t=<token> back without a history entry, then reloads the document", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=a%20b`);
    expect(takeLinkToken().token).toBe("a b");
    expect(window.location.hash).toBe("");
    const length = window.history.length;
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    reopenWithToken("a b", null);
    expect(window.location.pathname + window.location.search).toBe(`/d/review?link=${LINK}`);
    expect(window.location.hash).toBe("#t=a%20b");
    expect(window.history.length).toBe(length);
    // A fragment-only change is a same-document navigation: without an explicit reload nothing reloads.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(takeLinkToken().token).toBe("a b");
  });

  it("with no token, only reloads", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}`);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    reopenWithToken(null, null);
    expect(window.location.hash).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("the film in the fragment (#847)", () => {
  it("returns the token and a UUID film id from #t=...&v=..., and scrubs the whole fragment", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=abc&v=${FILM}`);
    expect(takeLinkToken()).toEqual({ token: "abc", videoId: FILM });
    expect(window.location.hash).toBe("");
  });

  it("ignores a v that is not a UUID", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=abc&v=not-a-uuid`);
    expect(takeLinkToken()).toEqual({ token: "abc", videoId: null });
  });

  it("an ordinary link has no film", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=abc`);
    expect(takeLinkToken()).toEqual({ token: "abc", videoId: null });
    window.history.replaceState(null, "", `/d/review?link=${LINK}`);
    expect(takeLinkToken()).toEqual({ token: null, videoId: null });
  });

  it("Reload restores v along with the token", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}`);
    vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    reopenWithToken("abc", FILM);
    expect(window.location.hash).toBe(`#t=abc&v=${FILM}`);
  });
});
