---
status: accepted
---

# The Project whiteboard is a live session, one Durable Object per Project

Every Project gains a Project whiteboard built on ReUI `whiteboard-1` (Excalidraw). The owner
chose live co-editing with presence over saved boards with "updated by X, reload" conflicts,
and over shipping saved boards first. Everything else in the Portal is request/response over
D1, so this is the first stateful real-time surface, and a future reader will wonder why.

## Decision

1. **One Durable Object per Project holds the live board.** Everyone who opens the board
   connects to it over a WebSocket; it orders edits, relays them, and tracks presence. D1 is
   not the live store.
2. **Snapshots are the durable record.** The Durable Object writes a snapshot every 30 seconds
   while the board is changing and when the last person leaves. The last 30 snapshots are kept
   and back whiteboard-1's version restore, which anyone who can edit may use.
3. **Access is Project collaboration's.** Whoever can open the Project's collaboration can open
   and edit its board, External editors included. An Archived Project's board is view-only.
4. **Media is Embedded media owned by the Project.** Images and videos on the board are stored
   with the Project and deleted with it; a file removed from the board, or uploaded and never
   placed, is deleted after 7 days so undo and version restore can still bring it back. Video
   sits on the board as a poster frame that opens the Portal player, because Excalidraw has no
   video element.

## Considered options

- **Saved boards with optimistic versioning** — no new infrastructure, but two people on one
  board overwrite each other or get told to reload. Declined: the board is shared working space.
- **Saved boards now, live later** — declined by the owner in favour of building live once.

## Consequences

- A new Durable Object class and binding, its migration, and WebSocket auth that re-checks
  collaboration access on connect.
- Deleting a Project must also tear down its Durable Object's storage, beside the existing R2
  purge of `projects/{id}/`.
- Snapshot cadence and retention are tunable without changing this decision.
