import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      className={cn(
        "quincy-input w-full min-h-[38px] border border-solid border-[var(--border-hairline)] rounded-[var(--radius-sm)] bg-[var(--paper-050)] px-[10px] py-[8px] [font:var(--weight-regular)_14px/var(--leading-normal)_var(--font-sans)] text-[var(--text-primary)]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
