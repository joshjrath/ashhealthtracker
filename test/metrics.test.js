import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOALS, addDays, mondayOf, nightOffset, sleepMinutes, goalStatus, dayScore, streak, adherence,
  averageOf, foodStatus, weightStats, goalProgress, weeklyWeight, macroCalories, fitnessTotals,
  workoutStreak, weeklyReview, insights, fmtClock, fmtDur, MIN,
} from "../js/metrics.js";
import { resolveDay } from "../js/sources.js";
import { seed } from "../js/store.js";

const g = DEFAULT_GOALS;
const T = "2026-09-27"; // a Sunday
const R = (manual = {}, apple = {}) => resolveDay({ manual, apple });

test("dates step across month and year ends", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(mondayOf(T), "2026-09-21");
});

test("sleep is bed → wake from your log only", () => {
  assert.equal(nightOffset("23:00"), 180);
  assert.equal(sleepMinutes({ bed: "23:15", wake: "07:00" }), 465);
  assert.equal(sleepMinutes({ bed: "23:15", wake: "07:00", sleepMins: 120 }), 465, "Apple's number is ignored");
  assert.equal(sleepMinutes({ bed: "23:15" }), null);
  assert.equal(fmtClock(180), "11:00p");
  assert.equal(fmtDur(482), "8h 02m");
});

test("food status: none, partial, complete", () => {
  assert.equal(foodStatus(R()), "none");
  assert.equal(foodStatus(R({ protein: 40 })), "partial");
  assert.equal(foodStatus(R({ kcal: 1900, foodDone: true })), "complete");
});

test("missing data is never a miss", () => {
  const empty = R();
  for (const id of ["calories", "protein", "fiber", "steps", "active", "exercise", "sleep", "creatine", "workout"]) {
    assert.equal(goalStatus(id, empty, g, false), "none", `${id} past`);
    assert.equal(goalStatus(id, empty, g, true), "pending", `${id} today`);
  }
  assert.equal(goalStatus("calories", undefined, g), "none");
});

test("food goals: hits are final, misses need a complete log", () => {
  assert.equal(goalStatus("protein", R({ protein: 160 }), g), "hit", "hit even on a partial log");
  assert.equal(goalStatus("protein", R({ protein: 90 }), g), "none", "partial and short: can't call it");
  assert.equal(goalStatus("protein", R({ protein: 90, foodDone: true }), g), "miss");
  assert.equal(goalStatus("calories", R({ kcal: 1500 }), g, true), "pending");
  assert.equal(goalStatus("calories", R({ kcal: 1950 }), g), "none", "in range but partial");
  assert.equal(goalStatus("calories", R({ kcal: 1950, foodDone: true }), g), "hit");
  assert.equal(goalStatus("calories", R({ kcal: 2300 }), g, true), "miss", "over the zone can't come back");
  assert.equal(goalStatus("calories", R({ kcal: 1500, foodDone: true }), g), "miss");
});

test("fitness and habit goals", () => {
  assert.equal(goalStatus("steps", R({}, { steps: 12000 }), g, true), "hit");
  assert.equal(goalStatus("steps", R({}, { steps: 4000 }), g, true), "pending");
  assert.equal(goalStatus("steps", R({}, { steps: 4000 }), g, false), "miss");
  assert.equal(goalStatus("active", R({}, { activeKcal: 650 }), g), "hit");
  assert.equal(goalStatus("exercise", R({}, { exerciseMin: 30 }), g), "miss");
  assert.equal(goalStatus("workout", R({}, { exerciseMin: 12 }), g), "miss", "Watch synced, no workout");
  assert.equal(goalStatus("workout", R({}, { steps: 5000 }), g), "none", "steps alone don't prove a rest day");
  assert.equal(goalStatus("creatine", R({ creatine: false }), g), "miss");
  assert.equal(goalStatus("sleep", R({ bed: "01:00", wake: "06:00" }), g), "miss");
});

test("daily score keeps hits, misses and gaps apart", () => {
  const day = R({ kcal: 1760, protein: 143, fiber: 8, bed: "22:58", wake: "07:00", creatine: true }, { steps: 11240, activeKcal: 482, exerciseMin: 47 });
  const s = dayScore(day, g, true);
  assert.equal(s.total, 8);
  assert.equal(s.hit, 3); // steps, sleep, creatine
  assert.equal(s.pending, 5);
  assert.equal(s.miss, 0);
  const past = dayScore(R({ creatine: true }), g, false);
  assert.deepEqual([past.hit, past.miss, past.none], [1, 0, 7]);
});

