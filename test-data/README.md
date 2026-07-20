# Test data

Local-only fixtures used by the production test suite. **Nothing here except this
README is committed** — the media is large and gitignored.

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
