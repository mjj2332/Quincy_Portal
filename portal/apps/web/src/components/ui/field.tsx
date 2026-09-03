import * as React from "react";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="field"
      className={cn("flex w-full flex-col gap-[6px]", className)}
      {...props}
    />
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("w-full", className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-secondary)]",
        className,
      )}
      {...props}
    />
  );
}

function FieldError({ className, children, ...props }: React.ComponentProps<"div">) {
  if (!children) return null;

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn(
        "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-[var(--signal-critical)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { Field, FieldGroup, FieldLabel, FieldError };
