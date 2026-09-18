import { useCallback, useState } from "react";
import type { Combobox as ComboboxPrimitive } from "@base-ui/react";
import type { ProjectMemberRole } from "@quincy/shared";
import { ApiError, apiDeleteWithBody, apiPutWithStatus } from "../lib/api";
import { confirm } from "../lib/confirm";
import { buttonClasses } from "./quincy/Button";
import { cn } from "../lib/utils";
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
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "./reui/combobox";
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
  globalRole: string;
  active: boolean;
  candidate: ProjectAssignmentCandidate | null;
};

const PROJECT_TEAM_MESSAGE =
  "col-span-full [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] " +
  "text-[color:var(--signal-critical)]";

const TEAM_CHIP_REMOVE_HIT_AREA =
  // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token. The visible icon-xs
  // button is 24px (`size-6`); a transparent pseudo-element extends the hit area to 44px
  // (24 + 10 + 10) without growing the chip itself.
  "relative before:absolute before:content-[''] before:-inset-[10px]";

function cellKey(roleOnProject: ProjectMemberRole, userId: string) { return `${roleOnProject}:${userId}`; }
function roleLabel(roleOnProject: ProjectMemberRole) { return roleOnProject === "photographer" ? "Photographer" : "Editor"; }
function globalRoleLabel(role: string) { return role === "admin" ? "Admin" : role === "photographer" ? "Photographer" : role === "external_editor" ? "External editor" : "Editor"; }
function details(error: unknown): Record<string, unknown> | null { return error instanceof ApiError && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : null; }
function displayName(name: string, email: string) { return name || email; }
function firstName(name: string, email: string) {
  const trimmed = displayName(name, email).trim();
  return trimmed.split(/\s+/)[0] ?? "";
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
function useTeamMutations(projectId: string) {
  const queryClient = useOptionalProjectQueryClient();
  const terminateOnUnauthorized = useProjectAccessTermination();
  const [mutationStates, setMutationStates] = useState<Record<string, PersonMutationState>>({});
  const pending = new Set(Object.entries(mutationStates).filter(([, state]) => state.kind === "pending").map(([key]) => key));

  function setState(key: string, state: PersonMutationState | null) {
    setMutationStates((current) => { const next = { ...current }; if (state) next[key] = state; else delete next[key]; return next; });
  }

  async function add(roleOnProject: ProjectMemberRole, candidate: ProjectAssignmentCandidate) {
    const key = cellKey(roleOnProject, candidate.id);
    if (pending.has(key) || !queryClient) return;
    setState(key, { kind: "pending", intent: "add" });
    const optimistic: ProjectMember = { id: `optimistic-${key}`, userId: candidate.id, roleOnProject, name: candidate.name, email: candidate.email, globalRole: candidate.globalRole, active: true, assignedSubtaskCount: 0 };
    let mutation: Awaited<ReturnType<typeof beginProjectMembershipMutation>> | undefined;
    try {
      mutation = await beginProjectMembershipMutation(queryClient, projectId, roleOnProject, candidate.id, "add", optimistic);
      const response = await apiPutWithStatus<MembershipResponse>(`/api/projects/${encodeURIComponent(projectId)}/${roleOnProject === "photographer" ? "photographers" : "editors"}/${encodeURIComponent(candidate.id)}`);
      await mutation.commit(response.data.membership);
      await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "activity" }], dashboard: true, calendar: true });
      setState(key, null);
    } catch (error) {
      await mutation?.fail(); terminateOnUnauthorized(error); setState(key, { kind: "error", retry: "add", role: roleOnProject, candidate, message: error instanceof Error ? error.message : "Assignment could not be added." });
    }
  }

  async function remove(member: ProjectMember) {
    const key = cellKey(member.roleOnProject, member.userId);
    if (pending.has(key) || !queryClient) return;
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
        await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "activity" }, ...(response.subtaskAssignmentsCleared > 0 ? [{ kind: "subtasks" as const }] : [])], dashboard: true, calendar: true });
        setState(key, null);
        return;
      } catch (error) {
        const payload = details(error);
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

  return { mutationStates, pending, add, remove };
}

function TeamChipContent({ option }: { option: TeamOption }) {
  const name = displayName(option.name, option.email);
  return <>
    <Avatar size="sm" className="size-4">
      <AvatarFallback className="text-[8px]">{initials(option.name, option.email)}</AvatarFallback>
    </Avatar>
    <span className="[overflow-wrap:anywhere]">
      {firstName(option.name, option.email)}
      {!option.active && <em className="ml-[var(--space-1)] not-italic uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution-text)]"> Inactive</em>}
    </span>
    <span className="sr-only">{name}</span>
  </>;
}

