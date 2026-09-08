import * as React from "react";
import { cn } from "@/lib/utils";

// Hand-rolled rather than composed over `reui/checkbox`: `reui/checkbox.tsx` is Base UI's
// `<span role="checkbox">` with a hidden input tucked inside, not a real `<input
// type="checkbox">` at the root. `SubtaskChecklist` drives a real input directly —
// `SubtaskChecklist.dom.test.tsx:172` clicks `row.querySelector<HTMLInputElement>('input[type=
// "checkbox"]')`, `SubtaskChecklist.dom.test.tsx:232` asserts that same queried `input` carries
// no `aria-roledescription`, and `SubtaskChecklist.tsx:246` reads `event.target.checked` off the
// change handler. A `<span role="checkbox">` root would put `.checked`/`aria-label` in the wrong
// place for all three, the same failure mode already recorded three times in #53
// (`Admin.tsx:71-78`, `ProjectFields.tsx:40-46`, `NotificationPreferences.tsx:35-38`, all inlining
// the legacy `ui/checkbox` primitive rather than swapping to Base UI's). Already tracked on #57.
//
// Ported verbatim from `components/ui/checkbox.tsx`. Does NOT re-export `CHECK_TILE` or
// `TOGGLE_ROW`: no #54 consumer imports either, and `NotificationPreferences.tsx:35-38` argues
// explicitly against componentising row metrics — consolidating the three existing inline copies
// is a #57 entry, not this slice.
const CHECKBOX_INPUT =
  "size-[18px] shrink-0 m-0 accent-[var(--accent)] cursor-pointer " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed";

function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return <input type="checkbox" data-slot="checkbox" className={cn(CHECKBOX_INPUT, className)} {...props} />;
}

export { Checkbox, CHECKBOX_INPUT };
