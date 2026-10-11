import { describe, expect, it } from "vitest";
import { lockedSql } from "../../app/src/lib/delivery-lock";
import { deliveryLockedSql } from "../src/delivery-lock-sql";

/** The background Worker's copy of `lockedSql` (#787 slice 8) is the app Worker's, character for character, for any alias. */
describe("deliveryLockedSql", () => {
  it("is the app Worker's lockedSql for every alias", () => {
    for (const alias of ["a", "da", "item"]) expect(deliveryLockedSql(alias)).toBe(lockedSql(alias));
  });
});
