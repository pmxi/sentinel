# Browser speed benchmark

Fake mail only. **Never run against production.** The seeder refuses database names
that do not start with `sent_bench`; the browser runner can target any URL and does
not have that protection. Archive changes data: reseed before every full run.

## Setup, seed, serve

From the repository root:

```sh
pnpm install --frozen-lockfile
# Install pinned Playwright's headless Chromium (no CI changes required):
pnpm --dir bench exec playwright install chromium
POSTGRES_PORT=5433 docker compose up -d postgres
docker exec sent-postgres-1 psql -U sent -d sent -c 'create database sent_bench'
```

Configure the root `.env` following `.env.example` and the repository setup guide:
`DATABASE_URL=postgres://sent:sent-local-only@localhost:5433/sent_bench`, a hashed
local login password, random session/encryption keys, empty OpenAI/provider keys,
`PORT=3100`, `SENT_PUBLIC_URL=http://localhost:3100`, and empty `SENT_WEB_URL`.

```sh
pnpm bench:seed --seed 1
pnpm build
NODE_ENV=production WEB_DIST_PATH="$PWD/apps/web/dist" node --env-file=.env apps/server/dist/index.js
```

Run **only the server**, not `pnpm dev` (which also runs the worker). The seeder
uses core migrations, resets mail tables transactionally, inserts 23,032 messages
in 20,986 threads, and uses a fixed clock (`2026-11-20`) for reproducibility.
All classified messages have cleaned reader text. Search fixtures are exported
as `SEARCH_TERMS` from `src/data.ts`.

The inbox has 928 inbound threads / 1,061 messages with sizes
`1:868, 2:13, 3:32, 4:11, 5:1, 6:1, 8:2`. Thread times are shuffled;
the newest 75 inbox threads contain 119 messages (mean 1.59, max 8).
Larger conversations are archived and spread across the years. Another 695
outbound messages are unarchived, for 1,756 unarchived messages of any direction.

## Run any build

The runner uses browser/HTTP only: no DB, internal application imports, or build
assumptions. A rewrite can serve the same API/login contract and DOM contract below.

```sh
SENT_BENCH_PASSWORD=sent-local-dev-password pnpm bench:run \
  --url http://localhost:3100 --label node-react \
  --iterations 15 --profiles local,lan,broadband,far,mobile

pnpm bench:compare bench/results/old/results.json bench/results/new/results.json
```

`--url` is required; `--password` overrides `SENT_BENCH_PASSWORD` (environment is
preferable to shell history). Optional `--selectors path/to/overrides.json` and
`--out path/to/results` are relative to the invoking directory. Default output is
`bench/results/<label>-<ISO timestamp>/`. Results are gitignored. Iterations default
to 15, limited to 1–100, plus exactly two discarded warmups for each action/profile.
Archive is therefore bounded to 102 mutations per profile. Each failure is recorded
and later actions continue; the process exits nonzero if any sample failed.

When archive is selected, an untimed authenticated HTTP preflight paginates
`GET /api/messages?view=l1&limit=75` using `cursor` / `nextCursor`, counting distinct
`messages[].threadId` values. It rejects runs whose aggregate archive attempts
across all selected profiles (including warmups), plus rows reserved for varied
selection and next-email, exceed the available Important inbox. Lower iterations,
select fewer profiles, or reseed if rejected. Other builds must implement this
read-only pagination contract as well as login; non-archive runs skip the check.
Counting stops once sufficient inventory is proven; it never archives during setup.

`results.json` contains metadata (URL, label, date, browser, host CPU/RAM/OS,
network conditions, selectors, timeout), individual samples, warmups, and failures.
Each sample also records HTTP request count and transferred bytes during its exact
browser-clock trigger-to-paint window, using Playwright request/response events.
Bytes include request/response headers and encoded bodies for requests completed
by paint; still-in-flight/failed responses contribute no bytes, although their
requests are counted. Background requests begun before the trigger are excluded.
The summary's second table shows median requests / decimal KB. This is not a
packet-level wire meter, and cache/header accounting follows Chromium/Playwright.
`summary.md` reports successful measured samples as median (p95), in milliseconds,
using linearly interpolated percentiles. Compare prints B/A ratios; below 1 is faster.

For focused reproduction, `--actions archive --profiles far,mobile --iterations 10`
runs only archive samples. `--diagnostics` saves a screenshot and JSON evidence
for each failed sample (including warmups), linked by its `evidence` field. JSON
includes reader/body readiness, selected row, focus, visible row subjects and DOM
transitions, plus timestamped HTTP requests/responses and mail state. Evidence
contains the target build's mail data: use fake benchmark data only. Diagnostic
collection adds overhead; leave it off for comparison baselines.

