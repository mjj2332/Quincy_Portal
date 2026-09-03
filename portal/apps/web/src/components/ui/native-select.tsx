import * as React from "react";
import { cn } from "@/lib/utils";
import { FIELD_BOX } from "@/components/ui/input";

function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn(FIELD_BOX, "pe-[var(--space-2)]", className)} {...props} />;
}

export { NativeSelect };
