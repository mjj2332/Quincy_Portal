import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ROLES, type Role } from "@quincy/shared";
import { ApiError, apiGet, apiPatch, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";

type AdminTab = "users" | "integrations";
type Toast = { id: number; message: string; tone: "success" | "error" };
type User = { id: string; name: string; email: string; role: Role; active: boolean; createdAt: string | null };
type IntegrationStatus = "connected" | "disconnected" | "expired" | "error";
type Integration = { provider: string; status: IntegrationStatus; expiresAt: string | null; lastEventAt: string | null; lastError: string | null };
type UsersResponse = { users: User[] };
type IntegrationsResponse = { integrations: Integration[] };

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
  const { can } = useCapabilities();
  const canManageUsers = can("manageUsers");
  const canManageIntegrations = can("manageIntegrations");
  const availableTabs: AdminTab[] = [
    ...(canManageUsers ? ["users" as const] : []),
    ...(canManageIntegrations ? ["integrations" as const] : []),
  ];
  const [activeTab, setActiveTab] = useState<AdminTab>(availableTabs[0] ?? "users");
  const [users, setUsers] = useState<User[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [usersError, setUsersError] = useState<string>();
  const [integrationsError, setIntegrationsError] = useState<string>();
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isLoadingIntegrations, setIsLoadingIntegrations] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [isConnectingDropbox, setIsConnectingDropbox] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string>();
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
      setUsers((await apiGet<UsersResponse>("/api/users")).users);
    } catch (reason) {
      setUsersError(reason instanceof Error ? reason.message : "Users could not be loaded.");
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

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

  useEffect(() => {
    if (activeTab === "users" && canManageUsers) void loadUsers();
    if (activeTab === "integrations" && canManageIntegrations) void loadIntegrations();
  }, [activeTab, canManageIntegrations, canManageUsers, loadIntegrations, loadUsers]);

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

  async function updateUser(user: User, patch: { role?: Role; active?: boolean }) {
    setUpdatingUserId(user.id);
    try {
      await apiPatch<{ ok: true }, typeof patch>(`/api/users/${user.id}`, patch);
      await loadUsers();
      toast(patch.active === false ? `${user.name} has been deactivated and signed out everywhere.` : patch.active === true ? `${user.name} has been reactivated.` : "Role updated.");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The user could not be updated.", "error");
    } finally {
      setUpdatingUserId(undefined);
    }
  }

  function toggleActive(user: User) {
    const action = user.active ? "deactivate" : "reactivate";
    const detail = user.active ? " This signs them out everywhere immediately." : "";
    if (window.confirm(`Are you sure you want to ${action} ${user.name}?${detail}`)) void updateUser(user, { active: !user.active });
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
        {availableTabs.map((tab) => <button key={tab} className={`ctab ${activeTab === tab ? "is-active" : ""}`} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>{tab === "users" ? "Users" : "Integrations"}</button>)}
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
        {!isLoadingUsers && !usersError && users.length === 0 && <div className="empty"><span className="serif">No users provisioned.</span>Provision a team member to give them closed-access Google sign-in.</div>}
        {!isLoadingUsers && !usersError && users.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{users.map((user) => {
          const isSelf = user.id === currentUserId;
          const isUpdating = updatingUserId === user.id;
          return <tr key={user.id}><td data-label="Name"><strong>{user.name}</strong></td><td data-label="Email">{user.email}</td><td data-label="Role"><label className="sr-only" htmlFor={`role-${user.id}`}>Role for {user.name}</label><select id={`role-${user.id}`} className="admin-role-select" value={user.role} disabled={isUpdating} onChange={(event) => void updateUser(user, { role: event.target.value as Role })}>{ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></td><td data-label="Access"><span className={`admin-status admin-status--${user.active ? "active" : "inactive"}`}>{user.active ? "Active" : "Inactive"}</span></td><td data-label="Created">{formatDate(user.createdAt)}</td><td className="admin-table__action"><button className="button button--secondary" type="button" disabled={isUpdating || isSelf} title={isSelf ? "You cannot deactivate your own account." : undefined} onClick={() => toggleActive(user)}>{user.active ? "Deactivate" : "Reactivate"}</button></td></tr>;
        })}</tbody></table></div>}
      </section>}

      {activeTab === "integrations" && canManageIntegrations && <section className="admin-section" role="tabpanel">
        <div className="admin-section__head"><div><div className="ey">Studio connections</div><h2 className="serif">Integrations</h2></div><button className="button button--secondary" type="button" onClick={() => void loadIntegrations()} disabled={isLoadingIntegrations}>Refresh</button></div>
        {isLoadingIntegrations && <div className="empty" role="status"><span className="serif">Loading integrations.</span>Checking studio connections.</div>}
        {!isLoadingIntegrations && integrationsError && <div className="empty" role="alert"><span className="serif">Integrations are unavailable.</span>{integrationsError}<div style={{ marginTop: 16 }}><button className="button button--secondary" type="button" onClick={() => void loadIntegrations()}>Try again</button></div></div>}
        {!isLoadingIntegrations && !integrationsError && <div className="integration-grid">{PROVIDERS.map((provider) => {
          const integration = integrations.find((item) => item.provider === provider);
          const status = integration?.status ?? "not-configured";
          const title = provider === "dropbox" ? "Dropbox" : provider === "tonomo" ? "Tonomo" : "Vimeo";
          return <article className="integration-card" key={provider}><div className="integration-card__top"><div><div className="ey">{title}</div><h3 className="serif">{title}</h3></div><span className={`admin-status admin-status--${status}`}>{statusLabel(status)}</span></div>{provider === "dropbox" ? <><p>{integration ? "Connect the studio Dropbox to sync RAW capture folders." : "No Dropbox connection has been configured for this studio."}</p>{integration?.lastError && <div className="notice admin-notice" role="alert">{integration.lastError}</div>}<dl className="integration-meta"><div><dt>Last event</dt><dd>{relativeTime(integration?.lastEventAt ?? null)}</dd></div>{integration?.expiresAt && <div><dt>Expires</dt><dd>{formatDate(integration.expiresAt)}</dd></div>}</dl>{dropboxNotice && <div className="notice admin-notice" role="alert">{dropboxNotice}</div>}<button className="button" type="button" onClick={() => void connectDropbox()} disabled={isConnectingDropbox}>{isConnectingDropbox ? "Opening Dropbox…" : integration?.status === "connected" ? "Reconnect Dropbox" : "Connect Dropbox"}</button></> : <><p>Configured in a later phase.</p><dl className="integration-meta"><div><dt>Last event</dt><dd>{relativeTime(integration?.lastEventAt ?? null)}</dd></div></dl></>}</article>;
        })}</div>}
      </section>}
      <div className="toasts" aria-live="polite">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
    </main>
  );
}
