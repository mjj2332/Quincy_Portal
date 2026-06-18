# Quincy Portal — Personas

> **Status:** Draft v0.1 · 18 June 2026
> Edit freely. `✏️ NEEDS INPUT` marks where I need a decision.
> These personas drive **role-based access** in the prototype (see `PRD.md` §4).

---

## At a glance

| # | Persona | Type | Primary job in the portal | Access scope |
|---|---|---|---|---|
| 1 | **Project Manager / Admin** | Internal | Run projects, manage people, oversee delivery | **Full** |
| 2 | **Photographer** | Internal | Upload & annotate RAW | **RAW only** |
| 3 | **Photo Editor / QA Officer** | Internal | Select RAW → edit → QA → publish | **RAW + Edited + Publish** |
| 4 | **Client (Agent / Agency)** | External | Receive & download final media | **Delivery page only** |

---

## 1. Project Manager / Admin

**Who they are.** The person who runs Quincy's production operation — books shoots,
assigns photographers, keeps projects moving, and is accountable for what reaches the client.

**What they need to do**
- See **every** project and its pipeline stage at a glance.
- Create / configure / archive projects; assign photographer & editor.
- Manage users and their roles.
- Step into any stage (RAW, editing, edited QA, delivery) when needed.
- Publish to client and manage the client link.

**Permissions:** everything (see matrix in `PRD.md` §4).

**Success looks like:** nothing is stuck; they can answer "where is this shoot?" instantly.

> ✏️ **NEEDS INPUT:** Is "Admin" and "Project Manager" one role or two (e.g. Admin manages
> users/settings, PM manages shoots)? Currently modelled as one.

---

## 2. Photographer

**Who they are.** The shooter on location. Hands off captures and flags intent, then
steps out of the pipeline.

**What they need to do**
- **Upload RAW images** to the project(s) they're assigned to.
- **Comment & annotate** their RAW images (mark brackets, note client requests, call out hero angles).
- See the status of their uploads (received / in QA).

**Explicitly restricted** (per your brief)
- ❌ No access to **Edited** images.
- ❌ No access to other features — no client delivery, no publish, no copywriting, no other projects' work.
- Scoped to **RAW only**, and ✏️ likely only on **assigned** projects.

**Success looks like:** upload is fast and reliable; they can leave clear notes for QA without wading through the rest of the system.

> ✏️ **NEEDS INPUT:**
> - Can a photographer see *all* projects or only ones they're assigned to?
> - Can they compare their own RAWs, or just view + annotate?
> - After QA selects RAWs for editing, do photographers see which of theirs were chosen?
> - Home screen: a filtered dashboard, or a stripped-down "my uploads" screen?

---

## 3. Photo Editor / Quality Assurance Officer

**Who they are.** The craft + quality gate. They decide what gets edited, check the
edits, and own what's published to the client.

**What they need to do**
- **Review RAW** images from photographers; compare similar frames; annotate & comment.
- **Select the RAWs** to send to **autoHDR** for editing.
- **Review edited images** when they return; approve / flag; annotate & comment.
- Compare images (RAW↔RAW, and ✏️ possibly RAW↔Edited).
- Manage & **publish** the final deliverables to the client delivery page:
  **selected images, videos, floorplan, and copywriting.**

**Permissions:** RAW + Edited + publish (see matrix). ✏️ confirm whether they can also
create projects or only work within ones Admin sets up.

**Success looks like:** a tight selection → edit → QA → publish loop with full annotation
history, and confidence that only approved media reaches the agent.

> ✏️ **NEEDS INPUT:**
> - Is "**select for editing**" a distinct action from "approve", or the same?
> - Do they write the **copywriting**, or just review/publish copy written elsewhere?
> - Who uploads **video** and **floorplan** — this role, Admin, or the photographer?

---

## 4. Client (Agent / Agency) — external

**Who they are.** The real-estate agent or agency Quincy delivers to (e.g. McGrath,
Ray White, Sotheby's, The Agency). Not a Quincy employee.

**What they need to do**
- Open a **private link** (no login) to their property's delivery page.
- Browse final **images, video, floorplan, copywriting**.
- **Favourite**, **download** (web-size / full-res, single or zip), **share**, view **slideshow**.
- **Purchase premium content** — unlock watermarked extra images / video add-ons.

**Permissions:** the client delivery page for **their** project only — no internal access.

**Success looks like:** they land on a beautiful, fast gallery and get their assets in seconds.

> ✏️ **NEEDS INPUT:** Your original brief mentioned *"a photo review site, before publish to
> the end client."* Does the **agent ever review/approve** media (a guest-reviewer step),
> or do they **only receive** the final delivery? This decides whether we keep the
> "guest reviewer link" concept that's in the prototype today.

---

## Roles not yet defined  ⬜

Add any persona I've missed below and I'll fold it into the model:

- _✏️ e.g. Videographer? Stylist? Retoucher (separate from QA)? External freelance reviewer?_
- _✏️ ..._
