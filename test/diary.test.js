// The food diary, library, training plan and achievements over HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { resolveDay } from "../js/sources.js";
import { USDA_CHOBANI } from "./fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir, store, server, base;
const fetchCalls = [];

async function fakeFetch(url, init = {}) {
  fetchCalls.push(String(url));
  const body = /nal\.usda\.gov/.test(url)
    ? { foods: JSON.parse(init.body).dataType.includes("Branded") ? [USDA_CHOBANI] : [] }
    : { products: [] };
  return { ok: true, status: 200, json: async () => body };
}
const estimateCalls = [];
const makeClient = async () => ({
  sdk: null,
  client: {
    beta: { messages: { create: async (req) => {
      estimateCalls.push(req);
      return { stop_reason: "end_turn", model: req.model, content: [{ type: "text", text: JSON.stringify({
        isFood: true, name: "Turkey hoagie", brand: "Wawa", servingLabel: "1 classic hoagie", servingUnit: "serving", servingAmount: 1,
        servingGrams: 300, quantity: 1, kcal: 680, protein: 38, carbs: 72, fat: 26, fiber: null, kcalLow: 560, kcalHigh: 820,
        confidence: "medium", basis: "Typical recipe; Wawa's own numbers may differ.", officialSource: null, ask: null,
      }) }] };
    } } },
    models: { retrieve: async (id) => ({ id }) },
  },
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ash-diary-"));
  store = await openStore({ databaseUrl: process.env.TEST_DATABASE_URL, file: join(dir, "db.json") });
  await store.replaceDays({});
  for (const k of ["food", "meal", "reward", "lookup", "estimate"]) for (const x of await store.listItems(k)) await store.deleteItem(k, x.id);
  // A shared test database may hold a password or keys from other test files.
  for (const k of ["trainingPlan", "achievementTiers", "achievementLedger", "foodApis", "auth", "tokens"]) await store.setMeta(k, null);
  server = await createApp({ store, root, password: "", secret: "s".repeat(32), requireAuth: false, fetch: fakeFetch, makeClient, foodEnv: { usdaKey: "env-usda-key-123456" } });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const shake = { id: "food_shake", name: "Specular Protein Shake", serving: { label: "1 shake", amount: 1, unit: "serving" },
  nutrients: { kcal: 210, protein: 35, carbs: 12, fat: 4, fiber: 2 }, source: { kind: "custom" }, favorite: true };

test("custom foods save, clean and list; uses are counted by the server as you log", async () => {
  const put = await call("PUT", "/api/items/food/food_shake", { ...shake, uses: { count: 99 }, junk: "<script>" });
  assert.equal(put.status, 200);
  assert.equal(put.body.item.uses.count, 0, "the page can't set usage counts");
  assert.equal(put.body.item.junk, undefined);
  assert.equal((await call("PUT", "/api/items/food/food_bad", { name: "No calories" })).status, 400);
  assert.equal((await call("PUT", "/api/items/nope/x1", shake)).status, 404);

  // Log it twice for breakfast; the day's totals come only from the diary.
  const e = (id) => ({ id, meal: "breakfast", name: shake.name, qty: 1, unit: "serving", serving: shake.serving, kcal: 210, protein: 35, carbs: 12, fat: 4, fiber: 2, foodId: "food_shake", source: { kind: "custom" }, time: "08:10" });
  let r = await call("PATCH", "/api/days/2026-09-28", { foods: [e("f1")] });
  assert.equal(r.status, 200);
  r = await call("PATCH", "/api/days/2026-09-28", { foods: [e("f1"), e("f2")] });
  const lib = (await call("GET", "/api/library")).body;
  assert.equal(lib.foods[0].uses.count, 2, "each new entry counts once");
  assert.ok(lib.foods[0].uses.lastUsedAt);
  const day = resolveDay((await call("GET", "/api/state")).body.days["2026-09-28"]);
  assert.equal(day.kcal, 420);
  assert.equal(day.protein, 70);
  assert.equal(day.food.byMeal.breakfast.entries.length, 2);
});

test("saving the log dialog keeps the diary and lifts; PATCH changes only what's sent", async () => {
  await call("PATCH", "/api/days/2026-09-28", { lifts: [{ exercise: "Bench press", sets: [{ reps: 8, weight: 135 }, { reps: 8, weight: 135 }] }] });
  await call("PUT", "/api/days/2026-09-28", { creatine: true, kcal: 300 }); // the log dialog: quick-add totals
  let raw = (await call("GET", "/api/state")).body.days["2026-09-28"];
  assert.equal(raw.manual.foods.length, 2, "diary kept");
  assert.equal(raw.manual.lifts.length, 1, "lifts kept");
  assert.equal(resolveDay(raw).kcal, 720, "diary + quick-add");
  await call("PATCH", "/api/days/2026-09-28", { foodDone: true, kcal: null });
  raw = (await call("GET", "/api/state")).body.days["2026-09-28"];
  assert.equal(raw.manual.foodDone, true);
  assert.equal(raw.manual.kcal, undefined, "null clears a field");
  assert.equal(raw.manual.creatine, true, "untouched fields stay");
  // PATCH needs JSON, like every other write
  const res = await fetch(`${base}/api/days/2026-09-28`, { method: "PATCH", body: "foodDone=false", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 415);
});

test("Apple Health can't write food, lifts or calories eaten, even through the diary fields", async () => {
  await store.setMeta("tokens", []);
  const { body: t } = await call("POST", "/api/tokens", { name: "iPhone" });
  const res = await fetch(`${base}/api/ingest`, {
    method: "POST", headers: { authorization: `Bearer ${t.token}` },
    body: JSON.stringify({ date: "2026-09-28", steps: 9000, foods: [{ name: "Apple food", kcal: 999 }], lifts: [{ exercise: "x", sets: [{ reps: 1, weight: 1 }] }], dietaryEnergy: 999, protein: 99 }),
  });
  assert.equal(res.status, 200);
  const raw = (await call("GET", "/api/state")).body.days["2026-09-28"];
  assert.deepEqual(Object.keys(raw.apple).sort(), ["steps"]);
  const d = resolveDay(raw);
  assert.equal(d.kcal, 420);
  assert.equal(d.foods.length, 2);
});

test("meals and rewards are items too; rewards link to a tier by id", async () => {
  const meal = await call("PUT", "/api/items/meal/meal_1", { name: "Usual breakfast", items: [{ name: "Egg", kcal: 72, protein: 6.3, qty: 2, unit: "piece" }, { name: "Nothing" }] });
  assert.equal(meal.status, 200);
  assert.equal(meal.body.item.items.length, 1, "items without calories are dropped");
  const rw = await call("PUT", "/api/items/reward/rew_1", { name: "New running shoes", achievementId: "weight-2", description: "The good ones" });
  assert.equal(rw.body.item.achievementId, "weight-2");
  const bad = await call("PUT", "/api/items/reward/rew_2", { name: "x", achievementId: "../../etc" });
  assert.equal(bad.body.item.achievementId, null);
  const claimed = await call("PUT", "/api/items/reward/rew_1", { ...rw.body.item, claimedAt: "2026-09-29T12:00:00Z" });
  assert.equal(claimed.body.item.claimedAt, "2026-09-29T12:00:00.000Z");
  assert.equal(claimed.body.item.createdAt, rw.body.item.createdAt);
  await call("DELETE", "/api/items/reward/rew_2");
  const lib = (await call("GET", "/api/library")).body;
  assert.deepEqual(lib.rewards.map((r) => r.id), ["rew_1"]);
});

test("food search returns saved foods and ranked, cached lookups; estimates are labelled", async () => {
  const first = await call("GET", `/api/food/search?q=${encodeURIComponent("chobani zero sugar vanilla yogurt")}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.results[0].source.kind, "verified");
  assert.equal(first.body.cached, false);
  const n = fetchCalls.length;
  const again = await call("GET", `/api/food/search?q=${encodeURIComponent("Chobani Zero Sugar Vanilla Yogurt")}`);
  assert.equal(again.body.cached, true);
  assert.equal(fetchCalls.length, n);
  const saved = await call("GET", `/api/food/search?q=${encodeURIComponent("protein shake")}`);
  assert.equal(saved.body.saved[0].id, "food_shake");
  assert.equal((await call("GET", "/api/food/search?q=")).status, 400);

  const none = await call("POST", "/api/food/estimate", { text: "Wawa turkey hoagie" });
  assert.equal(none.status, 400, "no Anthropic key yet");
  assert.match(none.body.error, /Anthropic API key/);
  await call("PUT", "/api/food-apis", { anthropicKey: "sk-ant-test-0000000000" });
  const est = await call("POST", "/api/food/estimate", { text: "Wawa turkey hoagie" });
  assert.equal(est.status, 200);
  assert.equal(est.body.food.source.kind, "estimate");
  assert.equal(est.body.food.source.confidence, "medium");
  assert.equal(estimateCalls[0].fallbacks, "default");
  // Nothing was saved to the diary or library by estimating
  assert.equal((await call("GET", "/api/library")).body.foods.length, 1);
});

test("lookup keys are stored, masked, and cleared back to the Railway variable", async () => {
  let s = (await call("GET", "/api/settings")).body.food;
  assert.equal(s.usda.source, "railway");
  assert.equal(s.anthropic.source, "settings");
  assert.equal(s.anthropic.preview, "sk-a…0000");
  assert.ok(!JSON.stringify(s).includes("sk-ant-test-0000000000"), "never the key itself");
  assert.equal((await call("PUT", "/api/food-apis", { usdaKey: "has space" })).status, 400);
  assert.equal((await call("PUT", "/api/food-apis", { anthropicModel: "gpt-4" })).status, 400);
  await call("PUT", "/api/food-apis", { usdaKey: "mine-usda-key-99999", offEnabled: false, anthropicModel: "claude-sonnet-5-5" });
  s = (await call("GET", "/api/settings")).body.food;
  assert.equal(s.usda.source, "settings");
  assert.equal(s.offEnabled, false);
  assert.equal(s.model, "claude-sonnet-5-5");
  await call("PUT", "/api/food-apis", { usdaKey: "" });
  assert.equal((await call("GET", "/api/settings")).body.food.usda.source, "railway");
  const t = await call("POST", "/api/food-apis/test", { provider: "usda" });
  assert.equal(t.body.ok, true);
  assert.equal((await call("POST", "/api/food-apis/test", { provider: "anthropic" })).body.ok, true);
});

test("training plan, tier overrides and the achievement ledger", async () => {
  const plan = await call("PUT", "/api/plan", { days: { mon: "strength", tue: "cardio", wed: "rest", thu: "strength", fri: "any", sat: "bogus" }, since: "2026-09-01" });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plan.days.sat, "rest");
  assert.equal(plan.body.plan.days.sun, "rest");
  assert.equal((await call("GET", "/api/state")).body.plan.days.mon, "strength");

  assert.equal((await call("PUT", "/api/achievement-tiers", { iron: [10, 5, 20, 30, 40] })).status, 400);
  assert.equal((await call("PUT", "/api/achievement-tiers", { iron: [1, 2, 3] })).status, 400);
  const t = await call("PUT", "/api/achievement-tiers", { iron: [20000, 50000, 100000, 250000, 500000], weight: [5, 10, 15, 20, 25] });
  assert.deepEqual(t.body.tiers, { iron: [20000, 50000, 100000, 250000, 500000] }, "defaults aren't stored as overrides");

  let l = await call("POST", "/api/achievements/ledger", { init: ["weight-1", "complete-1"] });
  assert.ok(l.body.ledger.initializedAt);
  assert.equal(l.body.ledger.entries["weight-1"].historical, true);
  const again = await call("POST", "/api/achievements/ledger", { init: ["weight-2"] });
  assert.equal(again.body.ledger.entries["weight-2"], undefined, "init only happens once");
  l = await call("POST", "/api/achievements/ledger", { ack: ["weight-1", "<bad>"] });
  assert.ok(l.body.ledger.entries["weight-1"].ackAt);
  assert.equal(l.body.ledger.entries["<bad>"], undefined);
  const s = (await call("GET", "/api/state")).body;
  assert.ok(s.achievements.ledger.entries["weight-1"].ackAt);
  assert.deepEqual(s.achievements.tiers, { iron: [20000, 50000, 100000, 250000, 500000] });
  assert.equal((await call("PUT", "/api/plan", null)).body.plan, null);
});

test("imports restore the library and plan alongside the days", async () => {
  const r = await call("POST", "/api/import", {
    days: { "2026-09-20": { manual: { foods: [{ name: "Oats", kcal: 150, meal: "breakfast" }], foodDone: true }, apple: {} } },
    library: { foods: [{ id: "food_oats", name: "Oats", nutrients: { kcal: 150 } }], meals: [], rewards: [{ id: "rew_9", name: "Massage" }] },
    plan: { days: { mon: "strength" } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.items, 2);
  const s = (await call("GET", "/api/state")).body;
  assert.equal(resolveDay(s.days["2026-09-20"]).kcal, 150);
  assert.ok(s.library.foods.some((f) => f.id === "food_oats"));
  assert.equal(s.plan.days.mon, "strength");
});
