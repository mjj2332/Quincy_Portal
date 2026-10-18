import { useCallback, useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { AlertCircle, AlertTriangle, Loader2, PlusIcon } from "lucide-react";
import { ROLE_LABELS, type ProjectMemberRole, type Role } from "@quincy/shared";
import { ApiError, apiDeleteWithBody, apiPutWithStatus } from "../lib/api";
import { confirm } from "../lib/confirm";
import { Button, buttonClasses } from "./quincy/Button";
import { cn } from "../lib/utils";
import { ARCHIVED_HEADER_NOTICE_CLASS } from "./archived-notice";
import {
  beginProjectMembershipMutation,
  invalidateProjectSurfaces,
  useProjectAssignmentCandidatesQuery,
  useProjectAccessTermination,
  useOptionalProjectQueryClient,
  type ProjectAssignmentCandidate,
  type ProjectMember,
} from "../lib/project-data";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
} from "./reui/combobox";
import { AvatarStack } from "./quincy/AvatarStack";
import { HEADER_CHIP, HEADER_CHIP_LOCK } from "./project-header/header-styles";
import { HeaderTooltip } from "./project-header/HeaderTooltip";
import { Avatar, AvatarFallback } from "./reui/avatar";
import { Item, ItemContent, ItemDescription, ItemTitle } from "./reui/item";

/**
 * Replaces `ProjectTeamControl` (#204): one Base UI multi-select Combobox, styled after
 * `c-combobox-19`, instead of per-role "+ Add" popovers and member rows. The `add()`/`remove()`
 * mutation bodies below — the 422 probe→confirm loop, the `external_editor` `confirmAccessLoss`
 * body, the 409 `membership_cycle_changed` conflict merge, `terminateOnUnauthorized`, and the
 * `invalidateProjectSurfaces` calls — are carried over verbatim from `ProjectTeamControl.tsx`.
 * The only change to that logic is that error/conflict mutation states now carry a `retry` tag
 * (`"add" | "remove"`) plus whatever they need to retry (the candidate or the member): the old
 * per-role error banner matched on key prefix alone, so a REMOVE error for an existing member
 * (whose key is identical to that person's ADD candidate key) rendered a second, wrongly-labelled
 * "could not be added" banner whose Retry button called `add()` instead of `remove()`. One
 * message per mutation state, tagged with its own retry action, replaces that.
 */

type PersonMutationState =
  | { kind: "pending"; intent: "add" | "remove" }
  | { kind: "error"; retry: "add"; message: string; role: ProjectMemberRole; candidate: ProjectAssignmentCandidate }
  | { kind: "error"; retry: "remove"; message: string; member: ProjectMember }
  | { kind: "conflict"; retry: "remove"; message: string; member: ProjectMember };

type MembershipResponse = { outcome: "created" | "unchanged"; membership: ProjectMember };
type RemoveResponse = { outcome: "removed"; removed: { membershipCycle: string; userId: string; roleOnProject: ProjectMemberRole }; subtaskAssignmentsCleared: number };

/** An entry in the grouped Combobox's `items` — either a real assignment candidate (`candidate`
 *  set, selectable) or a member-only stand-in built for someone not among today's candidates
 *  (e.g. inactive), which can appear as a chip but never as a selectable option. */
type TeamOption = {
  key: string;
  role: ProjectMemberRole;
  userId: string;
  name: string;
  email: string;
  globalRole: Role;
  active: boolean;
  candidate: ProjectAssignmentCandidate | null;
};

const PROJECT_TEAM_MESSAGE =
  "col-span-full [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] " +
  "text-[color:var(--signal-critical)]";

/** #222: also the event-calendar People chips' remove hit area (the Calendar's facets were removed in #430). */
export const TEAM_CHIP_REMOVE_HIT_AREA =
  // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. The visible icon-xs
  // button is 24px (`size-6`); a transparent pseudo-element extends the hit area to 44px
  // without growing the chip itself. An absolute inset is measured from the *padding* box, and
  // the Button has a 1px transparent border, so the inset is 11px, not 10: 22 + 11 + 11 = 44
  // (10px measured 42×42 in the browser, #487).
  "relative before:absolute before:content-[''] before:-inset-[11px]";

/** The chip's base look, identical for the real `ComboboxChip` (merged over its own vendor
 *  defaults via `cn`/`twMerge`) and the read-only `<span>`, which has no vendor component to fall
 *  back on and so needs the full class list spelled out itself. Kept as one constant instead of
 *  two hand-duplicated class strings (review fix #204). `has-disabled:*` and
 *  `has-data-[slot=combobox-chip-remove]:pr-0` are dead weight on the read-only span (it has
 *  neither a disabled descendant nor a chip-remove child) but harmless there. */
/** #222: exported — the event-calendar People/Layers chips use the same presentation. */
export const TEAM_CHIP =
  "flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1.5 rounded-[var(--radius-pill)] " +
  "bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-foreground has-disabled:pointer-events-none " +
  "has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0 " +
  // 44px touch target at the narrow breakpoint (spec §10.5, docs/lessons.md § "A hover-reveal affordance has no touch equivalent"). This repo's
  // `≤720px` spelling is `max-[721px]:`, not `max-[720px]:` — `max-[720px]:` alone compiles to
  // `width < 720`, excluding exactly 720 (docs/lessons.md § "Three CSS traps a Tailwind convergence").
  "max-[721px]:min-h-[44px]";

/** #514: header chips may carry a long collision label (full name + email). They never outgrow their container and wrap
 *  instead of truncating (the email is what tells two people apart); a short chip keeps TEAM_CHIP's fixed look as the minimum. */
const TEAM_CHIP_FIT = "h-auto min-h-[calc(--spacing(5.25))] max-w-full min-w-0 whitespace-normal py-0.5";

type TeamChipDataState = "idle" | "pending" | "error" | "conflict";

/** Per-chip mutation-state styling (review fix #204 "visible per-chip state") — tokens only. */
function teamChipStateClasses(dataState: TeamChipDataState) {
  switch (dataState) {
    case "pending": return "opacity-70";
    case "error": return "border border-[color:var(--signal-critical)] ring-1 ring-[color:var(--signal-critical)]";
    case "conflict": return "border border-[color:var(--signal-caution-text)] ring-1 ring-[color:var(--signal-caution-text)]";
    default: return "";
  }
}

/** #452: the server refuses every membership write on an archived Project with this 409 (it supersedes #446's removal code). */
function isMembershipArchivedRefusal(error: unknown) { return error instanceof ApiError && error.status === 409 && details(error)?.code === "membership_project_archived"; }
const ARCHIVED_TEAM_NOTICE = "Read-only while archived. Restore the project before changing the team.";
/** Capped so a long notice wraps inside the Team column instead of widening it and shifting its neighbours. */

function cellKey(roleOnProject: ProjectMemberRole, userId: string) { return `${roleOnProject}:${userId}`; }
// Deliberately a short dual-role chip tag ("Photo"/"Edit"), not a role label; labels come from ROLE_LABELS.
function shortRoleTag(roleOnProject: ProjectMemberRole) { return roleOnProject === "photographer" ? "Photo" : "Edit"; }
function details(error: unknown): Record<string, unknown> | null { return error instanceof ApiError && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : null; }
function displayName(name: string, email: string) { return name || email; }
function firstName(name: string, email: string) {
  const trimmed = displayName(name, email).trim();
  return trimmed.split(/\s+/)[0] ?? "";
}
/**
 * #514: the visible header-chip label per userId. Computed over the FULL assigned value (before
 * the "+N" collapse, so a hidden member still counts) and deduped by userId (a dual-role member is
 * one person, not a collision): the first name when it is unique, the full name when another person
 * shares the first name, the full name plus email when another person shares the full name too.
 */
