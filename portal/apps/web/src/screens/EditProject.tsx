import { useEffect, useState, type FormEvent } from "react";
import type { CollectionKind, MonitoredRawFolder } from "@quincy/shared";
import { FIELD_GRID_PROPERTY, ProjectFields, emptyProjectForm, type ProjectFieldError, type ProjectForm, type ProjectTextField, validateProjectFields } from "../components/ProjectFields";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { InternalLink } from "../components/InternalLink";
import { invalidateProjectSurfaces, projectDataKeys, removeProjectData, useOptionalProjectQueryClient } from "../lib/project-data";
import { confirm } from "../lib/confirm";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { SectionHead } from "@/components/quincy/SectionHead";
import { StatusPill } from "@/components/quincy/StatusPill";
import { EmptyState } from "@/components/quincy/EmptyState";
import { Notice } from "@/components/quincy/Notice";
import { QuincyField } from "@/components/quincy/QuincyField";
import { Button } from "@/components/reui/button";
import { buttonClasses } from "@/components/quincy/Button";

type ProjectResponse = {
  id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null; agentEmail: string | null; agentPhone: string | null;
  shootDate: string | null; timeWindow: string | null; orderNo: string | null; orderId: string | null; invoiceAmount: number | null; paymentStatus: string | null; notes: string | null; productionNotes: string | null; rawFolderLink: string | null; rawFolderPath: string | null; monitoredRawFolder?: MonitoredRawFolder | null;
  archivedAt: string | null;
  collections: Array<{ id: string; kind: CollectionKind }>;
};
type FormErrors = Partial<Record<"street" | ProjectFieldError, string>>;

const DANGER_ROW = "pt-[var(--space-5)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-signal-critical/28 grid gap-[var(--space-5)] items-end grid-cols-1 max-[721px]:items-stretch";
const DANGER_LABEL = "block [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground";
// `!mt`: `tokens/base.css` is imported outside any `@layer`, so its `p { margin: 0 }` beats a
// plain margin utility from `@layer utilities`. Without the `!` this gap collapses to zero. (§7 case O)
const DANGER_COPY = "!mt-[var(--space-1)] max-w-[52ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

function fieldValue(value: string | number | null): string { return value === null ? "" : String(value); }
function optionalValue(value: string): string | null { return value.trim() || null; }
function formFromProject(project: ProjectResponse): ProjectForm {
  return {
    ...emptyProjectForm,
    street: project.street, suburb: fieldValue(project.suburb), postcode: fieldValue(project.postcode), agencyName: fieldValue(project.agencyName), agentName: fieldValue(project.agentName), agentEmail: fieldValue(project.agentEmail), agentPhone: fieldValue(project.agentPhone), shootDate: fieldValue(project.shootDate), timeWindow: fieldValue(project.timeWindow), orderNo: fieldValue(project.orderNo), orderId: fieldValue(project.orderId), invoiceAmount: fieldValue(project.invoiceAmount), paymentStatus: fieldValue(project.paymentStatus), notes: fieldValue(project.notes), productionNotes: fieldValue(project.productionNotes), rawFolderLink: fieldValue(project.rawFolderLink), rawFolderPath: fieldValue(project.rawFolderPath), orderedServices: project.collections.flatMap((collection) => collection.kind === "raw" ? [] : [collection.kind]),
  };
}

