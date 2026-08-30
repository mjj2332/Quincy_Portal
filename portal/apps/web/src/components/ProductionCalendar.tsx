import { useEffect, useMemo, useState } from "react";
import {
  deriveProductionCalendarWindow,
  formatSydneyCivilMinute,
  STAGE_PRESENTATION_KEYS,
  type CalendarEventDto,
  type DashboardCalendarState,
  type ProductionCalendarFilters,
  type ProductionCalendarSubview,
} from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { productionCalendarFiltersFor, useProductionCalendarRange } from "../lib/production-calendar-query";
import { mapCalendarEventsToFullCalendar } from "../lib/production-calendar-event-input";
import { ProductionCalendarSurface } from "./ProductionCalendarSurface";
import { ProductionCalendarToolbar } from "./ProductionCalendarToolbar";
import { ProductionCalendarEvent } from "./ProductionCalendarEvent";
import { ProductionCalendarFilters as ProductionCalendarFiltersPanel } from "./ProductionCalendarFilters";
import { presentationStages, useStages } from "../lib/stages";
import { useCapabilities } from "../lib/capabilities";

export type ProductionCalendarProps = {
  identity: DashboardIdentity;
  calendar: DashboardCalendarState;
  onNavigate: (next: DashboardCalendarState) => void;
  onAppliedFilters?: (filters: ProductionCalendarFilters) => void;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (!details || typeof details !== "object") return undefined;
  const code = "code" in details ? (details as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function errorRefinement(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = "details" in error ? (error as { details?: unknown }).details : undefined;
  if (!details || typeof details !== "object") return undefined;
  const refinement = "refinement" in details ? (details as { refinement?: unknown }).refinement : undefined;
  return typeof refinement === "string" ? refinement : undefined;
}

function sameFilters(left: ProductionCalendarFilters, right: ProductionCalendarFilters): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventCivilDate(event: CalendarEventDto): string {
  return event.timing.allDay ? event.timing.start : formatSydneyCivilMinute(event.timing.start).slice(0, 10);
}

function viewForSubview(subview: ProductionCalendarSubview): "dayGridMonth" | "timeGridWeek" | "list" {
  if (subview === "month") return "dayGridMonth";
  if (subview === "week") return "timeGridWeek";
  return "list";
}

/**
 * The read-only Calendar screen. FullCalendar receives already-mapped events;
 * all range identity comes from the shared civil window, never datesSet.
 */
export function ProductionCalendar({ identity, calendar, onNavigate, onAppliedFilters }: ProductionCalendarProps) {
  const range = useMemo(() => deriveProductionCalendarWindow(calendar.date, calendar.subview), [calendar.date, calendar.subview]);
  const query = useProductionCalendarRange({ identity, calendar, enabled: true });
  const { stages } = useStages();
  const { can } = useCapabilities();
  const canAdminBackend = can("adminBackend");
  const stageOptions = useMemo(() => {
    const presented = presentationStages(stages, canAdminBackend);
    return STAGE_PRESENTATION_KEYS.flatMap((key) => {
      const stage = presented.find((candidate) => candidate.key === key)
        ?? (key === "editing" && canAdminBackend ? presented.find((candidate) => candidate.key === "editing_autohdr") : undefined);
      return stage && stage.active ? [{ key, label: stage.label }] : [];
    });
  }, [canAdminBackend, stages]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const mappedEvents = useMemo(() => mapCalendarEventsToFullCalendar(query.data?.events ?? []), [query.data?.events]);

  useEffect(() => {
    setSelectedDay(null);
  }, [calendar.date, calendar.subview]);

  useEffect(() => {
    if (!query.data) setSelectedDay(null);
  }, [query.data]);

  useEffect(() => {
    const applied = query.data?.range.appliedFilters;
    if (!applied || sameFilters(applied, productionCalendarFiltersFor(calendar))) return;
    onAppliedFilters?.(applied);
  }, [calendar, onAppliedFilters, query.data?.range.appliedFilters]);

  const selectedEvents = selectedDay === null
    ? []
    : (query.data?.events ?? []).filter((event) => eventCivilDate(event) === selectedDay);
  const dense = errorCode(query.error) === "calendar_range_too_dense";
  const refinement = errorRefinement(query.error) ?? "Refine the date range, Stage, Editor, layer, or search filters.";

  return (
    <section className="qc-calendar-screen" aria-label="Production Calendar">
      <ProductionCalendarToolbar calendar={calendar} range={range} onNavigate={onNavigate} />
      <ProductionCalendarFiltersPanel
        filters={productionCalendarFiltersFor(calendar)}
        facetPeople={query.data?.filterFacets.people ?? []}
        stages={stageOptions}
        disabled={query.isPending && !query.data}
        onChange={(next) => onNavigate({ ...calendar, ...next, view: "calendar" })}
      />

      {query.isPending && !query.data && <div className="empty qc-calendar-state" role="status">Loading calendar…</div>}

      {!query.isPending && query.error && !query.data && (
        <div className="empty qc-calendar-state" role="alert">
          <span className="serif">Calendar unavailable.</span>
          {dense ? <><p>That range is too dense — narrow the filters.</p><p>{refinement}</p></> : <p>Calendar could not be loaded. Try again.</p>}
          {!dense && <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void query.refetch()}>Try again</button></div>}
        </div>
      )}

      {query.data && query.data.events.length === 0 && <div className="empty qc-calendar-state" role="status">No scheduled work in this range.</div>}

      {query.data && query.data.events.length > 0 && (
        <>
          <ProductionCalendarSurface
            key={`${calendar.subview}:${calendar.date}`}
            initialView={viewForSubview(calendar.subview)}
            initialDate={calendar.date}
            visibleRange={range}
            headerToolbar={false}
            events={mappedEvents}
            editable={false}
            eventStartEditable={false}
            eventDurationEditable={false}
            droppable={false}
            selectable={false}
            weekends
            firstDay={1}
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
            expandRows={calendar.subview === "week"}
            // Agenda uses FullCalendar's list view with an explicit fourteen-day
            // duration, while visibleRange remains the shared Quincy window.
            views={{ list: { type: "list", duration: { days: 14 } } }}
            dateClick={(info) => {
              if (calendar.subview === "month" && info.allDay) setSelectedDay(info.dateStr);
            }}
            eventContent={(info) => <ProductionCalendarEvent event={info.event.extendedProps.dto} subview={calendar.subview} />}
          />

          {calendar.subview === "month" && selectedDay !== null && (
            <section className="qc-calendar-disclosure" aria-label="Selected day">
              <div className="ey">Selected day · {selectedDay}</div>
              {selectedEvents.length === 0 ? <p className="muted">No scheduled work on this day.</p> : <div className="qc-calendar-disclosure__events">{selectedEvents.map((event) => <ProductionCalendarEvent key={event.id} event={event} subview={calendar.subview} compact />)}</div>}
            </section>
          )}
        </>
      )}
    </section>
  );
}
