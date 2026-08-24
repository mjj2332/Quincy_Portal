import { useCallback, useEffect, useState } from "react";
import type { CollectionKind, Role } from "@quincy/shared";
import { apiGet } from "../lib/api";
import { FieldGroup } from "@/components/ui/field";
import { QuincyField } from "@/components/quincy/QuincyField";

export type User = { id: string; name: string; email: string; role: Role; active: boolean };
export type ProjectForm = {
  street: string; suburb: string; postcode: string; agencyName: string; agentName: string; agentEmail: string; agentPhone: string;
  shootDate: string; timeWindow: string; orderNo: string; orderId: string; invoiceAmount: string; paymentStatus: string; notes: string;
  rawFolderLink: string; rawFolderPath: string; orderedServices: Exclude<CollectionKind, "raw">[]; photographerUserIds: string[]; editorUserIds: string[];
};
export type ProjectTextField = Exclude<keyof ProjectForm, "orderedServices" | "photographerUserIds" | "editorUserIds">;
export type ProjectSelectionField = "orderedServices" | "photographerUserIds" | "editorUserIds";
export type ProjectFieldError = "agentEmail" | "rawFolderLink" | "invoiceAmount";
export type ProjectFieldsMode = "create" | "edit";

type UsersResponse = { users: User[] };
type Service = { kind: Exclude<CollectionKind, "raw">; label: string };

export const SERVICES: Service[] = [
  { kind: "edited", label: "Edited photography" },
  { kind: "video", label: "Video" },
  { kind: "floorplan", label: "Floorplan" },
  { kind: "copy", label: "Copywriting" },
];

