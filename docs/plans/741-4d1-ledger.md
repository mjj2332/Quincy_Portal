# #741 PR 4d-i reuse ledger

One line per new UI element. ReUI MCP queried (`search` "file upload dropzone video": `c-file-upload-1/4/5/6` and the `use-file-upload` hook; no dropzone component).

| Element | Item used | Notes |
|---|---|---|
| Films section heading, eyebrow, intro | existing `.workspace-intro` / `.ey` / `h1.serif` markup (`CollectionPanel.tsx` Video branch) | installed |
| "Video links" secondary heading and rule | existing tokens (`--border-width-hair`, `--type` scale) in `CollectionPanel.tsx` | installed; plain heading, no widget |
| New-film drop target | `components/quincy/FileDropzone.tsx` `FileDropzone` (new, Quincy-owned), after ReUI `c-file-upload-1` / `use-file-upload` | **Searches:** `components/reui/` + `components/quincy/` (none), ReUI MCP `file upload dropzone video` (examples only, they import the `use-file-upload` hook), base-nova (no dropzone). **Candidates:** `UploadDropzone.tsx` is JPEG/RAW-specific with 3 parallel workers and its own meter, its raw inputs are baseline-allowlisted; `c-file-upload-1` needs the hook's multi-file list and preview URLs, which a single-file MP4 pick does not use. Drag state is 12 lines, so the hook is not vendored. Lives in `quincy/` so no allowlist entry. |
| "Upload new film" / "Upload v{n}" picker | `FilePickButton` in the same file: `quincy/Button` + a hidden `<input type=file>` | the one raw input is inside `components/quincy/`; the visible Button is the tab stop |
| Film title field | `quincy/QuincyField` (`reui/field` + `reui/input`) | installed |
| Probe summary line, cautions, refusal copy | `quincy/Notice` (`caution`, `critical`) and body text tokens | installed |
| Upload progress row, Cancel, Retry, Retry finishing, failure line | `quincy/EmbeddedUploadTray` (extended: `finishing` phase, `message`/`retryLabel`/`noRetry`/`cautions` per row) | installed; existing HEIC rows unchanged (tests green) |
| Video card shell | `reui/frame` (`Frame` + `FramePanel`, ADR 0014) | installed |
| Poster | `components/LazyImage` | installed; a posterless card shows a plain "No poster" text block (text, not a widget) |
| Version / Premium / duration chips | `reui/badge` (`secondary`, `warning`, `invert`) | installed |
| "N versions" list | `reui/popover` (`PopoverTrigger`, `PopoverContent`, `PopoverTitle`) + `reui/item` rows | installed; Base UI popover, no hand-built role |
| "Uploading v4 · 42%" spinner | `reui/spinner` | installed |
| Empty state | `quincy/EmptyState` | installed |
| Load-failure and gate-check-failure notice with Retry | `quincy/Notice` + `quincy/Button` | installed |
| Card grid layout | CSS grid with `repeat(auto-fill, minmax(min(320px,100%),1fr))` on token gaps | layout only |

No allowlist entry was added: the only raw `<input>` lives in `components/quincy/FileDropzone.tsx`; `ui-primitive-ratchet.guard.test.ts` passes unchanged.
Not in 4d-i (later slices): Open review, selection checkboxes and Share bar, note/decision/link chips, premium actions, the player.
