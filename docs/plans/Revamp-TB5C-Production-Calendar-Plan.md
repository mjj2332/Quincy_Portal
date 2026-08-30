# Revamp TB5C — Production Calendar

**Status:** BUILT — ready for deploy prep (2026-08-31). All 12 slices implemented on branch
`tb5c-production-calendar` (off `main` `f6af664`), HEAD `8853fb2`. Review pipeline complete:
per-slice fresh-Sol + mid-slice Sol + confirm passes; fresh-Sol whole-branch review (2 passes,
APPROVE after fixes); Opus final-draft review → **APPROVE WITH FOLLOW-UPS** (all resolved: S3
fixed `a6a6bc7`, S2 fixed `5697bd3`, S1 documented `d81fc99` as a known corpus-proportional-density
limit). Agy Slice 10/11 acceptance matrix → all 12 checks PASS, 0 mutations
(`docs/plans/tb5c/slice-10-11-acceptance.md`); FullCalendar v7 has no live region of its own so
`SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT` stays off. Physical-phone + real-AT checks **waived by
owner 2026-08-31**. Full 6-workspace gate green (typecheck; build web; web 190 node + 529 dom;
shared 126; workers/app 279 +1 skip; background 253; webhook 13). Deploy boundary confirmed:
**app Worker only, no D1 migration** (0038 still free), no `feature_flags` seed, no
`workers/background` / `workers/webhook-ingress` / `prototype/` / schema change; rollback =
`wrangler rollback` to app Worker version `2b515484-44c6-4550-a1e2-62f88c6a8b73` (the TB5B
deploy). Prior status history: Opus plan-tier APPROVE (revision 4) after Sol draft → fresh-Sol ×2
→ 3 fresh-Sol revisions → Opus REVERT #1 → fresh-Sol revision → Opus APPROVE. `@ilamy/calendar`
evaluated on a throwaway branch 2026-08-30 and rejected (no public external-drop API); FullCalendar
v7 retained.

**Slice-3 factual delta (2026-08-30, design unchanged):** FullCalendar v7 restructured its packages — the separate view/interaction packages stopped at v6; v7 ships plugins as `@fullcalendar/react` subpaths. §"FullCalendar v7 dependency and visual boundary" corrected: pin `@fullcalendar/{core,react}@7.0.2` + `temporal-polyfill@1.0.4` only (`@full-ui/headless-calendar@7.0.2` transitive); import plugins from `@fullcalendar/react/{daygrid,timegrid,list,interaction}` and CSS from `@fullcalendar/react/skeleton.css` + `@fullcalendar/react/themes/pulse/theme.css`. No Radix in the FullCalendar packages themselves.

## Recommendation: one tracer bullet, one deploy

Build TB5C as **one tracer bullet, internally divided into independently green slices, followed by one app-Worker production deploy and one QA cycle**. Do not split it into TB5C-a read-only and TB5C-b direct manipulation.

The new dependency, strict URL grammar, shared DTO/mapping module, bounded range endpoint, and three-audience authorization projection are the load-bearing risk. A read-only production split would still have to ship all of those boundaries, then preserve an intermediate read-only compatibility state while a second rollout adds mutation. It would add a second deploy/rollback/QA surface without isolating the hardest uncertainty. The plan instead establishes the shared contracts first, makes the read-only UI independently green, and adds project, checklist, and Unscheduled mutations in separate later slices behind server-computed permissions. No slice is deployed independently; the capability grant is the single launch gate and reaches production only with the complete tracer bullet.

The plan must return to plan-tier review rather than silently split if implementation discovers any of these facts: the range projection cannot remain within the bounded at-most-two-statement contract below; FullCalendar v7 cannot satisfy the real-browser/AT matrix through public Standard APIs; the TB4B/TB4D commands need semantic changes; or the external projection cannot remain an explicit `visibleProjectWhere`-scoped select. Those are architecture findings, not slice-local fixes.

## Purpose and outcomes

TB5C adds **Calendar** as the third active Dashboard projection:

```text
List | Kanban | Calendar
```

It delivers these outcomes:

1. Admins, internal Editors, and assigned-scope External Editors can read an authorized Sydney-time production Calendar in Month, Week, and Agenda subviews.
2. The Project layer shows exactly one milestone at each existing TB4B Project Deadline. The Checklist layer shows each existing TB4D due-only milestone or scheduled range.
3. The Calendar is a projection, not a scheduling authority. Every mutation replays the unchanged TB4B or TB4D command with its existing version, DST, reminder, activity, audit, queue-publication, and conflict semantics.
4. FullCalendar owns calendar geometry and its drag/resize/external-drop mechanics. Quincy owns authorization, query identity, optimistic state, guarded mutations, confirmation, conflict recovery, focus, announcements, toolbar, filters, Unscheduled panel, responsive behavior, and visual language.
5. URL state restores the same authorized Calendar date/subview/layers/filters through Back/Forward, copied links, internal navigation, and OAuth return. Inaccessible filter IDs are discarded without revealing them.
6. External Editor ships in the same tracer bullet: assigned unarchived projects only, read-only Project Deadlines, Collaboration-authorized checklist mutation, and a quick **My tasks** filter that never narrows the default corpus.
7. Photographer receives no capability, no Calendar navigation, and a generic `403` from the authenticated endpoint.

## Authority and dependency boundary

Apply authority in this order:

1. `docs/plans/revamp_2026_portal/roadmap/TB5C-Production-Calendar.md` controls scope, subviews, layers, filters, direct manipulation, Unscheduled behavior, conflict/DST/overlap rules, FullCalendar ownership, tests, and acceptance.
2. The locked decisions in the caller's TB5C planning spec control where they add detail to the brief, including zero migration, capability-only launch, localStorage fallback, app-only deploy, the new shared module, exact dependency pins, confirmation reuse, the 50/50 Unscheduled bound, and all-three-audiences delivery.
3. `docs/Decision-Sheet.md` controls D-13, D-16, D-17, D-18, and D-19: authorized Production Calendar/checklist scheduling; one reviewed FullCalendar registry exception under Quincy visual authority; route/resource/range-aware query identities and canonical coordination; and assigned-scope External Editor Calendar.
4. `CLAUDE.md` / `AGENTS.md` controls the repository and rollout constraints. Calendar stays non-live until this tracer bullet deploys. Route/resource/range query keys must preserve drafts and active manipulation.
5. The implemented foundations are immutable inputs:
   - TB2: principal/role/authorization-epoch/scope query identity, 15-second `staleTime`, visible 30-second polling, focus/reconnect refetch, narrow invalidation, and access-loss purge;
   - TB4B: `SaveProjectDeadlineRequest`, `saveProjectDeadlineSchedule`, occurrence materialization, advance-offset and `elapsed_at_save` rules, Sydney civil resolution, version conflicts, and terminal project rules;
   - TB4D: `InitialChecklistScheduleInput`, the five-state `ChecklistScheduleDto`, `schedule_version`, O(1) Sydney resolver, half-open timed/inclusive date-range semantics, activity, and conflicts;
   - TB4E: `visibleProjectWhere`, explicit external selects, strict response parsing, authorization epoch, whole-family `['production-calendar', ...]` purge reservation, and the TB5C-owned Calendar DTO seam;
   - TB5A: `stageTransportKeyForRole`, `STAGE_PRESENTATION_KEYS`, and role-safe `editing_autohdr -> editing` presentation. Calendar consumes Stage only as context and never reads or returns Board position/revision/order;
   - TB5B: the eight-rule `QuincyGuardedDirectManipulationPolicy` in `apps/web/src/lib/kanban-interaction.ts`. TB5C adopts the policy, not dnd-kit's helpers or geometry.
6. `docs/PRD.md`, `Personas.md`, and `Sitemap.md` resolve only matters left open above; current source wins where their prose describes superseded implementation.

Implementation is confined to `portal/`. `prototype/` is reference-only. `@quincy/shared` remains the sole owner of capability and Stage vocabulary. Hono middleware is path-scoped, and both exact range-route forms are registered. Media is untouched.

## Scope

### In scope

- A capability-gated third Dashboard view for active projects.
- Month, Monday-start seven-day Week, and Agenda subviews in `Australia/Sydney`; Month includes its leading/trailing grid days, Week is 24-hour and fully reachable, and Agenda is action-based.
- Desktop first-use Month/today; phone first-use Agenda/today; remembered subview and last date are client-only fallbacks.
- Project Deadline and checklist due/range event layers with role-safe Stage context, checklist completion, completion/overdue/delivered state, and non-blocking same-assignee timed overlap indication.
- Strict URL state for Calendar date, subview, layers, Editor/Stage filters, Unassigned, completed/delivered toggles, overdue-only, My tasks, and Dashboard search.
- One authorized, range-bounded app endpoint returning internal or strict External DTOs from at most two bounded D1 statements and no browser fan-out.
- A bounded Unscheduled panel with explicit truncation counts.
- Project Deadline drag/move with confirmation; checklist due/range drag, range end-resize, and an explicit schedule editor; keyboard Move/Reschedule parity.
- Guarded optimistic proposals, no-retry stale rollback/refetch, refresh deferral/reconciliation, access-loss precedence, deterministic focus, and terminal-safe announcements.
- FullCalendar v7 Standard React/DayGrid/TimeGrid/List/Interaction plus `temporal-polyfill`, with the official shadcn registry used as a reviewed specialist source and Quincy styling remaining authoritative.
- App Worker route/UI/shared-package changes, automated coverage, Agy local-dev functional QA, and real-hardware/AT acceptance.

### Hard non-goals

- Day, year, multi-month, Scheduler, resource timeline, or any premium/resource view.
- Shoot-date, activity, comment, upload, or other event layers; recurrence.
- Google, Outlook, Apple, ICS sync/export, or any external Calendar integration.
- Empty-slot creation, hard capacity booking, overlap rejection, or capacity semantics.
- Calendar-specific storage, mutation command, notification, activity, audit, reminder, version, or conflict code.
- A second project Deadline/checklist schedule store or any TB4B/TB4D command semantic change.
- Any D1 migration, `schema.ts` change, generated migration, or new feature-flag row. Migration number `0038` remains available to a later phase.
- Any `workers/background` or `workers/webhook-ingress` change or deploy.
- Any TB5A Stage/order behavior, `boardPosition`, `board_revision`, Board ordering, or `tb5a_board_contract_enabled` dependency.
- Photographer Calendar access.
- `@fullcalendar/premium`, Scheduler, resource plugins, a generic Calendar primitive library, or a second general-purpose primitive system from registry output.
- Prototype edits, media deletion, or broader project authorization.

## Locked implementation constraints

### Zero migration — why

Every Project event and unscheduled Project entry derives from existing `projects.deadline_*`, `deadline_reminder_offsets_json`, and `deadline_version`. Every Checklist event and unscheduled/needs-attention entry derives from the existing `project_subtasks` due/schedule columns and `schedule_version`. Direct manipulation calls the existing services that already update those fields and materialize their canonical side effects. The Calendar needs no persisted layout, event, overlap, filter, preference, or notification row. Therefore a migration would create duplicate authority rather than capability.

Every slice audit must confirm no change under `portal/packages/db/`, no edit to any `schema.ts`, no new SQL file, no `drizzle-kit generate`, and no reference to migration `0038`. Closeout keeps the next migration number at `0038` in both root instruction files.

### Capability-only launch gate

Add `viewProductionCalendar` to `CAPABILITIES`, then grant it to `ROLE_CAPABILITIES.admin`, `ROLE_CAPABILITIES.editor`, and `EXTERNAL_EDITOR_CAPABILITIES`; the External list becomes exactly 11 items. Do not grant it to Photographer. Do not add a `feature_flags` row or read a Calendar flag.

The Dashboard renders the Calendar selector only when `can('viewProductionCalendar')`. The endpoint applies the same capability server-side and returns generic authorization results (`401` unauthenticated; `403` capability withheld; normal visible-scope filtering/`404` behavior where a project-specific command later loses access). The capability constant/grants and the fully mounted three-principal endpoint land in the same slice, before the UI slice. Thus no green slice contains a granted capability pointing at a nonexistent or partially implemented Calendar route. This is not a partial production launch because there is one final deploy.

TB4E's deliberately temporary assertions must flip in the same capability slice:

- remove every assertion that `viewProductionCalendar` is absent from `CAPABILITIES`;
- replace the External absence assertion with `roleHasCapability('external_editor', 'viewProductionCalendar') === true`;
- update the exact `EXTERNAL_EDITOR_CAPABILITIES` array and its length `10 -> 11`;
- leave `externalMeResponseSchema`'s existing self-updating `.length(EXTERNAL_EDITOR_CAPABILITIES.length)` expression unchanged; update only the hand-written `packages/shared/test/capabilities.test.ts` exact array/length expectation and the exact `/api/me` capability response expectation;
- replace any route-security-manifest Calendar `withheld` expectation/reservation with the new assigned/global-self Calendar surface classification and live strict-schema probe when the route lands. The planning baseline contains no registered Calendar route, so Slice 0 must distinguish executable assertions from TB4E's plan-only reservation rather than inventing a row;
- update repository-audit expectations for `rg -n 'moveProjectStage|viewProductionCalendar' packages/shared/src/capabilities.ts`: both strings must exist, with Calendar granted to Admin/Editor/External and absent from Photographer.

Rollback is `git revert` of TB5C plus app Worker redeploy. There is no runtime flag, schema rollback, or data repair.

### Client-only remembered fallback

Use `quincy:dashboard:calendar:subview` and `quincy:dashboard:calendar:last-date`. Extend the existing `quincy:dashboard:view` value domain to `'list' | 'kanban' | 'calendar'`, and update `normalizeDashboardView` accordingly. URL state always wins. When the URL contains a valid Calendar route, no storage value changes the parsed state. When `/` is loaded with stored view `calendar`, a capability-eligible active-scope principal initializes the Calendar from the remembered subview/date fallbacks and immediately replaces `/` with the canonical Calendar URL; a principal without `viewProductionCalendar` coerces that stored value to `kanban` and rewrites the preference without issuing a Calendar query. Archived mode always selects/records `list`, ignores a stored `calendar`, and removes Calendar query state. When Calendar is selected from `/` without Calendar query state, initialize subview from storage (phone fallback Agenda, desktop fallback Month) and date from valid stored date or Sydney today, then immediately serialize the canonical Calendar URL. Every storage read/write is in `try/catch`, including partial availability where read succeeds and write fails. No server preference or endpoint is introduced.

### App Worker only

`saveProjectDeadlineSchedule` and its occurrence/queue publication are app-owned in `workers/app/src/lib/project-deadline.ts`. `saveProjectSubtask` and `finalizeProjectSubtaskCommandResult` are app-owned in `workers/app/src/lib/project-subtasks.ts`. Background only scans already materialized occurrences; a drag invokes the same app-side materialization. The implementation diff must contain no `workers/background` or `workers/webhook-ingress` file, and neither Worker is redeployed.

## Shared production-calendar contract

Create `portal/packages/shared/src/production-calendar.ts`, export it from `packages/shared/src/index.ts`, and make it the only shared Calendar domain vocabulary. The server and web import it. The web may add React/FullCalendar adapters, but it must not duplicate date shifting, schedule command mapping, request parsing, DTO schemas, permissions shapes, or Calendar filter normalization.

### Export list

The module exports at least:

