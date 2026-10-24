import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorageShim } from "../testing/local-storage";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { DELIVERY_VIDEO_LAYOUT_KEY } from "../lib/video-layout-pref";
import { byTestId, film, flush, render, type Mounted } from "../testing/delivery-fixtures";
import { FilmList } from "./FilmList";

/**
 * #933 fix round 1: when the Video rows chunk cannot load (a deploy replaced it), a client on the Delivery page sees neutral words and Reload, never the staff Portal's "The
 * Portal may have been updated" notice. The module's import fails here as a stale chunk does in a browser.
 */
vi.mock("../components/quincy/VideoRows", () => { throw new TypeError("Failed to fetch dynamically imported module: https://quincy.test/assets/VideoRows-OLD.js"); });

let mounted: Mounted | null = null;
let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  shim = installLocalStorageShim(); resetUiPrefMemory();
  shim.values.set(DELIVERY_VIDEO_LAYOUT_KEY, JSON.stringify("rows"));
});
afterEach(async () => { await mounted?.unmount(); mounted = null; resetUiPrefMemory(); shim.restore(); vi.restoreAllMocks(); });

describe("the Delivery Video rows chunk failing to load", () => {
  it("says the list could not be loaded, with Reload, in words a client can use", async () => {
    mounted = await render(<FilmList items={[film(1), film(2)]} hrefs={null} unlock={{}} onRequestUnlock={() => {}} />);
    for (let i = 0; i < 100 && !byTestId("view-load-error"); i += 1) await flush();
    const notice = byTestId("view-load-error")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("The list could not be loaded.");
    expect(notice.textContent).not.toMatch(/Portal|updated/);
    expect([...notice.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Reload"]);
  });
});
