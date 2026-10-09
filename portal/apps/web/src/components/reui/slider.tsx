/**
 * base-nova `slider` (Base UI `@base-ui/react/slider`), vendored through the sandbox (#741 4d-ii,
 * docs/reui-reuse.md): `npx shadcn@latest add slider` in `tmp/ReUI-Test-1`. The video scrubber is its first
 * consumer. Quincy changes to the registry source:
 * - `cn` imports from `@/lib/utils` (the sandbox's `"cn"` alias does not exist here).
 * - Orientation variants read `data-[orientation=…]:` (Base UI emits `data-orientation`, never a bare
 *   `data-horizontal`; see the skin guard).
 * - Track: `h-1 bg-muted` becomes a hairline `h-[2px] rounded-none bg-border` (`--border` is remapped on the inverse surface; `--surface-sunken` is ink-700 there and barely shows on the ink stage) (the Progress bar's
 *   skin). The range and thumb keep the registry's `bg-primary`, which `data-surface="inverse"` remaps to paper on ink
 *   (an `--accent` fill would vanish there: it is ink on every surface).
 * - Thumb: `bg-white` (a dead paint under the skin guard) becomes `bg-primary`; the `ring-ring/50`
 *   focus/hover/active rings are dropped, because Quincy's one focus indicator is the global
 *   `:focus-visible` outline (`styles/tokens/base.css`). Focus lives on the Thumb's hidden input, so the
 *   thumb paints that same outline through `has-[:focus-visible]`.
 * - Control: `min-h-11` on coarse pointers and at <=721px so the whole strip is a 44px drag target.
 * - `thumbProps` (new): forwarded to every Thumb, because `getAriaLabel` / `getAriaValueText` live on the Thumb, not
 *   the Root, and the scrubber needs its timecode as `aria-valuetext`.
 * Registry exports and behaviour are otherwise unchanged (multi-thumb by value array, `thumbAlignment="edge"`).
 */
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbProps,
  ...props
}: SliderPrimitive.Root.Props & { thumbProps?: Omit<SliderPrimitive.Thumb.Props, "className" | "index"> }) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=horizontal]:min-h-6 data-[orientation=horizontal]:pointer-coarse:min-h-11 data-[orientation=horizontal]:max-[721px]:min-h-11 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-none bg-border select-none data-[orientation=horizontal]:h-[2px] data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-[2px]"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            {...thumbProps}
            className="relative block size-3 pointer-coarse:size-4 shrink-0 rounded-full border border-primary bg-primary transition-[color,box-shadow] select-none after:absolute after:-inset-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-2 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