```ts
export const PRODUCTION_CALENDAR_ZONE = 'Australia/Sydney' as const;
export const PRODUCTION_CALENDAR_SUBVIEWS = ['month', 'week', 'agenda'] as const;
export const PRODUCTION_CALENDAR_LAYERS = ['project', 'checklist'] as const;
export const PRODUCTION_CALENDAR_MAX_RANGE_DAYS = 42;
export const PRODUCTION_CALENDAR_UNSCHEDULED_LIMIT_PER_KIND = 50;
export const PRODUCTION_CALENDAR_MAX_EDITOR_IDS = 50;
export const PRODUCTION_CALENDAR_MAX_STAGE_KEYS = 5;
export const PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES = 8192;
export const PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS = 10_000;

export const productionCalendarRangeQuerySchema: z.ZodType<ProductionCalendarRangeQuery, z.ZodTypeDef, ProductionCalendarRangeQueryInput>;
export const externalProductionCalendarRangeQuerySchema: z.ZodType<ExternalProductionCalendarRangeQuery, z.ZodTypeDef, ExternalProductionCalendarRangeQueryInput>;
export const productionCalendarFiltersSchema: z.ZodType<ProductionCalendarFilters, z.ZodTypeDef, ProductionCalendarFiltersInput>;
export function calendarEventSchemaFor<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<CalendarEventDto<TStage>>;
export function calendarUnscheduledEntrySchemaFor<TStage extends StageTransportKey>(stageSchema: z.ZodType<TStage>): z.ZodType<CalendarUnscheduledEntryDto<TStage>>;
export const adminProductionCalendarRangeResponseSchema: z.ZodType<ProductionCalendarRangeResponse<StageKey>>;
export const editorProductionCalendarRangeResponseSchema: z.ZodType<ProductionCalendarRangeResponse<StagePresentationKey>>;
export const externalCalendarRangeSchema: z.ZodType<ExternalCalendarRangeDto>;

export type ProductionCalendarSubview = 'month' | 'week' | 'agenda';
export type ProductionCalendarLayer = 'project' | 'checklist';
export type ProductionCalendarFilters = ...; // Stage filters are always StagePresentationKey[]
export type ProductionCalendarFiltersInput = ...; // raw/defaultable/unsorted form accepted by Zod
export type ProductionCalendarRangeQuery = ...;
export type ProductionCalendarRangeQueryInput = ...;
export type ExternalProductionCalendarRangeQueryInput = ProductionCalendarRangeQueryInput;
export type CalendarEventDto<TStage extends StageTransportKey = StageTransportKey> = ProjectDeadlineCalendarEventDto<TStage> | ChecklistCalendarEventDto<TStage>;
export type CalendarUnscheduledEntryDto<TStage extends StageTransportKey = StageTransportKey> = ProjectCalendarUnscheduledEntryDto<TStage> | ChecklistCalendarUnscheduledEntryDto<TStage>;
export type ProductionCalendarRangeResponse<TStage extends StageTransportKey = StageTransportKey> = ...;
export type ExternalCalendarRangeDto = z.infer<typeof externalCalendarRangeSchema>;

export function shiftSydneyCalendarDate(...): CalendarMappingResult<string>;
export function shiftSydneyCivilPreservingWallTime(...): CalendarMappingResult<SydneyCivilResolution>;
export function mapProjectDeadlineMoveToCommand(...): CalendarMappingResult<SaveProjectDeadlineRequest>;
export function mapUnscheduledProjectDropToCommand(...): CalendarMappingResult<SaveProjectDeadlineRequest>;
export function mapChecklistMoveToCommand(...): CalendarMappingResult<SaveChecklistScheduleRequest>;
export function mapChecklistEndResizeToCommand(...): CalendarMappingResult<SaveChecklistScheduleRequest>;
export function mapUnscheduledChecklistDropToCommand(...): CalendarMappingResult<SaveChecklistScheduleRequest>;
export function previewProjectDeadlineReminderConsequences(...): ProjectDeadlineReminderMovePreview;
```

Names may be tightened during implementation, but this ownership and exhaustive surface may not move into web/server-local helpers.

### Request/filter types

The HTTP parser converts repeated/canonical comma-separated query fields into this strict normalized type:

```ts
type ProductionCalendarFilters = {
  layers: Array<'project' | 'checklist'>;       // unique, canonical order; at least one
  editorIds: string[];                         // lowercase UUIDs, multi-Editor OR, unique, sorted
  includeUnassigned: boolean;                  // OR branch beside editorIds
  stageKeys: StagePresentationKey[];           // canonical filter keys for every role, unique, STAGE_PRESENTATION_KEYS order
  showCompletedChecklist: boolean;
  showDeliveredProjects: boolean;
  overdueOnly: boolean;
  search: string;                              // trim/collapse whitespace, bounded to 200 chars
  myTasks: boolean;
};

type ProductionCalendarRangeQuery = {
  start: string;                               // validated YYYY-MM-DD in Sydney, inclusive
  end: string;                                 // validated YYYY-MM-DD in Sydney, exclusive
  date: string;                                // active/focused YYYY-MM-DD
  subview: 'month' | 'week' | 'agenda';
  scope: 'active';
  filters: ProductionCalendarFilters;
};

type ExternalProductionCalendarRangeQuery = ProductionCalendarRangeQuery;
```

The **query/filter** schemas normalize defaults, trimming, whitespace, ordering, and deduplication, so their raw input types are deliberately distinct from their output types. Use the three-parameter Zod 3 form `z.ZodType<Out, z.ZodTypeDef, In>` shown above for those, or omit an explicit annotation and export `z.input<typeof schema>` / `z.output<typeof schema>`; never claim `Input=Output` with `z.ZodType<Out>` for a normalizing schema. The **DTO/response** schemas (`adminProductionCalendarRangeResponseSchema`, `editorProductionCalendarRangeSchema`, `externalCalendarRangeSchema`, and the `…SchemaFor` factories) are strict, non-normalizing, and deliberately `Input === Output`; the single-parameter `z.ZodType<Out>` form is correct for those and the three-parameter form must not be over-applied to them.

`start < end`; the range is at most 42 calendar days by component arithmetic, never `Date` parsing. Month requests include the rendered leading/trailing grid days. Week requests are exactly Monday through the following Monday. Agenda uses a bounded window no larger than 31 days and advances explicitly. Invalid dates, duplicate scalar params, unknown params, invalid UUIDs, mixed spellings, empty layers, and oversized ranges return `400` without querying D1. Repeated list params are rejected at the HTTP boundary; canonical serialization uses one comma-separated value with sorted unique members. `editorIds` is capped at 50, `stageKeys` at 5 (the `STAGE_PRESENTATION_KEYS` count), and the entire encoded query string at 8,192 UTF-8 bytes. This ceiling is deliberately above the true worst case (50 comma-joined lowercase UUIDs ≈ 1,857 bytes, plus a 200-char multibyte `q` percent-encoded ≈ 2,400 bytes, plus fixed scalars), so a request that satisfies every per-field cap always passes the byte cap; a Slice 4 case combines 50 editors with a 200-character multibyte `q` and expects `200`. The byte and cardinality checks happen before D1; over-cap input returns `400 calendar_query_too_large`. There is deliberately no Project-ID request filter or URL control.

Stage **filter** parsing is role-independent: the URL grammar and both range-query schemas accept only `StagePresentationKey[]`, in canonical `STAGE_PRESENTATION_KEYS` order. Thus `editing` is the one canonical filter spelling for every principal, while `editing_autohdr` is an unknown filter token and returns `400` for Admin, internal Editor, and External Editor alike. After validation, the server expands `editing -> editing_autohdr` exactly once for the storage/SQL predicate; because `STAGE_KEYS` has only that one editing sub-stage, this loses no Admin filtering precision. This filter rule does not change DTO presentation: `project.stageKey` remains parameterized by `StageTransportKey`, so Admin receives `editing_autohdr` while non-Admin receives `editing` through `stageTransportKeyForRole`. Restored URLs discard inaccessible Editor IDs non-disclosingly, but do not role-coerce malformed Stage tokens.

The server resolves Sydney start/end instants through existing civil-time primitives (`startT00:00`, `endT00:00`) and handles the theoretical resolver error as `400`; it never uses the Worker/browser local zone. Date-only values are validated as calendar components and never passed to `new Date('YYYY-MM-DD')`.

### Display-zone binding

Every FullCalendar instance sets the exact option `timeZone="Australia/Sydney"` (from `PRODUCTION_CALENDAR_ZONE`) in Month, Week, and Agenda/List. Quincy feeds FullCalendar timed event `start`/`end` values as ISO instants with explicit offsets or `Z`, and feeds all-day values as validated `YYYY-MM-DD` strings with FullCalendar-exclusive `end`. It never feeds a zone-less timed string or derives a date-only value through `Date`.

FullCalendar v7 callback payloads return these exact forms:

- `eventDrop` and `eventResize`: `info.event.start`/`end` are `Date | null`; `startStr`/`endStr` are `YYYY-MM-DD` for all-day events and offset-bearing ISO strings for timed events. Use the strings only for validated all-day component arithmetic; use the `Date` instant through the callback adapter for timed civil values.
- external `drop`: `info.date` is a `Date`, `info.dateStr` is `YYYY-MM-DD` when `info.allDay` and an offset-bearing timed string otherwise; `eventReceive` exposes the received event in the same event form above. All timed paths use the `Date` instant through the adapter.
- `dateClick`: `info.date` is a `Date`, with `info.dateStr`/`info.allDay` in the same all-day-versus-timed forms. It may drive disclosure/focus but never creation.

Those `Date` objects represent instants but their native getters/formatters are local/UTC-flavored, not a trustworthy expression of the configured Calendar zone. Add a web-only adapter in `apps/web/src/lib/production-calendar-fullcalendar.ts`, centered on `fullCalendarCallbackToSydneyCivil(value: { allDay: boolean; date: Date; dateStr: string }): { allDay: true; date: string } | { allDay: false; date: string; localCivil: string; utcOffsetMinutes: number }`. The adapter **reuses the existing Temporal-free `@quincy/shared` primitives**: for an instant-bearing (timed) callback it calls `formatSydneyCivilMinute(value.date.toISOString())` (`packages/shared/src/sydney-civil-time.ts:140`, already exported) to obtain the `YYYY-MM-DDTHH:mm` Sydney civil minute, then `resolveSydneyCivilMinute` for its `utcOffsetMinutes`; for an all-day callback it validates and preserves FullCalendar's `YYYY-MM-DD` string with `isSydneyCalendarDate`, never `Date` conversion, and returns no `localCivil`/`utcOffsetMinutes`. The adapter — not a native `Date#get*`, an `Intl` call using the browser zone, or FullCalendar's offset-free callback text — supplies the Sydney date/civil minute passed to shared mappers. **No new DST engine and no `Temporal` usage is introduced in our code:** `temporal-polyfill` is a declared **peer dependency** of `@fullcalendar/react@7.0.2` / `@full-ui/headless-calendar@7.0.2` for FullCalendar's own internal Temporal use (that is why it is a direct pin), but Quincy's adapter and mappers stay on the shared civil-time helpers, so there is exactly one Sydney-time authority. A shared-suite equivalence test asserts the adapter's output and `resolveSydneyCivilMinute` agree across the April 2026 fold and the October 2026 gap.

### DTOs

Use strict Zod schemas and unions of complete literal-pinned object branches. All Calendar-safe strings are bounded. Event IDs are opaque stable strings (`project-deadline:<projectId>` and `checklist:<subtaskId>`), not storage IDs for a new entity.

```ts
type CalendarPermissions = {
  canDrag: boolean;
  canResize: boolean;
};

type ChecklistCalendarPermissions = CalendarPermissions & {
  canOpenScheduleEditor: boolean;
  canScheduleRange: boolean; // server-computed CHECKLIST_SCHEDULE_RANGES_ENABLED boundary
};

type CalendarProjectContext<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  street: string;
  stageKey: TStage;
  checklist: { completed: number; total: number };
  delivered: boolean;
};

type CalendarPerson = {
  id: string;
  name: string;
  roleLabel: string;
  isExternal: boolean;
  active: boolean;
};

type CalendarEventTiming =
  | { allDay: true; start: string; end: string | null } // dates; range end is FullCalendar-exclusive
  | { allDay: false; start: string; end: string | null }; // ISO instants; milestone end null

type ProjectDeadlineCalendarEventDto<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: 'project_deadline';
  title: string;
  project: CalendarProjectContext<TStage>;
  timing: CalendarEventTiming;
  status: { overdue: boolean; delivered: boolean; completed: false; sameAssigneeOverlap: false };
  permissions: { canDrag: boolean; canResize: false };
  deadlineLocalCivil: string;
  deadlineVersion: number;
  reminderOffsetsMinutes: number[];
};

type ChecklistCalendarEventBase<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: 'checklist';
  title: string;
  project: CalendarProjectContext<TStage>;
  assignee: CalendarPerson | null;
  timing: CalendarEventTiming;
  status: { overdue: boolean; delivered: boolean; completed: boolean; sameAssigneeOverlap: boolean };
};

type ValidChecklistScheduleDto = Extract<ChecklistScheduleDto, { state: 'unscheduled' | 'due_only' | 'range' }>;
type UnscheduledChecklistScheduleDto = ValidChecklistScheduleDto & { state: 'unscheduled' };
type DueOnlyChecklistScheduleDto = ValidChecklistScheduleDto & { state: 'due_only' };
type RangeChecklistScheduleDto = ValidChecklistScheduleDto & { state: 'range' };
type LegacyUnresolvedChecklistScheduleDto = Extract<ChecklistScheduleDto, { state: 'legacy_unresolved' }>;
type InvalidChecklistScheduleDto = Extract<ChecklistScheduleDto, { state: 'invalid' }>;

type ChecklistCalendarEventDto<TStage extends StageTransportKey = StageTransportKey> =
  | ChecklistCalendarEventBase<TStage> & {
      schedule: DueOnlyChecklistScheduleDto;
      permissions: { canDrag: boolean; canResize: false; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
    }
  | ChecklistCalendarEventBase<TStage> & {
      schedule: RangeChecklistScheduleDto;
      permissions: ChecklistCalendarPermissions;
    };

type ProjectCalendarUnscheduledEntryDto<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: 'project_deadline';
  reason: 'unscheduled';
  title: string;
  project: CalendarProjectContext<TStage>;
  permissions: { canDrag: boolean; canResize: false };
  deadlineVersion: number;
  reminderOffsetsMinutes: []; // an unset/cleared TB4B schedule has no offsets
};

type ChecklistCalendarUnscheduledBase<TStage extends StageTransportKey = StageTransportKey> = {
  id: string;
  kind: 'checklist';
  title: string;
  project: CalendarProjectContext<TStage>;
  assignee: CalendarPerson | null;
};

type ChecklistCalendarUnscheduledEntryDto<TStage extends StageTransportKey = StageTransportKey> =
  | ChecklistCalendarUnscheduledBase<TStage> & {
      reason: 'unscheduled';
      schedule: UnscheduledChecklistScheduleDto;
      permissions: { canDrag: boolean; canResize: false; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
      // attentionReason is absent
    }
  | ChecklistCalendarUnscheduledBase<TStage> & {
      reason: 'schedule_needs_attention';
      attentionReason: 'legacy_unresolved';
      schedule: LegacyUnresolvedChecklistScheduleDto;
      permissions: { canDrag: false; canResize: false; canOpenScheduleEditor: boolean; canScheduleRange: boolean };
    }
  | ChecklistCalendarUnscheduledBase<TStage> & {
      reason: 'schedule_needs_attention';
      attentionReason: 'invalid';
      schedule: InvalidChecklistScheduleDto;
      permissions: { canDrag: false; canResize: false; canOpenScheduleEditor: false; canScheduleRange: false };
    };

type ProductionCalendarRangeResponse<TStage extends StageTransportKey = StageTransportKey> = {
  range: {
    start: string;
    end: string;
    date: string;
    subview: ProductionCalendarSubview;
    zone: 'Australia/Sydney';
    appliedFilters: ProductionCalendarFilters; // canonical presentation-stage filters; inaccessible IDs removed non-disclosingly
  };
  events: CalendarEventDto<TStage>[];
  unscheduled: CalendarUnscheduledEntryDto<TStage>[];
  filterFacets: {
    projects: Array<{ id: string; street: string }>;
    people: CalendarPerson[];
    myTasksUserId: string;
    unscheduled: {
      project: { matched: number; returned: number; truncated: boolean };
      checklist: { matched: number; returned: number; truncated: boolean };
    };
  };
};

type ExternalCalendarRangeDto = ProductionCalendarRangeResponse<StagePresentationKey>;
```

