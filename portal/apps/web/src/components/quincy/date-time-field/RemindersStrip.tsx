import { useId, useRef, useState } from "react";
import { PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS, PROJECT_DEADLINE_MAX_OFFSET_MINUTES, PROJECT_DEADLINE_PRESETS, deadlineOffsetLabel } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/reui/field";
import { Input } from "@/components/reui/input";
import { cn } from "@/lib/utils";

const CHIP = "pointer-coarse:min-h-[44px] aria-pressed:border-foreground aria-pressed:bg-secondary aria-pressed:!text-foreground";

const isPreset = (offset: number) => (PROJECT_DEADLINE_PRESETS as readonly number[]).includes(offset);
const descending = (values: number[]) => [...new Set(values)].sort((a, b) => b - a);

/**
 * The Deadline reminders strip (#213's chip row, extracted from `ProjectDeadlineControl` by #422):
 * one toggle chip per preset offset, a pressed chip per custom offset (pressing it off removes
 * it), `+ custom` for whole minutes, at most eight advances, and a "Due now" chip that is always on
 * and cannot be pressed. The offsets are the draft's; nothing here saves them.
 */
export function RemindersStrip({ offsets, onChange }: { offsets: readonly number[]; onChange: (next: number[]) => void }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const customToggle = useRef<HTMLButtonElement>(null);
  const customId = useId();
  const selected = new Set(offsets);
  const customOffsets = offsets.filter((value) => !isPreset(value));
  const full = offsets.length >= PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS;
  const customValue = Number(custom);
  const customValid = custom.trim() !== "" && Number.isSafeInteger(customValue) && customValue >= 1 && customValue <= PROJECT_DEADLINE_MAX_OFFSET_MINUTES && !selected.has(customValue);

  const toggle = (offset: number, on: boolean) => onChange(on ? descending([...offsets, offset]) : offsets.filter((value) => value !== offset));

  const addCustom = () => {
    if (!customValid || full) return;
    onChange(descending([...offsets, customValue]));
    setCustom("");
    setCustomOpen(false);
    // The field and its Add button unmount here: hand focus to "+ custom" so a keyboard user keeps
    // their place (synchronously; a deferred refocus loses it, docs/lessons.md TB8-02).
    customToggle.current?.focus();
  };

  const removeCustom = (value: number) => {
    toggle(value, false);
    customToggle.current?.focus();
  };

  return (
    <fieldset className="m-0 grid min-w-0 gap-[var(--space-2)] border-0 p-0">
      <legend className="mb-[var(--space-1)] p-0 [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">
        Advance reminders <span>({offsets.length}/{PROJECT_DEADLINE_MAX_ADVANCE_OFFSETS})</span>
      </legend>
      <div className="flex flex-wrap gap-[var(--space-2)]" role="group" aria-label="Advance reminders">
        {PROJECT_DEADLINE_PRESETS.map((preset) => (
          <Button key={preset} type="button" size="sm" variant="outline" className={CHIP} aria-pressed={selected.has(preset)} disabled={full && !selected.has(preset)} onClick={() => toggle(preset, !selected.has(preset))}>
            {deadlineOffsetLabel(preset)}
          </Button>
        ))}
        {customOffsets.map((value) => (
          <Button key={value} type="button" size="sm" variant="outline" className={CHIP} aria-pressed onClick={() => removeCustom(value)}>{deadlineOffsetLabel(value)}</Button>
        ))}
        <Button ref={customToggle} type="button" size="sm" variant="outline" className={CHIP} aria-expanded={customOpen} aria-controls={customId} disabled={full} onClick={() => setCustomOpen((open) => !open)}>+ custom</Button>
        {/* Mandatory, so it is a pressed chip nobody can press. */}
        <Button type="button" size="sm" variant="outline" className={cn(CHIP, "disabled:opacity-100")} aria-pressed disabled>Due now</Button>
      </div>
      {customOpen && (
        <Field id={customId} orientation="horizontal" className="items-end">
          <div className="grid min-w-0 flex-1 gap-[var(--space-1)]">
            <FieldLabel htmlFor={`${customId}-minutes`}>Custom reminder minutes</FieldLabel>
            <Input id={`${customId}-minutes`} type="number" min={1} max={PROJECT_DEADLINE_MAX_OFFSET_MINUTES} step={1} value={custom} placeholder="Minutes before" autoFocus onChange={(event) => setCustom(event.target.value)} />
          </div>
          <Button type="button" variant="secondary" disabled={!customValid || full} onClick={addCustom}>Add</Button>
        </Field>
      )}
      <FieldDescription className="text-[length:var(--text-xs)]">Due-now reminder is mandatory.</FieldDescription>
    </fieldset>
  );
}
