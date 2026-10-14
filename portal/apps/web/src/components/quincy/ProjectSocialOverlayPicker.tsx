import { useEffect, useRef, useState } from "react";
import { useRunFence, type RunTicket } from "../../lib/use-run-fence";
import { useQueryClient } from "@tanstack/react-query";
import { PROJECT_SOCIAL_OVERLAYS_MAX, type ProjectSocialOverlayChoice, type ProjectSocialOverlaysResponse, type Role } from "@quincy/shared";
import { projectDataKeys, useProjectSocialOverlaysQuery } from "../../lib/project-data";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime } from "../../lib/project-query-sync";
import { saveProjectSocialOverlays, SocialOverlaysSaveError } from "../../lib/project-social-overlays";
import { cn } from "../../lib/utils";
import { Badge } from "../reui/badge";
import { Button } from "../reui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "../reui/combobox";
import { Field, FieldDescription, FieldError, FieldLabel } from "../reui/field";
import { Item, ItemContent, ItemDescription, ItemTitle } from "../reui/item";
import { META_TRIGGER } from "./icon-button";

type Failure = { kind: "failed" } | { kind: "conflict"; current: ProjectSocialOverlaysResponse } | { kind: "unavailable" };
type Request = { overlayIds: string[]; expectedRevision: string };

// Compact like the Stage / Dropbox triggers (#858 round 2): META_TRIGGER is `inline-grid`, which stacked the chevron under the label, and the Field stretches its direct children (`*:w-full`), so the trigger sits in a wrapper div and `w-fit` keeps it content-sized.
const TRIGGER_CLASSES = "inline-flex flex-row items-center justify-between self-start w-fit max-w-full gap-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-sm)] bg-card border-solid border-[length:var(--border-width-hair)] border-border [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground";
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));
const TRIGGER_ID = "project-social-overlays-trigger";

/**
 * Which Social overlays this Project offers in the Video viewer (#870). The composition is `quincy/SubtaskAssigneePicker`'s: `reui/combobox` `multiple`, a local draft that picks edit freely,
 * the one write on close (so a burst of picks is a single request that cannot race its own `expectedOverlayIds`), and focus put back on the trigger before the popup unmounts. The write names the
 * COMPLETE stored set the picker last saw, archived choices included: an archived overlay is never offered, stays on the Project that had it, and is shown here as Archived and read-only.
 * A failed save keeps the attempted choice on screen with Retry (a transient failure) or Reload (a conflict, which applies the fresh server state only when asked).
 */
