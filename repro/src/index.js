// Minimal repro: a supervisor Durable Object creates N facets in one request,
// and each facet writes one value to its own storage. Based on the docs example
// (developers.cloudflare.com/durable-objects/.../durable-object-facets).
//
// GET /?n=18                      -> dynamic class (Worker Loader), storage.kv.put
//     &code=static                -> class exported from this Worker instead
//     &store=sql                  -> storage.sql instead of storage.kv
//     &store=none                 -> facet doesn't touch storage (control)
//     &run=<name>                 -> supervisor instance name (default: random, fresh each time)
import { DurableObject } from "cloudflare:workers";

const CHILD_CODE = `
  import { DurableObject } from "cloudflare:workers";
  export class App extends DurableObject {
    fetch(request) {
      const store = new URL(request.url).searchParams.get("store");
      if (store === "kv") this.ctx.storage.kv.put("counter", 1);
      if (store === "sql") {
        this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
        this.ctx.storage.sql.exec("INSERT INTO t VALUES (1)");
      }
      return new Response("ok");
    }
  }
`;

// The same class, but bundled with this Worker (no Worker Loader involved).
export class StaticApp extends DurableObject {
  fetch(request) {
    const store = new URL(request.url).searchParams.get("store");
    if (store === "kv") this.ctx.storage.kv.put("counter", 1);
    if (store === "sql") {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
      this.ctx.storage.sql.exec("INSERT INTO t VALUES (1)");
    }
    return new Response("ok");
  }
}

export class Supervisor extends DurableObject {
  async fetch(request) {
    const q = new URL(request.url).searchParams;
    const n = Math.min(Number(q.get("n") || 18), 100);
    const code = q.get("code") || "dynamic";
    const store = q.get("store") || "kv";
    const results = [];
    for (let i = 0; i < n; i++) {
      const facet = this.ctx.facets.get(`app-${i}`, async () => ({
        class: code === "static"
          ? this.ctx.exports.StaticApp
          : this.env.LOADER.get("repro-child-v1", async () => ({
              compatibilityDate: "2026-09-04",
              mainModule: "child.js",
              modules: { "child.js": CHILD_CODE },
              globalOutbound: null,
            })).getDurableObjectClass("App"),
      }));
      try {
        const res = await facet.fetch(`https://facet/?store=${store}`);
        results.push({ i, ok: res.ok });
      } catch (e) {
        results.push({ i, error: String(e.message || e) });
        break;
      }
    }
    const firstError = results.find((r) => r.error);
    return Response.json({ n, code, store, succeeded: results.filter((r) => r.ok).length, firstError: firstError || null });
  }
}

export default {
  async fetch(request, env, ctx) {
    const q = new URL(request.url).searchParams;
    if (env.TOKEN && request.headers.get("authorization") !== `Bearer ${env.TOKEN}`) return new Response("unauthorized", { status: 401 });
    const name = q.get("run") || crypto.randomUUID();
    return ctx.exports.Supervisor.getByName(name).fetch(request);
  },
};
