# TB5C Slice 5 — real-browser DST/flavor proof (carried from Slice 3)

Date: 2026-08-30. Environment: in-app Chromium, dev server (`vite serve`), **browser
`Intl` timeZone = `Asia/Kuala_Lumpur`** (UTC+8, **no DST**) — a genuine non-Sydney zone,
confirmed live (`Intl.DateTimeFormat().resolvedOptions().timeZone` +
`getTimezoneOffset() === -480`). Ran against the dev-only harness
(`/__fc-harness`, `apps/web/src/dev/production-calendar-harness.tsx`) before it was removed.

The `vite serve` circular-import blocker was fixed first (`f6af664`, merged to `main`, TB5C
rebased). One further dev-only fix was needed to render the harness: the harness middleware
now runs its HTML through `server.transformIndexHtml` so the `@vitejs/plugin-react` refresh
preamble is injected (without it a React component module throws "can't detect preamble").
That middleware + harness were then deleted at slice close; `vite.config.ts` is back to its
pre-Slice-3 form.

## FullCalendar v7 `timeZone="Australia/Sydney"` in a non-Sydney browser

**April 2026 fold** (DST ends 05 Apr; 02:00–02:59 occurs twice). Two events one hour apart in
UTC, both landing on the repeated 02:30 wall-clock:

| event | instant (UTC) | rendered (Month / Week / List) |
| --- | --- | --- |
| Fold · 02:30 AEDT | `2026-04-04T15:30Z` | 02:30 on Sun 05 Apr |
| Fold · 02:30 AEST | `2026-04-04T16:30Z` | 02:30 on Sun 05 Apr |
| Fold · all day | `2026-04-05` | all-day row on Sun 05 Apr (date unchanged) |

**October 2026 gap** (DST starts 04 Oct; 02:00–02:59 does not exist):

| event | instant (UTC) | rendered |
| --- | --- | --- |
| Gap · 01:30 AEST | `2026-10-03T15:30Z` | 01:30–03:00 on Sun 04 Oct (30-min event drawn through the missing hour) |
| Gap · 03:30 AEDT | `2026-10-03T16:30Z` | 03:30 on Sun 04 Oct |
| Gap · all day | `2026-10-04` | all-day row on Sun 04 Oct |

Nothing is drawn in the 02:00–03:00 band on 04 Oct. All 24 Week hour labels are Sydney hours
(midnight-anchored: 12am, 1am, …). Conclusion: **v7 honours the named zone with no plugin and
no dependence on the browser zone** — matches the plan's revised research.

## Callback adapter round-trip (`fullCalendarCallbackToSydneyCivil`)

Exercised in the live `Asia/Kuala_Lumpur` browser with the exact `{ allDay, date: Date, dateStr }`
shapes FullCalendar hands `eventDrop`/`eventResize`/`drop`/`dateClick`:

| input instant | adapter `localCivil` | adapter `utcOffsetMinutes` |
| --- | --- | --- |
| `2026-04-04T15:30Z` (fold, earlier) | `2026-04-05T02:30` | **660** (AEDT) |
| `2026-04-04T16:30Z` (fold, later) | `2026-04-05T02:30` | **600** (AEST) |
| `2026-10-03T15:30Z` (gap, before) | `2026-10-04T01:30` | **600** |
| `2026-10-03T16:30Z` (gap, after) | `2026-10-04T03:30` | **660** |
| all-day `2026-04-05` | `2026-04-05` | — |
| all-day `2026-10-04` | `2026-10-04` | — |

Both fold occurrences resolve to the same civil minute with distinct offsets — the adapter
disambiguates the repeated local time by matching the callback instant. Browser zone had zero
influence (adapter uses only `@quincy/shared` civil helpers; no `Temporal`, no `Date#get*`, no
browser-zone `Intl`). This is consistent with the Slice-3 shared-suite equivalence test.

## Flavor

The scoped `.production-calendar` overrides map FullCalendar's Pulse theme onto Quincy brand
tokens; verified live: wrapper background `rgb(250,248,242)` (Warm Paper), text/border
`rgb(10,10,10)` (Ink), font `Apfel Grotezk`. The monochrome result is the intended Quincy
look — **no flavor re-point needed**. Screenshots were taken at 1440×900 / 1024×768 / 390×844
(Month, Week, List) as transient visual evidence; deeper event-chip / spacing polish is Slice 10.

## Production build unchanged by the harness

The harness plugin was `apply: "serve"` — absent from every production build. After removal,
`npm run build -w @quincy/web`:

- `index-*.js` **1,232.39 kB / 366.83 kB gzip** — the Slice-3 baseline (~1,223 kB); the small
  delta is Slice 5's Dashboard/App wiring + the shared window function.
- `ProductionCalendar-*.js` **274.79 kB / 77.41 kB gzip** — a **lazy route chunk**
  (`React.lazy` in `Dashboard.tsx`), loaded only when a capability-holding principal opens the
  Calendar view — never on the sign-in screen or a Photographer dashboard.
- `ProductionCalendar-*.css` **22.06 kB / 4.94 kB gzip** — the FullCalendar/Pulse CSS, also
  split out (main CSS dropped 149.63 → 127.64 kB).