The internal and External schemas share the same Calendar-safe structure, but **not** the project-context Stage DTO domain: Admin DTOs contain the actual stored `StageKey`, while internal Editor and External DTOs permit only `StagePresentationKey`. Export the currently module-private `STAGE_TRANSPORT_KEYS` from `stage-move.ts` and re-export it from `index.ts` so the shared transport vocabulary is public and testable, but use the tighter `z.enum(STAGE_KEYS)` for the Admin Calendar project-context domain because `stageTransportKeyForRole(stage, 'admin')` can never emit the transport-only alias `editing`. This is an export-only TB5A compatibility change with no Stage mapping/order behavior change. Use `z.enum(STAGE_PRESENTATION_KEYS)` for each non-Admin response domain, and carry those concrete schemas through every nested event and Unscheduled branch. Select exactly one role-domain response schema after authentication rather than using an ellipsis, permissive string, cast, or post-parse assertion.

Pinned Zod is 3.25.x, so construct checklist variants with `z.union([...])`, not `z.discriminatedUnion`: each union member is a complete `.strict()` object that pins a nested strict `schedule` to one literal `state`, and needs-attention members additionally pin `reason:'schedule_needs_attention'` plus the unique `attentionReason:'legacy_unresolved' | 'invalid'` literal. The event union contains only complete `due_only` and `range` members; the Unscheduled union contains complete `unscheduled`, `legacy_unresolved`, and `invalid` members. This preserves strict unknown-key rejection, permission literals, and rejection of every cross-combination without relying on an unsupported nested or non-unique discriminator. Tests assert `safeParse(...).success === false`, not Zod issue paths. The query schema remains role-independent and always uses `z.enum(STAGE_PRESENTATION_KEYS)` for `stageKeys`.

Checklist Calendar DTOs do not duplicate a top-level `scheduleVersion`; all commands source `expectedVersion` from `schedule.version`. This deliberately preserves `invalidDto`'s defensive clamp to `0` for corrupt stored versions instead of comparing it with an unsafe raw row value and turning the needs-attention projection into a strict-parse 500. Shared compile-time tests use `expectTypeOf` to pin every named alias above and specifically prove that due-only/range/unscheduled aliases are not `never`.

Keep separately named Admin, internal-Editor, and External strict response schemas so `EXTERNAL_API_RESPONSE_SCHEMAS.calendar` is an explicit privacy boundary and future internal additions cannot flow outward by structural accident. Remove the stub definition from `external-project-dto.ts`, import/re-export the finalized schema/type there only if compatibility requires it, and point `EXTERNAL_API_RESPONSE_SCHEMAS.calendar` at the shared finalized external schema. No External person email, contact, notes, provider, media, raw Stage, Board, or membership-cycle field is selected or serialized.

`legacy_unresolved` and `invalid` checklist schedules cannot produce drag geometry. Return them only in their matching strict `reason:'schedule_needs_attention'` / `attentionReason` branch; they can never parse as scheduled events or plain `unscheduled` entries. `schedule_needs_attention` is projection vocabulary only and creates no stored state or new conflict code. The unchanged PATCH treats them differently, and Calendar must preserve that distinction:

- `invalid` is unreplaceable by every schedule-bearing request because `saveProjectSubtask` returns `storage_invalid` before choosing either request branch. It is fully read-only in Calendar: no drag, resize, external drop, Move/Reschedule, or Calendar editor. Show needs-attention copy and link only to an existing non-Calendar repair path if one exists; otherwise say repair is unavailable. True invalid-storage repair is a TB4D semantic change and out of scope.
- `legacy_unresolved` has version `0`. The legacy `dueDate` patch branch rejects it with `subtask_schedule_reload_required`, but the unchanged **versioned** `scheduleRequest` branch accepts `expectedVersion:0`, normalizes a complete replacement, and can increment it to version 1. Therefore it has no drag/resize/external-drop geometry, but a Collaboration-authorized user may open the Calendar Move/Reschedule editor and submit a complete versioned replacement. Calendar never uses the rejected legacy patch branch.

Valid `unscheduled`, `due_only`, and `range` states are likewise replaceable through the unchanged versioned PATCH, subject to version, normalization, and Collaboration authorization.

### Stage and status semantics

- Project events show street/address, role-safe Stage, `completed/total` checklist count, Deadline overdue state, and delivered state.
- Checklist events show title, assignee, project/street, role-safe Stage, completion, overdue, and delivered context.
- `editing_autohdr` remains distinct for Admin in the project-context DTO's `StageKey` domain; `stageTransportKeyForRole` neutralizes that DTO field to `editing` for non-Admin. Calendar Stage filters and URLs use only `StagePresentationKey` for every role and therefore never expose or accept the internal key.
- Project Deadline overdue means TB4B's Deadline is before the authoritative server `now` and project is not delivered/archived.
- Checklist overdue means its due/end is before server `now`, it is incomplete, and the row is a valid scheduled state. Date-only overdue compares Sydney calendar dates by validated components, not UTC parsing.
- There is no synthetic elapsed-time progress percentage and no shoot-date duration.

## Server range endpoint

### Route and authorization

Add `portal/workers/app/src/routes/production-calendar.ts`, mount it in `workers/app/src/index.ts`, and register exactly:

```ts
productionCalendarRoutes.use('/production-calendar', requireCapability('viewProductionCalendar'));
productionCalendarRoutes.use('/production-calendar/', requireCapability('viewProductionCalendar'));
productionCalendarRoutes.get('/production-calendar', terminalRoute(..., productionCalendarHandler));
productionCalendarRoutes.get('/production-calendar/', terminalRoute(..., productionCalendarHandler));
```

The already-mounted `/api` router owns `requireSession`. Do not use `router.use('*', ...)`. The two registrations call one handler. `SecurityRouteRegistration` has one classification per `(method,path)`, so add exactly one checked-in row for each GET route form using the legacy seed class `scoped`, which resolves to `scope:'assigned-project'`, `projection:'external-safe'`, and `response:'scoped'` — the same contract triple as `GET /api/projects` (a role-branched global-or-scoped collection). `securityClassForSeed` currently allow-lists only `/api/projects` and `/api/projects/:id` for `scoped-project`, so `/api/production-calendar` would otherwise derive `scoped-child-resource`; Slice 4 **adds `/api/production-calendar` (both forms) to that `scoped-project` allow-list** so it derives the `/api/projects` class rather than the child-resource class, since it is a collection query, not a project-child route. Widen `SecurityRouteRegistration['externalSurface']` and its seed-derived union to include `'calendar'`, then set `externalSurface:'calendar'` on both rows. Do not add parallel internal/External rows for the same route key. Also add the two non-terminal `.use` registrations to `CHECKED_IN_MIDDLEWARE_REGISTRATIONS` as `['ALL','/api/production-calendar']` and `['ALL','/api/production-calendar/']`; the manifest's exact count reconciliation depends on them. In `route-manifest.test.ts`, add a `probes.calendar` entry (a canonical bounded query with `start/end/date/sub/scope/layers`) **and** an `expectedScope.calendar` entry (value `'assigned-project'`, matching the resolved scope), since that test reconciles `externalSurface` set-equality against `Object.keys(probes)` and also indexes an exhaustive `expectedScope` record. Photographer is a generic capability denial. Unauthenticated requests stop at session middleware with `401`.

### Query identity and URL

The request is `GET /api/production-calendar` with strict canonical query fields:

```text
start=YYYY-MM-DD&end=YYYY-MM-DD&date=YYYY-MM-DD&sub=month|week|agenda&scope=active
&layers=project,checklist&editors=<uuid,...>&unassigned=1
&stages=<presentation-key,...>&completed=1&delivered=1&overdue=1&mine=1&q=<encoded text>
```

The shared API parser/serializer owns this grammar, including `mine=1`; its normalized default is `myTasks=false`, and `mine` is omitted from a canonical request when false. Defaults are omitted only where the shared parser supplies one unambiguous value; `start`, `end`, `date`, `sub`, `scope`, and `layers` are always explicit on API requests. The fixed API serialization order is `start`, `end`, `date`, `sub`, `scope`, `layers`, `editors`, `unassigned`, `stages`, `completed`, `delivered`, `overdue`, `mine`, `q`. The web query key is:

```ts
[
  'production-calendar',
  principalId,
  role,
  authorizationEpoch,
  { scope: 'active', start, end, date, subview, filters: canonicalFilters }
]
```

This key has 15-second `staleTime`, visible-only 30-second polling, focus/reconnect refetch, TB2 retry policy, and an `AbortSignal`. Do not place drafts, active drag geometry, confirmation state, or optimistic event arrays in TanStack Query cache. The accepted response is held behind an interaction barrier just as TB5B holds accepted Board state.

`removeProductionCalendarQueries(queryClient)` cancels and removes the whole `['production-calendar']` family. `PrincipalFreshnessBoundary` calls it synchronously before project-loss UI notification for any lost/cycle-changed project because a mixed range can contain private data. Principal-terminal cleanup still clears the whole QueryClient. Successful project Deadline/checklist mutations narrowly invalidate Calendar-family queries and the affected project detail/subtasks queries; they do not broaden a query key or broadcast event contents.

Extend the existing `quincy:project-data:v1` `BroadcastChannel` runtime—never create a second channel—with the exact ID-free message `{version:1,type:'production-calendar-invalidated',sourceTabId,committedAt}`. A successful Deadline/checklist schedule mutation publishes it once after the canonical winner. Its receiver invalidates only the receiver's own authorized `['production-calendar', ...]` family; it contains no project/event/filter data, never rebroadcasts, and relies on that tab's principal/role/epoch/scope keys. Receipt during `calendarInteractionBlocked` queues exactly one deferred refetch; receipt during `calendarSettlePending` may be the one settling refetch and must remain acceptable. Tests cover drag, confirmation, editor draft, mutation, and settle receipt, deduplication to one refetch, no echo, authorization-scope isolation, and unsupported-channel fallback.

### At most two bounded SQL statements

After request and capability validation, the handler performs **at most two D1 `.all()` statements**: statement 1 returns scheduled events plus bounded Unscheduled candidates (or one density-error row); only when statement 1 is below the density ceiling does statement 2 return range-derived facets and the sanitized filter echo. It must not issue project-list then per-project checklist queries or any per-project authorization/access-helper read. Both statements use the same reviewed bounded CTE shape, explicit select maps, and principal predicate; statement 2 is not a directory query. A reviewed query plan and integration query-count assertion pin the two-statement maximum.

The normalized `editorIds` and `stageKeys` lists are each bound exactly once per statement as a JSON array and expanded with `json_each(?)`; no `IN (?, ...)` placeholder fan-out is allowed. Together with fixed scalar bindings this guarantees a constant bound-parameter count regardless of list cardinality. Pre-D1 parsing caps editors at 50, Stage keys at 5 (the complete `StagePresentationKey` filter vocabulary), and the full encoded query at 8,192 UTF-8 bytes; over-cap inputs return `400 calendar_query_too_large` before either statement executes. There is no `projectIds` input.

1. `authorized_projects_base` selects only Calendar-safe project columns, applies `visibleProjectWhere(principal)`, always excludes archived projects, and applies active scope plus layer-relevant Stage/delivered/search conditions. Its FROM/JOIN is role-branched: External Editor starts from `projects INNER JOIN project_members` constrained by `(project_id, user_id=:me, role_on_project='editor')`, which is non-multiplying under `project_members_unique`; Admin/internal Editor starts from `projects` with no membership join because `visibleProjectWhere` is `1=1` for their `viewAllProjects` roles. It projects `can_collaborate` with the exact existing rule: active Admin is true; External Editor's required visible assignment is true; internal Editor uses a correlated `EXISTS` on `project_members(project_id,user_id)`. That signal supplies per-project checklist `canDrag`/`canResize`, including for an internal Editor who has `viewAllProjects` but Collaboration rights only on member projects. Do not call a per-project access helper afterward. Expand canonical filter key `editing` to stored key `editing_autohdr` before binding the Stage JSON array.
2. Keep the scope/Collaboration membership signal separate from the Editor-facet membership relation. `authorized_people_base` derives only editor memberships/assignees represented by the bounded authorized candidate universe; `valid_selected_editors` intersects the one JSON list with that allow-list. An intersection emptied only by inaccessible IDs means “no filter,” preventing an ID oracle; authorized selected IDs still apply normally.
3. `visible_projects` applies the valid project-Editor OR/Unassigned filter without multiplying project rows. `checklist_counts` groups `project_subtasks` by visible project for `completed/total` context.
4. `candidate_subtasks` joins visible projects to subtasks and assignee `user` through an explicit select map; it applies checklist layer, Stage, authorized assignee multi-OR/Unassigned, completion, overdue, and search predicates. Assignee requested IDs are sanitized through the same range-derived people base. The exact logical search columns are identical for Admin, internal Editor, and External Editor: `projects.street`, `projects.suburb`, the authorized agency display name, the authorized agent display name, and—only on checklist branches—`project_subtasks.title`. Internal stored `agency_name`/`agent_name` and External `agencyDisplayName`/`agentDisplayName` are projected into the same two logical display-name columns before the predicate. Explicitly exclude `projects.notes`, `projects.production_notes`, email, phone, provider, and every other field, preventing a role-dependent visibility oracle. Search is literal substring matching expressed as OR-ed `instr(lower(<column>), lower(:search)) > 0` predicates rather than `LIKE`. SQLite `lower()` is ASCII-only: tests may assert ASCII case folding and literal multibyte execution/matching at identical case, but must not claim Unicode case-insensitive behavior. Do not interpolate wildcards or use a `LIKE` fallback: a valid 200-character multibyte search must remain below the query-string cap and execute without SQLite/D1's 50-byte LIKE-pattern failure.
5. Statement 1's normalized `UNION ALL` branches emit project Deadline events, checklist events, and unscheduled Project/checklist candidates. Window functions assign `row_number()` and `count(*) over()` independently to each Unscheduled kind; only ranks `<= 50` are returned while total counts survive for truncation copy. Scheduled branches also carry `count(*) over()` across the candidate stream. If the count exceeds `PRODUCTION_CALENDAR_MAX_SCHEDULED_EVENTS = 10_000`, the SQL emits only a density sentinel and the handler returns non-200 `422 calendar_range_too_dense` with `{count,max}` and refinement copy; it never silently truncates scheduled events. **As built (Slice 4 B1 fix), the density count is over the whole active-corpus candidate set the handler must classify — not the in-range scheduled subset — so it is corpus-proportional; `docs/plans/tb5c/slice-4-query-review.md` records this as a known operational limit (~500-project threshold) with a monitoring trigger (owner decision 2026-08-31).**
6. Project Deadline intersection is `deadline_at >= :startInstant AND deadline_at < :endInstant`.
7. Timed checklist milestone intersection is `schedule_end_at >= :startInstant AND schedule_end_at < :endInstant`. Timed range intersection is `schedule_start_at < :endInstant AND schedule_end_at > :startInstant`.
8. Date-only milestone intersection is `due_date >= :startDate AND due_date < :endDate`. Inclusive date-only range intersection is `schedule_start_civil < :endDate AND due_date >= :startDate`; serialization adds one validated calendar day to the inclusive stored end to produce FullCalendar's exclusive all-day `end`.
9. Project events match selected Editor membership. Checklist events match selected assignee. `editorIds + includeUnassigned` is one OR group, never AND. Project and checklist layer predicates remain independent.
10. Statement 2 facets and accepted filter IDs derive only from the authorized bounded candidate universe for this request, including every authorized editor membership/assignee represented there even when Unscheduled rank truncation omits an item. `filterFacets.people` never widens to unrelated directory/assignable users. Selected IDs absent from that range-derived authorized universe are dropped before effective filter application and echoed only in sanitized `range.appliedFilters`; the response never identifies which inaccessible ID was removed.
11. The handler groups/serializes normalized rows in memory, calls `serializeChecklistSchedule` for all five states, computes permissions, stable ordering, and overlap markers, then strict-parses the response. It performs no third read.

