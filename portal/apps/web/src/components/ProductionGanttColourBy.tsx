import type { CSSProperties, ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/reui/avatar";
import { toggleChipDisplayClassName } from "@/components/reui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/reui/toggle-group";
import { peopleToneColor } from "../lib/dashboard-appearance";
import type { ColourBy, PeopleKeyEntry } from "../lib/timeline-colour-by";
import { cn } from "../lib/utils";
import { Eyebrow } from "./quincy/Eyebrow";
import { KEY_ROW_CLASS, KEY_ROW_LIST_CLASS, KEY_ROW_TRAILING_CLASS } from "./quincy/StageKeyRow";

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

/**
 * Frame 3b `.av.pc`: a person's initials on their colour (`--text-on-tone` clears 5.9:1 on every `--people-N`). Decorative.
 * `chip` (26px) in the People key; `bar` (22px) beside a same-day Subtask's diamond on the Timeline.
 */
export function PersonToneAvatar({ initials, color, size = "chip", className }: { initials: string; color: string; size?: "chip" | "bar"; className?: string }) {
  return (
    <Avatar aria-hidden="true" size={size} className={className} style={{ "--person-color": color } as CSSProperties}>
      <AvatarFallback className="bg-(--person-color) text-on-tone">{initials}</AvatarFallback>
    </Avatar>
  );
}

/** A People key chip: the Stage key's Toggle `chip` pill, drawn as a display-only chip (D6), the swatch hugging its start. */
function PeopleKeyChip({ swatch, label, open }: { swatch: ReactNode; label: string; open: number }) {
  return (
    <span data-testid="people-key-chip" className={cn(toggleChipDisplayClassName, "ps-1")}>
      {swatch}
      {label}
      <span className="font-mono text-xs tabular-nums text-foreground-secondary">{open} open</span>
    </span>
  );
}

/** Frame 3b `.av.none`: the unassigned treatment, a dashed ring in the module's unassigned colour. */
const UNASSIGNED_SWATCH_COLOR = peopleToneColor({ kind: "unassigned" });

export function PeopleKeyRow({ people, unassignedOpen, trailing }: { people: readonly PeopleKeyEntry[]; unassignedOpen: number; trailing?: ReactNode }) {
  return (
    <div role="group" aria-label="People key" data-testid="people-key-row" className={KEY_ROW_CLASS}>
      <div className={KEY_ROW_LIST_CLASS}>
        {people.map((person) => (
          <PeopleKeyChip key={person.personId} swatch={<PersonToneAvatar initials={person.initials} color={person.color} />} label={person.label} open={person.open} />
        ))}
        <PeopleKeyChip
          swatch={
            <span
              aria-hidden="true"
              className="size-6.5 shrink-0 rounded-full border-[length:var(--border-width-mid)] border-dashed border-(--person-color) bg-card"
              style={{ "--person-color": UNASSIGNED_SWATCH_COLOR } as CSSProperties}
            />
          }
          label="Unassigned"
          open={unassignedOpen}
        />
      </div>
      {trailing !== undefined && <div className={KEY_ROW_TRAILING_CLASS}>{trailing}</div>}
    </div>
  );
}
