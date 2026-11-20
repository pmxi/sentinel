# Browser benchmark investigation (2026-11-20)

Fake local data only. PR #13's unmodified `bench/` ran from a separate worktree.
Node/React, Rust/Solid before, and Rust/Solid after each received a fresh seed 1
in `sent_bench_pr12` (23,032 messages / 20,986 threads). Only the API server ran;
the local launcher/worker was stopped. All three full runs used Chromium
145.0.7632.6 on the same 8-core Linux machine, 15 measured iterations plus two
discarded warmups per action/profile, `inbox_load,archive`, and `local,lan`.
No `apps/` or benchmark source was changed.

## Inbox transport stall

The original Rust listener accepted Tokio TCP streams without disabling Nagle.
The actual browser reload of `/inbox/l1` received the HTML headers in about
0.6 ms, but the 518-byte HTML body only completed at 41–42 ms. The JS/CSS requests
could not start until about 42 ms. Node's HTML completed in about 2–3 ms. The
connection was reused (`connectStart = -1`); this was not connection setup.

A control using a single persistent Python HTTP/1.1 connection with
`TCP_QUICKACK=0` reproduced the delay without Postgres, JavaScript, or rendering:

| Server | Headers | Complete HTML body |
| --- | ---: | ---: |
| Rust before | 0.3–0.6 ms | 40.9–41.1 ms |
| Node | 0.9–5.1 ms | 0.9–5.1 ms |
| Rust with TCP_NODELAY | 0.2–0.8 ms | 0.2–0.9 ms |

`server/src/main.rs` now applies `TCP_NODELAY` to every accepted connection before
Axum serves it. A socket-level test checks two accepted connections through the
same listener factory used by `main`; invalid/occupied bind addresses are covered
too. The browser's HTML completion delay disappeared as well. Keep-alive, HTTP
responses, static-file handling, API calls, pool settings, compression, and query
behavior were not changed.

### Per-request measurements

Curl TTFB medians in milliseconds, one discarded request followed by 15 measured
requests per URL. These supplemental runs used the same read-only benchmark DB
snapshot for all three servers. TTFB includes local TCP/HTTP overhead; it is not
being presented as database execution time. Asset digests differ between builds.
Browser reloads reuse/revalidate assets; these curl calls additionally measure
the uncached server path for each logical request in the six-request window.

| Request | Node | Rust before | Rust after |
| --- | ---: | ---: | ---: |
| `/inbox/l1` | 0.830 | 0.359 | 0.359 |
| `/assets/index-*.js` | 0.850 | 0.322 | 0.295 |
| `/assets/index-*.css` | 0.889 | 0.296 | 0.285 |
| `/api/auth/session` | 0.674 | 0.202 | 0.198 |
| `/api/accounts` | 1.069 | 0.458 | 0.584 |
| `/api/messages?view=l1&limit=75` | 25.144 | 21.439 | 20.970 |

The slower-query hypothesis did not survive this check: Rust's list endpoint was
faster, not slower. Both pools have a maximum of 12 connections. Both builds use
HTTP/1.1 keep-alive and uncompressed API responses. The isolated static-response
control rules out database/pool behavior and Solid rendering as explanations for
the approximately 40 ms HTML stall.

A browser interception control held `/api/accounts` open: both builds still
started `/api/messages?view=l1&limit=75` before accounts was released. The list
does not serially wait for accounts. Session gating and parallel query behavior
were preserved, not replaced by prefetching.

### Client tracing

Five local reload traces per build were captured with CDP Tracing, including
`devtools.timeline`, `v8`, `v8.execute`, and `blink.user_timing`. These are separate
instrumented measurements, not the 15-iteration uninstrumented benchmark.
The table gives median renderer-main-thread interval unions inside the same
navigation-to-list-paint window; nested events are not counted twice.

| Trace interval | Node | Rust/Solid before | Rust/Solid after |
| --- | ---: | ---: | ---: |
| JS: module evaluation, EvaluateScript, FunctionCall, RunMicrotasks | 36.4 ms | 48.8 ms | 46.7 ms |
| Style/layout | 17.1 ms | 18.0 ms | 16.9 ms |
| Paint | 2.6 ms | 2.5 ms | 2.4 ms |
| Navigation to list paint | 110.4 ms | 150.3 ms | 110.9 ms |

The Solid traces still contain more JS/microtask work, not more layout/paint work.
This category-level evidence does not establish one component as the cause of
that remaining CPU cost. No rendering/cache/prefetch workaround was added.
The full benchmark below **still shows a local gap versus Node**; it would be
incorrect to claim that all local performance differences were eliminated, or
that this machine reproduced the historical exact 82.7/110.7 ms medians.

## Archive shortcut race

`Reader` used `!message() || action.isPending` for both `e` and `#`. Its automatic
mark-read effect submits unread messages through that same mutation. The command
dispatcher discards disabled commands. A populated reader is therefore not
sufficient to make the shortcut available.

In a real-browser control, holding automatic mark-read requests reproduced this:
before the fix there were two pending reads, `e` was not prevented, no archive
POST occurred, and the target row remained. Releasing those reads and pressing
`e` again archived it. After the fix, with three reads still held, `e` was
prevented, an archive POST was sent, and the target row disappeared before reads
were released. These are controlled race reproductions, not benchmark samples.

