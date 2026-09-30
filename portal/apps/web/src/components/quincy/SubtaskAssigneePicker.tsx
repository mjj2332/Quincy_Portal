import { useEffect, useRef, useState } from "react";
import type { Role } from "@quincy/shared";
import { useSubtaskAssigneeOptions } from "../../lib/project-data";
import { initials } from "../../lib/initials";
import { cn } from "../../lib/utils";
import { AvatarStack } from "./AvatarStack";
import { EmptyAssigneeGlyph } from "./EmptyAssigneeGlyph";
import { META_TRIGGER } from "./icon-button";
import { Avatar, AvatarFallback } from "../reui/avatar";
import { StatusPill } from "./StatusPill";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "../reui/combobox";
import { Item, ItemContent, ItemTitle } from "../reui/item";

export type AssigneePickerPerson = { id: string; name: string };

/** What the picker showed when it opened: the diff and `expectedVersion` are computed against this, never against a refetch that landed while it was open. */
export type AssigneePickerBaseline = { ids: string[]; version: number | undefined };

export type SubtaskAssigneePickerProps = {
  projectId: string;
  role: Role;
  /** The trigger's accessible name. */
  label: string;
  selected: AssigneePickerPerson[];
  /** The selection's version (a Checklist row's `assignmentVersion`); captured on open and handed back with the baseline. */
  version?: number;
  /** People the viewer may not see (External Editors): counted on the trigger, never listed. */
  hiddenCount?: number;
  disabled?: boolean;
  /** A write for this row is in flight: the trigger stays mounted, enabled and focusable (Base UI hands focus back to it on close) but will not open. Use this, not `disabled`, for transient busy state. */
  busy?: boolean;
  /** The composer's bordered arm of the trigger. */
  compact?: boolean;
  /** Called once when the list closes with a different set: the final ids, and those people (id and name) for a caller that keeps the selection itself. */
  onCommit: (nextIds: string[], people: AssigneePickerPerson[], baseline: AssigneePickerBaseline) => void | Promise<void>;
};

type Option = AssigneePickerPerson & { inactive: boolean };

