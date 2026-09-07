import { useState, type FormEvent } from "react";
import type { CollectionKind } from "@quincy/shared";
import { ProjectFields, emptyProjectForm, type ProjectFieldError, type ProjectForm, type ProjectSelectionField, type ProjectTextField, validateProjectFields } from "../components/ProjectFields";
import { apiPost } from "../lib/api";
import { InternalLink } from "../components/InternalLink";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient } from "../lib/project-data";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { FIELD_BOX } from "@/components/ui/input";
import { QuincyField } from "@/components/quincy/QuincyField";
import { Notice } from "@/components/quincy/Notice";
import { buttonClasses } from "@/components/ui/button";

type ProjectDetail = { id: string; collections: Array<{ id: string; kind: CollectionKind }>; members: Array<{ id: string }> };
type FormErrors = Partial<Record<"street" | ProjectFieldError, string>>;

const OPTIONAL_MARKER = "not-italic ms-[var(--space-2)] [font:var(--type-eyebrow)] normal-case tracking-[var(--tracking-normal)] text-foreground-secondary";

function optionalValue(value: string): string | null { return value.trim() || null; }

export function CreateProject({ onNavigate }: { onNavigate: (path: string, notice?: string) => void }) {
  const queryClient = useOptionalProjectQueryClient();
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
      if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId: project.id, resources: [], dashboard: true, calendar: true });
      onNavigate(`/projects/${encodeURIComponent(project.id)}`, "Shoot created.");
    } catch (reason) { setSubmitError(reason instanceof Error ? reason.message : "The shoot could not be created."); }
    finally { setIsSubmitting(false); }
  }

  return <main className="page !max-w-[1080px]">
    <header className="flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]">
      <div>
        <Eyebrow className="block mb-[var(--space-3)]">Production desk</Eyebrow>
        <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)]">New shoot</h1>
      </div>
      <InternalLink className={buttonClasses("secondary")} to="/">Cancel</InternalLink>
    </header>
    <form onSubmit={(event) => void submit(event)} noValidate className="create-project__form flex flex-col gap-[var(--space-8)]">
      {submitError && <Notice role="alert">{submitError}</Notice>}
      <section
        aria-labelledby="property-heading"
        className="p-[clamp(var(--space-5),6vw,var(--space-8))] bg-card border-solid border-[length:var(--border-width-hair)] border-border"
      >
        <Eyebrow className="block mb-[var(--space-3)]">Start with the address</Eyebrow>
        <h2 id="property-heading" className="m-0 [font:var(--type-h1)] max-[721px]:[font:var(--type-h2)] tracking-[var(--tracking-tight)] text-foreground text-balance">
          Where is the shoot?
        </h2>
        {/* `!` on both margins: `tokens/base.css` is imported outside any `@layer`, so its
            `p { margin: 0 }` beats a plain margin utility from `@layer utilities`. (§7 case O) */}
        <p className="!mt-[var(--space-4)] !mb-[var(--space-5)] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
          You can fill in everything else later from the shoot&apos;s workspace.
        </p>

        <div className="create-project__hero-action grid gap-[var(--space-3)] grid-cols-1 min-[721px]:grid-cols-[minmax(0,1fr)_auto]">
          <label className="flex flex-col gap-[6px]">
            <span className="sr-only">Street address</span>
            <input
              autoFocus
              required
              id="project-street"
              placeholder="12 Kings Road, Vaucluse"
              value={form.street}
              onChange={(event) => updateField("street", event.target.value)}
              aria-invalid={Boolean(errors.street)}
              aria-describedby={errors.street ? "project-street-error" : undefined}
              aria-errormessage={errors.street ? "project-street-error" : undefined}
              className={cn(FIELD_BOX,
                "min-h-[var(--space-7)] rounded-none px-[16px] py-[12px]",
                "border-[var(--field-border)]",
                "[font:var(--weight-regular)_var(--text-lg)/var(--leading-snug)_var(--font-display)]")}
            />
          </label>
          <button data-testid="create-project-hero-submit" type="submit" className={buttonClasses("primary", { busy: isSubmitting, className: "min-h-[var(--space-7)] max-[721px]:w-full" })} disabled={isSubmitting || !form.street.trim()}>
            {isSubmitting ? "Creating shoot…" : "Create shoot"}
          </button>
        </div>

        {errors.street ? (
          <p id="project-street-error" role="alert" className="!mt-[var(--space-2)] mb-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive">
            {errors.street}
          </p>
        ) : null}

        <div className="grid gap-[var(--space-4)] max-w-[580px] grid-cols-1 min-[721px]:grid-cols-[minmax(0,1fr)_150px] mt-[var(--space-4)]">
          <QuincyField id="project-suburb" label={<>Suburb <em className={OPTIONAL_MARKER}>optional</em></>} value={form.suburb} onChange={(event) => updateField("suburb", event.target.value)} />
          <QuincyField id="project-postcode" label={<>Postcode <em className={OPTIONAL_MARKER}>optional</em></>} inputMode="numeric" value={form.postcode} onChange={(event) => updateField("postcode", event.target.value)} />
        </div>
      </section>
      <details open={showDetails} onToggle={(event) => setShowDetails(event.currentTarget.open)} className="bg-card border-solid border-[length:var(--border-width-hair)] border-border">
        <summary className="p-[var(--space-5)] cursor-pointer [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] text-foreground marker:text-foreground-secondary open:[border-bottom-style:solid] open:border-b-[length:var(--border-width-hair)] open:border-b-border">
          Add details now <span className="normal-case tracking-[var(--tracking-normal)] text-foreground-secondary">(optional)</span>
        </summary>
        <div className="p-[var(--space-5)] max-[721px]:p-[var(--space-4)] flex flex-col gap-[var(--space-8)]">
          <ProjectFields form={form} errors={errors} onChange={updateField} onToggle={toggleValue} />
          <div className="create-project__actions flex flex-wrap justify-end gap-[var(--space-3)] max-[721px]:flex-col-reverse max-[721px]:[&>*]:w-full">
            <InternalLink className={buttonClasses("secondary")} to="/" aria-disabled={isSubmitting}>Cancel</InternalLink>
            <button data-testid="create-project-submit" className={buttonClasses("primary", { busy: isSubmitting })} type="submit" disabled={isSubmitting || !form.street.trim()}>{isSubmitting ? "Creating shoot…" : "Create shoot"}</button>
          </div>
        </div>
      </details>
    </form>
  </main>;
}
