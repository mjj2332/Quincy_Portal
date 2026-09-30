import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "../reui/avatar";
import { initials } from "../../lib/initials";
import { cn } from "../../lib/utils";

export type AvatarStackPerson = { id: string; name: string; inactive?: boolean };

export type AvatarStackProps = {
  people: AvatarStackPerson[];
  /** Visible avatars before the `+N` overflow. */
  limit?: number;
  /** Singular noun for the overflow label ("2 more Editors") and an unnamed person. */
  personNoun: string;
  emptyLabel: string;
  /** Hide the stack from assistive tech, for use inside a control that already names its people. */
  decorative?: boolean;
  className?: string;
  /** Extra classes for every avatar and the `+N` count (a denser stack, e.g. inside a Calendar chip). */
  avatarClassName?: string;
  /** People the viewer may not see (an External Editor's `otherAssigneeCount`, #370): counted into the `+N`, never named. */
  hiddenCount?: number;
};

/**
 * A capped avatar stack with a `+N` overflow (#82, extracted for the Gantt People column in #365).
 * The list is displayed as given — the caller owns filtering and order. `role="img"` on each
 * avatar is load-bearing: `aria-label` on a roleless `<span>` is dropped by every major screen
 * reader. The avatars are static; the 44px touch-target contract belongs to whatever wraps them.
 */
export function AvatarStack({ people, limit = 3, personNoun, emptyLabel, decorative = false, className, avatarClassName, hiddenCount = 0 }: AvatarStackProps) {
  const hidden = decorative ? { "aria-hidden": true as const } : {};
  if (people.length === 0 && hiddenCount === 0) {
    return (
      <span
        {...(decorative ? hidden : { role: "img", "aria-label": emptyLabel })}
        className={cn("inline-block size-6 shrink-0 rounded-full border border-dashed border-[var(--border-hairline)] bg-transparent", className)}
      />
    );
  }
  const shown = people.slice(0, limit);
  const overflow = people.length - shown.length + hiddenCount;
  return (
    <AvatarGroup {...hidden} className={className}>
      {shown.map((person) => {
        const name = person.name.trim();
        const empty = name === "";
        const label = (empty ? `${personNoun} (name unavailable)` : name) + (person.inactive ? " (inactive)" : "");
        return (
          <Avatar key={person.id} size="sm" role="img" aria-label={label} className={cn(person.inactive && "opacity-60", avatarClassName)}>
            <AvatarFallback aria-hidden="true">{empty ? "?" : initials(person.name)}</AvatarFallback>
          </Avatar>
        );
      })}
      {overflow > 0 && (
        <AvatarGroupCount role="img" className={avatarClassName} aria-label={`${overflow} more ${personNoun}${overflow === 1 ? "" : "s"}`}>
          <span aria-hidden="true">+{overflow}</span>
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  );
}
