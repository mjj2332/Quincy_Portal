import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { ArrowRightFromLineIcon, ChevronDownIcon, GlobeIcon, LockIcon, PaperclipIcon, PencilIcon, SendIcon, XIcon, type LucideIcon } from "lucide-react";
import type { VideoNoteVisibility } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { rangeStep, type NoteMarks } from "@/lib/video-note-marks";
import { Button } from "@/components/reui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/reui/dropdown-menu";
import { Spinner } from "@/components/reui/spinner";
import { NOTE_TARGET, NOTE_TARGET_PHONE, NOTE_TOOL, NoteDrawRow, keepFocus, type NoteDrawRowProps } from "./NoteDrawRow";

/**
 * The note composer box (#927, prototype `note-composer`: C2, C4, C5, C6, G1, R1, E1, P1; F1 floating). One box, after Frame.io's comment
 * field, for every place a note or a reply is written on a Video: row 1 is the anchor chip inline before the text, then the media strip; the
 * last row is the tools on the left (in/out, paperclip, pen) and visibility plus a round Send on the right. While the pen is on, the drawing
 * row (`NoteDrawRow`) takes the tool row's place, and visibility and Send hide until ‹.
 *
 * Variants: `staff` (visibility menu), `guest` (no visibility: a guest's note is always public), `reply` (paperclip and Send only: a reply
 * inherits its note's anchor and visibility; no visible Cancel, Esc and the reply toggle dismiss it), `edit` (a fixed visibility label,
 * Cancel and Save). `phone` gives every target 44px; `floating` is Full screen's box over the film.
 *
 * Presentational and Guest-safe: no `lib/api`, no form store. The field (the rich editor) and the strip are slots; every state is a prop.
 * The box's text region is the scroller (seven 24px lines, then it scrolls), so the field inside should not scroll on its own, and the chip
 * floats so the first line of text runs beside it.
 *
 * Escape inside the box (not in a portaled popup: those close themselves) ends drawing first, else goes to `onEscape`; a handled one is
 * `preventDefault`ed, so the screen's own Escape (Full screen) can skip it. A press on in/out, the chip's ×, Send, Cancel and Save keeps the
 * focus in the field, so a phone keeps its keyboard (#879 fix). The pen does not: it lowers the keyboard on purpose (P4).
 */

/** A control the host can lock, with the reason as its title (D4: "editing the range locks the pen", and the reverse). */
export interface NoteControl { disabled?: boolean; reason?: string }
export type NoteAnchorChip =
  /** The point the note is anchored to. `following`: it still follows the playhead (the note has not started). */
  | { kind: "point"; at: string; following: boolean }
  /** In → Out. `toLive`: only In is marked, so Out is the playhead. */
  | { kind: "range"; from: string; to: string; toLive: boolean; onClear: () => void; clearDisabled?: boolean };
export interface NoteSendControl { label: string; onSend: () => void; disabled: boolean; reason?: string; pending?: boolean }
export interface NoteSaveControl { onSave: () => void; onCancel: () => void; disabled: boolean; reason?: string; pending?: boolean; saveLabel?: string }

interface BaseProps {
  /** The form's accessible name ("Add a note", "Reply", "Edit note"). */
  label: string;
  /** The text field (the rich editor). */
  field: ReactNode;
  /** The media strip under the text. */
  strip?: ReactNode;
  /** A problem or lock line above the tools (too long, a failed post, "Finish or cancel the open edit first"). */
  notice?: ReactNode;
  attach: { onPick: () => void } & NoteControl;
  phone?: boolean;
  floating?: boolean;
  onEscape?: () => void;
  testId?: string;
  className?: string;
  /** Extra classes and attributes for the text region (the phone sheet clamps it to the film's floor and marks it). */
  textClassName?: string;
  textAttributes?: Record<`data-${string}`, string>;
  formAttributes?: Record<`data-${string}`, string>;
}
interface AnchoredProps {
  chip: NoteAnchorChip;
  /** The draft has a drawing: the chip carries the pencil. */
  drawn?: boolean;
  range: { marks: NoteMarks; onPress: (step: "in" | "out" | "clear") => void } & NoteControl;
  /** Absent: no pen (a guest on a Project with drawing off). */
  pen?: { onPress: () => void } & NoteControl;
  /** Drawing is on: the row the tools give way to. */
  draw?: Omit<NoteDrawRowProps, "phone"> | null;
}
export type NoteComposerBoxProps =
  | (BaseProps & AnchoredProps & { variant: "staff"; visibility: { value: VideoNoteVisibility; onChange: (value: VideoNoteVisibility) => void; disabled?: boolean }; send: NoteSendControl })
  | (BaseProps & AnchoredProps & { variant: "guest"; send: NoteSendControl })
  | (BaseProps & { variant: "reply"; send: NoteSendControl })
  | (BaseProps & AnchoredProps & { variant: "edit"; visibility: VideoNoteVisibility; save: NoteSaveControl });

