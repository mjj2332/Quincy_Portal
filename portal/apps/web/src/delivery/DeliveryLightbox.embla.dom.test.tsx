import { afterEach, describe, expect, it, vi } from "vitest";
import { byLabel, byTestId, click, flush, photo, page, press, render, until, type Mounted } from "../testing/delivery-fixtures";
import { DeliveryPage } from "./DeliveryPage";

// Real embla, no fake: happy-dom has no layout, so this only proves the vendored carousel mounts, reports no error and does not fight the page's own index.
vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));
let mounted: Mounted | null = null;
afterEach(async () => { await mounted?.unmount(); mounted = null; document.body.innerHTML = ""; });

describe("the lightbox with the real carousel", () => {
  it("mounts, steps with the arrow keys and closes without an error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mounted = await render(<DeliveryPage dto={page([photo(1), photo(2), photo(3)])} hrefs={null} onRequestUnlock={() => undefined} unlockState={{}} />);
    await click(byLabel("Open Photo 01"));
    await until(() => byTestId("delivery-lightbox"));
    expect(byTestId("delivery-lightbox")!.querySelector('[aria-roledescription="carousel"]')).not.toBeNull();
    expect(byTestId("delivery-lightbox")!.querySelectorAll('[aria-roledescription="slide"]')).toHaveLength(3);
    await press("ArrowRight", byTestId("delivery-lightbox")!);
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 2 of 3");
    await click(byLabel("Next photo"));
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 3 of 3");
    await click(byLabel("Close")); await flush(8);
    expect(byTestId("delivery-lightbox")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
