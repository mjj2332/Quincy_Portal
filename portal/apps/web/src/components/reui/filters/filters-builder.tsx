/**
 * ReUI `@reui/filters` (#255), vendored from `npx shadcn@latest add @reui/filters --yes --path
 * src/components/vendor-255` in the `tmp/ReUI-Test-1` base-nova sandbox (the sandbox install is the
 * source of truth; the ReUI MCP was not available to the installing agent). Mechanical edits, identical
 * in kind across every file of this item (`components/reui/filters/`, `components/reui/cascader/`,
 * `components/reui/spinner.tsx`):
 *
 * 1. Dropped the registry's `"use client"` directive (meaningless in this Vite SPA).
 * 2. `cn` imported from `@/lib/utils` instead of the registry's raw `"cn"` package.
 * 3. Cross-file imports repointed from `@/components/vendor-255/<name>` to this item's real home
 *    (`@/components/reui/filters/<name>`, `@/components/reui/cascader/<name>`,
 *    `@/components/reui/spinner`), and `@/components/ui/<name>` to Quincy's own adapted copies in
 *    `@/components/reui/<name>` (`button`, `button-group`, `dropdown-menu`, `input`, `popover`,
 *    `scroll-area`, `separator`, `tooltip` — the vendored duplicates of those were NOT copied).
 *
 * Left out of the install on purpose: `cascader-virtual.tsx` (imports `@tanstack/react-virtual`, a
 * new production dependency — see `filters-builder.tsx`), `cascader-columns.tsx` (imported only by
 * `cascader-virtual.tsx`), and `filters-date.tsx` (nothing imports it).
 *
 * File-specific edits:
 * - QUINCY ADDITION (#428 design review D2), additive: `FiltersBuilder` takes `align?: "start" | "center" | "end"` (default `"start"`, upstream's hard-coded value), passed to the field picker's `PopoverContent`, so a trigger near the page's right edge can open its menu inward. Omitted, it renders exactly as upstream.
 * - TRIM (no new production dependency): the field picker rendered `CascaderVirtualItems` from `cascader-virtual.tsx`, which needs `@tanstack/react-virtual`. It now renders `CascaderItems` from `cascader-item.tsx` — upstream's own comment says the virtual list renders exactly that below its windowing threshold, and a Quincy field list is two fields long.
 */
import * as React from "react"
import {
  Cascader,
  CascaderEmpty,
  CascaderList,
  CascaderPanel,
  CascaderStatus,
} from "@/components/reui/cascader/cascader"
import { CascaderFooter } from "@/components/reui/cascader/cascader-footer"
import {
  CascaderBreadcrumb,
  CascaderInput,
  CascaderNav,
} from "@/components/reui/cascader/cascader-nav"
import type {
  CascaderActionItem,
  CascaderLabels,
  CascaderNode,
} from "@/components/reui/cascader/cascader-types"
import { CascaderItems } from "@/components/reui/cascader/cascader-item"
import {
  filterControlSizes,
  filterReadOnlyProps,
  useFilterActions,
  useFilterState,
} from "@/components/reui/filters/filters-context"
import {
  FILTER_FIELD_PICKER_CLASS,
  getFilterField,
  getFilterFieldCount,
  joinFilterPath,
  splitFilterPath,
} from "@/components/reui/filters/filters-lib"
import { getDefaultFilterOperator } from "@/components/reui/filters/filters-operators"
import type { FilterField } from "@/components/reui/filters/filters-types"

import { cn } from "@/lib/utils"
import { Button } from "@/components/reui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/reui/popover"
import { ListFilterPlusIcon } from "lucide-react"

/**
 * Projects ONLY the field tree: operators or values as nodes would force the
 * wizard through a combobox that owns the arrows and `aria-activedescendant`.
 */
function toCascaderNodes<V, O>(
  fields: readonly FilterField<V, O>[],
  parentPath: string[] = []
): CascaderNode<FilterField<V, O>>[] {
  return fields.map((field) => {
    const path = [...parentPath, field.id]
    const node: CascaderNode<FilterField<V, O>> = {
      value: joinFilterPath(path),
      label: field.label,
      icon: field.icon,
      description: field.description,
      keywords: field.keywords,
      disabled: field.disabled,
      data: field,
    }
    if (field.fields?.length) {
      node.children = toCascaderNodes(field.fields, path)
      node.count = getFilterFieldCount(field)
    }
    return node
  })
}

