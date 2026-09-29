// Training plan weeks, lifting history, and the one achievement engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekStatus, planStreak, liftHistory, e1rm, cleanPlan, plannedFor } from "../js/training.js";
import { evaluate, buildCatalog, rankNext, unseenUnlocks, progressText, remainingText, DEFAULT_CATALOG } from "../js/achievements.js";
import { resolveDay, cleanApple } from "../js/sources.js";
import { goalStatus, dayScore, streak, DEFAULT_GOALS, addDays, range } from "../js/metrics.js";

const PLAN = cleanPlan({ days: { mon: "strength", tue: "cardio", wed: "rest", thu: "strength", fri: "any", sat: "rest", sun: "rest" } });
const lift = (weight, reps = 8, sets = 3) => [{ exercise: "Bench press", sets: Array.from({ length: sets }, () => ({ reps, weight, unit: "lb" })) }];
const strength = (k, weight = 135) => resolveDay({ manual: { lifts: lift(weight) }, apple: {} }, k);
const cardio = (k) => resolveDay({ manual: {}, apple: { workouts: [{ type: "Running", start: `${k}T07:00`, durationMin: 30 }], exerciseMin: 32, activeKcal: 400 } }, k);
const quiet = (k) => resolveDay({ manual: {}, apple: { exerciseMin: 5, activeKcal: 200 } }, k); // synced, no workout
const resolveAll = (raw) => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolveDay(v, k)]));

/* ── training ──────────────────────────────────────────────────────────── */

test("a plan week counts strength, cardio and total sessions; moving a day is fine", () => {
  // Week of Mon 2026-09-07: lift Tue instead of Mon, run Wed, lift Thu, anything Fri.
  const days = { "2026-09-08": strength("2026-09-08"), "2026-09-09": cardio("2026-09-09"), "2026-09-10": strength("2026-09-10"), "2026-09-11": cardio("2026-09-11") };
  const w = weekStatus(days, PLAN, "2026-09-07", "2026-09-20");
  assert.equal(w.status, "hit");
  assert.deepEqual(w.need, { strength: 2, cardio: 1, total: 4 });
  const short = weekStatus({ ...days, "2026-09-11": quiet("2026-09-11") }, PLAN, "2026-09-07", "2026-09-20");
  assert.equal(short.status, "miss", "three of four planned sessions");
  assert.equal(weekStatus({}, PLAN, "2026-09-07", "2026-09-20").status, "none", "no data at all is a gap, not a miss");
  assert.equal(weekStatus({}, PLAN, "2026-09-21", "2026-09-23").status, "pending", "the current week isn't judged yet");
  assert.equal(weekStatus({}, cleanPlan({ days: {} }), "2026-09-07", "2026-09-20").status, null, "an all-rest plan earns nothing");
});

test("planned rest days take the workout goal out of the day", () => {
  const g = { ...DEFAULT_GOALS, tracked: ["workout", "steps"], plan: PLAN };
  const wed = resolveDay({ manual: {}, apple: { steps: 12000 } }, "2026-09-09");
  assert.equal(plannedFor(PLAN, "2026-09-09"), "rest");
  assert.equal(goalStatus("workout", wed, g), "off");
  const s = dayScore(wed, g);
  assert.equal(s.total, 1, "only steps counts on a rest day");
  assert.equal(s.hit, 1);
  // Rest days don't break a workout streak either
  const days = { "2026-09-08": cardio("2026-09-08"), "2026-09-09": wed, "2026-09-10": strength("2026-09-10") };
  assert.equal(streak("workout", days, g, "2026-09-10").current, 2);
});

test("plan streak: a gap week pauses, a missed week resets, dates recorded", () => {
  const raw = {};
  const fullWeek = (mon) => {
    raw[mon] = { manual: { lifts: lift(135) }, apple: {} };
    raw[addDays(mon, 1)] = { manual: {}, apple: { workouts: [{ type: "Running", start: `${addDays(mon, 1)}T07:00` }] } };
    raw[addDays(mon, 3)] = { manual: { lifts: lift(135) }, apple: {} };
    raw[addDays(mon, 4)] = { manual: {}, apple: { workouts: [{ type: "Cycling", start: `${addDays(mon, 4)}T07:00` }] } };
  };
  fullWeek("2026-08-03"); fullWeek("2026-08-10"); /* 08-17: no data */ fullWeek("2026-08-24");
  const days = resolveAll(raw);
  const s = planStreak(days, PLAN, "2026-08-30", "2026-08-03");
  assert.equal(s.current, 3);
  assert.equal(s.reachedAt[1], "2026-08-09");
  assert.equal(s.reachedAt[3], "2026-08-30");
  // A synced-but-empty week is a miss and resets the run
  raw["2026-08-18"] = { manual: {}, apple: { exerciseMin: 5, activeKcal: 100 } };
  assert.equal(planStreak(resolveAll(raw), PLAN, "2026-08-30", "2026-08-03").current, 1);
});

