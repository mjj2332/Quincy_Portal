import { useCallback, useEffect, useState } from "react";
import type { CollectionKind, MonitoredRawFolder, Role } from "@quincy/shared";
import { apiGet } from "../lib/api";
import { cn } from "@/lib/utils";
import { FieldGroup } from "@/components/reui/field";
import { QuincyField } from "@/components/quincy/QuincyField";
import { QuincyTextareaField } from "@/components/quincy/QuincyTextareaField";
import { SectionHead } from "@/components/quincy/SectionHead";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Notice } from "@/components/quincy/Notice";
import { buttonClasses } from "@/components/quincy/Button";

export type User = { id: string; name: string; email: string; role: Role; active: boolean };
export type ProjectForm = {
  street: string; suburb: string; postcode: string; agencyName: string; agentName: string; agentEmail: string; agentPhone: string;
  shootDate: string; timeWindow: string; orderNo: string; orderId: string; invoiceAmount: string; paymentStatus: string; notes: string; productionNotes: string;
  rawFolderLink: string; rawFolderPath: string; orderedServices: Exclude<CollectionKind, "raw">[]; photographerUserIds: string[]; editorUserIds: string[];
};
export type ProjectTextField = Exclude<keyof ProjectForm, "orderedServices" | "photographerUserIds" | "editorUserIds">;
export type ProjectSelectionField = "orderedServices" | "photographerUserIds" | "editorUserIds";
export type ProjectFieldError = "agentEmail" | "rawFolderLink" | "invoiceAmount";
export type ProjectFieldsMode = "create" | "edit";

type AssignmentCandidatesResponse = { photographers: Array<Omit<User, "role"> & { globalRole: Role }>; editors: Array<Omit<User, "role"> & { globalRole: Role }> };
type Service = { kind: Exclude<CollectionKind, "raw">; label: string };

export const SERVICES: Service[] = [
  { kind: "edited", label: "Edited photography" },
  { kind: "video", label: "Video" },
  { kind: "floorplan", label: "Floorplan" },
  { kind: "copy", label: "Copywriting" },
];

export const emptyProjectForm: ProjectForm = {
  street: "", suburb: "", postcode: "", agencyName: "", agentName: "", agentEmail: "", agentPhone: "",
  shootDate: "", timeWindow: "", orderNo: "", orderId: "", invoiceAmount: "", paymentStatus: "", notes: "", productionNotes: "",
  rawFolderLink: "", rawFolderPath: "", orderedServices: [], photographerUserIds: [], editorUserIds: [],
};

// Inlined from the legacy `ui/checkbox` primitive, which this file no longer imports. The
// checklist and services-grid checkboxes stay native `<input type="checkbox">`s, not ReUI's Base
// UI `Checkbox`: `ProjectFields.test.ts:66,132` match serialised markup on
// `/<input type="checkbox"[^>]*><span[^>]*>…<\/span>/g`, but Base UI's hidden input orders its
// props `checked, disabled, form, name, id, required, ref, style, tabIndex, type, …` (so `type`
// is never first) and renders a `<span role="checkbox">` root *before* that hidden input — the
// regex would never match. Same device as `screens/NotificationPreferences.tsx`'s `TOGGLE_ROW`.
const CHECKBOX_INPUT =
  "size-[18px] shrink-0 m-0 accent-[var(--accent)] cursor-pointer " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed";

/* A bordered, selectable tile: the services grid and the create-mode team checklist. */
const CHECK_TILE =
  "flex items-start gap-[var(--space-3)] cursor-pointer " +
  "min-h-[var(--space-7)] p-[12px] bg-card text-foreground-secondary " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:bg-secondary has-[:checked]:bg-surface-sunken " +
  "has-[:focus-visible]:outline-[length:var(--border-width-bold)] has-[:focus-visible]:outline-solid " +
  "has-[:focus-visible]:outline-ring has-[:focus-visible]:-outline-offset-2 " +
  "has-[:disabled]:cursor-default has-[:disabled]:text-foreground-secondary " +
  "has-[:disabled]:bg-surface-sunken has-[:disabled]:hover:bg-surface-sunken";