export function teamChipLabels(people: ReadonlyArray<{ userId: string; name: string; email: string }>): Map<string, string> {
  const unique = new Map<string, { userId: string; name: string; email: string }>();
  for (const person of people) if (!unique.has(person.userId)) unique.set(person.userId, person);
  const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const firsts = new Map<string, number>();
  const fulls = new Map<string, number>();
  for (const person of unique.values()) {
    const first = norm(firstName(person.name, person.email));
    const full = norm(displayName(person.name, person.email));
    firsts.set(first, (firsts.get(first) ?? 0) + 1);
    fulls.set(full, (fulls.get(full) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const person of unique.values()) {
    const full = displayName(person.name, person.email).trim();
    const label = (fulls.get(norm(full)) ?? 0) > 1 && person.name ? `${full} (${person.email})`
      : (firsts.get(norm(firstName(person.name, person.email))) ?? 0) > 1 ? full
      : firstName(person.name, person.email);
    labels.set(person.userId, label);
  }
  return labels;
}
function initials(name: string, email: string) {
  const parts = displayName(name, email).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}
function candidateOption(role: ProjectMemberRole, candidate: ProjectAssignmentCandidate): TeamOption {
  return { key: cellKey(role, candidate.id), role, userId: candidate.id, name: candidate.name, email: candidate.email, globalRole: candidate.globalRole, active: true, candidate };
}
function memberOption(member: ProjectMember): TeamOption {
  return { key: cellKey(member.roleOnProject, member.userId), role: member.roleOnProject, userId: member.userId, name: member.name, email: member.email, globalRole: member.globalRole, active: member.active, candidate: null };
}

/** Moved verbatim from `ProjectTeamControl.tsx` — see the file header for what changed and why. */
function useTeamMutations(projectId: string, hooks: { onRequestStart: () => void; onArchivedRefusal: () => void }) {
  const queryClient = useOptionalProjectQueryClient();
  const terminateOnUnauthorized = useProjectAccessTermination();
  const [mutationStates, setMutationStates] = useState<Record<string, PersonMutationState>>({});
  const pending = new Set(Object.entries(mutationStates).filter(([, state]) => state.kind === "pending").map(([key]) => key));

  function setState(key: string, state: PersonMutationState | null) {
    setMutationStates((current) => { const next = { ...current }; if (state) next[key] = state; else delete next[key]; return next; });
  }

  /** Settled (error / conflict) states go when the Team turns read-only: a Retry there could only 409 again. */
  const clearSettled = useCallback(() => setMutationStates((current) => {
    const entries = Object.entries(current).filter(([, state]) => state.kind === "pending");
    return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
  }), []);

  /** The Project was archived under this write. `fail()` rolls the optimistic overlay back but, with nothing committed, does not
   *  refresh the detail, so the refetch is explicit and comes after it. */
  async function archivedRefusal(key: string, mutation: Awaited<ReturnType<typeof beginProjectMembershipMutation>> | undefined) {
    await mutation?.fail();
    setState(key, null);
    hooks.onArchivedRefusal();
    if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "collaboration-summary" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true });
  }

  async function add(roleOnProject: ProjectMemberRole, candidate: ProjectAssignmentCandidate) {
    const key = cellKey(roleOnProject, candidate.id);
    if (pending.has(key) || !queryClient) return;
    hooks.onRequestStart();
    setState(key, { kind: "pending", intent: "add" });
    const optimistic: ProjectMember = { id: `optimistic-${key}`, userId: candidate.id, roleOnProject, name: candidate.name, email: candidate.email, globalRole: candidate.globalRole, active: true, assignedSubtaskCount: 0 };
    let mutation: Awaited<ReturnType<typeof beginProjectMembershipMutation>> | undefined;
    try {
      mutation = await beginProjectMembershipMutation(queryClient, projectId, roleOnProject, candidate.id, "add", optimistic);
      const response = await apiPutWithStatus<MembershipResponse>(`/api/projects/${encodeURIComponent(projectId)}/${roleOnProject === "photographer" ? "photographers" : "editors"}/${encodeURIComponent(candidate.id)}`);
      await mutation.commit(response.data.membership);
      await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "activity" }], dashboard: true, calendar: true, gantt: true, people: true });
      setState(key, null);
    } catch (error) {
      terminateOnUnauthorized(error);
      if (isMembershipArchivedRefusal(error)) { await archivedRefusal(key, mutation); return; }
      await mutation?.fail(); setState(key, { kind: "error", retry: "add", role: roleOnProject, candidate, message: error instanceof Error ? error.message : "Assignment could not be added." });
    }
  }

  async function remove(member: ProjectMember) {
    const key = cellKey(member.roleOnProject, member.userId);
    if (pending.has(key) || !queryClient) return;
    hooks.onRequestStart();
    let confirmedCount: number | null = null;
    while (true) {
      setState(key, { kind: "pending", intent: "remove" });
      let mutation: Awaited<ReturnType<typeof beginProjectMembershipMutation>> | undefined;
      try {
        mutation = await beginProjectMembershipMutation(queryClient, projectId, member.roleOnProject, member.userId, "remove", null);
        const clearAssignments = confirmedCount !== null && confirmedCount > 0;
        const body = member.globalRole === "external_editor"
          ? { membershipCycle: member.id, clearSubtaskAssignments: clearAssignments, confirmedAssignmentCount: confirmedCount ?? 0, confirmAccessLoss: confirmedCount !== null } as const
          : { membershipCycle: member.id, clearSubtaskAssignments: clearAssignments, confirmedAssignmentCount: confirmedCount ?? 0 } as const;
        const response = await apiDeleteWithBody<RemoveResponse, typeof body>(`/api/projects/${encodeURIComponent(projectId)}/${member.roleOnProject === "photographer" ? "photographers" : "editors"}/${encodeURIComponent(member.userId)}`, body);
        await mutation.commit(undefined, response.subtaskAssignmentsCleared);
        await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "activity" }, ...(response.subtaskAssignmentsCleared > 0 ? [{ kind: "subtasks" as const }] : [])], dashboard: true, calendar: true, gantt: true, people: true });
        setState(key, null);
        return;
      } catch (error) {
        const payload = details(error);
        if (isMembershipArchivedRefusal(error)) { await archivedRefusal(key, mutation); return; }
        if (error instanceof ApiError && error.status === 422 && payload?.code === "subtask_assignment_confirmation_required") {
          await mutation?.fail();
          if (typeof payload.assignmentCount !== "number") {
            // Never fabricate a confirmation count for a malformed server response — the dialog
            // must only ever display a server-verified count, per the plan's explicit contract.
            setState(key, { kind: "error", retry: "remove", member, message: "Assignment could not be removed." });
            return;
          }
          const count = payload.assignmentCount;
          const accepted = await confirm({ title: "Remove final project role?", message: payload.accessWillBeLost ? `Project access will be lost immediately. Removing ${member.name || member.email}'s final project role will unassign ${count} checklist item${count === 1 ? "" : "s"}. Continue?` : `Removing ${member.name || member.email}'s final project role will unassign ${count} checklist item${count === 1 ? "" : "s"}. Continue?`, confirmLabel: "Remove and unassign", danger: true });
          if (!accepted) { setState(key, null); return; }
          confirmedCount = count;
          continue;
        }
        if (error instanceof ApiError && error.status === 409 && payload?.code === "membership_cycle_changed") {
          const currentMembership = payload.currentMembership as ProjectMember | null | undefined;
          await mutation?.conflict(currentMembership ?? null);
          setState(key, { kind: "conflict", retry: "remove", member, message: "Assignment changed elsewhere. Review the refreshed row before trying again." });
          return;
        }
        await mutation?.fail(); terminateOnUnauthorized(error); setState(key, { kind: "error", retry: "remove", member, message: error instanceof Error ? error.message : "Assignment could not be removed." });
        return;
      }
    }
  }

  return { mutationStates, pending, add, remove, clearSettled };
}

