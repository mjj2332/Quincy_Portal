# Editor folders drive Portal import and export

The studio now works in its own Dropbox folders under `/Editor/01_ACTIVE EDITS` rather than the folders created by Tonomo. The owner confirmed that each Project's `Input` and `Output` folders must serve Portal's actual import/export workflow, not merely be an empty scaffold alongside the old integration. This deliberately changes the Tonomo-folder-based workflow described in the current PRD; file-flow details and rollout remain to be agreed before implementation.

Existing active Projects are included: link verified matches to their manually created September folders without moving or renaming files, and flag ambiguous matches for owner review. Preserve the currently used `09. September` folder; newly created month folders from October onward must include the year.

Import support includes DNG originals in `Input` for Portal RAW review, as confirmed by the owner. A JPEG-only import would omit most of the source material in the existing Editor folders.

The confirmed new-folder convention is `2026-10 October/01/<Tonomo folder name>` using the scheduled shoot's civil date. An established Project folder stays at its original path after rescheduling; the date in the path records its initial placement, not necessarily its current schedule.

## Amendment 2026-09-15

Portal-created `Input`/`Output` children are now named `0. Input` and `1. Output`, so the numbered pair sorts ahead of `Editing Notes` in Dropbox's default listing. This is a naming change only: mappings established before this date keep their existing plain `Input`/`Output` paths, reviewed linking recognises both spellings, and no existing folder is renamed in Dropbox.
