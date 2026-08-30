import FullCalendar, { type CalendarOptions, type PluginInput } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import listPlugin from "@fullcalendar/react/list";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import { PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";
import "../styles/production-calendar.css";

export const PRODUCTION_CALENDAR_PLUGINS: PluginInput[] = [
  dayGridPlugin,
  timeGridPlugin,
  listPlugin,
  interactionPlugin,
];

export type ProductionCalendarSurfaceProps = Omit<CalendarOptions, "plugins" | "timeZone">;

/**
 * The FullCalendar boundary. It owns the plugin set, Sydney display zone, and
 * Quincy stylesheet; the screen container owns route/query state and the
 * read-only event callbacks.
 */
export function ProductionCalendarSurface(props: ProductionCalendarSurfaceProps) {
  return (
    <div className="production-calendar">
      <FullCalendar
        {...props}
        plugins={PRODUCTION_CALENDAR_PLUGINS}
        timeZone={PRODUCTION_CALENDAR_ZONE}
      />
    </div>
  );
}
