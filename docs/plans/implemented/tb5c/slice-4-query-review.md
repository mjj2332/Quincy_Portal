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

Wall time is `performance.now()` around `SELF.fetch` on the dev machine — it includes the D1
round trips, router, auth-cookie verification, JSON serialization, and Zod strict-parse. It is
**not** isolated Worker CPU; the Workers test pool does not expose a CPU-time meter, so CPU
headroom against the 30 s limit is not directly measured here. The 10,001 case short-circuits:
the outer `SELECT … WHERE scheduled_total <= 10000` yields no rows and only the `density`
sentinel is returned, so statement 2 never runs and no row is serialized.

Since B1, the guarded count is the **whole** statement-1 candidate load (project events +
project unscheduled + every visible checklist row), not just the in-range scheduled subset —
so the ceiling also bounds the number of rows the handler deserializes and runs
`serializeChecklistSchedule` over, which is the real CPU driver.

## Ceiling decision

**The 10,000 ceiling is retained.** What the measurements establish: (a) the refusal path is
cheap and constant (~16 ms wall / 213 B) and correctly skips statement 2; (b) response payload
at the ceiling is bounded — a near-ceiling success (7,701 events) is ~5.9 MiB, and the JSON
body was produced and re-parsed without error. What they do **not** establish: a precise
Worker-CPU margin. The ceiling is a coarse guard whose job is to force the user to narrow a
range/Stage/Editor/layer/search filter before the view gets pathological; 10,000 was ratified
at Opus plan-tier review and nothing measured here contradicts it. If a production incident
ever shows CPU pressure below this count, lower the constant — it is a single
`PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS` value in `@quincy/shared` with no schema impact. No
plan delta.

## Known limitation: the density guard is corpus-proportional, not range-proportional (Opus final-draft review S1, 2026-08-31)

`checklist_filtered_candidates` (and therefore statement 1 and `density.scheduled_total`)
reads from `candidate_subtasks_unfiltered`, which applies the visible-project scope, Stage,
delivered, completion, overdue and search predicates but **no range predicate** — the range
predicate lives only in `range_candidate_subtasks`, used for the people/facet universe. This is
deliberate (the Slice-4 B1 fix moved authoritative 5-state classification into the handler, so
statement 1 must carry every visible checklist row, including out-of-range and repair rows, for
`serializeChecklistSchedule` to classify).

Consequences, accepted as a known operational limit rather than fixed (owner decision
2026-08-31, "option C"):

- **`density.scheduled_total` counts the whole active-corpus candidate set**, not the in-range
  subset. Once a studio's active unarchived corpus exceeds ~10,000 visible incomplete checklist
  rows (≈500 active projects at ~20 subtasks each), **every** Calendar request returns
  `422 calendar_range_too_dense` for **every** date range until the corpus shrinks or a
  Stage/Editor/search filter narrows it. Narrowing the *date range* alone does not help at that
  point; the refusal copy leads with "narrow the filters" and names Stage/Editor/layer/search,
  which do help.
- **Per-request D1→Worker row load is corpus-proportional**: at the current corpus (~76
  projects / ~1,500 rows) every request — including the 30 s poll — ships and classifies
  ~1,500 candidate rows regardless of whether one week or six is in view. Measured cost at
  1,596 rows is ~85 ms wall / 1.28 MB (see above); acceptable at this scale.

The range-scoped fix (`checklist_filtered_candidates` FROM `range_candidate_subtasks`) was
prototyped and reverted: a right-*length* but corrupt schedule value (`"not-a-date"`,
`"2026-13-45"`) has `coarse_shape = 1` and would then be filtered by a meaningless lexical
range comparison instead of reaching the handler for real classification — reintroducing
exactly the B1 hazard. A safe range-scoping would need `NOT GLOB`/structural-char guards so any
non-parseable value always reaches the handler; deferred until the studio approaches the
~500-project threshold. **Monitoring trigger:** if `calendar_range_too_dense` starts appearing
in production logs, or active-project count approaches 400, revisit with the range-scoped +
garbage-guard approach.
