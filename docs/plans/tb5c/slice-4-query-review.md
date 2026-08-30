# TB5C Slice 4 query review

Date: 2026-08-30 (revised after the Sol REVISE round — B1/B2/B3 fixes)

The calendar handler issues **exactly two** parameterized D1 statements:

1. `productionCalendarRangeSql(role)` — returns every bounded checklist candidate row (with all
   schedule columns), the bounded project-deadline event rows, and the bounded unscheduled
   project rows, each carrying the shared `density.scheduled_total`. If that coarse upper-bound
   count exceeds `PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS` (10,000) the outer query returns a
   single `density` sentinel row and nothing else.
2. `productionCalendarFacetsSql(role)` — executed **only** when statement 1 did not return the
   sentinel. Returns the request-bounded project/person facets and the `my_tasks` echo.

There is no project loop and no access-helper read. Authoritative five-state schedule
classification (`serializeChecklistSchedule`) and the 50/50 unscheduled truncation happen in
the handler, not in SQL — see B1 below.

## Blocking fixes applied

- **B1 — schedule-shape authority moved to the handler.** SQL no longer decides `invalid` vs
  `legacy_unresolved` vs the three valid states. `candidate_subtasks_unfiltered` returns every
  visible checklist row; `responseFromRows` calls `serializeChecklistSchedule` on each and
  routes it: valid + intersecting → event; `unscheduled` → Unscheduled entry;
  `legacy_unresolved` / `invalid` → `schedule_needs_attention` Unscheduled entry (never
  dropped). Coarse SQL predicates (`coarse_shape`, `range_candidate_subtasks`,
  `scheduled_checklist_candidates`) are used **only** as a conservative superset for the
  people/facet universe and the density upper bound — over-inclusion there is safe, under-
  inclusion of a repair row is impossible because those rows always reach statement 1.
  All `GLOB '[0-9]…'` digit-class shape checks were replaced with `length() = 10 | 16`
  tests: workerd's SQLite rejects a 12-bracket GLOB pattern with
  `LIKE or GLOB pattern too complex` (an 8-bracket pattern passes; the limit is between 8 and
  12), so the digit-class approach was not viable regardless.
- **B2 — no Editor-ID oracle.** `authorized_people_base` is derived from the fully
  request-bounded universe (visible-project scope, archived/delivered, Stage, search, range
  intersection, completion, overdue) but **before** the `editors=` / `mine=1` selection.
  `valid_selected_editors` = requested ∩ that universe. A real-but-out-of-scope ID and a
  fabricated ID are now indistinguishable: both fall out of the universe, so both are dropped
  from `appliedFilters` and neither narrows the result. Partial lists keep their valid subset.
- **B3 — layer filters no longer cross contaminate.** The authorized project base is not
  filtered by `editors=` or `mine=1`. `project_filtered_candidates` applies editor **membership**
  to the project-event / unscheduled-project branches only; `checklist_filtered_candidates`
  applies assignee **identity** (and `mine=1 → assignee_id = me`) to the checklist branches
  only. A checklist assigned to the selected person is returned even when that person is not an
  editor member of its project.

## Local `EXPLAIN QUERY PLAN` (workerd SQLite, full migration schema)

Statement 1 (`productionCalendarRangeSql("admin")`, all 17 params bound):

```text
CO-ROUTINE candidate_rows
  MATERIALIZE request / selected_editor_state            (SCAN CONSTANT ROW)
  json_each VIRTUAL TABLE INDEX 1                         (editors, stages — one each)
  MATERIALIZE authorized_candidate_projects
    SEARCH p USING INDEX projects_archived_idx (archived_at=?)
    SEARCH agencies USING INDEX sqlite_autoindex_agencies_1 (id=?) LEFT-JOIN
    SEARCH agents   USING INDEX sqlite_autoindex_agents_1 (id=?) LEFT-JOIN
    UNION USING TEMP B-TREE
  MATERIALIZE checklist_counts
    SEARCH subtasks USING INDEX project_subtasks_project_position_idx (project_id=?)
    USE TEMP B-TREE FOR GROUP BY
  MATERIALIZE authorized_people_base                      (project_members + user by PK)
```

Facets statement mirrors the same bounded joins and adds one `UNION USING TEMP B-TREE`.
There is no direct index on `deadline_at`, `schedule_end_at`, or `due_date`; those predicates
are evaluated after the bounded project/subtask joins, by design. No `IN (?, …)` fan-out —
Editor and Stage lists are a single `json_each` expansion each.

## Measured behaviour (workerd Workers pool, `SELF.fetch`, full migration schema)

A single dense project seeded with valid in-range timed `due_only` checklist rows
(`schedule_version = 1`, resolved instant matching the civil string), Month range
`2026-08-24 … 2026-09-05`, admin principal:

| scheduled events | HTTP | wall (incl. fetch/serialize) | response bytes |
| ---: | ---: | ---: | ---: |
| 1,601  | 200 | ~85 ms  | 1,284,266 (~1.22 MiB) |
| 7,701  | 200 | ~259 ms | 6,176,466 (~5.89 MiB) |
| 10,001 | 422 | ~16 ms  | 213 |

Wall time is `performance.now()` around `SELF.fetch` on the dev machine, so it includes
router, auth-cookie verification, JSON serialization, and Zod strict-parse — actual Worker CPU
is a fraction of it. The 10,001 case short-circuits: the outer `SELECT … WHERE scheduled_total
<= 10000` yields no rows and only the `density` sentinel is returned, so statement 2 never
runs and no row is serialized.

## Ceiling decision

**The 10,000 ceiling is retained.** Evidence: the refusal path is cheap and constant
(~16 ms / 213 B), and even a near-ceiling success (7,701 events → ~5.9 MiB / ~260 ms wall)
still completes and deserializes. The ceiling exists precisely to force the user to narrow a
range/Stage/Editor/layer/search filter before payloads reach that size; the measurements show
it triggers well before anything approaching a Worker resource limit, and lowering it further
was already considered and rejected at Opus plan-tier review. No plan delta.
