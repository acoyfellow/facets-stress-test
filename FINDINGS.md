# Facet stress test: findings (production, 2026-10-08)

One parent Durable Object, children loaded with Worker Loader as facets.
No AI calls. Raw data: `results/prod-*.json`, probe logs `results/probes-2026-10-08.txt`.

| Test | Result |
|---|---|
| 5,000 tiny children in one parent | Never broke. Load latency rose 31 ms -> 62 ms p50. Parent never restarted. |
| Were they still warm afterwards? | 0 of 5,000. The runtime unloads idle children while keeping the parent alive. Reload ~95 ms each. |
| 400 children each holding 1 MB | Never broke (400 MB total > 128 MB isolate). 6 still warm, 394 reloaded. Memory pressure evicts children, not the parent. |
| 400 children, each its own Dynamic Worker | Never broke, 32-35 ms p50. All unloaded afterwards. |
| 200 children, own Worker, 8 MB each | Never broke, 35-57 ms p50. All unloaded afterwards. |
| Churn (load -> ping -> unload) | Shared Worker: 1 ms p50. Own Worker: 11 ms p50. |
| Stampede (all tick at once) | 500 shared children: 500/500 in 179 ms. 40 own-Worker children: only 10/40 succeed (matches the documented 10 distinct Dynamic Workers in flight per DO). |
| Child throws | Parent fine, sibling still warm. |
| Child infinite loop | "Worker exceeded CPU time limit". Parent fine, sibling still warm. |
| Child deep recursion | "Maximum call stack size exceeded". Parent fine. |
| Child calls fetch() | Refused: no global outbound access unless given a binding. |
| Child memory bomb | "Worker exceeded memory limit". Parent fine, sibling still warm. |
| Child returns 100 MB | Delivered fine. |
| Child writes 256 MB to its SQLite | Fine (4.1 s). |
| Child hangs forever | Parent's own 20 s timeout fires; parent survives, but the sibling child was no longer warm afterwards. |
| Nesting | Max depth 4 including the root DO: "Facet nesting depth limit exceeded. The maximum depth including the root Durable Object is 4." Not in the docs. |

## The surprise: the parent's storage resets after ~17 children write

- Children that **don't** write to their own SQLite: 50 in one parent request, fine (and 5,000 total above).
- Children that **do** write one small row each, in one parent request:
  17 works every time; **18 fails every time** with
  `Internal error in Durable Object storage caused object to be reset`.
  Same at concurrency 1, 2, 5 and 10.
- One writing child per request: the 18th and 28th failed (28/30 ok), so it isn't purely per request.
- Batches of 10 into one parent: the first batch works, every later batch fails.

**Narrowed down later (see [repro/](repro/README.md)).** It needs all four of these together.
Remove any one and 18 (and 30) work:
1. each child writes to a table with `INTEGER PRIMARY KEY AUTOINCREMENT`,
2. the parent writes to its own SQLite after each child,
3. the parent unloads each child with `ctx.facets.abort()`,
4. more than 17 children in one parent.

It happens with a class bundled in the Worker too, so Dynamic Workers aren't part of it.
An earlier line here said "with or without unloading"; that was wrong. Without the unload it passes.
