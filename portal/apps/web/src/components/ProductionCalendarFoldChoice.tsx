import { useId, useState, type JSX } from "react";
import { Modal } from "./Modal";
import { buttonClasses } from "./quincy/Button";
import { utcOffsetLabel } from "../lib/sydney-time-labels";

export type ProductionCalendarFoldChoiceProps = {
  open: boolean;
  title?: string;
  eyebrow?: string;
  endpoint: "start" | "end";
  choices: Array<{ disambiguation: "earlier" | "later"; utcOffsetMinutes: number }>;
  onSubmit: (choice: "earlier" | "later") => void;
  onCancel: () => void;
};

export function ProductionCalendarFoldChoice({ open, title = "Choose Sydney time", eyebrow, endpoint, choices, onSubmit, onCancel }: ProductionCalendarFoldChoiceProps): JSX.Element {
  const [choice, setChoice] = useState<"earlier" | "later" | undefined>();
  const name = useId();
  return <Modal open={open} title={title} eyebrow={eyebrow} onClose={onCancel} initialFocus={0} testId="calendar-fold-choice" variant="calendar" footer={<>
    <button className={buttonClasses("secondary")} type="button" data-testid="calendar-fold-cancel" onClick={onCancel}>Cancel</button>
    <button className={buttonClasses()} type="button" data-testid="calendar-fold-submit" disabled={!choice} onClick={() => { if (choice) onSubmit(choice); }}>Use this time</button>
  </>}>
    <fieldset className="qc-calendar-schedule-editor__fold">
      <legend>{endpoint === "start" ? "Start" : "End"} occurs twice in Sydney</legend>
      {choices.map((item) => <label key={item.disambiguation}>
        <input aria-label={`${endpoint} ${item.disambiguation} occurrence`} type="radio" name={name} value={item.disambiguation} checked={choice === item.disambiguation} onChange={() => setChoice(item.disambiguation)} />
        {item.disambiguation === "earlier" ? "Earlier" : "Later"} occurrence ({utcOffsetLabel(item.utcOffsetMinutes)})
      </label>)}
    </fieldset>
  </Modal>;
}
