# facets-stress-test

How far can one Cloudflare Durable Object go as a parent of
[facets](https://developers.cloudflare.com/durable-objects/api/durable-object-facets/),
children it creates at runtime, each a Durable Object with its own SQLite, running code
loaded by [Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)?

The docs say "any number of facets" and stop there. This repo pushes one parent until something
gives. It measures memory, hostile children, everyone-at-once, nesting and churn, and reports
what happened. No AI calls. A full production run cost well under a dollar.

![One Lab Durable Object loading many facet children through Worker Loader](img/shape.svg)

## What we found (production, 2026-10-08)

| Test | Result |
|---|---|
| 5,000 tiny children in one parent | Never broke. Load latency went from 31 to 62 ms p50. The parent never restarted. |
| Still warm afterwards? | 0 of 5,000. Idle children get unloaded while the parent stays alive. Reloading took ~95 ms each. |
| 400 children holding 1 MB each (400 MB, well over the 128 MB isolate limit) | Never broke. 6 stayed warm, 394 had been reloaded. **Memory pressure unloads children, not the parent.** |
| Children that each use their own Dynamic Worker | 400 at 32-35 ms p50; 200 at 8 MB each, 35-57 ms p50. |
| Load, ping, unload, repeated | 1 ms p50 sharing one Worker, 11 ms p50 with a new Worker each time. |
| Everyone at once | 500 children sharing one Worker: 500/500 in 179 ms. 40 children with 40 different Workers: 10/40 succeed, which matches the documented limit of 10 distinct Dynamic Workers in flight per Durable Object. |
| A child loops forever, eats memory, recurses, or throws | Each is stopped ("exceeded CPU time limit", "exceeded memory limit", ...). The parent and a canary sibling are unaffected. |
| A child calls `fetch()` | Refused. Loaded code has no network unless you hand it a binding. |
| A child returns 100 MB / writes 256 MB to its SQLite | Both fine. |
| A child hangs forever | Only the parent's own timeout catches it. The parent survives, but the canary sibling had been unloaded. |
| Facets inside facets | Stops at depth 4 counting the root: "Facet nesting depth limit exceeded". This limit isn't in the docs. |

Details and raw numbers: [FINDINGS.md](FINDINGS.md) and [`results/`](results/).

### The surprise: the parent gets reset at the 18th child

One combination resets the **parent** with
`Internal error in Durable Object storage caused object to be reset`, every time, at exactly 18 children:

1. each child writes to a table declared `INTEGER PRIMARY KEY AUTOINCREMENT`,
2. the parent writes to its own SQLite after each child,
3. the parent unloads each child with `ctx.facets.abort()`,
4. more than 17 children.

Drop any one and 18, or 30, are fine. It also happens with a facet class bundled in the Worker, so
Worker Loader isn't involved. [`repro/`](repro/README.md) is a single 100-line Worker that shows it
with one `curl`.

Takeaway if you build on facets: until this is fixed, avoid `AUTOINCREMENT` in facet tables when the
parent also writes and unloads children. A plain `INTEGER PRIMARY KEY` behaves the same for most uses
and doesn't trigger it.

## Run it yourself

You need Node 20+ and a Cloudflare account with Workers Paid. Facets and Worker Loader aren't on the
free plan.

```sh
git clone https://github.com/acoyfellow/facets-stress-test
cd facets-stress-test
npm install

# 1. Local (fast, free, but no production memory/CPU limits)
echo 'TOKEN=dev' > .dev.vars
npm run dev                                           # http://localhost:8799
SCALE=0.1 node run.mjs http://localhost:8799 dev local

# 2. Production
npx wrangler secret put TOKEN                         # any long random string
npx wrangler deploy --var EXPIRES:2026-12-01T00:00:00Z   # optional self-destruct date
node run.mjs https://facets-stress-test.<you>.workers.dev <token> prod
node run.mjs <url> <token> prod hoard,hostile         # or only some rounds

# 3. Clean up
npx wrangler delete
```

Each run writes `results/<target>-<time>.json` and wipes its labs, including all child storage,
unless you set `KEEP=1`.

Rounds: `hoard` (load and keep), `swarm` (create, write, unload), `churn`, `stampede`, `hostile`, `nest`.
Local runs use `SCALE=0.1` and skip the memory bomb, since local mode would just use up your own RAM.

The minimal repro has its own Worker: `npm run repro:deploy`, then see [repro/README.md](repro/README.md).

### What it costs, and the guard rails

- **Dynamic Workers are billed per unique Worker ID per day** after the first 1,000 a month. Most rounds
  share a handful of IDs. A `Ledger` Durable Object counts every unique ID and refuses to go past 1,500
  for the whole deployment (`LIMITS` in [`src/index.js`](src/index.js)). Our full run used 484.
- At most 500 children per request and 200,000 per lab.
- Every request needs `Authorization: Bearer <TOKEN>`. `EXPIRES` turns the Worker into a 410 after a date.
- No AI, no outbound network from children.

## Layout

```
src/index.js     Lab (the parent) and Ledger Durable Objects, plus the HTTP entry point
src/child.js     generates the child module source (padding, hold memory, write, nest, hostile modes)
run.mjs          driver: ramps each round until it breaks or hits a cap, saves results JSON
results/         raw production and local results from 2026-10-08
repro/           minimal Worker for the storage reset, with its own README
```

## Caveats

- Measured on one day (2026-10-08) on one account with compatibility date `2026-09-04`. Facets are new,
  and limits and behavior may change.
- Latencies are from one location and include the driver's round trip to the Worker for each batch.
- Local `wrangler dev` crashed at ~4,250 children and ~1,000 swarm writes. That's a property of local
  mode, not production, which went further without trouble.

MIT licensed.
