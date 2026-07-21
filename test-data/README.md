# Test data

Fixtures used by the production test suite. The **media** is large and gitignored
(local-only); the small JSON fixtures in `tonomo/` ARE committed — tests and CI
depend on them.

## `tonomo/` (committed)

The two real captured Tonomo webhook payloads — the authoritative reference for the
Tonomo order contract (`@quincy/shared` `parseTonomoOrder` is built and tested against
them via `portal/packages/shared/test/tonomo.test.ts`):

- `order-with-raw-folder.json` — an in-progress order carrying `rawFolderLink`/
  `rawFolderPath` (pre-fills the project's Dropbox sync source) and one photographer.
- `order-delivered.json` — a delivered order with 8 `services_a_la_cart` entries and 11
  `deliverablesLinks` (Floor Plan / Photos / Video / PDF types, including a duplicated
  reel under two share links with one `content_hash` — the dedupe case).

Originals were captured to `prototype/uploads/Webhook-data*.md` (kept for history);
these copies are the canonical, referenced versions.

## `Test Images with star rating/`

44 real Lightroom JPEG exports (2.9–28 MB each, ~614 MB total) used by the XMP
star-rating parser test at
[`portal/packages/shared/test/xmp.test.ts`](../portal/packages/shared/test/xmp.test.ts).
8 carry `xmp:Rating="1"`; the rest are unrated. The parser reads the rating from a
256 KB header range-read — see `portal/packages/shared/src/xmp.ts`.

The test **skips cleanly** (via `describe.skipIf`) when this folder is absent — so CI,
which does not have the fixtures, passes without them, while local runs validate against
the real files. If you have the fixtures, keep them at exactly this path so the test finds
them; if you move them, update the `fixtureDirectory` URL in `xmp.test.ts`.
