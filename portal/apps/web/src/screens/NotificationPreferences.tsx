import { useEffect, useState } from "react";
import { ApiError, apiGet, apiPatch } from "../lib/api";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Checkbox } from "@/components/reui/checkbox";
import { Notice } from "@/components/quincy/Notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/reui/select";
import { DEFAULT_EMAIL_DIGEST_CADENCE, type EmailDigestCadence } from "@quincy/shared";
import { cn } from "@/lib/utils";

type NotificationPreferencesValue = { projectDeadlineReminderEmails: boolean; subtaskReminderEmails: boolean; emailDigestCadence: EmailDigestCadence; includeProjectActivity: boolean };
type Section = "digest" | "activity" | "deadline" | "subtask";

// #489: the studio's own slots, in Sydney time every day of the week. The wording is the whole contract the
// person reads, so it names the hours rather than saying "twice a day".
const CADENCE_OPTIONS: ReadonlyArray<{ value: EmailDigestCadence; label: string }> = [
  { value: "immediate", label: "Immediately" },
  { value: "hourly", label: "Hourly" },
  { value: "twice_daily", label: "Twice daily (8:00 am and 2:00 pm)" },
  { value: "daily", label: "Daily (8:00 am)" },
];
const cadenceLabel = (value: string | null) => CADENCE_OPTIONS.find((option) => option.value === value)?.label ?? "";

// The page frame. `.page` is unlayered app.css (capped at `--container-page`, 1480px), so the
// narrower measure this single-column screen wants must be `!`-prefixed to beat it — same device as
// Admin.tsx:431.
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

// One row toggle's metrics. Inlined from the legacy ui/checkbox primitive, which this screen no
// longer imports — Admin.tsx and ProjectFields.tsx keep that shared export alive for their own
// rows. Three declarations with one consumer; re-exporting them from components/quincy/ would
// dress row metrics up as a component.
const TOGGLE_ROW =
  "flex items-center gap-[var(--space-2)] cursor-pointer " +
  "min-h-[38px] max-[721px]:min-h-[44px] text-foreground-secondary " + // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

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
  "text-foreground-secondary";

type EmailRowProps = { ariaLabel: string; checked: boolean; loading: boolean; unavailable: boolean; saving: boolean; disabled: boolean; onChange: (next: boolean) => void };

/** One in-app + email pair. In-app is always on, so only the email switch is a control. */
function EmailRows({ ariaLabel, checked, loading, unavailable, saving, disabled, onChange }: EmailRowProps) {
  const valueText = loading ? "Loading…" : unavailable ? "Unavailable" : saving ? "Saving…" : checked ? "On" : "Off";
  const valueTone = disabled ? "text-muted-foreground" : "text-foreground";
  return (
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
            aria-label={ariaLabel}
            // Base UI auto-detects the wrapping <label>, writes an id onto it, and emits
            // aria-labelledby pointing back at it. aria-labelledby BEATS aria-label, so
            // without this the control is announced "Email On" — precisely what the line
            // above exists to prevent, reintroduced by the component swap. Base UI reads
            // `explicitAriaLabelledBy ?? labelId`, and `??` (not `||`) means the empty string
            // suppresses the association instead of falling back to it.
            // Load-bearing — do not remove as redundant.
            aria-labelledby=""
            checked={unavailable ? false : checked}
            disabled={disabled}
            // `data-disabled`, not `:disabled` — Base UI's root is a <span>, which the
            // :disabled pseudo-class never matches. See the note in components/reui/checkbox.
            // LIVE, unlike the six Button call sites dropped in #71: nothing in the checkbox
            // chain sets `pointer-events-none` while disabled (reui/checkbox.tsx pairs
            // `data-disabled:cursor-not-allowed` with `data-disabled:opacity-50` and no
            // pointer-events rule), so the control still hit-tests and `!` beats the base's
            // cursor-not-allowed at equal specificity. Do not "clean this up" by analogy.
            className={saving ? "data-disabled:!cursor-wait" : undefined}
            onCheckedChange={onChange}
          />
          {valueText}
        </span>
      </label>
    </div>
  );
}

