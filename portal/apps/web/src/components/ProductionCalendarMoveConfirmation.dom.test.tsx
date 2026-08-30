import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductionCalendarMoveConfirmation } from "./ProductionCalendarMoveConfirmation";

describe("ProductionCalendarMoveConfirmation", () => {
  it("shows the civil move and each reminder consequence label", () => {
    const view = ProductionCalendarMoveConfirmation({
      street: "12 Harbour Street",
      oldCivil: "2026-08-10T09:30",
      newCivil: "2026-08-20T09:30",
      consequences: [
        { offsetMinutes: 1440, label: "future", oldFireAt: "old", newFireAt: "new", oldLocalCivil: "2026-08-09T09:30", newLocalCivil: "2026-08-19T09:30" },
        { offsetMinutes: 120, label: "elapsed_at_save", oldFireAt: "old-2", newFireAt: "new-2", oldLocalCivil: "2026-08-10T07:30", newLocalCivil: "2026-08-20T07:30" },
        { offsetMinutes: 60, label: "shifted_wall_clock_hour", oldFireAt: "old-3", newFireAt: "new-3", oldLocalCivil: "2026-04-05T09:00", newLocalCivil: "2026-10-04T08:00" },
      ],
    });
    expect(view.props.children).toBeDefined();
    const text = renderToStaticMarkup(view);
    expect(text).toContain("12 Harbour Street");
    expect(text).toContain("1 day before");
    expect(text).toContain("will have already passed when saved");
    expect(text).toContain("fires an hour earlier/later (daylight-saving)");
  });

  it("renders empty reminder copy", () => {
    const view = ProductionCalendarMoveConfirmation({ street: "12 Harbour Street", oldCivil: "2026-08-10T09:30", newCivil: "2026-08-20T09:30", consequences: [] });
    expect(renderToStaticMarkup(view)).toContain("No reminders are set.");
  });
});