const VISIBILITY: Record<VideoNoteVisibility, { label: string; Icon: LucideIcon; description: string }> = {
  internal: { label: "Internal", Icon: LockIcon, description: "Studio only — never shown on the client link." },
  public: { label: "Client-visible", Icon: GlobeIcon, description: "Shown to the client on the review link." },
};
const RANGE_TITLE = { in: "Set in (I)", out: "Set out (O)", clear: "Clear in / out" } as const;
/** Marks a control whose press keeps the field's focus; the box applies it in the capture phase, ahead of the control's own handlers (Base UI drops a locked button's `onMouseDown`). */
const KEEP_FOCUS = { "data-keep-focus": "" } as const;
const keepFocusOnPress = (event: { target: EventTarget; preventDefault: () => void }) => { if (event.target instanceof Element && event.target.closest("[data-keep-focus]")) keepFocus(event); };
/** A hairline at the prototype's softened border (`color-mix(--border 60%)`). */
const SOFT_BORDER = "border-[color-mix(in_srgb,var(--border)_60%,transparent)]";
/** The anchor chip (prototype `.cmp-chip`, quincy.css `.tc-chip`): small mono in the caution tint, floated before the first line and centred on its 24px. */
const CHIP = "float-start me-[var(--space-2)] mt-0.5 inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] bg-[color-mix(in_oklch,var(--warning-foreground)_18%,transparent)] px-[var(--space-2)] py-[var(--space-1)] text-warning-foreground [font:var(--weight-regular)_var(--text-xs)/1_var(--font-mono)] tabular-nums whitespace-nowrap select-none";
/** A text control in the row (Cancel, Save): sentence case in the label type, 32px; 44px on a phone. */
const TEXT_CONTROL = "normal-case tracking-normal [font:var(--type-label)] transition-colors";

/** Locked with a reason: still focusable (the title is the reason, and a disabled button takes no hover), but inert. */
const lockProps = (control: NoteControl | undefined) => (control?.disabled ? { disabled: true, ...(control.reason ? { focusableWhenDisabled: true } : {}) } : {});

function AnchorChip({ chip, drawn, phone }: { chip: NoteAnchorChip; drawn: boolean; phone: boolean }) {
  const pencil = drawn ? <PencilIcon aria-hidden="true" className="size-3" strokeWidth={2.25} /> : null;
  if (chip.kind === "point") {
    return <span data-testid="note-composer-chip" aria-live="off" className={CHIP} title={chip.following && !drawn ? "Follows the playhead until you start the note" : "The note is stamped here"}>
      {pencil}<span className="sr-only">{drawn ? "Note with a drawing at " : "Note at "}</span>{chip.at}
    </span>;
  }
  const spoken = `Note from ${chip.from}${chip.toLive ? ", Out follows the playhead" : ` to ${chip.to}`}${drawn ? ", with a drawing" : ""}: `;
  return <span data-testid="note-composer-chip" aria-live="off" className={CHIP}>
    {pencil}<span className="sr-only">{spoken}</span>
    <span aria-hidden="true">{chip.from} → <span data-testid={chip.toLive ? "note-composer-chip-live" : undefined} className={chip.toLive ? "opacity-60" : undefined}>{chip.to}</span></span>
    <Button
      type="button" variant="ghost" size="icon-xs" aria-label="Clear in and out" title="Clear in / out" disabled={chip.clearDisabled === true} {...KEEP_FOCUS} onClick={chip.onClear}
      // 16px in the chip; a phone's hit area grows to 40px around it with a transparent pseudo-element.
      className={cn("-me-1 size-4 rounded-[var(--radius-xs)] border-0 !text-warning-foreground hover:bg-[color-mix(in_oklch,var(--warning-foreground)_25%,transparent)] hover:!text-warning-foreground transition-colors [&_svg:not([class*='size-'])]:size-3", phone && "relative after:absolute after:-inset-[var(--space-3)] after:content-['']")}
    ><XIcon aria-hidden="true" strokeWidth={2.25} /></Button>
  </span>;
}

