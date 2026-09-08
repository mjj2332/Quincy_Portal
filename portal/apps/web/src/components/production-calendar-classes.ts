/**
 * Class tokens shared by the calendar chrome components after the #61 re-skin. Several tokens
 * were byte-identical (or near-identical) across ProductionCalendarEvent.tsx,
 * ProductionCalendarUnscheduledPanel.tsx, ProductionCalendarToolbar.tsx,
 * ProductionCalendarFilters.tsx, ProductionCalendar.tsx, ProductionCalendarMoveDialog.tsx,
 * ProductionCalendarScheduleEditor.tsx and screens/Dashboard.tsx. This module keeps one copy so a
 * metric change does not have to be made in several places at once.
 */

export const CAL_PILL =
  "max-w-full px-[6px] py-[2px] [font:600_9px/1.2_var(--font-sans)] tracking-[.05em] uppercase";

export const CARD_META =
  "flex items-center justify-between gap-[8px] min-w-0 text-muted-foreground text-[10px] tracking-[.08em] uppercase";

export const CARD_HEADING =
  "mt-[3px] mb-0 overflow-hidden text-ellipsis whitespace-nowrap [font:600_13px/1.25_var(--font-sans)]";

export const CARD_SUBTITLE =
  "mt-[3px] mb-0 overflow-hidden text-ellipsis whitespace-nowrap text-foreground-secondary text-[11px]";

// Shared remainder of the "needs attention" note. Call sites differ in the top margin (event
// cards use `mt-[8px]`, the unscheduled panel uses `mt-[3px]`) and the panel site also adds
// `whitespace-normal` — both are appended locally through `cn(...)` rather than baked in here.
export const CARD_ATTENTION = "mb-0 text-signal-critical [font:400_11px/1.35_var(--font-sans)]";

// Shared remainder of the card's inline text-button action (Move/Reschedule, Schedule, etc.) plus
// its coarse-block padding/44px floor. `buttonClasses("text")` already carries
// `max-[721px]:min-h-[44px]` and `px-0`. Call sites differ only in the top margin (event cards use
// `mt-[8px]`, the unscheduled panel uses `mt-[9px]`) — appended locally through `cn(...)`.
export const CARD_ACTION =
  "p-0 text-[11px] " +
  "pointer-coarse:min-w-[44px] pointer-coarse:min-h-[44px] pointer-coarse:px-[4px] pointer-coarse:py-[8px] " +
  "max-[721px]:min-w-[44px] max-[721px]:px-[4px] max-[721px]:py-[8px]";

export const COARSE_TAP_TARGET =
  "pointer-coarse:min-w-[44px] pointer-coarse:min-h-[44px] max-[721px]:min-w-[44px]";

export const CALENDAR_STATE_BOX = "min-h-[180px] grid place-content-center gap-[4px]";

// FIELD_BOX (shared by NativeSelect / reui/input) already carries the border, radius, field
// background and the `max-[721px]:min-h-[44px]` floor. This is the compact type/padding plus the
// coarse-pointer half of the 44px floor that several calendar dialogs layer on top of it.
export const FIELD_COMPACT =
  "[font:400_13px/1.3_var(--font-sans)] tracking-normal px-[6px] py-[4px] pointer-coarse:min-h-[44px]";
