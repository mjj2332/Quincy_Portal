import type { CSSProperties, ReactNode } from "react";
import type { StagePresentationKey } from "@quincy/shared";
import { Toggle } from "@/components/reui/toggle";
import type { StageTone } from "../../lib/dashboard-appearance";
import { cn } from "../../lib/utils";

/**
 * #916 / #918: the Dashboard's Stage key, frame 3a's key row (`design/prototypes/dashboard-views`,
 * "Dashboard views v3", `.keyrow` / `.kchip`). One chip per Stage, each a swatch drawn from the
 * appearance module's `StageTone` and the Stage name. The key doubles as a Stage filter: a chip is a
 * ReUI `Toggle` (`variant="chip"`, a scoped adaptation, see `reui/toggle.tsx`) whose pressed state is
 * "the Filter shows this Stage", and pressing it hands the Stage to `onToggle`, which the view turns
 * into a Filter write (`toggleStageInDashboardFilter`). A chip the Filter cannot toggle (an OR, negated,
 * nested or repeated Stage rule) is disabled and titled "Edit Stage in Filter". No counts (owner
 * decision D5: the query is server-filtered, so an unselected Stage's count is unknowable).
 *
 * The row lays out its chips only. The band it sits in (frame 3a's padding, canvas fill and hairlines;
 * the phone Key drawer; the Calendar header) belongs to the host, which is why there is no padding,
 * background or border here. `trailing` sits at the row's end (the Timeline's Colour by switch).
 */
export type StageKeyEntry<K extends string = StagePresentationKey> = {
  key: K;
  label: string;
  tone: StageTone;
  /** The Filter shows this Stage. */
  pressed: boolean;
  /** The Filter's Stage rule is too complex for a chip to rewrite. */
  disabled: boolean;
};

export const STAGE_KEY_DISABLED_TITLE = "Edit Stage in Filter";

/**
 * A Stage swatch drawn from its tone: frame 3a's `.sw`, a 14px square. `hollow-dashed` is the surface
 * paper inside a dashed edge in the tone (Awaiting RAW), `wash` a quiet tint inside a solid edge
 * (Delivered), `solid` the tone itself. Decorative: the label beside it carries the meaning.
 */
export function StageToneSwatch({ tone, className }: { tone: StageTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="stage-key-swatch"
      data-treatment={tone.treatment}
      className={cn(
        "size-3.5 shrink-0 rounded-xs",
        tone.treatment === "solid" && "bg-(--swatch-color)",
        tone.treatment === "hollow-dashed" && "border-[length:var(--border-width-mid)] border-dashed border-(--swatch-color) bg-card",
        tone.treatment === "wash" && "border-[length:var(--border-width-mid)] border-(--swatch-color) bg-[color-mix(in_srgb,var(--swatch-color)_var(--stage-wash-mix),var(--bg-surface))]",
        className,
      )}
      style={{ "--swatch-color": tone.color } as CSSProperties}
    />
  );
}

export function StageKeyRow<K extends string = StagePresentationKey>({
  entries,
  onToggle,
  trailing,
  "aria-label": ariaLabel = "Stage key",
}: {
  entries: readonly StageKeyEntry<K>[];
  onToggle: (key: K) => void;
  trailing?: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} data-testid="stage-key-row" className="flex flex-wrap items-center gap-2">
      {entries.map((entry) => {
        const chip = (
          <Toggle
            key={entry.key}
            variant="chip"
            size="chip"
            pressed={entry.pressed}
            disabled={entry.disabled}
            title={entry.disabled ? STAGE_KEY_DISABLED_TITLE : undefined}
            data-stage-key={entry.key}
            onPressedChange={() => onToggle(entry.key)}
          >
            <StageToneSwatch tone={entry.tone} />
            {entry.label}
          </Toggle>
        );
        // A disabled button takes no pointer events, so its own title never shows on hover; the
        // wrapper carries it for the pointer, the button for assistive tech.
        return entry.disabled ? (
          <span key={entry.key} title={STAGE_KEY_DISABLED_TITLE} className="inline-flex">
            {chip}
          </span>
        ) : (
          chip
        );
      })}
      {trailing !== undefined && <div className="ms-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
