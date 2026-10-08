// Source for the dynamically-loaded child. Generated, never written by a model,
// so the experiment costs nothing in AI calls.
export function childModule({ padKb = 0 } = {}) {
  const pad = padKb > 0 ? "x".repeat(padKb * 1024) : "";
  return `import { DurableObject } from "cloudflare:workers";
const PAD = ${JSON.stringify(pad)};
let ISOLATE = null; // set on first use: random values aren't allowed at module load
const isolateId = () => (ISOLATE ??= crypto.randomUUID());
const MB = 1048576;

export class Child extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.boot = crypto.randomUUID();
    this.hold = null;
    this.calls = 0;
  }

  info() {
    return { boot: this.boot, isolate: isolateId(), calls: this.calls, heldMb: this.hold ? this.hold.length / MB : 0, padKb: PAD.length / 1024 };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = (k, d) => url.searchParams.get(k) ?? d;
    this.calls++;

    if (url.pathname === "/ping") return Response.json(this.info());

    if (url.pathname === "/hold") {
      const mb = Number(q("mb", "0"));
      if (mb > 0 && !this.hold) { this.hold = new Uint8Array(mb * MB); this.hold.fill(1); }
      return Response.json(this.info());
    }

    if (url.pathname === "/write") {
      const bytes = Number(q("bytes", "64"));
      const rows = Number(q("rows", "1"));
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
      const v = "y".repeat(bytes);
      for (let i = 0; i < rows; i++) sql.exec("INSERT INTO t (v) VALUES (?)", v);
      return Response.json({ ...this.info(), size: this.ctx.storage.sql.databaseSize });
    }

    if (url.pathname === "/nest") {
      const depth = Number(q("depth", "0"));
      if (depth <= 0) return Response.json({ depth: 0, ...this.info() });
      if (!this.ctx.facets) return Response.json({ error: "ctx.facets is undefined inside a facet" });
      const cls = this.ctx.exports && this.ctx.exports.Child;
      if (!cls) return Response.json({ error: "ctx.exports.Child is undefined inside a facet", exportsKeys: this.ctx.exports ? Object.keys(this.ctx.exports) : null });
      const sub = this.ctx.facets.get("n", () => ({ class: cls }));
      const res = await sub.fetch("https://child/nest?depth=" + (depth - 1));
      const inner = await res.json();
      return Response.json({ depth: (inner.depth ?? -1) + (inner.error ? 0 : 1), inner });
    }

    if (url.pathname === "/hostile") {
      const kind = q("kind", "");
      if (kind === "loop") { while (true) {} }
      if (kind === "alloc") { const keep = []; while (true) { const a = new Uint8Array(16 * MB); a.fill(1); keep.push(a); } }
      if (kind === "recurse") { const f = (n) => f(n + 1) + 1; f(0); }
      if (kind === "throw") throw new Error("boom from child");
      if (kind === "fetch") { const r = await fetch("https://example.com/"); return new Response("fetched " + r.status); }
      if (kind === "hang") { await new Promise(() => {}); }
      if (kind === "bigreturn") return new Response("z".repeat(Number(q("mb", "100")) * MB));
      if (kind === "storage") {
        const mb = Number(q("mb", "256"));
        const sql = this.ctx.storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS s (k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
        const v = "s".repeat(MB);
        for (let i = 0; i < mb; i++) sql.exec("INSERT INTO s (v) VALUES (?)", v);
        return Response.json({ wroteMb: mb, size: sql.databaseSize });
      }
      return new Response("unknown kind " + kind, { status: 400 });
    }

    return new Response("not found", { status: 404 });
  }
}

export default { fetch() { return new Response("child"); } };
`;
}
