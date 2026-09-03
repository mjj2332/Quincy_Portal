import * as React from "react";
import { cn } from "@/lib/utils";
import { FIELD_BOX } from "@/components/ui/input";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(FIELD_BOX, "min-h-[96px] resize-y leading-[var(--leading-normal)]", className)}
      {...props}
    />
  );
}

export { Textarea };