test("lifting: volume in lb, kg converted, overload = a new best estimated max", () => {
  assert.equal(Math.round(e1rm({ reps: 5, weight: 100, unit: "kg" })), Math.round(100 * 2.2046226218 * (1 + 5 / 30)));
  const days = {
    "2026-09-01": { lifts: lift(135) },
    "2026-09-04": { lifts: lift(135) },
    "2026-09-08": { lifts: lift(145) },
  };
  const h = liftHistory(days, Object.keys(days).sort());
  assert.equal(h.volume, 3 * 8 * (135 + 135 + 145));
  assert.equal(h.increases, 1);
  assert.equal(h.perDay[2].prs[0].exercise, "Bench press");
  assert.equal(h.sessions, 3);
});

/* ── achievements ──────────────────────────────────────────────────────── */

const G = { ...DEFAULT_GOALS, startWeight: 172.3 };

function weightDays(values, from = "2026-06-01") {
  const raw = {};
  values.forEach((v, i) => { if (v != null) raw[addDays(from, i)] = { manual: {}, apple: { weight: v } }; });
  return resolveAll(raw);
}

test("weight loss: progress on the trend, dated the day it crossed, a heavy morning can't take it back", () => {
  const vals = [];
  for (let i = 0; i < 60; i++) vals.push(+(172.3 - i * 0.2).toFixed(1)); // −0.2 lb a day
  vals.push(170); // a heavy morning on day 61
  const days = weightDays(vals);
  const today = addDays("2026-06-01", 60);
  const r = evaluate({ days, g: G, today, catalog: buildCatalog() });
  const w = r.groups.find((x) => x.id === "weight");
  assert.equal(w.tiers[0].unlocked, true);
  assert.equal(w.tiers[1].unlocked, true);
  assert.ok(w.tiers[1].unlockedAt, "unlock date known");
  assert.equal(w.tiers[1].dateKnown, true);
  // Trend (7-day avg) crosses 10 lb lost around day 53–54.
  assert.ok(w.tiers[1].unlockedAt >= "2026-07-20" && w.tiers[1].unlockedAt <= "2026-07-26", w.tiers[1].unlockedAt);
  assert.equal(w.tiers[2].unlocked, false);
  assert.match(progressText(w.tiers[2]), /^\d+\.\d \/ 15\.0 lb$/);
  assert.match(remainingText(w.tiers[2]), /lb remaining$/);
});

test("historical unlocks: weight lost before tracking began has no invented date", () => {
  const days = weightDays([160, 160.2, 159.8, 160.1]); // already 12 lb down from 172.3 at the first weigh-in
  const r = evaluate({ days, g: G, today: "2026-06-04", catalog: buildCatalog() });
  const t2 = r.byId["weight-2"];
  assert.equal(t2.unlocked, true);
  assert.equal(t2.dateKnown, false);
  assert.equal(t2.unlockedAt, null);
});

function foodDay(k, kcal, protein, done = true) {
  return { manual: { foods: [{ meal: "lunch", name: "Food", kcal, protein }], foodDone: done }, apple: {} };
}

test("nutrition consistency rewards in-range complete days with protein — never eating less", () => {
  const raw = {};
  const start = "2026-09-01";
  for (let i = 0; i < 10; i++) raw[addDays(start, i)] = foodDay(addDays(start, i), 2000, 160); // in range, protein hit
  for (let i = 10; i < 20; i++) raw[addDays(start, i)] = foodDay(addDays(start, i), 1200, 160); // well under: never counts
  for (let i = 20; i < 25; i++) raw[addDays(start, i)] = foodDay(addDays(start, i), 2000, 160, false); // not marked complete
  const days = resolveAll(raw);
  const r = evaluate({ days, g: G, today: addDays(start, 24), catalog: buildCatalog() });
  const n = r.groups.find((x) => x.id === "nutrition");
  assert.equal(n.current, 10);
  assert.equal(n.tiers[0].unlocked, true);
  assert.equal(n.tiers[0].unlockedAt, addDays(start, 6));
  assert.equal(n.tiers[1].unlocked, false);
});

test("Apple Health food and sleep can never unlock anything", () => {
  const raw = {};
  const start = "2026-09-01";
  for (let i = 0; i < 20; i++) {
    const k = addDays(start, i);
    // Whatever Apple sends for food or sleep is stripped at the door…
    const apple = cleanApple({ kcal: 2000, protein: 180, dietaryEnergy: 2000, bed: "22:00", wake: "07:00", sleepMins: 540, steps: 12000, activeKcal: 700, exerciseMin: 70 });
    // …and even if an old bucket held it, it's never read.
    raw[k] = { manual: { creatine: true }, apple: { ...apple, kcal: 2000, protein: 180, bed: "22:00", wake: "07:00" } };
  }
  const days = resolveAll(raw);
  const r = evaluate({ days, g: G, today: addDays(start, 19), catalog: buildCatalog() });
  assert.equal(r.groups.find((x) => x.id === "nutrition").current, 0);
  assert.equal(r.groups.find((x) => x.id === "complete").current, 0, "no complete days without your own food and sleep");
});