The range cap, active-only scope, explicit filters, 50/50 Unscheduled bounds, and density ceiling prevent all-history downloads, but the 10,000-row ceiling alone is not a CPU budget: `resolveSydneyCivilMinute` makes up to six `Intl.DateTimeFormat#formatToParts` calls per resolution (three `offsetAt` probes plus up to three `roundTripCivil` checks, `sydney-civil-time.ts:115-127`), and each timed checklist endpoint resolves once, so a worst-case all-timed response approaches ~120,000 `formatToParts` calls plus JSON serialization. Slice 4's dense-fixture review records measured Worker CPU time and response bytes for the 1,596-row and 7,676-row shapes and the synthetic 10,001 refusal, alongside `EXPLAIN QUERY PLAN`; Slice 10 repeats the browser-side payload/render measurement. The fixed 10,000 maximum is retained only if those recorded numbers fit the deployed Worker budget and practical payload budget; evidence outside the budget returns to plan review to lower the ceiling.

No current index directly backs `projects.deadline_at` or the `project_subtasks.schedule_end_at`/`due_date` range predicates. Zero migration remains deliberate because the measured corpus is approximately 76 projects and 1,500 checklist rows: Slice 4 records the full-scan query plan, CPU, and bytes as an explicit baseline. An index is reconsidered only from measured evidence in a later migration plan; the storage-authority argument alone is not the justification.

### Unscheduled bound and truncation

Return at most **50 visible matching unscheduled Project entries plus 50 visible matching checklist entries**, ordered deterministically by overdue-relevant/status context, street/title, then ID. Fifty of each keeps the panel useful while bounding a cross-project payload to 100 draggable candidates; separate limits prevent a large checklist corpus from starving Projects. The `matched/returned/truncated` metadata drives exact copy such as `37 more — refine filters or search`. When truncated, only entries after deterministic rank 50 are omitted. No omitted-item detail or omission-specific metadata is returned: no hidden IDs, per-item fields, or data identifying which items were dropped. Aggregate, range-derived `filterFacets.people` may still include authorized people who appear only in the truncated tail because that is authorized range aggregate context, not omitted-item disclosure. The cap is never silent.

True `unscheduled` entries are eligible for external drop according to permissions. `schedule_needs_attention` entries are returned for repair visibility but are not externally draggable.

### Permissions

The server computes permissions; the client only tightens them for current interaction state:

- Project Deadline: `canDrag = roleHasCapability(role,'editProject') && !delivered && !archived`; `canResize=false`. This makes Admin editable, internal Editor read-only under current grants, External read-only, and Photographer unreachable.
- Unscheduled Project: the same `canDrag`; External entries remain visible and non-draggable.
- Checklist due-only: the DTO can contain only a `due_only` schedule; `canDrag` is true iff the principal has current `collaborateOnProject` access and the schedule is writable. `canOpenScheduleEditor` follows that rule because a due-only replacement need not produce a range; server-computed `canScheduleRange = canOpenScheduleEditor && CHECKLIST_SCHEDULE_RANGES_ENABLED` controls the editor's range option. `canResize=false` is literal in the strict branch.
- Checklist range: the DTO can contain only a `range` schedule. `canScheduleRange`, `canDrag`, and `canResize` are true only when Collaboration-authorized, writable, **and** `CHECKLIST_SCHEDULE_RANGES_ENABLED`; `canResize` remains end-edge-only in UI. In inert mode the existing range stays visible but cannot be moved/resized/replaced with a range; the editor may still offer a non-range complete replacement if `canOpenScheduleEditor` is otherwise true.
- Unscheduled checklist: the strict `reason:'unscheduled'` branch contains only `schedule.state:'unscheduled'`; `canOpenScheduleEditor` is true iff Collaboration-authorized, `canScheduleRange = canOpenScheduleEditor && CHECKLIST_SCHEDULE_RANGES_ENABLED`, and external-drop `canDrag` is true only when Collaboration-authorized **and** the range flag is enabled. In inert mode all external drop is disabled rather than exposing a target-dependent permission; the editor still offers authorized non-range replacement but disables its range option. `canResize=false`. The strict needs-attention branches always set drag/resize false. Only matching `legacy_unresolved` may set `canOpenScheduleEditor=true` when Collaboration-authorized, solely for a complete versioned `scheduleRequest` replacement with `expectedVersion:0`; its `canScheduleRange` is flag-gated. Matching `invalid` fixes both editor permissions false and exposes no Calendar editor. Only existing non-Calendar repair behavior, if any, is linked for invalid storage.
- Delivered project context does not invent a new checklist prohibition; checklist rights follow TB4D/Collaboration. Archived projects are absent.

### Overlap indicator

Group valid, incomplete, timed checklist ranges by non-null assignee. Sort by start instant and mark overlapping intervals with a sweep (`next.start < activeEnd`). Due-only, date-only, completed, Project Deadline, and unassigned entries do not participate. Overlap remains a non-blocking `status.sameAssigneeOverlap` indicator and accessible label. No mutation is blocked and no booking record is created.

## Routing and Dashboard URL contract

### Minimal route extension

Only Calendar state enters the URL. List and Kanban remain the current localStorage-only view choices. A shared Kanban URL is not required by TB5C; widening all Dashboard view routing would enlarge the closed parser without helping copied Calendar links.

Extend `StaffRoute` with:

```ts
type DashboardCalendarRoute = {
  kind: 'dashboard';
  calendar?: {
    view: 'calendar';
    date: string;
    subview: 'month' | 'week' | 'agenda';
    layers: Array<'project' | 'checklist'>;
    editorIds: string[];
    includeUnassigned: boolean;
    stageKeys: StagePresentationKey[]; // one role-independent canonical filter vocabulary
    showCompletedChecklist: boolean;
    showDeliveredProjects: boolean;
    overdueOnly: boolean;
    search: string;
    myTasks: boolean;
  };
};
```

The canonical staff location is rooted at `/`:

```text
/?view=calendar&date=YYYY-MM-DD&sub=month|week|agenda&layers=project,checklist
&editors=<sorted UUIDs>&unassigned=1
&stages=<presentation keys>&completed=1&delivered=1&overdue=1&mine=1&q=<encoded text>
```

`view`, `date`, `sub`, and `layers` are required for a Calendar route so copied links are self-contained. Exact filter defaults are: both layers; `editorIds=[]`; `includeUnassigned=false`; `stageKeys=[]`; `showCompletedChecklist=false`; `showDeliveredProjects=false`; `overdueOnly=false`; `search=''`; and `myTasks=false`. Empty Editor IDs plus `includeUnassigned=false` means no Editor restriction and includes assigned and unassigned rows; `includeUnassigned` becomes an explicit OR branch when an Editor filter is active, or an Unassigned-only filter when true with no IDs. Optional fields equal to these defaults are omitted in URLs, and the same normalized defaults drive API serialization, query keys, Back/Forward, copied links, and localStorage fallback.

`parseStaffPathname` stays pathname-only and continues rejecting `?`/`#`. `parseStaffLocation` gains exactly two allow-listed query branches: existing project `collaboration=open`, and the strict Dashboard Calendar grammar. Parsing is order-insensitive; serialization is fixed-order. The shared route parser/serializer includes `mine=1`, normalizes its absence to `myTasks=false`, and omits it when false. The parser rejects unknown or duplicate parameters, repeated scalar/list fields, malformed percent encoding, noncanonical booleans, uppercase/non-UUID IDs, unsafe text, empty layer sets, hashes, and Calendar params without `view=calendar`. After `URLSearchParams` decoding, apply the existing unsafe-text class `/[\\\u0000-\u001f\u007f]/` to **every decoded query value**, including `q`, so percent-encoded backslash/control characters do not bypass the closed contract.

`staffPathFor` emits parameters in this fixed order: `view`, `date`, `sub`, `layers`, `editors`, `unassigned`, `stages`, `completed`, `delivered`, `overdue`, `mine`, `q`. It sorts/deduplicates list values, percent-encodes through `URLSearchParams`, and omits only documented defaults. Search sanitization is **two separate operations, never conflated**: (a) the `unsafeText` character class (backslash, C0 control characters U+0000-U+001F, and DEL U+007F) is stripped from the search **input state** on every change, so the user always sees exactly what will be searched and an unserializable Calendar URL can never be constructed — interior spaces and other whitespace are preserved so multi-word queries like `smith street` are typable; (b) leading/trailing trim and internal whitespace collapse apply **only** to the debounced value used for `q`, the API query, and the query key. A test types `"a b "` and asserts the input state retains the interior space while the debounced `q` is `"a b"`. Whitespace is not unsafe-text and never affects URL serializability. `safeStaffDestination` round-trips parse -> serialize, preserving canonical Calendar URLs for `router.push`/`replace`, links, and OAuth return. Valid noncanonical parameter order is parsed then canonicalized; duplicate/unknown/invalid data is rejected. Stage filters validate only against `STAGE_PRESENTATION_KEYS`; `editing` is accepted for every role and `editing_autohdr` is rejected for every role. Every Calendar navigation helper builds the canonical location, asserts `safeStaffDestination(built) === built`, and only then calls `history.push`/`replace`; a failed invariant retains the current route and reports a development/test error, never invokes the router's `/` fallback.

`App.tsx` passes `route.calendar` into Dashboard. If the authenticated principal lacks `viewProductionCalendar`, replace the Calendar URL with `/`, render the normal authorized Dashboard view, and never issue the range request. Once a response removes inaccessible IDs in `appliedFilters`, Dashboard `history.replace`s the canonical sanitized Calendar URL without announcing or naming removed IDs.

### Dashboard integration and interaction barrier

Change `DashboardView` to `'list' | 'kanban' | 'calendar'`. The third selector is rendered only with the capability. Archived mode has no Calendar; selecting Archived switches to List, records `list`, and removes Calendar query state. Switching into Calendar records `calendar` and pushes a canonical Calendar URL; subview/date/filter navigation pushes meaningful history entries, while high-frequency search typing uses sanitized debounced `replace` and committed filter changes use `push`. Switching List/Kanban removes Calendar query parameters and records the existing `quincy:dashboard:view` preference.

Calendar uses the same Dashboard `query` state as List/Kanban. **Every write to the shared `query` state strips the `unsafeText` class** (from any view, including List/Kanban keystrokes), so the value is always serializable regardless of which view it was typed in and a switch into Calendar can never fail the `safeStaffDestination(built) === built` invariant. In Calendar the value is URL-owned, debounced, and server-evaluated over the exact role-identical columns above; in List/Kanban it remains the existing immediate client-side filter over `street`, `suburb`, `agencyName`, and `agentName`. Switching views preserves the sanitized value: entering Calendar serializes it as `q`, while leaving Calendar removes `q` with the other Calendar parameters but retains the value for the current session. A Slice 6 case types an unsafe character in List, switches to Calendar, and asserts a canonical Calendar URL with the character absent and no route retention. Reloading a non-Calendar `/` follows the existing local-only List/Kanban behavior and does not invent URL persistence for those views.

Calendar uses two orthogonal gates that must never be merged and must not be folded into the Board's `interactionBlocked`/`movementSettlePending` state machine:

- `calendarInteractionBlocked` is the Calendar **accept gate**. It is true only during drag/resize/external-drop proposal, required confirmation, schedule-editor draft, or pending Calendar mutation. While true, incoming poll/focus/reconnect/broadcast query replacements are deferred against the accepted Calendar snapshot.
- `calendarSettlePending` is the Calendar **command gate**. It begins after a canonical mutation winner and disables every further Calendar mutation activator until the authoritative range refetch is accepted. It must not block query acceptance, the queued-refetch effect, or the settling refetch; that accepted refetch is precisely what clears it. A failed settle keeps it set and exposes recovery.

The Dashboard view selector is disabled by **accept gates only**: `interactionBlocked || calendarInteractionBlocked`. No settle gate may disable a navigation control. `movementSettlePending` stays exactly where TB5B owns it (`movementDisabled` on the Board), and `calendarSettlePending` disables only Calendar mutation activators; it does not disable List/Kanban/Calendar view switching, Dashboard scope navigation, or another escape/recovery navigation control. Calendar date/subview/filter commands that could destroy an active draft use `calendarInteractionBlocked`; settled Calendar navigation remains available, while mutation activators use `calendarInteractionBlocked || calendarSettlePending`. No Calendar gate becomes a member of either Board gate, and no Board accept path reads a Calendar gate. A failed Calendar settle retains its Calendar recovery state but still permits switching to List/Kanban; leaving Calendar cancels the Calendar recovery hold/queued settle bookkeeping without altering the Board settle state. Access loss synchronously cancels both Calendar states, closes dialogs, suppresses private announcements, purges the whole family, and wins over late responses.

Component ownership:

```text
Dashboard.tsx
└── ProductionCalendar.tsx
    ├── ProductionCalendarToolbar.tsx
    ├── ProductionCalendarFilters.tsx
    ├── ProductionCalendarEvent.tsx
    ├── ProductionCalendarUnscheduledPanel.tsx
    ├── ProductionCalendarMoveDialog.tsx
    └── ProductionCalendarScheduleEditor.tsx
```

Exact file grouping may be reduced if small, but `Dashboard.tsx` must not absorb FullCalendar geometry or schedule mapping. Add `apps/web/src/lib/production-calendar-query.ts` for TanStack Query/runtime glue and `apps/web/src/lib/production-calendar-interaction.ts` only for React-free accepted-snapshot/optimism/rollback/focus/announcement orchestration. All civil/date/command mapping remains shared.

Phone behavior:

- Agenda is the phone first-use default. Month remains compact and discloses a selected day's list beneath the grid.
- Week on phone renders the Week view for reading with horizontal/vertical reachability, but disables pointer/touch drag and resize. Every editable item exposes Agenda-style **Move/Reschedule**; this is the locked action-based fallback, not a QA contingency.
- Desktop/tablet Week retains drag and end-resize after real-browser proof. Pointer capability is not inferred only from viewport; coarse pointer plus the phone breakpoint selects action-only behavior.

## FullCalendar v7 dependency and visual boundary

### Exact pins and registry review

**Corrected 2026-08-30 (Slice 3 discovery — factual delta, design unchanged).** FullCalendar v7 **restructured the package layout**: the old separate view/interaction packages (`@fullcalendar/daygrid`, `@fullcalendar/timegrid`, `@fullcalendar/list`, `@fullcalendar/interaction`, `@fullcalendar/scrollgrid`) were **not published at v7** — their npm `latest` is still `6.1.21`, with only a `7.0.0-rc.0` tag. In v7 the plugins are **subpath exports of `@fullcalendar/react`**. The npm registry state (verified via `npm view` on 2026-08-30): `@fullcalendar/core` and `@fullcalendar/react` have a real stable line `7.0.0` (2026-06-19) → `7.0.1` → `7.0.2` (2026-07-24, `latest`); `@fullcalendar/react@7.0.2` depends on `@fullcalendar/core@7.0.2` (exact) and the new **`@full-ui/headless-calendar@7.0.2`** (MIT; its only peer is `temporal-polyfill@^1.0.1` — no Radix, no other runtime deps); `temporal-polyfill@^1.0.1` is a declared **peer** of both, so it is installed directly.

