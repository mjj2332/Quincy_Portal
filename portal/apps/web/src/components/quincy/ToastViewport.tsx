import { useEffect, useSyncExternalStore } from "react";
import { cn } from "../../lib/utils";
import { buttonClasses } from "./Button";
import { dismissToast, getToasts, pauseToast, registerToastViewport, resumeToast, subscribeToasts, type Toast } from "../../lib/toast-store";

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

/** #221: a second click in the same tick finds the toast already gone and does nothing. */
function activateToastAction(item: Toast): void {
  if (!item.action || !getToasts().some((candidate) => candidate.id === item.id)) return;
  item.action.onAction();
  dismissToast(item.id);
}

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
          // #221: hover or focus anywhere inside the toast holds its expiry; leaving resumes it.
          // Blur resumes only when focus moves OUTSIDE this toast, not between its own children.
          onMouseEnter={() => pauseToast(item.id)}
          onMouseLeave={() => resumeToast(item.id)}
          onFocus={() => pauseToast(item.id)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeToast(item.id);
          }}
          className={cn(
            "flex items-center gap-[var(--space-3)] bg-surface-inverse text-on-inverse px-[var(--space-5)] py-[var(--space-3)] rounded-[var(--radius-sm)] shadow-[var(--shadow-md)] text-[length:var(--text-sm)] leading-[var(--leading-normal)] motion-safe:animate-[slidein_var(--dur-base)_var(--ease-entrance)] pointer-events-auto max-w-[min(380px,100%)]",
            item.tone === "error" && "bg-destructive",
          )}
        >
          {/* #221 caution glyph: an aria-hidden graphical mark, so it takes the brand
              `--signal-caution` (colors.css: icons keep the brand value at the 3:1 non-text bar),
              which measures 4.20:1 on `--ink-900` (`bg-surface-inverse`). `--signal-caution-text`
              is the TEXT role and measures only 2.98:1 on ink — below even the icon bar. Written
              as an arbitrary `color` property rather than the `text-signal-caution` utility,
              because that utility is the text-role misuse Guard 5 (design-system-guards) polices. */}
          <span aria-hidden="true" className={cn("shrink-0 inline-grid place-items-center size-[var(--space-4)] [font:var(--weight-regular)_var(--text-xs)/1.4_var(--font-mono)]", item.tone === "caution" && "[color:var(--signal-caution)]")}>{item.tone === "success" ? "✓" : "!"}</span>
          <span aria-hidden={item.announcedElsewhere && item.action ? "true" : undefined}>{item.message}</span>
          {/* `text` (ghost) is the one existing variant legible here: it sets no rest-state
              background or text colour of its own, so it inherits this wrapper's `text-on-inverse`
              — readable on both `bg-surface-inverse` (the default tone) and `bg-destructive` (the
              error tone, still carrying `text-on-inverse`). `primary`'s bg-on-bg merges into the
              inverse backdrop, `secondary`'s bg-background is a near-white pill with no explicit
              rest-state text colour (also inherited, so equally near-invisible on itself), and
              `danger` pairs a dark destructive text colour with a near-transparent destructive
              wash — illegible on both tones. `underline` restores the affordance `buttonClasses`'s
              `no-underline` strips, and `min-h-[44px]` overrides `text`'s 32px box (only kicks in
              at `max-[721px]` on `text` otherwise) to keep the hit target at every width.

              `focus-visible:!outline-on-inverse` is the same fix `ImpersonationBanner.tsx`'s `EXIT`
              carries, applied here for the same reason: the toast sits on ink (or, in the error
              tone, on `bg-destructive`), and `styles/tokens/base.css:25`'s unlayered global
              `:focus-visible { outline: … var(--focus-ring); }` (imported outside any layer at
              `index.css:8`) beats an ordinary layered `outline-*` utility regardless of
              specificity — so without the `!`, the ring stays `--focus-ring` (ink), unreadable on
              an ink toast (~1.00:1) and barely better on the destructive one (~1.98:1). */}
          {item.action && <button type="button" data-testid="toast-action" className={buttonClasses("text", { className: "underline underline-offset-2 shrink-0 min-h-[44px] px-[var(--space-2)] focus-visible:!outline-on-inverse" })} onClick={() => activateToastAction(item)}>{item.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
