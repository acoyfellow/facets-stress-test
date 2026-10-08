// Driver: ramps each round until it breaks or hits a cap, writes results/<target>-<run>.json
// usage: node run.mjs <baseUrl> <token> <target-label> [rounds,comma,separated]
import { writeFileSync, mkdirSync } from "node:fs";

const [base, token, target = "local", only] = process.argv.slice(2);
if (!base || !token) { console.error("usage: node run.mjs <baseUrl> <token> <target> [rounds]"); process.exit(1); }
const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const tag = run.slice(5, 19).replace(/[^0-9]/g, "").slice(-8);
const out = { target, base: base.replace(/\/\/[^/]+/, "//<host>"), run, rounds: {} };
mkdirSync("results", { recursive: true });
const file = `results/${target}-${run}.json`;
const save = () => writeFileSync(file, JSON.stringify(out, null, 2));

async function op(lab, name, args = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/lab/${lab}/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { ok: false, error: `non-JSON ${res.status}: ${text.slice(0, 300)}` }; }
    return { http: res.status, wallMs: Date.now() - t0, ...body };
  } catch (e) { return { ok: false, http: 0, wallMs: Date.now() - t0, error: String(e).slice(0, 300) }; }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Ramp a hoard until a batch fails, the parent restarts, or maxTotal is reached.
async function hoardRamp(key, { mode, heapMb, step, maxTotal, padKb = 0 }) {
  const lab = `${key}-${tag}`;
  const steps = [];
  let total = 0, firstBoot = null, verdict = "reached cap without breaking";
  while (total < maxTotal) {
    const r = await op(lab, "hoard", { start: total, count: Math.min(step, maxTotal - total), mode, heapMb, padKb });
    const res = r.result || {};
    steps.push({ total, http: r.http, wallMs: r.wallMs, loaded: res.loaded, isolates: res.distinctIsolatesThisBatch, latency: res.latency, parentBoot: res.parent?.boot, failures: res.failures, error: r.error });
    if (firstBoot === null && res.parent) firstBoot = res.parent.boot;
    if (!r.ok) { verdict = `request failed at ${total} children: ${r.error}`; break; }
    total += res.loaded;
    if (res.parent && res.parent.boot !== firstBoot) { verdict = `parent restarted somewhere before ${total} children`; break; }
    if (res.failures?.length) { verdict = `child failures at ~${total}: ${res.failures[0].error}`; break; }
    log(key, total, "loaded", res.latency?.p50, "ms p50");
  }
  // Who is still warm?
  const census = [];
  for (let s = 0; s < total; s += 500) { const c = await op(lab, "census", { start: s, count: 500 }); census.push(c.result || { error: c.error }); if (!c.ok) break; }
  const warm = census.reduce((a, c) => a + (c.stillWarm || 0), 0);
  const restarted = census.reduce((a, c) => a + (c.restarted || 0), 0);
  out.rounds[key] = { mode, heapMb, padKb, step, maxTotal, loadedTotal: total, verdict, censusWarm: warm, censusRestarted: restarted, steps, census };
  save();
  log(key, "=>", verdict, "| warm", warm, "restarted", restarted);
  return lab;
}