export function NotificationPreferences() {
  const [deadlineEnabled, setEnabled] = useState(true);
  const [subtaskEnabled, setSubtaskEnabled] = useState(true);
  const [cadence, setCadence] = useState<EmailDigestCadence>(DEFAULT_EMAIL_DIGEST_CADENCE);
  // #490: on until the person turns it off, so the control never flashes a wrong "Off" while loading.
  const [includeActivity, setIncludeActivity] = useState(true);
  const [loading, setLoading] = useState(true);
  // One flag per card: the two saves are independent, so one must not clear or disable the other.
  const [saving, setSaving] = useState<Record<Section, boolean>>({ digest: false, activity: false, deadline: false, subtask: false });
  const [error, setError] = useState<{ section: Section; message: string } | null>(null);
  // A failed load is page-level: it covers both cards, so it has its own slot rather than a card's.
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    apiGet<NotificationPreferencesValue>("/api/notification-preferences").then((value) => { if (active) setEnabled(value.projectDeadlineReminderEmails); if (active) setSubtaskEnabled(value.subtaskReminderEmails); if (active) setCadence(value.emailDigestCadence ?? DEFAULT_EMAIL_DIGEST_CADENCE); if (active) setIncludeActivity(value.includeProjectActivity ?? true); }).catch((reason) => { if (active) setLoadError(reason instanceof Error ? reason.message : "Preferences could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  // One switch per PATCH. The route upserts atomically and keeps the other stored value when a
  // field is absent (COALESCE), so concurrent PATCHes of different fields cannot clobber each other.
  async function change(section: "deadline" | "subtask", next: boolean) {
    const setValue = section === "deadline" ? setEnabled : setSubtaskEnabled;
    const previous = section === "deadline" ? deadlineEnabled : subtaskEnabled;
    setValue(next); setSaving((current) => ({ ...current, [section]: true })); setError((current) => (current?.section === section ? null : current));
    try {
      const value = await apiPatch<NotificationPreferencesValue, Partial<NotificationPreferencesValue>>("/api/notification-preferences", section === "deadline" ? { projectDeadlineReminderEmails: next } : { subtaskReminderEmails: next });
      setValue(section === "deadline" ? value.projectDeadlineReminderEmails : value.subtaskReminderEmails);
    }
    catch (reason) { setValue(previous); setError({ section, message: reason instanceof ApiError ? reason.message : "Preferences could not be saved." }); }
    finally { setSaving((current) => ({ ...current, [section]: false })); }
  }

  // Its own PATCH, like each switch: a cadence save never carries (or clobbers) the reminder switches.
  async function changeCadence(next: EmailDigestCadence) {
    const previous = cadence;
    if (next === previous) return;
    setCadence(next); setSaving((current) => ({ ...current, digest: true })); setError((current) => (current?.section === "digest" ? null : current));
    try {
      const value = await apiPatch<NotificationPreferencesValue, Partial<NotificationPreferencesValue>>("/api/notification-preferences", { emailDigestCadence: next });
      setCadence(value.emailDigestCadence);
    }
    catch (reason) { setCadence(previous); setError({ section: "digest", message: reason instanceof ApiError ? reason.message : "Preferences could not be saved." }); }
    finally { setSaving((current) => ({ ...current, digest: false })); }
  }

  // #490: its own PATCH, like the cadence and each reminder switch, so saving it never carries (or clobbers) another preference.
  async function changeActivity(next: boolean) {
    const previous = includeActivity;
    setIncludeActivity(next); setSaving((current) => ({ ...current, activity: true })); setError((current) => (current?.section === "activity" ? null : current));
    try {
      const value = await apiPatch<NotificationPreferencesValue, Partial<NotificationPreferencesValue>>("/api/notification-preferences", { includeProjectActivity: next });
      setIncludeActivity(value.includeProjectActivity);
    }
    catch (reason) { setIncludeActivity(previous); setError({ section: "activity", message: reason instanceof ApiError ? reason.message : "Preferences could not be saved." }); }
    finally { setSaving((current) => ({ ...current, activity: false })); }
  }

  const unavailable = loadError !== null;
  const anySaving = saving.digest || saving.activity || saving.deadline || saving.subtask;
  const activityDisabled = loading || unavailable || saving.activity;
  const activityValueText = loading ? "Loading…" : unavailable ? "Unavailable" : saving.activity ? "Saving…" : includeActivity ? "On" : "Off";

  return (
    <main className={PAGE}>
      <header className={HEAD}>
        <div>
          <Eyebrow className="block mb-[var(--space-3)]">Personal settings</Eyebrow>
          <h1 className={H1}>Notification preferences</h1>
          <p className={LEDE}>How notifications and reminders reach you.</p>
          <p className={cn(FOOT, "mt-[var(--space-2)]")}>In-app reminders always arrive in your notification bell.</p>
        </div>
      </header>

      {loadError && <Notice key="load" role="alert" className="mb-[var(--space-4)]">{loadError}</Notice>}

      <section className={CARD} aria-labelledby="email-digest">
        <h2 id="email-digest" className={CARD_TITLE}>Email digest</h2>
        <div className="mt-[var(--space-4)]">
          <div className={ROW}>
            <Eyebrow id="email-digest-frequency-label">Frequency</Eyebrow>
            <span className={cn(VALUE, "text-foreground")}>
              <Select
                value={cadence}
                disabled={loading || unavailable || saving.digest}
                onValueChange={(next) => { if (next) void changeCadence(next as EmailDigestCadence); }}
              >
                <SelectTrigger aria-labelledby="email-digest-frequency-label" aria-busy={saving.digest || undefined} className="min-h-[38px] min-w-[16rem] max-[721px]:min-h-[44px] max-[721px]:w-full rounded-[var(--radius-sm)] border-border bg-[var(--field-bg)]">
                  <SelectValue>{(value: string | null) => cadenceLabel(value ?? cadence)}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
                  {CADENCE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value} className="max-[721px]:min-h-[44px]">{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {saving.digest && <span className="text-foreground-secondary">Saving…</span>}
            </span>
          </div>

          <label className={CONTROL_ROW}>
            <Eyebrow>Project activity</Eyebrow>
            <span className={cn(VALUE, activityDisabled ? "text-muted-foreground" : "text-foreground")}>
              <Checkbox
                // Same two load-bearing attributes as EmailRows: the explicit name beats the wrapping <label>'s
                // computed one, and the empty aria-labelledby stops Base UI re-pointing the control at that label.
                aria-label="Include Project activity in email digest"
                aria-labelledby=""
                checked={unavailable ? false : includeActivity}
                disabled={activityDisabled}
                className={saving.activity ? "data-disabled:!cursor-wait" : undefined}
                onCheckedChange={(next) => void changeActivity(next)}
              />
              {activityValueText}
            </span>
          </label>
        </div>
        <p className={FOOT}>Comments, mentions, assignments and workflow updates are gathered into one email, grouped by Project, in Sydney time every day of the week. Anything you have already read in the app is left out, and nothing is sent when nothing is left. Checklist item and Project deadline reminders always arrive straight away.</p>
        <p className={cn(FOOT, "mt-[var(--space-2)]")}>Project activity (stage changes and collaboration activity) is only ever emailed in a digest; if you choose Immediately, it arrives hourly.</p>
        {(error?.section === "digest" || error?.section === "activity") && <Notice role="alert" className="mt-[var(--space-4)]">{error.message}</Notice>}
      </section>

      <section className={cn(CARD, "mt-[var(--space-4)]")} aria-labelledby="deadline-reminders">
        <h2 id="deadline-reminders" className={CARD_TITLE}>Project deadlines</h2>
        <EmailRows ariaLabel="Project deadline reminder emails" checked={deadlineEnabled} loading={loading} unavailable={unavailable} saving={saving.deadline} disabled={loading || unavailable || saving.deadline} onChange={(next) => void change("deadline", next)} />
        <p className={FOOT}>Sent before and when a Project's deadline is due.</p>
        {error?.section === "deadline" && <Notice role="alert" className="mt-[var(--space-4)]">{error.message}</Notice>}
      </section>

      <section className={cn(CARD, "mt-[var(--space-4)]")} aria-labelledby="subtask-reminders">
        <h2 id="subtask-reminders" className={CARD_TITLE}>Checklist item reminders</h2>
        <EmailRows ariaLabel="Checklist item reminder emails" checked={subtaskEnabled} loading={loading} unavailable={unavailable} saving={saving.subtask} disabled={loading || unavailable || saving.subtask} onChange={(next) => void change("subtask", next)} />
        <p className={FOOT}>Sent for checklist items assigned to you, before and when they're due.</p>
        {error?.section === "subtask" && <Notice role="alert" className="mt-[var(--space-4)]">{error.message}</Notice>}
      </section>

      <div aria-live="polite" className="sr-only">{anySaving ? "Saving notification preferences" : ""}</div>
    </main>
  );
}