Pin **exactly**:

```json
"@fullcalendar/core": "7.0.2",
"@fullcalendar/react": "7.0.2",
"temporal-polyfill": "1.0.4"
```

`@full-ui/headless-calendar@7.0.2` arrives transitively, pinned by the lockfile (`@fullcalendar/react@7.0.2` requires it exactly). `lucide-react` remains the existing `1.34.0`.

**Import model (v7):**

```ts
import FullCalendar from "@fullcalendar/react";
import { dayGridPlugin } from "@fullcalendar/react/daygrid";
import { timeGridPlugin } from "@fullcalendar/react/timegrid";
import { listPlugin } from "@fullcalendar/react/list";
import { interactionPlugin } from "@fullcalendar/react/interaction";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/pulse/theme.css";
// optional palette: "@fullcalendar/react/themes/pulse/palettes/<name>.css"
```

Standard views only. **No premium / resource / Scheduler**: do not import `@fullcalendar/react/premium` or any resource/timeline subpath, and no `@fullcalendar/premium`-style package (they no longer exist under that name). At build time, npm metadata checks may verify availability, integrity, provenance, and peer ranges of exactly `@fullcalendar/{core,react}@7.0.2` + `temporal-polyfill@1.0.4`; they may not substitute a newer version. A newer stable `7.0.x` or the plugin packages reaching real v7 stable is a plan-review delta, not an in-slice change.

`@ilamy/calendar` was evaluated on a throwaway branch on 2026-08-30 and rejected because its public TypeScript definitions and compiled JavaScript expose no external-drop/`eventReceive` API; FullCalendar Interaction's public `Draggable` plus `drop`/`eventReceive` is therefore the canonical path for the required Unscheduled-panel drop.

Before adoption:

1. Add/verify the `@fullcalendar` registry mapping `https://shadcn-registry.fullcalendar.io/{name}.json` in `apps/web/components.json`. The baseline has `style: "base-sera"` and no `registries` key, so this is an explicit additive key at that exact path.
2. Fetch and record the registry JSON for **all five** flavor items (`<flavor>-event-calendar.json`) as the documented "reviewed specialist source" comparison. Each declares `dependencies: @fullcalendar/react@^7.0.1, lucide-react, temporal-polyfill@^1.0.1` and `registryDependencies: [button, tabs]` and writes a demo + calendar wrapper + toolbar + icons + views. Then either run `npx shadcn@latest add @fullcalendar/pulse-event-calendar` and prune, **or** — if inspection shows the generated toolbar/demo only couples to shadcn `button`/`tabs` (the second-primitive-system the plan forbids; Quincy is Base UI) — skip `add`, import the theme CSS directly from `@fullcalendar/react/themes/pulse/theme.css`, and write the thin wrapper against Quincy primitives. Document which path was taken and why. D-16's "reviewed specialist source" obligation is met by the JSON inspection either way.
3. Inspect every generated/modified file and the full direct/transitive dependency tree (`npm ls --all` plus lockfile diff). The only expected new runtime packages are `@fullcalendar/core@7.0.2`, `@fullcalendar/react@7.0.2`, `@full-ui/headless-calendar@7.0.2`, `temporal-polyfill@1.0.4`. Any `@radix-ui/*` addition is a red flag — resolve it (the FullCalendar packages themselves pull no Radix; only a taken shadcn `button`/`tabs` would). Retain only the Calendar-specific source needed for Standard views; remove any demo; do not accept a duplicate general Button/Tabs system.
4. Verify package peer ranges against pinned React/React DOM `19.2.8`; fail the slice on peer warnings, duplicate React, premium/resource packages, unpinned versions, postinstall scripts, or an unexplained primitive package.
5. Verify `@fullcalendar/react@7.0.2` + `@fullcalendar/core@7.0.2` + `@full-ui/headless-calendar@7.0.2` and the peer `temporal-polyfill@1.0.4` resolve and build cleanly under Vite 8 production build, happy-dom, and both Node configs (FullCalendar uses Temporal internally; Quincy code does not). Confirm the subpath exports (`@fullcalendar/react/{daygrid,timegrid,list,interaction,skeleton.css}`, `@fullcalendar/react/themes/pulse/theme.css`) resolve under the repo's module resolution. Assert that `packages/shared`, `workers/app`, and the Quincy Calendar adapter/mappers import no `Temporal` and no `temporal-polyfill` — the callback adapter is built on the existing `@quincy/shared` civil-time helpers per §"Display-zone binding".

### Flavor and CSS decision

Provisionally pin **Pulse**. FullCalendar v7 describes Pulse as its minimal Apple-like flavor; among Monarch (Material 3), Forma (Fluent), Breezy (Tailwind Plus), Classic (legacy FullCalendar), and Pulse, it imposes the least competing product vocabulary and is the best starting point for Quincy's sparse editorial surface. Users never select a flavor.

**Delta 2026-08-30 (Slice 3 build):** a **pre-existing** circular-import bug in the `@quincy/shared` barrel (`external-project-dto.ts` ↔ `external-upload.ts`) crashes the whole SPA under `vite serve` — it reproduces on clean `main`, is invisible to the bundled production build and to vitest, and is tracked as a separate fix (spawned task). It blocks a throwaway Vite dev harness route from rendering. Therefore:
- Slice 3's real-browser DST/flavor proof is **carried to Slice 5** (the first product UI slice, where Agy renders the real Calendar in a real browser anyway — no verification is lost, only its timing). Slice 3 acceptance is met without it: exact pins, clean install (no Radix, single React, no premium), typecheck/build/tests green, and the adapter's fold/gap equivalence unit tests.
- The `apps/web/src/dev/production-calendar-harness.tsx` + its `apply:"serve"` Vite middleware are **committed as a dev-only artifact** (proven absent from the production build) and used for the Slice 5 browser proof once the circular fix lands; they are removed in Slice 5/closeout.
- The 5-flavor comparison for Slice 3 is the **documented registry-JSON/CSS-level comparison** (all five `<flavor>-event-calendar.json` inspected); Pulse is provisionally pinned by importing `@fullcalendar/react/themes/pulse/theme.css` directly and mapping its supported CSS variables. The matched-screenshot visual comparison at 1440x900 / 1024x768 / 390x844 happens in Slice 5 against the harness; if it selects another flavor, re-point the one theme import + variable map before Slice 6.

**Delta 2026-08-30 (Slice 5 build):** the carried browser proof is **done** — see `docs/plans/tb5c/slice-5-browser-proof.md`. The `vite serve` circular blocker was fixed first (`f6af664`, merged to `main`, TB5C rebased). Ran against the harness in a live `Asia/Kuala_Lumpur` (UTC+8, no DST) browser: FC v7 `timeZone="Australia/Sydney"` renders the April fold (both 02:30 occurrences) and the October gap (nothing in the missing hour) correctly in Month/Week/List; all 24 Week hour labels are Sydney hours; `fullCalendarCallbackToSydneyCivil` round-trips all six fold/gap/all-day shapes with the browser zone having zero influence. Pulse maps to Quincy tokens live (Warm Paper / Ink / Apfel Grotezk) — **no flavor re-point**. **Harness + its Vite middleware removed**; `vite.config.ts` restored to its pre-Slice-3 form; production build re-proven (main bundle back to the ~1,223 kB Slice-3 baseline, Calendar is a `React.lazy` route chunk — 274 kB JS / 22 kB CSS — loaded only when a capable principal opens the view). One extra dev-only fix was needed to render the harness at all: its middleware now runs the HTML through `server.transformIndexHtml` for the `@vitejs/plugin-react` preamble (deleted with the harness).

Import the v7 skeleton and registry-selected theme CSS through one Calendar-only stylesheet. First map every supported flavor CSS variable and add only scoped Quincy structural/token overrides under a `.production-calendar` wrapper (Ink, Warm Paper, signals, focus, and surfaces); do not copy the upstream palette or theme into `app.css`. Fork an upstream palette source only if source review proves the registry CSS cannot be adapted through supported variables plus scoped overrides. If a fork is necessary, record the exact unsupported need, upstream version/path, copied lines, and maintenance rationale, and keep the fork Calendar-only. Tailwind v4/Preflight remains under the existing platform contract. No dark-mode surface is added.

FullCalendar owns view geometry, event drag/resize, external-drop hit-testing, scroll, and drag mirror. Quincy supplies its own toolbar, filter bar, event content, dialogs, permission/read-only states, URL integration, and responsive treatment. Every view binds `timeZone={PRODUCTION_CALENDAR_ZONE}` exactly as specified in **Display-zone binding**. Set `selectable=false`; `dateClick` may be wired only for selected-day disclosure/focus through the Sydney adapter, never creation, and empty space creates nothing.

## Direct manipulation contract

Every operation applies the eight TB5B rules:

1. explicit source capability and authorized projection;
2. immutable interaction-start snapshot plus optimistic proposal;
3. guarded canonical command with source concurrency token;
4. stale rollback/refetch with no automatic retry;
5. refresh deferral/reconciliation, with access-loss purge first;
6. keyboard and complete non-drag action;
7. deterministic focus and announcement lifecycle;
8. confirmation-gated optimism—no optimistic move before required confirmation; if the server unexpectedly requires confirmation, synchronously roll back before opening it and never send client-classified confirmation reasons.

Unlike TB5B, FullCalendar owns geometry. A Quincy interaction adapter snapshots the accepted DTO and translates FullCalendar callbacks into a shared command mapping. The optimistic event overlay stays component state, never query-cache state. Only one Calendar mutation/confirmation is active at once.

### Project Deadline mapping

Project Deadline is draggable only when `permissions.canDrag` and never resizable.

```ts
mapProjectDeadlineMoveToCommand({
  event,
  target: { subview, targetDate, targetCivilMinute? },
  disambiguation?,
}): CalendarMappingResult<SaveProjectDeadlineRequest>
```

- Month changes only the `YYYY-MM-DD` portion of `deadlineLocalCivil`, retains its `HH:mm`, and re-resolves it in Sydney.
- Week takes the FullCalendar Sydney target, snaps to a 15-minute civil minute before mapping, and sends that civil time.
- Agenda and all keyboard/non-drag paths open the same Move/Reschedule editor.
- The request is exactly:

```ts
{
  expectedVersion: event.deadlineVersion,
  deadline: { localCivil: shiftedCivil, ...(disambiguation ? { disambiguation } : {}) },
  reminderOffsetsMinutes: [...event.reminderOffsetsMinutes]
}
```

No offset is added, removed, or recomputed. A normal scheduled Project move must replay the existing offsets exactly.

Before optimism, call the existing promise-based confirmation singleton with Calendar content: old -> new Sydney civil time and a reminder consequence list. The pinned rendering seam is `ConfirmOptions` in `apps/web/src/lib/confirm.ts` plus the `ConfirmDialog` host in `apps/web/src/components/ConfirmDialog.tsx`, which currently renders `<p>{message}</p>`. Add optional `content?: ReactNode` while keeping `message: string` required; `ConfirmDialog` renders the message and additive content together. Preserve all 19 production `confirm({...})` text call sites across nine files, option normalization, FIFO singleton queue, focus trap/return, Escape/cancel, and the existing `ConfirmDialog.dom.test.tsx` queue/focus coverage, with new backward-compatibility and rich-content host tests. The shared preview helper resolves each unchanged offset against old/new Deadline, given a captured `now`, and labels whether it remains future, becomes `elapsed_at_save`, or fires at a different Sydney wall-clock hour because the offset crosses a DST transition. It is preview copy only; `saveProjectDeadlineSchedule` remains authoritative.

If the proposed Deadline is a repeated Sydney time, resolve Earlier/Later **before** building/showing confirmation, then compute reminder consequences from that chosen instant. Confirmation never previews an unresolved fold. If the server unexpectedly returns `deadline_repeated_local_time` after confirmation, roll back, retain the draft, collect the fold choice, rebuild the consequence preview, and show a new confirmation; never resubmit directly.

Confirmation cancel restores source geometry/focus without a request. Accept applies the optimistic proposal then `PUT /api/projects/:id/deadline`. Handle:

- `409 deadline_version_conflict` with `{current}`: revert, replace/refetch authoritative state, no retry, preserve the user's proposed civil value in the Move dialog if they choose to reapply;
- `409 deadline_project_archived` / `deadline_project_delivered`: revert, refetch/purge as appropriate, disable movement;
- `400 deadline_nonexistent_local_time`: revert, retain draft, explain Sydney DST gap;
- unexpected `400 deadline_repeated_local_time`: revert/hold source, ask Earlier/Later, rebuild reminder consequences, and re-show confirmation using the same expected version and offsets; never resubmit directly;
- `400 deadline_invalid_reminder_offsets`: revert/refetch because the carried source offsets are no longer valid; never normalize silently;
- `400 deadline_invalid_version`: rollback, focus the source/replacement event, announce invalid source version, refetch, and require a fresh user action;
- `400 deadline_invalid_local_time`: rollback, retain/focus the draft, announce the invalid Sydney civil input, and send no retry;
- `400 deadline_resolver_defect`: rollback, focus the source/recovery action, announce that scheduling could not be resolved, and refetch without retry;
- `404 project_not_found`: rollback, refetch/purge the missing event as authoritative, focus the safe Calendar fallback, and announce unavailability without street details;
- `401`/`403`: apply access-loss precedence—cancel, purge the whole Calendar family, close confirmation/editor, suppress event-specific late announcements, and focus the safe Dashboard route/control.

### Checklist mapping

All mappings use the event's complete five-state `schedule`; its sole version authority is `schedule.version`:

```ts
{
  schedule: {
    expectedVersion: event.schedule.version,
    schedule: mappedInitialChecklistScheduleInput
  }
}
```

sent through the unchanged `PATCH /api/projects/:projectId/subtasks/:subtaskId`.