/** Small icon + sr-only label per non-idle mutation state, on both the real chip and the
 *  read-only span — review fix #204 "visible per-chip state". */
function TeamChipStateIcon({ dataState }: { dataState: TeamChipDataState }) {
  if (dataState === "pending") return <>
    <Loader2 className="size-3 shrink-0 motion-safe:animate-spin text-muted-foreground" aria-hidden="true" />
    <span className="sr-only">Working…</span>
  </>;
  if (dataState === "error") return <AlertCircle className="size-3 shrink-0 text-[color:var(--signal-critical)]" aria-hidden="true" />;
  if (dataState === "conflict") return <AlertTriangle className="size-3 shrink-0 text-[color:var(--signal-caution-text)]" aria-hidden="true" />;
  return null;
}

function TeamChipContent({ option, dataState, roleTag, lockedLabel, fullName = false, label }: { option: TeamOption; label?: string; dataState: TeamChipDataState; roleTag?: string; lockedLabel?: string; /** New shoot shows the whole name; the header keeps the first name. */ fullName?: boolean }) {
  const name = displayName(option.name, option.email);
  return <>
    <Avatar size="sm" className="size-4">
      <AvatarFallback className="text-[length:var(--text-2xs)] leading-none">{initials(option.name, option.email)}</AvatarFallback>
    </Avatar>
    <span className="min-w-0 [overflow-wrap:anywhere]">
      <span data-slot="team-chip-label">{fullName ? name : (label ?? firstName(option.name, option.email))}</span>
      {/* Dual-role disambiguation (review fix #204): visible when this userId is displayed in
       *  both the photographer and editor roles, so the two chips are not identical text. */}
      {roleTag && <span className="ml-[var(--space-1)] text-[length:var(--text-2xs)] text-foreground-secondary">{roleTag}</span>}
      {lockedLabel && <span className="ml-[var(--space-1)] text-[length:var(--text-2xs)] text-foreground-secondary">{lockedLabel}</span>}
      {!option.active && <em className="ml-[var(--space-1)] not-italic uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution-text)]"> Inactive</em>}
    </span>
    <TeamChipStateIcon dataState={dataState} />
    <span className="sr-only">{name}</span>
  </>;
}

/** #550: whether the chips box holds more than one row, from the first and last child's measured box.
 *  Children are vertically centred, so a same-row pair can differ by a few px; a different row differs by
 *  at least a row's height, hence the half-height tolerance. */
export function chipsBoxWraps(first: { top: number; height: number }, last: { top: number }): boolean {
  return last.top - first.top >= Math.max(first.height / 2, 1);
}

