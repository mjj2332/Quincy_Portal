// Vendored via `shadcn add toggle` (base-nova) through the `tmp/ReUI-Test-1` sandbox (#491, the
// `rich-text-editor-2` toolbar's only new primitive). Edits, none a behaviour change:
// 1. `import { cn } from "cn"` -> `@/lib/utils`, as every vendored primitive here does.
// 2. `dark:aria-invalid:ring-destructive/40` removed: `styles/tokens/reui.css` rebinds `dark` to a
//    `.dark` class nothing sets (`reui-skin.guard.test.ts`).
// 3. `size="sm"` gains `max-[721px]:h-11 max-[721px]:min-w-11`: the 44px touch target at <=721px
//    (`quincy/icon-button.tsx`'s contract). Neither `Toggle sm` nor `Button icon-sm` (`size-7`) had it.
// 4. `outline-none` and `focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50` removed: `outline-none` is dead
//    (a layered utility loses to the unlayered `tokens/base.css` `:focus-visible` outline, as in
//    `reui/button.tsx` divergence 4) and the ring would be a second indicator beside that outline.
// 5. `disabled:opacity-50` -> `disabled:text-muted-foreground`: a disabled control is colour, never an
//    opacity multiplier on an already-quiet colour (`quincy/icon-button.tsx`, TB8-06/TB8-07 contrast).
// 6. #916 (frame 3a `.kchip`): `variant="chip"` + `size="chip"`, the Dashboard Stage key chip
//    (`quincy/StageKeyRow.tsx`): a 32px pill on the surface paper with a hairline edge, 14px regular
//    label, 8px swatch gap; pressed keeps the surface (the frame draws every in-scope Stage that way),
//    unpressed falls back to the canvas with the secondary text role. 44px at <=721px and on a coarse
//    pointer. Scoped: no other caller passes these, so every existing Toggle renders as before.
// 7. #920 (frame 3b `.seg2 button`): `variant="segment"` + `size="segment"`, a segment of the Dashboard
//    Timeline's "Colour by: Stage | People" `ToggleGroup` (`ProductionGanttColourBy.tsx`; the group's track
//    is `toggle-group.tsx` item 2): a 30px, 14px regular segment in the secondary text role on the
//    group's paper-100 track; pressed lifts to the surface paper in ink with the whisper shadow token.
//    44px at <=721px and on a coarse pointer. Scoped: no other caller passes these.
// 8. #916 review (2026-10-18): items 6 and 7 dropped their `data-[state=on]:bg-card`: Base UI's Toggle marks
//    pressed with `aria-pressed` / `data-pressed`, never `data-state`, so it never applied (`aria-pressed:` carries
//    it). Item 6's pill and size are named once (`CHIP_PILL`, `CHIP_SIZE`) and exported as
//    `toggleChipDisplayClassName`: the same pill, drawn pressed, for a display-only chip that is not a control
//    (`ProductionGanttColourBy.tsx`'s People key chip, owner decision D6), so the two never drift.
// 9. #916 design review (should-fix 3): item 6's chip takes an ink edge while `data-picked` is set
//    (`data-picked:border-foreground`): a Stage the Filter's Stage rule keeps. Pressed alone is the surface paper on the
//    canvas, which read ~1.03:1 against an unpressed chip. Scoped to `variant="chip"`; the display-only People chip
//    (`toggleChipDisplayClassName`) is never picked, so it keeps the hairline.
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/** Item 6's chip pill and size (frame 3a `.kchip`), shared with `toggleChipDisplayClassName`. */
const CHIP_PILL = "gap-2 rounded-full border border-border font-normal"
const CHIP_SIZE = "h-8 ps-2 pe-3 max-[721px]:h-11 pointer-coarse:h-11"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent hover:bg-muted",
        chip: `${CHIP_PILL} bg-transparent text-foreground-secondary hover:bg-muted hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground data-picked:border-foreground`,
        segment: "rounded-[var(--radius-sm)] bg-transparent font-normal text-foreground-secondary hover:bg-transparent hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[var(--shadow-sm)]",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 max-[721px]:h-11 max-[721px]:min-w-11 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        chip: CHIP_SIZE,
        segment: "h-7.5 px-3.5 max-[721px]:h-11 pointer-coarse:h-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/**
 * Item 8: the chip's pressed look on a display-only element (not a control: no hover, no pressed state).
 * Layout and type match the Toggle base; the pill and size are item 6's own.
 */
const toggleChipDisplayClassName = cn(
  "inline-flex items-center whitespace-nowrap text-sm",
  CHIP_PILL,
  CHIP_SIZE,
  "bg-card text-foreground"
)

export { Toggle, toggleVariants, toggleChipDisplayClassName }
