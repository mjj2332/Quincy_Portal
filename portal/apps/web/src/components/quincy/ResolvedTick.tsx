import { CircleCheck } from "lucide-react";
import { cn } from "../../lib/utils";

/** The filled green tick: a success-token disc with the check cut out in the card colour. Shared by the staff toggle and the status-only views. */
export const RESOLVED_TICK = "fill-success text-card [&>circle]:stroke-success";

/**
 * A resolved note, as status only (read-only staff viewers and guests): a green tick with an sr-only "Resolved". 32px square so its glyph centre matches the staff toggle. The caller places it
 * (`ms-auto` in the Reply row, or alone in a right-aligned row). Not focusable: the sr-only text carries the meaning, so there is no extra tab stop.
 */
export function ResolvedTick({ "data-testid": testId, className }: { "data-testid": string; className?: string }) {
  return <span data-testid={testId} className={cn("inline-flex size-8 items-center justify-center", className)}><CircleCheck aria-hidden="true" className={cn("size-5", RESOLVED_TICK)} /><span className="sr-only">Resolved</span></span>;
}