export function NoteComposerBox(props: NoteComposerBoxProps) {
  const { variant, label, field, strip, notice, attach, phone = false, floating = false, onEscape, testId = "note-composer", className, textClassName, textAttributes, formAttributes } = props;
  const anchored = variant === "reply" ? null : props;
  const draw = anchored?.draw ?? null;
  const target = phone ? NOTE_TARGET_PHONE : NOTE_TARGET;
  const tool = cn(NOTE_TOOL, target);
  const send = variant === "edit" ? null : props.send;
  const save = variant === "edit" ? props.save : null;
  const blocked = send ? send.disabled : save!.disabled;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    if (send) send.onSend(); else save!.onSave();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A portaled popup (the colour palette, the visibility menu) bubbles its keys here through React; it closes itself.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (draw) { event.preventDefault(); draw.onDone(); return; }
    if (onEscape) { event.preventDefault(); onEscape(); }
  };

  const step = anchored ? rangeStep(anchored.range.marks) : "in";
  const marked = anchored ? anchored.range.marks.in !== null || anchored.range.marks.out !== null : false;
  const tools = <div data-testid="note-composer-tools" className="-ms-[var(--space-2)] flex min-w-0 items-center gap-0.5">
    {anchored && <Button
      type="button" variant="ghost" size="icon" aria-label="In and out points" aria-pressed={marked} aria-keyshortcuts="I O"
      title={anchored.range.disabled && anchored.range.reason ? anchored.range.reason : RANGE_TITLE[step]}
      className={tool} {...lockProps(anchored.range)} {...KEEP_FOCUS} onClick={() => { anchored.range.onPress(step); }}
    ><ArrowRightFromLineIcon aria-hidden="true" /></Button>}
    <Button type="button" variant="ghost" size="icon" aria-label="Add photos or videos" title={attach.disabled && attach.reason ? attach.reason : "Add photos or videos"} className={tool} {...lockProps(attach)} onClick={attach.onPick}>
      <PaperclipIcon aria-hidden="true" />
    </Button>
    {anchored?.pen && <Button type="button" variant="ghost" size="icon" aria-label="Draw on the frame" title={anchored.pen.disabled && anchored.pen.reason ? anchored.pen.reason : "Draw on the frame"} className={tool} {...lockProps(anchored.pen)} onClick={anchored.pen.onPress}>
      <PencilIcon aria-hidden="true" />
    </Button>}
    <span className="min-w-0 flex-1" />
    {variant === "staff" && <VisibilityMenu value={props.visibility.value} onChange={props.visibility.onChange} disabled={props.visibility.disabled === true} phone={phone} />}
    {variant === "edit" && <FixedVisibility value={props.visibility} phone={phone} />}
    {send && <Button
      type="submit" size="icon-round" aria-label={send.label} title={send.disabled && send.reason ? send.reason : variant === "reply" ? "Send reply (⌘↵)" : "Post (⌘↵)"} aria-keyshortcuts="Meta+Enter Control+Enter"
      // icon-round is the 44px circle (dimming only its glyph when disabled); off a phone it is the prototype's 32px, 44px on a touch tablet. A lock with a reason is aria-disabled, so it dims the same way.
      className={cn("ms-[var(--space-1)] aria-disabled:[&_svg]:opacity-50", phone ? "size-11" : NOTE_TARGET)}
      {...(send.disabled ? { disabled: true, focusableWhenDisabled: true } : {})} {...KEEP_FOCUS}
    >{send.pending ? <Spinner aria-hidden="true" role={undefined} aria-label={undefined} /> : <SendIcon aria-hidden="true" className={phone ? "size-4.5" : "size-4"} />}</Button>}
    {save && <>
      <Button type="button" variant="ghost" className={cn(TEXT_CONTROL, "ms-[var(--space-1)] px-[var(--space-2)] text-foreground-secondary hover:bg-[color-mix(in_oklch,var(--surface-sunken),var(--foreground)_10%)]", phone ? "min-h-11" : "min-h-8")} disabled={save.pending === true} {...KEEP_FOCUS} onClick={save.onCancel}>Cancel</Button>
      <Button type="submit" title={save.disabled && save.reason ? save.reason : undefined} className={cn(TEXT_CONTROL, "rounded-[var(--radius-pill)] px-[var(--space-3)]", phone ? "min-h-11" : "min-h-8")} {...lockProps(save)} {...KEEP_FOCUS}>{save.pending ? "Saving…" : save.saveLabel ?? "Save"}</Button>
    </>}
  </div>;

  return <form
    aria-label={label} data-testid={testId} data-variant={variant} data-drawing={draw ? "true" : "false"} data-floating={floating ? "true" : undefined} {...formAttributes}
    className={cn(
      "relative",
      floating ? "p-0" : variant === "reply" ? "ps-[var(--space-3)] pe-[var(--space-3)] pt-[var(--space-1)] pb-[var(--space-3)]" : cn("border-t border-border bg-card", phone ? "p-[var(--space-2)]" : "p-[var(--space-3)]"),
      className,
    )}
    onSubmit={submit}
  >
    <div
      data-testid="note-composer-box" onKeyDown={onKeyDown} onPointerDownCapture={keepFocusOnPress} onMouseDownCapture={keepFocusOnPress}
      className={cn(
        "relative flex flex-col gap-[var(--space-2)] rounded-[var(--radius-lg)] border border-solid border-[length:var(--border-width-hair)] pt-[var(--space-2)] pe-[var(--space-2)] pb-[var(--space-1)] ps-[var(--space-3)] transition-colors focus-within:border-border-hover",
        SOFT_BORDER,
        floating ? "bg-[color-mix(in_srgb,var(--card)_92%,transparent)] shadow-[var(--shadow-lg)] backdrop-blur-md" : "bg-surface-sunken",
      )}
    >
      <div data-testid="note-composer-text" {...textAttributes} className={cn("relative min-h-[var(--space-5)] max-h-[calc(var(--space-5)*7)] overflow-y-auto leading-[var(--space-5)] text-foreground", phone ? "text-[length:var(--text-base)]" : "text-[length:var(--text-sm)]", textClassName)}>
        {anchored && <AnchorChip chip={anchored.chip} drawn={anchored.drawn === true} phone={phone} />}
        {field}
      </div>
      {strip}
      {notice}
      {draw ? <NoteDrawRow {...draw} phone={phone} /> : tools}
    </div>
  </form>;
}

