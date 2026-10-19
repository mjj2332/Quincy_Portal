import type { StageKey } from "@quincy/shared";
import type { ProjectStageKey } from "../../lib/stages";
import { PHONE_VIEWPORT_QUERY } from "../../lib/use-media-query";

/**
 * The Board's column geometry and Stage-key spellings, shared by the Board (`board.tsx`) and its loading
 * skeleton (`board-skeleton.tsx`), so the skeleton lands in the shape the Board draws (#923, frame 4h).
 */

/** `editing` is the role-safe presentation of `editing_autohdr`. */
export function semanticStageKey(value: ProjectStageKey): StageKey {
  return value === "editing" ? "editing_autohdr" : value;
}

/**
 * The phone Board (frame 4f), exactly what `max-[721px]:` compiles to (width < 721, so 720 is phone and 721 is
 * not), so the Board's script and its classes never disagree at the edge. Not `(max-width: 721px)`, which also
 * matches 721.
 */
export const BOARD_PHONE_QUERY = PHONE_VIEWPORT_QUERY;

/**
 * Frame 4e column sizes (#923). A working column is fluid (`flex-1`) over the 280px floor, so four of them fill
 * a 1440 screen beside the resting Delivered rail; `[contain:inline-size]` keeps a long street from widening a
 * column (its intrinsic width is the floor), so the `w-max min-w-full` row is exactly the screen until the
 * floors overflow it, and then it scrolls. 280px still clears #81's touch constraint: five 44px star targets
 * need 220px. On a phone a column is the viewport's width (`100cqw` of the `@container` viewport) and snaps.
 * None of this changes during a drag, so `MeasuringStrategy.Always` re-measures nothing that moved.
 */
export const COLUMN_SIZE_CLASS = "flex-1 min-w-[17.5rem] [contain:inline-size] snap-start max-[721px]:w-[100cqw] max-[721px]:flex-none";
/** The collapsed rail: 48px, and never drawn on a phone (the Board shows a phone every column in full). */
export const RAIL_SIZE_CLASS = "w-12 shrink-0 snap-start";
export const COLUMN_SURFACE_CLASS = "bg-[var(--paper-050)] min-h-0 border border-[length:var(--border-width-hair)] border-border opacity-100";
