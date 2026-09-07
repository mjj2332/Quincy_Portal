# Archive — historical, NOT authoritative

Everything under `docs/archive/` is kept for **provenance only**. None of it is a
source of truth, and nothing here is built, imported, deployed or linted.

> **The single design authority is `portal/apps/web/src/styles/`.**
> If a file here disagrees with the live token set, the live token set is right and
> this archive is stale. Do not "reconcile" the app back towards these files, and do
> not copy from them into `portal/`.

## What's here

### `design-system-export-2026-06-19/`

The original Claude-Design export of the Quincy Productions design system, captured
2026-06-19. Its directory was originally
`prototype/_ds/quincy-productions-design-system-b05a1c92-e535-473c-9869-277317e90689/`;
the contents are verbatim, only the path changed.

Its tokens were ported into `portal/apps/web/src/styles/tokens/`, which has since
**extended and diverged from** them — the live set adds `inverse.css` and
`tailwind.css`, and individual values have moved. Treat any difference as intentional.

`_ds_bundle.js` and `_adherence.oxlintrc.json` are generated artefacts of a compiler
that no longer runs against this repo.

### `brand-assets/`

The original transparent-PNG brand marks and patterns, from `prototype/assets/`.

Only two are used by the application, and each is served from the app's own
`portal/apps/web/public/brand/` — **not** from here:

- `quincy-wordmark-black.png` — the sign-in and topbar mark
- `quincy-pattern-black.png` — the sign-in backdrop and a token in `tokens/base.css`

The rest (`quincy-hero-black`, `quincy-hero-q-white`, `quincy-qp-black`,
`quincy-qp-white`, `quincy-wordmark-white`, `quincy-pattern-white`) are unreferenced.
They are kept because this is the repository's only copy; adding them to `public/`
would ship unreferenced bytes on every deploy.

### `tonomo-webhook-captures/`

The two raw Tonomo webhook payloads as originally captured, from `prototype/uploads/`.
The **canonical, test-referenced** copies are the JSON fixtures in `test-data/tonomo/`,
which `@quincy/shared`'s `parseTonomoOrder` is built and tested against. These Markdown
captures are the provenance record behind those fixtures, nothing more.

## What is deliberately not here

The prototype application itself — `index.html`, `app/*.jsx`, `app.css` and the
multi-megabyte standalone HTML dumps. It was a reference-only Claude-Design export
(React via CDN, in-browser Babel, mock data, no backend). Its look and flows are now
carried by `portal/`, its design system is ported, and no application code ever
imported from it.

It is recoverable from git history if it is ever needed: it lived at `prototype/` up to
the commit that removed it (see `git log -- prototype/`).
