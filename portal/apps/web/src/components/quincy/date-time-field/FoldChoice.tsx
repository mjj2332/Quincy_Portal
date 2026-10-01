import { useId } from "react";
import { Button } from "@/components/reui/button";
import { ButtonGroup } from "@/components/reui/button-group";
import { FieldDescription } from "@/components/reui/field";
import { utcOffsetLabel } from "@/lib/sydney-time-labels";

export type FoldOption = { disambiguation: "earlier" | "later"; utcOffsetMinutes: number };

/**
 * Earlier / Later: shown only while the chosen Sydney civil minute happens twice (a daylight-saving
 * fall-back). Each option names its UTC offset so the choice is not a guess. Nothing is
 * pre-selected for a newly picked time; Apply stays disabled until one is pressed.
 */
export function FoldChoice({ choices, selected, onSelect, subject }: {
  /** Names the end this choice is for in a range ("Start", "End"); absent in the single-moment forms. */
  subject?: string;
  choices: readonly FoldOption[];
  selected: "earlier" | "later" | undefined;
  onSelect: (choice: "earlier" | "later") => void;
}) {
  const helpId = useId();
  return (
    <div className="grid gap-[var(--space-2)]">
      <FieldDescription id={helpId} className="text-[length:var(--text-xs)]">{subject ? `${subject}: this` : "This"} time happens twice in Sydney. Choose which one.</FieldDescription>
      <ButtonGroup aria-label={subject ? `Which Sydney time, ${subject.toLowerCase()}` : "Which Sydney time"} aria-describedby={helpId} className="w-full">
        {choices.map((choice) => (
          <Button
            key={choice.disambiguation}
            type="button"
            variant="outline"
            className="flex-1 aria-pressed:border-foreground aria-pressed:bg-secondary"
            aria-pressed={selected === choice.disambiguation}
            onClick={() => onSelect(choice.disambiguation)}
          >
            {choice.disambiguation === "earlier" ? "Earlier" : "Later"} ({utcOffsetLabel(choice.utcOffsetMinutes)})
          </Button>
        ))}
      </ButtonGroup>
    </div>
  );
}
