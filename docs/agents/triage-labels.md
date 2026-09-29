# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| --------------------------- | --------------------- | ----------------------------------------- |
| `needs-triage`               | `needs-triage`         | Maintainer needs to evaluate this issue  |
| `needs-info`                 | `needs-info`           | Waiting on reporter for more information |
| `ready-for-agent`            | `ready-for-agent`      | Fully specified, ready for an AFK agent  |
| `ready-for-human`            | `ready-for-human`      | Requires human implementation            |
| `wontfix`                    | `wontfix`              | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

All five exist in the tracker (`needs-triage`, `needs-info` and `ready-for-human` were created for #164).

## Other labels

These describe an issue's kind, not its triage state. Apply one alongside a role label.

| Label              | Use for                                              |
| ------------------ | ---------------------------------------------------- |
| `bug`              | Something is broken                                  |
| `enhancement`      | A new feature or an improvement to an existing one   |
| `documentation`    | Docs-only change                                     |
| `question`         | Needs an answer rather than a change                 |
| `duplicate`        | Already tracked elsewhere (link it, then close)      |
| `invalid`          | Not a real problem                                   |
| `good first issue` | Small and self-contained                             |
| `help wanted`      | Open for anyone to pick up                           |

Check `gh label list` before labelling; `gh issue create --label` fails outright on a label that does not exist.