// The three field-grid shapes, named once and used throughout (§5.14).
export const FIELD_GRID_4 = "grid gap-[var(--space-4)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-4";
export const FIELD_GRID_2 = "grid gap-[var(--space-4)] max-w-[620px] grid-cols-1 min-[721px]:grid-cols-2";
export const FIELD_GRID_PROPERTY = "grid gap-[var(--space-4)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(110px,0.55fr)]";

// Section body copy, shared by the read-only notes across §5.14. `SectionHead`'s own
// `mb-[var(--space-5)]` collapses with the `mt` here, so the note sits 24px under the rule; the
// `mb` is what keeps it off the field grid that follows it.
// Both margins are `!` for the same cascade reason `button.tsx`'s colours are: `tokens/base.css`
// is imported outside any `@layer`, and its unlayered `p { margin: 0 }` beats any margin utility
// Tailwind emits into `@layer utilities`. Without the `!` these two collapse to zero. (§7 case O)
const SECTION_NOTE = "!mt-[var(--space-2)] !mb-[var(--space-4)] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";
// The team checklist's own empty message. It sits inside `TEAM_CHECKLIST`'s `bg-border` ground, so
// it needs a tile's own paper behind it or it renders on the rule colour.
const CHECKLIST_EMPTY = "m-0 p-[12px] bg-card [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";
const TILE_LABEL = "text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";
const TILE_HINT = "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";
const TILE_SPAN = "flex min-w-0 flex-col gap-[var(--space-1)]";
// Reproduces what the now-deleted `.create-project__checklist` rule did: a 1px-gap hairline grid,
// same technique as the services grid, plus its own `margin-top: var(--space-3)`.
const TEAM_CHECKLIST = "grid gap-[1px] mt-[var(--space-3)] bg-border border-solid border-[length:var(--border-width-hair)] border-border";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUrl(value: string): boolean {
  try { new URL(value); return true; } catch { return false; }
}

function userName(user: User): string { return user.name || user.email; }
function roleLabel(role: Role): string { return role === "external_editor" ? "External editor" : role === "admin" ? "admin" : role === "editor" ? "editor" : ""; }

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

