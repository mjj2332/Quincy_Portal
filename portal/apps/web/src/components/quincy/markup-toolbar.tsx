import type { ReactNode, Ref } from "react";
import { ArrowUpRightIcon, MinusIcon, PencilIcon, Redo2Icon, SquareIcon, Trash2Icon, Undo2Icon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
import { ButtonGroup } from "@/components/reui/button-group";
import { RadioGroup, RadioGroupItem } from "@/components/reui/radio-group";
import { Separator } from "@/components/reui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/reui/toggle-group";
import type { MarkupTool, MarkupToolKind } from "@/lib/use-markup";
import { Eyebrow } from "./Eyebrow";

/**
 * The markup toolbar shared by the photo Lightbox and (in 6b) the video note (#741 slice 6s-ui): one floating pill holding
 * tools, pen colours, stroke widths, Undo, Redo, Clear and a host slot. Every control is one tap: no mode swap, no popover.
 * Presentational only; the host owns the tool state, the history and the key handling (the shortcuts are written on the
 * buttons as `aria-keyshortcuts`, and the host shows them in its hint pill).
 *
 * - The tools are one choice, so they are a radio group (one tab stop, arrow keys, aria-checked). Colours and widths are
 *   toggle groups with a single value; clicking the pressed one is ignored, so neither can be left empty.
 * - Targets are 28px, and 44px on a phone (`max-[721px]`) and on a coarse pointer above it (`min-[721px]:pointer-coarse`,
 *   scoped so the two never compete in the cascade: docs/lessons.md, "A touch phone matches `pointer-coarse:` too").
 * - `compact` (the host's phone band) packs two rows: tools and history, then colours and one width button that
 *   cycles 2 -> 4 -> 7. Label and host slot follow on a last row.
 * - `collapsed` (video's rest state, #741 6b-ui) swaps the whole pill for one "Draw" button in the same place; `onExpand` runs the host's enter-draw.
 *   Photo never collapses. The button carries the pill's `drawbar` class and the toolbar's test id with a `-draw` suffix.
 * - No tooltips: a Base UI tooltip closes on Escape with a document-level stopPropagation, which would make one Escape
 *   close the tip instead of ending drawing. The title attribute and the host's hint pill carry the shortcuts.
 */
// The hex values stay literals: they are pen ink applied to the photograph, not interface chrome (design tokens §1.5).
export const PEN_COLOUR_NAMES = {
  "#e64b3c": "Red", "#f0a020": "Amber", "#3f8f5a": "Green",
  "#2f6df0": "Blue", "#ffffff": "White", "#0a0a0a": "Black",
} as const;
export const MARKUP_WIDTHS = [2, 4, 7] as const;

const TOOLS: { kind: MarkupToolKind; label: string; Icon: LucideIcon }[] = [
  { kind: "freehand", label: "Pen", Icon: PencilIcon },
  { kind: "arrow", label: "Arrow", Icon: ArrowUpRightIcon },
  { kind: "line", label: "Line", Icon: MinusIcon },
  { kind: "rectangle", label: "Rectangle", Icon: SquareIcon },
];

/** 28px; 44px on a phone and on a touch tablet. */
const TARGET = "h-7 min-w-7 max-[721px]:h-11 max-[721px]:min-w-11 min-[721px]:pointer-coarse:h-11 min-[721px]:pointer-coarse:min-w-11";
const GROUP = "inline-flex w-auto items-center gap-[var(--space-1)]";
/** The selection ring is a box-shadow on the inner circle (a --card gap, then a --ring band), so the outline stays free for the global keyboard :focus-visible ring. The pressed fill is cleared: the ring alone shows the selection. */
const SWATCH_ITEM = "group/swatch aria-pressed:bg-transparent";
const SWATCH_RING = "group-aria-pressed/swatch:shadow-[0_0_0_2px_var(--card),0_0_0_calc(2px+var(--border-width-bold))_var(--ring)]";
/** The selected chip's fill (--secondary) is ~1.17:1 against the pill, so it also carries an inset --border-hover hairline. */
const SELECTED_HAIRLINE_CHECKED = "data-checked:shadow-[inset_0_0_0_var(--border-width-hair)_var(--border-hover)]";
const SELECTED_HAIRLINE_PRESSED = "aria-pressed:shadow-[inset_0_0_0_var(--border-width-hair)_var(--border-hover)]";
const COMPACT_BUTTON = "w-11 min-w-11 px-0 min-[721px]:pointer-coarse:min-w-11";
/** The default button is 38px; a touch tablet gets 44px. */
/** Undo, Redo and Clear are icon-only at every width (at 1280 the worded form overflowed the pill's 868px budget): 38px square, 44px on a phone or a touch tablet. */
const HISTORY_BUTTON = "w-[38px] min-w-[38px] px-0 max-[721px]:w-11 max-[721px]:min-w-11 min-[721px]:pointer-coarse:w-11 min-[721px]:pointer-coarse:min-w-11";
const COARSE_BUTTON = "min-[721px]:pointer-coarse:min-h-11";

export interface MarkupToolbarProps {
  /** The eyebrow ("Markup", "Editing drawing"); null leaves it out. */
  label: ReactNode;
  tool: MarkupTool;
  onToolChange: (kind: MarkupToolKind) => void;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** The host's phone form. */
  compact?: boolean;
  /** The host's own controls (Cancel / Save, Done). */
  trailing?: ReactNode;
  /** Video's rest state: one "Draw" button instead of the pill. */
  collapsed?: boolean;
  /** Pressing "Draw" in the collapsed state. */
  onExpand?: () => void;
  /** Disables the collapsed "Draw" button (the frame is being confirmed). */
  expanding?: boolean;
  /** The collapsed button's ref, so a host can return focus to it. */
  drawRef?: Ref<HTMLButtonElement>;
  testId?: string;
  className?: string;
}

export function MarkupToolbar({ label, tool, onToolChange, onColorChange, onWidthChange, canUndo, canRedo, canClear, onUndo, onRedo, onClear, compact = false, trailing, collapsed = false, onExpand, expanding = false, drawRef, testId, className }: MarkupToolbarProps) {
  if (collapsed) {
    return (
      <Button
        ref={drawRef} type="button" variant="outline" aria-label="Draw" data-testid={testId ? `${testId}-draw` : undefined} disabled={expanding} onClick={onExpand}
        className={cn("drawbar pointer-events-auto bg-card shadow-[var(--shadow-lg)] min-[721px]:pointer-coarse:min-h-11", className)}
      ><PencilIcon aria-hidden="true" className="size-4" />Draw</Button>
    );
  }

  const tools = (
    <RadioGroup key="tools" aria-label="Markup tool" className={GROUP} value={tool.kind} onValueChange={(value) => { if (value !== tool.kind) onToolChange(value as MarkupToolKind); }}>
      {TOOLS.map(({ kind, label: name, Icon }) => (
        <RadioGroupItem
          key={kind} value={kind} aria-label={name} title={name} render={<button type="button" />} nativeButton
          className={cn(
            // size-auto first: tailwind-merge lets a later `size-*` drop an earlier `h-*`, and TARGET must keep its h-7.
            "aspect-auto size-auto", TARGET, "items-center justify-center rounded-[var(--radius-sm)] border-0 bg-transparent text-foreground-secondary",
            "cursor-pointer hover:bg-secondary data-checked:border-0 data-checked:bg-secondary data-checked:text-foreground", SELECTED_HAIRLINE_CHECKED,
          )}
        ><Icon aria-hidden="true" className="size-4" /></RadioGroupItem>
      ))}
    </RadioGroup>
  );

  const colours = (
    <ToggleGroup key="colours" aria-label="Pen colour" className={GROUP} spacing={1} value={[tool.color]} onValueChange={(value) => { const next = value[0]; if (next && next !== tool.color) onColorChange(next); }}>
      {(Object.keys(PEN_COLOUR_NAMES) as (keyof typeof PEN_COLOUR_NAMES)[]).map((color) => (
        <ToggleGroupItem key={color} value={color} size="sm" aria-label={PEN_COLOUR_NAMES[color]} title={PEN_COLOUR_NAMES[color]} className={cn(TARGET, "rounded-full px-0", SWATCH_ITEM)}>
          <span aria-hidden="true" style={{ background: color }} className={cn("block h-[19px] w-[19px] rounded-full border border-solid border-[length:var(--border-width-hair)] border-border", SWATCH_RING)} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );

  const nextWidth = MARKUP_WIDTHS[(MARKUP_WIDTHS.indexOf(tool.width as (typeof MARKUP_WIDTHS)[number]) + 1) % MARKUP_WIDTHS.length]!;
  const widths = compact
    ? (
      <Button key="widths" type="button" variant="outline" className={cn(COARSE_BUTTON, COMPACT_BUTTON)} aria-label={`Stroke width, ${tool.width} pixels`} title="Stroke width" onClick={() => onWidthChange(nextWidth)}>
        <span aria-hidden="true" style={{ width: tool.width + 3, height: tool.width + 3 }} className="block rounded-full bg-foreground" />
      </Button>
    )
    : (
      <ToggleGroup key="widths" aria-label="Stroke width" className={GROUP} spacing={1} value={[String(tool.width)]} onValueChange={(value) => { const next = Number(value[0]); if (value[0] && next !== tool.width) onWidthChange(next); }}>
        {MARKUP_WIDTHS.map((width) => (
          <ToggleGroupItem key={width} value={String(width)} size="sm" aria-label={`${width} pixels`} title={`${width} pixels`} className={cn(TARGET, "px-0 aria-pressed:bg-secondary hover:bg-secondary", SELECTED_HAIRLINE_PRESSED)}>
            <span aria-hidden="true" style={{ width: width + 3, height: width + 3 }} className="block rounded-full bg-foreground" />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );

  const historyButton = (name: string, Icon: LucideIcon, disabled: boolean, onClick: () => void, extra: { shortcuts?: string; title: string }) => (
    <Button key={name} type="button" variant="outline" className={cn(COARSE_BUTTON, HISTORY_BUTTON)} aria-label={name} title={extra.title} aria-keyshortcuts={extra.shortcuts} disabled={disabled} onClick={onClick}>
      <Icon aria-hidden="true" className="size-4" />
    </Button>
  );
  const history = (
    <ButtonGroup key="history" role="group" aria-label="History" className="inline-flex w-auto">
      {historyButton("Undo", Undo2Icon, !canUndo, onUndo, { shortcuts: "Control+Z Meta+Z", title: "Undo (⌘Z)" })}
      {historyButton("Redo", Redo2Icon, !canRedo, onRedo, { shortcuts: "Control+Shift+Z Meta+Shift+Z Control+Y", title: "Redo (⇧⌘Z)" })}
      {historyButton("Clear", Trash2Icon, !canClear, onClear, { title: "Clear all markup (undoable)" })}
    </ButtonGroup>
  );

  const divider = (key: string) => <Separator key={key} orientation="vertical" className="h-6 max-[721px]:hidden" />;
  const groups = compact ? [tools, history, colours, widths] : [tools, divider("d1"), colours, divider("d2"), widths, divider("d3"), history];

  return (
    <div
      className={cn(
        "drawbar pointer-events-auto flex w-max max-w-[calc(100%-32px)] flex-wrap items-center justify-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]",
        // A pill wraps to several rows on a phone; a stadium radius then clips the corner controls, so compact takes the large radius.
        compact ? "rounded-[var(--radius-lg)]" : "rounded-[var(--radius-pill)]",
        "border border-solid border-[length:var(--border-width-hair)] border-border bg-card py-[var(--space-2)] pr-[var(--space-2)] pl-[var(--space-4)] text-foreground shadow-[var(--shadow-lg)]",
        "max-[721px]:max-w-[calc(100%-16px)] max-[721px]:gap-[var(--space-2)] max-[721px]:pl-[var(--space-2)]",
        className,
      )}
      data-testid={testId}
    >
      {label != null && <Eyebrow className={cn("text-on-inverse-muted", compact && "order-last")}>{label}</Eyebrow>}
      {groups}
      {trailing != null && <div className={cn("inline-flex items-center gap-[var(--space-2)]", compact && "order-last")}>{trailing}</div>}
    </div>
  );
}
