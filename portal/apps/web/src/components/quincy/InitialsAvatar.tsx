import { Avatar, AvatarFallback } from "@/components/reui/avatar";
import { initials } from "@/lib/initials";
import { cn } from "@/lib/utils";

// Ink on paper, 12px, the pair the rail's identity block settled on in #122 — one place for it
// so the notification row (#116) and the rail cannot drift apart.
const FALLBACK =
  "bg-[var(--ink-900)] text-[color:var(--paper-050)] " +
  "text-[length:12px] leading-[1.2] font-[family-name:var(--font-sans)] font-[var(--weight-regular)] tracking-[0.02em]";

/**
 * A person's initials on base-nova's `Avatar` (`reui/avatar.tsx`), Quincy-toned. Decorative: the
 * name is always spoken by the text beside it, so the avatar is `aria-hidden` and carries no
 * accessible name of its own. `className` reaches the `Avatar` root (its default is `size-8`).
 */
export function InitialsAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar aria-hidden="true" className={className}>
      <AvatarFallback className={cn(FALLBACK)}>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}
