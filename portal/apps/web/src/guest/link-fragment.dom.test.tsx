import { afterEach, describe, expect, it, vi } from "vitest";
import { reopenWithToken, takeLinkToken } from "./link-fragment";

const LINK = "0b9e0c4e-6a3f-4b1e-9a51-1f5c2f0b7d10";

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("reopenWithToken: the chunk-failure Reload", () => {
  it("puts ?link=<id>#t=<token> back without a history entry, then reloads the document", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=a%20b`);
    expect(takeLinkToken()).toBe("a b");
    expect(window.location.hash).toBe("");
    const length = window.history.length;
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    reopenWithToken("a b");
    expect(window.location.pathname + window.location.search).toBe(`/d/review?link=${LINK}`);
    expect(window.location.hash).toBe("#t=a%20b");
    expect(window.history.length).toBe(length);
    // A fragment-only change is a same-document navigation: without an explicit reload nothing reloads.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(takeLinkToken()).toBe("a b");
  });

  it("with no token, only reloads", () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}`);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    reopenWithToken(null);
    expect(window.location.hash).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
