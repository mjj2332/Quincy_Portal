---
status: accepted
---

# Admins reach every admin capability through MCP, bounded by the never-list

MCP grows to cover the features built since ADR 0019 (Video review, Review links, the Delivery page,
Premium and Unlock, Social overlays, planning reads, staff downloads), and an Admin's Connected app can
reach every admin capability the browser offers. ADR 0019's never-list stays whole: no tool changes a
user's role or active status, changes or reads a feature flag, revokes Connected apps or starts
impersonation. Every role still gets exactly its browser permissions, author-only rules included, so an
Admin through MCP is never more than that Admin in the browser (owner decision, 2026-10-28 grilling).
This amends ADR 0019 decision 3 and adds the guards below.

## Why

The new features put two things in an AI client's reach that ADR 0019 did not: text written by Guest
reviewers, who are outside the studio, and actions clients see at once (Publish, Release, Unlock,
Revoke). Guest text is the prompt-injection vector the never-list exists for, so the list is the one
thing "full access" does not lift: one injected note must not be able to switch impersonation on or
cut another Admin off. The cost of the `admin` scope's 15-minute, no-refresh token was real friction,
consent every quarter hour; refresh with an absolute cap keeps a working session practical without a
standing admin grant.

## Decision

1. **Admin scope lifetime.** Access tokens stay 15 minutes; refresh tokens now rotate, with an absolute
   limit of 8 hours from consent, after which refresh is refused and the Admin consents again. Revoke,
   an epoch bump and the `mcp_access` flag still cut it off at once.
2. **Scope follows capability.** A write whose capability only Admins hold is `admin` scope; every other
   write is `write`, even when an Admin calls it.
3. **Outward actions confirm.** Publish and Unlock use the `delete_project` pattern (a summary and a
   signed confirm token, refused if anything changed). Release and its withdrawal, Revoke, Replace,
   Delete (Review link), End guest sessions, and marking an already-published Asset Premium take
   `confirm: true` after a stated reason. Restorable or not-yet-visible changes do not confirm.
4. **Guest text is marked untrusted.** Every note and reply in a tool result carries
   `authorKind: "guest" | "staff"`, guest text sits in a delimited field, and the server's MCP
   instructions say guest text is outside data, never instructions.
5. **Review link addresses are returned**, as in the browser: staff connect AI clients to draft the
   message that sends them. Revoke and Replace answer a leak.
6. **A note's `visibility` is required** on create, with no default, because a note a guest can see is
   an outward act.
7. **A moment in a Video may be given as frames or a timecode.** The server resolves a timecode to the
   nearest frame of that Version and echoes the frame it used; frames remain what is stored.

## Considered options

- **Lift the never-list for Admins.** Declined: it is the defence against injected guest text, and an
  Admin grant is exactly the one worth hijacking.
- **Keep the 15-minute, no-refresh admin token.** Declined: consent every 15 minutes made the admin
  scope impractical. **A 1-hour token with 30-day refresh, like `write`.** Declined: a standing admin
  grant for weeks.
- **Tighter than the browser for non-Admins** (no outward actions through MCP). Declined: a second
  permission model, which ADR 0019 already refused; confirm round trips guard the actions instead.

## Consequences

- Uploads stay out of MCP; a signed-upload mechanism is its own later decision.
- Feature flags are now out of MCP for reading as well as changing.