export function ProjectFields({ form, errors, existingCollections = [], mode = "create", monitoredRawFolder, onChange, onToggle }: {
  form: ProjectForm;
  errors: Partial<Record<ProjectFieldError, string>>;
  existingCollections?: CollectionKind[];
  mode?: ProjectFieldsMode;
  /** Set when a ready Editor folder mapping already monitors this project's RAW intake — the
   * Tonomo fields below stay fully editable (they still drive Tonomo change detection, RAW
   * identity recovery and AutoHDR naming) but are no longer the folder being watched. */
  monitoredRawFolder?: MonitoredRawFolder | null;
  onChange: (field: ProjectTextField, value: string) => void;
  onToggle: (field: ProjectSelectionField, value: string) => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [usersError, setUsersError] = useState<string>();
  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true); setUsersError(undefined);
    try {
      const response = await apiGet<AssignmentCandidatesResponse>("/api/project-assignment-candidates");
      const candidates = [...response.photographers, ...response.editors];
      setUsers([...new Map(candidates.map((user) => [user.id, { ...user, role: user.globalRole }])).values()]);
    }
    catch (reason) { setUsersError(reason instanceof Error ? reason.message : "Team members could not be loaded."); }
    finally { setIsLoadingUsers(false); }
  }, []);

  useEffect(() => {
    if (mode !== "create") { setIsLoadingUsers(false); return; }
    void loadUsers();
  }, [loadUsers, mode]);

  const photographers = users.filter((user) => (user.role === "photographer" || user.role === "editor" || user.role === "admin") && (user.active || form.photographerUserIds.includes(user.id)));
  const editors = users.filter((user) => (user.role === "editor" || user.role === "external_editor" || user.role === "admin") && (user.active || form.editorUserIds.includes(user.id)));
  const collectionExists = (kind: CollectionKind) => existingCollections.includes(kind);
  const policy = projectFieldsPolicy(mode);

  return <>
    <section className="create-project__section" aria-labelledby="client-heading">
      <SectionHead eyebrow="Client" id="client-heading">Who is it for?</SectionHead>
      <FieldGroup className="grid grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-4 gap-[var(--space-4)]">
        <QuincyField id="project-agency-name" label="Agency" value={form.agencyName} onChange={(event) => onChange("agencyName", event.target.value)} />
        <QuincyField id="project-agent-name" label="Agent" value={form.agentName} onChange={(event) => onChange("agentName", event.target.value)} />
        <QuincyField id="project-agent-email" label="Agent email" type="email" value={form.agentEmail} onChange={(event) => onChange("agentEmail", event.target.value)} aria-invalid={Boolean(errors.agentEmail)} error={errors.agentEmail} />
        <QuincyField id="project-agent-phone" label="Agent phone" type="tel" value={form.agentPhone} onChange={(event) => onChange("agentPhone", event.target.value)} />
      </FieldGroup>
    </section>
    <section className="create-project__section" aria-labelledby="shoot-heading">
      <SectionHead eyebrow="Shoot" id="shoot-heading">When is it happening?</SectionHead>
      <div className={FIELD_GRID_2}>
        <QuincyField id="project-shoot-date" label="Shoot date" type="date" value={form.shootDate} onChange={(event) => onChange("shootDate", event.target.value)} />
        <QuincyField id="project-time-window" label="Time window" placeholder="e.g. 9:00–11:00 am" value={form.timeWindow} onChange={(event) => onChange("timeWindow", event.target.value)} />
      </div>
    </section>
    <section className="create-project__section" aria-labelledby="order-heading">
      <SectionHead eyebrow="Order" id="order-heading">How is it tracked?</SectionHead>
      {policy.orderReadOnly && <p className={SECTION_NOTE}>Order details are managed by the order system and are available here to copy.</p>}
      <div className={FIELD_GRID_4}>
        <QuincyField id="project-order-number" label="Order number" value={form.orderNo} readOnly={policy.orderReadOnly} onChange={policy.orderReadOnly ? undefined : (event) => onChange("orderNo", event.target.value)} />
        <QuincyField id="project-order-id" label="Order ID" value={form.orderId} readOnly={policy.orderReadOnly} onChange={policy.orderReadOnly ? undefined : (event) => onChange("orderId", event.target.value)} />
        {policy.showInvoiceAndPayment && <>
          <QuincyField id="project-invoice-amount" label="Invoice amount" type="number" step="any" inputMode="decimal" value={form.invoiceAmount} onChange={(event) => onChange("invoiceAmount", event.target.value)} aria-invalid={Boolean(errors.invoiceAmount)} error={errors.invoiceAmount} />
          <QuincyField id="project-payment-status" label="Payment status" value={form.paymentStatus} onChange={(event) => onChange("paymentStatus", event.target.value)} />
        </>}
      </div>
    </section>
    <section className="create-project__section" aria-labelledby="services-heading">
      <SectionHead eyebrow="Services" id="services-heading">What is being delivered?</SectionHead>
      {policy.servicesReadOnly && <p className={SECTION_NOTE}>Services are fixed after a project is created.</p>}
      <div role="group" aria-labelledby="services-heading"
           className="grid gap-[1px] bg-border border-solid border-[length:var(--border-width-hair)] border-border grid-cols-1 min-[721px]:grid-cols-3 min-[1081px]:grid-cols-5">
        <label className={CHECK_TILE}>
          <input type="checkbox" checked disabled className={CHECKBOX_INPUT} />
          <span className={TILE_SPAN}><strong className={TILE_LABEL}>RAW</strong><small className={TILE_HINT}>{collectionExists("raw") ? "Already created" : "Always included"}</small></span>
        </label>
        {SERVICES.map((service) => <label className={CHECK_TILE} key={service.kind}><input type="checkbox" checked={form.orderedServices.includes(service.kind)} disabled={policy.servicesReadOnly} onChange={policy.servicesReadOnly ? undefined : () => onToggle("orderedServices", service.kind)} className={CHECKBOX_INPUT} /><span className={TILE_SPAN}>{service.label}</span></label>)}
      </div>
    </section>
    <section className="create-project__section" aria-labelledby="dropbox-heading">
      <SectionHead eyebrow="Dropbox" id="dropbox-heading">Where will the RAW files land?</SectionHead>
      {monitoredRawFolder && <Notice tone="caution" role="status" className="mb-[var(--space-4)]">
        RAW is monitored from the Editor Input folder <strong className="font-medium [font-family:var(--font-mono)]">{monitoredRawFolder.path}</strong>. The fields below are the Tonomo folder: they are not monitored, and are still used for Tonomo change detection, RAW identity recovery and AutoHDR naming.
      </Notice>}
      <div className={FIELD_GRID_2}>
        <QuincyField id="project-raw-folder-link" label="RAW folder link" type="url" placeholder="https://www.dropbox.com/..." value={form.rawFolderLink} onChange={(event) => onChange("rawFolderLink", event.target.value)} aria-invalid={Boolean(errors.rawFolderLink)} error={errors.rawFolderLink} />
        <QuincyField id="project-raw-folder-path" label="RAW folder path" placeholder="/Shoots/Property name" value={form.rawFolderPath} onChange={(event) => onChange("rawFolderPath", event.target.value)} />
      </div>
    </section>
    {mode === "create" && <section className="create-project__section" aria-labelledby="team-heading">
      <SectionHead eyebrow="Team" id="team-heading">Who is assigned?</SectionHead>
      {isLoadingUsers && <div role="status" className={SECTION_NOTE}>Loading available team members…</div>}
      {!isLoadingUsers && usersError && <Notice role="alert">{usersError}<div className="mt-[var(--space-3)]"><button className={buttonClasses("secondary", {})} type="button" onClick={() => void loadUsers()}>Try again</button></div></Notice>}
      {!isLoadingUsers && !usersError && <div className={FIELD_GRID_2}>
        <div>
          <Eyebrow className="block mb-[var(--space-2)]">Photographers</Eyebrow>
          <div data-testid="create-project-checklist" className={TEAM_CHECKLIST}>{photographers.length ? photographers.map((user) => <label data-testid="create-project-check" className={CHECK_TILE} key={user.id}><input type="checkbox" checked={form.photographerUserIds.includes(user.id)} onChange={() => onToggle("photographerUserIds", user.id)} className={CHECKBOX_INPUT} /><span className={TILE_SPAN}><strong className={TILE_LABEL}>{userName(user)}</strong><small className={TILE_HINT}>{user.email}{roleLabel(user.role) && ` · ${roleLabel(user.role)}`}</small></span></label>) : <p className={CHECKLIST_EMPTY}>No active photographers are provisioned.</p>}</div>
        </div>
        <div>
          <Eyebrow className="block mb-[var(--space-2)]">Editors</Eyebrow>
          <div data-testid="create-project-checklist" className={TEAM_CHECKLIST}>{editors.length ? editors.map((user) => <label data-testid="create-project-check" className={CHECK_TILE} key={user.id}><input type="checkbox" checked={form.editorUserIds.includes(user.id)} onChange={() => onToggle("editorUserIds", user.id)} className={CHECKBOX_INPUT} /><span className={TILE_SPAN}><strong className={TILE_LABEL}>{userName(user)}</strong><small className={TILE_HINT}>{user.email}{user.role === "admin" && " · admin"}{user.role === "external_editor" && " · External editor"}</small></span></label>) : <p className={CHECKLIST_EMPTY}>No active editors are provisioned.</p>}</div>
        </div>
      </div>}
    </section>}
    <section className="create-project__section" aria-labelledby="notes-heading">
      <SectionHead eyebrow="Notes" id="notes-heading">Anything the team should know?</SectionHead>
      {policy.notesReadOnly && <p className={SECTION_NOTE}>Notes are retained from the original order.</p>}
      <QuincyTextareaField id="project-order-notes" label="Production notes" rows={5} value={form.productionNotes} readOnly={policy.notesReadOnly} onChange={policy.notesReadOnly ? undefined : (event) => onChange("productionNotes", event.target.value)} />
    </section>
  </>;
}
