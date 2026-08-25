# TB2 bundle and CSS delta

Measured 2026-08-25. Base is commit `dd85fd6` (the recorded pre-TB2 `main` base). The base
was archived to `/private/tmp/tb2-base.HmHm8A`, built with the repository's already-installed
dependencies via a temporary `node_modules` symlink; the working repository was not modified by
that comparison build.

Commands used for both builds:

```bash
find apps/web/dist -type f -print0 | sort -z | xargs -0 wc -c
wc -c apps/web/dist/assets/*.js apps/web/dist/assets/*.css
for asset in apps/web/dist/assets/*.js apps/web/dist/assets/*.css; do
  test -f "$asset" || continue
  raw_bytes="$(wc -c < "$asset" | tr -d ' ')"
  gzip_bytes="$(gzip -9 -c "$asset" | wc -c | tr -d ' ')"
  printf '%s\t%s\t%s\n' "$asset" "$raw_bytes" "$gzip_bytes"
done
```

| Measure | Base | TB2 | Delta | Delta % |
|---|---:|---:|---:|---:|
| Main JS raw | 955,297 | 1,006,255 | +50,958 | +5.33% |
| Main JS gzip -9 | 289,583 | 304,225 | +14,642 | +5.06% |
| Main CSS raw | 112,876 | 112,876 | 0 | 0.00% |
| Main CSS gzip -9 | 19,561 | 19,561 | 0 | 0.00% |
| `apps/web/dist` total raw | 2,689,722 | 2,740,680 | +50,958 | +1.89% |

Headline: TanStack Query adds 50,716 raw JS bytes / 14,594 gzip bytes. CSS is byte-identical.
The final JS contains no Query Devtools, persistence, or service-worker package.

Base emitted assets: `index-BRcM4W58.js` (955,297 raw; 289,583 gzip) and
`index-NmV-0yUO.css` (112,876 raw; 19,561 gzip).

TB2 emitted assets: `index-T9siV2LE.js` (1,006,255 raw; 304,225 gzip) and
`index-NmV-0yUO.css` (112,876 raw; 19,561 gzip).
