# Reusing ReUI and shadcn base-nova

Consult this before building any UI element: a component, a block, a shell, an icon. The Portal's
UI library is two registries under one folder, and most of what a spec asks for already exists in
one of them. Build on what exists; a hand-rolled element needs its reason written in the plan (an
ADR, a proven token conflict).

## The two registries

| | ReUI | shadcn base-nova |
|---|---|---|
| Name form | `@reui/<name>` | bare `<name>` |
| Holds | 22 components (`badge`, `kanban`, `data-grid`, `frame`, …), `c-*` examples, blocks (`app-shell-*`, `sheet-*`, `navbar-*`, …), icons, templates | the primitives: `button`, `sheet`, `breadcrumb`, `sidebar`, `dialog`, `tooltip`, `dropdown-menu`, `popover`, `tabs`, `scroll-area`, `item`, `field`, `select`, … |
| Served by | the proxy in `components.json` (licence key) | shadcn's default registry (no key) |
| Block source imports it as | `@/components/reui/<name>` | `@/components/ui/<name>` |

Both land in `portal/apps/web/src/components/reui/`, because the `ui` alias points there. A block's
`registryDependencies` mixes both forms: `@reui/badge` is ReUI's, `sheet` is base-nova's.

A single-file registry item lands flat, as all 38 pre-#219 files do. A **multi-file** registry item
(`@reui/gantt`'s 9 files, #219) may land in its own subdirectory — `components/reui/gantt/` — rather
than flat: it keeps the set's own file-to-file imports short and lets a guard scoped to that item
alone (`gantt-skin.guard.test.ts`) read the directory rather than an allowlist of names scattered
across the flat registry root.

**A 404 on `@reui/<name>` means "look in base-nova", not "it does not exist".** `@reui/sheet`,
`@reui/sidebar` and `@reui/breadcrumb` all 404, and all three exist as bare base-nova names. Confirm
with `npx shadcn@latest view <name>` (it returns the item's `registryDependencies` and files)
or ReUI MCP `search` before calling anything missing.

## Installing: vendor through the sandbox, then hand-apply

This replaces the ReUI skill's install step (`shadcn add @reui/<name> --yes` in the project); its
find, read-the-API and adapt steps apply unchanged. The CLI never runs against `portal/apps/web`:
an item's dependencies overwrite Quincy's adapted `button` and `badge` (`sheet` depends on
`button`). Install into the sandbox instead, into a fresh folder so nothing there is overwritten
either:

```bash
cd tmp/ReUI-Test-1   # base-nova sandbox, gitignored
npx shadcn@latest add sheet breadcrumb --yes --path src/components/vendor-<issue>
```

Then copy each file into `components/reui/`, and on the way:

- rewrite `import { cn } from "cn"` to `@/lib/utils`, and `@/components/ui/<name>` to
  `@/components/reui/<name>`
- keep the Quincy copy of any dependency already in `components/reui/` (skip the vendored
  `button.tsx`)
- record in the file's header comment what was dropped or changed and why (see
  `reui-block-adoption.md`)

`npx shadcn@latest view <name>` shows the raw registry source with unresolved placeholders
(`cn`, `IconPlaceholder`). Read it for dependencies; copy files only from an `add`.

## Where to read real compositions

- **ReUI MCP** (`mcp__ReUI__*`, Ultimate plan): `search` → `get_component` / `get_examples` →
  `validate_usage`. The server is the `proxy.collectui.pro` equivalent of `mcp.reui.io`.
- **`tmp/ReUI_Full_Source_Code/`**, the full ReUI source: `reui-blocks-main/blocks/<name>/`,
  `reui-icons-main/`, `reui-templates-main/<template>/`. Gitignored and on the owner's machine only; a
  worktree, remote session or CI run has MCP and nothing else.
- **`reui-templates-main/tempo-tasks` is the app shell's reference.** The #109 design canvas is
  "Tempo's layout in Quincy's palette"; its `src/features/app-shell/` composes base-nova `sidebar`,
  `sheet` and `breadcrumb` into the shell, header and right panel.

Block and template source imports `@/components/ui/`; that path is theirs. In this repo the same
primitive lives at `@/components/reui/`.

## Verifying the licence key

From `portal/apps/web`, `npx shadcn@latest view @reui/app-shell-1` returns the block when
`REUI_LICENSE_KEY` in `.env.local` is valid; with no key the error names `REUI_LICENSE_KEY`. The key
itself never appears in output, commits or docs.
