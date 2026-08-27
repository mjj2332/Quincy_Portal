import { useEffect, useState } from "react";
import { ApiError, apiGet, apiPatch } from "../lib/api";

type NotificationPreferencesValue = { projectDeadlineReminderEmails: boolean };

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
  return <main className="page preferences-page"><div className="page__head"><div><div className="ey">Personal settings</div><h1 className="serif">Notification preferences</h1><p className="lede">Choose how deadline reminders reach you.</p></div></div><section className="preferences-card" aria-labelledby="deadline-email-label"><div><h2 id="deadline-email-label">Project deadline reminder emails</h2><p>In-app Deadline reminders are always delivered.</p></div><label className="admin-toggle"><span className="sr-only">Project deadline reminder emails</span><input type="checkbox" checked={enabled} onChange={(event) => void change(event.target.checked)} disabled={loading || saving} /> <span>{loading ? "Loading…" : enabled ? "On" : "Off"}</span></label></section>{error && <div className="notice" role="alert">{error}</div>}<div aria-live="polite" className="sr-only">{saving ? "Saving notification preferences" : ""}</div></main>;
}