// Local workerd doesn't enforce production memory limits, so local runs are scaled
// down (SCALE=0.1) and skip the memory bomb, which would just eat the host's RAM.
const SCALE = Number(process.env.SCALE || 1);
const LOCAL = target === "local";
const scaled = (n) => Math.max(1, Math.round(n * SCALE));
const labsToWipe = [];
const rounds = {
  async hoard() {
    labsToWipe.push(await hoardRamp("hoard-shared-0mb", { mode: "shared", heapMb: 0, step: 250, maxTotal: scaled(5000) }));
    labsToWipe.push(await hoardRamp("hoard-shared-1mb", { mode: "shared", heapMb: 1, step: 10, maxTotal: scaled(400) }));
    labsToWipe.push(await hoardRamp("hoard-unique-0mb", { mode: "unique", heapMb: 0, step: 20, maxTotal: scaled(400) }));
    labsToWipe.push(await hoardRamp("hoard-unique-8mb", { mode: "unique", heapMb: 8, step: 5, maxTotal: scaled(200) }));
  },
  async swarm() {
    const lab = `swarm-${tag}`; labsToWipe.push(lab);
    const max = Number(process.env.SWARM || 10000);
    const steps = []; let total = 0, verdict = "reached cap without breaking";
    while (total < max) {
      const r = await op(lab, "swarm", { start: total, count: 500, concurrency: 10 });
      const res = r.result || {};
      steps.push({ total, wallMs: r.wallMs, created: res.created, latency: res.latency, dbBytes: res.parent?.dbBytes, failures: res.failures, error: r.error });
      if (!r.ok) { verdict = `failed at ${total}: ${r.error}`; break; }
      total += res.created;
      if (res.failures?.length) { verdict = `child failures at ~${total}: ${res.failures[0].error}`; break; }
      if (total % 2000 === 0) log("swarm", total, "db", res.parent?.dbBytes);
    }
    out.rounds.swarm = { max, created: total, verdict, steps }; save();
    log("swarm =>", total, verdict);
  },
  async churn() {
    const lab = `churn-${tag}`; labsToWipe.push(lab);
    const shared = await op(lab, "churn", { rounds: 40, k: 5, mode: "shared" });
    const unique = await op(lab, "churn", { rounds: 10, k: 3, mode: "unique", tag });
    out.rounds.churn = { shared, unique }; save();
    log("churn shared", shared.result?.latency, "unique", unique.result?.latency);
  },
  async stampede() {
    const lab = `stampede-${tag}`; labsToWipe.push(lab);
    const r = {};
    for (const n of [50, 200, 500]) r[`shared-${n}`] = await op(lab, "stampede", { count: n, mode: "shared" });
    r["unique-40"] = await op(`${lab}-u`, "stampede", { count: 40, mode: "unique" });
    labsToWipe.push(`${lab}-u`);
    out.rounds.stampede = r; save();
    log("stampede", Object.entries(r).map(([k, v]) => `${k}: ok ${v.result?.ok}/${v.result?.count} wall ${v.result?.wallMs}`).join(" | "));
  },
  async hostile() {
    const lab = `hostile-${tag}`; labsToWipe.push(lab);
    const r = {};
    const kinds = [["throw"], ["loop"], ["recurse"], ["fetch"], ["hang"], ["bigreturn", LOCAL ? 20 : 100], ["storage", LOCAL ? 16 : 256]];
    if (!LOCAL) kinds.push(["alloc"]);
    for (const [kind, mb] of kinds) {
      r[kind] = await op(lab, "hostile", { kind, mb });
      const x = r[kind].result;
      log("hostile", kind, x ? `parentSurvived=${x.parentSurvived} canaryWarm=${x.canaryStillWarm} ${x.elapsedMs}ms ${JSON.stringify(x.outcome).slice(0, 140)}` : r[kind].error);
    }
    out.rounds.hostile = r; save();
  },
  async nest() {
    const lab = `nest-${tag}`; labsToWipe.push(lab);
    const r = {};
    for (const d of [1, 3, 10]) r[`depth-${d}`] = await op(lab, "nest", { depth: d });
    out.rounds.nest = r; save();
    log("nest", JSON.stringify(r).slice(0, 400));
  },
};

const selected = only ? only.split(",") : Object.keys(rounds);
log("run", run, "target", target, "rounds", selected.join(","));
for (const name of selected) {
  log("== round", name);
  try { await rounds[name](); } catch (e) { out.rounds[name] = { crashed: String(e) }; save(); log(name, "crashed", e); }
}
if (process.env.KEEP !== "1") {
  out.wiped = {};
  for (const lab of labsToWipe) { const w = await op(lab, "wipe"); out.wiped[lab] = w.ok ? w.result : w.error; }
}
const ledger = await fetch(`${base}/ledger`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
out.ledger = ledger; save();
log("done ->", file, "ledger", JSON.stringify(ledger));
