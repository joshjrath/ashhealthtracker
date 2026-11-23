/* ──────────────────────────────────────────────────────────────────────────
   Storage. Postgres when DATABASE_URL is set (Railway), otherwise one JSON
   file on disk — enough to run and test locally without a database.

   Both keep the same shape:
     days  key "YYYY-MM-DD" → { manual: {...}, apple: {...}, legacy: {...} }
           (see js/sources.js — each source writes only its own bucket)
     meta  "goals", "lastSync", "prefs", "tokens", "auth", "sessionSecret", "foodApis",
           "trainingPlan", "achievementTiers", "achievementLedger", …
     items kind + id → data: saved foods ("food"), custom meals ("meal"),
           rewards ("reward"), cached food lookups ("lookup") and AI
           estimates ("estimate")
     snapshots  backups of all of the above, gzipped (see backup.mjs)

   dump() and restore() read and write everything at once, for backups.
   ────────────────────────────────────────────────────────────────────────── */
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

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
    create table if not exists items (
      kind text not null,
      id text not null,
      data jsonb not null,
      updated_at timestamptz not null default now(),
      primary key (kind, id)
    );
    create table if not exists snapshots (
      id text primary key,
      created_at timestamptz not null,
      info jsonb not null,
      data bytea not null
    );
    create table if not exists photos (
      id text primary key,
      created_at timestamptz not null default now(),
      info jsonb not null,
      data bytea not null
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
    async getDay(key) {
      const r = await pool.query("select data from days where key = $1", [key]);
      return r.rows[0]?.data ?? null;
    },
    async listItems(kind) {
      const r = await pool.query("select data from items where kind = $1 order by updated_at desc", [kind]);
      return r.rows.map((x) => x.data);
    },
    async getItem(kind, id) {
      const r = await pool.query("select data from items where kind = $1 and id = $2", [kind, id]);
      return r.rows[0]?.data ?? null;
    },
    async putItem(kind, id, data) {
      await pool.query(
        `insert into items (kind, id, data) values ($1, $2, $3::jsonb)
         on conflict (kind, id) do update set data = excluded.data, updated_at = now()`,
        [kind, id, JSON.stringify(data)],
      );
    },
    async deleteItem(kind, id) {
      await pool.query("delete from items where kind = $1 and id = $2", [kind, id]);
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

    /* everything at once, for backups */
    async dump() {
      const [d, m, i] = await Promise.all([
        pool.query("select key, data from days"),
        pool.query("select k, v from meta"),
        pool.query("select kind, data from items"),
      ]);
      const items = {};
      for (const r of i.rows) (items[r.kind] ||= []).push(r.data);
      return {
        days: Object.fromEntries(d.rows.map((r) => [r.key, r.data])),
        meta: Object.fromEntries(m.rows.map((r) => [r.k, r.v])),
        items,
      };
    },
    /** Put back days, the given meta keys and item kinds — all or nothing. */
    async restore({ days, meta, items }, { metaKeys, itemKinds }) {
      await tx(async (c) => {
        await c.query("delete from days");
        for (const [key, data] of Object.entries(days || {})) {
          await c.query("insert into days (key, data) values ($1, $2::jsonb)", [key, JSON.stringify(data)]);
        }
        await c.query("delete from items where kind = any($1)", [itemKinds]);
        for (const kind of itemKinds) {
          for (const data of items?.[kind] || []) {
            await c.query("insert into items (kind, id, data) values ($1, $2, $3::jsonb)", [kind, data.id, JSON.stringify(data)]);
          }
        }
        for (const k of metaKeys) {
          if (meta?.[k] === undefined || meta[k] === null) await c.query("delete from meta where k = $1", [k]);
          else await c.query("insert into meta (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v", [k, JSON.stringify(meta[k])]);
        }
      });
    },
    async putSnapshot({ data, ...info }) {
      await pool.query("insert into snapshots (id, created_at, info, data) values ($1, $2, $3::jsonb, $4)",
        [info.id, info.createdAt, JSON.stringify(info), data]);
    },
    async listSnapshots() {
      const r = await pool.query("select info from snapshots order by created_at desc");
      return r.rows.map((x) => x.info);
    },
    async getSnapshot(id) {
      const r = await pool.query("select info, data from snapshots where id = $1", [id]);
      return r.rows[0] ? { ...r.rows[0].info, data: r.rows[0].data } : null;
    },
    async deleteSnapshot(id) {
      await pool.query("delete from snapshots where id = $1", [id]);
    },
    async deleteSnapshots(ids) {
      await pool.query("delete from snapshots where id = any($1)", [ids]);
    },
    // Progress photos: kept apart from your log, so they never ride along in snapshots or exports.
    async putPhoto(info, data) {
      await pool.query("insert into photos (id, info, data) values ($1, $2::jsonb, $3)", [info.id, JSON.stringify(info), data]);
    },
    async listPhotos() {
      const r = await pool.query("select info from photos order by created_at");
      return r.rows.map((x) => x.info);
    },
    async getPhoto(id) {
      const r = await pool.query("select info, data from photos where id = $1", [id]);
      return r.rows[0] ? { info: r.rows[0].info, data: r.rows[0].data } : null;
    },
    async deletePhoto(id) {
      await pool.query("delete from photos where id = $1", [id]);
    },
    close: () => pool.end(),
  };
}