/** #550: true while the box wraps; re-measured on mount, when the chips change and whenever the box resizes. */
function useChipsBoxWrapped(box: HTMLElement | null, remeasureKey: string): boolean {
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    if (!box) return;
    const measure = () => {
      const first = box.firstElementChild as HTMLElement | null;
      const last = box.lastElementChild as HTMLElement | null;
      setWrapped(!!first && !!last && first !== last && chipsBoxWraps({ top: first.offsetTop, height: first.offsetHeight }, { top: last.offsetTop }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, remeasureKey]);
  return wrapped;
}

function TeamMoreToggle({ hiddenCount, expanded, onToggle }: { hiddenCount: number; expanded: boolean; onToggle: () => void }) {
  if (hiddenCount <= 0 && !expanded) return null;
  const label = expanded ? "Show fewer team members" : `Show ${hiddenCount} more team members`;
  return <button
    type="button"
    // #213 follow-up: chip-height among the chips (a 44px button made the box two tall rows). The
    // 44px target comes from the same transparent hit-area the chip × uses, whose ±10px inset is
    // sized for that ×'s 24px box — so this is 24px too (`size-6`-tall), not the chips' 21px, or
    // the sum would be 41. The narrow breakpoint keeps the real 44px height like the chips do.
    // #550: one quiet text-link for "+N" and "Show less". The ghost variant fills `aria-expanded`
    // buttons (`aria-expanded:bg-muted`), which is what made "Show less" read as one more chip; it also forces
    // `aria-expanded:!text-foreground`, so the expanded state re-asserts the secondary colour to match "+N".
    className={cn(buttonClasses("text", { className: "min-h-0 h-6 py-0 px-1.5 shrink-0 !normal-case max-[721px]:min-h-[44px] bg-transparent text-foreground-secondary hover:bg-transparent aria-expanded:bg-transparent aria-expanded:!text-foreground-secondary hover:underline underline-offset-2" }), TEAM_CHIP_REMOVE_HIT_AREA)}
    aria-expanded={expanded}
    aria-label={label}
    // Base UI's Chips container opens the popup on most interaction inside it — this toggle
    // sits among the chips (spec §"+N") and must not trigger that.
    onMouseDown={(event) => event.stopPropagation()}
    onClick={onToggle}
  >
    {expanded ? "Show less" : `+${hiddenCount}`}
  </button>;
}

const NO_LOCKED_KEYS: Set<string> = new Set();

type TeamGroup = { value: string; label: string; items: TeamOption[] };
type TeamChipView = { dataState: TeamChipDataState; isPending: boolean; messageId: string | undefined; name: string; roleTag: string | undefined; /** #514: header chips only; New shoot shows the whole name. */ label?: string };

/** The picker shared by the Project header (persisted mode, per-change saves) and New shoot
 *  (collect mode, #487). Presentation only: callers own the value, the mutations and the chip
 *  state. `lockedKeys` chips (New shoot's Default editors) render without a remove control and
 *  with a visible "Default editor" tag; their list items are disabled. */
function TeamComboboxView({ groups, value, onValueChange, visible, hiddenCount, expanded, onToggleExpanded, chipProps, pending, lockedKeys, inputRef, inputDisabled, rowClassName, contentRef, blockEnterSubmit = false, truncateDescriptions = false, formControl = false, inputId }: {
  groups: TeamGroup[];
  value: TeamOption[];
  onValueChange: (next: TeamOption[], eventDetails: ComboboxPrimitive.Root.ChangeEventDetails) => void;
  visible: TeamOption[];
  hiddenCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  chipProps: (option: TeamOption) => TeamChipView;
  pending: Set<string>;
  lockedKeys: Set<string>;
  inputRef?: Ref<HTMLInputElement>;
  inputDisabled: boolean;
  rowClassName?: string;
  contentRef?: Ref<HTMLDivElement>;
  /** Inside a `<form>` (New shoot) Enter in the search box would otherwise submit it; Base UI deliberately lets it through when no item is highlighted. */
  blockEnterSubmit?: boolean;
  /** Keeps each list row to one line when the list is the 300px minimum (New shoot's content-sized anchor); the full text stays in `title`. */
  truncateDescriptions?: boolean;
  /** New shoot: sized like the form's other inputs (38px, exactly 44px at narrow) instead of the header's control height. */
  formControl?: boolean;
  /** Lets an outside `<label for>` name the search input. */
  inputId?: string;
}) {
  const anchor = useComboboxAnchor();
  // #550: the pill needs one row; a wrapped box switches to --radius-sm (measured, not by viewport).
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const boxRef = useCallback((node: HTMLDivElement | null) => { anchor.current = node; setBox(node); }, [anchor]);
  const wrapped = useChipsBoxWrapped(box, `${visible.length}:${hiddenCount}:${expanded}`);
  return (
<Combobox
    multiple
    items={groups}
    value={value}
    onValueChange={onValueChange}
    isItemEqualToValue={(a: TeamOption, b: TeamOption) => a.key === b.key}
    itemToStringLabel={(item: TeamOption) => displayName(item.name, item.email)}
    itemToStringValue={(item: TeamOption) => item.key}
    filter={(item: TeamOption, query: string) => {
      const needle = query.trim().toLocaleLowerCase();
      if (!needle) return true;
      return `${item.name} ${item.email} ${ROLE_LABELS[item.role]} ${ROLE_LABELS[item.globalRole]}`.toLocaleLowerCase().includes(needle);
    }}
  >
    {/* No `has-data-[slot=combobox-chip]:pl-1` override here: the vendor default already
     *  carries `has-data-[slot=combobox-chip]:px-1` (both sides, `reui/combobox.tsx`), which
     *  subsumes the left-only version this file used to duplicate by hand. */}
    {/* #213 follow-up: content-sized like prototype 2a's Team `.sel` (chips · Add… · chevron), not a
     *  box stretched to its cell — `w-fit` sizes to the chips and `max-w-full` still wraps them
     *  inside the cell. */}
    <ComboboxChips ref={boxRef} data-wrapped={wrapped ? "true" : undefined} className={cn("w-fit max-w-full rounded-[var(--radius-pill)] data-[wrapped=true]:rounded-[var(--radius-sm)] max-[721px]:min-h-[44px]", formControl && "min-h-[38px] w-full rounded-[var(--radius-sm)]", rowClassName)}>
      <ComboboxValue>
        {() => visible.map((option) => {
          const { dataState, isPending, messageId, name, roleTag, label } = chipProps(option);
          const locked = lockedKeys.has(option.key);
          return <ComboboxChip
            key={option.key}
            showRemove={!locked}
            className={cn(TEAM_CHIP, TEAM_CHIP_FIT, teamChipStateClasses(dataState), formControl && "max-[721px]:min-h-0")}
            data-testid={`project-member-${option.key}`}
            data-state={dataState}
            aria-busy={isPending || undefined}
            aria-describedby={messageId}
            title={`${name} · ${ROLE_LABELS[option.role]}`}
            removeProps={{
              "aria-label": `Remove ${name} (${ROLE_LABELS[option.role]})`,
              "data-testid": "project-member-remove",
              disabled: isPending,
              className: TEAM_CHIP_REMOVE_HIT_AREA,
              // #206: Base UI renders the chip as a `div tabIndex=-1` and `ChipRemove` as a
              // `<button tabIndex=-1>`, relying on the chip's own Backspace/Delete path — which
              // `onValueChange` above rejects on purpose (reason "none"). Base UI merges
              // elementProps after its own `{ tabIndex: -1 }`, so this wins and makes the × a
              // real Tab stop; ChipRemove's own onKeyDown still handles Enter/Space.
              tabIndex: 0,
              // A key the parent Chip does not recognise makes it refocus its own `div` from its
              // keydown handler, so the browser's default Tab would then step from the chip
              // back onto this × — a trap. Keep Tab from reaching the chip; the default move
              // still happens. Arrow keys deliberately still bubble (chip-to-chip navigation).
              // Capture phase, not `onKeyDown`: Base UI's `useButton` wraps the merged bubble
              // handler and skips it while `disabled` — and the pending × is disabled yet still
              // focusable, so a bubble-phase guard would leave exactly that state trapped.
              onKeyDownCapture: (event) => { if (event.key === "Tab") event.stopPropagation(); },
            }}
          >
            <TeamChipContent option={option} dataState={dataState} roleTag={locked ? undefined : roleTag} lockedLabel={locked ? "Default editor" : undefined} fullName={formControl} label={label} />
          </ComboboxChip>;
        })}
      </ComboboxValue>
      <TeamMoreToggle hiddenCount={hiddenCount} expanded={expanded} onToggle={onToggleExpanded} />
      {/* `flex-none w-[12ch]`, not the vendor's `min-w-16 flex-1`: the input is the "Add…" affordance,
       *  and a flexing input is what claimed the rest of the line as white space. No focus growth:
       *  this box is the popup's anchor, so a width change on focus would jump the open list. */}
      <ComboboxChipsInput ref={inputRef} id={inputId} aria-label="Add team member" placeholder="Add…" className="flex-none min-w-0 w-[12ch]" disabled={inputDisabled} aria-invalid={inputDisabled ? true : undefined}
        onKeyDown={blockEnterSubmit ? (event) => { if (event.key === "Enter") event.preventDefault(); } : undefined} />
    </ComboboxChips>
    {/* #213 follow-up: the chips box is now content-sized, so the list no longer copies its width —
     *  a one-member box would give an unusably narrow list. Prototype 2a's list is 300px; it
     *  still never runs narrower than its anchor or wider than the viewport.
     *  `w-`, not `min-w-` (#456): the vendor's `data-[chips=true]:min-w-(--anchor-width)` variant wins a
     *  `min-w-` on specificity, pinning the popup to the content-sized anchor. Overriding `w-` makes
     *  twMerge drop the vendor `w-(--anchor-width)`, and `max-w-` still caps it on small screens. */}
    <ComboboxContent ref={contentRef} anchor={anchor} data-testid="project-team-options" className="w-[max(var(--anchor-width),300px)] max-w-[calc(100vw-2*var(--space-4))]">
      <ComboboxEmpty>No eligible people match.</ComboboxEmpty>
      <ComboboxList aria-label="Team candidates">
        {(group: (typeof groups)[number]) => <ComboboxGroup key={group.value} items={group.items}>
          <ComboboxLabel>{group.label}</ComboboxLabel>
          <ComboboxCollection>
            {(option: TeamOption) => <ComboboxItem key={option.key} value={option} disabled={pending.has(option.key) || lockedKeys.has(option.key)} className="max-[721px]:min-h-[44px]">
              <Item size="xs" className="p-0 flex-nowrap">
                <Avatar size="sm" className="size-6 shrink-0">
                  <AvatarFallback>{initials(option.name, option.email)}</AvatarFallback>
                </Avatar>
                <ItemContent className="min-w-0">
                  <ItemTitle className="block max-w-full truncate">{displayName(option.name, option.email)}</ItemTitle>
                  {truncateDescriptions
                    // Collect mode: the email truncates, the role never does.
                    ? <ItemDescription className="flex min-w-0 items-baseline gap-1" title={`${option.email} · ${ROLE_LABELS[option.globalRole]}`}>
                      <span className="min-w-0 truncate">{option.email}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{ROLE_LABELS[option.globalRole]}</span>
                    </ItemDescription>
                    : <ItemDescription>{option.email} · {ROLE_LABELS[option.globalRole]}</ItemDescription>}
                </ItemContent>
              </Item>
            </ComboboxItem>}
          </ComboboxCollection>
        </ComboboxGroup>}
      </ComboboxList>
    </ComboboxContent>
  </Combobox>);
}

/** #914 D3: the Team chip's accessible name, from the same people its avatars show. */
function teamTriggerName(value: TeamOption[]): string {
  const names = [...new Map(value.map((option) => [option.userId, displayName(option.name, option.email)])).values()];
  return names.length ? `Team: ${names.join(", ")}` : "Team: nobody assigned";
}

function stackPeople(value: TeamOption[]) {
  return [...new Map(value.map((option) => [option.userId, { id: option.userId, name: displayName(option.name, option.email), inactive: !option.active }])).values()];
}

const TEAM_POPOVER_META = "m-0 [font:var(--type-eyebrow)] text-foreground-secondary";
const TEAM_POPOVER_LABEL = "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

type TeamPickerProps = {
  groups: TeamGroup[];
  value: TeamOption[];
  onValueChange: (next: TeamOption[], eventDetails: ComboboxPrimitive.Root.ChangeEventDetails) => void;
  chipProps: (option: TeamOption) => TeamChipView;
  pending: Set<string>;
  inputRef?: Ref<HTMLInputElement>;
  inputDisabled: boolean;
  candidatesError: React.ReactNode;
  messages: React.ReactNode;
};

/** The Combobox props both grouped presentations share: multiple, keyed by role and person, filtered on name, email and roles. */
function teamPickerRootProps({ groups, value, onValueChange }: Pick<TeamPickerProps, "groups" | "value" | "onValueChange">) {
  return {
    multiple: true as const,
    items: groups,
    value,
    onValueChange,
    isItemEqualToValue: (a: TeamOption, b: TeamOption) => a.key === b.key,
    itemToStringLabel: (item: TeamOption) => displayName(item.name, item.email),
    itemToStringValue: (item: TeamOption) => item.key,
    filter: (item: TeamOption, query: string) => {
      const needle = query.trim().toLocaleLowerCase();
      if (!needle) return true;
      return `${item.name} ${item.email} ${ROLE_LABELS[item.role]} ${ROLE_LABELS[item.globalRole]}`.toLocaleLowerCase().includes(needle);
    },
  };
}

const TEAM_PICKER_FOOT = "The group you pick from sets the person’s role. Pick a checked person again to remove them.";

/** How many frames after the list mounts `OpenAtTop` keeps it at its top: Base UI's open-time scroll lands within the first one or two. */
const OPEN_AT_TOP_FRAMES = 6;
const PERSON_SCROLL_EVENTS = ["pointerdown", "wheel", "touchstart", "keydown"] as const;

/**
 * #914 D3 / M6 (browser pass): the Team list opens at its top. As the list opens Base UI scrolls the first selected option into
 * view (`useListNavigation`'s open-time `forceScrollIntoView`, no prop turns it off), which hid the first group heading and half a row
 * under the search. For the first frames after it mounts this puts every scroller from the list up to `bound` back at the top,
 * and stops at the person's first press, wheel, touch or key (a scroll they make, or arrowing to an option, is theirs). Typing a
 * query resets the list to its top in Base UI already.
 */
function OpenAtTop({ bound }: { bound: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const start = marker.current;
    const root = start?.closest<HTMLElement>(bound) ?? start?.closest<HTMLElement>('[data-testid="project-team-control"]') ?? null;
    if (!start || !root) return;
    let frame = 0;
    let left = OPEN_AT_TOP_FRAMES;
    let touched = false;
    const touch = () => { touched = true; };
    for (const type of PERSON_SCROLL_EVENTS) root.addEventListener(type, touch, { capture: true, passive: true });
    const reset = () => {
      if (touched) return;
      const list = root.querySelector<HTMLElement>('[data-slot="combobox-list"]');
      for (let element: HTMLElement | null = list; element; element = element === root ? null : element.parentElement) {
        if (element.scrollTop !== 0) element.scrollTop = 0;
      }
      left -= 1;
      if (left > 0) frame = requestAnimationFrame(reset);
    };
    reset();
    return () => {
      cancelAnimationFrame(frame);
      for (const type of PERSON_SCROLL_EVENTS) root.removeEventListener(type, touch, { capture: true });
    };
  }, [bound]);
  return <span ref={marker} hidden />;
}