// shrink-0: the stack is bounded (at most 3 avatars and a chip) and must not clip at 375px; the row's schedule chip truncates instead.
const TRIGGER_CLASSES = "[&>svg]:hidden shrink-0";
const COMPACT_CLASSES = "border-solid border-[length:var(--border-width-hair)] border-border";

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Multi-select assignee list for a Checklist row or the composer (#368). The same composition as
 * `ProjectTeamCombobox` (`reui/combobox` `multiple` + `reui/item` + `reui/avatar`), behind an avatar-stack trigger.
 * Picking only edits a local draft; the one write happens on close, so a burst of picks is a single versioned request
 * rather than several that would race their own `expectedVersion`.
 */
export function SubtaskAssigneePicker({ projectId, role, label, selected, version, hiddenCount = 0, disabled = false, busy = false, compact = false, onCommit }: SubtaskAssigneePickerProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [committing, setCommitting] = useState<string[] | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const draftRef = useRef<string[]>([]);
  const baselineRef = useRef<AssigneePickerBaseline>({ ids: [], version: undefined });
  const options = useSubtaskAssigneeOptions(projectId, role, open || hasOpened);

  // Selected first, then everyone else; a selected person no longer among the candidates (deactivated) stays listed so they can be removed.
  const byId = new Map<string, Option>();
  for (const person of selected) byId.set(person.id, { ...person, inactive: false });
  const candidateIds = new Set((options.data?.candidates ?? []).map((candidate) => candidate.id));
  const list: Option[] = [
    ...selected.map((person) => ({ ...person, inactive: options.data ? !candidateIds.has(person.id) : false })),
    ...(options.data?.candidates ?? []).filter((candidate) => !byId.has(candidate.id)).map((candidate) => ({ ...candidate, inactive: false })),
  ];
  const known = new Map(list.map((option) => [option.id, option]));
  const draftOptions = draft.map((id) => known.get(id)).filter((option): option is Option => Boolean(option));
  // While the write is in flight the trigger keeps showing what was picked, not the stale prop.
  const shownPeople = committing ? committing.map((id) => known.get(id)).filter((option): option is Option => Boolean(option)) : selected;
  useEffect(() => { if (committing && sameSet(committing, selected.map((person) => person.id))) setCommitting(null); }, [committing, selected]);

  function handleOpenChange(next: boolean) {
    if ((disabled || busy) && next) return;
    if (next) {
      const current = selected.map((person) => person.id);
      baselineRef.current = { ids: current, version };
      draftRef.current = current; setDraft(current); setHasOpened(true); setOpen(true);
      return;
    }
    // Focus is in the popup's search input, which unmounts with the popup. Base UI hands focus back to the trigger only AFTER
    // that, so focus would fall to <body> first; a modal ancestor's focus manager (the Project sheet) claims it and re-focuses
    // itself on the next frame, stealing it from the trigger. Put focus on the trigger before anything unmounts, on every close path.
    const trigger = triggerRef.current;
    const active = document.activeElement;
    if (trigger && active && active !== trigger && active.closest('[data-slot="combobox-content"]')) trigger.focus({ preventScroll: true });
    setOpen(false);
    const final = draftRef.current;
    const baseline = baselineRef.current;
    if (sameSet(final, baseline.ids)) return;
    setCommitting(final);
    const people = final.map((id) => known.get(id)).filter((option): option is Option => Boolean(option)).map(({ id, name }) => ({ id, name }));
    void Promise.resolve(onCommit(final, people, baseline)).finally(() => setCommitting(null));
  }

  function handleValueChange(next: Option[]) {
    const nextIds = next.map((option) => option.id);
    draftRef.current = nextIds; setDraft(nextIds);
  }

  const shownNames = (open ? draftOptions : shownPeople).map((person) => person.name.trim()).filter(Boolean);
  const titleNames = shownNames.join(", ");
  const others = open ? 0 : hiddenCount; // people the viewer may not see: a count, never names
  const triggerTitle = titleNames || others > 0
    ? `${titleNames}${titleNames && others > 0 ? " " : ""}${others > 0 ? `${titleNames ? "and " : ""}${others} other${others === 1 ? "" : "s"}` : ""}`
    : "Unassigned";

  const triggerPeople = open ? draftOptions : shownPeople;
  const triggerHidden = open ? 0 : hiddenCount;

  const emptyMessage = options.isError ? "People could not be loaded." : options.isPending ? "Loading people…" : "No matching people";

  return <Combobox
    multiple
    open={open}
    onOpenChange={handleOpenChange}
    items={list}
    value={draftOptions}
    onValueChange={handleValueChange}
    isItemEqualToValue={(a: Option, b: Option) => a.id === b.id}
    itemToStringLabel={(item: Option) => item.name}
    itemToStringValue={(item: Option) => item.id}
    disabled={disabled}
  >
    <ComboboxTrigger ref={triggerRef} aria-label={label} title={triggerTitle} aria-busy={busy || undefined} aria-disabled={busy || undefined} className={cn(META_TRIGGER, TRIGGER_CLASSES, compact && COMPACT_CLASSES)}>
      {triggerPeople.length === 0 && triggerHidden <= 0
        ? <EmptyAssigneeGlyph />
        : <AvatarStack people={triggerPeople} hiddenCount={triggerHidden} personNoun="Assignee" emptyLabel="Unassigned" />}
    </ComboboxTrigger>
    <ComboboxContent className="min-w-[max(var(--anchor-width),260px)] max-w-[calc(100vw-2*var(--space-4))]">
      <ComboboxInput showTrigger={false} placeholder="Search people…" aria-label="Search people" />
      <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
      <ComboboxList aria-label={label}>
        {(option: Option) => <ComboboxItem key={option.id} value={option} className="max-[721px]:min-h-[44px]">
          <Item size="xs" className="p-0">
            <Avatar size="sm" className="size-6"><AvatarFallback>{initials(option.name)}</AvatarFallback></Avatar>
            <ItemContent>
              <ItemTitle className="whitespace-nowrap" data-testid="assignee-option-name">{option.name}{option.inactive && <StatusPill tone="neutral" className="ml-[var(--space-1)]">Inactive</StatusPill>}</ItemTitle>
            </ItemContent>
          </Item>
        </ComboboxItem>}
      </ComboboxList>
    </ComboboxContent>
  </Combobox>;
}
