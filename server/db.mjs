/* ──────────────────────────────────────────────────────────────────────────
   Storage. Postgres when DATABASE_URL is set (Railway), otherwise one JSON
   file on disk — enough to run and test locally without a database.

   Both keep the same shape:
     days  key "YYYY-MM-DD" → { manual: {...}, apple: {...}, legacy: {...} }
           (see js/sources.js — each source writes only its own bucket)
     meta  "goals", "lastSync", "prefs", "tokens", "auth", "sessionSecret"
   ────────────────────────────────────────────────────────────────────────── */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function openStore({ databaseUrl, file }) {
  return databaseUrl ? openPg(databaseUrl) : openFile(file);
}

/* ── Postgres ──────────────────────────────────────────────────────────── */

async function openPg(url) {
  const { default: pg } = await import("pg");
  // Railway's private network (and localhost) speak plain TCP; a public
  // database URL gets TLS. PGSSLMODE=disable forces it off.
  const plain = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /\.railway\.internal[:/]/.test(url)
    || process.env.PGSSLMODE === "disable";
  const pool = new pg.Pool({ connectionString: url, max: 5, ssl: plain ? false : { rejectUnauthorized: false } });
  await pool.query(`
    create table if not exists days (
      key text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists meta (
      k text primary key,
      v jsonb not null
    );
  `);

  const tx = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  };

  return {
    kind: "postgres",
    async getAll() {
      const [d, m] = await Promise.all([
        pool.query("select key, data from days"),
        pool.query("select k, v from meta"),
      ]);
      const days = Object.fromEntries(d.rows.map((r) => [r.key, r.data]));
      const meta = Object.fromEntries(m.rows.map((r) => [r.k, r.v]));
      return { days, goals: meta.goals ?? null, lastSync: meta.lastSync ?? null };
    },
    async putDay(key, data) {
      await pool.query(
        `insert into days (key, data) values ($1, $2::jsonb)
         on conflict (key) do update set data = excluded.data, updated_at = now()`,
        [key, JSON.stringify(data)],
      );
    },
    async deleteDay(key) {
      await pool.query("delete from days where key = $1", [key]);
    },
    /** Apple's fields merge into the day's "apple" bucket; manual and legacy are untouched. */
    async mergeApple(days) {
      await tx(async (c) => {
        for (const [key, apple] of Object.entries(days)) {
          await c.query(
            `insert into days (key, data) values ($1, jsonb_build_object('manual', '{}'::jsonb, 'apple', $2::jsonb))
             on conflict (key) do update set
               data = jsonb_set(days.data, '{apple}', coalesce(days.data->'apple', '{}'::jsonb) || $2::jsonb, true),
               updated_at = now()`,
            [key, JSON.stringify(apple)],
          );
        }
      });
    },
    /** Replaces the day's "manual" bucket only; Apple's data for that day stays. */
    async putManual(key, manual) {
      await pool.query(
        `insert into days (key, data) values ($1, jsonb_build_object('manual', $2::jsonb, 'apple', '{}'::jsonb))
         on conflict (key) do update set data = jsonb_set(days.data, '{manual}', $2::jsonb, true), updated_at = now()`,
        [key, JSON.stringify(manual)],
      );
    },
    async replaceDays(days) {
      await tx(async (c) => {
        await c.query("delete from days");
        for (const [key, data] of Object.entries(days)) {
          await c.query("insert into days (key, data) values ($1, $2::jsonb)", [key, JSON.stringify(data)]);
        }
      });
    },
    async getMeta(k) {
      const r = await pool.query("select v from meta where k = $1", [k]);
      return r.rows[0]?.v ?? null;
    },
    async setMeta(k, v) {
      await pool.query(
        "insert into meta (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v",
        [k, JSON.stringify(v)],
      );
    },
    async ping() {
      await pool.query("select 1");
    },
    close: () => pool.end(),
  };
}

/* ── JSON file ─────────────────────────────────────────────────────────── */

async function openFile(file) {
  let doc = { days: {}, meta: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    doc = { days: parsed.days || {}, meta: parsed.meta || {} };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // Writes queue behind each other so two saves can't interleave.
  let chain = Promise.resolve();
  const flush = () => {
    chain = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(doc));
      await rename(tmp, file);
    });
    return chain;
  };

  return {
    kind: "file",
    async getAll() {
      return { days: structuredClone(doc.days), goals: doc.meta.goals ?? null, lastSync: doc.meta.lastSync ?? null };
    },
    async putDay(key, data) { doc.days[key] = data; await flush(); },
    async deleteDay(key) { delete doc.days[key]; await flush(); },
    async mergeApple(days) {
      for (const [key, apple] of Object.entries(days)) {
        const d = doc.days[key] || { manual: {}, apple: {} };
        doc.days[key] = { ...d, apple: { ...(d.apple || {}), ...apple } };
      }
      await flush();
    },
    async putManual(key, manual) {
      doc.days[key] = { ...(doc.days[key] || { apple: {} }), manual };
      await flush();
    },
    async replaceDays(days) { doc.days = { ...days }; await flush(); },
    async getMeta(k) { return doc.meta[k] === undefined ? null : structuredClone(doc.meta[k]); },
    async setMeta(k, v) { doc.meta[k] = v; await flush(); },
    async ping() {},
    close: async () => { await chain; },
  };
}
