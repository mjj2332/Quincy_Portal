# Dashboard views

Copied from the Claude Design project "Quincy Portal — Gantt, Calendar & shell search"
(claude.ai/design/p/1c2cbbc9-9ddd-4fe4-a11e-e59463ba8bac) on 2026-10-18. The page sources,
`support.js` and the fonts are byte-identical to the project.

**Round 3 (`Dashboard views v3.dc.html`) is the current design.** Rounds 1 and 2 stay for the
history of what changed; where they disagree with round 3, round 3 wins.

## Files

- `project/Dashboard views v3.dc.html`: round 3, the Timeline you can read: 14px labels, one
  colour per pipeline stage, and a Colour by Stage / People switch
- `project/Dashboard views v2.dc.html`: round 2, the stage-tinted Gantt, combobox calendar filters
  and write confirmations
- `project/Dashboard views.dc.html`: round 1, the Gantt view, new Calendar and one search
- `project/support.js`: the design-canvas runtime the pages load. It is generated, so don't edit it
- `project/fonts/`: Apfel Grotezk, Mazius Review and Athelas, as the pages reference them

Each page is a `.dc.html` design canvas: markup with `{{ }}` holes and `<sc-for>` loops, filled by
the `Component` class in its `text/x-dc` script. Read the markup and the class together. The
`data()` method holds the sample projects, and `gantt()` / `phone()` work out each bar's position
and treatment.

## Frames

| Frame | What it shows |
|---|---|
| 3a | Timeline, desktop 1440, two-week zoom, coloured by stage; hover tooltip, late chip, the key row as a stage filter |
| 3b | Timeline coloured by people: task bars filled with the assignee's colour, project bars neutral |
| 3c | Timeline on a phone (390), with labels above the bars. Beside it is the key: stage and task-state treatments and type sizes |
| 3d | Calendar week in the same palette and type |
| 2c | Gantt writes: deadline-drag confirmation and drop validation. Round 3 carries it forward unchanged |

Round 2's 2a/2b and round 1's 1a–1e are superseded by round 3.

## Left out

The project also holds `.thumbnail` and two round-2 working screenshots (`screenshots/2b*.png`).
The project's file server re-encodes images, so it can't hand them back byte for byte. They aren't
design frames, so they aren't copied here.

## Not decided yet

- **Edited review colour.** Round 3 gives it a new teal (`#2f6b66`), so it no longer shares ochre
  with RAW review. The page's `reviewTone` prop switches back to the shipped ochre plus hatch. The
  owner picks one before the build; teal needs a new token.
- **People colours** (`--pp-*`) are placeholders for four people. The build needs a rule that
  assigns a colour to every staff member.
