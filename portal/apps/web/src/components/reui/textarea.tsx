import * as React from "react"
import { cn } from "@/lib/utils"
import { FIELD_BOX } from "@/components/reui/input"

// Correction: nova duplicated its own copy of the field-box geometry instead of sharing input's.
// Reused FIELD_BOX here (as `ui/textarea.tsx` shares `ui/input.tsx`'s FIELD_BOX) so the two never
// drift, and layered Quincy's textarea-specific additions on top, ported from `ui/textarea.tsx`:
// `min-h-[96px] resize-y leading-[var(--leading-normal)]`.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(FIELD_BOX, "min-h-[96px] resize-y leading-[var(--leading-normal)]", className)}
      {...props}
    />
  )
}

export { Textarea }
