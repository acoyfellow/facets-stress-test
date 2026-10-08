// Minimal repro: a supervisor Durable Object creates N facets in one request,
// and each facet writes one value to its own storage. Based on the docs example
// (developers.cloudflare.com/durable-objects/.../durable-object-facets).
//
// Fails:  GET /?n=18&store=auto&parent=write&abort=1   (all switches: see README.md)
// Works:  the same with n=17, or with any one of store=auto / parent=write / abort=1 changed.
import { DurableObject } from "cloudflare:workers";

// What the facet does with its own storage. Shared by both facet classes below.
//   kv    storage.kv.put
//   sql   plain table + insert
//   auto  AUTOINCREMENT table + insert
//   size  plain insert, then read storage.sql.databaseSize
//   none  doesn't touch storage
function useStorage(ctx, store) {
  const sql = ctx.storage.sql;
  if (store === "kv") ctx.storage.kv.put("counter", 1);
  if (store === "sql" || store === "size") {
    sql.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
    sql.exec("INSERT INTO t VALUES (1)");
  }
  if (store === "auto") {
    sql.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
    sql.exec("INSERT INTO t (v) VALUES (?)", "y");
  }
  if (store === "size") return String(sql.databaseSize);
  return "ok";
}

const CHILD_CODE = `
  import { DurableObject } from "cloudflare:workers";
  ${useStorage.toString()}
  export class App extends DurableObject {
    fetch(request) {
      return new Response(useStorage(this.ctx, new URL(request.url).searchParams.get("store")));
    }
  }
`;

// The same class, but bundled with this Worker (no Worker Loader involved).
export class StaticApp extends DurableObject {
  fetch(request) {
    return new Response(useStorage(this.ctx, new URL(request.url).searchParams.get("store")));
  }
}

export class Supervisor extends DurableObject {
  async fetch(request) {
    const q = new URL(request.url).searchParams;
    const n = Math.min(Number(q.get("n") || 18), 100);
    const code = q.get("code") || "dynamic";
    const store = q.get("store") || "kv";
    const parentWrites = q.get("parent") === "write";
    const abort = q.get("abort") === "1";
    // Table the supervisor writes to. "facets" is the suspect; anything else is the control.
    const table = /^[a-z_]{1,20}$/.test(q.get("table") || "") ? q.get("table") : "seen";
    const results = [];
    for (let i = 0; i < n; i++) {
      const facet = this.ctx.facets.get(`app-${i}`, async () => ({
        class: code === "static"
          ? this.ctx.exports.StaticApp
          : this.env.LOADER.get("repro-child-v2", async () => ({
              compatibilityDate: "2026-09-04",
              mainModule: "child.js",
              modules: { "child.js": CHILD_CODE },
              globalOutbound: null,
            })).getDurableObjectClass("App"),
      }));
      try {
        const res = await facet.fetch(`https://facet/?store=${store}`);
        // parent=write: the supervisor also writes to its own SQLite after each facet.
        if (parentWrites) {
          this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY)`);
          this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES (?)`, `app-${i}`);
        }
        // abort=1: unload the facet right after using it.
        if (abort) this.ctx.facets.abort(`app-${i}`, new Error("done with this facet"));
        results.push({ i, ok: res.ok });
      } catch (e) {
        results.push({ i, error: String(e.message || e) });
        break;
      }
    }
    const firstError = results.find((r) => r.error);
    return Response.json({ n, code, store, parentWrites, succeeded: results.filter((r) => r.ok).length, firstError: firstError || null });
  }
}

export default {
  async fetch(request, env, ctx) {
    const q = new URL(request.url).searchParams;
    if (env.TOKEN && request.headers.get("authorization") !== `Bearer ${env.TOKEN}`) return new Response("unauthorized", { status: 401 });
    const name = q.get("run") || crypto.randomUUID();
    try {
      return await ctx.exports.Supervisor.getByName(name).fetch(request);
    } catch (e) {
      // The supervisor itself gets reset, so the error surfaces here, not inside its loop.
      return Response.json({ supervisorReset: true, error: String(e && e.message || e) }, { status: 500 });
    }
  },
};