The reader now exempts mark-read/unread from the triage-only pending guard.
Other pending mutations still block those shortcuts. `TriageProvider.perform`
rejects duplicate submissions for an already-hidden conversation, including an
archive followed by delete. Failure clears that guard so retry works. Seven new
tests exercise the actual providers/router/keyboard dispatcher, empty/error
states, and duplicate/retry handling.

### Why more archive-window requests/bytes in Solid?

These are real auto-advance and existing invalidation requests, not five archive
writes. An additional CDP capture on the unchanged Solid build recorded these
five initiations within one 34.7 ms trigger-to-paint window:

| Relative time | Request | Cause |
| --- | --- | --- |
| +3.8 ms | `POST /api/messages/{current}/action` | Archive |
| +5.4 ms | `GET /api/messages/{next}` | Auto-advance loads the next reader |
| +25.7 ms | `GET /api/threads/{nextThread}?trash=false` | Next detail enables its thread query |
| +28.8 ms | `GET /api/messages?view=l1&limit=75` | Successful triage invalidates the list |
| +29.1 ms | `GET /api/messages/{next}` | The same success invalidates active detail queries |

That example transferred about 149 KB by paint. The next message's detail was
about 48 KB and its thread about 97 KB; another detail GET was still finishing.
In the additional Node captures only the archive POST landed in the measured
window (30/30 examples, roughly 1.2 KB). React/Solid scheduling changes which
otherwise-existing requests overlap this very short paint window.

The benchmark counts completed bytes, not eventual traffic. Its request timing
records are also updated as responses arrive, so a still-pending list GET can
appear in CDP's five initiations but not yet in its reported count of four.
The historical median of five / 129.9 KB has no retained per-request capture to
assign exact IDs to retrospectively. The extra next-detail/thread/invalidation
sequence is reproduced above; the fresh full run's medians were three / 60.3 KB
before and two / 35.2 KB after. Request/refetch/invalidation policies were left
unchanged rather than moving work outside the benchmark window.

## Full benchmark results

Output from `bench:compare`, omitting only rows for actions that were not run.
Milliseconds; ratio B/A (<1 is faster).

Comparison: rust-solid-before (A) → rust-solid-after (B).

| Action | Profile | A median | B median | B/A | A req / KB | B req / KB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| inbox_load | local | 139.0 | 124.7 | 0.90 | 6.0 / 75.4 | 6.0 / 75.4 |
| inbox_load | lan | 180.1 | 146.9 | 0.82 | 6.0 / 75.5 | 6.0 / 75.5 |
| archive | local | 32.6 | 30.3 | 0.93 | 3.0 / 60.3 | 2.0 / 35.2 |
| archive | lan | 31.9 | 32.1 | 1.01 | 2.0 / 27.3 | 2.0 / 33.3 |

Failures (including warmups): A=0, B=0.

Comparison: node-react (A) → rust-solid-after (B).

| Action | Profile | A median | B median | B/A | A req / KB | B req / KB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| inbox_load | local | 97.6 | 124.7 | 1.28 | 6.0 / 77.1 | 6.0 / 75.4 |
| inbox_load | lan | 160.5 | 146.9 | 0.92 | 6.0 / 77.2 | 6.0 / 75.5 |
| archive | local | 31.2 | 30.3 | 0.97 | 1.0 / 1.2 | 2.0 / 35.2 |
| archive | lan | 29.6 | 32.1 | 1.08 | 1.0 / 1.2 | 2.0 / 33.3 |

Failures (including warmups): A=6, B=0. Node's failures were all LAN archive
timeouts (one warmup, five measured); they remain counted. The prescribed full
Solid before run had no timeouts; the controlled pending-read case above and two
timeouts in an additional local capture establish that the old guard is reachable,
not that every historical failure had that cause.

## Reproduction and local evidence

Use PR #13's README for building Node and starting either server, with only a
local `sent_bench*` database and no worker. In the benchmark worktree, before
**each** full run:

```sh
# DATABASE_URL and the server's local-only auth configuration must be set.
pnpm exec tsx bench/src/seed.ts --seed 1
SENT_BENCH_PASSWORD=sent-local-dev-password pnpm bench:run \
  --url http://127.0.0.1:3100 --label rust-solid-after \
  --iterations 15 --profiles local,lan --actions inbox_load,archive \
  --out /home/ubuntu/perf-pr12/rust-solid-after
pnpm bench:compare /home/ubuntu/perf-pr12/rust-solid-before/results.json \
  /home/ubuntu/perf-pr12/rust-solid-after/results.json
```

`pnpm exec tsx` supplies the same seed command without requiring a worktree `.env`
file; all configuration was injected in the local process environment.
Raw results, seed logs, curl samples, five `*-cpu-inbox-*.trace.json` files per
build, race-control JSON/screenshots, and archive-window CDP captures were saved
outside Git under `/home/ubuntu/perf-pr12/`. The temporary investigation helpers
there are not application or benchmark changes.
