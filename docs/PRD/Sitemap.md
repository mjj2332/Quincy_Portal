# Quincy Portal — Sitemap

> **Status:** Draft v0.1 · 18 June 2026
> Edit freely. ✅ Built · 🔶 Partial · ⬜ New. `✏️` = needs your input.
> Each screen notes **who can reach it** (A = Admin, P = Photographer, E = Editor/QA, C = Client).

---

## Top-level structure

```
Quincy Portal
│
├── 🔐 INTERNAL APP  (A · P · E)                     ← role-gated, login required ⬜
│   │
│   ├── Sign in  ⬜                                   (A · P · E)
│   │
│   ├── Dashboard / Projects  ✅                      (A · E full · P assigned only 🔶)
│   │   ├── Project card → opens Project Workspace
│   │   ├── Filters: status, agency, search  ✅
│   │   └── Kanban / List view toggle; Archived is List-only  ✅
│   │
│   ├── Project Workspace  ✅ (expanding)             (A · E · P→RAW only)
│   │   ├── Project header / rail  ✅  (client, agent, dates, photographer)
│   │   ├── Pipeline status  🔶  (see PRD §7)
│   │   │
│   │   ├── ▸ RAW collection  ⬜                       (A · P · E)
│   │   │     ├── Upload RAW  ⬜                        (A · P)
│   │   │     ├── Grid + lightbox  ✅
│   │   │     ├── Annotate / comment / markup  ✅
│   │   │     ├── Compare frames  ✅                    (A · E · P ✏️?)
│   │   │     └── ★ Select RAWs for editing  ⬜          (A · E)
│   │   │           └── Execute AutoHDR handoff  ⬜    (A only)
│   │   │
│   │   ├── ▸ Editing status  ⬜                         (A · E)
│   │   │     └── Non-admin view: neutral "Editing" status; AutoHDR details are admin-only
│   │   │
│   │   ├── ▸ Edited collection  🔶                    (A · E)   ❌ not Photographer
│   │   │     ├── Grid + lightbox  ✅
│   │   │     ├── Approve / flag / rate / label  ✅
│   │   │     ├── Annotate / comment / markup  ✅
│   │   │     ├── Compare (Edited↔Edited, RAW↔Edited ✏️)  🔶
│   │   │     └── Bulk actions  ✅
│   │   │
│   │   ├── ▸ Video  ⬜                                (A · E)
│   │   ├── ▸ Floorplan  🔶                            (A · E)
│   │   ├── ▸ Copywriting  ⬜                          (A · E)
│   │   │
│   │   └── ★ Publish to client  ✅ (images/floorplan) (A · E)
│   │         └── + video + copy  ⬜
│   │
│   ├── Clients  ✏️ (nav item exists, no screen yet)   (A)
│   ├── Schedule  ✏️ (nav item exists, no screen yet)  (A)
│   └── Settings / Users & roles  ⬜                   (A)
│
└── 🌐 CLIENT DELIVERY PAGE  ✅  (C — no login, private link)
    ├── Cover hero  ✅
    ├── Collection tabs  ✅  (Web / Print / Floorplan today → ✏️ Images / Video / Floorplan / Copy)
    ├── Gallery grid + lightbox  ✅
    ├── Favourites  ✅
    ├── Slideshow  ✅
    ├── Download (web / full-res · single / zip)  ✅
    ├── Share  ✅
    ├── Video / Film section  ✅
    ├── Description (copywriting) section  ✅
    └── Premium content  ✅  (watermarked + paywalled — unlock to download)
```

---

## Prototype "View as" switcher vs. real roles

The current prototype has a **demo switcher** (bottom-left): **Team / Reviewer / Client**.
This is a presentation convenience, **not** the real permission model. The target is
**login + role-gated access** per the table below.

| Demo view (today) | Maps to real role(s) | Notes |
|---|---|---|
| Team | Admin, Editor/QA | needs splitting into proper roles ⬜ |
| Reviewer | Guest reviewer link | ✏️ keep or remove (see Personas §4) |
| Client | Client | ✅ matches |
| — | **Photographer** | ⬜ not represented yet — new role to add |

> ✏️ **NEEDS INPUT:** Do you want me to keep the demo "View as" switcher (handy for
> showing stakeholders all roles in one prototype), **and** layer role-gating on top?
> Recommended: yes — keep the switcher as a prototype affordance, but make each role
> show only its permitted screens.

---

## Screen-by-screen routing notes

| Screen | Status | Reachable by | Entry point |
|---|---|---|---|
| Sign in | ⬜ | A · P · E | app root (when not authed) |
| Dashboard | ✅ | A · E (all) · P (assigned 🔶) | after sign in / logo click |
| Project workspace | ✅ | A · E · P (RAW only) | dashboard card |
| RAW collection | ⬜ | A · P · E | project tab |
| Edited collection | 🔶 | A · E | project tab |
| Video | ⬜ | A · E | project tab |
| Floorplan | 🔶 | A · E | project tab |
| Copywriting | ⬜ | A · E | project tab |
| autoHDR status | ⬜ | A (full details) · E (neutral **Editing** status only) | after "select for editing"; API projection/authorization enforces the boundary, not UI hiding |
| Publish flow | ✅ | A · E | workspace toolbar |
| Client delivery page | ✅ | C (+ A·E preview) | private link / "preview client" |
| Settings · Users | ⬜ | A | top nav |
| Clients directory | ✏️ | A | top nav (stub) |
| Schedule | ✏️ | A | top nav (stub) |

---

## Build order proposal  ✏️ (reorder as you like)

Once you've filled in the docs, I'd suggest tackling it in this order:

1. **Role model + gating** — introduce Photographer; gate screens by role.
2. **RAW vs Edited split** — restructure the project workspace into RAW / Edited collections.
3. **"Select for editing" → internal Editing workflow** — Editor/QA selects; Admin executes the private AutoHDR handoff; non-admin API projections remain neutral.
4. **Pipeline statuses** — update dashboard to the new stages.
5. **Video + Copywriting** — add as collections and deliverables.
6. **Client page additions** — surface video + copy on delivery.

> ✏️ Tell me if you'd rather I start somewhere specific, or do it all in one pass.
