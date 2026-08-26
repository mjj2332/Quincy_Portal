import { useEffect, useState, type FormEvent } from "react";
import type { CollectionKind } from "@quincy/shared";
import { ProjectFields, emptyProjectForm, type ProjectFieldError, type ProjectForm, type ProjectSelectionField, type ProjectTextField, validateProjectFields } from "../components/ProjectFields";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { InternalLink } from "../components/InternalLink";
import { invalidateProjectResources, projectDataKeys, removeProjectData, useOptionalProjectQueryClient } from "../lib/project-data";
import { confirm } from "../lib/confirm";

type ProjectResponse = {
  id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null; agentEmail: string | null; agentPhone: string | null;
  shootDate: string | null; timeWindow: string | null; orderNo: string | null; orderId: string | null; invoiceAmount: number | null; paymentStatus: string | null; notes: string | null; rawFolderLink: string | null; rawFolderPath: string | null;
  archivedAt: string | null;
  collections: Array<{ id: string; kind: CollectionKind }>; members: Array<{ userId: string; roleOnProject: "photographer" | "editor" }>;
};
type FormErrors = Partial<Record<"street" | ProjectFieldError, string>>;

function fieldValue(value: string | number | null): string { return value === null ? "" : String(value); }
function optionalValue(value: string): string | null { return value.trim() || null; }
function formFromProject(project: ProjectResponse): ProjectForm {
  return {
    street: project.street, suburb: fieldValue(project.suburb), postcode: fieldValue(project.postcode), agencyName: fieldValue(project.agencyName), agentName: fieldValue(project.agentName), agentEmail: fieldValue(project.agentEmail), agentPhone: fieldValue(project.agentPhone), shootDate: fieldValue(project.shootDate), timeWindow: fieldValue(project.timeWindow), orderNo: fieldValue(project.orderNo), orderId: fieldValue(project.orderId), invoiceAmount: fieldValue(project.invoiceAmount), paymentStatus: fieldValue(project.paymentStatus), notes: fieldValue(project.notes), rawFolderLink: fieldValue(project.rawFolderLink), rawFolderPath: fieldValue(project.rawFolderPath), orderedServices: project.collections.flatMap((collection) => collection.kind === "raw" ? [] : [collection.kind]), photographerUserIds: project.members.filter((member) => member.roleOnProject === "photographer").map((member) => member.userId), editorUserIds: project.members.filter((member) => member.roleOnProject === "editor").map((member) => member.userId),
  };
}

export function editProjectPayload(form: ProjectForm): Record<string, unknown> {
  return {
    street: form.street.trim(), suburb: optionalValue(form.suburb), postcode: optionalValue(form.postcode),
    agencyName: optionalValue(form.agencyName), agentName: optionalValue(form.agentName), agentEmail: optionalValue(form.agentEmail), agentPhone: optionalValue(form.agentPhone),
    shootDate: optionalValue(form.shootDate), timeWindow: optionalValue(form.timeWindow), rawFolderLink: optionalValue(form.rawFolderLink), rawFolderPath: optionalValue(form.rawFolderPath),
    photographerUserIds: form.photographerUserIds, editorUserIds: form.editorUserIds,
  };
}

