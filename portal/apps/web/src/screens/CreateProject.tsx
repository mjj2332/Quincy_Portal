import { useState, type FormEvent } from "react";
import type { CollectionKind } from "@quincy/shared";
import { ProjectFields, emptyProjectForm, type ProjectFieldError, type ProjectForm, type ProjectSelectionField, type ProjectTextField, validateProjectFields } from "../components/ProjectFields";
import { apiPost } from "../lib/api";
import { InternalLink } from "../components/InternalLink";

type ProjectDetail = { id: string; collections: Array<{ id: string; kind: CollectionKind }>; members: Array<{ id: string }> };
type FormErrors = Partial<Record<"street" | ProjectFieldError, string>>;

function optionalValue(value: string): string | null { return value.trim() || null; }

export function CreateProject({ onNavigate }: { onNavigate: (path: string, notice?: string) => void }) {
  const [form, setForm] = useState<ProjectForm>(emptyProjectForm);
  const [showDetails, setShowDetails] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField(field: ProjectTextField, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    if (field === "street" || field === "agentEmail" || field === "rawFolderLink" || field === "invoiceAmount") setErrors((current) => ({ ...current, [field]: undefined }));
    setSubmitError(undefined);
  }

  function toggleValue(field: ProjectSelectionField, value: string) {
    setForm((current) => { const values = current[field] as string[]; return { ...current, [field]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] }; });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FormErrors = { street: form.street.trim() ? undefined : "Enter the property street address.", ...validateProjectFields(form) };
    setErrors(nextErrors); setSubmitError(undefined);
    if (Object.values(nextErrors).some(Boolean)) return;
    setIsSubmitting(true);
    try {
      const invoiceAmount = form.invoiceAmount.trim();
      const project = await apiPost<ProjectDetail, Record<string, unknown>>("/api/projects", {
        street: form.street.trim(), suburb: optionalValue(form.suburb), postcode: optionalValue(form.postcode), agencyName: optionalValue(form.agencyName), agentName: optionalValue(form.agentName), agentEmail: optionalValue(form.agentEmail), agentPhone: optionalValue(form.agentPhone), shootDate: optionalValue(form.shootDate), timeWindow: optionalValue(form.timeWindow), orderNo: optionalValue(form.orderNo), orderId: optionalValue(form.orderId), invoiceAmount: invoiceAmount ? Number(invoiceAmount) : null, paymentStatus: optionalValue(form.paymentStatus), productionNotes: optionalValue(form.productionNotes), rawFolderLink: optionalValue(form.rawFolderLink), rawFolderPath: optionalValue(form.rawFolderPath), orderedServices: form.orderedServices, photographerUserIds: form.photographerUserIds, editorUserIds: form.editorUserIds,
      });
      onNavigate(`/projects/${encodeURIComponent(project.id)}`, "Shoot created.");
    } catch (reason) { setSubmitError(reason instanceof Error ? reason.message : "The shoot could not be created."); }
    finally { setIsSubmitting(false); }
  }

  return <main className="page create-project">
    <div className="pagehead"><div><div className="ey" style={{ marginBottom: 14 }}>Production desk</div><h1 className="serif">New shoot</h1></div><InternalLink className="button button--secondary" to="/">Cancel</InternalLink></div>
    <form className="create-project__form" onSubmit={(event) => void submit(event)} noValidate>
      {submitError && <div className="notice" role="alert">{submitError}</div>}
      <section className="create-project__hero" aria-labelledby="property-heading">
        <div className="ey">Start with the address</div><h2 className="serif" id="property-heading">Where is the shoot?</h2>
        <div className="create-project__hero-action"><label className="create-project__address"><span className="sr-only">Street address</span><input autoFocus required placeholder="12 Kings Road, Vaucluse" value={form.street} onChange={(event) => updateField("street", event.target.value)} aria-invalid={Boolean(errors.street)} /></label><button className="button" type="submit" disabled={isSubmitting || !form.street.trim()}>{isSubmitting ? "Creating shoot…" : "Create shoot"}</button></div>
        {errors.street && <small className="create-project__hero-error">{errors.street}</small>}
        <div className="create-project__refinements"><label className="admin-field"><span>Suburb <em>optional</em></span><input value={form.suburb} onChange={(event) => updateField("suburb", event.target.value)} /></label><label className="admin-field"><span>Postcode <em>optional</em></span><input inputMode="numeric" value={form.postcode} onChange={(event) => updateField("postcode", event.target.value)} /></label></div>
        <p>You can fill in everything else later from the shoot&apos;s workspace.</p>
      </section>
      <details className="create-project__details" open={showDetails} onToggle={(event) => setShowDetails(event.currentTarget.open)}><summary>Add details now <span>(optional)</span></summary><div className="create-project__detail-content"><ProjectFields form={form} errors={errors} onChange={updateField} onToggle={toggleValue} /><div className="create-project__actions"><InternalLink className="button button--secondary" to="/" aria-disabled={isSubmitting}>Cancel</InternalLink><button className="button" type="submit" disabled={isSubmitting || !form.street.trim()}>{isSubmitting ? "Creating shoot…" : "Create shoot"}</button></div></div></details>
    </form>
  </main>;
}
