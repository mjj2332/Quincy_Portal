import { CircleCheck } from "lucide-react";
import { cn } from "../../lib/utils";
import { IconTip } from "./VideoPlayer";

/** The filled green tick: a success-token disc with the check cut out in the page colour. Shared by the staff toggle and the status-only views. */
export const RESOLVED_TICK = "fill-success text-background [&>circle]:stroke-success";

/** A resolved note, as status only (read-only staff viewers and guests): a green tick with an sr-only "Resolved", in the note's bottom-right. */
export function ResolvedTick({ "data-testid": testId }: { "data-testid": string }) {
  return <div className="flex justify-end">
    <IconTip label="Resolved"><span tabIndex={0} data-testid={testId} className="inline-flex rounded-[var(--radius-xs)]"><CircleCheck aria-hidden="true" className={cn("size-5", RESOLVED_TICK)} /><span className="sr-only">Resolved</span></span></IconTip>
  </div>;
}
