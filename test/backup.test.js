// Data safety: an update never loses data, backups happen on their own,
// and any rollback can be undone. Set TEST_DATABASE_URL to run on Postgres.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { createBackups, DATA_META } from "../server/backup.mjs";
import { pickStorage } from "../server/storage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PG = process.env.TEST_DATABASE_URL;
let dir;
const running = new Set(); // sites still open if a test fails midway

before(async () => { dir = await mkdtemp(join(tmpdir(), "ash-backup-")); });
after(async () => {
  for (const stop of running) await stop().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const open = (name) => openStore({ databaseUrl: PG, file: join(dir, `${name}.json`) });

/** Start the site the way a deploy does: open the storage, create the app, listen. */
async function boot(name, { fresh = false, ...opts } = {}) {
  const store = await open(name);
  if (fresh) await wipe(store); // before the app reads anything, as a shared test database may hold another file's data
  const server = await createApp({ store, root, password: "", secret: "s".repeat(32), requireAuth: false, backupSchedule: false, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const stop = async () => { running.delete(stop); await new Promise((r) => server.close(r)); await store.close(); };
  running.add(stop);
  return { store, server, call, stop };
}

async function wipe(store) {
  const keys = [...DATA_META, "auth", "tokens", "foodApis", "backupSettings", "backupState"].filter((k) => k !== "schema");
  await store.restore({ days: {}, meta: {}, items: {} }, { metaKeys: keys, itemKinds: ["food", "meal", "reward"] });
  for (const s of await store.listSnapshots()) await store.deleteSnapshot(s.id);
}

/** Everything that counts as your data, comparable across restarts. */
async function data(store) {
  const d = await store.dump();
  const meta = Object.fromEntries(Object.entries(d.meta).filter(([k]) => !["backupState", "sessionSecret"].includes(k)));
  const items = Object.fromEntries(["food", "meal", "reward"].map((k) => [k, (d.items[k] || []).sort((a, b) => a.id.localeCompare(b.id))]));
  return { days: d.days, meta, items };
}

async function fill(call) {
  await call("PUT", "/api/days/2026-10-01", { creatine: true, bed: "23:00", wake: "07:00", weight: 165.2 });
  await call("PATCH", "/api/days/2026-10-01", {
    foods: [{ id: "f1", meal: "breakfast", name: "Oats", kcal: 150, protein: 5, foodId: "food_oats" }],
    lifts: [{ exercise: "Bench press", sets: [{ reps: 8, weight: 135 }] }], foodDone: true,
  });
  await call("PUT", "/api/items/food/food_oats", { name: "Oats", nutrients: { kcal: 150, protein: 5 }, source: { kind: "database" } });
  await call("PUT", "/api/items/meal/meal_1", { name: "Breakfast", items: [{ name: "Oats", kcal: 150 }] });
  await call("PUT", "/api/items/reward/rew_1", { name: "New shoes", achievementId: "weight-2" });
  await call("PUT", "/api/goals", { kcalTarget: 2100, protein: 160 });
  await call("PUT", "/api/plan", { days: { mon: "strength", wed: "cardio" } });
  await call("PUT", "/api/achievement-tiers", { iron: [20000, 50000, 100000, 250000, 500000] });
  await call("POST", "/api/achievements/ledger", { init: ["weight-1"] });
  await call("PUT", "/api/prefs", { weightRange: "30" });
  const t = await call("POST", "/api/tokens", { name: "iPhone" });
  return t.body.token;
}

test("an update — the server restarting on the same storage — keeps every day, food, meal, reward and setting", async () => {
  let site = await boot("restart", { fresh: true });
  const token = await fill(site.call);
  const res = await site.call("GET", "/api/state");
  assert.equal(Object.keys(res.body.days).length, 1);
  const before = await data(site.store);
  await site.stop();

  // Three "deploys" in a row.
  for (let i = 0; i < 3; i++) {
    site = await boot("restart");
    assert.deepEqual(await data(site.store), before, `restart ${i + 1} changed nothing`);
    await site.stop();
  }
  site = await boot("restart");
  const s = (await site.call("GET", "/api/state")).body;
  assert.equal(s.days["2026-10-01"].manual.foods[0].name, "Oats");
  assert.equal(s.days["2026-10-01"].manual.lifts[0].exercise, "Bench press");
  assert.equal(s.goals.kcalTarget, 2100);
  assert.equal(s.plan.days.mon, "strength");
  assert.deepEqual(s.library.rewards.map((r) => r.name), ["New shoes"]);
  const settings = (await site.call("GET", "/api/settings")).body;
  assert.equal(settings.tokens.length, 1, "upload tokens survive too");
  assert.ok(token);
  await site.stop();
});

test("before an update starts, the data is backed up — once, not again when nothing changed", async () => {
  let site = await boot("boot", { fresh: true, version: "aaaaaaa1" });
  await fill(site.call);
  await site.stop();
  site = await boot("boot", { version: "bbbbbbb2" });
  let list = await site.store.listSnapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "boot");
  assert.match(list[0].reason, /Before update bbbbbbb/);
  assert.equal(list[0].summary.days, 1);
  assert.equal(list[0].summary.entries, 1);
  await site.stop();
  site = await boot("boot", { version: "ccccccc3" });
  list = await site.store.listSnapshots();
  assert.equal(list.length, 1, "unchanged data isn't stored twice");
  await site.stop();
});

test("scheduled backups: every 3 hours by default, only when something changed", async () => {
  const store = await open("sched");
  await wipe(store);
  let t = Date.parse("2026-10-08T00:00:00Z");
  const b = createBackups({ store, now: () => t });
  assert.equal((await b.tick())?.skipped, "empty", "an empty log isn't backed up");
  await store.putDay("2026-10-08", { manual: { kcal: 2000, foodDone: true }, apple: {} });
  assert.ok((await b.tick()).snapshot, "first backup");
  t += 1 * 3600_000;
  assert.equal(await b.tick(), null, "not due after an hour");
  await store.putDay("2026-10-08", { manual: { kcal: 2200, foodDone: true }, apple: {} });
  t += 2 * 3600_000;
  assert.ok((await b.tick()).snapshot, "due at 3 hours, and the data changed");
  t += 3 * 3600_000;
  assert.equal((await b.tick()).skipped, "unchanged");
  assert.equal((await store.listSnapshots()).length, 2);
  await b.setEvery(0);
  t += 24 * 3600_000;
  assert.equal(await b.tick(), null, "off means off");
  await assert.rejects(b.setEvery(5), /listed schedules/);
  await store.close();
});

test("rolling back restores days, library and settings — and can itself be undone", async () => {
  const site = await boot("restore", { fresh: true });
  await fill(site.call);
  const v1 = await data(site.store);
  const made = await site.call("POST", "/api/backups", {});
  const first = made.body?.snapshot;
  assert.ok(first, JSON.stringify(made).slice(0, 300));
  // Later: more logging, a goal change, a deleted reward.
  await site.call("PUT", "/api/days/2026-10-02", { weight: 164.8 });
  await site.call("PUT", "/api/goals", { kcalTarget: 1800 });
  await site.call("DELETE", "/api/items/reward/rew_1");
  const v2 = await data(site.store);

  const r = await site.call("POST", `/api/backups/${first.id}/restore`, {});
  assert.equal(r.status, 200);
  assert.deepEqual((await data(site.store)).days, v1.days);
  assert.deepEqual((await data(site.store)).items, v1.items);
  assert.equal((await site.call("GET", "/api/state")).body.goals.kcalTarget, 2100);
  assert.ok(r.body.undo, "the state before the rollback was backed up");
  const undo = await site.call("POST", `/api/backups/${r.body.undo.id}/restore`, {});
  assert.equal(undo.status, 200);
  assert.deepEqual((await data(site.store)).days, v2.days);
  assert.equal((await site.call("GET", "/api/state")).body.goals.kcalTarget, 1800);
  assert.equal((await site.call("POST", "/api/backups/bk_nope/restore", {})).status, 404);
  await site.stop();
});

test("backups hold your data, not your password, tokens or keys — and a rollback leaves those alone", async () => {
  const site = await boot("secrets", { fresh: true });
  await fill(site.call);
  await site.call("PUT", "/api/food-apis", { usdaKey: "secret-usda-key-123" });
  const snap = (await site.call("POST", "/api/backups", {})).body.snapshot;
  const { payload } = await site.server.backups.load(snap.id);
  const text = JSON.stringify(payload);
  for (const k of ["auth", "tokens", "foodApis", "sessionSecret"]) assert.equal(payload.meta[k], undefined, k);
  assert.ok(!text.includes("secret-usda-key-123"));
  await site.call("POST", "/api/tokens", { name: "Second phone" });
  await site.call("POST", `/api/backups/${snap.id}/restore`, {});
  const st = (await site.call("GET", "/api/settings")).body;
  assert.equal(st.tokens.length, 2, "a token made after the backup isn't revoked by rolling back");
  assert.equal(st.food.usda.source, "settings");
  await site.stop();
});

test("erasing, importing and sorting older entries are each backed up first", async () => {
  const site = await boot("safety", { fresh: true });
  await fill(site.call);
  await site.call("DELETE", "/api/days");
  let list = await site.store.listSnapshots();
  assert.equal(list[0].kind, "safety");
  assert.match(list[0].reason, /erasing/);
  assert.equal(list[0].summary.days, 1, "the erased days are in it");
  const rec = (await site.call("GET", "/api/state")).body.backup;
  assert.equal(rec.recovery, null, "library items still there, so the log isn't empty");
  await site.store.restore({ days: {}, meta: {}, items: {} }, { metaKeys: [], itemKinds: ["food", "meal", "reward"] });
  const empty = (await site.call("GET", "/api/state")).body.backup;
  assert.equal(empty.recovery.id, list[0].id, "an empty log offers the backup back");
  assert.equal(empty.recovery.summary.days, 1);
  await site.call("PUT", "/api/days/2026-09-30", { weight: 170 });
  await site.call("POST", "/api/import", { days: { "2026-09-01": { manual: { kcal: 1 }, apple: {} } } });
  list = await site.store.listSnapshots();
  assert.ok(list.some((s) => /importing/.test(s.reason)));
  await site.stop();
});

test("a downloaded backup is an export file that Import reads back", async () => {
  const site = await boot("download", { fresh: true });
  await fill(site.call);
  const snap = (await site.call("POST", "/api/backups", {})).body.snapshot;
  const dl = await site.call("GET", `/api/backups/${snap.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.format, "ash-health/backup-1");
  const before = await data(site.store);
  await site.call("DELETE", "/api/days");
  const imp = await site.call("POST", "/api/import", dl.body);
  assert.equal(imp.status, 200);
  const after = await data(site.store);
  assert.deepEqual(Object.keys(after.days), Object.keys(before.days));
  assert.deepEqual(after.days["2026-10-01"].manual.foods.map((e) => e.name), ["Oats"]);
  assert.deepEqual(after.meta.achievementTiers, before.meta.achievementTiers);
  assert.equal(after.meta.prefs.weightRange, "30");
  await site.stop();
});

test("retention: everything from 2 days, one a day for a month, one a week for six months", async () => {
  const store = await open("retention");
  await wipe(store);
  const t0 = Date.parse("2026-10-08T12:00:00Z");
  let i = 0;
  const add = async (hoursAgo, kind = "auto") => {
    i += 1;
    await store.putSnapshot({ id: `bk_t${String(i).padStart(4, "0")}`, createdAt: new Date(t0 - hoursAgo * 3600_000).toISOString(), reason: "x", kind, hash: `h${i}`, bytes: 1, summary: { days: 1 }, data: Buffer.from("x") });
  };
  for (let h = 0; h < 24 * 400; h += 6) await add(h); // every 6 hours for 400 days
  await add(24 * 300, "manual");
  const b = createBackups({ store, now: () => t0 });
  await b.prune();
  const left = await store.listSnapshots();
  const ages = left.map((s) => (t0 - Date.parse(s.createdAt)) / 3600_000);
  assert.equal(ages.filter((a) => a < 48).length, 8, "all 8 from the last two days");
  const days = new Set(left.filter((s) => (t0 - Date.parse(s.createdAt)) / 3600_000 >= 48 && (t0 - Date.parse(s.createdAt)) / 3600_000 < 24 * 30).map((s) => s.createdAt.slice(0, 10)));
  assert.equal(days.size, left.filter((s) => { const a = (t0 - Date.parse(s.createdAt)) / 3600_000; return a >= 48 && a < 24 * 30; }).length, "one per day");
  assert.ok(!ages.some((a) => a >= 24 * 182 && a !== 24 * 300), "nothing older than six months except what you kept yourself");
  assert.ok(left.some((s) => s.kind === "manual"));
  assert.ok(left.length < 90, `${left.length} kept`);
  await store.close();
});

test("storage: Railway without a database or volume is reported as temporary", () => {
  const railway = { RAILWAY_PROJECT_ID: "p" };
  assert.equal(pickStorage({}, "/app").persistent, true, "your own computer");
  assert.equal(pickStorage(railway, "/app").persistent, false);
  assert.match(pickStorage(railway, "/app").where, /temporary/);
  const pg = pickStorage({ ...railway, DATABASE_URL: "postgres://x" }, "/app");
  assert.equal(pg.kind, "postgres");
  assert.equal(pg.persistent, true);
  const vol = pickStorage({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: "/data" }, "/app");
  assert.equal(vol.file, "/data/ash-health.json");
  assert.equal(vol.persistent, true);
  assert.equal(pickStorage({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: "/data", DATA_FILE: "/app/x.json" }, "/app").persistent, false, "a file outside the volume is still temporary");
  assert.equal(pickStorage({ ...railway, DATABASE_PRIVATE_URL: "postgres://y" }, "/app").kind, "postgres");
});

test("the page is told when storage is temporary", async () => {
  const site = await boot("temp", { storage: { persistent: false, where: "Railway's temporary disk — erased on every update" } });
  const s = (await site.call("GET", "/api/state")).body;
  assert.equal(s.backup.persistent, false);
  const st = (await site.call("GET", "/api/settings")).body;
  assert.match(st.storageWhere, /temporary/);
  assert.equal(st.backups.persistent, false);
  await site.stop();
});
