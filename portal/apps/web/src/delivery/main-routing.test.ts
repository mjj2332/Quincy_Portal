import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("main.tsx routing", () => {
  const source = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");
  it("chooses the Delivery page third: after the Review and unsubscribe branches, before any staff boot work", () => {
    const review = source.indexOf("isGuestReviewPath(window.location.pathname)");
    const unsubscribe = source.indexOf("isGuestUnsubscribePath(window.location.pathname)");
    const delivery = source.indexOf("isDeliveryPagePath(window.location.pathname)");
    const boot = source.indexOf("captureBootLanding(window.location.pathname)");
    expect(review).toBeGreaterThan(-1);
    expect(unsubscribe).toBeGreaterThan(review);
    expect(delivery).toBeGreaterThan(unsubscribe);
    expect(boot).toBeGreaterThan(delivery);
    expect(source).toContain('import("./delivery/DeliveryApp")');
  });
});