export interface FilterFieldPickerProps {
  /** The level being browsed. Not the chosen field. */
  path: string[]
  onPathChange: (path: string[]) => void
  query: string
  onQueryChange: (query: string) => void
  /** A field was chosen, with its starting operator already resolved. */
  onSelect: (path: string[], defaultOperator: string | null) => void
  /** Viewport height before the list scrolls. */
  maxHeight?: number
  /** Cascader-only strings; the `FilterLabels` bridge below covers the rest. */
  labels?: Partial<CascaderLabels>
  /** Pinned footer rows, OUT of the option ring so arrows never land on one. */
  actions?: CascaderActionItem[]
}

/**
 * Fully controlled, not draft-driven, so ONE picker serves both the create
 * popover (driven by the draft reducer) and an advanced row (its own state).
 */
export function FilterFieldPicker<V, O>({
  path,
  onPathChange,
  query,
  onQueryChange,
  onSelect,
  maxHeight = 260,
  labels: labelsProp,
  actions: actionItems,
}: FilterFieldPickerProps) {
  const actions = useFilterActions<V, O>()

  const items = React.useMemo(
    () => toCascaderNodes(actions.index.roots),
    [actions.index]
  )

  // Bridges `FilterLabels` onto the cascader's own key names. `labelsProp` is
  // spread LAST, so a consumer override always wins.
  const cascaderLabels = React.useMemo<Partial<CascaderLabels>>(
    () => ({
      search: actions.labels.searchFields,
      back: actions.labels.back,
      empty: actions.labels.empty,
      pathSeparator: actions.labels.pathSeparator.trim() || "/",
      itemCount: actions.labels.itemCount,
      branchAffordance: actions.labels.branchAffordance,
      rootLevel: actions.labels.fieldsLabel,
      panelLabel: actions.labels.fieldsLabel,
      resultsAnnouncement: actions.labels.resultsAnnouncement,
      actionsLabel: actions.labels.actionsLabel,
      ...labelsProp,
    }),
    [actions.labels, labelsProp]
  )

  return (
    <Cascader
      inline
      /* Pinned open: inline renders no popup and forces `open`, so the
         single-select commit's `setOpen(false)` dismisses nothing. That avoids
         the `multiple` plus `max` workaround and its `aria-multiselectable`. */
      open
      onOpenChange={() => {}}
      items={items}
      /* No `selectable` predicate: LEAVES commit, branches navigate. Honouring
         a branch's opt-in made one click mean both drill and commit. */
      searchScope="deep"
      /* Nothing is ever selected, so the ~24px check gutter is dead space. */
      indicator={false}
      path={path}
      onPathChange={onPathChange}
      /* Controlled: the single-select arm of `commit()` never clears the query,
         so an uncontrolled one would bleed into the next step. */
      inputValue={query}
      onInputValueChange={onQueryChange}
      value=""
      onValueChange={(value) => {
        const nextPath = splitFilterPath(value)
        const field = getFilterField(actions.index, nextPath)
        if (!field) return
        onSelect(
          nextPath,
          getDefaultFilterOperator(field, actions.resolveOperators(field))
        )
      }}
      labels={cascaderLabels}
      actions={actionItems}
      /* Set here only: `CascaderList` takes its own `maxHeight` and that WINS,
         so a second copy on the list is a divergence waiting to happen. */
      maxHeight={maxHeight}
    >
      <CascaderPanel>
        <CascaderNav>
          <CascaderInput placeholder={actions.labels.searchFields} />
        </CascaderNav>
        <CascaderBreadcrumb />
        <CascaderEmpty />
        <CascaderList>
          {/* WINDOWED: the picker is where scale lives and nothing here pins.
            Below the threshold it renders what `CascaderItems` does. */}
          <CascaderItems />
        </CascaderList>
        <CascaderFooter />
        <CascaderStatus />
      </CascaderPanel>
    </Cascader>
  )
}

