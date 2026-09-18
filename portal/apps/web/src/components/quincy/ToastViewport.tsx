import { useEffect, useSyncExternalStore } from "react";
import { cn } from "../../lib/utils";
import { dismissToast, getToasts, registerToastViewport, subscribeToasts } from "../../lib/toast-store";

/**
 * The single toast surface — issue #110. Rendered in-tree, with no portal, by exactly the three
 * screens that need one (`Dashboard.tsx`, `Admin.tsx`, `ProjectWorkspace.tsx` — pinned by the
 * "single-viewport source assertion" in `ToastViewport.dom.test.tsx`). `ShellRoute` renders none:
 * if it did, production would mount two and every toast would render and announce twice.
 *
 * No provider either — this reads the module-level `toast-store` with `useSyncExternalStore`, so a
 * screen rendered standalone with `createRoot` (no provider of any kind) behaves identically to a
 * shell-mounted one.
 */
export function ToastViewport({ testId = "toast-viewport", toastTestId = "toast" }: { testId?: string; toastTestId?: string }) {
  useEffect(() => registerToastViewport(), []);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <div
      aria-live="polite"
      data-testid={testId}
      className="fixed z-[var(--z-toast)] flex flex-col items-end gap-[var(--space-3)] pointer-events-none right-[max(var(--space-5),env(safe-area-inset-right))] bottom-[max(var(--space-5),env(safe-area-inset-bottom))] left-[var(--toast-inset-inline-start)]"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          // Hidden from the accessibility tree, not from the screen: the event was already
          // announced in the screen's own live region, and an aria-hidden node mutating inside a
          // live region produces no announcement. #99. Two branches, per #216 fix round 1 item 1:
          // an announcedElsewhere toast with no action hides the whole wrapper, as before — but a
          // focusable control (the action button) must never sit inside an aria-hidden subtree
          // (focusable + aria-hidden is itself invalid), so when there's an action the wrapper
          // stays in the tree and only the message span is hidden instead (glyph span stays
          // hidden either way) — the live region then announces just the action's label, which is
          // exactly what's wanted: the toast's own message was already announced elsewhere, but an
          // available action wasn't.
          aria-hidden={item.announcedElsewhere && !item.action ? "true" : undefined}
          data-testid={toastTestId}
          data-tone={item.tone}
          className={cn(
            "flex items-center gap-[var(--space-3)] bg-surface-inverse text-on-inverse px-[var(--space-5)] py-[var(--space-3)] rounded-[var(--radius-sm)] shadow-[var(--shadow-md)] text-[length:var(--text-sm)] leading-[var(--leading-normal)] motion-safe:animate-[slidein_var(--dur-base)_var(--ease-entrance)] pointer-events-auto max-w-[min(380px,100%)]",
            item.tone === "error" && "bg-destructive",
          )}
        >
          <span aria-hidden="true" className="shrink-0 inline-grid place-items-center size-[var(--space-4)] [font:var(--weight-regular)_var(--text-xs)/1.4_var(--font-mono)]">{item.tone === "error" ? "!" : "✓"}</span>
          <span aria-hidden={item.announcedElsewhere && item.action ? "true" : undefined}>{item.message}</span>
          {item.action && <button type="button" data-testid="toast-action" className="underline underline-offset-2 shrink-0 min-h-[44px] px-[var(--space-2)]" onClick={() => { item.action!.onAction(); dismissToast(item.id); }}>{item.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
