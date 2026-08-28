import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, size, useFloating } from "@floating-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectMemberRole } from "@quincy/shared";
import { ApiError, apiDeleteWithBody, apiPutWithStatus } from "../lib/api";
import { confirm } from "../lib/confirm";
import {
  beginProjectMembershipMutation,
  useProjectAssignmentCandidatesQuery,
  useProjectAccessTermination,
  useOptionalProjectQueryClient,
  type ProjectAssignmentCandidate,
  type ProjectMember,
} from "../lib/project-data";

type PersonMutationState =
  | { kind: "pending"; intent: "add" | "remove" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string };

type MembershipResponse = { outcome: "created" | "unchanged"; membership: ProjectMember };
type RemoveResponse = { outcome: "removed"; removed: { membershipCycle: string; userId: string; roleOnProject: ProjectMemberRole }; subtaskAssignmentsCleared: number };

function cellKey(roleOnProject: ProjectMemberRole, userId: string) { return `${roleOnProject}:${userId}`; }
function roleLabel(roleOnProject: ProjectMemberRole) { return roleOnProject === "photographer" ? "Photographer" : "Editor"; }
function globalRoleLabel(role: string) { return role === "admin" ? "Admin" : role === "photographer" ? "Photographer" : role === "external_editor" ? "External editor" : "Editor"; }
function details(error: unknown): Record<string, unknown> | null { return error instanceof ApiError && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : null; }

function TeamPicker({ roleOnProject, candidates, selectedIds, pending, onSelect }: {
  roleOnProject: ProjectMemberRole;
  candidates: ProjectAssignmentCandidate[];
  selectedIds: Set<string>;
  pending: Set<string>;
  onSelect: (candidate: ProjectAssignmentCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = `project-team-${roleOnProject}-listbox`;
  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "bottom-start",
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableWidth, availableHeight, elements }) { Object.assign(elements.floating.style, { maxWidth: `${availableWidth}px`, maxHeight: `${availableHeight}px` }); } })],
  });
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return candidates.filter((candidate) => !needle || `${candidate.name} ${candidate.email} ${globalRoleLabel(candidate.globalRole)}`.toLocaleLowerCase().includes(needle));
  }, [candidates, query]);
  useEffect(() => { if (open) { setActiveIndex(0); window.setTimeout(() => searchRef.current?.focus(), 0); } else setQuery(""); }, [open]);
  useEffect(() => { if (activeIndex >= matches.length) setActiveIndex(Math.max(0, matches.length - 1)); }, [activeIndex, matches.length]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && (triggerRef.current?.contains(node) || floating.refs.floating.current?.contains(node))) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [floating.refs.floating, open]);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(0, matches.length - 1))); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    if (event.key === "Enter" && matches[activeIndex]) { event.preventDefault(); onSelect(matches[activeIndex]!); }
  }
  return <>
    <button ref={(node) => { triggerRef.current = node; floating.refs.setReference(node); }} type="button" className="project-team__add" aria-label={`Add ${roleLabel(roleOnProject)}`} aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen((value) => !value)}>+ Add</button>
    {open && <FloatingPortal><FloatingFocusManager context={floating.context} modal={false} initialFocus={searchRef} returnFocus={triggerRef}>
      <div ref={floating.refs.setFloating} className="project-team-picker" style={floating.floatingStyles} role="dialog" aria-label={`Add ${roleLabel(roleOnProject)}`} onKeyDown={onKeyDown}>
        <label className="sr-only" htmlFor={`${listId}-search`}>Search {roleLabel(roleOnProject).toLocaleLowerCase()}s</label>
        <input ref={searchRef} id={`${listId}-search`} type="search" value={query} placeholder="Search name, email or role…" onChange={(event) => setQuery(event.target.value)} />
        <div id={listId} className="project-team-picker__results" role="listbox" aria-label={`${roleLabel(roleOnProject)} candidates`}>
          {matches.length ? matches.map((candidate, index) => {
            const key = cellKey(roleOnProject, candidate.id);
            const isSelected = selectedIds.has(candidate.id);
            const isPending = pending.has(key);
            return <button key={candidate.id} type="button" role="option" aria-selected={isSelected} aria-current={index === activeIndex ? "true" : undefined} className={`project-team-picker__option${isSelected ? " is-selected" : ""}`} disabled={isPending} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(candidate)}>
              <span><strong>{candidate.name || candidate.email}</strong><small>{candidate.email} · {globalRoleLabel(candidate.globalRole)}</small></span><span aria-hidden="true">{isSelected ? "✓" : ""}</span>
            </button>;
          }) : <p className="project-team-picker__empty">No eligible people match.</p>}
        </div>
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}

