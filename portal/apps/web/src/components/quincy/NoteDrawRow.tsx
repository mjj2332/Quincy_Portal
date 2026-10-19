import { useRef, useState, type Ref } from "react";
import { ChevronLeftIcon, Redo2Icon, TrashIcon, Undo2Icon, type LucideIcon } from "lucide-react";
import type { MarkupToolKind } from "@/lib/use-markup";
import { cn } from "@/lib/utils";
import { SCROLL_FADE_MASK_CLASSES, useScrollFade } from "@/lib/use-scroll-fade";
import { Button } from "@/components/reui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/reui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/reui/radio-group";
import { Separator } from "@/components/reui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/reui/toggle-group";
import { MARKUP_TOOLS, PEN_COLOUR_NAMES, SELECTED_HAIRLINE_CHECKED, SWATCH_ITEM, SWATCH_RING } from "./markup-toolbar";

/**
 * The note composer's drawing row (#927, prototype `note-composer` frames C6, C7, P4, P5): while the pen is on it takes the place of the
 * composer's tool row, as Frame.io's does. ‹ Done | Pen, Arrow, Line, Rectangle | colour | Undo, Redo, Clear. The stroke width is fixed
 * (the host draws new strokes at `DEFAULT_PEN`'s 4), so there is no width control. On a phone Clear moves into the colour popover, under the
 * swatches, so every target in the row stays 44px; where the row is still wider than the box it scrolls sideways (never wraps, never shrinks).
 *
 * Presentational and Guest-safe: the host owns the tool, the colour, the history and the keys (Esc and ⌘Z are the host's; the shortcuts are
 * written on the buttons). A press on the row keeps the focus where it is, so a phone that raised its keyboard over the drawing (a tap on
 * the text, P4) keeps it. No tooltips, for the reason `markup-toolbar.tsx` gives: a Base UI tooltip eats the Escape that ends drawing.
 */