export function editProjectPayload(form: ProjectForm): Record<string, unknown> {
  return {
    street: form.street.trim(), suburb: optionalValue(form.suburb), postcode: optionalValue(form.postcode),
    agencyName: optionalValue(form.agencyName), agentName: optionalValue(form.agentName), agentEmail: optionalValue(form.agentEmail), agentPhone: optionalValue(form.agentPhone),
    shootDate: optionalValue(form.shootDate), timeWindow: optionalValue(form.timeWindow), productionNotes: optionalValue(form.productionNotes), rawFolderLink: optionalValue(form.rawFolderLink), rawFolderPath: optionalValue(form.rawFolderPath),
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
        await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true });
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
    try { await apiPost<{ ok: true }, Record<string, never>>(`/api/projects/${projectId}/archive`, {}); if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true }); onNavigate(`/projects/${encodeURIComponent(projectId)}`, "Project archived."); }
    catch (reason) { setDangerError(reason instanceof Error ? reason.message : "The project could not be archived."); }
    finally { setIsDangerAction(false); }
  }

  async function restoreProject() {
    if (!await confirm({ title: "Restore project?", message: "Restore this project to the dashboard?", confirmLabel: "Restore" })) return;
    setDangerError(undefined); setIsDangerAction(true);
    try { await apiPost<{ ok: true }, Record<string, never>>(`/api/projects/${projectId}/restore`, {}); if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "activity" }], dashboard: true, calendar: true, gantt: true }); onNavigate(`/projects/${encodeURIComponent(projectId)}`, "Project restored."); }
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

  return <main className="page !max-w-[1080px]">
    <header className="flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]">
      <div>
        <Eyebrow className="block mb-[var(--space-3)]">Production desk</Eyebrow>
        <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)]">Edit shoot</h1>
        {archived && <StatusPill tone="caution" role="status" className="mt-[var(--space-3)]">Archived — hidden from the dashboard</StatusPill>}
      </div>
      <InternalLink className={buttonClasses("secondary", {})} to={`/projects/${encodeURIComponent(projectId)}`}>Cancel</InternalLink>
    </header>
    {canEditProject && (project ? <form data-testid="edit-project-form" className="flex flex-col gap-[var(--space-8)]" onSubmit={(event) => void submit(event)} noValidate>
      {submitError && <Notice role="alert">{submitError}</Notice>}
      <section className="create-project__section" aria-labelledby="property-heading">
        <SectionHead eyebrow="Property" id="property-heading">Where is the shoot?</SectionHead>
        <div className={FIELD_GRID_PROPERTY}>
          <QuincyField id="project-street" label="Street *" required value={form.street} onChange={(event) => updateField("street", event.target.value)} aria-invalid={Boolean(errors.street)} error={errors.street} />
          <QuincyField id="project-suburb" label="Suburb" value={form.suburb} onChange={(event) => updateField("suburb", event.target.value)} />
          <QuincyField id="project-postcode" label="Postcode" inputMode="numeric" value={form.postcode} onChange={(event) => updateField("postcode", event.target.value)} />
        </div>
      </section>
      <ProjectFields form={form} errors={errors} existingCollections={project.collections.map((collection) => collection.kind)} mode="edit" monitoredRawFolder={project.monitoredRawFolder} onChange={updateField} onToggle={() => {}} />
      <div className="flex flex-wrap justify-end gap-[var(--space-3)] max-[721px]:flex-col-reverse max-[721px]:[&>*]:w-full">
        <InternalLink className={buttonClasses("secondary", {})} to={`/projects/${encodeURIComponent(projectId)}`} aria-disabled={isSubmitting}>Cancel</InternalLink>
        <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Saving details…" : "Save changes"}</Button>
      </div>
    </form> : <EmptyState role={loadError ? "alert" : "status"} tone={loadError ? "error" : "empty"} title={loadError ? "Project details unavailable." : "Loading shoot details."}>{loadError ?? "Preparing the form."}</EmptyState>)}
    {canEditProject && project && can("adminBackend") && <section
      aria-labelledby="danger-zone-heading"
      className="flex flex-col gap-[var(--space-5)] mt-[var(--space-8)] p-[var(--space-5)] border-solid border-[length:var(--border-width-hair)] border-signal-critical/48 bg-signal-critical/4"
    >
      <SectionHead eyebrow="Irreversible" id="danger-zone-heading" className="border-t-destructive">Danger zone</SectionHead>
      {dangerError && <Notice role="alert">{dangerError}</Notice>}
      {dangerNotice && <Notice tone="positive" role="status">{dangerNotice}</Notice>}
      {!archived ? <div className={`${DANGER_ROW} min-[721px]:grid-cols-[minmax(0,1fr)_auto]`}>
        <div>
          <strong className={DANGER_LABEL}>Archive project</strong>
          <p className={DANGER_COPY}>Archived projects are hidden from the dashboard but remain recoverable.</p>
        </div>
        <Button variant="outline" className="max-[721px]:w-full" type="button" disabled={isDangerAction} onClick={() => void archiveProject()}>{isDangerAction ? "Archiving…" : "Archive project"}</Button>
      </div> : <>
        <div className={`${DANGER_ROW} min-[721px]:grid-cols-[minmax(0,1fr)_auto]`}>
          <div>
            <strong className={DANGER_LABEL}>Restore project</strong>
            <p className={DANGER_COPY}>Return this project to the dashboard and active production work.</p>
          </div>
          <Button variant="outline" className="max-[721px]:w-full" type="button" disabled={isDangerAction} onClick={() => void restoreProject()}>{isDangerAction ? "Restoring…" : "Restore project"}</Button>
        </div>
        <div className={`${DANGER_ROW} min-[721px]:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)_auto]`}>
          <div>
            <strong className={DANGER_LABEL}>Delete project permanently</strong>
            <p className={DANGER_COPY}>All media in cloud storage will be erased. This cannot be undone.</p>
          </div>
          <QuincyField id="project-delete-confirmation" label={<>Type “{project.street}” to confirm</>} value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" />
          <Button variant="destructive" className="max-[721px]:w-full" type="button" disabled={isDangerAction || !deleteMatchesStreet} onClick={() => void deleteProject()}>{isDangerAction ? "Deleting…" : "Delete project permanently"}</Button>
        </div>
      </>}
    </section>}
  </main>;
}
