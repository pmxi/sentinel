# Archive timeout diagnosis

## Conclusion

Reproduced an application keyboard-availability race, not duplicate-subject
matching or an archive/refetch race. The visible reader is ready under the
benchmark contract, but automatic mark-read mutations disable the reader's `e`
command until their HTTP requests complete. The key is discarded, not queued.
No application code or benchmark action timing/conditions were changed; failures
remain counted. Waiting for network idle or retrying inside measured samples
would hide this user-visible behavior.

The original six samples had no diagnostic captures, so their individual causes
cannot be proved retrospectively. This explains the matching symptom reproduced
on the same build, corpus, and throttled profiles.

## Reproduction and checks against alternative explanations

After `pnpm bench:seed` (seed 1), ran:

```sh
pnpm bench:run --url http://localhost:3100 --label archive-diagnosis \
  --actions archive --profiles far,mobile --iterations 10 --diagnostics
```

There were 24 samples (two warmups and ten measured per profile), with 13
failures: nine far and four mobile, including warmups. In every failure:

- A captured `keydown:e` had focus on the selected message-row button, not a
  typing target. Reader subject matched that row; the body contained text.
- The target subject occurred exactly once in the visible list. It remained
  present throughout captured list transitions and at timeout: no removal then
  reappearance was observed.
- At least one automatic `mark_read` POST was outstanding when `e` was pressed;
  a 202 response arrived after the key.
- No archive POST occurred during that sample's entire network sequence.

Full transient evidence is in
`bench/results/archive-diagnosis-2026-11-20T02-08-23.607Z/` (gitignored). Two
representative failures and an already-read control are retained in
[`archive-diagnosis/`](archive-diagnosis/); failure JSON contains all visible row
subjects, DOM history, selected row, focused element, and timestamped HTTP
request/response/finished events. The two timeout screenshots were visually
checked: both show the selected row still present and a populated reader.

### Far, warmup -2

[`far-archive--2.png`](archive-diagnosis/far-archive--2.png),
[`far-archive--2.json`](archive-diagnosis/far-archive--2.json)

Target: `Travel itinerary — Cedar Collective #20952`, eight-message thread.
At the key: reader matched, body length 4,409, exactly one target row.
Times below are relative to the captured keydown (browser epoch; HTTP events
use host epoch, so allow a few milliseconds of clock/event-delivery skew):

| Relative ms | Event |
| ---: | --- |
| -58.7 | Four POSTs `/api/messages/{id}/action`, `mark_read`, `undoable:false` |
| 0 | `keydown:e`, selected row focused, reader/body already rendered |
| +95.3 | First two mark-read responses, HTTP 202 |
| +143.3 | Remaining two mark-read responses, HTTP 202 |
| approximately +30,000 | Timeout; original row still present; no archive POST |

The network sequence also includes list/detail/thread GET refetches. Since there
was no archive request and no observed optimistic removal, these are not evidence
of a successful archive being undone by a refetch.

### Mobile, measured iteration 0

[`mobile-archive-0.png`](archive-diagnosis/mobile-archive-0.png),
[`mobile-archive-0.json`](archive-diagnosis/mobile-archive-0.json)

Target: `Team workshop — Orchard Review #19131`, single-message thread.
At the key: reader matched, body length 4,961, exactly one target row.

| Relative ms | Event |
| ---: | --- |
| -30.7 | POST `/api/messages/00000003-0000-4000-8000-000000004abb/action`, `mark_read` |
| 0 | `keydown:e`, selected row focused |
| +285.3 | Mark-read response, HTTP 202 |
| approximately +30,000 | Timeout; row/reader still present; no archive POST |

### Disconfirming control

After the diagnostic run, without reseeding, opened the failed far target again
in a fresh browser context with the same far profile. It was now read. Used the
same subject/body readiness condition, then sent exactly one `e`, without a sleep
or network-idle wait. It succeeded in **35.5 ms**, and an archive POST was sent
for message `00000003-0000-4000-8000-00000000586c` at approximately +31.8 ms.
This checks that the subject condition, selected row, key dispatch and archive
path can work for that very same thread once mark-read is no longer pending.
See [`control-already-read.json`](archive-diagnosis/control-already-read.json).

## Reachable causal chain in the served build

The unchanged production build comes from the checked-out Node+React code:

1. `apps/web/src/InboxPage.tsx`, reader effect over `thread.data.messages`: for
   each unread displayed message it invokes `performAction({action:"mark_read"})`.
   The captured POST bodies prove this path executes in the reproduced samples.
2. That `performAction` comes from the reader's `useMutation`, whose
   `mutationFn` returns `sentApi.action`. Its `isPending` is `actionPending`.
   Pending mark-read requests are directly observed across the key event.
3. The same reader computes `unavailable = !message || actionPending` and
   registers the `archive` command with `disabled: unavailable`.
4. `apps/web/src/commands.tsx`, `CommandProvider` dispatch, finds only commands
   with the pressed key and `!item.disabled`; an unavailable `e` is ignored.
   DOM evidence shows the key arrived on a non-typing selected row with rendered
   subject/body. No archive POST follows. The already-read control sends one.

React's internal pending flag was not instrumented directly; its value follows
from the checked source and outstanding mutation promises, not from a browser
inspection of React internals. This is why network traces and the same-thread
control accompany the source-based explanation.

The archive toolbar button has no equivalent `actionPending` disabling guard;
the symptom specifically concerns the keyboard benchmark contract. No waiting,
button substitution, retries, or application fixes were introduced into baseline
samples. Final full-run samples use default actions, profiles, and 15 iterations,
with diagnostics off to avoid instrumentation overhead, after another reseed.

## Final tracked baseline

The final reseed inserted 23,032 messages / 20,986 threads in 37.27 seconds.
The full run completed all 595 samples (525 measured, 70 warmups). Five measured
archive samples timed out: lan iterations 5 and 9, broadband iteration 5, mobile
iterations 3 and 12. They remain in `results.json` as failures with null latency;
the process exited 1 after writing both output files. These final samples were
not instrumented, so their individual causes are not independently proven.
The race is latency/state-dependent, not restricted to far/mobile: read state
accumulates across actions and profiles within a run.

`pnpm check` passed: 18 test files passed / 1 skipped; 101 tests passed / 25
skipped (database integration tests require their separate test DB setting).
The new diagnostic tests cover normal and empty evidence, unavailable JSON
bodies, and screenshot errors. No provider worker ran and no production system
was accessed.
