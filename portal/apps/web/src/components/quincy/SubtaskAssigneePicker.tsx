import { useEffect, useRef, useState } from "react";
import type { Role } from "@quincy/shared";
import { useSubtaskAssigneeOptions } from "../../lib/project-data";
import { initials } from "../../lib/initials";
import { cn } from "../../lib/utils";
import { AvatarStack } from "./AvatarStack";
import { META_TRIGGER } from "./icon-button";
import { Avatar, AvatarFallback } from "../reui/avatar";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "../reui/combobox";
import { Item, ItemContent, ItemTitle } from "../reui/item";

export type AssigneePickerPerson = { id: string; name: string };

export type SubtaskAssigneePickerProps = {
  projectId: string;
  role: Role;
  /** The trigger's accessible name. */
  label: string;
  selected: AssigneePickerPerson[];
  /** People the viewer may not see (External Editors): counted on the trigger, never listed. */
  hiddenCount?: number;
  disabled?: boolean;
  /** The composer's bordered arm of the trigger. */
  compact?: boolean;
  /** Called once when the list closes with a different set: the final ids, and those people (id and name) for a caller that keeps the selection itself. */
  onCommit: (nextIds: string[], people: AssigneePickerPerson[]) => void | Promise<void>;
};

type Option = AssigneePickerPerson & { inactive: boolean };

const TRIGGER_CLASSES = "[&>svg]:hidden";
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
export function SubtaskAssigneePicker({ projectId, role, label, selected, hiddenCount = 0, disabled = false, compact = false, onCommit }: SubtaskAssigneePickerProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [committing, setCommitting] = useState<string[] | null>(null);
  const draftRef = useRef<string[]>([]);
  const options = useSubtaskAssigneeOptions(projectId, role, open || hasOpened);
  const multiAssignee = options.data?.multiAssignee ?? false;

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
    if (disabled && next) return;
    if (next) {
      const current = selected.map((person) => person.id);
      draftRef.current = current; setDraft(current); setHasOpened(true); setOpen(true);
      return;
    }
    setOpen(false);
    const final = draftRef.current;
    if (sameSet(final, selected.map((person) => person.id))) return;
    setCommitting(final);
    const people = final.map((id) => known.get(id)).filter((option): option is Option => Boolean(option)).map(({ id, name }) => ({ id, name }));
    void Promise.resolve(onCommit(final, people)).finally(() => setCommitting(null));
  }

  function handleValueChange(next: Option[]) {
    const nextIds = next.map((option) => option.id);
    const added = nextIds.filter((id) => !draftRef.current.includes(id));
    const resolved = !multiAssignee && added.length ? [added[added.length - 1]!] : nextIds;
    draftRef.current = resolved; setDraft(resolved);
  }

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
    <ComboboxTrigger aria-label={label} className={cn(META_TRIGGER, TRIGGER_CLASSES, compact && COMPACT_CLASSES)}>
      <AvatarStack people={open ? draftOptions : shownPeople} hiddenCount={open ? 0 : hiddenCount} personNoun="Assignee" emptyLabel="Unassigned" />
    </ComboboxTrigger>
    <ComboboxContent className="min-w-[max(var(--anchor-width),260px)] max-w-[calc(100vw-2*var(--space-4))]">
      <ComboboxInput showTrigger={false} placeholder="Search people…" aria-label="Search people" />
      <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
      <ComboboxList aria-label={label}>
        {(option: Option) => <ComboboxItem key={option.id} value={option} className="max-[721px]:min-h-[44px]">
          <Item size="xs" className="p-0">
            <Avatar size="sm" className="size-6"><AvatarFallback>{initials(option.name)}</AvatarFallback></Avatar>
            <ItemContent>
              <ItemTitle className="whitespace-nowrap" data-testid="assignee-option-name">{option.name}{option.inactive && <em className="ml-[var(--space-1)] not-italic uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution-text)]"> Inactive</em>}</ItemTitle>
            </ItemContent>
          </Item>
        </ComboboxItem>}
      </ComboboxList>
    </ComboboxContent>
  </Combobox>;
}
