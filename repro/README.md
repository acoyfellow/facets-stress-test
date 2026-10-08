# Durable Object facets: parent storage reset after 17 children

A supervisor Durable Object that creates more than 17 facets in one request gets reset with

```
Internal error in Durable Object storage caused object to be reset; reference = <id>
```

when **all four** of these are true:

1. each facet writes a row to a table declared `INTEGER PRIMARY KEY AUTOINCREMENT`,
2. the supervisor writes to its own SQLite after each facet,
3. the supervisor unloads each facet with `ctx.facets.abort()` after using it,
4. there are 18 or more facets.

Drop any one of them and 18 and 30 facets both work. It happens with a Dynamic Worker (Worker Loader)
facet class and with a class bundled in the Worker, so Worker Loader isn't involved.
The error escapes the supervisor's own `try/catch` around the facet call. The whole object is reset,
so it surfaces at the caller.

Seen on 2026-10-08, compatibility date `2026-09-04`, wrangler 4.x. The code is [`src/index.js`](src/index.js), about 100 lines.

## Run it

```sh
npx wrangler deploy --config repro/wrangler.jsonc
U=https://facet-storage-repro.<your-subdomain>.workers.dev

curl "$U/?n=17&store=auto&parent=write&abort=1"   # ok: succeeded 17
curl "$U/?n=18&store=auto&parent=write&abort=1"   # 500: supervisorReset, "Internal error in Durable Object storage..."
```

Each request uses a fresh supervisor (random name) unless you pass `&run=<name>`.

| Switch | Meaning |
|---|---|
| `n` | facets created in one request (max 100) |
| `code=dynamic` / `static` | facet class from Worker Loader / exported from this Worker |
| `store=auto` | facet: `CREATE TABLE t (k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)` + one insert |
| `store=sql` | facet: plain table `t (v INTEGER)` + one insert |
| `store=size` | like `sql`, then reads `storage.sql.databaseSize` |
| `store=kv` / `none` | facet: `storage.kv.put` / no storage |
| `parent=write` | supervisor inserts one row in its own SQLite after each facet |
| `table=<name>` | table the supervisor writes to (default `seen`) |
| `abort=1` | supervisor calls `ctx.facets.abort(name)` after each facet |
| `TOKEN` secret | optional; if set, requests need `Authorization: Bearer <token>` |

## Results (production, 2026-10-08)

| Facet storage | Parent writes | Abort | Code | n=17 | n=18 |
|---|---|---|---|---|---|
| auto | yes | yes | dynamic | ok | **reset** (4 of 4) |
| auto | yes | yes | static | ok | **reset** (3 of 3) |
| auto | no | yes | dynamic | ok | ok |
| auto | yes | no | dynamic | ok | ok |
| sql | yes | yes | dynamic | ok | ok |
| size | yes | yes | dynamic / static | ok | ok |
| kv | yes / no | yes / no | dynamic / static | ok | ok |
| none | yes / no | yes / no | dynamic / static | ok | ok |

n=30 behaves like n=18. Raw output: [`results/`](results/). Reference ids from the failures are in
`results/error-text-2026-10-08.txt`.

## Why 17

Unknown. A guess: with AUTOINCREMENT each facet database also gets a `sqlite_sequence` table, and
something about tracking aborted facet databases inside the parent's storage overflows after 17. That is
only a guess and is not verified.

This was found by the stress test in the repo root ([FINDINGS.md](../FINDINGS.md)), then narrowed down by
switching off one part of that harness at a time.
