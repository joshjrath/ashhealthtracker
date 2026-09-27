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
  server = createApp({ store, root, password: "hunter2", secret: "s".repeat(32), ingestToken: "tok123", requireAuth: true });
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
  assert.deepEqual(s.days["2026-09-27"], { creatine: true, protein: 158, steps: 11240 });
  assert.equal(s.lastSync.days, 1);
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

test("no password on Railway means no service", async () => {
  const s2 = createApp({ store, root, password: "", secret: "x", ingestToken: "", requireAuth: true });
  await new Promise((r) => s2.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/state`);
  assert.equal(res.status, 503);
  s2.close();
});
