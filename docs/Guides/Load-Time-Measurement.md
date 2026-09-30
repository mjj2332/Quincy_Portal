# Load-time measurement

Where a page load spends its time, read from production. Added in #361 so the deferred fixes in
#358 (session caching, D1 placement or read replication, cover-query restructuring, trimming the
Dashboard's project list) are chosen on evidence rather than guesses.

Four sources, all available in production. Nothing to enable.

| Source | What it answers | Retention |
|---|---|---|
| `Server-Timing` response header | What did *this* request cost, by stage? | Per request (DevTools) |
| Workers Logs, `server_timing` events | The same numbers across every request | 7 days |
| Workers Logs, `boot_timing` events | How long a real sign-in takes to reach the session, then the first Dashboard data | 7 days |
| `wrangler d1 insights` | Which SQL statements read the most rows | Time window you pass |

## What is measured

Every `/api/*` and `/media/*` response carries a header such as:

```
auth;dur=12.3, principal;dur=3.1, handler;dur=45.0,
d1;dur=31.2, d1-queries;desc="5", d1-meta;desc="2", d1-rows;desc="42", d1-region;desc="OC"
```

| Segment | Meaning |
|---|---|
| `auth` | The session check (better-auth `getSession`). On `/api/auth/*` it is the whole handler time. |
| `principal` | Reloading the user row and the impersonation check that follow it. |
| `handler` | Everything after auth: the route itself. |
| `d1` | Summed duration of every D1 call in the request. |
| `d1-queries` | Number of statements issued (a `batch` of N counts N). |
| `d1-meta` | How many of those returned D1 metadata (see below). |
| `d1-rows` | Rows read, **summed over the `d1-meta` calls only**. |
| `d1-region` | D1 region that served a metadata-bearing call. |

Rules that keep the header safe to expose (it is readable by anyone who can make the request):

- Metric names are a fixed allow-list and the only params are `dur` (a number) or `desc`
  (digits or a D1 region code). No query text, ids, emails or names can appear. The test in
  `workers/app/test/server-timing.test.ts` asserts this.
- An unauthenticated 401 carries `auth` only. `principal`, `handler` and every `d1*` segment are
  withheld until the request has authenticated (or is an `/api/auth/*` route).

### What D1 does and does not tell us

`d1` and `d1-queries` are always exact. **Rows read and region are partial.** D1 attaches
`meta.rows_read` and `meta.served_by_region` only to results of `.all()`, `.run()` and `.batch()`.
`.first()` and `.raw()` return none, and Drizzle's `.get()`, `.all()` with selected fields and
`.values()` go through `.raw()`; most app reads, including better-auth's lookups, are those. So
`d1-rows` undercounts and `d1-meta` (`n` calls of `d1-queries` total) is the coverage figure to read it
against. Treat `d1-rows` as a floor, and use `wrangler d1 insights` for authoritative rows read per
query. Without read replication (none is configured) the region is constant: the primary.

### Caveats on the numbers

- **Workers clocks only advance on I/O.** `performance.now()` does not move during CPU-only work, so
  a segment is I/O wait, and pure computation reads as roughly 0.
- **`d1` overlaps** `auth`, `principal` and `handler`: it is a component of them, not an addition.
- The header measures up to the handler's `return`. Bytes streamed afterwards (zip downloads) and
  work in `ctx.waitUntil` are outside it.
- Production responses also carry Cloudflare's own `cfL4` / `cfExtPri` Server-Timing entries. Ignore them.

## Reading one request: DevTools

Network tab, click a request (`/api/projects` is the one that matters), **Timing** tab, scroll to
*Server Timing*. The stages are listed with their durations; the request's total less those is
network and queueing. `d1-*` entries show their `desc` value.

## Reading a week: Workers Logs

Cloudflare dashboard -> Workers & Pages -> `quincy-portal-app` -> **Logs** -> **Query Builder**.
Set the range to the last 7 days (the retention limit).

Server timing, per route:

1. Filter `event = server_timing` (and `status < 400` to keep errors out of the percentiles).
2. Calculation: `p50` and `p95` of each of `auth`, `principal`, `handler`, `d1Ms`, `total`; also
   `avg` of `d1Queries`, `d1Rows`, `d1Meta`.
3. Group by `route`. Ids are already replaced with `:id`; `/media` is sampled (about 10% of fast
   successful requests, plus every request that failed or took over 500 ms), while `/api` is complete.

Boot timing, per sign-in:

1. Filter `event = boot_timing` and `hidden = false`. Samples where the tab was backgrounded during
   boot are noise.
2. Calculation: `p50` and `p95` of `sessionMs` and `dashboardMs`. Group by `role` and/or `view`.
3. `sessionMs` is time from navigation to "Loading the studio..." disappearing. `dashboardMs` is time
   from navigation to the first Dashboard projects data. Both are measured from navigation start,
   so `dashboardMs - sessionMs` is the Dashboard's own leg.

The same two marks exist on the browser timeline (DevTools -> Performance -> Timings:
`quincy:session-resolved`, `quincy:dashboard-data`) for a single local run.

## Reading D1: `wrangler d1 insights`

From `portal/workers/app`, after `wrangler login`:

```sh
npx wrangler d1 insights quincy-portal --time-period 7d --sort-type sum --sort-by reads --limit 15
npx wrangler d1 insights quincy-portal --time-period 7d --sort-type sum --sort-by time  --limit 15
npx wrangler d1 insights quincy-portal --time-period 7d --sort-type avg --sort-by time  --limit 15 --json
```

The first names the statements that read the most rows (cover queries, project list). The second
names the ones that cost the most total time. Flags are the CLI's current ones (`--help` to confirm;
the command is marked experimental).

## Collecting a week

1. Deploy, then use the app normally for seven days: sign in from a cold tab on the Dashboard at
   least once a day as each role.
2. Run the Query Builder queries above and the two `d1 insights` invocations. Note the numbers.
3. Compare against the decision rules below.

## Which numbers decide the deferred fixes

- **High `auth` p95, as a large share of `/api` `total`** -> session caching (its own reviewed
  decision; better-auth's cookie cache trades revocation latency, so it is not automatic).
- **High `d1Ms` per query, with low `d1Rows`** (few rows, slow anyway) -> latency or placement.
  D1 location or read replication.
- **High `d1Rows`, or high `handler`, on `/api/projects`** -> cover-query restructuring or trimming
  the Dashboard's project list.
- **`dashboardMs - sessionMs` dominated by the `/api/projects` `handler` p95** -> the server fixes
  above. **Dominated instead by the gap between that and `total`** (chunk download, parse) -> the
  bundle work from #359, not a server change.
- **`sessionMs` itself large while `auth` is small** -> the time is the `index.html` and JS load
  before the app can even ask, again #359 territory.
