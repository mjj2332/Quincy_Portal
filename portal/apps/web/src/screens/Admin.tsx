import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { isProjectAssignmentEligible, ROLES, type Role } from "@quincy/shared";
import { ApiError, apiGet, apiPatch, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { useStages } from "../lib/stages";
import { invalidateActiveProjectDetails, useOptionalProjectQueryClient } from "../lib/project-data";
import { confirm } from "../lib/confirm";
import { impersonateUser } from "../lib/auth";
import { locationStore } from "../lib/router";
import { pushToast as toast } from "../lib/toast-store";
import { ToastViewport } from "../components/quincy/ToastViewport";
import { Modal } from "../components/Modal";
import { Button } from "@/components/reui/button";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Input } from "@/components/reui/input";
import { NativeSelect } from "@/components/quincy/NativeSelect";
import { StatusPill, type StatusTone } from "@/components/quincy/StatusPill";
import { TabStrip } from "@/components/quincy/TabStrip";
import { TableWrap, Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/quincy/Table";
import { SectionHead } from "@/components/quincy/SectionHead";
import { Notice } from "@/components/quincy/Notice";
import { EmptyState } from "@/components/quincy/EmptyState";
import { QuincyField } from "@/components/quincy/QuincyField";
import { QuincySelectField } from "@/components/quincy/QuincySelectField";

type AdminTab = "users" | "directory" | "pipeline" | "integrations";
type User = { id: string; name: string; email: string; role: Role; active: boolean; defaultEditor: boolean; createdAt: string | null };
type IntegrationStatus = "connected" | "disconnected" | "expired" | "error";
type Integration = { provider: string; status: IntegrationStatus; expiresAt: string | null; lastEventAt: string | null; lastError: string | null };
type UsersResponse = { users: User[] };
type ImpersonationSettingsResponse = { enabled: boolean };
/** Set by the background purge worker, released only here (#161). */
type ProvisioningFreezeResponse = { frozen: boolean; frozenAt: number | null; updatedBy: string | null };
type IntegrationsResponse = { integrations: Integration[] };
type Agency = { id: string; name: string; notes: string | null; agentCount: number; createdAt: string | null };
type Agent = { id: string; agencyId: string | null; agencyName?: string | null; name: string; email: string | null; phone: string | null; createdAt: string | null };
type Stage = { key: string; label: string; displayOrder: number; active: boolean };
type Event = { id: string; eventId: string; status: "received" | "processed" | "poison"; error: string | null; receivedAt: string | null; processedAt: string | null; summary: { street: string; orderId: string } | null };
type EventsResponse = { events: Event[]; total: number };
type TonomoHealth = { tonomo: { lastEventAt: string | null; counts: { received: number; processed: number; poison: number }; poisonCount: number } };
type EventDetail = { event: Event & { payloadJson: string } };
type RenditionDlqEvent = { id: string; assetId: string; status: "open" | "replayed" | "discarded"; receivedAt: string | null; resolvedAt: string | null; projectId: string | null; street: string | null };
type RenditionDlqResponse = { events: RenditionDlqEvent[]; openCount: number };
type NotificationDeliveryView = "pending_stuck" | "dlq" | "failed" | "unknown" | "preference_suppressed";
type NotificationDeliveryItem = {
  outboxId: string;
  eventType: string;
  projectId: string | null;
  projectStreet: string | null;
  recipientName: string | null;
  channels: Array<{ channel: string; status: string }>;
  status: string;
  attempts: number;
  safeErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  unknownEmailPossible: boolean;
};
type NotificationDeliveryResponse = { view: NotificationDeliveryView; items: NotificationDeliveryItem[]; nextCursor: string | null; counts: Record<NotificationDeliveryView, number> };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDERS = ["dropbox", "tonomo", "vimeo"] as const;
const TAB_LABELS: Record<AdminTab, string> = { users: "Users", directory: "Directory", pipeline: "Pipeline", integrations: "Integrations" };
const DELIVERY_VIEWS: NotificationDeliveryView[] = ["pending_stuck", "dlq", "failed", "unknown", "preference_suppressed"];
const DELIVERY_LABELS: Record<NotificationDeliveryView, string> = {
  pending_stuck: "Pending / stuck",
  dlq: "DLQ",
  failed: "FAILED",
  unknown: "UNKNOWN",
  preference_suppressed: "Preference suppressed",
};
// Inlined from the legacy `ui/checkbox` primitive, which this screen no longer imports. Both the
// impersonation switch and the per-stage active toggle stay native `<input type="checkbox">`s,
// not ReUI's Base UI `Checkbox`: `Admin.dom.test.tsx:206,261` read `.checked` off
// `[aria-label="Enable user impersonation (testing)"]`, but Base UI puts `aria-label` on the
// `<span role="checkbox">` root, whose `.checked` is `undefined`. Applied uniformly to both
// checkboxes in this screen even though the stage toggle alone would have survived a swap — one
// native checkbox and one Base UI checkbox in the same screen is worse than either. Same device as
// `screens/NotificationPreferences.tsx`'s `TOGGLE_ROW` and `components/ProjectFields.tsx`'s
// `CHECK_TILE`/`CHECKBOX_INPUT`.
const TOGGLE_ROW =
  "flex items-center gap-[var(--space-2)] cursor-pointer " +
  "min-h-[38px] max-[721px]:min-h-[44px] text-foreground-secondary " + // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

const CHECKBOX_INPUT =
  "size-[18px] shrink-0 m-0 accent-[var(--accent)] cursor-pointer " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed";

// Quincy's `text` button variant was a compact, padding-free label (`min-h-[32px] px-0 py-[6px]`);
// nova's nearest analogue, `ghost`, is a fully padded 38px button. In this screen's dense table
// action cells that reads wrong, so the Quincy metrics are restored on top of `variant="ghost"`.
// The `max-[721px]:min-h-[44px]` touch target in the cva base is a different modifier and survives
// the merge, exactly as it did under `ui/button.tsx`'s own `text` variant.
const TEXT_BUTTON = "min-h-[32px] px-0 py-[6px]";

const TONE_FOR_STATUS: Record<IntegrationStatus | "not-configured", StatusTone> = {
  connected: "positive",
  disconnected: "neutral",
  expired: "caution",
  error: "critical",
  "not-configured": "neutral",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function relativeTime(value: string | null): string {
  if (!value) return "No events recorded";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "No events recorded";
  const seconds = Math.round((date.valueOf() - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, amount] of units) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return formatter.format(seconds, "second");
}

function statusLabel(status: IntegrationStatus | "not-configured"): string {
  return status === "not-configured" ? "Not configured" : status.charAt(0).toUpperCase() + status.slice(1);
}

function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function eventTypeLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "project.comment.mentioned": "Comment mention",
    "project.assignment.created": "Project assignment",
    "project.deadline.reminder": "Deadline reminder",
    "project.activity.broad": "Project activity",
  };
  return labels[eventType] ?? "Unknown event";
}

