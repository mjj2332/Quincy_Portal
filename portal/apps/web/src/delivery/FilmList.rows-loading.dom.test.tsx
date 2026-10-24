import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorageShim } from "../testing/local-storage";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { DELIVERY_VIDEO_LAYOUT_KEY } from "../lib/video-layout-pref";
import { byTestId, film, render, type Mounted } from "../testing/delivery-fixtures";
import { FilmList } from "./FilmList";

/** #933 fix round 1: while the Video rows chunk is on its way, its skeleton is announced (a status region with its words), as the guest list's is. The chunk never arrives here. */
vi.mock("../components/quincy/VideoRows", () => new Promise(() => {}));

let mounted: Mounted | null = null;
let shim: ReturnType<typeof installLocalStorageShim>;
beforeEach(() => {
  shim = installLocalStorageShim(); resetUiPrefMemory();
  shim.values.set(DELIVERY_VIDEO_LAYOUT_KEY, JSON.stringify("rows"));
});
afterEach(async () => { await mounted?.unmount(); mounted = null; resetUiPrefMemory(); shim.restore(); });

describe("the Delivery Video rows while their chunk loads", () => {
  it("shows a skeleton that says it is loading the film list", async () => {
    mounted = await render(<FilmList items={[film(1), film(2)]} hrefs={null} unlock={{}} onRequestUnlock={() => {}} />);
    const loading = byTestId("delivery-film-rows-loading")!;
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.textContent).toBe("Loading the film list");
  });
});