/** D3 / M6's grouped list: Photographers, then Editors; each row an avatar, the name, the email and role, and its own state. */
function TeamGroupedList({ chipProps, pending, listClassName }: Pick<TeamPickerProps, "chipProps" | "pending"> & { listClassName?: string }) {
  return <>
    <ComboboxEmpty>No eligible people match.</ComboboxEmpty>
    <ComboboxList aria-label="Team candidates" className={listClassName}>
      {(group: TeamGroup) => <ComboboxGroup key={group.value} items={group.items} className="border-t border-border pt-[var(--space-1)] first:border-t-0">
        <ComboboxLabel className={TEAM_POPOVER_LABEL}>{group.label}</ComboboxLabel>
        <ComboboxCollection>
          {(option: TeamOption) => {
            const { dataState, isPending, messageId } = chipProps(option);
            return <ComboboxItem key={option.key} value={option} disabled={pending.has(option.key)} data-testid={`project-team-option-${option.key}`} data-state={dataState} aria-busy={isPending || undefined} aria-describedby={messageId} className="min-h-[44px]">
              <Item size="xs" className="p-0 flex-nowrap">
                <Avatar size="sm" className="size-7 shrink-0">
                  <AvatarFallback>{initials(option.name, option.email)}</AvatarFallback>
                </Avatar>
                <ItemContent className="min-w-0">
                  <ItemTitle className="block max-w-full truncate">{displayName(option.name, option.email)}</ItemTitle>
                  <ItemDescription className="truncate">{option.email} · {ROLE_LABELS[option.globalRole]}{!option.active && " · Inactive"}</ItemDescription>
                </ItemContent>
                <TeamChipStateIcon dataState={dataState} />
              </Item>
            </ComboboxItem>;
          }}
        </ComboboxCollection>
      </ComboboxGroup>}
    </ComboboxList>
  </>;
}

/**
 * #914 D3 — the Project header's Team: an avatar-stack chip (three faces, then +N) that opens the grouped picker with the search
 * field inside it (the `SubtaskAssigneePicker` shape: `ComboboxTrigger` + `ComboboxInput` in the popup). The same multi-select
 * Combobox and mutations as the chips presentation: the group a person is picked from sets the role, and pressing a checked person
 * again removes them. Each row shows its own pending or failed state; the failure messages and their Retry sit inside the popup.
 */
function TeamPopoverView({ contentRef, triggerRef, ...props }: TeamPickerProps & { contentRef?: Ref<HTMLDivElement>; triggerRef?: Ref<HTMLButtonElement> }) {
  const { value, inputRef, inputDisabled, candidatesError, messages } = props;
  const assigned = new Set(value.map((option) => option.userId)).size;
  return <Combobox {...teamPickerRootProps(props)}>
    <HeaderTooltip label="Team"><ComboboxTrigger ref={triggerRef} data-testid="project-team-trigger" aria-label={teamTriggerName(value)} className={cn(HEADER_CHIP, value.length > 0 && "ps-[var(--space-2)]")}>
      {value.length
        ? <AvatarStack decorative fullLimit people={stackPeople(value)} personNoun="team member" emptyLabel="Nobody assigned" />
        : <><PlusIcon aria-hidden="true" className="size-4" />Add team</>}
    </ComboboxTrigger></HeaderTooltip>
    <ComboboxContent ref={contentRef} align="end" data-testid="project-team-options" className="w-[320px] max-w-[calc(100vw-2*var(--space-4))]">
      <div className="flex items-center justify-between gap-[var(--space-2)] px-[var(--space-3)] pt-[var(--space-3)] pb-[var(--space-2)]">
        <span className={TEAM_POPOVER_LABEL}>Team</span>
        <span className={TEAM_POPOVER_META} data-testid="project-team-assigned">{assigned} assigned</span>
      </div>
      {candidatesError}
      <ComboboxInput ref={inputRef} showTrigger={false} placeholder="Search people…" aria-label="Search people" disabled={inputDisabled} aria-invalid={inputDisabled ? true : undefined} />
      <TeamGroupedList {...props} />
      <OpenAtTop bound='[data-slot="combobox-content"]' />
      {messages}
      <p className={cn(TEAM_POPOVER_META, "border-t border-border px-[var(--space-3)] pt-[var(--space-2)] pb-[var(--space-3)]")}>{TEAM_PICKER_FOOT}</p>
    </ComboboxContent>
  </Combobox>;
}

/**
 * #914 D2 "Manage" / M6 — the same grouped picker drawn in place, with no popup: Base UI's `<Combobox.Root inline open>`, the search
 * field above the list. The section it sits in (Project info) is the surface.
 */