test("training consistency needs a plan and says so", () => {
  const r = evaluate({ days: {}, g: G, today: "2026-09-29", catalog: buildCatalog() });
  const t = r.groups.find((x) => x.id === "training");
  assert.match(t.needsSetup, /training plan/);
  assert.ok(!r.next.some((x) => x.group === "training"), "not suggested until it can be earned");
});

test("next unlock: deterministic, 'possible today' first, then soonest at your pace", () => {
  const mk = (id, groupIndex, pct, eta, possibleToday = false) => ({
    id: `${id}-1`, group: id, groupIndex, pct, remaining: 1, threshold: 2,
    metric: { eta: () => ({ days: eta, possibleToday, label: "", why: "" }) },
  });
  const groups = [
    { id: "a", next: mk("a", 0, 0.9, 30).valueOf(), metric: { eta: () => ({ days: 30, label: "", why: "" }) } },
    { id: "b", next: mk("b", 1, 0.2, 3), metric: { eta: () => ({ days: 3, label: "", why: "" }) } },
    { id: "c", next: mk("c", 2, 0.5, 9), metric: { eta: () => ({ days: 0.5, possibleToday: true, label: "Possible today", why: "" }) } },
  ];
  assert.deepEqual(rankNext(groups).map((x) => x.group), ["c", "b", "a"], "not by raw percentage");
  assert.deepEqual(rankNext(groups).map((x) => x.group), rankNext([...groups].reverse()).map((x) => x.group));
});

test("the catalog is data: overrides validated, new families from existing metric kinds", () => {
  const cat = buildCatalog(
    [{ id: "protein", name: "Protein Days", metric: "goalDays", params: { goal: "protein" }, tiers: [3, 6, 9], unit: "days", requirement: "Hit protein on {n} days" },
      { id: "bogus", metric: "noSuchKind", tiers: [1] }],
    { iron: [20000, 50000, 100000, 250000, 500000], weight: [5, 4, 3, 2, 1] },
  );
  assert.deepEqual(cat.find((c) => c.id === "iron").tiers, [20000, 50000, 100000, 250000, 500000]);
  assert.deepEqual(cat.find((c) => c.id === "weight").tiers, [5, 10, 15, 20, 25], "a descending override is ignored");
  assert.ok(!cat.some((c) => c.id === "bogus"));
  const raw = {};
  for (let i = 0; i < 4; i++) raw[addDays("2026-09-01", i)] = foodDay(addDays("2026-09-01", i), 2000, 160);
  const r = evaluate({ days: resolveAll(raw), g: G, today: "2026-09-04", catalog: cat });
  assert.equal(r.byId["protein-1"].unlocked, true);
  assert.equal(r.byId["protein-2"].unlocked, false);
  assert.equal(r.total, DEFAULT_CATALOG.length * 5 + 3);
});

test("rewards attach to tiers; the ledger decides what's been celebrated", () => {
  const days = weightDays([160, 160.2, 159.8]);
  const rewards = [{ id: "rew_1", name: "New shoes", achievementId: "weight-2" }, { id: "rew_2", name: "Old", achievementId: "weight-2", archived: true }];
  const r = evaluate({ days, g: G, today: "2026-06-03", catalog: buildCatalog(), rewards });
  assert.deepEqual(r.byId["weight-2"].rewards.map((x) => x.id), ["rew_1"]);
  assert.deepEqual(unseenUnlocks(r, null), [], "nothing is celebrated before the ledger starts");
  const ledger = { initializedAt: "2026-06-03T00:00:00Z", entries: { "weight-1": { ackAt: "x" } } };
  assert.deepEqual(unseenUnlocks(r, ledger).map((t) => t.id), ["weight-2"]);
});

test("complete days need every goal that applied, not in a row", () => {
  const g = { ...G, tracked: ["protein", "creatine"] };
  const raw = {};
  range("2026-09-01", "2026-09-10").forEach((k, i) => {
    raw[k] = { manual: { foods: [{ name: "x", kcal: 2000, protein: i % 2 ? 100 : 160 }], foodDone: true, creatine: true }, apple: {} };
  });
  const r = evaluate({ days: resolveAll(raw), g, today: "2026-09-10", catalog: buildCatalog() });
  assert.equal(r.groups.find((x) => x.id === "complete").current, 5);
  assert.equal(r.byId["complete-1"].unlocked, true);
});