export interface NoteDrawRowProps {
  tool: MarkupToolKind;
  color: string;
  onToolChange: (kind: MarkupToolKind) => void;
  onColorChange: (color: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** ‹: drawing ends (the strokes stay in the draft). */
  onDone: () => void;
  /** The phone form: 44px targets, no separators, Clear in the colour popover. */
  phone?: boolean;
  /** The host focuses Done when drawing opens, as the shipped toolbar did. */
  doneRef?: Ref<HTMLButtonElement>;
}

/** Keeps the focus where it is: a press on these controls must not take it from the field, or iOS drops the keyboard (#879 fix, §3.4). */
export const keepFocus = (event: { preventDefault: () => void }) => { event.preventDefault(); };
const KEEP_FOCUS = { onPointerDown: keepFocus, onMouseDown: keepFocus } as const;

/**
 * A composer tool (prototype `.cmp-tool`): a quiet glyph button, 32px on a 8px radius, 44px on a phone and on a touch tablet.
 * The hover lift is the box's own sunken ground with a tenth of the ink mixed in (the prototype's ink-600 over ink-700): the inverse
 * `--muted` the ghost variant hovers with IS the box's ground, so it would not show. The pressed state is the chip's caution tint.
 */
export const NOTE_TOOL = "rounded-[var(--radius-md)] border-0 px-0 text-foreground-secondary transition-colors hover:bg-[color-mix(in_oklch,var(--surface-sunken),var(--foreground)_10%)] hover:!text-foreground aria-pressed:bg-[color-mix(in_oklch,var(--warning-foreground)_16%,transparent)] aria-pressed:!text-warning-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:!text-foreground-secondary [&_svg:not([class*='size-'])]:size-4.5";
/** 32px; 44px on a touch tablet (scoped above the phone width: docs/lessons.md "A touch phone matches `pointer-coarse:` too"). */
export const NOTE_TARGET = "size-8 min-[721px]:pointer-coarse:size-11";
/** The phone's 44px, with the prototype's 20px glyph. */
export const NOTE_TARGET_PHONE = "size-11 [&_svg:not([class*='size-'])]:size-5";
/** The checked tool: the lift, full ink, and the toolbar's inset hairline (prototype `[aria-checked=true]`). */
const CHECKED = cn("data-checked:bg-[color-mix(in_oklch,var(--surface-sunken),var(--foreground)_10%)] data-checked:!text-foreground", SELECTED_HAIRLINE_CHECKED);
/** A swatch disc, its paint inline (pen ink applied to the frame, not interface chrome: design tokens §1.5). */
const SWATCH = "block rounded-full border border-solid border-[length:var(--border-width-hair)] border-border";
const SEP = "mx-0.5 h-4.5 bg-[color-mix(in_srgb,var(--border)_70%,transparent)] data-[orientation=vertical]:self-center";

function HistoryButton({ label, title, shortcuts, Icon, disabled, onClick, target }: { label: string; title: string; shortcuts?: string; Icon: LucideIcon; disabled: boolean; onClick: () => void; target: string }) {
  return <Button type="button" variant="ghost" size="icon" aria-label={label} title={title} aria-keyshortcuts={shortcuts} disabled={disabled} className={cn(NOTE_TOOL, target)} {...KEEP_FOCUS} onClick={onClick}>
    <Icon aria-hidden="true" />
  </Button>;
}

export function NoteDrawRow({ tool, color, onToolChange, onColorChange, canUndo, canRedo, canClear, onUndo, onRedo, onClear, onDone, phone = false, doneRef }: NoteDrawRowProps) {
  const [palette, setPalette] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const { fade, onScroll } = useScrollFade(scroller);
  const target = phone ? NOTE_TARGET_PHONE : NOTE_TARGET;
  const sep = (key: string) => (phone ? null : <Separator key={key} orientation="vertical" className={SEP} />);
  const colours = Object.keys(PEN_COLOUR_NAMES) as (keyof typeof PEN_COLOUR_NAMES)[];

  return <div
    ref={scroller} role="toolbar" aria-label="Drawing" data-testid="note-draw-row" data-fade={fade} onScroll={onScroll}
    // The row scrolls rather than wraps (the 44px targets do not fit a narrow phone); the block padding keeps the focus ring inside the scroller's clip.
    className={cn("-my-1 -ms-[var(--space-2)] flex min-w-0 flex-nowrap items-center overflow-x-auto overflow-y-hidden py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0", SCROLL_FADE_MASK_CLASSES)}
  >
    <Button ref={doneRef} type="button" variant="ghost" size="icon" aria-label="Done drawing" title="Done drawing (Esc)" className={cn(NOTE_TOOL, target)} {...KEEP_FOCUS} onClick={onDone}>
      <ChevronLeftIcon aria-hidden="true" />
    </Button>
    {sep("s1")}
    <RadioGroup aria-label="Drawing tool" className="inline-flex w-auto items-center gap-0" value={tool} onValueChange={(value) => { if (value !== tool) onToolChange(value as MarkupToolKind); }}>
      {MARKUP_TOOLS.map(({ kind, label, Icon }) => (
        <RadioGroupItem
          key={kind} value={kind} aria-label={label} title={label} render={<button type="button" />} nativeButton {...KEEP_FOCUS}
          // aspect-auto first: the item's own `size-4 aspect-square` must give way to the target.
          className={cn("aspect-auto items-center justify-center rounded-[var(--radius-md)] border-0 bg-transparent cursor-pointer data-checked:border-0", NOTE_TOOL, target, CHECKED)}
        ><Icon aria-hidden="true" /></RadioGroupItem>
      ))}
    </RadioGroup>
    {sep("s2")}
    <Popover open={palette} onOpenChange={setPalette}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" aria-label="Pen colour" title="Pen colour" className={cn(NOTE_TOOL, target)} />}>
        <span aria-hidden="true" style={{ background: color }} className={cn(SWATCH, phone ? "size-5" : "size-4")} />
      </PopoverTrigger>
      {/* A click inside the portaled palette must not reach a note card that renders the composer (docs/lessons.md "A portaled menu's click bubbles to the card that renders it (#901)"). */}
      <PopoverContent aria-label="Pen colour" side="top" align="start" sideOffset={8} data-testid="note-draw-palette" className="w-auto gap-[var(--space-1)] rounded-[var(--radius-md)] p-[var(--space-2)] shadow-[var(--shadow-md)]" onClick={(event) => { event.stopPropagation(); }}>
        <ToggleGroup aria-label="Pen colours" spacing={0.5} value={[color]} onValueChange={(value) => { const next = value[0]; if (next && next !== color) onColorChange(next); setPalette(false); }}>
          {colours.map((swatch) => (
            <ToggleGroupItem key={swatch} value={swatch} aria-label={PEN_COLOUR_NAMES[swatch]} title={PEN_COLOUR_NAMES[swatch]} className={cn("min-w-0 rounded-[var(--radius-md)] px-0", phone ? "size-11" : "size-8", SWATCH_ITEM)}>
              <span aria-hidden="true" style={{ background: swatch }} className={cn(SWATCH, phone ? "size-5" : "size-4", SWATCH_RING)} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {phone && <Button
          type="button" variant="ghost" disabled={!canClear}
          className="-mx-[var(--space-2)] -mb-[var(--space-2)] min-h-11 justify-start gap-[var(--space-3)] rounded-none rounded-b-[var(--radius-md)] border-t-[color-mix(in_srgb,var(--border)_60%,transparent)] px-[var(--space-3)] normal-case tracking-normal !text-destructive-wash-foreground [font:var(--type-label)] transition-colors"
          onClick={() => { onClear(); setPalette(false); }}
        ><TrashIcon aria-hidden="true" />Clear drawing</Button>}
      </PopoverContent>
    </Popover>
    {sep("s3")}
    <HistoryButton label="Undo" title="Undo (⌘Z)" shortcuts="Control+Z Meta+Z" Icon={Undo2Icon} disabled={!canUndo} onClick={onUndo} target={target} />
    <HistoryButton label="Redo" title="Redo (⇧⌘Z)" shortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" Icon={Redo2Icon} disabled={!canRedo} onClick={onRedo} target={target} />
    {!phone && <HistoryButton label="Clear drawing" title="Clear drawing" Icon={TrashIcon} disabled={!canClear} onClick={onClear} target={target} />}
  </div>;
}