export function EditProject({ projectId, onNavigate }: { projectId: string; onNavigate: (path: string, notice?: string, replace?: boolean) => void }) {
  const queryClient = useOptionalProjectQueryClient();
  const { can } = useCapabilities();
  const canEditProject = can("editProject");
  const [project, setProject] = useState<ProjectResponse>();
  const [form, setForm] = useState<ProjectForm>(emptyProjectForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [loadError, setLoadError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [dangerError, setDangerError] = useState<string>();
  const [dangerNotice, setDangerNotice] = useState<string>();
  const [isDangerAction, setIsDangerAction] = useState(false);

  useEffect(() => {
    if (!canEditProject) return;
    let alive = true;
    setLoadError(undefined);
    void apiGet<ProjectResponse>(`/api/projects/${projectId}`).then((response) => { if (alive) { setProject(response); setForm(formFromProject(response)); } }).catch((reason: unknown) => { if (alive) setLoadError(reason instanceof Error ? reason.message : "Project details could not be loaded."); });
    return () => { alive = false; };
  }, [canEditProject, projectId]);

  function updateField(field: ProjectTextField, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    if (field === "street" || field === "agentEmail" || field === "rawFolderLink") setErrors((current) => ({ ...current, [field]: undefined }));
    setSubmitError(undefined);
  }

  function toggleValue(field: ProjectSelectionField, value: string) {
    setForm((current) => { const values = current[field] as string[]; return { ...current, [field]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] }; });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: FormErrors = { street: form.street.trim() ? undefined : "Enter the property street address.", ...validateProjectFields(form, "edit") };
    setErrors(nextErrors); setSubmitError(undefined);
    if (Object.values(nextErrors).some(Boolean)) return;
    setIsSubmitting(true);
    try {
      const response = await apiPatch<ProjectResponse, Record<string, unknown>>(`/api/projects/${projectId}`, editProjectPayload(form));
      if (queryClient) {
        queryClient.setQueryData(projectDataKeys.detail(projectId), response);
        await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }] });
      }
      onNavigate(`/projects/${encodeURIComponent(projectId)}`, "Shoot details saved.");
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "The shoot details could not be saved.");
    }
    finally { setIsSubmitting(false); }
  }

  async function archiveProject() {
    if (!await confirm({ title: "Archive project?", message: "Archive this project? It will be hidden from the dashboard and can be restored later.", confirmLabel: "Archive" })) return;
    setDangerError(undefined); setIsDangerAction(true);
    try { await apiPost<{ ok: true }, Record<string, never>>(`/api/projects/${projectId}/archive`, {}); if (queryClient) await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }] }); onNavigate(`/projects/${encodeURIComponent(projectId)}`, "Project archived."); }
    catch (reason) { setDangerError(reason instanceof Error ? reason.message : "The project could not be archived."); }
    finally { setIsDangerAction(false); }
  }

  async function restoreProject() {
    if (!await confirm({ title: "Restore project?", message: "Restore this project to the dashboard?", confirmLabel: "Restore" })) return;
    setDangerError(undefined); setIsDangerAction(true);
    try { await apiPost<{ ok: true }, Record<string, never>>(`/api/projects/${projectId}/restore`, {}); if (queryClient) await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }] }); onNavigate(`/projects/${encodeURIComponent(projectId)}`, "Project restored."); }
    catch (reason) { setDangerError(reason instanceof Error ? reason.message : "The project could not be restored."); }
    finally { setIsDangerAction(false); }
  }

  async function deleteProject() {
    if (!await confirm({ title: "Delete project permanently?", message: "Permanently delete this archived project and all of its cloud media? This cannot be undone.", confirmLabel: "Delete permanently", danger: true })) return;
    setDangerError(undefined); setIsDangerAction(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The project could not be deleted.");
      if (queryClient) await removeProjectData(queryClient, projectId);
      onNavigate("/", "Project permanently deleted.", true);
    } catch (reason) { setDangerError(reason instanceof Error ? reason.message : "The project could not be deleted."); setIsDangerAction(false); }
  }

  const archived = Boolean(project?.archivedAt);
  const deleteMatchesStreet = deleteConfirmation.trim().toLocaleLowerCase() === project?.street.trim().toLocaleLowerCase();

  return <main className="page create-project edit-project">
    <div className="pagehead"><div><div className="ey" style={{ marginBottom: 14 }}>Production desk</div><h1 className="serif">Edit shoot</h1>{archived && <div className="edit-project__archived" role="status">Archived — hidden from the dashboard</div>}</div><InternalLink className="button button--secondary" to={`/projects/${encodeURIComponent(projectId)}`}>Cancel</InternalLink></div>
    {canEditProject && (project ? <form className="create-project__form" onSubmit={(event) => void submit(event)} noValidate>
      {submitError && <div className="notice" role="alert">{submitError}</div>}
      <section className="create-project__section" aria-labelledby="property-heading"><div className="create-project__section-head"><div className="ey">Property</div><h2 className="serif" id="property-heading">Where is the shoot?</h2></div><div className="create-project__fields create-project__fields--property"><label className="admin-field create-project__field--wide"><span>Street *</span><input required value={form.street} onChange={(event) => updateField("street", event.target.value)} aria-invalid={Boolean(errors.street)} />{errors.street && <small>{errors.street}</small>}</label><label className="admin-field"><span>Suburb</span><input value={form.suburb} onChange={(event) => updateField("suburb", event.target.value)} /></label><label className="admin-field"><span>Postcode</span><input inputMode="numeric" value={form.postcode} onChange={(event) => updateField("postcode", event.target.value)} /></label></div></section>
      <ProjectFields form={form} errors={errors} existingCollections={project.collections.map((collection) => collection.kind)} mode="edit" onChange={updateField} onToggle={toggleValue} />
      <div className="create-project__actions"><InternalLink className="button button--secondary" to={`/projects/${encodeURIComponent(projectId)}`} aria-disabled={isSubmitting}>Cancel</InternalLink><button className="button" type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving details…" : "Save changes"}</button></div>
    </form> : <div className="empty" role={loadError ? "alert" : "status"}><span className="serif">{loadError ? "Project details unavailable." : "Loading shoot details."}</span>{loadError ?? "Preparing the form."}</div>)}
    {canEditProject && project && can("adminBackend") && <section className="danger-zone" aria-labelledby="danger-zone-heading"><div><div className="ey">Danger zone</div><h2 className="serif" id="danger-zone-heading">Project lifecycle</h2></div>{dangerError && <div className="notice" role="alert">{dangerError}</div>}{dangerNotice && <div className="danger-zone__notice" role="status">{dangerNotice}</div>}{!archived ? <div className="danger-zone__action"><div><strong>Archive project</strong><p>Archived projects are hidden from the dashboard but remain recoverable.</p></div><button className="button button--secondary" type="button" disabled={isDangerAction} onClick={() => void archiveProject()}>{isDangerAction ? "Archiving…" : "Archive project"}</button></div> : <><div className="danger-zone__action"><div><strong>Restore project</strong><p>Return this project to the dashboard and active production work.</p></div><button className="button button--secondary" type="button" disabled={isDangerAction} onClick={() => void restoreProject()}>{isDangerAction ? "Restoring…" : "Restore project"}</button></div><div className="danger-zone__delete"><div><strong>Delete project permanently</strong><p>All media in cloud storage will be erased. This cannot be undone.</p></div><label className="admin-field"><span>Type “{project.street}” to confirm</span><input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" /></label><button className="button danger-zone__button" type="button" disabled={isDangerAction || !deleteMatchesStreet} onClick={() => void deleteProject()}>{isDangerAction ? "Deleting…" : "Delete project permanently"}</button></div></>}</section>}
  </main>;
}
