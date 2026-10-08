# Facet stress test: findings (production, 2026-10-08)

One parent Durable Object, with children loaded through Worker Loader as facets.
No AI calls. Raw data: `results/prod-*.json`, probe logs `results/probes-2026-10-08.txt`,
repro sweeps `repro/results/`.

| Test | Result |
|---|---|
| 5,000 tiny children in one parent | Never broke. Load latency rose from 31 to 62 ms p50. The parent never restarted. |
| Were they still warm afterwards? | 0 of 5,000. The runtime unloads idle children while keeping the parent alive. Reloading took ~95 ms each. |
| 400 children each holding 1 MB | Never broke (400 MB total, more than a 128 MB isolate). 6 still warm, 394 reloaded. Memory pressure unloads children, not the parent. |
| 400 children, each its own Dynamic Worker | Never broke, 32-35 ms p50. All unloaded afterwards. |
| 200 children, own Worker, 8 MB each | Never broke, 35-57 ms p50. All unloaded afterwards. |
| Churn (load, ping, unload) | Shared Worker: 1 ms p50. Own Worker: 11 ms p50. |
| Stampede (all at once) | 500 shared children: 500/500 in 179 ms. 40 own-Worker children: only 10/40 succeed, which matches the documented 10 distinct Dynamic Workers in flight per DO. |
| Child throws | Parent fine, sibling still warm. |
| Child infinite loop | "Worker exceeded CPU time limit". Parent fine, sibling still warm. |
| Child deep recursion | "Maximum call stack size exceeded". Parent fine. |
| Child calls fetch() | Refused: loaded code has no outbound network unless given a binding. |
| Child memory bomb | "Worker exceeded memory limit". Parent fine, sibling still warm. |
| Child returns 100 MB | Delivered fine. |
| Child writes 256 MB to its SQLite | Fine (4.1 s). |
| Child hangs forever | Only the parent's own 20 s timeout catches it. The parent survives, but the sibling was no longer warm afterwards. |
| Nesting | Max depth 4 including the root DO: "Facet nesting depth limit exceeded. The maximum depth including the root Durable Object is 4." Not in the docs. |

## The surprise: the parent is reset after ~18 children write

How it first showed up in this harness (`swarm`: each child writes one row and is recorded in the
parent, then unloaded with `ctx.facets.abort()`):

- Children that **don't** write to their own SQLite: 50 in one parent request, fine (and 5,000 total above).
- Children that **do** write one small row each, in one parent request: 17 works every time, and
  **18 fails every time** with `Internal error in Durable Object storage caused object to be reset`.
  Same at concurrency 1, 2, 5 and 10.
- One writing child per request: the 18th and 28th failed (28/30 ok), so it isn't per request.
- Batches of 10 into one parent: the first batch works, every later batch fails.

**Narrowed down in [repro/](repro/README.md):** the trigger is `ctx.facets.abort()` on facets that
wrote to their own storage (SQL or KV). Without the abort, with `ctx.facets.delete()` instead, or
with facets that never write, 100 are fine. What gets written only moves the threshold:

- plain SQL or KV in the facet: reset at #32, or #22 if the parent also writes after each facet;
- an `AUTOINCREMENT` table in the facet: #26, or #18 with parent writes (this harness's case).

It's a running total per parent instance, not per request. It happens with a class bundled in the
Worker too, so Dynamic Workers aren't part of it.

Two corrections to earlier drafts of this file. First, it said "with or without unloading"; without the
unload it passes. Second, a later draft blamed `AUTOINCREMENT` plus parent writes. Sweeping each
switch up to 100 facets showed those only make it fail sooner.
