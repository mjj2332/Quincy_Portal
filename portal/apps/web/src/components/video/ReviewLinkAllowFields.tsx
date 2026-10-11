import { useId } from "react";
import type { Allow } from "../../lib/review-link-form-store";
import { FIELD_LEGEND_TEXT } from "../quincy/Eyebrow";
import { Switch } from "../reui/switch";

const ROWS: Array<{ key: keyof Allow; label: string; hint: string }> = [
  { key: "comments", label: "Comments", hint: "Guests can add notes to a film." },
  { key: "approve", label: "Approve", hint: "Guests can approve or request changes." },
  { key: "download", label: "Download", hint: "Guests can download a film after they verify their email, approve it, and you Release it. Premium films also need unlocking." },
];

/** The three permissions as `reui/switch` rows (#741 11b). Used by the create form and a link's settings. */
export const LEGEND = FIELD_LEGEND_TEXT;

export function ReviewLinkAllowFields({ value, onChange, disabled = false }: { value: Allow; onChange: (key: keyof Allow, next: boolean) => void; disabled?: boolean }) {
  const legendId = useId();
  return <div role="group" aria-labelledby={legendId} className="grid gap-[var(--space-2)]">
    <span id={legendId} className={LEGEND}>What guests can do</span>
    {ROWS.map((row) => <div key={row.key} className="flex min-h-11 items-center justify-between gap-[var(--space-3)]">
      <div className="grid gap-0.5">
        <span className="[font:var(--weight-medium)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{row.label}</span>
        <span className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{row.hint}</span>
      </div>
      <Switch aria-label={row.label} checked={value[row.key]} disabled={disabled} onCheckedChange={(next) => onChange(row.key, next)} />
    </div>)}
  </div>;
}
