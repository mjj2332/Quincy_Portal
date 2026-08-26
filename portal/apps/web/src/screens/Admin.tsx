import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { ROLES, type Role } from "@quincy/shared";
import { ApiError, apiGet, apiPatch, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { useStages } from "../lib/stages";
import { invalidateActiveProjectDetails, useOptionalProjectQueryClient } from "../lib/project-data";
import { confirm } from "../lib/confirm";
import { impersonateUser } from "../lib/auth";
import { locationStore } from "../lib/router";

type AdminTab = "users" | "directory" | "pipeline" | "integrations";
type Toast = { id: number; message: string; tone: "success" | "error" };
type User = { id: string; name: string; email: string; role: Role; active: boolean; createdAt: string | null };
type IntegrationStatus = "connected" | "disconnected" | "expired" | "error";
type Integration = { provider: string; status: IntegrationStatus; expiresAt: string | null; lastEventAt: string | null; lastError: string | null };
type UsersResponse = { users: User[] };
type ImpersonationSettingsResponse = { enabled: boolean };
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
type NotificationDeliveryView = "pending_stuck" | "dlq" | "failed" | "unknown";
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
  const [notificationDeliveryCounts, setNotificationDeliveryCounts] = useState<Record<NotificationDeliveryView, number>>({ pending_stuck: 0, dlq: 0, failed: 0, unknown: 0 });
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
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }, []);

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    setUsersError(undefined);
    try {
      const [usersResponse, settingsResponse] = await Promise.all([
        apiGet<UsersResponse>("/api/users"),
        apiGet<ImpersonationSettingsResponse>("/api/users/impersonation-settings"),
      ]);
      setUsers(usersResponse.users);
      setImpersonationEnabled(settingsResponse.enabled);
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

  async function updateUser(user: User, patch: { role?: Role; active?: boolean; name?: string }) {
    setUpdatingUserId(user.id);
    try {
      await apiPatch<{ ok: true }, typeof patch>(`/api/users/${user.id}`, patch);
      if (patch.name !== undefined && queryClient) await invalidateActiveProjectDetails(queryClient);
      await loadUsers();
      toast(patch.active === false ? `${user.name} has been deactivated and signed out everywhere.` : patch.active === true ? `${user.name} has been reactivated.` : patch.name !== undefined ? "Name updated." : "Role updated.");
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
    <main className="page admin-page">
      <div className="pagehead">
        <div>
          <div className="ey" style={{ marginBottom: 14 }}>Administration</div>
          <h1 className="serif">Studio controls</h1>
        </div>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="Administration sections">
        {availableTabs.map((tab) => <button key={tab} className={`ctab ${activeTab === tab ? "is-active" : ""}`} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>{tab === "users" ? "Users" : tab === "directory" ? "Directory" : tab === "pipeline" ? "Pipeline" : "Integrations"}</button>)}
      </div>

      {activeTab === "users" && canManageUsers && <section className="admin-section" role="tabpanel">
        <div className="admin-section__head">
          <div><div className="ey">Access roster</div><h2 className="serif">Users</h2></div>
          <button className="button button--secondary" type="button" onClick={() => void loadUsers()} disabled={isLoadingUsers}>Refresh</button>
        </div>

        <form className="admin-provision" onSubmit={provisionUser} noValidate>
          <div className="admin-provision__copy"><div className="ey">Provision user</div><p>Creating a user allows that Google account to sign in — access is closed otherwise.</p></div>
          <label className="admin-field"><span>Name</span><input value={form.name} onChange={(event) => { setForm((value) => ({ ...value, name: event.target.value })); setFormErrors((value) => ({ ...value, name: undefined })); }} aria-invalid={Boolean(formErrors.name)} />{formErrors.name && <small>{formErrors.name}</small>}</label>
          <label className="admin-field"><span>Email</span><input type="email" value={form.email} onChange={(event) => { setForm((value) => ({ ...value, email: event.target.value })); setFormErrors((value) => ({ ...value, email: undefined })); }} aria-invalid={Boolean(formErrors.email)} />{formErrors.email && <small>{formErrors.email}</small>}</label>
          <label className="admin-field"><span>Role</span><select value={form.role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value as Role }))}>{ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
          <button className="button" type="submit" disabled={isProvisioning}>{isProvisioning ? "Provisioning…" : "Provision user"}</button>
        </form>

        {isLoadingUsers && <div className="empty" role="status"><span className="serif">Loading users.</span>Reading the studio access roster.</div>}
        {!isLoadingUsers && usersError && <div className="empty" role="alert"><span className="serif">Users are unavailable.</span>{usersError}<div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void loadUsers()}>Try again</button></div></div>}
        {!isLoadingUsers && !usersError && <label className="admin-toggle admin-impersonation-toggle"><input type="checkbox" checked={impersonationEnabled} disabled={isUpdatingImpersonation} onChange={toggleImpersonation} aria-label="Enable user impersonation (testing)" /><span>Enable user impersonation (testing)</span></label>}
        {!isLoadingUsers && !usersError && users.length === 0 && <div className="empty"><span className="serif">No users provisioned.</span>Provision a team member to give them closed-access Google sign-in.</div>}
        {!isLoadingUsers && !usersError && users.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{users.map((user) => {
          const isSelf = user.id === currentUserId;
          const isUpdating = updatingUserId === user.id;
          const isEditingName = editingUserId === user.id;
          const canImpersonate = impersonationEnabled && user.active && user.role !== "admin" && !isSelf;
          return <tr key={user.id}><td data-label="Name">{isEditingName ? <input className="admin-inline-input" value={userNameDraft} onChange={(event) => setUserNameDraft(event.target.value)} aria-label={`Name for ${user.name}`} /> : <strong>{user.name}</strong>}</td><td data-label="Email">{user.email}</td><td data-label="Role"><label className="sr-only" htmlFor={`role-${user.id}`}>Role for {user.name}</label><select id={`role-${user.id}`} className="admin-role-select" value={user.role} disabled={isUpdating} onChange={(event) => void updateUser(user, { role: event.target.value as Role })}>{ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></td><td data-label="Access"><span className={`admin-status admin-status--${user.active ? "active" : "inactive"}`}>{user.active ? "Active" : "Inactive"}</span></td><td data-label="Created">{formatDate(user.createdAt)}</td><td className="admin-table__action">{isEditingName ? <><button className="button button--secondary" type="button" disabled={isUpdating} onClick={() => void saveUserName(user)}>Save</button><button className="button button--text" type="button" onClick={() => setEditingUserId(undefined)}>Cancel</button></> : <><button className="button button--text" type="button" disabled={isUpdating} onClick={() => startEditingUserName(user)}>Edit</button><button className="button button--secondary" type="button" disabled={isUpdating || isSelf} title={isSelf ? "You cannot deactivate your own account." : undefined} onClick={() => void toggleActive(user)}>{user.active ? "Deactivate" : "Reactivate"}</button>{canImpersonate && <button className="button button--text" type="button" disabled={isUpdating} onClick={() => void actAs(user)}>Act as</button>}</>}</td></tr>;
        })}</tbody></table></div>}
      </section>}

      {activeTab === "directory" && canAdminBackend && <section className="admin-section" role="tabpanel">
        <div className="admin-section__head"><div><div className="ey">Client directory</div><h2 className="serif">Agencies & agents</h2></div><button className="button button--secondary" type="button" onClick={() => void loadDirectory()}>Refresh</button></div>
        {directoryError && <div className="notice" role="alert">{directoryError}</div>}
        <form className="admin-provision admin-directory-form" onSubmit={saveAgency}><div className="admin-provision__copy"><div className="ey">Add agency</div><p>Directory records remain available to projects once linked.</p></div><label className="admin-field"><span>Name</span><input value={agencyForm.name} onChange={(event) => setAgencyForm((value) => ({ ...value, name: event.target.value }))} /></label><label className="admin-field"><span>Notes</span><input value={agencyForm.notes} onChange={(event) => setAgencyForm((value) => ({ ...value, notes: event.target.value }))} /></label><button className="button" type="submit">Add agency</button></form>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Agency</th><th>Notes</th><th>Agents</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{agencies.length === 0 ? <tr><td colSpan={5} className="admin-table__empty">No agencies yet.</td></tr> : agencies.map((agency) => <tr key={agency.id} className={selectedAgencyId === agency.id ? "is-selected" : ""}><td data-label="Agency">{editingAgency === agency.id ? <input className="admin-inline-input" value={agency.name} onChange={(event) => setAgencies((current) => current.map((item) => item.id === agency.id ? { ...item, name: event.target.value } : item))} /> : <strong>{agency.name}</strong>}</td><td data-label="Notes">{editingAgency === agency.id ? <input className="admin-inline-input" value={agency.notes ?? ""} onChange={(event) => setAgencies((current) => current.map((item) => item.id === agency.id ? { ...item, notes: event.target.value || null } : item))} /> : agency.notes || "—"}</td><td data-label="Agents">{agency.agentCount}</td><td data-label="Created">{formatDate(agency.createdAt)}</td><td className="admin-table__action">{editingAgency === agency.id ? <><button className="button button--secondary" type="button" onClick={() => void saveAgencyEdit(agency)}>Save</button><button className="button button--text" type="button" onClick={() => setEditingAgency(undefined)}>Cancel</button></> : <><button className="button button--text" type="button" onClick={() => { setSelectedAgencyId(agency.id); void loadDirectory(agency.id); }}>Agents</button><button className="button button--text" type="button" onClick={() => setEditingAgency(agency.id)}>Edit</button></>}</td></tr>)}</tbody></table></div>
        <div className="admin-section__head admin-subsection"><div><div className="ey">{selectedAgencyId ? agencies.find((agency) => agency.id === selectedAgencyId)?.name ?? "Selected agency" : "All agencies"}</div><h2 className="serif">Agents</h2></div>{selectedAgencyId && <button className="button button--secondary" type="button" onClick={() => { setSelectedAgencyId(undefined); void loadDirectory(undefined); }}>Show all</button>}</div>
        <form className="admin-provision admin-directory-form admin-agent-form" onSubmit={saveAgent}><div className="admin-provision__copy"><div className="ey">Add agent</div><p>{selectedAgencyId ? "The agent will be assigned to this agency." : "Choose an agency above to assign this agent."}</p></div><label className="admin-field"><span>Name</span><input value={agentForm.name} onChange={(event) => setAgentForm((value) => ({ ...value, name: event.target.value }))} /></label><label className="admin-field"><span>Email</span><input type="email" value={agentForm.email} onChange={(event) => setAgentForm((value) => ({ ...value, email: event.target.value }))} /></label><label className="admin-field"><span>Phone</span><input value={agentForm.phone} onChange={(event) => setAgentForm((value) => ({ ...value, phone: event.target.value }))} /></label><button className="button" type="submit">Add agent</button></form>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Agency</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{agents.length === 0 ? <tr><td colSpan={5} className="admin-table__empty">No agents found.</td></tr> : agents.map((agent) => <tr key={agent.id}><td data-label="Name">{editingAgent === agent.id ? <input className="admin-inline-input" value={agent.name} onChange={(event) => setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, name: event.target.value } : item))} /> : <strong>{agent.name}</strong>}</td><td data-label="Email">{editingAgent === agent.id ? <input className="admin-inline-input" value={agent.email ?? ""} onChange={(event) => setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, email: event.target.value || null } : item))} /> : agent.email || "—"}</td><td data-label="Phone">{editingAgent === agent.id ? <input className="admin-inline-input" value={agent.phone ?? ""} onChange={(event) => setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, phone: event.target.value || null } : item))} /> : agent.phone || "—"}</td><td data-label="Agency">{agent.agencyName || "—"}</td><td className="admin-table__action">{editingAgent === agent.id ? <><button className="button button--secondary" type="button" onClick={() => void saveAgentEdit(agent)}>Save</button><button className="button button--text" type="button" onClick={() => setEditingAgent(undefined)}>Cancel</button></> : <button className="button button--text" type="button" onClick={() => setEditingAgent(agent.id)}>Edit</button>}</td></tr>)}</tbody></table></div>
      </section>}

      {activeTab === "pipeline" && canAdminBackend && <section className="admin-section" role="tabpanel">
        <div className="admin-section__head"><div><div className="ey">Project flow</div><h2 className="serif">Pipeline stages</h2></div><button className="button button--secondary" type="button" onClick={() => void loadPipeline()}>Refresh</button></div>
        {pipelineError && <div className="notice" role="alert">{pipelineError}</div>}{stageError && <div className="notice" role="alert">{stageError}</div>}
        <div className="admin-stage-list">{stages.map((stage) => <div className="admin-stage" key={stage.key}><div className="admin-stage__order">{stage.displayOrder}</div><div><strong>{stage.key.replace(/_/g, " ")}</strong><small>Stable stage key</small></div><label className="admin-field"><span>Label</span><input value={stage.label} onChange={(event) => setStages((current) => current.map((item) => item.key === stage.key ? { ...item, label: event.target.value } : item))} onBlur={() => void updateStage(stage.key, { label: stage.label })} /></label><label className="admin-toggle"><input type="checkbox" checked={stage.active} onChange={(event) => void updateStage(stage.key, { active: event.target.checked })} /><span>{stage.active ? "Active" : "Inactive"}</span></label></div>)}</div>
      </section>}

      {activeTab === "integrations" && canManageIntegrations && <section className="admin-section" role="tabpanel">
        <div className="admin-section__head"><div><div className="ey">Studio connections</div><h2 className="serif">Integrations</h2></div><button className="button button--secondary" type="button" onClick={() => void loadIntegrationsTab()} disabled={isLoadingIntegrations}>Refresh</button></div>
        {isLoadingIntegrations && <div className="empty" role="status"><span className="serif">Loading integrations.</span>Checking studio connections.</div>}
        {!isLoadingIntegrations && integrationsError && <div className="empty" role="alert"><span className="serif">Integrations are unavailable.</span>{integrationsError}<div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void loadIntegrationsTab()}>Try again</button></div></div>}
        {!isLoadingIntegrations && !integrationsError && <div className="integration-grid">{PROVIDERS.map((provider) => {
          const integration = integrations.find((item) => item.provider === provider);
          const status = provider === "tonomo" ? (tonomoHealth?.lastEventAt ? "connected" : "disconnected") : integration?.status ?? "not-configured";
          const title = provider === "dropbox" ? "Dropbox" : provider === "tonomo" ? "Tonomo" : "Vimeo";
          return <article className="integration-card" key={provider}><div className="integration-card__top"><div><div className="ey">{title}</div><h3 className="serif">{title}</h3></div><span className={`admin-status admin-status--${status}`}>{provider === "tonomo" ? tonomoHealth?.lastEventAt ? "Receiving" : "Awaiting first event" : statusLabel(status)}</span></div>{provider === "dropbox" ? <><p>{integration ? "Connect the studio Dropbox to sync RAW capture folders." : "No Dropbox connection has been configured for this studio."}</p>{integration?.lastError && <div className="notice admin-notice" role="alert">{integration.lastError}</div>}<dl className="integration-meta"><div><dt>Last event</dt><dd>{relativeTime(integration?.lastEventAt ?? null)}</dd></div>{integration?.expiresAt && <div><dt>Expires</dt><dd>{formatDate(integration.expiresAt)}</dd></div>}</dl>{dropboxNotice && <div className="notice admin-notice" role="alert">{dropboxNotice}</div>}<button className="button" type="button" onClick={() => void connectDropbox()} disabled={isConnectingDropbox}>{isConnectingDropbox ? "Opening Dropbox…" : integration?.status === "connected" ? "Reconnect Dropbox" : "Connect Dropbox"}</button></> : provider === "tonomo" ? <><p>Order deliveries are recorded and reconciled automatically.</p><dl className="integration-meta"><div><dt>Last event</dt><dd>{relativeTime(tonomoHealth?.lastEventAt ?? null)}</dd></div><div><dt>Processed</dt><dd>{tonomoHealth?.counts.processed ?? 0}</dd></div><div><dt>Received</dt><dd>{tonomoHealth?.counts.received ?? 0}</dd></div><div><dt>Poison</dt><dd>{tonomoHealth?.counts.poison ?? 0}</dd></div></dl></> : <><p>Configured in a later phase.</p><dl className="integration-meta"><div><dt>Last event</dt><dd>{relativeTime(integration?.lastEventAt ?? null)}</dd></div></dl></>}</article>;
        })}</div>}
        {!isLoadingIntegrations && !integrationsError && canAdminBackend && <div className="admin-poison"><div className="admin-section__head"><div><div className="ey">Operator queue</div><h2 className="serif">Failed Tonomo events</h2></div></div>{poisonEvents.length === 0 ? <div className="empty"><span className="serif">No failed events.</span>Tonomo orders are processing normally.</div> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Received</th><th>Order</th><th>Error reason</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{poisonEvents.map((event) => { const isOperating = operatingEventIds.has(event.id); return <tr key={event.id}><td data-label="Received">{formatDate(event.receivedAt)}</td><td data-label="Order">{event.summary ? <>{event.summary.street}<br /><small>{event.summary.orderId}</small></> : "Unparseable"}</td><td data-label="Error reason">{event.error || "—"}</td><td className="admin-table__action"><button className="button button--text" type="button" onClick={() => void viewPayload(event.id)}>View payload</button><button className="button button--secondary" type="button" disabled={isOperating} onClick={() => void operateEvent(event.id, "retry")}>Retry</button><button className="button button--text" type="button" disabled={isOperating} onClick={() => void operateEvent(event.id, "discard")}>Discard</button></td></tr>; })}</tbody></table></div>{poisonTotal > poisonEvents.length && <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void loadTonomo(poisonEvents.length, true)}>Load more</button></div>}</>}</div>}
        {!isLoadingIntegrations && !integrationsError && canAdminBackend && <div className="admin-poison"><div className="admin-section__head"><div><div className="ey">Operator queue</div><h2 className="serif">Rendition delivery failures</h2></div><span className={`admin-status admin-status--${renditionDlqOpenCount > 0 ? "error" : "active"}`}>{renditionDlqOpenCount > 0 ? `${renditionDlqOpenCount} stuck` : "No backlog"}</span></div>{renditionDlq.length === 0 ? <div className="empty"><span className="serif">No stuck renditions.</span>Preview generation is processing normally.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>First failed</th><th>Project</th><th>Asset</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{renditionDlq.map((event) => { const isOperating = operatingRenditionDlqIds.has(event.id); return <tr key={event.id}><td data-label="First failed">{formatDate(event.receivedAt)}</td><td data-label="Project">{event.street || "—"}</td><td data-label="Asset"><code>{event.assetId}</code></td><td className="admin-table__action"><button className="button button--secondary" type="button" disabled={isOperating} onClick={() => void operateRenditionDlqEvent(event.id, "replay")}>Replay</button><button className="button button--text" type="button" disabled={isOperating} onClick={() => void operateRenditionDlqEvent(event.id, "discard")}>Discard</button></td></tr>; })}</tbody></table></div>}</div>}
        {!isLoadingIntegrations && !integrationsError && canAdminBackend && <div className="admin-poison" aria-label="Notification delivery operations"><div className="admin-section__head"><div><div className="ey">Operator queue</div><h2 className="serif">Notification delivery</h2></div><button className="button button--secondary" type="button" onClick={() => void loadNotificationDeliveries(notificationDeliveryView)} disabled={isLoadingNotificationDeliveries}>Refresh</button></div><div className="admin-tabs" role="tablist" aria-label="Notification delivery filters">{(["pending_stuck", "dlq", "failed", "unknown"] as const).map((view) => <button key={view} className={`ctab ${notificationDeliveryView === view ? "is-active" : ""}`} type="button" role="tab" aria-selected={notificationDeliveryView === view} onClick={() => selectNotificationDeliveryView(view)}>{view === "pending_stuck" ? "Pending / stuck" : view.toUpperCase()} ({notificationDeliveryCounts[view]})</button>)}</div>{notificationDeliveriesError && <div className="notice" role="alert">{notificationDeliveriesError}</div>}{isLoadingNotificationDeliveries && <div className="empty" role="status"><span className="serif">Loading delivery status.</span>Reading the durable notification ledger.</div>}{!isLoadingNotificationDeliveries && !notificationDeliveriesError && notificationDeliveries.length === 0 && <div className="empty"><span className="serif">No matching deliveries.</span>This queue is clear.</div>}{!isLoadingNotificationDeliveries && notificationDeliveries.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Updated</th><th>Project</th><th>Recipient</th><th>Channels</th><th>State</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{notificationDeliveries.map((item) => { const isOperating = operatingNotificationIds.has(item.outboxId); return <tr key={item.outboxId}><td data-label="Updated">{formatDate(new Date(item.updatedAt).toISOString())}</td><td data-label="Project">{item.projectStreet || item.projectId || "—"}</td><td data-label="Recipient">{item.recipientName || "Unavailable"}</td><td data-label="Channels">{item.channels.map((channel) => `${channel.channel}: ${channel.status}`).join(" · ")}{item.unknownEmailPossible && <><br /><strong className="admin-warning">Duplicate email possible</strong></>}</td><td data-label="State">{item.status}{item.safeErrorCode && <><br /><small>{item.safeErrorCode}</small></>}</td><td className="admin-table__action"><button className="button button--secondary" type="button" disabled={isOperating} onClick={() => void operateNotificationDelivery(item, "replay")}>Replay</button><button className="button button--text" type="button" disabled={isOperating} onClick={() => void operateNotificationDelivery(item, "discard")}>Discard</button></td></tr>; })}</tbody></table></div>}{notificationDeliveryCursor && <div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" disabled={isLoadingNotificationDeliveries} onClick={() => void loadNotificationDeliveries(notificationDeliveryView, notificationDeliveryCursor, true)}>Load more</button></div>}</div>}
      </section>}
      {payload && <div className="admin-modal" role="dialog" aria-modal="true" aria-label="Tonomo event payload"><div className="admin-modal__panel"><div className="admin-section__head"><div><div className="ey">Webhook payload</div><h2 className="serif">Event details</h2></div><button className="button button--secondary" type="button" onClick={() => setPayload(undefined)}>Close</button></div><pre>{payload.json}</pre></div></div>}
      <div className="toasts" aria-live="polite">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
    </main>
  );
}
