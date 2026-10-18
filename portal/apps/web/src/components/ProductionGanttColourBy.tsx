import type { CSSProperties, ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/reui/avatar";
import { ToggleGroup, ToggleGroupItem } from "@/components/reui/toggle-group";
import type { ColourBy, PeopleKeyEntry } from "../lib/timeline-colour-by";
import { cn } from "../lib/utils";
import { Eyebrow } from "./quincy/Eyebrow";

/**
 * #916 / #920: the Timeline's Colour by controls, frame 3b (`design/prototypes/dashboard-views`,
 * "Dashboard views v3", `.nbar .lab` + `.seg2`, and the People `.keyrow`).
 *
 * `TimelineColourBySwitch` is controlled: `colourBy` in, `onColourByChange` out. `ProductionGantt`
 * reads the remembered choice once (`useTimelineColourBy`, `lib/timeline-colour-by.ts`) and renders
 * the switch in its nav on desktop and tablet; the phone Key drawer (#921) renders the same switch with
 * the same pair. A ReUI `ToggleGroup` in its scoped `segment` variant (`reui/toggle-group.tsx` item 2,
 * `reui/toggle.tsx` item 7): one choice is always pressed, so pressing the pressed one changes nothing.
 *
 * `PeopleKeyRow` replaces the Stage key in People mode: one chip per person on a drawn Subtask with how
 * many of their Subtasks are open, then Unassigned. Display-only (owner decision D6): the chips are
 * not buttons and write no filter. Like `StageKeyRow`, the row lays out its chips only; the band it
 * sits in belongs to the host.
 */

export function TimelineColourBySwitch({
  colourBy,
  onColourByChange,
  className,
}: {
  colourBy: ColourBy;
  onColourByChange: (next: ColourBy) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* The group carries the name; this is its visible caption (frame 3b `.lab`, 0.08em tracking). */}
      <Eyebrow aria-hidden="true" className="tracking-[var(--tracking-wide)]">Colour by</Eyebrow>
      <ToggleGroup
        variant="segment"
        size="segment"
        spacing={0.5}
        aria-label="Colour by"
        data-testid="timeline-colour-by"
        value={[colourBy]}
        onValueChange={(next) => {
          const picked = next[0];
          if (picked === "stage" || picked === "people") onColourByChange(picked);
        }}
      >
        <ToggleGroupItem value="stage" data-testid="timeline-colour-by-stage">Stage</ToggleGroupItem>
        <ToggleGroupItem value="people" data-testid="timeline-colour-by-people">People</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

/** Frame 3b `.av.pc`: a person's initials on their colour (paper initials clear 5.9:1 on every `--people-N`). Decorative. */
export function PersonToneAvatar({ initials, color, className }: { initials: string; color: string; className?: string }) {
  return (
    <Avatar aria-hidden="true" className={cn("size-6.5", className)} style={{ "--person-color": color } as CSSProperties}>
      <AvatarFallback className="bg-(--person-color) text-xs text-[var(--paper-000)]">{initials}</AvatarFallback>
    </Avatar>
  );
}

function PeopleKeyChip({ swatch, label, open }: { swatch: ReactNode; label: string; open: number }) {
  return (
    <span
      data-testid="people-key-chip"
      className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-card ps-1 pe-3 text-sm text-foreground max-[721px]:h-11 pointer-coarse:h-11"
    >
      {swatch}
      {label}
      <span className="font-mono text-xs tabular-nums text-foreground-secondary">{open} open</span>
    </span>
  );
}

export function PeopleKeyRow({ people, unassignedOpen, trailing }: { people: readonly PeopleKeyEntry[]; unassignedOpen: number; trailing?: ReactNode }) {
  return (
    <div role="group" aria-label="People key" data-testid="people-key-row" className="flex flex-wrap items-center gap-2">
      {people.map((person) => (
        <PeopleKeyChip key={person.personId} swatch={<PersonToneAvatar initials={person.initials} color={person.color} />} label={person.label} open={person.open} />
      ))}
      <PeopleKeyChip
        // Frame 3b `.av.none`: the unassigned treatment, Awaiting RAW's greige in a dashed ring.
        swatch={<span aria-hidden="true" className="size-6.5 shrink-0 rounded-full border-[length:var(--border-width-mid)] border-dashed border-(--stage-awaiting-raw) bg-card" />}
        label="Unassigned"
        open={unassignedOpen}
      />
      {trailing !== undefined && <div className="ms-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
