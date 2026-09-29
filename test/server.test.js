import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, store, server, base;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ash-"));
  // TEST_DATABASE_URL runs the same checks against a real Postgres.
  store = await openStore({ databaseUrl: process.env.TEST_DATABASE_URL, file: join(dir, "db.json") });
  await store.replaceDays({});
  server = await createApp({ store, root, password: "hunter2", secret: "s".repeat(32), ingestToken: "tok123", requireAuth: true });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

async function login() {
  const res = await fetch(`${base}/login`, { method: "POST", body: "password=hunter2", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 303);
  return res.headers.get("set-cookie").split(";")[0];
}

test("everything but login and health checks needs a session", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const page = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const bad = await fetch(`${base}/login`, { method: "POST", body: "password=nope",
    headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(bad.status, 401);
});

test("server files are never served, even signed in", async () => {
  const c = await login();
  for (const p of ["/server/auth.mjs", "/package.json", "/server.mjs", "/data/local.json", "/js/../server/app.mjs", "/%2e%2e/etc/passwd"]) {
    assert.equal((await fetch(`${base}${p}`, { headers: { cookie: c } })).status, 404, p);
  }
  assert.equal((await fetch(`${base}/js/app.js`, { headers: { cookie: c } })).status, 200);
});

test("ingest needs the token and merges without erasing hand-logged fields", async () => {
  const c = await login();
  const put = await fetch(`${base}/api/days/2026-09-27`, { method: "PUT", headers: { cookie: c, "content-type": "application/json" },
    body: JSON.stringify({ creatine: true, protein: 150 }) });
  assert.equal(put.status, 200);

  const payload = JSON.stringify({ date: "2026-09-27", steps: 11240, protein: 158 });
  assert.equal((await fetch(`${base}/api/ingest`, { method: "POST", body: payload })).status, 401);
  assert.equal((await fetch(`${base}/api/ingest`, { method: "POST", body: payload, headers: { authorization: "Bearer wrong" } })).status, 401);
  const ok = await fetch(`${base}/api/ingest`, { method: "POST", body: payload, headers: { authorization: "Bearer tok123" } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).days, 1);

  const s = await (await fetch(`${base}/api/state`, { headers: { cookie: c } })).json();
  // Apple's protein is refused at the door; your 150g stands, steps land in Apple's bucket.
  assert.deepEqual(s.days["2026-09-27"], { manual: { creatine: true, protein: 150 }, apple: { steps: 11240 } });
  assert.equal(s.lastSync.days, 1);
  assert.deepEqual(s.lastSync.ignored, ["protein"]);

  // Saving the day by hand replaces only what you logged; Apple's steps stay.
  await fetch(`${base}/api/days/2026-09-27`, { method: "PUT", headers: { cookie: c, "content-type": "application/json" },
    body: JSON.stringify({ protein: 160, foodDone: true, steps: 99999999999, kcal: -4 }) });
  await fetch(`${base}/api/days/2026-09-27`, { method: "DELETE", headers: { cookie: c } });
  const after = await (await fetch(`${base}/api/state`, { headers: { cookie: c } })).json();
  assert.deepEqual(after.days["2026-09-27"], { manual: {}, apple: { steps: 11240 } }, "clearing your entries keeps Apple's");

  const seen = await (await fetch(`${base}/api/settings`, { headers: { cookie: c } })).json();
  assert.equal(seen.fieldsSeen.metrics.protein.accepted, false);
  assert.equal(seen.fieldsSeen.metrics.steps.accepted, true);
  assert.equal(s.goals.goalWeight, 145);

  const junk = await fetch(`${base}/api/ingest`, { method: "POST", body: "{nope", headers: { authorization: "Bearer tok123" } });
  assert.equal(junk.status, 400);
});

test("writes need JSON, goals are cleaned, import replaces", async () => {
  const c = await login();
  const form = await fetch(`${base}/api/goals`, { method: "PUT", headers: { cookie: c, "content-type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415);
  const g = await (await fetch(`${base}/api/goals`, { method: "PUT", headers: { cookie: c, "content-type": "application/json" },
    body: JSON.stringify({ protein: 170, kcalLow: 2100, kcalHigh: 1900, tracked: ["protein", "evil"] }) })).json();
  assert.equal(g.goals.protein, 170);
  assert.deepEqual([g.goals.kcalLow, g.goals.kcalHigh], [1900, 2100]);
  assert.deepEqual(g.goals.tracked, ["protein"]);

  const imp = await fetch(`${base}/api/import`, { method: "POST", headers: { cookie: c, "content-type": "application/json" },
    body: JSON.stringify({ days: { "2026-01-01": { weight: 170 }, bogus: { weight: 1 } } }) });
  assert.equal((await imp.json()).days, 1);
  const s = await (await fetch(`${base}/api/state`, { headers: { cookie: c } })).json();
  assert.deepEqual(Object.keys(s.days), ["2026-01-01"]);
});

test("old flat days migrate once; food/sleep wait for review; review keeps or sets aside", async () => {
  const legacyStore = await openStore({ file: join(dir, "legacy.json") });
  await legacyStore.replaceDays({
    "2026-09-01": { kcal: 1900, protein: 150, creatine: true, steps: 9000 },
    "2026-09-02": { kcal: 3400, protein: 40, bed: "23:00", wake: "03:05", sleepMins: 245, steps: 7000 },
  });
  await legacyStore.setMeta("goals", { ...{ tracked: ["calories", "protein", "workout"] } });
  const s3 = await createApp({ store: legacyStore, root, password: "pw123456", secret: "k", ingestToken: "t", requireAuth: true });
  await new Promise((r) => s3.listen(0, r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const res = await fetch(`${b3}/login`, { method: "POST", body: "password=pw123456", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" } });
  const c = res.headers.get("set-cookie").split(";")[0];
  const st = await (await fetch(`${b3}/api/state`, { headers: { cookie: c } })).json();
  assert.deepEqual(st.days["2026-09-01"].manual, { creatine: true });
  assert.equal(st.days["2026-09-01"].legacy.kcal, 1900);
  assert.deepEqual(st.days["2026-09-02"].legacy.appleSleep, { bed: "23:00", wake: "03:05", sleepMins: 245 });
  assert.deepEqual(st.goals.tracked, ["calories", "protein", "workout", "active", "exercise"]);

  const rv = await (await fetch(`${b3}/api/review`, { headers: { cookie: c } })).json();
  assert.deepEqual(rv.items.map((x) => [x.key, x.savedByHand, !!x.sleep]), [["2026-09-02", false, false], ["2026-09-01", true, false]]);
  const done = await (await fetch(`${b3}/api/review`, { method: "POST", headers: { cookie: c, "content-type": "application/json" },
    body: JSON.stringify({ keep: ["2026-09-01"], reject: ["2026-09-02"] }) })).json();
  assert.equal(done.done, 2);
  assert.equal(done.items.length, 0);
  const st2 = await (await fetch(`${b3}/api/state`, { headers: { cookie: c } })).json();
  assert.deepEqual(st2.days["2026-09-01"].manual, { kcal: 1900, protein: 150, creatine: true, foodDone: true });
  assert.deepEqual(st2.days["2026-09-02"].legacy.rejected, { kcal: 3400, protein: 40 });
  s3.close();

  // A second start doesn't migrate again.
  const s4 = await createApp({ store: legacyStore, root, password: "pw123456", secret: "k", ingestToken: "t", requireAuth: true });
  s4.close();
  assert.deepEqual((await legacyStore.getAll()).days["2026-09-01"].manual.kcal, 1900);
  await legacyStore.close();
});

test("five wrong passwords lock an address out for a minute", async () => {
  const wrong = () => fetch(`${base}/login`, { method: "POST", body: "password=nope",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" } });
  for (let i = 0; i < 5; i++) assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).status, 429);
});

test("no password on Railway means no service", async () => {
  const bare = await openStore({ file: join(dir, "bare.json") });
  const s2 = await createApp({ store: bare, root, password: "", secret: "x", ingestToken: "", requireAuth: true });
  await new Promise((r) => s2.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/state`);
  assert.equal(res.status, 503);
  s2.close();
});

const j = (c) => ({ cookie: c, "content-type": "application/json" });

test("upload tokens: create, use, reveal, rotate, rename, delete", async () => {
  const c = await login();
  const made = await (await fetch(`${base}/api/tokens`, { method: "POST", headers: j(c), body: JSON.stringify({ name: "iPhone" }) })).json();
  assert.match(made.token, /^ahx_[\w-]{40,}$/);

  const list = await (await fetch(`${base}/api/settings`, { headers: { cookie: c } })).json();
  const t = list.tokens.find((x) => x.id === made.id);
  assert.equal(t.name, "iPhone");
  assert.equal(t.token, undefined, "the list never carries full tokens");
  assert.ok(made.token.endsWith(t.preview.slice(-4)));
  assert.equal(list.envToken, true);

  const push = (tok) => fetch(`${base}/api/ingest`, { method: "POST", headers: { authorization: `Bearer ${tok}` },
    body: JSON.stringify({ date: "2026-09-20", steps: 5000 }) });
  assert.equal((await push(made.token)).status, 200);
  assert.equal((await push("tok123")).status, 200, "the Railway variable still works alongside");
  const after = await (await fetch(`${base}/api/settings`, { headers: { cookie: c } })).json();
  assert.ok(after.tokens.find((x) => x.id === made.id).lastUsedAt);

  const shown = await (await fetch(`${base}/api/tokens/${made.id}`, { headers: { cookie: c } })).json();
  assert.equal(shown.token, made.token);
  assert.equal((await fetch(`${base}/api/tokens/${made.id}`)).status, 401, "revealing needs a session");

  const rotated = await (await fetch(`${base}/api/tokens/${made.id}/rotate`, { method: "POST", headers: j(c), body: "{}" })).json();
  assert.notEqual(rotated.token, made.token);
  assert.equal((await push(made.token)).status, 401, "the old value is dead");
  assert.equal((await push(rotated.token)).status, 200);

  await fetch(`${base}/api/tokens/${made.id}`, { method: "PUT", headers: j(c), body: JSON.stringify({ name: "  Watch  " }) });
  assert.equal((await (await fetch(`${base}/api/tokens/${made.id}`, { headers: { cookie: c } })).json()).name, "Watch");

  assert.equal((await fetch(`${base}/api/tokens/${made.id}`, { method: "DELETE", headers: { cookie: c } })).status, 200);
  assert.equal((await push(rotated.token)).status, 401);
});

test("prefs keep only allowed values", async () => {
  const c = await login();
  const r = await (await fetch(`${base}/api/prefs`, { method: "PUT", headers: j(c),
    body: JSON.stringify({ weightRange: "all", trendRange: "7", sleepN: 99, trendMetric: "vodka", showSample: false, evil: 1 }) })).json();
  assert.deepEqual(r.prefs, { weightRange: "all", trendRange: 7, trendMetric: "calories", sleepN: 7, showSample: false });
  const s = await (await fetch(`${base}/api/state`, { headers: { cookie: c } })).json();
  assert.equal(s.prefs.weightRange, "all");
});

test("sign out everywhere retires old cookies but keeps this one", async () => {
  const other = await login();
  const me = await login();
  const res = await fetch(`${base}/api/sessions/revoke`, { method: "POST", headers: j(me), body: "{}" });
  assert.equal(res.status, 200);
  const fresh = res.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: other } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: fresh } })).status, 200);
});

// Last: it changes the password the other tests sign in with.
test("changing the password in Settings replaces APP_PASSWORD", async () => {
  const c = await login();
  const put = (body, cookie = c) => fetch(`${base}/api/password`, { method: "PUT", headers: j(cookie), body: JSON.stringify(body) });
  assert.equal((await put({ current: "wrong", next: "correct horse" })).status, 403);
  assert.equal((await put({ current: "hunter2", next: "short" })).status, 400);
  const ok = await put({ current: "hunter2", next: "correct horse" });
  assert.equal(ok.status, 200);
  const fresh = ok.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: c } })).status, 401, "old sessions end");
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: fresh } })).status, 200, "this device stays in");

  const tryLogin = (pw) => fetch(`${base}/login`, { method: "POST", body: `password=${encodeURIComponent(pw)}`, redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.0.0.${pw.length}` } });
  assert.equal((await tryLogin("hunter2")).status, 401);
  assert.equal((await tryLogin("correct horse")).status, 303);
  const st = await (await fetch(`${base}/api/settings`, { headers: { cookie: fresh } })).json();
  assert.equal(st.password.source, "settings");
});