function TeamMoreToggle({ hiddenCount, expanded, onToggle }: { hiddenCount: number; expanded: boolean; onToggle: () => void }) {
  if (hiddenCount <= 0 && !expanded) return null;
  const label = expanded ? "Show fewer team members" : `Show ${hiddenCount} more team members`;
  return <button
    type="button"
    className={buttonClasses("text", { className: "min-h-[44px] shrink-0 !normal-case" })}
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

export function ProjectTeamCombobox({ projectId, members, canEdit }: { projectId: string; members: ProjectMember[]; canEdit: boolean }) {
  const anchor = useComboboxAnchor();
  const candidatesQuery = useProjectAssignmentCandidatesQuery(canEdit);
  const { mutationStates, pending, add, remove } = useTeamMutations(projectId);
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
  const groups = [
    { value: "photographer", label: "Photographers", items: photographerOptions },
    { value: "editor", label: "Editors", items: editorOptions },
  ];

  const value = displayed.map((member) => optionsByKey.get(cellKey(member.roleOnProject, member.userId)) ?? memberOption(member));

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

  const visible = expanded ? value : value.slice(0, 3);
  const hiddenCount = value.length - visible.length;

  function chipProps(option: TeamOption) {
    const state = mutationStates[option.key];
    const dataState = state?.kind === "pending" ? "pending" : state?.kind === "error" ? "error" : state?.kind === "conflict" ? "conflict" : "idle";
    const isPending = dataState === "pending";
    const hasMessage = Boolean(state && state.kind !== "pending");
    const messageId = hasMessage ? `project-member-message-${option.key}` : undefined;
    const name = displayName(option.name, option.email);
    return { dataState, isPending, messageId, name };
  }

  return <div className="grid gap-[var(--space-3)]" data-testid="project-team-control">
    {canEdit && candidatesQuery.isError && <p className={cn(PROJECT_TEAM_MESSAGE)} role="alert">Candidates could not be loaded. {candidatesQuery.error instanceof Error ? candidatesQuery.error.message : "Try again shortly."}</p>}

    {canEdit ? <Combobox
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
        return `${item.name} ${item.email} ${roleLabel(item.role)} ${globalRoleLabel(item.globalRole)}`.toLocaleLowerCase().includes(needle);
      }}
    >
      <ComboboxChips ref={anchor} className="rounded-full has-data-[slot=combobox-chip]:pl-1">
        <ComboboxValue>
          {() => visible.map((option) => {
            const { dataState, isPending, messageId, name } = chipProps(option);
            return <ComboboxChip
              key={option.key}
              showRemove
              className="rounded-full gap-1.5"
              data-testid={`project-member-${option.key}`}
              data-state={dataState}
              aria-busy={isPending || undefined}
              aria-describedby={messageId}
              title={`${name} · ${roleLabel(option.role)}`}
              removeProps={{
                "aria-label": `Remove ${name} (${roleLabel(option.role)})`,
                "data-testid": "project-member-remove",
                disabled: isPending,
                className: TEAM_CHIP_REMOVE_HIT_AREA,
              }}
            >
              <TeamChipContent option={option} />
            </ComboboxChip>;
          })}
        </ComboboxValue>
        <TeamMoreToggle hiddenCount={hiddenCount} expanded={expanded} onToggle={() => setExpanded((current) => !current)} />
        <ComboboxChipsInput aria-label="Add team member" placeholder="Add team member…" disabled={candidatesQuery.isError} aria-invalid={candidatesQuery.isError ? true : undefined} />
      </ComboboxChips>
      <ComboboxContent anchor={anchor} className="max-w-(--anchor-width) min-w-(--anchor-width)">
        <ComboboxEmpty>No eligible people match.</ComboboxEmpty>
        <ComboboxList aria-label="Team candidates">
          {(group: (typeof groups)[number]) => <ComboboxGroup key={group.value} items={group.items}>
            <ComboboxLabel>{group.label}</ComboboxLabel>
            <ComboboxCollection>
              {(option: TeamOption) => <ComboboxItem key={option.key} value={option} disabled={pending.has(option.key)}>
                <Item size="xs" className="p-0">
                  <Avatar size="sm" className="size-6">
                    <AvatarFallback>{initials(option.name, option.email)}</AvatarFallback>
                  </Avatar>
                  <ItemContent>
                    <ItemTitle className="whitespace-nowrap">{displayName(option.name, option.email)}</ItemTitle>
                    <ItemDescription>{option.email} · {globalRoleLabel(option.globalRole)}</ItemDescription>
                  </ItemContent>
                </Item>
              </ComboboxItem>}
            </ComboboxCollection>
          </ComboboxGroup>}
        </ComboboxList>
      </ComboboxContent>
    </Combobox> : <div className="flex flex-wrap items-center gap-1.5">
      {displayed.length ? <>
        {visible.map((option) => {
          const { dataState, name } = chipProps(option);
          return <span
            key={option.key}
            data-testid={`project-member-${option.key}`}
            data-state={dataState}
            title={`${name} · ${roleLabel(option.role)}`}
            className="flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1.5 rounded-full bg-muted px-1.5 text-xs font-medium whitespace-nowrap text-foreground"
          >
            <TeamChipContent option={option} />
          </span>;
        })}
        <TeamMoreToggle hiddenCount={hiddenCount} expanded={expanded} onToggle={() => setExpanded((current) => !current)} />
      </> : <p className="m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Not assigned</p>}
    </div>}

    {Object.entries(mutationStates).filter(([, state]) => state.kind !== "pending").map(([key, state]) => {
      if (state.kind === "pending") return null;
      const name = state.retry === "add" ? displayName(state.candidate.name, state.candidate.email) : displayName(state.member.name, state.member.email);
      return <div key={key} id={`project-member-message-${key}`} data-testid={`project-member-message-${key}`} role="alert" className={cn(PROJECT_TEAM_MESSAGE)}>
        {name}: {state.message}
        {state.kind === "error" && <button type="button" className={buttonClasses("text", { className: "ml-[var(--space-2)] min-h-[44px]" })} onClick={() => state.retry === "add" ? void add(state.role, state.candidate) : void removeWithSnapshot(state.member)}>Retry</button>}
      </div>;
    })}
  </div>;
}
