import FullCalendar, { type CalendarOptions, type PluginInput } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import listPlugin from "@fullcalendar/react/list";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import { PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";
import { SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT } from "../lib/production-calendar-interaction";
import "../styles/production-calendar.css";

export const PRODUCTION_CALENDAR_PLUGINS: PluginInput[] = [
  dayGridPlugin,
  timeGridPlugin,
  listPlugin,
  interactionPlugin,
];

export type ProductionCalendarSurfaceProps = Omit<CalendarOptions, "plugins" | "timeZone"> & {
  reducedMotion?: boolean;
};

/** Keep FullCalendar's drag mirror out of the accessibility tree. */
export function applyProductionCalendarEventMirrorA11y(info: { el: HTMLElement; isMirror: boolean }): void {
  if (!info.isMirror) return;
  info.el.setAttribute("aria-hidden", "true");
  info.el.setAttribute("inert", "");
  info.el.tabIndex = -1;
  info.el.querySelectorAll<HTMLElement>("button, a, input, select, textarea, [tabindex]").forEach((element) => {
    element.tabIndex = -1;
  });
}

/**
 * The FullCalendar boundary. It owns the plugin set, Sydney display zone, and
 * Quincy stylesheet; the screen container owns route/query state and mutation
 * callbacks while this boundary remains a thin FullCalendar adapter.
 */
export function ProductionCalendarSurface({ reducedMotion = false, ...props }: ProductionCalendarSurfaceProps) {
  const eventDidMount = props.eventDidMount;
  const eventWillUnmount = props.eventWillUnmount;
  return (
    <div
      className="production-calendar"
      data-testid="production-calendar-surface"
      data-reduced-motion={reducedMotion ? "true" : undefined}
      // This remains false until Slice 11's real VoiceOver/NVDA cadence test.
      // If enabled, the scoped CSS seam hides only FullCalendar's own region;
      // Quincy's single polite live region remains the sole settled-result owner.
      data-suppress-fullcalendar-drop-announcement={SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT ? "true" : undefined}
    >
      <FullCalendar
        {...props}
        plugins={PRODUCTION_CALENDAR_PLUGINS}
        timeZone={PRODUCTION_CALENDAR_ZONE}
        eventDidMount={(info) => {
          applyProductionCalendarEventMirrorA11y(info);
          eventDidMount?.(info);
        }}
        eventWillUnmount={(info) => {
          eventWillUnmount?.(info);
        }}
      />
    </div>
  );
}
