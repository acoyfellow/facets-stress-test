import { DurableObject } from "cloudflare:workers";
import { childModule } from "./child.js";

// Hard limits. The experiment stops itself here no matter what the driver asks for.
const LIMITS = {
  uniqueWorkers: 1500, // unique Dynamic Worker IDs across the whole run (billing unit)
  facetsPerLab: 200_000,
  batch: 500, // children per request
  stampedeUnique: 40,
};

const json = (data, status = 200) => Response.json(data, { status });
const errText = (e) => String(e && (e.stack || e.message) || e).slice(0, 400);
const now = () => performance.now();

async function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

const summary = (ms) => ({ n: ms.length, p50: pct(ms, 50), p95: pct(ms, 95), max: pct(ms, 100) });

// Global ledger of unique Dynamic Worker IDs (the thing Cloudflare bills per day).
export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ids (id TEXT PRIMARY KEY)");
  }
  count() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM ids").one().n; }
  reserve(ids) {
    const sql = this.ctx.storage.sql;
    const fresh = ids.filter((id) => sql.exec("SELECT 1 FROM ids WHERE id = ?", id).toArray().length === 0);
    const total = this.count();
    if (total + fresh.length > LIMITS.uniqueWorkers) return { ok: false, total, wanted: fresh.length, cap: LIMITS.uniqueWorkers };
    for (const id of fresh) sql.exec("INSERT INTO ids (id) VALUES (?)", id);
    return { ok: true, total: total + fresh.length };
  }
}