function TeamInlineView({ fill = false, ...props }: TeamPickerProps & { fill?: boolean }) {
  const { inputRef, inputDisabled, candidatesError, messages } = props;
  return <Combobox {...teamPickerRootProps(props)} inline open>
    <div className={fill ? "flex min-h-0 flex-1 flex-col gap-[var(--space-2)]" : "grid gap-[var(--space-2)]"} data-testid="project-team-inline">
      {candidatesError}
      {/* M6: 16px type in the search, or iOS zooms the page on focus. */}
      <ComboboxInput ref={inputRef} showTrigger={false} placeholder="Search people…" aria-label="Search people" disabled={inputDisabled} aria-invalid={inputDisabled ? true : undefined} className={fill ? "mx-[var(--space-4)] shrink-0 min-h-[44px] *:text-[length:var(--text-base)]" : undefined} />
      {/* M6 (browser pass): in the phone Team view the helper line scrolls with the results, so with the keyboard up the results
          get the room rather than a pinned line. */}
      {fill
        ? <div className="grid min-h-0 flex-1 content-start overflow-y-auto overscroll-contain px-[var(--space-2)]">
          <TeamGroupedList {...props} listClassName="max-h-none overflow-visible" />
          {messages}
          <p className={cn(TEAM_POPOVER_META, "px-[var(--space-2)] pt-[var(--space-3)] pb-[max(var(--space-4),env(safe-area-inset-bottom))]")}>{TEAM_PICKER_FOOT}</p>
        </div>
        : <>
          <div className="grid"><TeamGroupedList {...props} /></div>
          {messages}
          <p className={TEAM_POPOVER_META}>{TEAM_PICKER_FOOT}</p>
        </>}
      <OpenAtTop bound={fill ? '[data-slot="drawer-content"]' : '[data-testid="project-team-control"]'} />
    </div>
  </Combobox>;
}

export type ProjectTeamPresentation = "chips" | "popover" | "inline";