test("streaks: no data pauses, a miss or three blank days ends", () => {
  const days = {};
  const hit = () => R({ creatine: true });
  days["2026-09-15"] = R({ creatine: false });
  for (const k of ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"]) days[k] = hit();
  // 20, 21 no data (paused)
  for (const k of ["2026-09-22", "2026-09-23"]) days[k] = hit();
  // 24, 25, 26 no data → ended
  days[T] = hit();
  assert.deepEqual(streak("creatine", days, g, T), { current: 1, best: 6 });
  days["2026-09-25"] = hit();
  assert.deepEqual(streak("creatine", days, g, T), { current: 8, best: 8 }); // 16–19, 22–23, 25, 27
  days["2026-09-26"] = R({ creatine: false });
  assert.deepEqual(streak("creatine", days, g, T), { current: 1, best: 7 });
});

test("adherence divides by judged goal-days and needs a sample", () => {
  const days = {};
  for (let i = 0; i < 4; i++) days[addDays(T, -i)] = R({ creatine: i !== 0 }, { steps: 12000 });
  const a = adherence(days, g, addDays(T, -6), T, T);
  assert.equal(a.hit, 7); // 4 steps + 3 creatine
  assert.equal(a.judged, 8);
  assert.equal(a.rate, null, "8 < MIN.adherence");
  for (let i = 4; i < 7; i++) days[addDays(T, -i)] = R({ creatine: true }, { steps: 12000 });
  assert.equal(adherence(days, g, addDays(T, -6), T, T).rate, 13 / 14);
});

test("averages skip gaps, need a sample, and count complete food days only", () => {
  const days = {
    [addDays(T, -1)]: R({ kcal: 2000, foodDone: true }, { steps: 8000 }),
    [addDays(T, -2)]: R({ kcal: 600 }, { steps: 12000 }), // forgot to finish logging
    [addDays(T, -3)]: R({ kcal: 1900, foodDone: true }),
    [addDays(T, -4)]: R({ kcal: 2100, foodDone: true }, { steps: 10000 }),
  };
  assert.deepEqual(averageOf("calories", days, addDays(T, -6), T), { value: 2000, n: 3 });
  assert.deepEqual(averageOf("steps", days, addDays(T, -6), T), { value: 10000, n: 3 });
  assert.equal(averageOf("sleep", days, addDays(T, -6), T).value, null);
  delete days[addDays(T, -4)];
  assert.equal(averageOf("calories", days, addDays(T, -6), T).value, null, "2 complete days isn't enough");
  assert.equal(macroCalories(R()), null);
  assert.deepEqual(macroCalories(R({ protein: 150, carbs: 200, fat: 60 })), { protein: 600, carbs: 800, fat: 540, total: 1940 });
});

test("weight: 7-day average, trend and goal date only with enough behind them", () => {
  const days = {};
  for (let i = 0; i < 6; i++) days[addDays(T, -i * 2)] = R({}, { weight: 165 - (6 - i) * 0.1 });
  let s = weightStats(days, g, T);
  assert.equal(s.avg7 != null, true);
  assert.equal(s.perWeek, null, "6 weigh-ins isn't a trend");
  assert.equal(s.eta, null);
  for (let i = 0; i < 42; i++) days[addDays(T, -i)] = R({}, { weight: 170 - (41 - i) * 0.08 });
  s = weightStats(days, g, T);
  assert.ok(s.perWeek < -0.5 && s.perWeek > -0.6);
  assert.equal(s.direction, "down");
  assert.ok(s.eta?.date > T);
  assert.ok(Math.abs(s.change30 - -2.4) < 0.05);
  const gp = goalProgress(days, g, T);
  assert.equal(gp.basis, "7-day average");
  assert.equal(weeklyWeight({ [T]: R({}, { weight: 160 }) }, T).thisWeek, null, "one weigh-in isn't a weekly average");
});

test("fitness totals, streak and weekly review", () => {
  const w = (type, start, durationMin, kcal) => ({ type, start, durationMin, kcal, id: start });
  const days = {
    [T]: R({}, { exerciseMin: 50, activeKcal: 600, workouts: [w("Running", `${T}T07:00`, 40, 400)] }),
    [addDays(T, -1)]: R({}, { exerciseMin: 70, activeKcal: 700, workouts: [w("Traditional Strength Training", `${addDays(T, -1)}T18:00`, 60, 300)] }),
    [addDays(T, -2)]: R({}, { exerciseMin: 10, activeKcal: 300 }),
    [addDays(T, -3)]: R({}, { workouts: [w("Running", `${addDays(T, -3)}T07:00`, 30, 300)] }),
  };
  const t = fitnessTotals(days, addDays(T, -6), T);
  assert.deepEqual([t.workouts, t.exercise, t.exerciseDays, t.active], [3, 130, 3, 1600]);
  assert.equal(t.topType.type, "Running");
  assert.equal(Math.round(t.avgDuration), 43);
  assert.equal(workoutStreak(days, T), 2);
  const r = weeklyReview(days, g, T);
  assert.equal(r.from, "2026-09-21");
  assert.equal(r.workouts, 3);
});

test("insights stay silent without enough days on both sides", () => {
  const days = {};
  for (let i = 1; i <= 10; i++) days[addDays(T, -i)] = R({ bed: "23:00", wake: "07:00" }, { steps: 12000 });
  assert.deepEqual(insights(days, g, T), []);
  for (let i = 11; i <= 20; i++) days[addDays(T, -i)] = R({ bed: "01:30", wake: "06:30" }, { steps: 8000 });
  const found = insights(days, g, T);
  const s = found.find((x) => x.id === "sleep-steps");
  assert.ok(s, "found with 10 vs 10 days");
  assert.equal(s.nA, 10); assert.equal(s.nB, 10);
  assert.match(s.text, /50% higher/);
  assert.equal(MIN.insight, 7);
});

test("sample data: stored by source, today mid-way with protein and fiber to go", () => {
  const s = seed(T);
  assert.equal(Object.keys(s.days).length, 120);
  assert.equal(s.days[T].apple.kcal, undefined, "no food in the Apple bucket");
  const today = resolveDay(s.days[T]);
  // Today's food comes from the diary: breakfast, lunch and a shake so far.
  assert.equal(today.foods.length, 5);
  assert.equal(today.kcal, 1205);
  assert.equal(today.protein, 90.3);
  assert.equal(today.food.missing.fiber, 1, "the estimated hoagie lists no fiber");
  const sc = dayScore(today, s.goals, true);
  assert.ok(sc.pending >= 2 && sc.miss === 0);
  // Earlier days keep typed totals, like a log from before the diary.
  const old = resolveDay(s.days[Object.keys(s.days)[0]]);
  assert.equal(old.foods.length, 0);
});