export const emptyProjectForm: ProjectForm = {
  street: "", suburb: "", postcode: "", agencyName: "", agentName: "", agentEmail: "", agentPhone: "",
  shootDate: "", timeWindow: "", orderNo: "", orderId: "", invoiceAmount: "", paymentStatus: "", notes: "",
  rawFolderLink: "", rawFolderPath: "", orderedServices: [], photographerUserIds: [], editorUserIds: [],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUrl(value: string): boolean {
  try { new URL(value); return true; } catch { return false; }
}

function userName(user: User): string { return user.name || user.email; }

export function projectFieldsPolicy(mode: ProjectFieldsMode = "create") {
  const readOnly = mode === "edit";
  return { servicesReadOnly: readOnly, orderReadOnly: readOnly, notesReadOnly: readOnly, showInvoiceAndPayment: !readOnly };
}

export function validateProjectFields(form: ProjectForm, mode: ProjectFieldsMode = "create"): Partial<Record<ProjectFieldError, string>> {
  const invoiceAmount = form.invoiceAmount.trim();
  return {
    agentEmail: form.agentEmail.trim() && !EMAIL_PATTERN.test(form.agentEmail.trim()) ? "Enter a valid email address." : undefined,
    rawFolderLink: form.rawFolderLink.trim() && !isUrl(form.rawFolderLink.trim()) ? "Enter a valid URL." : undefined,
    invoiceAmount: mode === "create" && invoiceAmount && !Number.isFinite(Number(invoiceAmount)) ? "Enter a numeric invoice amount." : undefined,
  };
}

export function ProjectFields({ form, errors, existingCollections = [], mode = "create", onChange, onToggle }: {
  form: ProjectForm;
  errors: Partial<Record<ProjectFieldError, string>>;
  existingCollections?: CollectionKind[];
  mode?: ProjectFieldsMode;
  onChange: (field: ProjectTextField, value: string) => void;
  onToggle: (field: ProjectSelectionField, value: string) => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [usersError, setUsersError] = useState<string>();
  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true); setUsersError(undefined);
    try { setUsers((await apiGet<UsersResponse>("/api/users")).users); }
    catch (reason) { setUsersError(reason instanceof Error ? reason.message : "Team members could not be loaded."); }
    finally { setIsLoadingUsers(false); }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  const photographers = users.filter((user) => (user.role === "photographer" || user.role === "editor" || user.role === "admin") && (user.active || form.photographerUserIds.includes(user.id)));
  const editors = users.filter((user) => (user.role === "editor" || user.role === "admin") && (user.active || form.editorUserIds.includes(user.id)));
  const collectionExists = (kind: CollectionKind) => existingCollections.includes(kind);
  const policy = projectFieldsPolicy(mode);

  return <>
    <section className="create-project__section" aria-labelledby="client-heading">
      <div className="create-project__section-head"><div className="ey">Client</div><h2 className="serif" id="client-heading">Who is it for?</h2></div>
      <FieldGroup className="[&]:grid grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-4 gap-[var(--space-4)]">
        <QuincyField id="project-agency-name" label="Agency" value={form.agencyName} onChange={(event) => onChange("agencyName", event.target.value)} />
        <QuincyField id="project-agent-name" label="Agent" value={form.agentName} onChange={(event) => onChange("agentName", event.target.value)} />
        <QuincyField id="project-agent-email" label="Agent email" type="email" value={form.agentEmail} onChange={(event) => onChange("agentEmail", event.target.value)} aria-invalid={Boolean(errors.agentEmail)} error={errors.agentEmail} />
        <QuincyField id="project-agent-phone" label="Agent phone" type="tel" value={form.agentPhone} onChange={(event) => onChange("agentPhone", event.target.value)} />
      </FieldGroup>
    </section>
    <section className="create-project__section" aria-labelledby="shoot-heading">
      <div className="create-project__section-head"><div className="ey">Shoot</div><h2 className="serif" id="shoot-heading">When is it happening?</h2></div>
      <div className="create-project__fields create-project__fields--two"><label className="admin-field"><span>Shoot date</span><input type="date" value={form.shootDate} onChange={(event) => onChange("shootDate", event.target.value)} /></label><label className="admin-field"><span>Time window</span><input placeholder="e.g. 9:00–11:00 am" value={form.timeWindow} onChange={(event) => onChange("timeWindow", event.target.value)} /></label></div>
    </section>
    <section className={`create-project__section ${policy.orderReadOnly ? "project-fields__section--readonly" : ""}`} aria-labelledby="order-heading">
      <div className="create-project__section-head"><div className="ey">Order</div><h2 className="serif" id="order-heading">How is it tracked?</h2>{policy.orderReadOnly && <p className="project-fields__readonly-note">Order details are managed by the order system and are available here to copy.</p>}</div>
      <div className="create-project__fields"><label className="admin-field"><span>Order number</span><input value={form.orderNo} readOnly={policy.orderReadOnly} onChange={policy.orderReadOnly ? undefined : (event) => onChange("orderNo", event.target.value)} /></label><label className="admin-field"><span>Order ID</span><input value={form.orderId} readOnly={policy.orderReadOnly} onChange={policy.orderReadOnly ? undefined : (event) => onChange("orderId", event.target.value)} /></label>{policy.showInvoiceAndPayment && <><label className="admin-field"><span>Invoice amount</span><input type="number" step="any" inputMode="decimal" value={form.invoiceAmount} onChange={(event) => onChange("invoiceAmount", event.target.value)} aria-invalid={Boolean(errors.invoiceAmount)} />{errors.invoiceAmount && <small>{errors.invoiceAmount}</small>}</label><label className="admin-field"><span>Payment status</span><input value={form.paymentStatus} onChange={(event) => onChange("paymentStatus", event.target.value)} /></label></>}</div>
    </section>
    <section className={`create-project__section ${policy.servicesReadOnly ? "project-fields__section--readonly" : ""}`} aria-labelledby="services-heading">
      <div className="create-project__section-head"><div className="ey">Services</div><h2 className="serif" id="services-heading">What is being delivered?</h2>{policy.servicesReadOnly && <p className="project-fields__readonly-note">Services are fixed after a project is created.</p>}</div>
      <div className="create-project__checks" role="group" aria-labelledby="services-heading">
        <label className="create-project__check"><input type="checkbox" checked disabled /><span><strong>RAW</strong><small>{collectionExists("raw") ? "Already created" : "Always included"}</small></span></label>
        {SERVICES.map((service) => <label className="create-project__check" key={service.kind}><input type="checkbox" checked={form.orderedServices.includes(service.kind)} disabled={policy.servicesReadOnly} onChange={policy.servicesReadOnly ? undefined : () => onToggle("orderedServices", service.kind)} /><span>{service.label}</span></label>)}
      </div>
    </section>
    <section className="create-project__section" aria-labelledby="dropbox-heading">
      <div className="create-project__section-head"><div className="ey">Dropbox</div><h2 className="serif" id="dropbox-heading">Where will the RAW files land?</h2></div>
      <div className="create-project__fields create-project__fields--two"><label className="admin-field"><span>RAW folder link</span><input type="url" placeholder="https://www.dropbox.com/..." value={form.rawFolderLink} onChange={(event) => onChange("rawFolderLink", event.target.value)} aria-invalid={Boolean(errors.rawFolderLink)} />{errors.rawFolderLink && <small>{errors.rawFolderLink}</small>}</label><label className="admin-field"><span>RAW folder path</span><input placeholder="/Shoots/Property name" value={form.rawFolderPath} onChange={(event) => onChange("rawFolderPath", event.target.value)} /></label></div>
    </section>
    <section className="create-project__section" aria-labelledby="team-heading">
      <div className="create-project__section-head"><div className="ey">Team</div><h2 className="serif" id="team-heading">Who is assigned?</h2></div>
      {isLoadingUsers && <div className="create-project__team-state" role="status">Loading available team members…</div>}
      {!isLoadingUsers && usersError && <div className="notice" role="alert">{usersError}<div style={{ marginTop: 12 }}><button className="button button--secondary" type="button" onClick={() => void loadUsers()}>Try again</button></div></div>}
      {!isLoadingUsers && !usersError && <div className="create-project__team"><div><div className="ey">Photographers</div><div className="create-project__checklist">{photographers.length ? photographers.map((user) => <label className="create-project__check" key={user.id}><input type="checkbox" checked={form.photographerUserIds.includes(user.id)} onChange={() => onToggle("photographerUserIds", user.id)} /><span><strong>{userName(user)}</strong><small>{user.email}{user.role === "admin" && " · admin"}{user.role === "editor" && " · editor"}</small></span></label>) : <p>No active photographers are provisioned.</p>}</div></div><div><div className="ey">Editors</div><div className="create-project__checklist">{editors.length ? editors.map((user) => <label className="create-project__check" key={user.id}><input type="checkbox" checked={form.editorUserIds.includes(user.id)} onChange={() => onToggle("editorUserIds", user.id)} /><span><strong>{userName(user)}</strong><small>{user.email}{user.role === "admin" && " · admin"}</small></span></label>) : <p>No active editors are provisioned.</p>}</div></div></div>}
    </section>
    <section className={`create-project__section ${policy.notesReadOnly ? "project-fields__section--readonly" : ""}`} aria-labelledby="notes-heading">
      <div className="create-project__section-head"><div className="ey">Notes</div><h2 className="serif" id="notes-heading">Anything the team should know?</h2>{policy.notesReadOnly && <p className="project-fields__readonly-note">Notes are retained from the original order.</p>}</div>
      <label className="admin-field"><span>Production notes</span><textarea rows={5} value={form.notes} readOnly={policy.notesReadOnly} onChange={policy.notesReadOnly ? undefined : (event) => onChange("notes", event.target.value)} /></label>
    </section>
  </>;
}
