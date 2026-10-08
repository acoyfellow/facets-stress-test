// Repro: a parent Durable Object that unloads facets with ctx.facets.abort() gets reset
// itself after ~20-30 of them, if those facets wrote to their own storage.
// Facets docs: developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
//
// Fails:  GET /?n=40&store=sql&abort=1        parent reset at facet #32
// Works:  GET /?n=40&store=sql&abort=delete   delete() instead of abort()
//         GET /?n=40&store=sql                no abort
//         GET /?n=40&store=none&abort=1       facets never wrote
// All switches: README.md
import { DurableObject } from "cloudflare:workers";

// What a facet does with its own storage. Shared by both facet classes below.
//   kv    one storage.kv.put
//   sql   plain table + insert
//   pk    INTEGER PRIMARY KEY table + insert
//   auto  INTEGER PRIMARY KEY AUTOINCREMENT table + insert
//   size  like sql, then reads storage.sql.databaseSize
//   none  doesn't touch storage
function useStorage(ctx, store) {
  const sql = ctx.storage.sql;
  if (store === "kv") ctx.storage.kv.put("counter", 1);
  if (store === "sql" || store === "size") {
    sql.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
    sql.exec("INSERT INTO t VALUES (1)");
  }
  if (store === "pk") {
    sql.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("INSERT INTO t (v) VALUES (?)", "y");
  }
  if (store === "auto") {
    sql.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
    sql.exec("INSERT INTO t (v) VALUES (?)", "y");
  }
  if (store === "size") return String(sql.databaseSize);
  return "ok";
}

// Facet class loaded at runtime through Worker Loader (code=dynamic, the default).
const CHILD_CODE = `
  import { DurableObject } from "cloudflare:workers";
  ${useStorage.toString()}
  export class App extends DurableObject {
    fetch(request) {
      return new Response(useStorage(this.ctx, new URL(request.url).searchParams.get("store")));
    }
  }
`;

// The same class bundled with this Worker (code=static), to rule Worker Loader out.
export class StaticApp extends DurableObject {
  fetch(request) {
    return new Response(useStorage(this.ctx, new URL(request.url).searchParams.get("store")));
  }
}

export class Supervisor extends DurableObject {
  facetClass(code) {
    if (code === "static") return this.ctx.exports.StaticApp;
    return this.env.LOADER.get("repro-child-v3", async () => ({
      compatibilityDate: "2026-09-04",
      mainModule: "child.js",
      modules: { "child.js": CHILD_CODE },
      globalOutbound: null,
    })).getDurableObjectClass("App");
  }

  async fetch(request) {
    const q = new URL(request.url).searchParams;
    const n = Math.max(1, Math.min(Number(q.get("n") || 40), 100));
    const start = Math.max(0, Math.min(Number(q.get("start") || 0), 100000));
    const code = q.get("code") || "dynamic";
    const store = q.get("store") || "kv";
    const parentWrites = q.get("parent") === "write";
    const after = q.get("abort") === "1" ? "abort" : q.get("abort") === "delete" ? "delete" : "nothing";
    const table = /^[a-z_]{1,20}$/.test(q.get("table") || "") ? q.get("table") : "seen";

    let succeeded = 0;
    let firstError = null;
    for (let i = start; i < start + n; i++) {
      const name = `app-${i}`;
      try {
        const facet = this.ctx.facets.get(name, async () => ({ class: this.facetClass(code) }));
        await facet.fetch(`https://facet/?store=${store}`);
        if (parentWrites) {
          this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY)`);
          this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES (?)`, name);
        }
        if (after === "abort") this.ctx.facets.abort(name, new Error("done with this facet"));
        if (after === "delete") this.ctx.facets.delete(name);
        succeeded++;
      } catch (e) {
        firstError = { i, error: String(e && e.message || e) };
        break;
      }
    }
    return Response.json({ n, start, code, store, parentWrites, after, succeeded, firstError });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (env.TOKEN && request.headers.get("authorization") !== `Bearer ${env.TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const name = new URL(request.url).searchParams.get("run") || crypto.randomUUID();
    try {
      return await ctx.exports.Supervisor.getByName(name).fetch(request);
    } catch (e) {
      // When the supervisor itself is reset, the error surfaces here instead of inside its loop.
      return Response.json({ supervisorReset: true, error: String(e && e.message || e) }, { status: 500 });
    }
  },
};
