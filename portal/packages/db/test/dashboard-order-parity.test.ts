import { describe, expect, it } from "vitest";
import { orderDashboardStreetTies } from "../src/dashboard-order";
import { compareByStreetThenId } from "@quincy/shared";

type DashboardRow = {
  project: { id: string; street: string; shootDate: string | null };
};

describe("dashboard street tie ordering parity", () => {
  it("matches the shared comparator for one contiguous shoot-date tie group", () => {
    const shootDate = "2026-01-01";
    const rows: DashboardRow[] = [
      { project: { id: "z", street: "10 King Street", shootDate } },
      { project: { id: "accent", street: "10 Élan Street", shootDate } },
      { project: { id: "other", street: "2 Apple Street", shootDate } },
      { project: { id: "a", street: "10 King Street", shootDate } },
    ];
    const sharedOrder = [...rows].sort((left, right) => compareByStreetThenId(left.project, right.project)).map((row) => row.project.id);
    const dbOrder = orderDashboardStreetTies(rows).map((row) => row.project.id);
    expect(dbOrder).toEqual(sharedOrder);
  });
});