export function ProjectTeamCombobox({ projectId, members, canEdit, archived = false, rowClassName, inputRef, presentation = "chips", onArchivedRefusal, triggerRef, fill = false }: { projectId: string; members: ProjectMember[]; canEdit: boolean; /** #452: an archived Project's Team is read-only. Also latched on from a 409 `membership_project_archived`, until this goes true to false (Restore). */ archived?: boolean; /** Sizes the Team row, read-only or editable (#458); the header passes its 44px control height. */ rowClassName?: string; /** #365: lets a hosting popover focus the input (the first chip × is a Tab stop and would otherwise take initial focus). */ inputRef?: Ref<HTMLInputElement>;
  /** #914: `"chips"` (the default: the Gantt People cell, New shoot's shape), `"popover"` (the Project header's avatar chip, D3) or `"inline"` (Project info's Manage, M6: the grouped list with no popup). */
  presentation?: ProjectTeamPresentation;
  /** #914: a write was refused as archived, so the host (the Project header's #455 latch) can turn the rest of its row read-only. This control moves its own focus. */
  onArchivedRefusal?: () => void;
  /** #914: the popover presentation's trigger. */
  triggerRef?: Ref<HTMLButtonElement>;
  /** #914 M6: the inline presentation fills its host's height: the search stays put and the list below it scrolls (the phone Team view). */
  fill?: boolean }) {
  const [latched, setLatched] = useState(false);
  const readOnly = archived || latched;
  const editable = canEdit && !readOnly;
  const candidatesQuery = useProjectAssignmentCandidatesQuery(editable);
  const noticeId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const readOnlyRef = useRef<HTMLDivElement>(null);
  const priorArchived = useRef(archived);
  const priorReadOnly = useRef(readOnly);
  const focusAtRequest = useRef(false);
  const focusAfterFlip = useRef<{ inControl: boolean } | null>(null);
  // The picker's list is portalled, so `root.contains()` alone misses focus that is inside it.
  const focusInControl = () => { const active = document.activeElement; return Boolean(active && (rootRef.current?.contains(active) || contentRef.current?.contains(active))); };
  const { mutationStates, pending, add, remove, clearSettled } = useTeamMutations(projectId, {
    onRequestStart: () => { focusAtRequest.current = focusInControl(); },
    onArchivedRefusal: () => { focusAfterFlip.current = { inControl: focusAtRequest.current }; setLatched(true); onArchivedRefusal?.(); },
  });

  // Restore: the prop goes true to false and the latch with it. (A Project archived and restored inside one refetch window keeps the latch until remount.)
  useLayoutEffect(() => { const was = priorArchived.current; priorArchived.current = archived; if (was && !archived) setLatched(false); }, [archived]);
  // Whatever turned the Team read-only (a refusal, or the prop arriving through a refetch), an earlier error's Retry could only 409 again.
  useLayoutEffect(() => { const was = priorReadOnly.current; priorReadOnly.current = readOnly; if (!was && readOnly) clearSettled(); }, [readOnly, clearSettled]);
  // Lost focus is decided from the capture taken when the request started, only on a refusal-driven flip, never on load: the controls
  // unmount in the flip commit, leaving focus on <body> (or a disabled control) unless it is moved to the always-mounted group.
  useLayoutEffect(() => {
    const flip = focusAfterFlip.current;
    if (!latched || !flip) return;
    focusAfterFlip.current = null;
    if (!flip.inControl) return;
    const active = document.activeElement;
    // Focus is lost when it sits on <body>, a disabled or disconnected node, or an ancestor that contains the Team control (a focus manager
    // reclaiming it). Another connected, enabled control the user moved to while the request was pending is theirs: leave it.
    const reclaimed = !!active && active !== document.body && (active.contains(rootRef.current) || active.contains(readOnlyRef.current) || active.contains(contentRef.current));
    if (!active || active === document.body || !active.isConnected || active.matches(":disabled") || (reclaimed && active !== readOnlyRef.current)) readOnlyRef.current?.focus();
  }, [latched]);
  const [pendingRemoveSnapshots, setPendingRemoveSnapshots] = useState<Record<string, ProjectMember>>({});
  const [expanded, setExpanded] = useState(false);

  const removeWithSnapshot = useCallback(async (member: ProjectMember) => {
    const key = cellKey(member.roleOnProject, member.userId);
    setPendingRemoveSnapshots((current) => ({ ...current, [key]: member }));
    try {
      await remove(member);
    } finally {
      setPendingRemoveSnapshots((current) => { if (!(key in current)) return current; const next = { ...current }; delete next[key]; return next; });
    }
  }, [remove]);

  const extraSnapshots = Object.values(pendingRemoveSnapshots).filter((snapshot) => !members.some((member) => member.roleOnProject === snapshot.roleOnProject && member.userId === snapshot.userId));
  const combined = [...members, ...extraSnapshots];
  const displayed = [...combined.filter((member) => member.roleOnProject === "photographer"), ...combined.filter((member) => member.roleOnProject === "editor")];

  const candidateList = candidatesQuery.data && Array.isArray(candidatesQuery.data.photographers) && Array.isArray(candidatesQuery.data.editors)
    ? candidatesQuery.data
    : { photographers: [], editors: [] };
  const photographerOptions = candidateList.photographers.map((candidate) => candidateOption("photographer", candidate));
  const editorOptions = candidateList.editors.map((candidate) => candidateOption("editor", candidate));
  const optionsByKey = new Map<string, TeamOption>();
  for (const option of [...photographerOptions, ...editorOptions]) optionsByKey.set(option.key, option);
  const value = displayed.map((member) => optionsByKey.get(cellKey(member.roleOnProject, member.userId)) ?? memberOption(member));
  // #914: the popover has no chips, so an assigned person who is not a candidate today (inactive) is listed, checked, under their
  // role: pressing it is their only remove. It is never addable, since it is only ever there while it is selected.
  const memberOnly = presentation !== "chips" ? value.filter((option) => !option.candidate) : [];
  const groups = [
    { value: "photographer", label: "Photographers", items: [...photographerOptions, ...memberOnly.filter((option) => option.role === "photographer")] },
    { value: "editor", label: "Editors", items: [...editorOptions, ...memberOnly.filter((option) => option.role === "editor")] },
  ];

  function onValueChange(next: TeamOption[], eventDetails: ComboboxPrimitive.Root.ChangeEventDetails) {
    // Base UI's own optimistic chip drop/query-clear must never win: our mutation ledger, not the
    // Combobox's local `value`, is the source of truth while a probe/confirm loop or a 409 merge
    // is in flight — see the file header and the plan's "pending-remove snapshot" note.
    eventDetails.cancel();
    const currentKeys = value.map((option) => option.key);
    const nextKeys = next.map((option) => option.key);
    const added = nextKeys.filter((key) => !currentKeys.includes(key));
    const removed = currentKeys.filter((key) => !nextKeys.includes(key));
    if (added.length === 1 && removed.length === 0) {
      const option = optionsByKey.get(added[0]!);
      if (option?.candidate) void add(option.role, option.candidate);
      return;
    }
    if (removed.length === 1 && added.length === 0) {
      const reason = eventDetails.reason;
      // Only an explicit item-press (deselecting ✓) or chip ×-press removes. Backspace-in-an-
      // empty-input is too easy to trigger by accident to treat as a removal (spec §onValueChange).
      if (reason !== "item-press" && reason !== "chip-remove-press") return;
      const removedKey = removed[0]!;
      // Always the member from CURRENT props, never the pending-remove snapshot — after a 409
      // conflict the snapshot's membership id is stale (plan's explicit contract).
      const member = members.find((candidate) => cellKey(candidate.roleOnProject, candidate.userId) === removedKey);
      if (member) void removeWithSnapshot(member);
    }
  }

  function chipDataState(option: TeamOption): TeamChipDataState {
    const state = mutationStates[option.key];
    return state?.kind === "pending" ? "pending" : state?.kind === "error" ? "error" : state?.kind === "conflict" ? "conflict" : "idle";
  }

  // "+N" must never hide a non-idle chip (review fix #204): auto-expand — on top of whatever the
  // user last chose — while any member beyond the first three is mid-mutation. `ChipRemove`
  // removes by DOM index, so the visible set must stay a prefix of `value`; expanding the whole
  // row is the only way to guarantee a hidden non-idle chip is never the one that gets removed.
  const hasHiddenNonIdle = value.slice(3).some((option) => chipDataState(option) !== "idle");
  const effectiveExpanded = expanded || hasHiddenNonIdle;
  const visible = effectiveExpanded ? value : value.slice(0, 3);
  const hiddenCount = value.length - visible.length;

  // Dual-role disambiguation (review fix #204): a userId displayed under both roles gets a short
  // visible role tag on each of its two chips so they are not identical text.
  const roleCountsByUserId = new Map<string, number>();
  for (const option of value) roleCountsByUserId.set(option.userId, (roleCountsByUserId.get(option.userId) ?? 0) + 1);
  const dualRoleUserIds = new Set([...roleCountsByUserId].filter(([, count]) => count > 1).map(([userId]) => userId));

  const chipLabels = teamChipLabels(value);

  function chipProps(option: TeamOption) {
    const dataState = chipDataState(option);
    const state = mutationStates[option.key];
    const isPending = dataState === "pending";
    const hasMessage = Boolean(state && state.kind !== "pending");
    const messageId = hasMessage ? `project-member-message-${option.key}` : undefined;
    const name = displayName(option.name, option.email);
    const roleTag = dualRoleUserIds.has(option.userId) ? shortRoleTag(option.role) : undefined;
    return { dataState, isPending, messageId, name, roleTag, label: chipLabels.get(option.userId) };
  }

  const candidatesError = editable && candidatesQuery.isError && <p className={PROJECT_TEAM_MESSAGE} role="alert">Candidates could not be loaded. {candidatesQuery.error instanceof Error ? candidatesQuery.error.message : "Try again shortly."}</p>;
  const messages = Object.entries(mutationStates).filter(([, state]) => state.kind !== "pending").map(([key, state]) => {
    if (state.kind === "pending") return null;
    const name = state.retry === "add" ? displayName(state.candidate.name, state.candidate.email) : displayName(state.member.name, state.member.email);
    return <div key={key} id={`project-member-message-${key}`} data-testid={`project-member-message-${key}`} role="alert" className={cn(PROJECT_TEAM_MESSAGE, presentation === "popover" && "px-[var(--space-3)] pb-[var(--space-2)]")}>
      {name}: {state.message}
      {state.kind === "error" && !readOnly && <Button type="button" variant="text" className="ml-[var(--space-2)] min-h-[44px]" onClick={() => state.retry === "add" ? void add(state.role, state.candidate) : void removeWithSnapshot(state.member)}>Retry</Button>}
    </div>;
  });
  const latchedNotice = latched && <p id={noticeId} role="status" className={ARCHIVED_HEADER_NOTICE_CLASS}>{ARCHIVED_TEAM_NOTICE}</p>;

  if (presentation === "inline") {
    return <div ref={rootRef} className={fill ? "flex min-h-0 flex-1 flex-col gap-[var(--space-3)]" : "grid gap-[var(--space-3)]"} data-testid="project-team-control">
      {editable ? <TeamInlineView
        fill={fill}
        groups={groups}
        value={value}
        onValueChange={onValueChange}
        chipProps={chipProps}
        pending={pending}
        inputRef={inputRef}
        inputDisabled={candidatesQuery.isError}
        candidatesError={candidatesError}
        messages={messages}
      /> : <div
        // Read-only (archived, or latched by a refusal here): the named group a refusal returns focus to, with the names by role.
        {...(readOnly ? { role: "group", "aria-label": "Team", tabIndex: -1, "aria-describedby": latched ? noticeId : undefined } : {})}
        ref={readOnlyRef}
        data-header-value="team"
        className="grid gap-[var(--space-1)] outline-none [font:var(--type-label)] text-foreground focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {value.length ? stackPeople(value).map((person) => <span key={person.id}>{person.name}</span>) : <span className="text-foreground-secondary">Nobody assigned</span>}
      </div>}
      {latchedNotice}
    </div>;
  }

  if (presentation === "popover") {
    return <div ref={rootRef} className="grid gap-[var(--space-3)]" data-testid="project-team-control">
      {editable ? <TeamPopoverView
        groups={groups}
        value={value}
        onValueChange={onValueChange}
        chipProps={chipProps}
        pending={pending}
        inputRef={inputRef}
        inputDisabled={candidatesQuery.isError}
        contentRef={contentRef}
        triggerRef={triggerRef}
        candidatesError={candidatesError && <div className="px-[var(--space-3)] pb-[var(--space-2)]">{candidatesError}</div>}
        messages={messages}
      /> : <div
        // D6: a flat value, no chevron. Only an archived (or latched) Team gets the named group: the focus target, and the anchor for the notice.
        {...(readOnly ? { role: "group", "aria-label": "Team", tabIndex: -1, "aria-describedby": latched ? noticeId : undefined } : {})}
        ref={readOnlyRef}
        data-header-value="team"
        className={HEADER_CHIP_LOCK}
      >
        {value.length
          ? <AvatarStack fullLimit people={stackPeople(value)} personNoun="team member" emptyLabel="Nobody assigned" />
          : <><span className="sr-only">No team assigned</span><span aria-hidden="true">—</span></>}
      </div>}
      {latchedNotice}
    </div>;
  }

  return <div ref={rootRef} className="grid gap-[var(--space-3)]" data-testid="project-team-control">
    {candidatesError}

    {editable ? <TeamComboboxView
      groups={groups}
      value={value}
      onValueChange={onValueChange}
      visible={visible}
      hiddenCount={hiddenCount}
      expanded={effectiveExpanded}
      onToggleExpanded={() => setExpanded(!effectiveExpanded)}
      chipProps={chipProps}
      pending={pending}
      lockedKeys={NO_LOCKED_KEYS}
      inputRef={inputRef}
      inputDisabled={candidatesQuery.isError}
      rowClassName={rowClassName}
      contentRef={contentRef}
    /> : <div
      // Only an archived (or latched) Team gets the named group: the focus target, and the anchor for the notice. A live read-only Team keeps its plain row.
      {...(readOnly ? { role: "group", "aria-label": "Team", tabIndex: -1, "aria-describedby": latched ? noticeId : undefined } : {})}
      ref={readOnlyRef}
      className={cn("flex flex-wrap items-center gap-1.5 outline-none focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2", rowClassName)}
    >
      {displayed.length ? <>
        {visible.map((option) => {
          const { dataState, messageId, name, roleTag, label } = chipProps(option);
          return <span
            key={option.key}
            data-testid={`project-member-${option.key}`}
            data-state={dataState}
            aria-describedby={messageId}
            title={`${name} · ${ROLE_LABELS[option.role]}`}
            className={cn(TEAM_CHIP, TEAM_CHIP_FIT, teamChipStateClasses(dataState), readOnly && "max-[721px]:min-h-0")}
          >
            <TeamChipContent option={option} dataState={dataState} roleTag={roleTag} label={label} />
          </span>;
        })}
        <TeamMoreToggle hiddenCount={hiddenCount} expanded={effectiveExpanded} onToggle={() => setExpanded(!effectiveExpanded)} />
      </> : readOnly
        // #452: an empty read-only Team shows a dash, like the header's Client; the visible mark is hidden from assistive tech, which reads the sr-only name.
        ? <><span className="sr-only">No team assigned</span><span aria-hidden="true" className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground">—</span></>
        : <p className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Not assigned</p>}
    </div>}
    {latchedNotice}

    {messages}
  </div>;
}