export function ProjectTeamControl({ projectId, members, canEdit }: { projectId: string; members: ProjectMember[]; canEdit: boolean }) {
  const queryClient = useOptionalProjectQueryClient();
  const candidatesQuery = useProjectAssignmentCandidatesQuery(canEdit);
  const terminateOnUnauthorized = useProjectAccessTermination();
  const [mutationStates, setMutationStates] = useState<Record<string, PersonMutationState>>({});
  const photographers = members.filter((member) => member.roleOnProject === "photographer");
  const editors = members.filter((member) => member.roleOnProject === "editor");
  const pending = new Set(Object.entries(mutationStates).filter(([, state]) => state.kind === "pending").map(([key]) => key));
  const selected = (roleOnProject: ProjectMemberRole) => new Set(members.filter((member) => member.roleOnProject === roleOnProject).map((member) => member.userId));
  const candidateList = candidatesQuery.data && Array.isArray(candidatesQuery.data.photographers) && Array.isArray(candidatesQuery.data.editors)
    ? candidatesQuery.data
    : { photographers: [], editors: [] };

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
      setState(key, null);
    } catch (error) {
      await mutation?.fail(); terminateOnUnauthorized(error); setState(key, { kind: "error", message: error instanceof Error ? error.message : "Assignment could not be added." });
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
        const body = { membershipCycle: member.id, clearSubtaskAssignments: confirmedCount !== null, confirmedAssignmentCount: confirmedCount ?? 0 } as const;
        const response = await apiDeleteWithBody<RemoveResponse, typeof body>(`/api/projects/${encodeURIComponent(projectId)}/${member.roleOnProject === "photographer" ? "photographers" : "editors"}/${encodeURIComponent(member.userId)}`, body);
        await mutation.commit(undefined, response.subtaskAssignmentsCleared);
        setState(key, null);
        return;
      } catch (error) {
        const payload = details(error);
        if (error instanceof ApiError && error.status === 422 && payload?.code === "subtask_assignment_confirmation_required") {
          await mutation?.fail();
          if (typeof payload.assignmentCount !== "number") {
            // Never fabricate a confirmation count for a malformed server response — the dialog
            // must only ever display a server-verified count, per the plan's explicit contract.
            setState(key, { kind: "error", message: "Assignment could not be removed." });
            return;
          }
          const count = payload.assignmentCount;
          const accepted = await confirm({ title: "Remove final project role?", message: `Removing ${member.name || member.email}'s final project role will unassign ${count} checklist item${count === 1 ? "" : "s"}. Continue?`, confirmLabel: "Remove and unassign", danger: true });
          if (!accepted) { setState(key, null); return; }
          confirmedCount = count;
          continue;
        }
        if (error instanceof ApiError && error.status === 409 && payload?.code === "membership_cycle_changed") {
          const currentMembership = payload.currentMembership as ProjectMember | null | undefined;
          await mutation?.conflict(currentMembership ?? null);
          setState(key, { kind: "conflict", message: "Assignment changed elsewhere. Review the refreshed row before trying again." });
          return;
        }
        await mutation?.fail(); terminateOnUnauthorized(error); setState(key, { kind: "error", message: error instanceof Error ? error.message : "Assignment could not be removed." });
        return;
      }
    }
  }

  function roleSection(roleOnProject: ProjectMemberRole, roleMembers: ProjectMember[], roleCandidates: ProjectAssignmentCandidate[]) {
    const roleSelected = selected(roleOnProject);
    const roleErrors = Object.entries(mutationStates).filter(([key, state]) => key.startsWith(`${roleOnProject}:`) && state.kind === "error");
    return <section className="project-team__role" aria-labelledby={`project-team-${roleOnProject}-heading`}>
      <div className="project-team__role-head"><h3 id={`project-team-${roleOnProject}-heading`}>{roleLabel(roleOnProject)}s</h3>{canEdit && <TeamPicker roleOnProject={roleOnProject} candidates={roleCandidates} selectedIds={roleSelected} pending={pending} onSelect={(candidate) => void add(roleOnProject, candidate)} />}</div>
      {roleErrors.map(([key, state]) => {
        const candidate = roleCandidates.find((item) => key === cellKey(roleOnProject, item.id));
        return <div className="project-team__message project-team__message--error" role="alert" key={key}>{state.kind === "error" ? state.message : "Assignment could not be added."}{candidate && <button type="button" onClick={() => void add(roleOnProject, candidate)}>Retry</button>}</div>;
      })}
      {roleMembers.length ? <div className="project-team__members">{roleMembers.map((member) => {
        const key = cellKey(roleOnProject, member.userId); const state = mutationStates[key];
        return <div className={`project-team__member${!member.active ? " is-inactive" : ""}`} key={member.id} data-testid={`project-member-${key}`}><div className="project-team__identity"><strong>{member.name || member.email}</strong><small>{member.email} · {globalRoleLabel(member.globalRole)}{!member.active && <em>Inactive</em>}</small></div>{canEdit && <button type="button" className="project-team__remove" disabled={state?.kind === "pending"} onClick={() => void remove(member)}>{state?.kind === "pending" ? "Working…" : "Remove"}</button>} {state && state.kind !== "pending" && <div className={`project-team__message project-team__message--${state.kind}`} role="alert">{state.message}{state.kind === "error" && <button type="button" onClick={() => void remove(member)}>Retry</button>}</div>}</div>;
      })}</div> : <p className="project-team__empty">Not assigned</p>}
    </section>;
  }

  return <div className="project-team" data-testid="project-team-control">
    {candidatesQuery.isError && canEdit && <p className="project-team__message project-team__message--error" role="alert">Candidates could not be loaded. {candidatesQuery.error instanceof Error ? candidatesQuery.error.message : "Try again shortly."}</p>}
    {roleSection("photographer", photographers, candidateList.photographers)}
    {roleSection("editor", editors, candidateList.editors)}
  </div>;
}
