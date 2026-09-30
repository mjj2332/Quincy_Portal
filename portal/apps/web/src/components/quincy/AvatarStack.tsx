import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "../reui/avatar";
import { initials } from "../../lib/initials";
import { cn } from "../../lib/utils";

export type AvatarStackPerson = { id: string; name: string; inactive?: boolean };

export type AvatarStackProps = {
  people: AvatarStackPerson[];
  /** Most avatars shown; when there are more people, `limit - 1` avatars and the `+N` chip share that width. */
  limit?: number;
  /** Singular noun for the overflow label ("2 more Editors") and an unnamed person. */
  personNoun: string;
  emptyLabel: string;
  /**
   * People the viewer may not see (an External Editor's view of non-team assignees): a count only, never an id, name,
   * initials or tooltip. Folded into the overflow chip as "+N others".
   */
  hiddenCount?: number;
  /** Hide the stack from assistive tech, for use inside a control that already names its people. */
  decorative?: boolean;
  className?: string;
  /** Extra classes for every avatar and the `+N` count (a denser stack, e.g. inside a Calendar chip). */
  avatarClassName?: string;
  /**
   * Show one initial per avatar. Two 11px initials are wider than the visible part of an overlapped 16px avatar, so a
   * dense stack clips the second letter (#370); the full name stays in the avatar's label.
   */
  singleInitial?: boolean;
};

/**
 * A capped avatar stack with a `+N` overflow (#82, extracted for the Gantt People column in #365).
 * The list is displayed as given — the caller owns filtering and order. `role="img"` on each
 * avatar is load-bearing: `aria-label` on a roleless `<span>` is dropped by every major screen
 * reader. The avatars are static; the 44px touch-target contract belongs to whatever wraps them.
 */
export function AvatarStack({ people, limit = 3, personNoun, emptyLabel, hiddenCount = 0, decorative = false, className, avatarClassName, singleInitial = false }: AvatarStackProps) {
  const hidden = decorative ? { "aria-hidden": true as const } : {};
  if (people.length === 0 && hiddenCount <= 0) {
    return (
      <span
        {...(decorative ? hidden : { role: "img", "aria-label": emptyLabel })}
        className={cn("inline-block size-6 shrink-0 rounded-full border border-dashed border-[var(--border-hairline)] bg-transparent", className)}
      />
    );
  }
  // With a `+N` chip, one fewer avatar: 3 avatars and a chip need ~84px, more than the Gantt People column's ~80px of content.
  const shown = people.slice(0, people.length > limit ? Math.max(limit - 1, 1) : limit);
  const overflow = people.length - shown.length;
  const countLabel = [
    overflow > 0 ? `${overflow} more ${personNoun}${overflow === 1 ? "" : "s"}` : null,
    hiddenCount > 0 ? `${hiddenCount} other${hiddenCount === 1 ? "" : "s"} not shown` : null,
  ].filter(Boolean).join(" and ");
  return (
    <AvatarGroup {...hidden} className={cn("-space-x-[var(--space-1)]", className)}>
      {shown.map((person) => {
        const name = person.name.trim();
        const empty = name === "";
        const label = (empty ? `${personNoun} (name unavailable)` : name) + (person.inactive ? " (inactive)" : "");
        return (
          <Avatar key={person.id} size="sm" role="img" aria-label={label} className={cn(person.inactive && "opacity-60", avatarClassName)}>
            <AvatarFallback aria-hidden="true">{empty ? "?" : singleInitial ? [...initials(person.name)].slice(0, 1).join("") : initials(person.name)}</AvatarFallback>
          </Avatar>
        );
      })}
      {(overflow > 0 || hiddenCount > 0) && (
        <AvatarGroupCount role="img" aria-label={countLabel} className={cn(avatarClassName, hiddenCount > 0 && "w-auto group-has-data-[size=sm]/avatar-group:w-auto min-w-6 px-[var(--space-2)] whitespace-nowrap", hiddenCount > 0 && !avatarClassName && "text-xs")}>
          <span aria-hidden="true">{hiddenCount > 0 ? `+${overflow + hiddenCount} others` : `+${overflow}`}</span>
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  );
}
