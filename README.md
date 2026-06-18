# Quincy Portal — Prototype

An interactive design prototype for **Quincy Portal**, a replacement for our current
[Pixieset site](https://quincyproductions.pixieset.com). It combines client photo
**delivery** with an internal photo **review / approval** layer, in one connected product.

> ⚠️ **This is a prototype for review, not production code.** It was mocked up in HTML/CSS/JS
> (React via CDN) using Claude Design. It is meant to communicate the intended design and
> flows so the team can give feedback before we build the real thing.

## How to review it

**Use the multi-file build — [`project/index.html`](project/index.html)** (this is also
what the Cloudflare Pages site serves). Open it in a modern browser — no build step or
server required. It pulls in `app/*.jsx`, `app.css`, and the design system under
`project/_ds/`, and is the **current, up-to-date** version of the prototype.

> ⚠️ The single-file `project/Quincy Portal.html` (and `project/export/Quincy Portal.html`)
> is an **older snapshot** — it predates the RAW/Edited workspace rework and doesn't reflect
> the latest design. Don't review from it until it's regenerated. Use `index.html`.

## What's in it

Surfaces sharing one data model, switchable via the **"View as"** control (bottom-left):
**Team / Reviewer / Client**.

- **Team dashboard** — every shoot as a project card with pipeline status, review progress,
  filters (status, agency, search), and grid / list views.
- **Project workspace** — the internal hub for a shoot: project rail (client, agent, dates,
  photographer), **RAW** and **Edited** collections, grid + lightbox with **freehand
  paint-style markup**, comments, star ratings, colour labels, approve / flag, side-by-side
  compare, bulk actions, and **Publish to client**. A guest-reviewer link is review-only.
- **Client delivery page** (no login, private link) — editorial cover hero, collection tabs,
  gallery grid + lightbox, favourites, slideshow, share, download (web / full-res, single /
  zip), a video/film section, a copywriting/description section, and premium (watermarked,
  paywalled) content.

Built on the Quincy Productions design system (ink-on-paper, Mazius display, Apfel UI).

> 📄 **Where the product thinking lives:** the `project/docs/` folder holds the working
> [PRD](project/docs/PRD.md), [Personas](project/docs/Personas.md), and
> [Sitemap](project/docs/Sitemap.md). They flag what's built vs. planned (e.g. the
> photographer role, RAW→autoHDR editing pipeline, role-gated login) and mark open questions
> for the team — a good place to leave feedback.

### Notes for reviewers

- **Property photos are hot-linked** from Quincy's Pixieset CDN, so they need an internet
  connection to display and may appear blank in offline/automated captures. For production
  we'd host our own exports.
- Grids reuse a pool of ~8 real interiors, so a single gallery repeats shots. Real
  per-property export sets would make it photo-accurate.

## Repo layout

```
project/                     The prototype
  index.html                 Multi-file entry point
  Quincy Portal.html         Standalone single-file build
  Quincy Portal (standalone source).html
  app/                       React/JSX components (data, ui, viewer, dashboard,
                             board, workspace, client, tweaks-panel, main)
  app.css                    App styles
  docs/                      Product docs — PRD, Personas, Sitemap
  assets/                    Logos & patterns
  export/                    Exported standalone build
  uploads/                   Saved markup/drawings from the prototype
  _ds/                       Quincy Productions design system (tokens, fonts, styles)
chats/                       Early design conversation transcript (origins)
AGENTS.md                    Handoff notes for a coding agent that implements this for real
```