/* ── JSON file ─────────────────────────────────────────────────────────── */

async function openFile(file) {
  const snapDir = `${file}.backups`;
  const photoDir = `${file}.photos`;
  let doc = { days: {}, meta: {}, items: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    doc = { days: parsed.days || {}, meta: parsed.meta || {}, items: parsed.items || {} };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // Writes queue behind each other so two saves can't interleave; one
  // failed write doesn't stop the ones after it.
  let chain = Promise.resolve();
  const flush = () => {
    chain = chain.catch(() => {}).then(async () => {
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
    async getDay(key) { return doc.days[key] ? structuredClone(doc.days[key]) : null; },
    async listItems(kind) {
      return Object.values(doc.items[kind] || {}).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).map((x) => structuredClone(x));
    },
    async getItem(kind, id) { return doc.items[kind]?.[id] ? structuredClone(doc.items[kind][id]) : null; },
    async putItem(kind, id, data) { (doc.items[kind] ||= {})[id] = data; await flush(); },
    async deleteItem(kind, id) { if (doc.items[kind]) delete doc.items[kind][id]; await flush(); },
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

    /* everything at once, for backups */
    async dump() {
      const items = {};
      for (const [kind, byId] of Object.entries(doc.items)) items[kind] = Object.values(byId);
      return structuredClone({ days: doc.days, meta: doc.meta, items });
    },
    async restore({ days, meta, items }, { metaKeys, itemKinds }) {
      const next = structuredClone({ days: days || {}, meta: meta || {}, items: items || {} });
      doc.days = next.days;
      for (const kind of itemKinds) doc.items[kind] = Object.fromEntries((next.items[kind] || []).map((x) => [x.id, x]));
      for (const k of metaKeys) {
        if (next.meta[k] === undefined || next.meta[k] === null) delete doc.meta[k];
        else doc.meta[k] = next.meta[k];
      }
      await flush();
    },
    // Snapshots sit beside the data file: an index plus one gzip file each.
    async putSnapshot({ data, ...info }) {
      await mkdir(snapDir, { recursive: true });
      await writeFile(join(snapDir, `${info.id}.json.gz`), data);
      const index = await readIndex();
      index.unshift(info);
      await writeIndex(index);
    },
    async listSnapshots() {
      return (await readIndex()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getSnapshot(id) {
      const info = (await readIndex()).find((x) => x.id === id);
      if (!info) return null;
      return { ...info, data: await readFile(join(snapDir, `${id}.json.gz`)) };
    },
    async deleteSnapshot(id) { await this.deleteSnapshots([id]); },
    async deleteSnapshots(ids) {
      const drop = new Set(ids);
      await writeIndex((await readIndex()).filter((x) => !drop.has(x.id)));
      for (const id of ids) await rm(join(snapDir, `${id}.json.gz`), { force: true });
    },
    // Photos sit beside the data file too: an index plus one .jpg each.
    async putPhoto(info, data) {
      await mkdir(photoDir, { recursive: true });
      await writeFile(join(photoDir, `${info.id}.jpg`), data);
      await writePhotoIndex([...(await readPhotoIndex()), info]);
    },
    async listPhotos() { return readPhotoIndex(); },
    async getPhoto(id) {
      const info = (await readPhotoIndex()).find((x) => x.id === id);
      if (!info) return null;
      return { info, data: await readFile(join(photoDir, `${id}.jpg`)) };
    },
    async deletePhoto(id) {
      await writePhotoIndex((await readPhotoIndex()).filter((x) => x.id !== id));
      await rm(join(photoDir, `${id}.jpg`), { force: true });
    },
    close: async () => { await chain; },
  };

  async function readIndex() {
    try {
      return JSON.parse(await readFile(join(snapDir, "index.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async function readPhotoIndex() {
    try {
      return JSON.parse(await readFile(join(photoDir, "index.json"), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async function writePhotoIndex(index) {
    await mkdir(photoDir, { recursive: true });
    const tmp = join(photoDir, "index.json.tmp");
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, join(photoDir, "index.json"));
  }
  async function writeIndex(index) {
    const tmp = join(snapDir, "index.json.tmp");
    await writeFile(tmp, JSON.stringify(index));
    await rename(tmp, join(snapDir, "index.json"));
  }
}
