import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Project priority as a five-star control (#81).
 *
 * Quincy-owned, deliberately **not** a registry component, following the precedent of
 * `quincy/menu.tsx`. The vendored ReUI `Rating` is mouse-only — click handlers on bare `<div>`s,
 * no role, no tab stop, no key handling, no route back to null, and a hardcoded `fill-yellow-400`.
 * It must never be installed into this app or "restored" to the registry.
 *
 * ## Semantics: a radiogroup whose unset state is "nothing checked"
 *
 * `role="radiogroup"` with five `role="radio"` children. Unset priority is all five
 * `aria-checked="false"` — the same state a required-but-unanswered radio question is in, and how
 * a screen-reader user learns there is no priority. There is deliberately no sixth "no priority"
 * radio: a sixth 44px coarse target does not fit the column (see the geometry note below), and it
 * would put a non-star glyph in a row whose whole job is to read as a rating at a glance.
 *
 * ## Manual selection — the one deliberate deviation, and why
 *
 * The WAI-ARIA APG radio-group pattern uses *automatic* selection: an arrow key both moves focus
 * and checks. This control uses **manual** selection — arrows move focus only, Enter/Space commits
 * — which matches #81's and #76's literal wording ("arrow keys traverse, Enter/Space sets") and
 * avoids a real defect:
 *
 * `Dashboard.tsx`'s `setProjectPriority` opens with `if (pendingOrdering.has(project.id)) return;`.
 * Under automatic selection, travelling 1 -> 5 fires four calls; the first sets `pendingOrdering`,
 * so calls two through four hit that early return — no optimistic update, no error, no toast. The
 * card would settle on 2 while the user watched it travel to 5. Debouncing would fix the call
 * count but not the model: the intermediate presses would still be *announced* as selections that
 * never happened. One gesture, one write, is the only shape that cannot lie.
 *
 * A reviewer holding the APG open will read this as a defect. It is not — do not "restore"
 * automatic selection.
 *
 * ## Ends clamp, they do not wrap
 *
 * APG permits either. This is an ordinal magnitude, so wrapping would turn "one arrow past 5" into
 * priority 1 — the single worst wrong value this control can produce.
 */

const STARS = [1, 2, 3, 4, 5] as const;

function starLabel(value: number): string {
  return value === 1 ? "1 star" : `${value} stars`;
}

export type PriorityStarsProps = {
  /** The Project's current priority, or `null` when unset. This component is fully controlled. */
  priority: number | null;
  /** The Project's street, used to disambiguate the group among many cards. */
  street: string;
  /** Admin-only. When false the control is read-only, and renders nothing at all when unset. */
  canPrioritize: boolean;
  /** True while a write for this Project is in flight; commits are ignored and the group is busy. */
  pending?: boolean;
  onPriorityChange?: (priority: number | null) => void;
};

export function PriorityStars({ priority, street, canPrioritize, pending = false, onPriorityChange }: PriorityStarsProps) {
  // Roving focus index, not a value: the *value* is `priority`, owned by the caller. Keeping a
  // second copy of the value here would hide the coordinator's optimistic update and its rollback.
  const [focusIndex, setFocusIndex] = useState(() => (priority ?? 1) - 1);
  const [announcement, setAnnouncement] = useState("");
  const starRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const shouldFocusRef = useRef(false);

  // Follow the prop when it changes underneath us — notably the coordinator's rollback path, which
  // restores the previous priority after a failed write.
  useEffect(() => { setFocusIndex((priority ?? 1) - 1); }, [priority]);

  // Move real DOM focus only in response to a key the user pressed, never on an incoming prop
  // change: stealing focus because a background refresh changed a value is its own defect.
  useEffect(() => {
    if (!shouldFocusRef.current) return;
    shouldFocusRef.current = false;
    starRefs.current[focusIndex]?.focus();
  }, [focusIndex]);

  // Non-Admins on an unset Project see nothing in this slot at all (#76 user story 7). ~90% of
  // live Projects are unset, so this is the common case, and a row of a control they can never use
  // would be the Board's dominant visual.
  if (!canPrioritize && priority === null) return null;

  // Read-only presentation. `role="img"` is load-bearing: an `aria-label` on a roleless <span> is
  // dropped by every major screen reader. (`components/atoms.tsx`'s `Stars` has that bug today —
  // it is a live defect on the Asset-rating surface, and must not be copied here.)
  if (!canPrioritize) {
    return (
      <div className="flex items-center px-[var(--space-3)] pb-[var(--space-3)]" data-testid="kanban2-card-priority">
        <span role="img" aria-label={`Priority ${priority} of 5 stars`} className="inline-flex items-center gap-[2px] text-base leading-none">
          {STARS.map((star) => (
            <span key={star} aria-hidden="true" className={star <= (priority ?? 0) ? "text-star-on" : "text-star-off"}>★</span>
          ))}
        </span>
      </div>
    );
  }

  function commit(value: number) {
    if (pending) return;
    // Re-activating the currently-set value clears it. This is the gesture an ARIA radio group has
    // no native analogue for, and the reason the unset state is "nothing checked" rather than a
    // sixth member.
    const next = value === priority ? null : value;
    setAnnouncement(next === null ? "Priority cleared." : `Priority set to ${starLabel(next)}.`);
    onPriorityChange?.(next);
  }

  function clear() {
    if (pending || priority === null) return;
    setAnnouncement("Priority cleared.");
    onPriorityChange?.(null);
  }

  function moveFocus(next: number) {
    shouldFocusRef.current = true;
    setFocusIndex(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveFocus(Math.max(0, focusIndex - 1)); // clamp, never wrap
        return;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveFocus(Math.min(STARS.length - 1, focusIndex + 1));
        return;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        return;
      case "End":
        event.preventDefault();
        moveFocus(STARS.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(focusIndex + 1);
        return;
      // Handled on the group, never on the card: Delete while focus is on the card link must not
      // clear a priority.
      case "Delete":
      case "Backspace":
        event.preventDefault();
        clear();
        return;
      default:
    }
  }

  // The tabindex owner is the checked star when set, star 1 when unset — exactly one tab stop for
  // the whole group (APG roving tabindex).
  const tabIndexOwner = (priority ?? 1) - 1;

  return (
    // Full-bleed: the row sits outside CardContent's padding and spans the card's full width, so
    // five 44px coarse targets fit. Separation between stars comes from padding *inside* each
    // cell, never from `gap` — WCAG 2.5.5 permits abutting targets provided each is 44x44, and any
    // inter-star gap is width the column does not have.
    <div className="w-full" data-testid="kanban2-card-priority">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role */}
      <div
        role="radiogroup"
        aria-label={`Priority for ${street}`}
        aria-busy={pending || undefined}
        onKeyDown={onKeyDown}
        className="flex items-center [touch-action:manipulation]"
      >
        {STARS.map((star, index) => {
          const on = priority !== null && star <= priority;
          return (
            <span
              key={star}
              ref={(node) => { starRefs.current[index] = node; }}
              role="radio"
              aria-checked={priority === star}
              aria-label={starLabel(star)}
              aria-disabled={pending || undefined}
              // Roving tabindex: only one star is ever in the tab order.
              tabIndex={index === tabIndexOwner ? 0 : -1}
              onClick={() => commit(star)}
              // 44px is the *hit box*, not the star — the glyph stays ~18px. Matches the drag
              // handle's existing `size-9 / pointer-coarse:size-11` idiom in `kanban2/card.tsx`.
              className={`inline-grid place-items-center size-9 pointer-coarse:size-11 max-[641px]:size-11 cursor-pointer select-none text-[18px] leading-none focus-visible:!outline-2 focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px] ${on ? "text-star-on" : "text-star-off"}`}
            >
              <span aria-hidden="true">★</span>
            </span>
          );
        })}
      </div>
      {/* Owned by this control, not the Board: routing the same message through the Dashboard's
          `onAnnounce` as well would land it in two live regions and read it twice. */}
      <span aria-live="polite" className="sr-only" data-testid="kanban2-card-priority-status">{announcement}</span>
    </div>
  );
}
