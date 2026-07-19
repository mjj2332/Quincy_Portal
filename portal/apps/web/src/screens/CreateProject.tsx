import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CollectionKind, Role } from "@quincy/shared";
import { apiGet, apiPost } from "../lib/api";

type User = { id: string; name: string; email: string; role: Role; active: boolean };
type UsersResponse = { users: User[] };
type ProjectDetail = { id: string; collections: Array<{ id: string; kind: CollectionKind }>; members: Array<{ id: string }> };
type FormErrors = Partial<Record<"street" | "agentEmail" | "rawFolderLink" | "invoiceAmount", string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICES: Array<{ kind: Exclude<CollectionKind, "raw">; label: string }> = [
  { kind: "edited", label: "Edited photography" },
  { kind: "video", label: "Video" },
  { kind: "floorplan", label: "Floorplan" },
  { kind: "copy", label: "Copywriting" },
];

function optionalValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function userName(user: User): string {
  return user.name || user.email;
}

export function CreateProject({ onCancel, onOpenProject }: { onCancel: () => void; onOpenProject: (projectId: string, notice?: string) => void }) {
  const [form, setForm] = useState({
    street: "", suburb: "", postcode: "", agencyName: "", agentName: "", agentEmail: "", agentPhone: "",
    shootDate: "", timeWindow: "", orderNo: "", orderId: "", invoiceAmount: "", paymentStatus: "", notes: "",
    rawFolderLink: "", rawFolderPath: "", orderedServices: [] as Exclude<CollectionKind, "raw">[], photographerUserIds: [] as string[], editorUserIds: [] as string[],
  });
  const [users, setUsers] = useState<User[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [usersError, setUsersError] = useState<string>();
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    setUsersError(undefined);
    try {
      setUsers((await apiGet<UsersResponse>("/api/users")).users.filter((user) => user.active));
    } catch (reason) {
      setUsersError(reason instanceof Error ? reason.message : "Team members could not be loaded.");
    } finally {
      setIsLoadingUsers(false);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  function updateField(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    if (field === "street" || field === "agentEmail" || field === "rawFolderLink" || field === "invoiceAmount") {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
    setSubmitError(undefined);
  }

  function toggleValue(field: "orderedServices" | "photographerUserIds" | "editorUserIds", value: string) {
    setForm((current) => {
      const values = current[field] as string[];
      return { ...current, [field]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] };
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invoiceAmount = form.invoiceAmount.trim();
    const nextErrors: FormErrors = {
      street: form.street.trim() ? undefined : "Enter the property street address.",
      agentEmail: form.agentEmail.trim() && !EMAIL_PATTERN.test(form.agentEmail.trim()) ? "Enter a valid email address." : undefined,
      rawFolderLink: form.rawFolderLink.trim() && !isUrl(form.rawFolderLink.trim()) ? "Enter a valid URL." : undefined,
      invoiceAmount: invoiceAmount && !Number.isFinite(Number(invoiceAmount)) ? "Enter a numeric invoice amount." : undefined,
    };
    setErrors(nextErrors);
    setSubmitError(undefined);
    if (Object.values(nextErrors).some(Boolean)) return;

    setIsSubmitting(true);
    try {
      const project = await apiPost<ProjectDetail, Record<string, unknown>>("/api/projects", {
        street: form.street.trim(),
        suburb: optionalValue(form.suburb),
        postcode: optionalValue(form.postcode),
        agencyName: optionalValue(form.agencyName),
        agentName: optionalValue(form.agentName),
        agentEmail: optionalValue(form.agentEmail),
        agentPhone: optionalValue(form.agentPhone),
        shootDate: optionalValue(form.shootDate),
        timeWindow: optionalValue(form.timeWindow),
        orderNo: optionalValue(form.orderNo),
        orderId: optionalValue(form.orderId),
        invoiceAmount: invoiceAmount ? Number(invoiceAmount) : null,
        paymentStatus: optionalValue(form.paymentStatus),
        notes: optionalValue(form.notes),
        rawFolderLink: optionalValue(form.rawFolderLink),
        rawFolderPath: optionalValue(form.rawFolderPath),
        orderedServices: form.orderedServices,
        photographerUserIds: form.photographerUserIds,
        editorUserIds: form.editorUserIds,
      });
      onOpenProject(project.id, "Shoot created.");
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "The shoot could not be created.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const photographers = users.filter((user) => user.role === "photographer");
  const editors = users.filter((user) => user.role === "editor");

  return <main className="page create-project">
    <div className="pagehead">
      <div><div className="ey" style={{ marginBottom: 14 }}>Production desk</div><h1 className="serif">New shoot</h1></div>
      <button className="button button--secondary" type="button" onClick={onCancel}>Cancel</button>
    </div>

    <form className="create-project__form" onSubmit={(event) => void submit(event)} noValidate>
      {submitError && <div className="notice" role="alert">{submitError}</div>}

      <section className="create-project__section" aria-labelledby="property-heading">
        <div className="create-project__section-head"><div className="ey">01 · Property</div><h2 className="serif" id="property-heading">Where is the shoot?</h2></div>
        <div className="create-project__fields create-project__fields--property">
          <label className="admin-field create-project__field--wide"><span>Street *</span><input required value={form.street} onChange={(event) => updateField("street", event.target.value)} aria-invalid={Boolean(errors.street)} />{errors.street && <small>{errors.street}</small>}</label>
          <label className="admin-field"><span>Suburb</span><input value={form.suburb} onChange={(event) => updateField("suburb", event.target.value)} /></label>
          <label className="admin-field"><span>Postcode</span><input inputMode="numeric" value={form.postcode} onChange={(event) => updateField("postcode", event.target.value)} /></label>
        </div>
      </section>

      <section className="create-project__section" aria-labelledby="client-heading">
        <div className="create-project__section-head"><div className="ey">02 · Client</div><h2 className="serif" id="client-heading">Who is it for?</h2></div>
        <div className="create-project__fields">
          <label className="admin-field"><span>Agency</span><input value={form.agencyName} onChange={(event) => updateField("agencyName", event.target.value)} /></label>
          <label className="admin-field"><span>Agent</span><input value={form.agentName} onChange={(event) => updateField("agentName", event.target.value)} /></label>
          <label className="admin-field"><span>Agent email</span><input type="email" value={form.agentEmail} onChange={(event) => updateField("agentEmail", event.target.value)} aria-invalid={Boolean(errors.agentEmail)} />{errors.agentEmail && <small>{errors.agentEmail}</small>}</label>
          <label className="admin-field"><span>Agent phone</span><input type="tel" value={form.agentPhone} onChange={(event) => updateField("agentPhone", event.target.value)} /></label>
        </div>
      </section>

      <section className="create-project__section" aria-labelledby="shoot-heading">
        <div className="create-project__section-head"><div className="ey">03 · Shoot</div><h2 className="serif" id="shoot-heading">When is it happening?</h2></div>
        <div className="create-project__fields create-project__fields--two"><label className="admin-field"><span>Shoot date</span><input type="date" value={form.shootDate} onChange={(event) => updateField("shootDate", event.target.value)} /></label><label className="admin-field"><span>Time window</span><input placeholder="e.g. 9:00–11:00 am" value={form.timeWindow} onChange={(event) => updateField("timeWindow", event.target.value)} /></label></div>
      </section>

      <section className="create-project__section" aria-labelledby="order-heading">
        <div className="create-project__section-head"><div className="ey">04 · Order</div><h2 className="serif" id="order-heading">How is it tracked?</h2></div>
        <div className="create-project__fields">
          <label className="admin-field"><span>Order number</span><input value={form.orderNo} onChange={(event) => updateField("orderNo", event.target.value)} /></label>
          <label className="admin-field"><span>Order ID</span><input value={form.orderId} onChange={(event) => updateField("orderId", event.target.value)} /></label>
          <label className="admin-field"><span>Invoice amount</span><input type="number" step="any" inputMode="decimal" value={form.invoiceAmount} onChange={(event) => updateField("invoiceAmount", event.target.value)} aria-invalid={Boolean(errors.invoiceAmount)} />{errors.invoiceAmount && <small>{errors.invoiceAmount}</small>}</label>
          <label className="admin-field"><span>Payment status</span><input value={form.paymentStatus} onChange={(event) => updateField("paymentStatus", event.target.value)} /></label>
        </div>
      </section>

      <section className="create-project__section" aria-labelledby="services-heading">
        <div className="create-project__section-head"><div className="ey">05 · Services</div><h2 className="serif" id="services-heading">What is being delivered?</h2></div>
        <div className="create-project__checks" role="group" aria-labelledby="services-heading">
          <label className="create-project__check"><input type="checkbox" checked disabled /><span><strong>RAW</strong><small>Always included</small></span></label>
          {SERVICES.map((service) => <label className="create-project__check" key={service.kind}><input type="checkbox" checked={form.orderedServices.includes(service.kind)} onChange={() => toggleValue("orderedServices", service.kind)} /><span>{service.label}</span></label>)}
        </div>
      </section>

      <section className="create-project__section" aria-labelledby="dropbox-heading">
        <div className="create-project__section-head"><div className="ey">06 · Dropbox</div><h2 className="serif" id="dropbox-heading">Where will the RAW files land?</h2></div>
        <div className="create-project__fields create-project__fields--two"><label className="admin-field"><span>RAW folder link</span><input type="url" placeholder="https://www.dropbox.com/..." value={form.rawFolderLink} onChange={(event) => updateField("rawFolderLink", event.target.value)} aria-invalid={Boolean(errors.rawFolderLink)} />{errors.rawFolderLink && <small>{errors.rawFolderLink}</small>}</label><label className="admin-field"><span>RAW folder path</span><input placeholder="/Shoots/Property name" value={form.rawFolderPath} onChange={(event) => updateField("rawFolderPath", event.target.value)} /></label></div>
      </section>

      <section className="create-project__section" aria-labelledby="team-heading">
        <div className="create-project__section-head"><div className="ey">07 · Team</div><h2 className="serif" id="team-heading">Who is assigned?</h2></div>
        {isLoadingUsers && <div className="create-project__team-state" role="status">Loading available team members…</div>}
        {!isLoadingUsers && usersError && <div className="notice" role="alert">{usersError}<div style={{ marginTop: 12 }}><button className="button button--secondary" type="button" onClick={() => void loadUsers()}>Try again</button></div></div>}
        {!isLoadingUsers && !usersError && <div className="create-project__team"><div><div className="ey">Photographers</div><div className="create-project__checklist">{photographers.length ? photographers.map((user) => <label className="create-project__check" key={user.id}><input type="checkbox" checked={form.photographerUserIds.includes(user.id)} onChange={() => toggleValue("photographerUserIds", user.id)} /><span><strong>{userName(user)}</strong><small>{user.email}</small></span></label>) : <p>No active photographers are provisioned.</p>}</div></div><div><div className="ey">Editors</div><div className="create-project__checklist">{editors.length ? editors.map((user) => <label className="create-project__check" key={user.id}><input type="checkbox" checked={form.editorUserIds.includes(user.id)} onChange={() => toggleValue("editorUserIds", user.id)} /><span><strong>{userName(user)}</strong><small>{user.email}</small></span></label>) : <p>No active editors are provisioned.</p>}</div></div></div>}
      </section>

      <section className="create-project__section" aria-labelledby="notes-heading">
        <div className="create-project__section-head"><div className="ey">08 · Notes</div><h2 className="serif" id="notes-heading">Anything the team should know?</h2></div>
        <label className="admin-field"><span>Production notes</span><textarea rows={5} value={form.notes} onChange={(event) => updateField("notes", event.target.value)} /></label>
      </section>

      <div className="create-project__actions"><button className="button button--secondary" type="button" onClick={onCancel} disabled={isSubmitting}>Cancel</button><button className="button" type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating shoot…" : "Create shoot"}</button></div>
    </form>
  </main>;
}
