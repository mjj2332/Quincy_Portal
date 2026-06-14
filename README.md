# Quincy Portal — Prototype

An interactive design prototype for **Quincy Portal**, a replacement for our current
[Pixieset site](https://quincyproductions.pixieset.com). It combines client photo
**delivery** with an internal photo **review / approval** layer, in one connected product.

> ⚠️ **This is a prototype for review, not production code.** It was mocked up in HTML/CSS/JS
> (React via CDN) using Claude Design. It is meant to communicate the intended design and
> flows so the team can give feedback before we build the real thing.

## How to review it

You have two options:

1. **Single-file (easiest)** — open [`project/Quincy Portal.html`](project/Quincy%20Portal.html)
   directly in your browser. Everything (app, fonts, logos, UI) is baked into the one file.
   You need to be **online** so the property cover photos can load (see note below).

2. **Multi-file source** — open [`project/index.html`](project/index.html) in your browser.
   This is the un-bundled version that pulls in `app/*.jsx`, `app.css`, and the design system
   under `project/_ds/`. Best if you want to read the source.

Either way: just open the file in a modern browser — no build step or server required.

## What's in it

Three surfaces sharing one data model, switchable via the **"View as"** control (bottom-left):

- **Team dashboard** — every shoot as a property card with pipeline status
  (Editing → In review → Client review → Delivered), review progress, filters, search.
- **Review workspace** — grid + lightbox with **freehand paint-style markup** on photos,
  star ratings, colour labels, comments, side-by-side compare, bulk approve/flag, and
  **Publish to client**. A guest-reviewer link variant is review-only.
- **Client gallery** (no login) — editorial cover hero, WEB / PRINT / FLOORPLAN collections,
  favourites, slideshow, share, download (web / full-res, zip), and print ordering.

Built on the Quincy Productions design system (ink-on-paper, Mazius display, Apfel UI).

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
  app/                       React/JSX components (data, ui, viewer, dashboard, review, …)
  app.css                    App styles
  assets/                    Logos & patterns
  _ds/                       Quincy Productions design system (tokens, fonts, styles)
chats/                       Design conversation transcript (how we got here)
AGENTS.md                    Handoff notes for a coding agent that implements this for real
```
