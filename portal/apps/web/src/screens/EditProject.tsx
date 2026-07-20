import { useEffect, useState, type FormEvent } from "react";
import type { CollectionKind } from "@quincy/shared";
import { ProjectFields, emptyProjectForm, type ProjectFieldError, type ProjectForm, type ProjectSelectionField, type ProjectTextField, validateProjectFields } from "../components/ProjectFields";
import { ApiError, apiGet, apiPatch } from "../lib/api";

type ProjectResponse = {
  id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null; agentEmail: string | null; agentPhone: string | null;
  shootDate: string | null; timeWindow: string | null; orderNo: string | null; orderId: string | null; invoiceAmount: number | null; paymentStatus: string | null; notes: string | null; rawFolderLink: string | null; rawFolderPath: string | null;
  collections: Array<{ id: string; kind: CollectionKind }>; members: Array<{ userId: string; roleOnProject: "photographer" | "editor" }>;
};
type FormErrors = Partial<Record<"street" | ProjectFieldError, string>>;
type ServiceRemovalBlock = { kind: CollectionKind; assetCount: number; manifestCount?: number };

function fieldValue(value: string | number | null): string { return value === null ? "" : String(value); }
function optionalValue(value: string): string | null { return value.trim() || null; }
function serviceLabel(kind: CollectionKind): string { return kind === "raw" ? "RAW" : kind.charAt(0).toUpperCase() + kind.slice(1); }

