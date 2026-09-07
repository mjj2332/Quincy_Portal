import * as React from "react";

import { cn } from "@/lib/utils";
import { FIELD_BOX } from "@/components/reui/input";

// Deliberately a real <select>, not ReUI/shadcn's `select` (a Base UI listbox-and-popup): that
// would drop the native mobile picker and change the keyboard model, which is a redesign this
// slice forbids. Logged to #57 for Stage C.
//
// `FIELD_BOX`'s `[&:read-only:not(select)]` guard is load-bearing for this consumer: a <select>
// matches `:read-only` unconditionally (only input/textarea/contenteditable are ever
// `:read-write`), so without the `:not(select)` every enabled Admin role-select would paint as
// if disabled.
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn(FIELD_BOX, "pe-[var(--space-2)]", className)} {...props} />;
}

export { NativeSelect };