type TeamSelectionField = "photographerUserIds" | "editorUserIds";

/** New shoot's Team (#487): the same picker as the Project header, but it only *collects*. There is
 *  no Project yet, so nothing is saved per change; each add/remove is reported through `onToggle`
 *  and the parent form submits the ids with the create request.
 *
 *  Default editors (an active, editor-eligible user flagged `defaultEditor`) are applied by the
 *  server at creation, so they show as locked "Default editor" chips here and are never part of
 *  `editorUserIds`: sending them would turn a Default editor deactivated between page load and
 *  submit into a 422, which the server rule deliberately never raises. Removing one is done from
 *  the Project header after creation. */
export function ProjectTeamCollectCombobox({ photographerUserIds, editorUserIds, onToggle, rowClassName, inputRef, inputId }: {
  photographerUserIds: string[];
  editorUserIds: string[];
  onToggle: (field: TeamSelectionField, userId: string) => void;
  rowClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
  inputId?: string;
}) {
  const candidatesQuery = useProjectAssignmentCandidatesQuery(true);
  // A picked person who later drops out of the candidates (deactivated while the form is open) must keep their chip, so the last
  // option seen for each key is kept, like the header's `memberOption` for a member who is no longer a candidate.
  const lastSeen = useRef(new Map<string, TeamOption>());

  const candidateList = candidatesQuery.data && Array.isArray(candidatesQuery.data.photographers) && Array.isArray(candidatesQuery.data.editors)
    ? candidatesQuery.data
    : { photographers: [], editors: [] };
  const photographerOptions = candidateList.photographers.map((candidate) => candidateOption("photographer", candidate));
  const editorOptions = candidateList.editors.map((candidate) => candidateOption("editor", candidate));
  const optionsByKey = new Map<string, TeamOption>();
  for (const option of [...photographerOptions, ...editorOptions]) { optionsByKey.set(option.key, option); lastSeen.current.set(option.key, option); }
  const groups: TeamGroup[] = [
    { value: "photographer", label: "Photographers", items: photographerOptions },
    { value: "editor", label: "Editors", items: editorOptions },
  ];

  const lockedKeys = new Set(candidateList.editors.filter((candidate) => candidate.defaultEditor).map((candidate) => cellKey("editor", candidate.id)));
  const value: TeamOption[] = [];
  const seen = new Set<string>();
  const addToValue = (key: string) => {
    const option = optionsByKey.get(key) ?? lastSeen.current.get(key);
    if (option && !seen.has(key)) { seen.add(key); value.push(option); }
  };
  for (const id of photographerUserIds) addToValue(cellKey("photographer", id));
  for (const key of lockedKeys) addToValue(key);
  for (const id of editorUserIds) addToValue(cellKey("editor", id));
  // Photographers first, then editors, like the header.
  value.sort((left, right) => (left.role === right.role ? 0 : left.role === "photographer" ? -1 : 1));

  function onValueChange(next: TeamOption[], eventDetails: ComboboxPrimitive.Root.ChangeEventDetails) {
    // The form owns the selection; Base UI's optimistic local value must never be the source of truth.
    eventDetails.cancel();
    const currentKeys = value.map((option) => option.key);
    const nextKeys = next.map((option) => option.key);
    const added = nextKeys.filter((key) => !currentKeys.includes(key));
    const removed = currentKeys.filter((key) => !nextKeys.includes(key));
    const toggle = (key: string) => {
      if (lockedKeys.has(key)) return;
      const option = value.find((candidate) => candidate.key === key) ?? optionsByKey.get(key);
      if (option) onToggle(option.role === "photographer" ? "photographerUserIds" : "editorUserIds", option.userId);
    };
    if (added.length === 1 && removed.length === 0) { toggle(added[0]!); return; }
    // Only an explicit item-press or chip x removes; Backspace in an empty input is too easy to hit by accident.
    if (removed.length === 1 && added.length === 0 && (eventDetails.reason === "item-press" || eventDetails.reason === "chip-remove-press")) toggle(removed[0]!);
  }

  // Collect mode always tags a chip with its role, spelled out: the team is reviewed here before Create, with no header context.
  function chipProps(option: TeamOption): TeamChipView {
    return { dataState: "idle", isPending: false, messageId: undefined, name: displayName(option.name, option.email), roleTag: ROLE_LABELS[option.role] };
  }

  return <div className="grid gap-[var(--space-3)]" data-testid="project-team-collect">
    {candidatesQuery.isPending && <p role="status" className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Loading available team members…</p>}
    {candidatesQuery.isError && <p className={PROJECT_TEAM_MESSAGE} role="alert">
      Candidates could not be loaded. {candidatesQuery.error instanceof Error ? candidatesQuery.error.message : "Try again shortly."}
      <Button variant="text" className="ml-[var(--space-2)] max-[721px]:min-h-[44px]" onClick={() => void candidatesQuery.refetch()}>Retry</Button>
    </p>}
    <TeamComboboxView
      groups={groups}
      value={value}
      onValueChange={onValueChange}
      // Every chip is shown: the whole team is reviewed before Create, and the visible chips stay a prefix of `value`, which ChipRemove needs.
      visible={value}
      hiddenCount={0}
      expanded={false}
      onToggleExpanded={() => undefined}
      chipProps={chipProps}
      pending={NO_LOCKED_KEYS}
      lockedKeys={lockedKeys}
      inputRef={inputRef}
      inputDisabled={candidatesQuery.isError}
      rowClassName={rowClassName}
      blockEnterSubmit
      truncateDescriptions
      formControl
      inputId={inputId}
    />
  </div>;
}