function FieldStep<V, O>() {
  const actions = useFilterActions<V, O>()
  const { draft } = useFilterState<V>()

  return (
    <FilterFieldPicker<V, O>
      path={draft?.cascaderPath ?? []}
      onPathChange={(next) =>
        actions.dispatchDraft({ type: "setCascaderPath", path: next })
      }
      query={draft?.query ?? ""}
      onQueryChange={(query) =>
        actions.dispatchDraft({ type: "setQuery", query })
      }
      onSelect={(path, defaultOperator) =>
        actions.dispatchDraft({ type: "selectField", path, defaultOperator })
      }
    />
  )
}

export interface FiltersBuilderProps {
  /** Replaces the default Add filter button. */
  trigger?: React.ReactNode
  className?: string
  /** QUINCY ADDITION (#428): which edge of the trigger the field picker aligns to. Default `"start"`. */
  align?: "start" | "center" | "end"
}

/**
 * The Add filter popover. ONE panel, the field step: picking a field commits
 * the rule and opens the operator menu on the new chip. `open` derives from the
 * draft and `openCreate` is gated, so read-only and disabled shut every route.
 */
export function FiltersBuilder<V, O>({
  trigger,
  className,
  align = "start",
}: FiltersBuilderProps) {
  const actions = useFilterActions<V, O>()
  const sizes = filterControlSizes(actions)
  const { draft, ruleCount } = useFilterState<V>()
  const open = draft !== null && draft.ruleId === null
  // The HANDOFF close, the one that must not FADE: the panel is a 224px card
  // dissolving over the very menu the user is now meant to read.
  const committing =
    draft !== null && draft.ruleId === null && draft.status === "ready"
  // LATCHED, because `committing` is true for one render only, before the exit
  // it suppresses begins. Adjusted during render; an effect is one frame late.
  const [instantExit, setInstantExit] = React.useState(false)
  if (committing && !instantExit) setInstantExit(true)
  else if (open && !committing && instantExit) setInstantExit(false)
  // Icon-only once chips sit beside it. Both states come off ONE size ladder,
  // so they share height and radius in every style at every bar size. The
  // hardcoded `icon`/`default` pair this replaced IS the `default` rung, so it
  // drifted the moment the bar was `sm`.
  const compact = ruleCount > 0

  // Base UI's own microtask-then-rAF ordering hands focus to the new chip, NOT
  // anything this file arranges. Suppressing the close restore with
  // `finalFocus` only removes the fallback that keeps focus off the BODY.

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) actions.closeDraft()
        else actions.openCreate()
      }}
    >
      <PopoverTrigger
        /* On the TRIGGER so a consumer's own `trigger` wears the state too. */
        disabled={actions.disabled}
        {...filterReadOnlyProps(actions)}
        render={
          trigger ? (
            (trigger as React.ReactElement)
          ) : (
            <Button
              variant="outline"
              size={compact ? sizes.icon : sizes.button}
              aria-label={compact ? actions.labels.addFilter : undefined}
              /* THE RESET BOUNCE: the button's base class carries
                 `transition-all`, so flipping the size class eased padding 0 to
                 `px-6` in sera over 150ms. Naming a transition REPLACES it. */
              className="transition-[color,background-color,border-color,box-shadow]"
            >
              {/* No filter-plus glyph in phosphor or remixicon. */}
              <ListFilterPlusIcon
              />
              {compact ? null : actions.labels.addFilter}
            </Button>
          )
        }
      />
      {/* The default, then the root override, then this `className` last, so
        the specific wins. */}
      <PopoverContent
        align={align}
        className={cn(
          FILTER_FIELD_PICKER_CLASS,
          /* See `instantExit`. Both PROPERTIES (an `exit` animation AND a
             transition each paint over the successor) and both twins (Base UI
             `data-ending-style`, Radix `data-[state=closed]`); only one can
             match in a given build. The string stays identical on both sides
             because listing only the Base UI half left the radix twin fading
             a 224px card over its successor. */
          instantExit &&
            cn(
              "data-ending-style:animate-none data-ending-style:transition-none",
              "data-[state=closed]:animate-none data-[state=closed]:transition-none"
            ),
          actions.fieldPickerClassName,
          className
        )}
      >
        <FieldStep<V, O> />
      </PopoverContent>
    </Popover>
  )
}

/** Exported for custom field pickers. */
export { toCascaderNodes }