export function ProjectSocialOverlayPicker({ projectId, role, canEdit, archived, onArchivedRefusal }: { projectId: string; role: Role; canEdit: boolean; archived: boolean; /** The server refused a save because the Project is archived: the header latches its other controls too. */ onArchivedRefusal?: () => void }) {
  const queryClient = useQueryClient();
  const query = useProjectSocialOverlaysQuery(projectId, true, role);
  const data = query.data;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [attempt, setAttempt] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [latched, setLatched] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const draftRef = useRef<string[]>([]);
  const baselineRef = useRef<{ ids: string[]; revision: string }>({ ids: [], revision: "" });
  const lastRequest = useRef<Request | null>(null);
  // The picker is re-keyed on its Project (ProjectHeader), so keying the fence on projectId matches that remount.
  const fence = useRunFence(projectId);
  const readOnly = !canEdit || archived || latched;
  // Restore (the prop goes true to false) drops a latch set by a refusal.
  const priorArchived = useRef(archived);
  useEffect(() => { const was = priorArchived.current; priorArchived.current = archived; if (was && !archived) setLatched(false); }, [archived]);
  useEffect(() => { if (readOnly) { setOpen(false); setDraft(baselineRef.current.ids); draftRef.current = baselineRef.current.ids; } }, [readOnly]);

  if (!data) {
    if (query.isError || !query.isPending) return null;
    return <span className="sr-only" role="status">Loading Social overlays</span>;
  }

  const known = new Map<string, ProjectSocialOverlayChoice>([...data.selected, ...data.available].map((choice) => [choice.id, choice]));
  const revision = data.revision;
  const activeIds = data.selected.filter((choice) => choice.archivedAt === null).map((choice) => choice.id);
  const archivedChoices = data.selected.filter((choice) => choice.archivedAt !== null);
  const draftChoices = draft.map((id) => known.get(id)).filter((choice): choice is ProjectSocialOverlayChoice => Boolean(choice));
  const shownIds = open ? draft : attempt ?? activeIds;
  const shownNames = shownIds.map((id) => known.get(id)?.name).filter((name): name is string => Boolean(name));
  const libraryEmpty = data.available.length === 0 && data.resolved.length === 0;
  const defaultName = data.available.find((choice) => choice.isDefault)?.name ?? data.resolved.find((overlay) => overlay.isDefault)?.name;
  const nothingChosen = shownIds.length === 0;

  // A read still in flight began before this answer: cancel it so it cannot land on top (a cancelled query keeps the data set after).
  async function publish(next: ProjectSocialOverlaysResponse, ticket: RunTicket) {
    await queryClient.cancelQueries({ queryKey: projectDataKeys.socialOverlays(projectId) });
    if (!ticket.isCurrent()) return;
    queryClient.setQueryData(projectDataKeys.socialOverlays(projectId), next);
    getProjectQueryRuntime(queryClient)?.publish(createProjectDataInvalidationMessage(projectId, [{ kind: "social-overlays" }]));
  }

  async function send(request: Request) {
    const originating = projectId;
    const ticket = fence.begin();
    lastRequest.current = request;
    setAttempt(request.overlayIds); setFailure(null); setSaving(true);
    try {
      const next = await saveProjectSocialOverlays(originating, request.overlayIds, request.expectedRevision);
      if (!ticket.isCurrent()) return;
      await publish(next, ticket);
      if (!ticket.isCurrent()) return;
      setAttempt(null);
    } catch (error) {
      if (!ticket.isCurrent()) return;
      const reason = error instanceof SocialOverlaysSaveError ? error.failure : { kind: "failed" as const, message: "" };
      if (reason.kind === "archived") {
        setLatched(true); setAttempt(null); onArchivedRefusal?.();
        void queryClient.invalidateQueries({ queryKey: projectDataKeys.detail(projectId) });
      }
      else if (reason.kind === "conflict") setFailure({ kind: "conflict", current: reason.current });
      else if (reason.kind === "unavailable") setFailure({ kind: "unavailable" });
      else setFailure({ kind: "failed" });
    } finally {
      if (ticket.isCurrent()) setSaving(false);
    }
  }

  function reload() {
    const fresh = failure?.kind === "conflict" ? failure.current : null;
    setFailure(null); setAttempt(null); lastRequest.current = null;
    if (fresh) void queryClient.cancelQueries({ queryKey: projectDataKeys.socialOverlays(projectId) }).then(() => queryClient.setQueryData(projectDataKeys.socialOverlays(projectId), fresh));
    else void query.refetch();
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      if (saving || libraryEmpty || readOnly) return;
      baselineRef.current = { ids: activeIds, revision };
      draftRef.current = activeIds; setDraft(activeIds); setFailure(null); setAttempt(null); lastRequest.current = null; setOpen(true);
      void query.refetch();
      return;
    }
    // Focus sits in the popup's search input, which unmounts with the popup, and the Project sheet's focus manager would claim it: put it on the trigger first, on every close path.
    const trigger = triggerRef.current;
    const active = document.activeElement;
    if (trigger && active && active !== trigger && active.closest('[data-slot="combobox-content"]')) trigger.focus({ preventScroll: true });
    setOpen(false);
    const final = draftRef.current, baseline = baselineRef.current;
    if (sameSet(final, baseline.ids)) return;
    void send({ overlayIds: final, expectedRevision: baseline.revision });
  }

  function handleValueChange(next: ProjectSocialOverlayChoice[]) {
    const ids = next.map((choice) => choice.id);
    draftRef.current = ids; setDraft(ids);
  }

  const hint = libraryEmpty
    ? "Social preview unavailable. An Admin adds overlays in Admin, Social overlays."
    : nothingChosen
      ? `Nothing chosen: this Project offers the Default overlay${defaultName ? ` (${defaultName})` : ""}.`
      : null;
  const archivedBadges = archivedChoices.length > 0 && <div className="flex flex-wrap items-center gap-[var(--space-2)]" data-testid="social-overlays-archived">
    {archivedChoices.map((choice) => <span key={choice.id} className="inline-flex items-center gap-[var(--space-1)] text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)]">{choice.name}<Badge variant="secondary" size="sm">Archived</Badge></span>)}
  </div>;

  if (readOnly) {
    const names = data.resolved.map((overlay) => overlay.name).join(", ");
    return <Field className="gap-[var(--space-1)]" data-testid="project-social-overlays">
      <FieldLabel>Social overlays</FieldLabel>
      <span className="min-h-[44px] inline-flex items-center text-foreground [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)]" data-testid="social-overlays-summary">{names || "None"}</span>
      {archivedBadges}
      {(archived || latched) && <FieldDescription>This Project is archived, so its Social overlays are read-only.</FieldDescription>}
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>;
  }

  const errorMessage = failure?.kind === "conflict" ? "The Social overlays changed since you looked, so your choice was not saved."
    : failure?.kind === "unavailable" ? "One of those overlays is no longer available, so your choice was not saved."
    : failure?.kind === "failed" ? "Your Social overlays could not be saved." : null;

  return <Field className="gap-[var(--space-1)]" data-testid="project-social-overlays">
    <FieldLabel htmlFor={TRIGGER_ID}>Social overlays</FieldLabel>
    <Combobox
      multiple
      open={open}
      onOpenChange={handleOpenChange}
      items={data.available}
      value={draftChoices.filter((choice) => choice.archivedAt === null)}
      onValueChange={handleValueChange}
      isItemEqualToValue={(a: ProjectSocialOverlayChoice, b: ProjectSocialOverlayChoice) => a.id === b.id}
      itemToStringLabel={(item: ProjectSocialOverlayChoice) => item.name}
      itemToStringValue={(item: ProjectSocialOverlayChoice) => item.id}
      disabled={libraryEmpty}
    >
      {/* The vertical Field gives every direct child `w-full`, which outranks the trigger's own `w-fit`; this wrapper takes the full width so the trigger keeps its content size. */}
      <div>
        <ComboboxTrigger ref={triggerRef} id={TRIGGER_ID} aria-label="Social overlays" aria-busy={saving || undefined} className={cn(META_TRIGGER, TRIGGER_CLASSES, "min-h-[44px]")}>
          <span className="min-w-0 max-w-[28ch] truncate">{shownNames.length > 0 ? shownNames.join(", ") : "Default overlay"}</span>
        </ComboboxTrigger>
      </div>
      <ComboboxContent className="min-w-[max(var(--anchor-width),260px)] max-w-[calc(100vw-2*var(--space-4))]">
        <ComboboxInput showTrigger={false} placeholder="Search overlays…" aria-label="Search overlays" />
        <ComboboxEmpty>No matching overlays</ComboboxEmpty>
        <ComboboxList aria-label="Social overlays">
          {(choice: ProjectSocialOverlayChoice) => <ComboboxItem key={choice.id} value={choice} disabled={!draft.includes(choice.id) && draft.length >= PROJECT_SOCIAL_OVERLAYS_MAX} className="max-[721px]:min-h-[44px]">
            <Item size="xs" className="p-0">
              <ItemContent>
                <ItemTitle className="whitespace-nowrap" data-testid="overlay-option-name">{choice.name}{choice.isDefault && <Badge variant="secondary" size="sm" className="ml-[var(--space-1)]">Default</Badge>}</ItemTitle>
                <ItemDescription>{choice.platformLabel}</ItemDescription>
              </ItemContent>
            </Item>
          </ComboboxItem>}
        </ComboboxList>
        {draft.length >= PROJECT_SOCIAL_OVERLAYS_MAX && <p className="px-[var(--space-3)] py-[var(--space-2)] text-foreground-secondary [font:var(--weight-regular)_var(--text-sm)/1.3_var(--font-sans)]">You can choose up to {PROJECT_SOCIAL_OVERLAYS_MAX} overlays. Remove one to pick another.</p>}
      </ComboboxContent>
    </Combobox>
    {archivedBadges}
    {hint && <FieldDescription>{hint}</FieldDescription>}
    {errorMessage && <FieldError role="alert" className="flex flex-wrap items-center gap-[var(--space-2)]">
      <span>{errorMessage}</span>
      {failure?.kind === "failed" && <Button type="button" variant="outline" size="sm" onClick={() => { if (lastRequest.current) void send(lastRequest.current); }}>Retry</Button>}
      {failure?.kind !== "failed" && <Button type="button" variant="outline" size="sm" onClick={reload}>Reload</Button>}
    </FieldError>}
  </Field>;
}