function VisibilityMenu({ value, onChange, disabled, phone }: { value: VideoNoteVisibility; onChange: (value: VideoNoteVisibility) => void; disabled: boolean; phone: boolean }) {
  const current = VISIBILITY[value];
  return <DropdownMenu>
    <DropdownMenuTrigger
      disabled={disabled}
      render={<Button type="button" variant="ghost" aria-label={`Who can see this note: ${current.label}`} title="Who can see this note"
        className={cn(TEXT_CONTROL, "gap-[var(--space-2)] rounded-[var(--radius-pill)] border-[color-mix(in_srgb,var(--border)_70%,transparent)] ps-[var(--space-3)] pe-[var(--space-2)] text-foreground hover:bg-[color-mix(in_oklch,var(--surface-sunken),var(--foreground)_10%)] aria-expanded:bg-[color-mix(in_oklch,var(--surface-sunken),var(--foreground)_10%)]", phone ? "min-h-11" : "min-h-8 min-[721px]:pointer-coarse:min-h-11")} />}
    >
      <current.Icon aria-hidden="true" className="size-3.5" />{current.label}<ChevronDownIcon aria-hidden="true" className="size-3" />
    </DropdownMenuTrigger>
    {/* A click inside the portaled menu must not reach a note card that renders the composer (docs/lessons.md "A portaled menu's click bubbles to the card that renders it (#901)"). */}
    <DropdownMenuContent side="top" align="end" sideOffset={6} data-testid="note-composer-visibility-menu" className="w-[calc(var(--space-11)+var(--space-7)+var(--space-6))] max-w-[calc(100vw-var(--space-6))] rounded-[var(--radius-md)] p-[var(--space-1)]" onClick={(event) => { event.stopPropagation(); }}>
      <DropdownMenuRadioGroup aria-label="Who can see this note" value={value} onValueChange={(next) => { if (next === "internal" || next === "public") onChange(next); }}>
        {(Object.keys(VISIBILITY) as VideoNoteVisibility[]).map((key) => {
          const option = VISIBILITY[key];
          // The item's two lines (C5's `.cmp-opt`): the icon, the name over its description, the check at the end. The removed hint line lives here.
          return <DropdownMenuRadioItem key={key} value={key} closeOnClick className={cn("items-start gap-[var(--space-3)] py-[var(--space-2)] ps-[var(--space-3)] pe-[var(--space-8)]", phone && "min-h-11")}>
            <option.Icon aria-hidden="true" className="mt-0.5" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[length:var(--text-sm)] leading-[var(--space-5)]">{option.label}</span>
              <span className="text-foreground-secondary [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]">{option.description}</span>
            </span>
          </DropdownMenuRadioItem>;
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Edit (E1): visibility can't change once posted, so it is a label, dashed so it does not read as a control. */
function FixedVisibility({ value, phone }: { value: VideoNoteVisibility; phone: boolean }) {
  const current = VISIBILITY[value];
  return <span data-testid="note-composer-visibility" title="Visibility can't change once posted" className={cn("inline-flex items-center gap-[var(--space-2)] rounded-[var(--radius-pill)] border border-dashed border-[color-mix(in_srgb,var(--border)_70%,transparent)] px-[var(--space-3)] text-foreground-secondary [font:var(--type-label)]", phone ? "min-h-11" : "min-h-8")}>
    <current.Icon aria-hidden="true" className="size-3.5" />{current.label}
  </span>;
}