export function Admin({ currentUserId }: { currentUserId?: string | null }) {
  const queryClient = useOptionalProjectQueryClient();
  const { can } = useCapabilities();
  const { refreshStages } = useStages();
  const canManageUsers = can("manageUsers");
  const canManageIntegrations = can("manageIntegrations");
  const canAdminBackend = can("adminBackend");
  const availableTabs: AdminTab[] = [
    ...(canManageUsers ? ["users" as const] : []),
    ...(canAdminBackend ? ["directory" as const, "pipeline" as const] : []),
    ...(canManageIntegrations ? ["integrations" as const] : []),
  ];
  const [activeTab, setActiveTab] = useState<AdminTab>(availableTabs[0] ?? "users");
  const [users, setUsers] = useState<User[]>([]);
  const [impersonationEnabled, setImpersonationEnabled] = useState(false);
  const [isUpdatingImpersonation, setIsUpdatingImpersonation] = useState(false);
  const [provisioningFreeze, setProvisioningFreeze] = useState<ProvisioningFreezeResponse>();
  const [isReleasingFreeze, setIsReleasingFreeze] = useState(false);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [tonomoHealth, setTonomoHealth] = useState<TonomoHealth["tonomo"]>();
  const [poisonEvents, setPoisonEvents] = useState<Event[]>([]);
  const [poisonTotal, setPoisonTotal] = useState(0);
  const [renditionDlq, setRenditionDlq] = useState<RenditionDlqEvent[]>([]);
  const [renditionDlqOpenCount, setRenditionDlqOpenCount] = useState(0);
  const [operatingRenditionDlqIds, setOperatingRenditionDlqIds] = useState<Set<string>>(new Set());
  const [notificationDeliveryView, setNotificationDeliveryView] = useState<NotificationDeliveryView>("pending_stuck");
  const [notificationDeliveries, setNotificationDeliveries] = useState<NotificationDeliveryItem[]>([]);
  const [notificationDeliveryCounts, setNotificationDeliveryCounts] = useState<Record<NotificationDeliveryView, number>>({ pending_stuck: 0, dlq: 0, failed: 0, unknown: 0, preference_suppressed: 0 });
  const [notificationDeliveryCursor, setNotificationDeliveryCursor] = useState<string | null>(null);
  const [notificationDeliveriesError, setNotificationDeliveriesError] = useState<string>();
  const [isLoadingNotificationDeliveries, setIsLoadingNotificationDeliveries] = useState(false);
  const [operatingNotificationIds, setOperatingNotificationIds] = useState<Set<string>>(new Set());
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>();
  const [agencyForm, setAgencyForm] = useState({ name: "", notes: "" });
  const [agentForm, setAgentForm] = useState({ name: "", email: "", phone: "" });
  const [editingAgency, setEditingAgency] = useState<string>();
  const [editingAgent, setEditingAgent] = useState<string>();
  const [editingUserId, setEditingUserId] = useState<string>();
  const [userNameDraft, setUserNameDraft] = useState("");
  const [stageError, setStageError] = useState<string>();
  const [payload, setPayload] = useState<{ id: string; json: string }>();
  // Retain the last payload so the dialog still has content during its 120ms close (§6.0).
  const lastPayload = useRef<{ id: string; json: string } | undefined>(undefined);
  if (payload) lastPayload.current = payload;
  const shownPayload = payload ?? lastPayload.current;
  const [directoryError, setDirectoryError] = useState<string>();
  const [pipelineError, setPipelineError] = useState<string>();
  const [usersError, setUsersError] = useState<string>();
  const [integrationsError, setIntegrationsError] = useState<string>();
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isLoadingIntegrations, setIsLoadingIntegrations] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [isConnectingDropbox, setIsConnectingDropbox] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string>();
  const [operatingEventIds, setOperatingEventIds] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ email: "", name: "", role: "photographer" as Role });
  const [formErrors, setFormErrors] = useState<{ email?: string; name?: string }>({});
  const [dropboxNotice, setDropboxNotice] = useState<string>();

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    setUsersError(undefined);
    try {
      const [usersResponse, settingsResponse, freezeResponse] = await Promise.all([
        apiGet<UsersResponse>("/api/users"),
        apiGet<ImpersonationSettingsResponse>("/api/users/impersonation-settings"),
        apiGet<ProvisioningFreezeResponse>("/api/users/external-provisioning-freeze"),
      ]);
      setUsers(usersResponse.users);
      setImpersonationEnabled(settingsResponse.enabled);
      setProvisioningFreeze(freezeResponse);
    } catch (reason) {
      setUsersError(reason instanceof Error ? reason.message : "Users could not be loaded.");
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

  async function toggleImpersonation(event: ChangeEvent<HTMLInputElement>) {
    const requested = event.currentTarget.checked;
    setIsUpdatingImpersonation(true);
    try {
      const response = await apiPatch<ImpersonationSettingsResponse, { enabled: boolean }>("/api/users/impersonation-settings", { enabled: requested });
      setImpersonationEnabled(response.enabled);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The impersonation setting could not be updated.", "error");
    } finally {
      setIsUpdatingImpersonation(false);
    }
  }

  async function releaseProvisioningFreeze() {
    if (!await confirm({
      title: "Release the provisioning freeze?",
      message: "Only release it after a manual Cloudflare zone purge has completed. Otherwise a converted External Editor can keep reading cached pages they no longer have access to.",
      confirmLabel: "Release freeze",
      danger: true,
    })) return;
    setIsReleasingFreeze(true);
    try {
      setProvisioningFreeze(await apiPatch<ProvisioningFreezeResponse, { frozen: false }>("/api/users/external-provisioning-freeze", { frozen: false }));
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The provisioning freeze could not be released.", "error");
    } finally {
      setIsReleasingFreeze(false);
    }
  }

  const loadIntegrations = useCallback(async () => {
    setIsLoadingIntegrations(true);
    setIntegrationsError(undefined);
    try {
      setIntegrations((await apiGet<IntegrationsResponse>("/api/integrations")).integrations);
    } catch (reason) {
      setIntegrationsError(reason instanceof Error ? reason.message : "Integrations could not be loaded.");
    } finally {
      setIsLoadingIntegrations(false);
    }
  }, []);

  const loadDirectory = useCallback(async (agencyId = selectedAgencyId) => {
    setDirectoryError(undefined);
    try {
      const [agencyResponse, agentResponse] = await Promise.all([
        apiGet<{ agencies: Agency[] }>("/api/admin/agencies"),
        apiGet<{ agents: Agent[] }>(`/api/admin/agents${agencyId ? `?agencyId=${agencyId}` : ""}`),
      ]);
      setAgencies(agencyResponse.agencies); setAgents(agentResponse.agents);
    } catch (reason) { setDirectoryError(reason instanceof Error ? reason.message : "Directory could not be loaded."); }
  }, [selectedAgencyId]);

  const loadPipeline = useCallback(async () => {
    setPipelineError(undefined);
    try { setStages((await apiGet<{ stages: Stage[] }>("/api/admin/stages")).stages); }
    catch (reason) { setPipelineError(reason instanceof Error ? reason.message : "Pipeline stages could not be loaded."); }
  }, []);

  const loadTonomo = useCallback(async (offset = 0, append = false) => {
    try {
      const [health, events] = await Promise.all([apiGet<TonomoHealth>("/api/admin/tonomo-health"), apiGet<EventsResponse>(`/api/admin/webhook-events?source=tonomo&status=poison&limit=50&offset=${offset}`)]);
      setTonomoHealth(health.tonomo); setPoisonEvents((current) => append ? [...current, ...events.events] : events.events); setPoisonTotal(events.total);
    } catch (reason) { setIntegrationsError(reason instanceof Error ? reason.message : "Tonomo status could not be loaded."); }
  }, []);

  const loadRenditionsDlq = useCallback(async () => {
    try {
      const response = await apiGet<RenditionDlqResponse>("/api/admin/renditions-dlq");
      setRenditionDlq(response.events); setRenditionDlqOpenCount(response.openCount);
    } catch (reason) { setIntegrationsError(reason instanceof Error ? reason.message : "Rendition backlog could not be loaded."); }
  }, []);

  const loadNotificationDeliveries = useCallback(async (view = notificationDeliveryView, cursor?: string, append = false) => {
    setIsLoadingNotificationDeliveries(true); setNotificationDeliveriesError(undefined);
    try {
      const response = await apiGet<NotificationDeliveryResponse>(`/api/admin/notification-deliveries?view=${view}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      setNotificationDeliveries((current) => append ? [...current, ...response.items] : response.items);
      setNotificationDeliveryCursor(response.nextCursor); setNotificationDeliveryCounts(response.counts);
    } catch (reason) {
      setNotificationDeliveriesError(reason instanceof Error ? reason.message : "Notification delivery status could not be loaded.");
    } finally { setIsLoadingNotificationDeliveries(false); }
  }, [notificationDeliveryView]);

  // integrationsError is shared across loadIntegrations/loadTonomo/loadRenditionsDlq, so any
  // retry of that error state must re-run all three or it can silently re-render stale/empty
  // Tonomo or rendition-backlog data as if nothing were wrong.
  const loadIntegrationsTab = useCallback(async () => {
    await loadIntegrations();
    if (canAdminBackend) { await loadTonomo(); await loadRenditionsDlq(); await loadNotificationDeliveries(); }
  }, [canAdminBackend, loadIntegrations, loadNotificationDeliveries, loadRenditionsDlq, loadTonomo]);

  useEffect(() => {
    if (activeTab === "users" && canManageUsers) void loadUsers();
    if (activeTab === "directory" && canAdminBackend) void loadDirectory();
    if (activeTab === "pipeline" && canAdminBackend) void loadPipeline();
    if (activeTab === "integrations" && canManageIntegrations) void loadIntegrationsTab();
  }, [activeTab, canAdminBackend, canManageIntegrations, canManageUsers, loadDirectory, loadIntegrationsTab, loadPipeline, loadUsers]);

  async function provisionUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = {
      name: form.name.trim() ? undefined : "Enter the person's name.",
      email: !form.email.trim() ? "Enter an email address." : !EMAIL_PATTERN.test(form.email.trim()) ? "Enter a valid email address." : undefined,
    };
    setFormErrors(errors);
    if (errors.name || errors.email) return;

    setIsProvisioning(true);
    try {
      await apiPost<{ id: string }, { email: string; name: string; role: Role }>("/api/users", { email: form.email.trim(), name: form.name.trim(), role: form.role });
      setForm({ email: "", name: "", role: "photographer" });
      await loadUsers();
      toast("User provisioned. They can now sign in with Google.");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The user could not be provisioned.", "error");
    } finally {
      setIsProvisioning(false);
    }
  }

  async function updateUser(user: User, patch: { role?: Role; active?: boolean; name?: string; defaultEditor?: boolean }) {
    setUpdatingUserId(user.id);
    try {
      await apiPatch<{ ok: true }, typeof patch>(`/api/users/${user.id}`, patch);
      if (patch.name !== undefined && queryClient) await invalidateActiveProjectDetails(queryClient);
      await loadUsers();
      toast(patch.active === false ? `${user.name} has been deactivated and signed out everywhere.` : patch.active === true ? `${user.name} has been reactivated.` : patch.name !== undefined ? "Name updated." : patch.defaultEditor === true ? `${user.name} will be added to new projects as an editor.` : patch.defaultEditor === false ? `${user.name} will no longer be added to new projects.` : "Role updated.");
      return true;
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The user could not be updated.", "error");
      return false;
    } finally {
      setUpdatingUserId(undefined);
    }
  }

  async function toggleActive(user: User) {
    const action = user.active ? "deactivate" : "reactivate";
    const detail = user.active ? " This signs them out everywhere immediately." : "";
    if (!await confirm({ title: user.active ? "Deactivate user?" : "Reactivate user?", message: `Are you sure you want to ${action} ${user.name}?${detail}`, confirmLabel: user.active ? "Deactivate" : "Reactivate", danger: user.active })) return;
    await updateUser(user, { active: !user.active });
  }

  async function actAs(user: User) {
    if (!await confirm({
      title: `Act as ${user.name}?`,
      message: "You'll gain their exact permissions, including bypassing author-only restrictions, until you exit.",
      confirmLabel: "Act as user",
      danger: true,
    })) return;
    setUpdatingUserId(user.id);
    try {
      await impersonateUser(user.id);
      locationStore().replace("/");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The user session could not be started.", "error");
    } finally {
      setUpdatingUserId(undefined);
    }
  }

  function startEditingUserName(user: User) {
    setEditingUserId(user.id);
    setUserNameDraft(user.name);
  }

  async function saveUserName(user: User) {
    const name = userNameDraft.trim();
    if (!name) return;
    if (await updateUser(user, { name })) setEditingUserId(undefined);
  }

  async function connectDropbox() {
    setDropboxNotice(undefined);
    setIsConnectingDropbox(true);
    try {
      const response = await apiPost<{ url: string }, Record<string, never>>("/api/integrations/dropbox/connect-url", {});
      window.location.assign(response.url);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 503) setDropboxNotice("Dropbox app registration pending — see tasks/todo.md.");
      else setDropboxNotice(reason instanceof Error ? `Dropbox could not be connected: ${reason.message}` : "Dropbox could not be connected.");
    } finally {
      setIsConnectingDropbox(false);
    }
  }

  async function saveAgency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!agencyForm.name.trim()) return;
    try { await apiPost("/api/admin/agencies", { name: agencyForm.name.trim(), notes: agencyForm.notes.trim() || null }); setAgencyForm({ name: "", notes: "" }); await loadDirectory(); toast("Agency added."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Agency could not be saved.", "error"); }
  }
  async function saveAgencyEdit(agency: Agency) {
    try { await apiPatch(`/api/admin/agencies/${agency.id}`, { name: agency.name, notes: agency.notes }); setEditingAgency(undefined); await loadDirectory(); toast("Agency updated."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Agency could not be updated.", "error"); }
  }
  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!agentForm.name.trim()) return;
    try { await apiPost("/api/admin/agents", { agencyId: selectedAgencyId ?? null, name: agentForm.name.trim(), email: agentForm.email.trim() || null, phone: agentForm.phone.trim() || null }); setAgentForm({ name: "", email: "", phone: "" }); await loadDirectory(); toast("Agent added."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Agent could not be saved.", "error"); }
  }
  async function saveAgentEdit(agent: Agent) {
    try { await apiPatch(`/api/admin/agents/${agent.id}`, { agencyId: agent.agencyId, name: agent.name, email: agent.email, phone: agent.phone }); setEditingAgent(undefined); await loadDirectory(); toast("Agent updated."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Agent could not be updated.", "error"); }
  }
  async function updateStage(key: string, patch: Partial<Pick<Stage, "label" | "active">>) {
    setStageError(undefined);
    try { await apiPatch(`/api/admin/stages/${key}`, patch); await Promise.all([loadPipeline(), refreshStages()]); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "Stage could not be updated."; setStageError(message); }
  }
  async function viewPayload(id: string) {
    try { const detail = await apiGet<EventDetail>(`/api/admin/webhook-events/${id}`); setPayload({ id, json: JSON.stringify(JSON.parse(detail.event.payloadJson), null, 2) }); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Payload could not be loaded.", "error"); }
  }
  async function operateEvent(id: string, action: "retry" | "discard") {
    setOperatingEventIds((current) => new Set(current).add(id));
    try { await apiPost(`/api/admin/webhook-events/${id}/${action}`, {}); await loadTonomo(); toast(action === "retry" ? "Event queued for retry." : "Event discarded."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Event could not be updated.", "error"); }
    finally { setOperatingEventIds((current) => { const next = new Set(current); next.delete(id); return next; }); }
  }
  async function operateRenditionDlqEvent(id: string, action: "replay" | "discard") {
    setOperatingRenditionDlqIds((current) => new Set(current).add(id));
    try { await apiPost(`/api/admin/renditions-dlq/${id}/${action}`, {}); await loadRenditionsDlq(); toast(action === "replay" ? "Rendition queued for retry." : "Rendition discarded."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Rendition event could not be updated.", "error"); }
    finally { setOperatingRenditionDlqIds((current) => { const next = new Set(current); next.delete(id); return next; }); }
  }
  async function operateNotificationDelivery(item: NotificationDeliveryItem, action: "replay" | "discard") {
    if (action === "discard" && !await confirm({ title: "Discard delivery?", message: "Discard this durable delivery? It will not delete the comment, inbox, or delivery history.", confirmLabel: "Discard", danger: true })) return;
    if (action === "replay" && item.unknownEmailPossible && !await confirm({ title: "Replay email?", message: "Cloudflare may already have accepted this email. Replaying can send a duplicate. In-app delivery will not be recreated. Replay email anyway?", confirmLabel: "Replay email", danger: true })) return;
    setOperatingNotificationIds((current) => new Set(current).add(item.outboxId));
    try {
      const body = action === "replay" && item.unknownEmailPossible ? { acknowledgeDuplicateEmail: true, channels: ["email"] as const } : {};
      await apiPost(`/api/admin/notification-deliveries/${item.outboxId}/${action}`, body);
      await loadNotificationDeliveries(notificationDeliveryView);
      toast(action === "replay" ? "Notification delivery queued for replay." : "Notification delivery discarded.");
    } catch (reason) { toast(reason instanceof Error ? reason.message : "Notification delivery could not be updated.", "error"); }
    finally { setOperatingNotificationIds((current) => { const next = new Set(current); next.delete(item.outboxId); return next; }); }
  }

  function selectNotificationDeliveryView(view: NotificationDeliveryView) {
    setNotificationDeliveryView(view);
    void loadNotificationDeliveries(view);
  }
  if (availableTabs.length === 0) return null;

  return (
    <main className="page !max-w-[1280px]">
      <header className="flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]">
        <div>
          <Eyebrow className="block mb-[var(--space-3)]">Administration</Eyebrow>
          <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)]">Studio controls</h1>
        </div>
      </header>

      <TabStrip
        idPrefix="admin"
        label="Administration sections"
        value={activeTab}
        onValueChange={(next) => setActiveTab(next as AdminTab)}
        className="mb-[var(--space-6)]"
        items={availableTabs.map((tab) => ({ value: tab, label: TAB_LABELS[tab] }))}
      />

      {activeTab === "users" && canManageUsers && <section role="tabpanel" id="admin-panel-users" aria-labelledby="admin-tab-users" tabIndex={0}>
        <SectionHead
          eyebrow="Access roster"
          actions={<Button type="button" variant="outline" onClick={() => void loadUsers()} disabled={isLoadingUsers}>Refresh</Button>}
        >
          Users
        </SectionHead>

        <form
          className="grid gap-[var(--space-4)] items-end mb-[var(--space-6)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-[minmax(210px,1.25fr)_minmax(150px,0.85fr)_minmax(220px,1.1fr)_minmax(130px,0.7fr)_auto]"
          onSubmit={provisionUser}
          noValidate
        >
          <div className="self-center min-[721px]:col-span-full min-[1081px]:col-span-1">
            <Eyebrow className="block mb-[var(--space-2)]">Provision user</Eyebrow>
            <p className="m-0 max-w-[38ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Creating a user allows that Google account to sign in — access is closed otherwise.</p>
          </div>
          <QuincyField
            id="admin-provision-name"
            label="Name"
            value={form.name}
            onChange={(event) => { setForm((value) => ({ ...value, name: event.target.value })); setFormErrors((value) => ({ ...value, name: undefined })); }}
            aria-invalid={Boolean(formErrors.name)}
            error={formErrors.name}
          />
          <QuincyField
            id="admin-provision-email"
            label="Email"
            type="email"
            value={form.email}
            onChange={(event) => { setForm((value) => ({ ...value, email: event.target.value })); setFormErrors((value) => ({ ...value, email: undefined })); }}
            aria-invalid={Boolean(formErrors.email)}
            error={formErrors.email}
          />
          <QuincySelectField
            id="admin-provision-role"
            label="Role"
            value={form.role}
            onChange={(event) => setForm((value) => ({ ...value, role: event.target.value as Role }))}
          >
            {ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
          </QuincySelectField>
          <Button type="submit" className="max-[721px]:w-full" disabled={isProvisioning}>{isProvisioning ? "Provisioning…" : "Provision user"}</Button>
        </form>

        {isLoadingUsers && <EmptyState role="status" title="Loading users.">Reading the studio access roster.</EmptyState>}
        {!isLoadingUsers && usersError && <EmptyState role="alert" tone="error" title="Users are unavailable.">{usersError}<div className="mt-[var(--space-4)]"><Button type="button" variant="outline" onClick={() => void loadUsers()}>Try again</Button></div></EmptyState>}
        {!isLoadingUsers && !usersError && <label className={cn(TOGGLE_ROW, "mb-[var(--space-4)]")}><input type="checkbox" className={CHECKBOX_INPUT} checked={impersonationEnabled} disabled={isUpdatingImpersonation} onChange={toggleImpersonation} aria-label="Enable user impersonation (testing)" /><span>Enable user impersonation (testing)</span></label>}
        {!isLoadingUsers && !usersError && provisioningFreeze?.frozen && <Notice tone="caution" role="status" data-testid="admin-provisioning-freeze" className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)]">
          <span>External Editor provisioning has been frozen since {formatDate(provisioningFreeze.frozenAt === null ? null : new Date(provisioningFreeze.frozenAt).toISOString())}. The Cloudflare cache purge after a role change did not complete, so no one can be made an External Editor. Purge the zone manually, then release the freeze.</span>
          <Button type="button" variant="outline" disabled={isReleasingFreeze} onClick={() => void releaseProvisioningFreeze()}>Release freeze</Button>
        </Notice>}
        {!isLoadingUsers && !usersError && users.length === 0 && <EmptyState title="No users provisioned.">Provision a team member to give them closed-access Google sign-in.</EmptyState>}
        {!isLoadingUsers && !usersError && users.length > 0 && <TableWrap><Table>
          <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Email</TableHeader><TableHeader>Role</TableHeader><TableHeader>Access</TableHeader><TableHeader>Default editor</TableHeader><TableHeader>Created</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
          <TableBody>{users.map((user) => {
          const isSelf = user.id === currentUserId;
          const isUpdating = updatingUserId === user.id;
          const isEditingName = editingUserId === user.id;
          const canImpersonate = impersonationEnabled && user.active && user.role !== "admin" && !isSelf;
          const isDefaultEditorIneligible = !user.active || !isProjectAssignmentEligible("editor", user.role);
          return <TableRow key={user.id} data-testid="admin-user-row">
            <TableCell data-label="Name">{isEditingName ? <Input className="min-w-[130px] border-[var(--field-border)]" value={userNameDraft} onChange={(event) => setUserNameDraft(event.target.value)} aria-label={`Name for ${user.name}`} /> : <strong>{user.name}</strong>}</TableCell>
            <TableCell data-label="Email">{user.email}</TableCell>
            <TableCell data-label="Role"><label className="sr-only" htmlFor={`role-${user.id}`}>Role for {user.name}</label><NativeSelect id={`role-${user.id}`} className="min-w-[128px]" value={user.role} disabled={isUpdating} onChange={(event) => void updateUser(user, { role: event.target.value as Role })}>{ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</NativeSelect></TableCell>
            <TableCell data-label="Access"><StatusPill tone={user.active ? "positive" : "neutral"}>{user.active ? "Active" : "Inactive"}</StatusPill></TableCell>
            <TableCell data-label="Default editor"><input type="checkbox" className={CHECKBOX_INPUT} checked={user.defaultEditor} disabled={isUpdating || isDefaultEditorIneligible} title={isDefaultEditorIneligible ? "Only active editors, external editors and admins can be default editors" : undefined} onChange={() => void updateUser(user, { defaultEditor: !user.defaultEditor })} aria-label={`Default editor: ${user.name}`} /></TableCell>
            <TableCell data-label="Created">{formatDate(user.createdAt)}</TableCell>
            <TableCell className="min-[721px]:text-right min-[721px]:[&>button+button]:ml-[var(--space-3)] max-[721px]:flex max-[721px]:flex-wrap max-[721px]:gap-[var(--space-3)] max-[721px]:pt-[var(--space-3)]" data-testid="admin-user-actions">{isEditingName ? <><Button type="button" variant="outline" disabled={isUpdating} onClick={() => void saveUserName(user)}>Save</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => setEditingUserId(undefined)}>Cancel</Button></> : <><Button type="button" variant="ghost" className={TEXT_BUTTON} disabled={isUpdating} onClick={() => startEditingUserName(user)}>Edit</Button><Button type="button" variant="outline" disabled={isUpdating || isSelf} title={isSelf ? "You cannot deactivate your own account." : undefined} onClick={() => void toggleActive(user)}>{user.active ? "Deactivate" : "Reactivate"}</Button>{canImpersonate && <Button type="button" variant="ghost" className={TEXT_BUTTON} disabled={isUpdating} onClick={() => void actAs(user)}>Act as</Button>}</>}</TableCell>
          </TableRow>;
        })}</TableBody>
        </Table></TableWrap>}
      </section>}

      {activeTab === "directory" && canAdminBackend && <section role="tabpanel" id="admin-panel-directory" aria-labelledby="admin-tab-directory" tabIndex={0}>
        <SectionHead eyebrow="Client directory" actions={<Button type="button" variant="outline" onClick={() => void loadDirectory()}>Refresh</Button>}>Agencies & agents</SectionHead>
        {directoryError && <Notice role="alert" className="mb-[var(--space-4)]">{directoryError}</Notice>}
        <form
          className="grid gap-[var(--space-4)] items-end mb-[var(--space-6)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-[minmax(200px,1.2fr)_minmax(180px,1fr)_minmax(180px,1fr)_auto]"
          onSubmit={saveAgency}
        >
          <div className="self-center min-[721px]:col-span-full min-[1081px]:col-span-1">
            <Eyebrow className="block mb-[var(--space-2)]">Add agency</Eyebrow>
            <p className="m-0 max-w-[38ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Directory records remain available to projects once linked.</p>
          </div>
          <QuincyField id="admin-agency-name" label="Name" value={agencyForm.name} onChange={(event) => setAgencyForm((value) => ({ ...value, name: event.target.value }))} />
          <QuincyField id="admin-agency-notes" label="Notes" value={agencyForm.notes} onChange={(event) => setAgencyForm((value) => ({ ...value, notes: event.target.value }))} />
          <Button type="submit" className="max-[721px]:w-full">Add agency</Button>
        </form>
        <TableWrap><Table>
          <TableHead><TableRow><TableHeader>Agency</TableHeader><TableHeader>Notes</TableHeader><TableHeader>Agents</TableHeader><TableHeader>Created</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
          <TableBody>{agencies.length === 0 ? <TableRow><TableCell colSpan={5} className="text-center text-foreground-secondary">No agencies yet.</TableCell></TableRow> : agencies.map((agency) => {
            const isSelected = selectedAgencyId === agency.id;
            return <TableRow
              key={agency.id}
              data-selected={isSelected ? "true" : undefined}
              className="data-[selected]:bg-signal-positive/6 min-[721px]:data-[selected]:[border-left-style:solid] min-[721px]:data-[selected]:border-l-[length:var(--border-width-rule)] min-[721px]:data-[selected]:border-l-signal-positive max-[721px]:data-[selected]:border-signal-positive"
            >
              <TableCell data-label="Agency">{isSelected && <span className="sr-only">Selected</span>}{editingAgency === agency.id ? <Input className="min-w-[130px] border-[var(--field-border)]" aria-label={`Name for ${agency.name}`} value={agency.name} onChange={(event) => setAgencies((current) => current.map((item) => item.id === agency.id ? { ...item, name: event.target.value } : item))} /> : <strong>{agency.name}</strong>}</TableCell>
              <TableCell data-label="Notes">{editingAgency === agency.id ? <Input className="min-w-[130px] border-[var(--field-border)]" aria-label={`Notes for ${agency.name}`} value={agency.notes ?? ""} onChange={(event) => setAgencies((current) => current.map((item) => item.id === agency.id ? { ...item, notes: event.target.value || null } : item))} /> : agency.notes || "—"}</TableCell>
              <TableCell data-label="Agents">{agency.agentCount}</TableCell>
              <TableCell data-label="Created">{formatDate(agency.createdAt)}</TableCell>
              <TableCell className="min-[721px]:text-right min-[721px]:[&>button+button]:ml-[var(--space-3)] max-[721px]:flex max-[721px]:flex-wrap max-[721px]:gap-[var(--space-3)] max-[721px]:pt-[var(--space-3)]">{editingAgency === agency.id ? <><Button type="button" variant="outline" onClick={() => void saveAgencyEdit(agency)}>Save</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => setEditingAgency(undefined)}>Cancel</Button></> : <><Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => { setSelectedAgencyId(agency.id); void loadDirectory(agency.id); }}>Agents</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => setEditingAgency(agency.id)}>Edit</Button></>}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table></TableWrap>
        <SectionHead eyebrow={selectedAgencyId ? agencies.find((agency) => agency.id === selectedAgencyId)?.name ?? "Selected agency" : "All agencies"} className={cn("mt-[var(--space-8)]")} actions={selectedAgencyId ? <Button type="button" variant="outline" onClick={() => { setSelectedAgencyId(undefined); void loadDirectory(undefined); }}>Show all</Button> : undefined}>Agents</SectionHead>
        <form
          className="grid gap-[var(--space-4)] items-end mb-[var(--space-6)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-[minmax(190px,1fr)_minmax(150px,0.8fr)_minmax(180px,1fr)_minmax(160px,0.8fr)_auto]"
          onSubmit={saveAgent}
        >
          <div className="self-center min-[721px]:col-span-full min-[1081px]:col-span-1">
            <Eyebrow className="block mb-[var(--space-2)]">Add agent</Eyebrow>
            <p className="m-0 max-w-[38ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{selectedAgencyId ? "The agent will be assigned to this agency." : "Choose an agency above to assign this agent."}</p>
          </div>
          <QuincyField id="admin-agent-name" label="Name" value={agentForm.name} onChange={(event) => setAgentForm((value) => ({ ...value, name: event.target.value }))} />
          <QuincyField id="admin-agent-email" label="Email" type="email" value={agentForm.email} onChange={(event) => setAgentForm((value) => ({ ...value, email: event.target.value }))} />
          <QuincyField id="admin-agent-phone" label="Phone" value={agentForm.phone} onChange={(event) => setAgentForm((value) => ({ ...value, phone: event.target.value }))} />
          <Button type="submit" className="max-[721px]:w-full">Add agent</Button>
        </form>
        <TableWrap><Table>
          <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Email</TableHeader><TableHeader>Phone</TableHeader><TableHeader>Agency</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
          <TableBody>{agents.length === 0 ? <TableRow><TableCell colSpan={5} className="text-center text-foreground-secondary">No agents found.</TableCell></TableRow> : agents.map((agent) => <TableRow key={agent.id}>
            <TableCell data-label="Name">{editingAgent === agent.id ? <Input className="min-w-[130px] border-[var(--field-border)]" aria-label={`Name for ${agent.name}`} value={agent.name} onChange={(event) => setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, name: event.target.value } : item))} /> : <strong>{agent.name}</strong>}</TableCell>
            <TableCell data-label="Email">{editingAgent === agent.id ? <Input className="min-w-[130px] border-[var(--field-border)]" aria-label={`Email for ${agent.name}`} value={agent.email ?? ""} onChange={(event) => setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, email: event.target.value || null } : item))} /> : agent.email || "—"}</TableCell>
            <TableCell data-label="Phone">{editingAgent === agent.id ? <Input className="min-w-[130px] border-[var(--field-border)]" aria-label={`Phone for ${agent.name}`} value={agent.phone ?? ""} onChange={(event) => setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, phone: event.target.value || null } : item))} /> : agent.phone || "—"}</TableCell>
            <TableCell data-label="Agency">{agent.agencyName || "—"}</TableCell>
            <TableCell className="min-[721px]:text-right min-[721px]:[&>button+button]:ml-[var(--space-3)] max-[721px]:flex max-[721px]:flex-wrap max-[721px]:gap-[var(--space-3)] max-[721px]:pt-[var(--space-3)]">{editingAgent === agent.id ? <><Button type="button" variant="outline" onClick={() => void saveAgentEdit(agent)}>Save</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => setEditingAgent(undefined)}>Cancel</Button></> : <Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => setEditingAgent(agent.id)}>Edit</Button>}</TableCell>
          </TableRow>)}</TableBody>
        </Table></TableWrap>
      </section>}

      {activeTab === "pipeline" && canAdminBackend && <section role="tabpanel" id="admin-panel-pipeline" aria-labelledby="admin-tab-pipeline" tabIndex={0}>
        <SectionHead eyebrow="Project flow" actions={<Button type="button" variant="outline" onClick={() => void loadPipeline()} data-testid="admin-pipeline-refresh">Refresh</Button>}>Pipeline stages</SectionHead>
        {pipelineError && <Notice role="alert" className="mb-[var(--space-4)]">{pipelineError}</Notice>}
        {stageError && <Notice role="alert" className="mb-[var(--space-4)]">{stageError}</Notice>}
        <div className="flex flex-col [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border">{stages.map((stage) => <div className="grid gap-[var(--space-4)] items-end p-[var(--space-4)] border-solid border-[length:var(--border-width-hair)] border-border border-t-0 bg-card grid-cols-[28px_minmax(0,1fr)] min-[721px]:grid-cols-[34px_minmax(150px,0.8fr)_minmax(180px,1fr)_90px]" key={stage.key} data-testid="admin-stage">
          <div className="self-center [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground-secondary [font-variant-numeric:tabular-nums]" data-testid="admin-stage-order">{stage.displayOrder}</div>
          <div className="min-w-0"><strong className="block capitalize text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{stage.key.replace(/_/g, " ")}</strong><small className="block mt-[var(--space-1)] [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Stable stage key</small></div>
          <QuincyField
            id={`stage-label-${stage.key}`}
            label="Label"
            className="max-[721px]:col-span-full"
            value={stage.label}
            onChange={(event) => setStages((current) => current.map((item) => item.key === stage.key ? { ...item, label: event.target.value } : item))}
            onBlur={() => void updateStage(stage.key, { label: stage.label })}
          />
          <label className={cn(TOGGLE_ROW, "max-[721px]:col-span-full")}><input type="checkbox" className={CHECKBOX_INPUT} checked={stage.active} onChange={(event) => void updateStage(stage.key, { active: event.target.checked })} /><span>{stage.active ? "Active" : "Inactive"}</span></label>
        </div>)}</div>
      </section>}

      {activeTab === "integrations" && canManageIntegrations && <section role="tabpanel" id="admin-panel-integrations" aria-labelledby="admin-tab-integrations" tabIndex={0}>
        <SectionHead eyebrow="Studio connections" actions={<Button type="button" variant="outline" onClick={() => void loadIntegrationsTab()} disabled={isLoadingIntegrations}>Refresh</Button>}>Integrations</SectionHead>
        {isLoadingIntegrations && <EmptyState role="status" title="Loading integrations.">Checking studio connections.</EmptyState>}
        {!isLoadingIntegrations && integrationsError && <EmptyState role="alert" tone="error" title="Integrations are unavailable.">{integrationsError}<div className="mt-[var(--space-4)]"><Button type="button" variant="outline" onClick={() => void loadIntegrationsTab()}>Try again</Button></div></EmptyState>}
        {!isLoadingIntegrations && !integrationsError && <div className="grid gap-[var(--space-4)] grid-cols-1 min-[1081px]:grid-cols-3">{PROVIDERS.map((provider) => {
          const integration = integrations.find((item) => item.provider === provider);
          const status = provider === "tonomo" ? (tonomoHealth?.lastEventAt ? "connected" : "disconnected") : integration?.status ?? "not-configured";
          const title = provider === "dropbox" ? "Dropbox" : provider === "tonomo" ? "Tonomo" : "Vimeo";
          return <article className="flex flex-col p-[var(--space-5)] border-solid border-[length:var(--border-width-hair)] border-border bg-card" key={provider}>
            <div className="flex items-start justify-between gap-[var(--space-3)]">
              <h3 className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground">{title}</h3>
              <StatusPill tone={TONE_FOR_STATUS[status]}>{provider === "tonomo" ? tonomoHealth?.lastEventAt ? "Receiving" : "Awaiting first event" : statusLabel(status)}</StatusPill>
            </div>
            {/* `!mt` on each blurb below: `tokens/base.css` is imported outside any `@layer`, so its
                `p { margin: 0 }` beats a plain margin utility from `@layer utilities`. (§7 case O) */}
            {provider === "dropbox" ? <>
              <p className="!mt-[var(--space-5)] mb-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{integration ? "Connect the studio Dropbox to sync RAW capture folders." : "No Dropbox connection has been configured for this studio."}</p>
              {integration?.lastError && <Notice role="alert" className="mb-[var(--space-3)]">{integration.lastError}</Notice>}
              <dl className="flex flex-wrap gap-x-[var(--space-5)] gap-y-[var(--space-3)] my-[var(--space-5)] [&>div]:flex [&>div]:flex-col [&>div]:gap-[var(--space-1)] [&_dt]:[font:var(--type-eyebrow)] [&_dt]:uppercase [&_dt]:tracking-[var(--tracking-wide)] [&_dt]:text-foreground-secondary [&_dd]:m-0 [&_dd]:[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [&_dd]:text-foreground-secondary">
                <div><dt>Last event</dt><dd>{relativeTime(integration?.lastEventAt ?? null)}</dd></div>
                {integration?.expiresAt && <div><dt>Expires</dt><dd>{formatDate(integration.expiresAt)}</dd></div>}
              </dl>
              {dropboxNotice && <Notice role="alert" className="mb-[var(--space-3)]">{dropboxNotice}</Notice>}
              <Button type="button" className="self-start mt-auto" onClick={() => void connectDropbox()} disabled={isConnectingDropbox}>{isConnectingDropbox ? "Opening Dropbox…" : integration?.status === "connected" ? "Reconnect Dropbox" : "Connect Dropbox"}</Button>
            </> : provider === "tonomo" ? <>
              <p className="!mt-[var(--space-5)] mb-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Order deliveries are recorded and reconciled automatically.</p>
              <dl className="flex flex-wrap gap-x-[var(--space-5)] gap-y-[var(--space-3)] my-[var(--space-5)] [&>div]:flex [&>div]:flex-col [&>div]:gap-[var(--space-1)] [&_dt]:[font:var(--type-eyebrow)] [&_dt]:uppercase [&_dt]:tracking-[var(--tracking-wide)] [&_dt]:text-foreground-secondary [&_dd]:m-0 [&_dd]:[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [&_dd]:text-foreground-secondary">
                <div><dt>Last event</dt><dd>{relativeTime(tonomoHealth?.lastEventAt ?? null)}</dd></div>
                <div><dt>Processed</dt><dd>{tonomoHealth?.counts.processed ?? 0}</dd></div>
                <div><dt>Received</dt><dd>{tonomoHealth?.counts.received ?? 0}</dd></div>
                <div><dt>Poison</dt><dd>{tonomoHealth?.counts.poison ?? 0}</dd></div>
              </dl>
            </> : <>
              <p className="!mt-[var(--space-5)] mb-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Configured in a later phase.</p>
              <dl className="flex flex-wrap gap-x-[var(--space-5)] gap-y-[var(--space-3)] my-[var(--space-5)] [&>div]:flex [&>div]:flex-col [&>div]:gap-[var(--space-1)] [&_dt]:[font:var(--type-eyebrow)] [&_dt]:uppercase [&_dt]:tracking-[var(--tracking-wide)] [&_dt]:text-foreground-secondary [&_dd]:m-0 [&_dd]:[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] [&_dd]:text-foreground-secondary">
                <div><dt>Last event</dt><dd>{relativeTime(integration?.lastEventAt ?? null)}</dd></div>
              </dl>
            </>}
          </article>;
        })}</div>}
        {!isLoadingIntegrations && !integrationsError && canAdminBackend && <div className="mt-[var(--space-8)]">
          <SectionHead
            eyebrow="Operator queue"
            actions={<StatusPill tone={poisonTotal > 0 ? "critical" : "neutral"}>{poisonTotal > 0 ? `${poisonTotal} events` : "No events"}</StatusPill>}
          >
            Failed Tonomo events
          </SectionHead>
          {poisonEvents.length === 0 ? <EmptyState title="No failed events.">Tonomo orders are processing normally.</EmptyState> : <>
            <TableWrap><Table>
              <TableHead><TableRow><TableHeader>Received</TableHeader><TableHeader>Order</TableHeader><TableHeader>Error reason</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
              <TableBody>{poisonEvents.map((event) => { const isOperating = operatingEventIds.has(event.id); return <TableRow key={event.id}>
                <TableCell data-label="Received">{formatDate(event.receivedAt)}</TableCell>
                <TableCell data-label="Order">{event.summary ? <>{event.summary.street}<br /><small>{event.summary.orderId}</small></> : "Unparseable"}</TableCell>
                <TableCell data-label="Error reason">{event.error || "—"}</TableCell>
                <TableCell className="min-[721px]:text-right min-[721px]:[&>button+button]:ml-[var(--space-3)] max-[721px]:flex max-[721px]:flex-wrap max-[721px]:gap-[var(--space-3)] max-[721px]:pt-[var(--space-3)]"><Button type="button" variant="ghost" className={TEXT_BUTTON} onClick={() => void viewPayload(event.id)}>View payload</Button><Button type="button" variant="outline" disabled={isOperating} onClick={() => void operateEvent(event.id, "retry")}>Retry</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} disabled={isOperating} onClick={() => void operateEvent(event.id, "discard")}>Discard</Button></TableCell>
              </TableRow>; })}</TableBody>
            </Table></TableWrap>
            {poisonTotal > poisonEvents.length && <div className="mt-[var(--space-4)]"><Button type="button" variant="outline" onClick={() => void loadTonomo(poisonEvents.length, true)}>Load more</Button></div>}
          </>}
        </div>}
        {!isLoadingIntegrations && !integrationsError && canAdminBackend && <div className="mt-[var(--space-8)]">
          <SectionHead
            eyebrow="Operator queue"
            actions={<StatusPill tone={renditionDlqOpenCount > 0 ? "critical" : "neutral"}>{renditionDlqOpenCount > 0 ? `${renditionDlqOpenCount} stuck` : "No backlog"}</StatusPill>}
          >
            Rendition delivery failures
          </SectionHead>
          {renditionDlq.length === 0 ? <EmptyState title="No stuck renditions.">Preview generation is processing normally.</EmptyState> : <TableWrap><Table>
            <TableHead><TableRow><TableHeader>First failed</TableHeader><TableHeader>Project</TableHeader><TableHeader>Asset</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
            <TableBody>{renditionDlq.map((event) => { const isOperating = operatingRenditionDlqIds.has(event.id); return <TableRow key={event.id}>
              <TableCell data-label="First failed">{formatDate(event.receivedAt)}</TableCell>
              <TableCell data-label="Project">{event.street || "—"}</TableCell>
              <TableCell data-label="Asset"><code className="[font:var(--weight-regular)_var(--text-xs)/1.4_var(--font-mono)]">{event.assetId}</code></TableCell>
              <TableCell className="min-[721px]:text-right min-[721px]:[&>button+button]:ml-[var(--space-3)] max-[721px]:flex max-[721px]:flex-wrap max-[721px]:gap-[var(--space-3)] max-[721px]:pt-[var(--space-3)]"><Button type="button" variant="outline" disabled={isOperating} onClick={() => void operateRenditionDlqEvent(event.id, "replay")}>Replay</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} disabled={isOperating} onClick={() => void operateRenditionDlqEvent(event.id, "discard")}>Discard</Button></TableCell>
            </TableRow>; })}</TableBody>
          </Table></TableWrap>}
        </div>}
        {!isLoadingIntegrations && !integrationsError && canAdminBackend && <div className="mt-[var(--space-8)]" aria-label="Notification delivery operations">
          <SectionHead
            eyebrow="Operator queue"
            actions={<>
              <StatusPill tone={notificationDeliveryCounts[notificationDeliveryView] > 0 ? "critical" : "neutral"}>{notificationDeliveryCounts[notificationDeliveryView] > 0 ? `${notificationDeliveryCounts[notificationDeliveryView]} deliveries` : "No deliveries"}</StatusPill>
              <Button type="button" variant="outline" disabled={isLoadingNotificationDeliveries} onClick={() => void loadNotificationDeliveries(notificationDeliveryView)} data-testid="admin-notification-delivery-refresh">Refresh</Button>
            </>}
          >
            Notification delivery
          </SectionHead>
          <TabStrip
            idPrefix="admin-delivery"
            label="Notification delivery filters"
            value={notificationDeliveryView}
            onValueChange={(next) => selectNotificationDeliveryView(next as NotificationDeliveryView)}
            className="mb-[var(--space-5)]"
            items={DELIVERY_VIEWS.map((view) => ({ value: view, label: DELIVERY_LABELS[view], count: notificationDeliveryCounts[view] }))}
          />
          <div role="tabpanel" id={`admin-delivery-panel-${notificationDeliveryView}`} aria-labelledby={`admin-delivery-tab-${notificationDeliveryView}`} tabIndex={0}>
            {notificationDeliveriesError && <Notice role="alert" className="mb-[var(--space-4)]">{notificationDeliveriesError}</Notice>}
            {isLoadingNotificationDeliveries && <EmptyState role="status" title="Loading delivery status.">Reading the durable notification ledger.</EmptyState>}
            {!isLoadingNotificationDeliveries && !notificationDeliveriesError && notificationDeliveries.length === 0 && <EmptyState title="No matching deliveries.">This queue is clear.</EmptyState>}
            {!isLoadingNotificationDeliveries && notificationDeliveries.length > 0 && <TableWrap><Table>
              <TableHead><TableRow><TableHeader>Updated</TableHeader><TableHeader>Event</TableHeader><TableHeader>Project</TableHeader><TableHeader>Recipient</TableHeader><TableHeader>Channels</TableHeader><TableHeader>State</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
              <TableBody>{notificationDeliveries.map((item) => { const isOperating = operatingNotificationIds.has(item.outboxId); return <TableRow key={item.outboxId}>
                <TableCell data-label="Updated">{formatDate(new Date(item.updatedAt).toISOString())}</TableCell>
                <TableCell data-label="Event">{eventTypeLabel(item.eventType)}</TableCell>
                <TableCell data-label="Project">{item.projectStreet || item.projectId || "—"}</TableCell>
                <TableCell data-label="Recipient">{item.recipientName || "Unavailable"}</TableCell>
                <TableCell data-label="Channels">{item.channels.map((channel) => `${channel.channel}: ${channel.status}`).join(" · ")}{item.unknownEmailPossible && <><br /><strong className="text-destructive [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]">Duplicate email possible</strong></>}</TableCell>
                <TableCell data-label="State">{item.status}{item.safeErrorCode && <><br /><small>{item.safeErrorCode}</small></>}</TableCell>
                <TableCell className="min-[721px]:text-right min-[721px]:[&>button+button]:ml-[var(--space-3)] max-[721px]:flex max-[721px]:flex-wrap max-[721px]:gap-[var(--space-3)] max-[721px]:pt-[var(--space-3)]" data-testid="admin-notification-delivery-actions">{notificationDeliveryView !== "preference_suppressed" && <><Button type="button" variant="outline" disabled={isOperating} onClick={() => void operateNotificationDelivery(item, "replay")}>Replay</Button><Button type="button" variant="ghost" className={TEXT_BUTTON} disabled={isOperating} onClick={() => void operateNotificationDelivery(item, "discard")}>Discard</Button></>}</TableCell>
              </TableRow>; })}</TableBody>
            </Table></TableWrap>}
            {notificationDeliveryCursor && <div className="mt-[var(--space-4)]"><Button type="button" variant="outline" disabled={isLoadingNotificationDeliveries} onClick={() => void loadNotificationDeliveries(notificationDeliveryView, notificationDeliveryCursor, true)}>Load more</Button></div>}
          </div>
        </div>}
      </section>}
      <Modal
        open={!!payload}
        title="Event details"
        eyebrow="Webhook payload"
        size="prose"
        testId="admin-payload-modal"
        onClose={() => setPayload(undefined)}
        footer={<Button variant="secondary" onClick={() => setPayload(undefined)}>Close</Button>}
      >
        <pre className="max-h-[55vh] overflow-auto m-0 p-[var(--space-4)] bg-background text-foreground-secondary [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-mono)]">
          {shownPayload?.json}
        </pre>
      </Modal>
      <ToastViewport />
    </main>
  );
}
