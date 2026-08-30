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

export type ProductionCalendarProps = Omit<CalendarOptions, "plugins" | "timeZone">;

/**
 * The production seam for Standard FullCalendar views. Product UI owns the toolbar and
 * event presentation in later slices; this wrapper owns only the plugin, zone, and CSS
 * boundary so no route accidentally adopts a different calendar configuration.
 */
export function ProductionCalendar(props: ProductionCalendarProps) {
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