export class Lab extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.boot = crypto.randomUUID();
    this.bornAt = Date.now();
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS facets (name TEXT PRIMARY KEY, boot TEXT, worker TEXT)");
  }

  async reserve(ids) {
    const r = await this.env.LEDGER.getByName("ledger").reserve(ids);
    if (!r.ok) throw new Error(`unique Dynamic Worker cap hit: ${JSON.stringify(r)}`);
    return r;
  }

  worker(id, { padKb = 0, cpuMs } = {}) {
    return this.env.LOADER.get(id, () => ({
      compatibilityDate: "2026-09-04",
      mainModule: "child.js",
      modules: { "child.js": childModule({ padKb }) },
      globalOutbound: null,
      ...(cpuMs ? { limits: { cpuMs } } : {}),
    }));
  }

  facet(name, workerId, opts) {
    return this.ctx.facets.get(name, () => ({ class: this.worker(workerId, opts).getDurableObjectClass("Child") }));
  }

  facetCount() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM facets").one().n; }

  record(name, boot, worker) {
    this.ctx.storage.sql.exec("INSERT INTO facets (name, boot, worker) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET boot = excluded.boot, worker = excluded.worker", name, boot, worker);
  }

  parent() {
    return { boot: this.boot, ageMs: Date.now() - this.bornAt, facetsRecorded: this.facetCount(), dbBytes: this.ctx.storage.sql.databaseSize };
  }

  async call(stub, path, timeoutMs = 10_000) {
    const t0 = now();
    const res = await withTimeout(stub.fetch("https://child" + path), timeoutMs, path);
    const text = await res.text();
    const ms = now() - t0;
    let body;
    try { body = JSON.parse(text); } catch { body = { text: text.slice(0, 200), length: text.length }; }
    return { ms, status: res.status, body };
  }

  // Load children and keep them loaded. Optionally make each one hold N MB.
  async hoard({ start = 0, count = 50, mode = "shared", heapMb = 0, padKb = 0, timeoutMs = 10_000 }) {
    count = Math.min(count, LIMITS.batch);
    if (this.facetCount() + count > LIMITS.facetsPerLab) throw new Error("facetsPerLab cap");
    const ids = [];
    for (let i = start; i < start + count; i++) ids.push(mode === "unique" ? `hoard-u-p${padKb}-${i}` : `hoard-s-p${padKb}`);
    await this.reserve([...new Set(ids)]);
    const ms = [];
    const failures = [];
    const isolates = new Set();
    for (let i = start; i < start + count; i++) {
      const name = `c${i}`;
      const workerId = ids[i - start];
      try {
        const r = await this.call(this.facet(name, workerId, { padKb }), heapMb > 0 ? `/hold?mb=${heapMb}` : "/ping", timeoutMs);
        if (r.status !== 200) throw new Error(`status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        ms.push(r.ms);
        isolates.add(r.body.isolate);
        this.record(name, r.body.boot, workerId);
      } catch (e) {
        failures.push({ i, error: errText(e) });
        if (failures.length >= 3) break;
      }
    }
    return { parent: this.parent(), loaded: ms.length, distinctIsolatesThisBatch: isolates.size, latency: summary(ms), failures };
  }

  // Re-ping recorded children: did any of them silently restart (evicted)?
  async census({ start = 0, count = 100, timeoutMs = 10_000 }) {
    const rows = this.ctx.storage.sql.exec("SELECT name, boot, worker FROM facets ORDER BY rowid LIMIT ? OFFSET ?", Math.min(count, LIMITS.batch), start).toArray();
    let same = 0, restarted = 0;
    const failures = [];
    const ms = [];
    for (const row of rows) {
      try {
        const r = await this.call(this.facet(row.name, row.worker, {}), "/ping", timeoutMs);
        ms.push(r.ms);
        if (r.body.boot === row.boot) same++; else { restarted++; this.record(row.name, r.body.boot, row.worker); }
      } catch (e) { failures.push({ name: row.name, error: errText(e) }); if (failures.length >= 3) break; }
    }
    return { parent: this.parent(), checked: rows.length, stillWarm: same, restarted, latency: summary(ms), failures };
  }

  // Create many facets that each write one row and then get unloaded.
  async swarm({ start = 0, count = 200, bytes = 64, concurrency = 1, timeoutMs = 10_000 }) {
    count = Math.min(count, LIMITS.batch);
    if (this.facetCount() + count > LIMITS.facetsPerLab) throw new Error("facetsPerLab cap");
    await this.reserve(["swarm"]);
    const ms = [];
    const failures = [];
    const one = async (i) => {
      const name = `w${i}`;
      try {
        const r = await this.call(this.facet(name, "swarm", {}), `/write?bytes=${bytes}`, timeoutMs);
        if (r.status !== 200) throw new Error(`status ${r.status}`);
        ms.push(r.ms);
        this.record(name, r.body.boot, "swarm");
        this.ctx.facets.abort(name, new Error("swarm: unload"));
      } catch (e) { failures.push({ i, error: errText(e) }); }
    };
    for (let i = start; i < start + count; i += concurrency) {
      const group = [];
      for (let j = i; j < Math.min(i + concurrency, start + count); j++) group.push(one(j));
      await Promise.all(group);
      if (failures.length >= 5) break;
    }
    return { parent: this.parent(), created: ms.length, latency: summary(ms), failures };
  }

  // Load -> ping -> abort, over and over. mode=unique forces a brand-new Dynamic Worker each time.
  async churn({ rounds = 20, k = 5, mode = "shared", tag = "a", timeoutMs = 10_000 }) {
    const plan = [];
    for (let r = 0; r < rounds; r++) for (let j = 0; j < k; j++) plan.push({ name: `ch${j}`, id: mode === "unique" ? `churn-${tag}-${r}-${j}` : "churn-shared" });
    await this.reserve([...new Set(plan.map((p) => p.id))]);
    const ms = [];
    const failures = [];
    for (const p of plan) {
      try {
        const r = await this.call(this.facet(p.name, p.id, {}), "/ping", timeoutMs);
        ms.push(r.ms);
        this.ctx.facets.abort(p.name, new Error("churn"));
      } catch (e) { failures.push({ ...p, error: errText(e) }); if (failures.length >= 3) break; }
    }
    return { parent: this.parent(), cycles: ms.length, latency: summary(ms), failures };
  }

  // One hostile child at a time. Afterwards: is the parent the same instance, and is a canary child still warm?
  async hostile({ kind, mb, timeoutMs = 20_000 }) {
    await this.reserve(["canary", `hostile-${kind}`]);
    const canary = await this.call(this.facet("canary", "canary", {}), "/ping");
    const before = this.parent();
    const t0 = now();
    let outcome;
    try {
      const qs = `/hostile?kind=${kind}${mb ? `&mb=${mb}` : ""}`;
      const r = await this.call(this.facet(`h-${kind}`, `hostile-${kind}`, { cpuMs: kind === "loop" ? 50 : undefined }), qs, timeoutMs);
      outcome = { status: r.status, bodyPreview: JSON.stringify(r.body).slice(0, 300) };
    } catch (e) { outcome = { error: errText(e) }; }
    const elapsedMs = Math.round(now() - t0);
    let canaryAfter;
    try { canaryAfter = (await this.call(this.facet("canary", "canary", {}), "/ping")).body; } catch (e) { canaryAfter = { error: errText(e) }; }
    try { this.ctx.facets.delete(`h-${kind}`); } catch {}
    return {
      kind, elapsedMs, outcome,
      parentSurvived: this.boot === before.boot,
      canaryStillWarm: canaryAfter.boot === canary.body.boot,
      canarySameIsolate: canaryAfter.isolate === canary.body.isolate,
      parent: this.parent(),
    };
  }

  // Everyone at once.
  async stampede({ count = 100, mode = "shared", timeoutMs = 20_000 }) {
    if (mode === "unique") count = Math.min(count, LIMITS.stampedeUnique);
    count = Math.min(count, LIMITS.batch);
    const ids = Array.from({ length: count }, (_, i) => (mode === "unique" ? `stampede-u-${i}` : "stampede-s"));
    await this.reserve([...new Set(ids)]);
    const t0 = now();
    const results = await Promise.allSettled(ids.map((id, i) => this.call(this.facet(`st${i}`, id, {}), "/ping", timeoutMs)));
    const wall = now() - t0;
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === 200);
    const errors = {};
    for (const r of results) if (r.status === "rejected") { const k = errText(r.reason).slice(0, 160); errors[k] = (errors[k] || 0) + 1; }
    return { parent: this.parent(), count, ok: ok.length, wallMs: Math.round(wall), latency: summary(ok.map((r) => r.value.ms)), errors };
  }

  async nest({ depth = 3 }) {
    await this.reserve(["nest"]);
    try {
      const r = await this.call(this.facet("nest-root", "nest", {}), `/nest?depth=${depth}`, 20_000);
      return { requested: depth, result: r.body, parent: this.parent() };
    } catch (e) { return { requested: depth, error: errText(e) }; }
  }

  async wipe() {
    const names = this.ctx.storage.sql.exec("SELECT name FROM facets").toArray().map((r) => r.name);
    let deleted = 0;
    for (const n of names) { try { this.ctx.facets.delete(n); deleted++; } catch {} }
    for (const n of ["canary", "nest-root", ...["loop", "alloc", "recurse", "throw", "fetch", "hang", "bigreturn", "storage"].map((k) => `h-${k}`)]) { try { this.ctx.facets.delete(n); } catch {} }
    await this.ctx.storage.deleteAll();
    return { deleted };
  }

  status() { return this.parent(); }
}

const OPS = new Set(["hoard", "census", "swarm", "churn", "hostile", "stampede", "nest", "wipe", "status"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.EXPIRES && Date.now() > Date.parse(env.EXPIRES)) return json({ error: "experiment expired" }, 410);
    if (!env.TOKEN || request.headers.get("authorization") !== `Bearer ${env.TOKEN}`) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/ledger") return json({ uniqueWorkers: await env.LEDGER.getByName("ledger").count(), cap: LIMITS.uniqueWorkers });
    const m = url.pathname.match(/^\/lab\/([a-z0-9-]{1,40})\/([a-z]+)$/);
    if (!m || !OPS.has(m[2]) || request.method !== "POST") return json({ error: "POST /lab/<name>/<op>", ops: [...OPS] }, 404);
    const args = await request.json().catch(() => ({}));
    const t0 = now();
    try {
      const result = await env.LAB.getByName(m[1])[m[2]](args);
      return json({ ok: true, ms: Math.round(now() - t0), result });
    } catch (e) {
      return json({ ok: false, ms: Math.round(now() - t0), error: errText(e) }, 500);
    }
  },
};
