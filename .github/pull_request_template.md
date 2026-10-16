<!-- What changes and why, in a few sentences. Link the issue ("Closes #n" / "Refs #n"). -->

## Verification

<!-- Commands run and their result lines; for UI, the browser-pass folder and design-reviewer's verdict. -->

## Checklist

- [ ] `npm run verify` from `portal/` passes (or: no `portal/` change).
- [ ] D1 migration? Read `docs/Guides/CI-Deploy.md` before merging. A merge to `main` touching `portal/` deploys production.

**UI changes** (delete this section when there are none):

- [ ] Prototype: `design/prototypes/<name>/`, frames <ids> — or "none: matches the rest of the Portal"
      (required for a revamp or a new screen).
- [ ] Built by ui-builder from the frame's source; every conflict with ReUI or a guard went to the owner.
- [ ] Values are Quincy tokens; `design-system-guards` and the `ui-primitive-ratchet` guard pass.
- [ ] Browser pass, stage 1 by the session: desktop in the built-in browser; **phone in Safari on the
      iOS Simulator** (`scripts/agents/ios-pass.sh`), with keyboard rows for any input surface.
- [ ] Stage 2: design-reviewer judged the screenshots against the prototype frame (or the rest of the Portal).
- [ ] New lessons go in `docs/lessons.md`, with a `Tags:` line.