- Due-only milestone drag changes its due endpoint; it is never resizable.
- Range drag is a **whole-block move** that preserves duration: both endpoints shift by the same civil delta and each is independently re-resolved through `resolveSydneyCivilMinute` (never epoch + elapsed milliseconds — that drifts across DST). **Month** granularity is whole days, so each endpoint keeps its own wall-clock `HH:mm`. **Week** granularity is the full civil-minute delta of the drag (a vertical drag shifts both endpoints' `HH:mm` by the same amount; a purely horizontal day-column drag leaves `HH:mm` unchanged) — clarified with Terry 2026-08-30. It is a move, not a reshape: to change one endpoint's time independently, use end-resize or the schedule editor.
- Month drag changes whole dates. Date endpoints remain dates; timed endpoints retain each endpoint's civil minute. FullCalendar supplies an **exclusive** all-day range `end`; the Month whole-day drag mapper validates it and subtracts exactly one calendar day before assigning the inclusive `InitialChecklistScheduleInput.end.localCivil`. A missing/non-advancing exclusive end is rejected locally. Timed ends are already half-open instant/civil endpoints and are used verbatim—no day subtraction.
- Week drag snaps the proposed start to 15 minutes, computes the civil-date/minute delta, and maps both endpoints without elapsed-duration arithmetic.
- End-edge resize changes only the end, with Month whole-date or Week 15-minute snapping. In `mapChecklistEndResizeToCommand`, a FullCalendar all-day exclusive `end` is validated and reduced by exactly one calendar day to produce TB4D's inclusive date endpoint; a timed end is used verbatim under the half-open timed contract. Start-edge resize is disabled and rejected locally with zero request. Pin the two-day resize case: a one-day all-day range starting on day `D` whose FullCalendar exclusive end becomes `D+2` must send inclusive `end.localCivil = D+1`, never `D+2`.
- Agenda uses Move/Reschedule. The explicit editor—not drag—owns timed/date-only and due-only/range conversions and supplies complete homogeneous endpoint input.
- Shared mapping validates date components directly, resolves endpoints independently, and passes resulting `InitialChecklistScheduleInput` through `normalizeChecklistSchedule` before returning a request.

Handle:

- `409 subtask_schedule_version_conflict` with `{current}` and optional `{currentSubtask}`: rollback, show latest/current, no retry;
- `409 subtask_item_conflict`: rollback and adopt/refetch `currentSubtask`, no retry;
- `503 subtask_schedule_ranges_disabled`: rollback, adopt/refetch authoritative state, announce that range scheduling is unavailable, disable every range-producing drag/resize/external-drop/editor option from the server permissions, and do not retry automatically;
- `422 subtask_schedule_storage_invalid`: rollback, show needs-attention copy with only the existing non-Calendar repair path if one exists; no Calendar editor and no retry. A `legacy_unresolved` editor save uses the versioned `scheduleRequest` with expected version 0; `subtask_schedule_reload_required` from an accidental legacy branch is a mapping defect, rolls back/refetches, and never falls back to that branch;
- TB4D validation errors including nonexistent, repeated-with-choices, invalid order, mixed endpoint kinds, missing endpoint, invalid local time/version, and resolver defect. Gap rejects/reverts; fold asks per affected endpoint and re-maps only after explicit choices.

The PATCH success body is role-divergent: `project-subtasks.ts` returns the Worker-local `ProjectSubtaskDto` (`project-subtasks.ts:31` — not in `@quincy/shared`, no zod schema, no current web consumer) for Admin/internal Editor, and `externalChecklistItemSchema` for External Editor. `apps/web/src/lib/production-calendar-query.ts` therefore exports a principal-domain mutation decoder selected from the captured principal before the request: the External arm reuses the existing strict `externalChecklistItemSchema`/external checklist decoder (strictness there is a privacy boundary). The internal arm is a **narrow, non-strict** schema over only the fields the Calendar reconciles from a checklist mutation — `id`, `title`, `done`, `assignee`, `position`, `schedule`, `scheduleVersion` (derived from `schedule.version`) — so a future additive field on the Worker DTO cannot become a runtime parse failure that breaks internal Calendar checklist mutation. Never parse both roles through one structural DTO or fall back after a failed chosen decoder. Slice 8 records that the internal DTO has no compile-time link to the shared schema and the decoder is intentionally tolerant of extra keys.

Success reconciles from that returned canonical subtask DTO. For a Calendar schedule-only command, if the returned canonical schedule is semantically equal to the accepted source and its `schedule.version` is unchanged, treat the service's `outcome:'noop'` as a successful no-op: adopt the returned item, clear optimism, announce “No change,” clear `calendarInteractionBlocked` (the settle gate was never set on this path — it is set only after a changed canonical winner), then flush any refresh that was deferred during the interaction as exactly one queued refetch — identical to the cancel path — publish nothing, and do not invent a version bump or a settle gate. A changed canonical response invalidates the range family and project subtask/detail keys, publishes the ID-free Calendar invalidation plus existing ID-safe invalidations, and sets `calendarSettlePending` until the authoritative range refetch is accepted. It clears `calendarInteractionBlocked` before that refetch so acceptance cannot deadlock.

### Unscheduled defaults

- Project -> Month: `17:00` Sydney on target date, `expectedVersion` from entry, `reminderOffsetsMinutes:[]`, confirmation required.
- Project -> Week: target 15-minute Sydney slot, same empty offsets and confirmation.
- Checklist -> Month: date-only due milestone on target date.
- Checklist -> Week: timed one-hour range `[target snapped to 15 minutes, target + 60 civil minutes]`, resolved in Sydney. If the end crosses a DST gap/fold, use the same reject/choice path rather than elapsed-time coercion.
- Agenda has no external drag; Move/Reschedule supplies the same defaults in a dialog.
- External Editor may drag/move valid `unscheduled` checklist entries; `legacy_unresolved` is editor-action-only and `invalid` is read-only. Project entries have real disabled controls and no draggable data.
- Empty Calendar space has `selectable=false`, no creation callback, and creates no work.

### Refresh and terminal behavior

At interaction start, snapshot the accepted response, event, filters, principal identity, and focus descriptor. While `calendarInteractionBlocked` is true (proposal/confirmation/editor draft/mutation), defer poll/focus/reconnect/broadcast replacements and coalesce them to exactly one queued refetch. On cancel/error, restore the snapshot, clear the accept gate, then perform/accept one refetch. On a changed success, reconcile the returned canonical source item, clear `calendarInteractionBlocked`, set `calendarSettlePending`, then perform exactly one authoritative range refetch (shared with any queued refresh); the checklist no-op exception above clears the accept gate and flushes the queued refetch exactly as the cancel path does, never setting the settle gate. Query acceptance remains enabled during settle; accepting that refetch clears `calendarSettlePending`. If it fails, keep only the command gate set with a visible recovery action, and let a later successful authorized refetch clear it; do not treat optimistic state as accepted.

Any authorization epoch/session/project-membership loss cancels in-flight requests, suppresses event-specific announcements, removes every Calendar query, closes Calendar dialogs/panels, and returns focus to a safe Dashboard control or safe route. Late callbacks compare the captured principal/access token and cannot repopulate or announce private street/Stage data.

## Numbered implementation slices

No slice is a production deploy. Each slice starts from the previous green commit, owns all test changes needed by its code, and ends with the same four-command gate from `portal/`. Luna/codex sandbox constraints do not weaken evidence: the orchestrating session runs `workers/app`/`workers/background` suites and all commits outside the sandbox when required.

**Gate command note (established Slice 0):** with the installed npm (11.x), a bare `npm run test --workspaces` exits non-zero because `@quincy/shared` has a vitest config but no `test` script (`packages/shared/package.json`). The gate uses `npm run test --workspaces --if-present` (equivalently `npm run test`), which cleanly runs every workspace that has a `test` script and skips `@quincy/shared`; the fourth command (`npx vitest run --config packages/shared/vitest.config.ts`) is what covers `@quincy/shared`. Slice-0 baseline on `tb5c-production-calendar` (no production source changed): typecheck 6 workspaces clean; `@quincy/web` build clean; `--if-present` workspace tests all green (23 / 19 / 35 / 19 / 37 / 1 test files, exit 0; workers/app has 1 skipped); `packages/shared` vitest 16 files / 99 tests green.

### Slice 0 — characterization and inventory

Production code remains unchanged.

- Characterize `DashboardView`, `quincy:dashboard:view`, Kanban sort storage, storage exception behavior, archived mode, search ownership, and every `interactionBlocked` transition.
- Pin every `staff-routes.ts` accepted/rejected location, `safeStaffDestination`, OAuth callback, history adapter, InternalLink, and `App.tsx` consumer.
- Record exact TB4B request/response/error shapes and the synthetic Calendar adapter equivalence tests; record TB4D five-state DTO, PATCH envelope, conflict details, and schedule validation errors.
- Record `ConfirmOptions`/singleton queue/focus behavior and TB5B's eight-rule policy, focus descriptor, announcement ownership, accepted-snapshot barrier, and access-loss precedence.
- Inventory TB4E Calendar stub, `EXTERNAL_API_RESPONSE_SCHEMAS.calendar`, `visibleProjectWhere`, strict select conventions, whole-family purge reservation, route-security manifest, exact capability arrays, `/api/me` length, and every absent-Calendar assertion.
- Inventory schema columns and prove the app-side command ownership / background scanner-only boundary.
- Add characterization tests only where current contracts lack executable pins. Save an implementation inventory note beside the slice handoff, not as claimed product behavior.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: current behavior is executable; every temporary TB4E assertion to flip and every route/parser consumer to change is enumerated; production source output is unchanged.

### Slice 1 — shared Calendar domain, DTOs, and mappings

- Add/export `production-calendar.ts` with strict request/filter/DTO/external schemas, constants, date/civil shift helpers, Project/checklist/Unscheduled command mappers, and reminder consequence preview.
- Export `STAGE_TRANSPORT_KEYS` from `stage-move.ts` and `index.ts`, while building the Admin Calendar project-context schema with the tighter `z.enum(STAGE_KEYS)` and non-Admin schemas with `z.enum(STAGE_PRESENTATION_KEYS)`. Use named checklist schedule aliases, omit duplicate top-level `scheduleVersion`, and pin the aliases with `expectTypeOf`.
- Finalize `ExternalCalendarRangeDto`, remove the TB4E stub duplication, and point `EXTERNAL_API_RESPONSE_SCHEMAS.calendar` to the new strict schema.
- Keep `viewProductionCalendar` absent in this slice; capability grants and all exact `/api/me` assertions move atomically with the fully mounted endpoint in Slice 4. Record the plan-only route-manifest reservation, but do not add a manifest row before a real route exists.
- Test component-valid date arithmetic without `Date` parsing; canonical filters with distinct Zod input/output types; response unknown-key rejection; role-safe project-context Stage keys; no Board/provider/contact/email fields; and all five checklist source states in their only valid projection branches. Build checklist schemas as unions of complete strict objects; assert scheduled schemas accept only `due_only | range`; plain Unscheduled accepts only `unscheduled` without `attentionReason`; needs-attention requires the matching `attentionReason` plus `legacy_unresolved | invalid`; invalid and legacy permissions cannot enable drag/resize; invalid cannot enable the editor; and every cross-combination/unknown key has `safeParse(...).success === false` without pinning issue paths. Construct and exercise the Admin, internal-Editor, and External schemas with their concrete Stage enums.
- Add real Sydney DST cases: month and week shifts across the October gap and April fold; gap rejection; fold choices; endpoints independently selecting offsets; timed range preserving each endpoint wall time rather than elapsed duration; date-only inclusive -> FullCalendar-exclusive end; Project 17:00 and checklist Month/Week defaults; reminder offsets unchanged and consequence classification.
- Audit zero `Temporal` import in shared/server.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: shared tests own every pure rule, the finalized strict External DTO exists, and there is still no capability grant or web/server Calendar wiring.

### Slice 2 — strict Dashboard Calendar routing

- Extend `StaffRoute`, `parseStaffLocation`, `staffPathFor`, and `safeStaffDestination` with the exact Calendar-only Dashboard query grammar; leave List/Kanban localStorage-only.
- Apply unsafe-text rejection to every decoded query value, and sanitize/collapse Calendar `q` in the state layer before serialization. Calendar push/replace helpers assert their built URL is a `safeStaffDestination` fixed point before navigation.
- Update shared/web router tests, `App.tsx` route handoff, OAuth destination/auth tests, InternalLink/history tests, and security cases for unknown/duplicate/malformed params.
- Prove canonical ordering/deduplication, Back/Forward notification, copied-link round trip, and Calendar query preservation through safe destination. Add a matrix for raw and percent-encoded backslash, NUL, C0 controls, CR/LF, and DEL: input sanitization must retain the current Calendar route rather than collapse it to `/`, parsing must reject encoded unsafe values, no control character may round-trip, and `safeStaffDestination(fullCanonicalCalendarUrl) === fullCanonicalCalendarUrl`. Pin `mine=1` parse/serialize and round trip, absence -> `myTasks=false`, false omission from canonical URLs/API queries, and its position before `q`. Prove `stages=editing` round-trips for every role while `stages=editing_autohdr` is rejected for every role. Prove the existing `?collaboration=open` branch is unchanged.
- Add Dashboard helper functions for URL-first initial state and try/catch storage fallback without rendering Calendar yet.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: every valid Calendar location round-trips canonically; every unknown query remains closed; existing routes/OAuth callbacks remain green.

### Slice 3 — dependency and registry adoption

- Verify availability/provenance of exactly `@fullcalendar/core@7.0.2`, `@fullcalendar/react@7.0.2`, `temporal-polyfill@1.0.4` (v7 uses `@fullcalendar/react` subpath plugins, not separate view packages — those stopped at v6); add those exact pins, update lockfile, record `portal/package.json` diff; `@full-ui/headless-calendar@7.0.2` is the expected transitive; any other version discovery returns to plan review without substitution.
- Add the additive `registries` key to `apps/web/components.json`; fetch + document the JSON of all five `<flavor>-event-calendar.json` registry items (deps, registryDependencies, files, theme approach). `npx shadcn add` may be **skipped** when the item only couples to shadcn `button`/`tabs` (Radix — Quincy is Base UI): import `@fullcalendar/react/themes/pulse/theme.css` directly and write a Quincy-owned thin `ProductionCalendar` wrapper. D-16's "reviewed specialist source" is met by the JSON inspection either way.
- Verify React 19.2.8 peers, single React resolution, Standard-only subpath plugins, no premium/resource, no new `@radix-ui/*`, and no second Button/Tabs/general primitive system.
- Add the Calendar-only CSS import boundary (`apps/web/src/styles/production-calendar.css` — skeleton + Pulse theme, not in global layers) and scoped Quincy token overrides under `.production-calendar`; no product route renders it yet.
- Add the `fullCalendarCallbackToSydneyCivil` adapter (`apps/web/src/lib/production-calendar-fullcalendar.ts`) built only on `@quincy/shared` civil-time helpers (no `Temporal`), with a fold/gap equivalence test.
- Add smoke tests that import the retained component/plugins/styles under Vite 8 build, happy-dom, and Node configs. Prove `packages/shared`, `workers/app`, and the Quincy adapter/mappers import neither `Temporal` nor `temporal-polyfill`.
- Commit the dev-only Vite harness (`apps/web/src/dev/production-calendar-harness.tsx` + its `apply:"serve"` middleware) — proven absent from the production build graph. It is used for the **Slice 5** real-browser DST/flavor proof (deferred from this slice due to the pre-existing `vite serve` circular bug; see the delta note in §"Flavor and CSS decision") and removed in Slice 5/closeout.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: exact dependency/lock/CSS delta resolves, typechecks, builds, and passes smoke tests with no peer/provenance/Radix failure; the adapter fold/gap unit test passes; the harness is absent from the shipped bundle. The non-Sydney real-browser gap/fold rendering + callback proof and the matched-screenshot flavor comparison are carried to Slice 5. No production chunk/network claim (no product route references the component yet).

### Slice 4 — capability launch contract and complete three-principal range endpoint

- Add `viewProductionCalendar`; grant Admin, Editor, and External Editor; keep Photographer absent; update the exact capability arrays, External length 11, `/api/me`, and absence assertions listed above in this same slice.
- Add both route forms with path-scoped `viewProductionCalendar` middleware, add both `ALL` `.use` entries to `CHECKED_IN_MIDDLEWARE_REGISTRATIONS`, widen `externalSurface` with `'calendar'`, and mount one handler only after it contains Admin, internal Editor, and External branches.
- Implement strict role-independent `StagePresentationKey` filter parsing and the at-most-two-statement visible-project/subtask normalized projection. Expand `editing` once for SQL. From first mount, External composes `visibleProjectWhere`, uses an explicit External select map, emits only `StagePresentationKey` in project context, and strict-parses with `EXTERNAL_API_RESPONSE_SCHEMAS.calendar`; role-domain internal responses use their concrete strict schema and Admin retains `editing_autohdr` in project context.
- Serialize project/checklist events, read-only schedule-needs-attention entries, range-derived facets, sanitized applied filters, principal-specific Collaboration permissions, overlaps, density refusal, and 50/50 truncation metadata.
- Register one `scoped` terminal/security row per GET route form with `externalSurface:'calendar'` (never duplicate rows by role); add `/api/production-calendar` (both forms) to `securityClassForSeed`'s `scoped-project` allow-list; add both `.use` entries to `CHECKED_IN_MIDDLEWARE_REGISTRATIONS`; add `probes.calendar` + `expectedScope.calendar` (`'assigned-project'`) to `route-manifest.test.ts`; and replace the TB4E reservation with a live strict-schema probe.
- Integration tests use real Admin, internal Editor, External Editor, and Photographer sessions. Assert 401/403; range bounds/Month padding; at most two D1 `.all()` calls and no N+1; JSON-array list binding with constant parameter count; pre-D1 list/query-byte caps; archived exclusion; delivered/overdue/completed/layer/Editor-OR/Unassigned/Stage/search/My-tasks filters; role-safe Stage; checklist counts; principal-specific and range-flag-specific permissions; date/timed intersection; 50/50 data; no hidden/contact/Board fields; stable order; overlap; and trailing-slash parity. Record `EXPLAIN QUERY PLAN`, Worker CPU time, and response bytes for the measured 20/100-per-project dense fixtures and over-10,000 `calendar_range_too_dense`, including the deliberate full scans without deadline/schedule range indexes. Stage-filter cases accept and expand `stages=editing` for every authorized role and reject `stages=editing_autohdr` pre-D1 for every role. Search tests use exactly street, suburb, agency display, agent display, and checklist title for all roles; exclude notes; prove ASCII case folding; and execute an identically-cased 200-character multibyte literal without a SQLite/D1 LIKE-pattern error, without claiming Unicode case folding.
- External cases include assigned, unassigned, archived, and removed-membership projects; all assigned work by default (not only My tasks); unassigned checklist items; Deadline read-only; valid checklist permission; inaccessible filter stripping; and rejection of participant email/contact/notes/raw Stage/Board/provider fields. Strict External parsing must fail on any extra field.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: the capability points only at a complete mounted handler; all three authorized audiences receive bounded strict responses on both route forms, Photographer receives 403, and query-count/privacy/density assertions pass.

### Slice 5 — read-only Calendar UI and query family

- Add `useProductionCalendarRange`, query-key constructor, principal-domain response decoder (including the strict External parse), and whole-family purge helper with TB2 freshness behavior.
- Add the component tree, Quincy toolbar, Month/Week/Agenda mapping, event renderers, loading/error/empty states, and selected-day Month disclosure.
- Bind every FullCalendar instance to `timeZone={PRODUCTION_CALENDAR_ZONE}` and label the toolbar visibly and accessibly as `Sydney time · AEST` or `Sydney time · AEDT` for the active date/range; a range crossing a transition uses `Sydney time · AEST/AEDT` rather than a misleading single abbreviation.
- Add Calendar as a capability-gated third Dashboard view; hide it for Photographer; enforce active-only scope.
- Wire URL-first state, canonical range derivation, Back/Forward, localStorage fallback, Sydney today, desktop Month/phone Agenda first use, and storage exceptions.
- Render server permissions as real disabled/read-only controls but issue no mutation yet. Independently hard-disable FullCalendar editing with `editable={false}`, `eventStartEditable={false}`, `eventDurationEditable={false}`, and `droppable={false}` regardless of DTO permissions; no `eventDrop`/`eventResize`/external-drop mutation handler is registered until Slices 7/8/9 deliberately flip the corresponding option.
- DOM/Node tests use fixtures parsed by the authenticated principal's concrete Admin, internal-Editor, or External response schema and derived from actual server projections. Cover view switching, URL round trip, storage failure, event state/Stage/checklist presentation, Agenda, Month disclosure, External read-only Deadline, and no Calendar query for withheld role.
- Agy proves the routed production Calendar chunk/CSS loads, then proves real FullCalendar Month/Week/Agenda geometry, navigation, scrolling, selected-day disclosure, and console/network cleanliness; happy-dom claims only wiring/markup.
- **Carried from Slice 3** (the `vite serve` circular fix must have landed first — spawned task; if not, this slice's browser work waits on it): against the committed dev harness in a real browser whose OS/browser zone is **not** Sydney, spanning the April 2026 fold + October 2026 gap, render Month / 24-hour Week / List with `timeZone="Australia/Sydney"` and assert timed ISO instants show correct AEST/AEDT offsets, all-day `YYYY-MM-DD` values keep their dates/exclusive ends, all 24 Week hour labels are Sydney-correct, and `eventDrop`/`eventResize`/`drop`/`dateClick` round-trip through `fullCalendarCallbackToSydneyCivil` without reading the browser zone (record the browser zone + callback payloads). Also capture the matched Pulse-flavor screenshots at 1440x900 / 1024x768 / 390x844 against current Dashboard evidence; if evidence selects another flavor, re-point the one theme import + variable map before Slice 6. **Remove the harness + its Vite middleware after this proof passes** and re-prove the production build is unchanged.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: all three authorized audiences can read their correct Calendar projection; browser evidence covers Sydney labels and geometry/scroll; all four component-level editing options remain false and no mutation callback is active.

### Slice 6 — filters, canonical URL, and access-loss purge

- Complete Projects/Checklist layer toggles, multi-Editor OR plus Unassigned, Stage multi-select, completed/delivered toggles, overdue-only, My tasks, and Dashboard search. Project facets remain response context only and are never rendered as a project multi-select.
- Reuse the Dashboard `query` state: Calendar sanitizes/serializes/debounces it for the role-identical server columns, while List/Kanban retain their existing immediate client filter. Test the documented in-memory preservation and URL removal/creation on view switches.
- Keep filter changes in URL/query identity; apply server `appliedFilters` by replace to remove inaccessible IDs; Back/Forward and copied links restore the same authorized slice.
- Integrate whole-family cancellation/removal into `PrincipalFreshnessBoundary` before UI-loss signaling and into terminal cleanup tests. Close Calendar disclosure/dialog state on purge.
- Test each filter alone and in combinations, canonical list ordering, unsafe-search sanitization and fixed-point debounced replace versus committed push, no hidden facet, project loss during active query, late response suppression, and entire-family removal across multiple cached ranges.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: filter/query/URL state is deterministic and shareable; inaccessible IDs disappear without disclosure; membership loss leaves no Calendar range cache.

### Slice 7 — Project Deadline direct manipulation

- Add the Calendar interaction orchestrator's accepted snapshot, optimistic overlay, focus descriptors, announcement builder, interaction barrier, and one-command serialization.
- Wire Month/Week project drag and Agenda/keyboard Move/Reschedule through the shared mapper and unchanged PUT command.
- Extend the confirmation singleton additively for rich Calendar content. Show old/new Sydney civil time and each unchanged reminder offset's predicted consequence; optimism begins only after accept.
- Implement all TB4B conflict/DST/terminal/error arms, no automatic retry, authoritative refetch settle, recovery hold, and draft-preserving reapply path.
- Tests assert exact request body, zero request on cancel/disabled/unchanged target, 15-minute snap, Month wall-time preservation, offset identity, gap/fold handling, confirmation queue/backward compatibility, rollback/no-retry, focus/announcements, refresh deferral, and terminal suppression. A failed Calendar settle must still allow switching to List/Kanban; that switch clears Calendar recovery/queued-settle state and leaves TB5B's Board settle behavior unchanged.
- Agy proves real drag/drop/scroll/focus/modal timing for Admin and read-only rendering for Editor/External.

**Delta 2026-08-30 (Slice 7 build, commit `a5e2acf`):** built + fresh-Sol REVISE (3 Blocking: stale-refetch adoption w/o an op-token guard; a dead-end direct-dialog DST fold; a no-op check comparing only the civil string) → Luna fix round → fresh-Sol confirm **APPROVE**; 4 post-APPROVE Should-fixes folded in. **The real-drag GESTURE + adapter half of the Agy proof is DONE** via a throwaway dev harness (`/__drag-harness`, removed at slice close) driven with real mouse drags in a live `Asia/Kuala_Lumpur` browser: a timed Deadline Month-drag fires `eventDrop` → `fullCalendarCallbackToSydneyCivil` → `{ localCivil: "2026-08-14T09:00", utcOffsetMinutes: 600 }` (09:00 wall-time preserved, browser zone irrelevant); an all-day drag → `{ allDay: true, date: "2026-08-07" }`; a per-event `editable:false` checklist event is not draggable (no `eventDrop`). **Residual Agy items** (need a human-authenticated Chrome + local Worker): the confirm-modal visual/focus-trap timing in a real browser, scroll/auto-scroll during drag, and the impersonated Editor/External read-only walkthrough. `useLayoutEffect` from the first round was reverted to `useEffect` in `PrincipalFreshnessBoundary` (Sol cleared it as unnecessary).

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: Project moves are confirmation-gated canonical TB4B writes with unchanged offsets; every failure restores authoritative geometry and deterministic focus.

### Slice 8 — Checklist direct manipulation and explicit editor

- Wire due drag, range drag, end-edge resize, Month whole-date and Week 15-minute behavior, plus Agenda/keyboard Move/Reschedule through shared mappers and the unchanged PATCH envelope. Flip only the FullCalendar editability options required by these implemented callbacks and server permissions.
- Disable start-edge resize in FullCalendar configuration and handler guard.
- Add the explicit versioned editor for `unscheduled`/`due_only`/`range` conversions and complete replacement of `legacy_unresolved`, with homogeneous endpoint input and per-endpoint fold choices. `invalid` never opens it.
- Implement all TB4D conflict/storage/validation arms, `503 subtask_schedule_ranges_disabled`, role-branched mutation response decoding, canonical response/noop reconciliation, no retry, refresh deferral, focus/announcements, and terminal precedence.
- Test each five-state source, endpoint-independent DST shifts, inclusive/exclusive all-day mapping (including the one-day-to-two-day resize sending inclusive `D+1`, not exclusive `D+2`), invalid order/mixed kind, conflict current/currentSubtask, unchanged-version semantic `noop` adoption/“No change”/both-gates-clear, `legacy_unresolved` version-0 replacement through `scheduleRequest` (and zero legacy `dueDate` patch), `invalid` read-only needs-attention behavior, internal versus External mutation response decoders, External Collaboration permissions, and editor draft preservation.
- Add a Calendar inert-mode suite mirroring `SubtaskChecklist.inert.dom.test.tsx` and `project-subtask-inert.test.ts`: with `CHECKLIST_SCHEDULE_RANGES_ENABLED=false`, range event drag/resize and range editor choice are disabled, Week range-producing actions send zero requests, a defensive server `503 subtask_schedule_ranges_disabled` is not retried, and permitted non-range editor replacement remains usable.
- Agy proves real event drag/end-resize geometry and modal/focus behavior for Admin, internal Editor, and External Editor.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: every checklist Calendar mutation is byte-for-shape the existing command envelope and all failures follow guarded rollback/no-retry.

### Slice 9 — Unscheduled panel and external drop

- Render separate Project and Checklist sections with returned/matched counts and exact `N more — refine filters or search` copy.
- Wire Month/Week external drop and action-based Agenda defaults through shared mappers; require Project confirmation; empty space remains inert.
- Flip FullCalendar `droppable` only when the Unscheduled source and server permissions allow it. With checklist range scheduling inert, checklist external drop remains disabled (including Month) and Week's one-hour range default is unavailable; non-range scheduling remains available through the explicit editor.
- Enforce real disabled Project entries for External and checklist-only movement. Both schedule-needs-attention reasons are non-draggable; `legacy_unresolved` offers the authorized complete versioned editor, while `invalid` offers only repair copy/link and no Calendar editor.
- Test 50/50 starvation resistance, deterministic truncation, all four defaults, Sydney edge cases, zero invented Project offsets, no Agenda external drag, no empty-space creation, and role restrictions.
- Agy proves external drag geometry/scroll and disabled-item behavior in all three roles.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: unscheduled work is bounded, never silently capped, and becomes scheduled only through the canonical source command.

### Slice 10 — overlap, refresh reconciliation, accessibility, phone, and visual proof

- Complete non-blocking overlap indicator, one semantic announcement builder, FullCalendar/Quincy live-region cadence, drag-mirror a11y hiding, reduced motion, zoom, scroll, and terminal suppression.
- Prove `calendarInteractionBlocked` defers and coalesces refresh during drag/resize/confirmation/editor/mutation, then clears before the one authoritative refetch. Prove `calendarSettlePending` disables commands but accepts that refetch and clears on acceptance; a failed refetch retains recovery without blocking later acceptance. Cover the ID-free cross-tab message at each phase, no rebroadcast, and access-loss immediate cancellation.
- Lock phone Week action-only behavior and ordinary scroll reachability. Validate Month disclosure and Agenda interaction.
- Run Agy local-dev matrix and capture matched evidence at 1440x900, 1024x768, and 390x844. Run physical/coarse-pointer phone Week acceptance and real VoiceOver or NVDA keyboard Move/Reschedule acceptance.
- Review bundle/CSS/dependency output and performance using the dense/multi-day fixture; record response bytes, parse/render time, and compare them with Slice 4's Worker CPU/bytes evidence before retaining the 10,000 ceiling. Happy-dom assertions explicitly disclaim sensor, geometry, scroll, browser focus timing, and AT delivery.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: the accessibility checklist below is fully evidenced; real browser/hardware—not DOM emulation—proves the FullCalendar interaction claims.

### Slice 11 — full proof and deployment preparation

- Run all automated obligations and repository audits; independently run the four-command gate in the orchestrating session.
- Run the complete Agy functional matrix after a human Admin sign-in, using Admin impersonation for internal Editor and External Editor. Agy never performs OAuth or reads auth secrets. Restart intermittent local `wrangler dev` and retry `ERR_CONNECTION_REFUSED` before classifying an app failure.
- Obtain fresh Sol diff review, Opus final-draft review, and resolution passes required by project process.
- Confirm diff touches no migration/schema/background/webhook/prototype/premium/media path. Record exact current app Worker version as rollback target.
- Prepare passive production checks and documentation closeout without moving the plan yet.

Gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces --if-present
npx vitest run --config packages/shared/vitest.config.ts
```

Acceptance: all reviews/evidence/gates are recorded, real-hardware and AT acceptance are complete, app-only deploy diff is proven, and rollback target is known.

## Accessibility acceptance checklist

- [ ] Every editable Project and Checklist event has a keyboard-operable **Move/Reschedule** action in Month, Week, and Agenda; every Unscheduled editable entry has equivalent non-drag scheduling.
- [ ] Pointer/touch drag is never the only path. Phone Week is deliberately action-only for mutation.
- [ ] The toolbar visibly and accessibly says Sydney time and announces the correct AEST/AEDT abbreviation for the active date; a view spanning the transition distinguishes both rather than presenting the wrong single offset.
- [ ] Focus returns deterministically to the originating event/action, its authoritative replacement, the selected-day disclosure, or a safe Calendar/Dashboard fallback after success, cancel, conflict, DST gap reject, fold-choice cancel, validation failure, refetch failure, and access loss.
- [ ] One pure Calendar announcement builder supplies start/proposal/drop/cancel/confirmation/success/conflict/rollback/recovery copy and returns `undefined` after terminal/access purge so private street/Stage text cannot be announced late.
- [ ] Announcements distinguish “saving,” “saved,” “reverted because data changed,” “no retry,” DST gap, fold choice, and access change without claiming unsaved optimism as fact.
- [ ] FullCalendar's internal live region owns at most geometry proposal messages; Quincy's one polite atomic region owns confirmation and settled results. Real VoiceOver/NVDA verifies that FullCalendar's assertive output does not pre-empt the polite settled/conflict result. If cadence fails, suppress FullCalendar's final/drop announcement and let Quincy own drop + settle; do not add a third region.
- [ ] Drag mirror/overlay is `aria-hidden`, non-focusable, and absent as a duplicate event in the accessibility tree.
- [ ] External Editor and internal Editor read-only Project Deadline controls use native `disabled`/non-draggable configuration and visible read-only copy, not `aria-disabled` alone.
- [ ] Range start resize has no reachable handle; end resize has an accessible name and an equivalent Move/Reschedule editor.
- [ ] Disabled, completed, delivered-context, schedule-needs-attention, and overlap indicators expose text/state without relying on color.
- [ ] FullCalendar auto-scroll during active manipulation does not prevent ordinary page/calendar scrolling when no manipulation is active; keyboard and phone users can reach all 24 Week hours.
- [ ] Touch targets meet 44x44 where controls are actionable; focus indicators remain visible against Warm Paper and event signal colors.
- [ ] `prefers-reduced-motion` removes nonessential transition/drag-mirror animation without removing state feedback.
- [ ] At 200% zoom, toolbar/filter/Unscheduled controls reflow without clipping, event actions remain reachable, and no two-dimensional page trap is introduced.
- [ ] 390x844 Month selected-day disclosure, Agenda, and Week action-only flow remain usable with coarse pointer and on real hardware.
- [ ] Matched 1440x900, 1024x768, and 390x844 evidence preserves Quincy typography/tokens and does not ship a stock FullCalendar/shadcn aesthetic.

## Automated tests and QA obligations

### Shared Node suite

- Strict query/filter/DTO/external schemas, distinct normalized input/output types, canonicalization, unknown-key rejection, and sanitized applied filters. Cover the complete literal-pinned checklist event/Unscheduled union members and permission literals, all invalid cross-combinations via `success:false`, named alias `expectTypeOf` checks, concrete Admin `StageKey`/non-Admin presentation Stage schema construction, `editing` acceptance plus `editing_autohdr` rejection for every filter role, and the Stage cap of 5.
- Calendar-component date validation/add-day/day-delta without date-only `Date` parsing.
- Sydney month/week shifting across real October gap and April fold; gap error; fold choices; endpoint-independent timed range resolution; no elapsed-duration preservation.
- Project/checklist scheduled and Unscheduled mappers, snap/default rules, `schedule.version`/offset authority, start-edge rejection, explicit FullCalendar-exclusive to TB4D-inclusive conversion including the `D+2 -> D+1` resize case, invalid order/mixed kinds.
- Reminder consequence preview including future, `elapsed_at_save`, and changed Sydney wall-clock hour.
- All five Checklist DTO states, inclusive date-range to exclusive FullCalendar end, and role-safe Stage presentation.
- Strict staff route Calendar parsing/serialization/safe destination and existing collaboration-route regression; decoded unsafe-character rejection, state-layer `q` sanitization, no `/` collapse, full canonical fixed point; API and Dashboard URL cases both pin `mine=1`, default false, false omission, fixed order, and canonical round trip.

### App Worker integration

- Authorized range and generic 401/403; bare/trailing route parity; one `scoped` security row per route, `externalSurface:'calendar'`, and both checked-in `ALL` middleware registrations.
- Admin, Editor, Photographer, and real External sessions; External assigned-only/unarchived and no unassigned-project leakage.
- At most two D1 range statements, reviewed query plan (including deliberate unindexed range scans), constant bound-parameter count with each list JSON-bound once through `json_each`, and no per-project fan-out; over-cardinality/8,192-byte inputs return pre-D1 `400`, while over-10,000 scheduled density returns non-silent `422 calendar_range_too_dense`; dense fixtures record Worker CPU and response bytes.
- Month padding, Week/Agenda bounds, timed/date intersection, active-only archive exclusion.
- Every layer/filter combination: project/checklist layers, Editor OR/Unassigned, Stage, completed, delivered, overdue, search, My tasks; assert no Project-ID request filter exists. Prove Stage `editing` expands exactly once while `editing_autohdr` is rejected pre-D1 for all roles. Prove the exact role-identical search columns, notes exclusion, ASCII case folding, and identical-case 200-character multibyte execution through `instr(lower(...), lower(?))` rather than `LIKE`, without claiming Unicode case folding.
- Events/facets derived from the authorized bounded candidate universe only; `filterFacets.people` includes represented authorized memberships/assignees even beyond an Unscheduled truncation tail, never unrelated directory users; inaccessible IDs are removed without response disclosure.
- Project/checklist presentation and exact server permissions, including Admin-only Deadline mutation, External checklist Collaboration rights, and range-flag-disabled permission literals.
- Unscheduled 50+50 limits, matched/returned/truncated values, deterministic dropped tail, and no starvation.
- Overlap indicator inclusions/exclusions; dense/multi-day fixture and query/performance budget.
- Strict External response rejects contact/email/notes/provider/media/raw Stage/Board/membership fields.

### Web Node/happy-dom

- Query key includes principal/role/epoch/scope/range/subview/filters; 15s/30s/focus/reconnect and AbortSignal.
- Dashboard capability/view/storage behavior including stored `calendar`, withheld-role and archived coercion; URL-first state, Back/Forward, copied links, canonical filtering, inaccessible-ID replacement, and shared-query state across views.
- Month/Week/Agenda composition and actual server-shaped fixtures; event/progress/status/read-only rendering.
- Project confirmation/reminder request; checklist move/end-resize/editor request and principal-domain mutation response decoding; Unscheduled defaults.
- Guarded snapshot/optimism/rollback/no-retry/refetch settle; checklist noop adoption/announcement/no version bump; range-disabled 503 no-retry; one active mutation; orthogonal Calendar accept/command gates; no settle-gated navigation; failed settle still switches views and clears Calendar recovery; settling refetch acceptance; incoming refresh/broadcast coalescing; access-loss family purge and late suppression.
- Existing-channel `production-calendar-invalidated` receive at proposal/confirmation/editor/mutation/settle yields exactly one scoped refetch, never rebroadcasts, and contains no ID or event data.
- Exact conflict/DST/storage/terminal arms, draft preservation, focus descriptors, and announcement copy.
- No empty-slot creation, no start resize, no phone Week drag, Slice-5 component-level edit hard-disable, Calendar range inert mode, and real disabled External Deadline controls.

happy-dom proves wiring, state, markup, and callbacks only. It does not prove FullCalendar sensor activation, geometry, event mirror, collision, scroll, browser focus timing, touch behavior, or screen-reader cadence.

### Agy and real-hardware matrix

Use local app Worker at `http://localhost:8787` after a human Admin sign-in; use `Admin-Impersonation.md` for Editor/External role coverage.

1. Admin: all subviews/layers/filters/URL restore; Project and Checklist moves; confirmation consequences; Unscheduled defaults; conflicts; DST gap/fold; overlap; refresh during manipulation.
2. Impersonated internal Editor: Calendar visible; Project Deadline visibly read-only under current no-`editProject` grant; checklist mutations work through Collaboration.
3. Impersonated External Editor: assigned-only events/facets; all assigned checklist work by default; My tasks quick filter; Project scheduled/unscheduled read-only; checklist drag/editor allowed; membership removal purges all ranges.
4. Photographer: no Calendar selector and direct canonical Calendar URL returns to authorized Dashboard; API 403.
5. Real Chrome: Month leading/trailing days, Week 24-hour scroll/15-minute geometry/end resize, Agenda actions, external drop, drag mirror, auto-scroll, focus after modal/conflict/refetch.
6. Physical/coarse-pointer phone at 390x844: Agenda default, Month disclosure, Week action-only reachability, ordinary scroll, 200% zoom.
7. Real VoiceOver or NVDA: keyboard Move/Reschedule for every editable type in all subviews, modal focus containment/return, live-region cadence, conflict/DST/access-loss announcements, no mirror duplication.
8. Matched Quincy evidence and bundle/CSS/dependency review.

If local `quincy-app-worker-dev` dies under sustained requests, restart it and retry the failed step. `ERR_CONNECTION_REFUSED` alone is infrastructure evidence, not an application finding.

## Repository audits

Run and classify before deploy:

```bash
rg -n "viewProductionCalendar" portal/packages/shared portal/apps/web portal/workers/app
rg -n "moveProjectStage|viewProductionCalendar" portal/packages/shared/src/capabilities.ts
rg -n "externalCalendarRangeSchema|adminProductionCalendarRangeResponseSchema|editorProductionCalendarRangeResponseSchema" portal/packages/shared portal/workers/app portal/apps/web
rg -n "production-calendar" portal/apps/web/src portal/workers/app/src portal/workers/app/test
rg -n "Temporal|temporal-polyfill" portal/packages/shared portal/workers/app portal/apps/web/src/lib/production-calendar-fullcalendar.ts
rg -n "STAGE_TRANSPORT_KEYS" portal/packages/shared/src portal/apps/web/src portal/workers/app/src
rg -n "boardPosition|boardRevision|board_revision|tb5a_board_contract_enabled" portal/packages/shared/src/production-calendar.ts portal/workers/app/src/routes/production-calendar.ts portal/apps/web/src/components/ProductionCalendar* portal/apps/web/src/lib/production-calendar*
rg -n "@fullcalendar/premium|@fullcalendar/react/premium|scheduler|resourceTimeline|resourceTimeGrid|@fullcalendar/(daygrid|timegrid|list|interaction)\"" portal/package.json portal/package-lock.json portal/apps/web/src
rg -n "@radix-ui/" portal/apps/web/src/components/ProductionCalendar* portal/apps/web/src/lib/production-calendar* portal/apps/web/src/styles/production-calendar.css
rg -n "Date\([^)]*YYYY|new Date\([^)]*localCivil|new Date\([^)]*due" portal/packages/shared/src/production-calendar.ts portal/workers/app/src/routes/production-calendar.ts
git diff --name-only -- portal/packages/db portal/workers/background portal/workers/webhook-ingress prototype
git diff -- portal/packages/db/src/schema.ts portal/packages/db/migrations
```

Expected: capability exists in the three approved grants only; one shared DTO owner; Calendar files use no Board contract; **zero `Temporal`/`temporal-polyfill` import in `packages/shared`, `workers/app`, and the Quincy Calendar adapter/mappers** (it appears only transitively under `@fullcalendar/*` in the lockfile); `STAGE_TRANSPORT_KEYS` is exported once from `stage-move.ts`/`index.ts` and never appears in an Admin project-context `z.enum(...)` (that domain uses `z.enum(STAGE_KEYS)`); no premium/resource import; no date-only parsing; and the final two diffs are empty. Also inspect `portal/package.json`/lock for exact pins and one React copy.

## Deployment and rollback

### Preconditions

- All slices and the complete four-command gate are green, including the dedicated shared suite that workspace tests skip.
- App Worker integration suites are independently run by the orchestrating session; absence of loopback permission in Luna/codex sandbox is not a finding and not accepted as evidence.
- Sol/Opus review findings are resolved.
- Agy local-dev role matrix, physical phone Week, and real AT keyboard acceptance all pass. Deployment waits for both real-hardware obligations.
- Diff audit proves no migration/schema/background/webhook/prototype/premium/media change. Migration number remains `0038`.
- Record current production app Worker version as rollback target.

### Deploy

Deploy **app Worker only**:

```bash
cd portal/workers/app
npx wrangler deploy
```

Do not deploy background or webhook-ingress. Do not run a D1 migration. The `viewProductionCalendar` capability grant is the launch gate; the deployed `/api/me`, nav, and endpoint become available together.

### Passive production verification

After deploy, without production mutations:

1. `/api/health` returns `200` and expected environment.
2. Unauthenticated `GET /api/production-calendar` with a valid canonical bounded query returns `401`.
3. Production login/Dashboard renders for the human-authenticated account.
4. Production HTML/assets serve the TB5C Calendar bundle and CSS; no stale chunk or console/network error.
5. Capability-eligible navigation shows Calendar and a passive current range loads. Photographer/withheld behavior remains hidden/403 where safely testable without changing accounts.

Mutating proof remains local unless the orchestrator separately authorizes production YOLO-mode under the disposable QA identity. Passive verification never drags/resizes/schedules real work.

Record:

```text
TB5C deployed YYYY-MM-DD — commit <sha>; app Worker <new version>;
no migration (next remains 0038); no background/webhook deploy;
capability launch active; rollback app Worker <previous version>;
passive production checks <result>.
```

### Rollback

`git revert` the TB5C merge/commit and redeploy the app Worker. If immediate operational rollback is needed first, restore the recorded prior app Worker version, then land the source revert so the next deploy cannot reintroduce TB5C. The revert removes the capability, nav, route, UI, and dependency use together. No D1 recovery, background rollback, occurrence repair, reminder repair, feature-flag change, or media action is needed; any successful pre-rollback mutations are canonical TB4B/TB4D writes and remain valid source data.

## Documentation closeout

After implementation is built, verified, committed, deployed, and passively verified:

- update `docs/lessons.md` with observed FullCalendar browser/AT behavior and the precise boundary happy-dom could not prove;
- update `docs/todo.md` with commit, app Worker version, test counts, reviews, QA, and passive verification;
- update both `CLAUDE.md` and `AGENTS.md`: migration number still `0038`; Calendar is now live and removed from the non-live Approved revamp targets sentence while preserving future route/range interaction rules;
- update this status with deploy date, commit, app Worker version, rollback target, and evidence;
- `git mv docs/plans/Revamp-TB5C-Production-Calendar-Plan.md docs/plans/implemented/Revamp-TB5C-Production-Calendar-Plan.md`.

The file remains in `docs/plans/` until all of those conditions are true.

## Final acceptance checklist

- [ ] One tracer bullet and one app-only production deploy; capability is the only launch gate.
- [ ] Calendar is a projection over TB4B/TB4D, with zero Calendar storage/notification/command and zero migration.
- [ ] Admin, Editor, and External Editor have `viewProductionCalendar`; Photographer does not; External capabilities total 11.
- [ ] One bounded range endpoint, both exact route forms, path-scoped middleware, at most two bounded D1 statements with constant parameter count, a non-silent density ceiling, and no browser N+1/all-history download.
- [ ] External projection composes `visibleProjectWhere`, explicit selects, strict schema, role-safe Stage, and assigned/unarchived scope.
- [ ] Project/checklist events and Unscheduled entries carry exact source versions/schedules/offsets and server permissions.
- [ ] Filters/facets/URL/query identity are authorization/range aware; inaccessible IDs are removed non-disclosingly; membership loss purges the entire family.
- [ ] Project moves preserve civil wall time/offset list and use rich confirmation; checklist moves preserve each endpoint civil time and use unchanged PATCH semantics.
- [ ] Gap/fold, stale conflicts, terminal states, invalid storage, refresh during manipulation, and no-retry rollback follow the canonical source rules.
- [ ] Unscheduled defaults are exact; 50+50 bounds disclose the deterministic dropped tail; empty space creates nothing.
- [ ] Same-assignee timed overlap is visible and non-blocking, never a booking rule.
- [ ] FullCalendar Standard owns geometry only; Pulse (or the evidence-approved single flavor) is source-reviewed/scoped under Quincy; no premium or second primitive system.
- [ ] Keyboard Move/Reschedule, focus, live regions, mirror hiding, reduced motion, 200% zoom, phone Week action fallback, real disabled read-only state, real-browser geometry, physical phone, and AT evidence all pass.
- [ ] The complete gate includes the dedicated shared Vitest config and is independently verified by the orchestrating session.
- [ ] Final diff contains no `packages/db`, migration, background, webhook-ingress, prototype, media, or TB5A Board-contract change.
