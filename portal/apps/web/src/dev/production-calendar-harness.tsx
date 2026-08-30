import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FullCalendar, { type CalendarRef, type EventApi } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import listPlugin from "@fullcalendar/react/list";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import { PRODUCTION_CALENDAR_ZONE } from "@quincy/shared";
import { fullCalendarCallbackToSydneyCivil } from "../lib/production-calendar-fullcalendar";
import "../styles/production-calendar.css";

if (!import.meta.env.DEV) throw new Error("The production-calendar harness is dev-only.");

const plugins = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];
const events = [
  { id: "fold-earlier", title: "Fold · 02:30 AEDT", start: "2026-04-04T15:30:00Z", end: "2026-04-04T16:00:00Z" },
  { id: "fold-later", title: "Fold · 02:30 AEST", start: "2026-04-04T16:30:00Z", end: "2026-04-04T17:00:00Z" },
  { id: "fold-all-day", title: "Fold · all day", start: "2026-04-05", allDay: true },
  { id: "gap-before", title: "Gap · 01:30 AEST", start: "2026-10-03T15:30:00Z", end: "2026-10-03T16:00:00Z" },
  { id: "gap-after", title: "Gap · 03:30 AEDT", start: "2026-10-03T16:30:00Z", end: "2026-10-03T17:00:00Z" },
  { id: "gap-all-day", title: "Gap · all day", start: "2026-10-04", allDay: true },
];

function logCallback(callbackType: string, event: Pick<EventApi, "allDay" | "start" | "startStr">) {
  const adapterOutput = event.start
    ? fullCalendarCallbackToSydneyCivil({ allDay: event.allDay, date: event.start, dateStr: event.startStr })
    : null;
  console.info({
    callbackType,
    "event.startStr": event.startStr,
    "event.start?.toISOString()": event.start?.toISOString(),
    adapterOutput,
  });
}

function Harness() {
  const calendarRef = useRef<CalendarRef>(null);
  const [view, setView] = useState<"dayGridMonth" | "timeGridWeek" | "listWeek">("dayGridMonth");

  function changeView(nextView: "dayGridMonth" | "timeGridWeek" | "listWeek") {
    setView(nextView);
    calendarRef.current?.getApi().changeView(nextView);
  }

  return (
    <main style={{ padding: 24 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <strong>TB5C Slice 3 · FullCalendar v7 · Sydney</strong>
        {(["dayGridMonth", "timeGridWeek", "listWeek"] as const).map((nextView) => (
          <button key={nextView} type="button" aria-pressed={view === nextView} onClick={() => changeView(nextView)}>
            {nextView}
          </button>
        ))}
        <button type="button" onClick={() => calendarRef.current?.getApi().gotoDate("2026-04-05")}>April fold</button>
        <button type="button" onClick={() => calendarRef.current?.getApi().gotoDate("2026-10-04")}>October gap</button>
      </header>
      <div className="production-calendar">
        <FullCalendar
          ref={calendarRef}
          plugins={plugins}
          timeZone={PRODUCTION_CALENDAR_ZONE}
          initialDate="2026-04-05"
          initialView={view}
          headerToolbar={false}
          events={events}
          allDaySlot
          slotMinTime="00:00"
          slotMaxTime="24:00"
          firstDay={1}
          height="auto"
          eventDrop={(info) => logCallback("eventDrop", info.event)}
          eventResize={(info) => logCallback("eventResize", info.event)}
          dateClick={(info) => logCallback("dateClick", { allDay: info.allDay, start: info.date, startStr: info.dateStr })}
        />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The production-calendar harness could not find #root.");
createRoot(root).render(<StrictMode><Harness /></StrictMode>);