Tracked baselines live under `bench/baselines/`; transient `bench/results/` remains
ignored. The Node+React baseline and archive-timeout diagnosis are in
[`baselines/node-react-2026-11-20/`](baselines/node-react-2026-11-20/).

## What is measured

A capturing in-page listener records the triggering keydown/click/submit's
`event.timeStamp`. A MutationObserver checks the completion condition; double
`requestAnimationFrame` records `performance.now()` at the next frame after it
holds. Both values share the browser performance clock. This approximates visible
event-to-paint latency, not network duration or React commit time; it is not a
hardware display/compositor measurement. No CPU throttling is applied.

Navigation samples measure navigation start (0) to the same painted condition.
Login is untimed via POST `/api/auth/login`, JSON `{password}`, header
`x-sent-request: 1`; its cookie storageState is reused in fresh browser contexts,
avoiding authentication rate limits without sharing HTTP caches.

Each sample has its own context and 1440×1000 viewport. Cold start uses an empty
cache; inbox load first navigates untimed and then reloads with that context's warm
HTTP cache. Other actions start from a freshly loaded inbox. Row index varies by
iteration, rather than repeatedly opening the same mail. Setup is untimed, and
each operation has a 30-second timeout. Service workers are blocked.

Actions:
- `cold_start`, `inbox_load`: at least 10 rendered list rows.
- `open_email`: clicked row's normalized subject matches reader, body has content.
- `next_email`: reader open, next key, next row's distinct subject and body rendered.
- `archive`: reader open, archive key, original row subject disappears from list.
- `search_rare`, `search_common`: focus shortcut and fill untimed, submit timed;
  first result contains the search term and differs from the inbox first row.

### Network profiles

Exported from `src/metrics.ts`; CDP `Network.emulateNetworkConditions` is applied
to every measured page before navigation. Latency is CDP per-request latency
(specified here as simulated RTT), **not** half the value. Throughputs are converted
from decimal Mbps to bytes/second; unthrottled uses CDP's `-1`.

| Profile | RTT / request latency | Download | Upload |
| --- | ---: | ---: | ---: |
| local | 0 ms | unlimited | unlimited |
| lan | 20 ms | unlimited | unlimited |
| broadband | 60 ms | 50 Mbps | 10 Mbps |
| far | 150 ms | 20 Mbps | 5 Mbps |
| mobile | 300 ms | 5 Mbps | 1 Mbps |

## Selector / keyboard contract

Override any of these flat JSON fields; unknown fields and empty values are errors:

```json
{
  "rows": "button.message-row",
  "rowSubject": ".message-subject",
  "readerSubject": ".conversation-heading h2",
  "body": ".latest-message .email-body",
  "search": "input[aria-label=\"Search mail\"]",
  "nextKey": "j",
  "archiveKey": "e",
  "searchKey": "/",
  "submitKey": "Enter"
}
```

`rowSubject` is relative to each row; other selectors are document-relative.
Subjects are trimmed and leading Re/Fw/Fwd prefixes stripped. Subjects must uniquely
identify visible conversations; next-row subjects must differ. The list must remain
visible with the reader open, and keyboard navigation must follow list order.
Virtual lists expose zero-based `data-index` attributes on rows. Untimed setup
scrolls `.message-list` until the target row (and its neighbor for `next_email`)
exists and is visible; non-virtual lists retain their normal DOM order. No setup
is added to the timed region. Body must contain nonempty text,
or a readable same-origin iframe containing text. Search is submit-on-Enter, not
live-as-you-type; first matching row must contain the submitted term. Loading
placeholders must not match the row/body selectors. Keys are Playwright key strings;
single-character shortcuts use their literal character as KeyboardEvent.key.
Timing matches the final key (or physical key code) and exact modifiers in a
Playwright chord such as `Control+Enter`; modifier-down events do not start it.
`ControlOrMeta` follows the browser platform.

## Caveats

- Search is lexical: seeded data has no embeddings and OpenAI is disabled.
- Worker is not running: archive persists optimistically and stays pending in the
  mutation outbox. Reader opening can also enqueue mark-read actions.
- Archive and read state accumulate; reseed between full runs/build comparisons.
- Two warmups are browser/server warmup, not shared client-cache warmup; only the
  explicit reload action warms the HTTP cache within a sample.
- A local machine is not the production box. Host contention, browser version,
  server caches, build mode, and corpus affect results. Compare identical profiles,
  iterations, seed, hardware, and conditions; 3 iterations is only a smoke check.
- The runner trusts the target URL; it cannot enforce that a remote build points
  at a benchmark database. Confirm that yourself before using it.
