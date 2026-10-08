# Repro: `ctx.facets.abort()` on facets that wrote storage resets the parent

A Durable Object that unloads its facets with `ctx.facets.abort()` gets reset itself after roughly
20-30 of them, **if those facets wrote anything to their own storage**:

```
Internal error in Durable Object storage caused object to be reset; reference = <id>
```

- Facets that don't touch storage: 100 aborts, no problem.
- Facets that wrote storage but aren't aborted (left for the runtime to unload): 100, no problem.
- Facets that wrote storage and are removed with `ctx.facets.delete()` instead: 100, no problem.
- Facets that wrote storage (SQL or KV) and are `abort()`ed: the parent resets.

It's a running total per parent instance, not per request. Three requests of 10 work, and the fourth
fails at facet #32 overall. After a reset the parent comes back and keeps working. In one test it
reset again 17 facets later.
It happens with a facet class from Worker Loader and with one bundled in the Worker, so Worker Loader
isn't involved.

What the facets and the parent store changes **where** it breaks:

| Facet writes | Parent also writes after each facet | Fails at facet # |
|---|---|---|
| nothing | yes | never (100/100) |
| `storage.kv.put` | no / yes | 32 / 22 |
| plain SQL table | no / yes | 32 / 22 |
| `INTEGER PRIMARY KEY` table | yes | 22 |
| `INTEGER PRIMARY KEY AUTOINCREMENT` table | no / yes | 26 / 18 |

Seen on 2026-10-08 in production, compatibility date `2026-09-04`. The code is
[`src/index.js`](src/index.js), about 110 lines. Raw output is in [`results/`](results/).

## Run it

```sh
npm install
npx wrangler deploy --config repro/wrangler.jsonc     # or: npm run repro:deploy
U=https://facet-storage-repro.<your-subdomain>.workers.dev

curl "$U/?n=40&store=sql&abort=1"        # succeeded 31, then "Internal error in Durable Object storage..."
curl "$U/?n=40&store=sql&abort=delete"   # succeeded 40
curl "$U/?n=40&store=sql"                # succeeded 40 (no abort)
curl "$U/?n=40&store=none&abort=1"       # succeeded 40 (facets never wrote)

npx wrangler delete --config repro/wrangler.jsonc     # clean up
```

Each request gets a fresh parent (random name) unless you pass `&run=<name>`. When the parent itself is
reset mid-request, the response is `{"supervisorReset": true, "error": "..."}` with status 500.

| Switch | Meaning |
|---|---|
| `n`, `start` | create facets `app-<start>` ... `app-<start+n-1>` (n ≤ 100) |
| `code=dynamic` / `static` | facet class from Worker Loader (default) / exported from this Worker |
| `store=sql` | facet: plain table `t (v INTEGER)` + one insert |
| `store=pk` | facet: `t (k INTEGER PRIMARY KEY, v TEXT)` + one insert |
| `store=auto` | facet: `t (k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)` + one insert |
| `store=size` | like `sql`, then reads `storage.sql.databaseSize` |
| `store=kv` / `none` | facet: one `storage.kv.put` / no storage (default `kv`) |
| `parent=write` | the parent inserts one row in its own SQLite after each facet |
| `table=<name>` | table the parent writes to (default `seen`) |
| `abort=1` / `abort=delete` | after each facet: `ctx.facets.abort(name)` / `ctx.facets.delete(name)` |
| `run=<name>` | reuse one parent across requests |
| `TOKEN` secret | optional; if set, requests need `Authorization: Bearer <token>` |

## Workaround

If a facet has written storage, don't `abort()` it. Either leave it alone, since the runtime unloads
idle facets by itself (5,000 in the main stress test), or `delete()` it if you're done with its data.

## How it was found

The stress test in the repo root ([FINDINGS.md](../FINDINGS.md)) creates facets that each write one row,
records them in the parent and aborts them. It failed at exactly 18 every time. Switching off one part of
that harness at a time, then sweeping each switch here up to 100 facets, gave the table above. The 18 was
the AUTOINCREMENT-plus-parent-writes case, the lowest threshold of the lot.
