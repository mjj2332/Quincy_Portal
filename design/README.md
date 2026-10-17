# design/

Design sources that a build follows. Tracked in git, read by agents, never built or deployed (CI
runs only on `portal/**`).

## `prototypes/<name>/`

One folder per Claude design prototype, exported from claude.ai/design as a handoff bundle and
committed as it came, so a build can always be compared with the exact frames it was planned
against.

- **When one is required:** revamps and new screens. Smaller UI changes match the rest of the
  Portal and need none.
- **What it decides:** layout, hierarchy, sizes, copy and behaviour. The build expresses it in
  Quincy tokens (`portal/apps/web/src/styles/`), not in the prototype's raw values. See AGENTS.md,
  "Design: the prototype decides, the tokens express it".
- **Frame ids** are named in the plan, the build brief and every browser-pass row, so each
  screenshot is checked against a specific frame.
- **Changing a prototype** is an owner decision: re-export it into the same folder in its own
  commit, so the diff shows what moved.

| Prototype | Work | Frames |
|---|---|---|
| `prototypes/video-review-revamp/` | Video review revamp, #879–#884 | P1–P10 phone, F1–F4, W1–W4, T1–T5, V1–V6 |
| `prototypes/project-header-revamp/` | Project header revamp (not yet planned or built); one hand-authored HTML page, not a design export | D1–D6 desktop, T1 tablet, M1–M6 phone, A1 alternative |

## What does not belong here

**The ReUI source snapshot.** It holds paid Pro blocks, templates and icons, and this repo is
public, so it lives outside the repo at `~/quincy-ref/reui/` on the owner's machine and is never
committed. Agents use the ReUI MCP first and that folder only as an offline fallback
(`docs/reui-reuse.md`).

**Screenshots from browser passes.** Those go in the session's scratchpad, or in `qa-evidence/`
when a PR needs them.