function blockedServiceMessage(reason: unknown): string | undefined {
  if (!(reason instanceof ApiError) || reason.status !== 409 || !reason.details || typeof reason.details !== "object") return undefined;
  const blocked = (reason.details as { blocked?: unknown }).blocked;
  if (!Array.isArray(blocked) || !blocked.length) return undefined;
  const details = blocked.filter((item): item is ServiceRemovalBlock => Boolean(item) && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string" && typeof (item as { assetCount?: unknown }).assetCount === "number")
    .map((item) => {
      const parts = [item.assetCount > 0 ? `${item.assetCount} asset${item.assetCount === 1 ? "" : "s"}` : null, (item.manifestCount ?? 0) > 0 ? `${item.manifestCount} pending upload${item.manifestCount === 1 ? "" : "s"}` : null].filter(Boolean);
      return `${serviceLabel(item.kind)} (${parts.join(", ") || "received media"})`;
    });
  return details.length ? `Can’t remove ${details.join(", ")}: media has been received or is being uploaded.` : undefined;
}

function formFromProject(project: ProjectResponse): ProjectForm {
  return {
    street: project.street, suburb: fieldValue(project.suburb), postcode: fieldValue(project.postcode), agencyName: fieldValue(project.agencyName), agentName: fieldValue(project.agentName), agentEmail: fieldValue(project.agentEmail), agentPhone: fieldValue(project.agentPhone), shootDate: fieldValue(project.shootDate), timeWindow: fieldValue(project.timeWindow), orderNo: fieldValue(project.orderNo), orderId: fieldValue(project.orderId), invoiceAmount: fieldValue(project.invoiceAmount), paymentStatus: fieldValue(project.paymentStatus), notes: fieldValue(project.notes), rawFolderLink: fieldValue(project.rawFolderLink), rawFolderPath: fieldValue(project.rawFolderPath), orderedServices: project.collections.flatMap((collection) => collection.kind === "raw" ? [] : [collection.kind]), photographerUserIds: project.members.filter((member) => member.roleOnProject === "photographer").map((member) => member.userId), editorUserIds: project.members.filter((member) => member.roleOnProject === "editor").map((member) => member.userId),
  };
}

export function EditProject({ projectId, onCancel, onSaved }: { projectId: string; onCancel: () => void; onSaved: (notice: string) => void }) {
  const [project, setProject] = useState<ProjectResponse>();
  const [form, setForm] = useState<ProjectForm>(emptyProjectForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [loadError, setLoadError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadError(undefined);
    void apiGet<ProjectResponse>(`/api/projects/${projectId}`).then((response) => { if (alive) { setProject(response); setForm(formFromProject(response)); } }).catch((reason: unknown) => { if (alive) setLoadError(reason instanceof Error ? reason.message : "Project details could not be loaded."); });
    return () => { alive = false; };
  }, [projectId]);

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
      await apiPatch<ProjectResponse, Record<string, unknown>>(`/api/projects/${projectId}`, {
        street: form.street.trim(), suburb: optionalValue(form.suburb), postcode: optionalValue(form.postcode), agencyName: optionalValue(form.agencyName), agentName: optionalValue(form.agentName), agentEmail: optionalValue(form.agentEmail), agentPhone: optionalValue(form.agentPhone), shootDate: optionalValue(form.shootDate), timeWindow: optionalValue(form.timeWindow), orderNo: optionalValue(form.orderNo), orderId: optionalValue(form.orderId), invoiceAmount: invoiceAmount ? Number(invoiceAmount) : null, paymentStatus: optionalValue(form.paymentStatus), notes: optionalValue(form.notes), rawFolderLink: optionalValue(form.rawFolderLink), rawFolderPath: optionalValue(form.rawFolderPath), orderedServices: form.orderedServices, photographerUserIds: form.photographerUserIds, editorUserIds: form.editorUserIds,
      });
      onSaved("Shoot details saved.");
    } catch (reason) {
      const blockedMessage = blockedServiceMessage(reason);
      if (blockedMessage) {
        setSubmitError(blockedMessage);
        try {
          const current = await apiGet<ProjectResponse>(`/api/projects/${projectId}`);
          setProject(current);
          setForm(formFromProject(current));
        } catch { /* Keep the safety error visible even if the re-sync request fails. */ }
      } else setSubmitError(reason instanceof Error ? reason.message : "The shoot details could not be saved.");
    }
    finally { setIsSubmitting(false); }
  }

  if (loadError) return <main className="page"><div className="pagehead"><h1 className="serif">Edit shoot</h1><button className="button button--secondary" type="button" onClick={onCancel}>Back to workspace</button></div><div className="empty" role="alert"><span className="serif">Project unavailable.</span>{loadError}</div></main>;
  if (!project) return <main className="page"><div className="empty"><span className="serif">Loading shoot details.</span>Preparing the form.</div></main>;

  return <main className="page create-project edit-project">
    <div className="pagehead"><div><div className="ey" style={{ marginBottom: 14 }}>Production desk</div><h1 className="serif">Edit shoot</h1></div><button className="button button--secondary" type="button" onClick={onCancel}>Cancel</button></div>
    <form className="create-project__form" onSubmit={(event) => void submit(event)} noValidate>
      {submitError && <div className="notice" role="alert">{submitError}</div>}
      <section className="create-project__section" aria-labelledby="property-heading"><div className="create-project__section-head"><div className="ey">Property</div><h2 className="serif" id="property-heading">Where is the shoot?</h2></div><div className="create-project__fields create-project__fields--property"><label className="admin-field create-project__field--wide"><span>Street *</span><input required value={form.street} onChange={(event) => updateField("street", event.target.value)} aria-invalid={Boolean(errors.street)} />{errors.street && <small>{errors.street}</small>}</label><label className="admin-field"><span>Suburb</span><input value={form.suburb} onChange={(event) => updateField("suburb", event.target.value)} /></label><label className="admin-field"><span>Postcode</span><input inputMode="numeric" value={form.postcode} onChange={(event) => updateField("postcode", event.target.value)} /></label></div></section>
      <ProjectFields form={form} errors={errors} existingCollections={project.collections.map((collection) => collection.kind)} onChange={updateField} onToggle={toggleValue} />
      <div className="create-project__actions"><button className="button button--secondary" type="button" onClick={onCancel} disabled={isSubmitting}>Cancel</button><button className="button" type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving details…" : "Save changes"}</button></div>
    </form>
  </main>;
}
