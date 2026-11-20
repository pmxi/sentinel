# rust-solid

Milliseconds: median (p95). Failed samples excluded; see results.json. Two warmups discarded per action/profile.

| Action | local | lan | broadband | far | mobile |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold_start | 182.9 (235.8) | 184.8 (188.6) | 408.8 (414.2) | 869.7 (875.6) | 1972.5 (1978.4) |
| inbox_load | 110.7 (116.3) | 115.0 (117.6) | 249.7 (252.1) | 540.2 (552.8) | 1074.9 (1080.8) |
| open_email | 60.9 (64.2) | 80.0 (94.1) | 185.4 (232.2) | 393.6 (422.2) | 759.7 (922.6) |
| next_email | 44.0 (46.3) | 76.3 (78.1) | 175.1 (205.8) | 376.4 (497.5) | 776.3 (1012.0) |
| archive | 32.4 (43.9) | 29.6 (34.2) | 28.5 (29.7) | 28.9 (30.3) | 28.8 (30.5) |
| search_rare | 46.5 (52.0) | 49.5 (52.7) | 97.1 (101.4) | 191.4 (197.2) | 362.9 (376.1) |
| search_common | 62.5 (68.2) | 66.9 (69.0) | 106.5 (108.8) | 214.3 (227.2) | 446.2 (448.9) |

Median HTTP requests / transferred KB (decimal, request + response headers and encoded bodies completed by paint). In-flight responses contribute no bytes.

| Action | local | lan | broadband | far | mobile |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold_start | 6.0 / 422.0 | 6.0 / 422.1 | 6.0 / 422.2 | 6.0 / 422.2 | 6.0 / 422.1 |
| inbox_load | 6.0 / 75.4 | 6.0 / 75.5 | 6.0 / 75.5 | 6.0 / 75.5 | 6.0 / 75.4 |
| open_email | 6.0 / 191.5 | 2.0 / 65.2 | 2.0 / 132.7 | 2.0 / 103.1 | 2.0 / 73.3 |
| next_email | 2.0 / 95.2 | 2.0 / 64.0 | 2.0 / 91.9 | 2.0 / 102.5 | 2.0 / 84.7 |
| archive | 5.0 / 129.9 | 2.0 / 33.6 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| search_rare | 1.0 / 23.7 | 1.0 / 23.7 | 1.0 / 23.7 | 1.0 / 23.7 | 1.0 / 23.7 |
| search_common | 1.0 / 69.4 | 1.0 / 69.4 | 1.0 / 69.4 | 1.0 / 69.4 | 1.0 / 69.4 |

Failures: 6 (including warmups).

## Target and run notes

- PR #12 commit: `30cb0137740e779a8fb3e6fbcc93da4d62379801` (Rust + SolidJS).
- Release server and production web build; unchanged default benchmark selectors/keys.
- Same machine and Chromium as the Node baseline, seed 1: 23,032 messages / 20,986 threads.
- Reseeded `sent_bench` with this branch's seeder (32.20 seconds); no rewrite seed used.
- Only the Rust server ran on `127.0.0.1:4000` during measurement: no Node server,
  worker, or concurrent builds. Fake providers enabled; OpenAI/provider credentials empty.
- 595 samples: 525 measured, 70 warmups. Diagnostics off. Node restarted on :3100 afterwards.
- Counted archive timeouts: broadband iteration 5; far 3/12; mobile 5/11/12.
  All report `page.waitForFunction: Timeout 30000ms exceeded.`; the completed runner exited 1.
  These Rust failures were not instrumented, so their individual causes are unverified.
- An earlier run against `a023b8c` was superseded; only the `30cb013` run is tracked here.
