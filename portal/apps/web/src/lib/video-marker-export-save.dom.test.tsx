import { describe, expect, it, vi } from "vitest";
import { saveBlob } from "./video-marker-export";
import "../testing/dom-polyfills";

describe("saveBlob", () => {
  it("clicks a temporary download anchor, removes it, and revokes the URL", async () => {
    const create = vi.fn(() => "blob:fake"); const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked = this; expect(document.body.contains(this)).toBe(true); });
    saveBlob(new Blob(["x"]), "a.edl", 0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(clicked!.download).toBe("a.edl"); expect(clicked!.getAttribute("href")).toBe("blob:fake");
    expect(document.body.contains(clicked!)).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });
});

