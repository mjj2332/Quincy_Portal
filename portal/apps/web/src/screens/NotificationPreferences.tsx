import { useEffect, useState } from "react";
import { ApiError, apiGet, apiPatch } from "../lib/api";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Checkbox, TOGGLE_ROW } from "@/components/ui/checkbox";
import { Notice } from "@/components/quincy/Notice";
import { cn } from "@/lib/utils";

type NotificationPreferencesValue = { projectDeadlineReminderEmails: boolean };

// The page frame. `.page` is unlayered app.css (max-width 1480px), so the narrower measure this
// single-column screen wants must be `!`-prefixed to beat it — same device as Admin.tsx:431.
const PAGE = "page !max-w-[var(--container-md)]";

// The page head, matched to the app's shipped pattern (Admin.tsx:432-437).
const HEAD = "flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]";
const H1 = "[font:var(--type-h1)] tracking-[var(--tracking-tight)] m-0";
const LEDE = "mt-[var(--space-3)] mb-0 max-w-[46ch] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground-secondary";

// The card. Square, hairline-bordered, no elevation — the brand's own card.
const CARD = "bg-card [border-style:solid] border-[length:var(--border-width-hair)] border-border " +
  "p-[var(--space-5)] max-[721px]:p-[var(--space-4)]";
const CARD_TITLE = "m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground";

// One ledger row: eyebrow left, value right. Below 721px the two columns stack, because a 140px
// label column plus a value does not fit a 390px viewport without the value wrapping mid-word.
// `max-[721px]` and `min-[721px]` are exactly complementary — see lessons.md trap 2.
const ROW = "grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-center gap-[var(--space-4)] " +
  "max-[721px]:grid-cols-1 max-[721px]:gap-[var(--space-1)] " +
  "py-[var(--space-4)] " +
  "[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border " +
  "first:border-t-0 first:pt-[var(--space-4)]";

// The email row is the same grid, wearing TOGGLE_ROW's metrics and cursor. TOGGLE_ROW leads with
// `flex`; `grid` appears later in the merged string and `cn` is twMerge-backed, so `grid` wins
// deterministically (§2.1) — this is not source-order luck.
const CONTROL_ROW = cn(TOGGLE_ROW, ROW, "text-foreground");

// The value slot. Same type and alignment in both rows, so the ledger reads as a table of states
// (§4.2) rather than a form with a missing input.
const VALUE = "flex items-center gap-[var(--space-2)] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

// The footnote under the ledger.
const FOOT = "mt-[var(--space-4)] mb-0 " +
  "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] " +
  "text-muted-foreground";

export function NotificationPreferences() {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    apiGet<NotificationPreferencesValue>("/api/notification-preferences").then((value) => { if (active) setEnabled(value.projectDeadlineReminderEmails); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Preferences could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function change(next: boolean) {
    const previous = enabled; setEnabled(next); setSaving(true); setError(null);
    try { const value = await apiPatch<NotificationPreferencesValue, NotificationPreferencesValue>("/api/notification-preferences", { projectDeadlineReminderEmails: next }); setEnabled(value.projectDeadlineReminderEmails); }
    catch (reason) { setEnabled(previous); setError(reason instanceof ApiError ? reason.message : "Preferences could not be saved."); }
    finally { setSaving(false); }
  }

  const busy = loading || saving;
  const valueText = loading ? "Loading…" : saving ? "Saving…" : enabled ? "On" : "Off";
  const valueTone = busy ? "text-muted-foreground" : "text-foreground";

  return (
    <main className={PAGE}>
      <header className={HEAD}>
        <div>
          <Eyebrow className="block mb-[var(--space-3)]">Personal settings</Eyebrow>
          <h1 className={H1}>Notification preferences</h1>
          <p className={LEDE}>How deadline reminders reach you.</p>
        </div>
      </header>

      <section className={CARD} aria-labelledby="deadline-reminders">
        <h2 id="deadline-reminders" className={CARD_TITLE}>Project deadlines</h2>

        <div className="mt-[var(--space-4)]">
          <div className={ROW}>
            <Eyebrow>In-app</Eyebrow>
            <span className={cn(VALUE, "text-foreground-secondary")}>Always on</span>
          </div>

          <label className={CONTROL_ROW}>
            <Eyebrow>Email</Eyebrow>
            <span className={cn(VALUE, valueTone)}>
              <Checkbox
                // `aria-label` deliberately overrides the wrapping <label>'s computed name. The
                // label exists to make the whole row clickable; without this the control would be
                // announced as "Email On", which names the column rather than the preference.
                // Load-bearing — do not remove as redundant.
                aria-label="Project deadline reminder emails"
                checked={enabled}
                disabled={busy}
                className={saving ? "disabled:!cursor-wait" : undefined}
                onChange={(event) => void change(event.target.checked)}
              />
              {valueText}
            </span>
          </label>
        </div>

        <p className={FOOT}>In-app reminders always arrive in your notification bell.</p>

        {error && <Notice role="alert" className="mt-[var(--space-4)]">{error}</Notice>}
      </section>

      <div aria-live="polite" className="sr-only">{saving ? "Saving notification preferences" : ""}</div>
    </main>
  );
}
