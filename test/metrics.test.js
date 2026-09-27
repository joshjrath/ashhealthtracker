import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOALS, addDays, mondayOf, nightOffset, sleepMinutes, goalMet, dayScore,
  streak, average, weightSeries, goalProgress, weeklyWeight, macroCalories, fmtClock, fmtDur,
} from "../js/metrics.js";
import { seed } from "../js/store.js";

const g = DEFAULT_GOALS;

test("dates step across month and year ends", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(mondayOf("2026-09-27"), "2026-09-21"); // a Sunday
  assert.equal(mondayOf("2026-09-21"), "2026-09-21");
});

test("sleep spans midnight and reads on a 20:00 clock", () => {
  assert.equal(nightOffset("23:00"), 180);
  assert.equal(nightOffset("00:30"), 270);
  assert.equal(nightOffset("21:15"), 75);
  assert.equal(sleepMinutes({ bed: "23:15", wake: "07:00" }), 465);
  assert.equal(sleepMinutes({ bed: "00:40", wake: "08:10" }), 450);
  assert.equal(sleepMinutes({ bed: "23:15" }), null);
  assert.equal(fmtClock(180), "11:00p");
  assert.equal(fmtClock(660), "7:00a");
  assert.equal(fmtDur(482), "8h 02m");
});

test("calories count only inside the success zone", () => {
  assert.equal(goalMet("calories", { kcal: 1984 }, g), true);
  assert.equal(goalMet("calories", { kcal: 1900 }, g), true);
  assert.equal(goalMet("calories", { kcal: 2101 }, g), false);
  assert.equal(goalMet("calories", { kcal: 1850 }, g), false);
  assert.equal(goalMet("calories", {}, g), null);
});

test("the daily score explains itself", () => {
  const day = { kcal: 1984, protein: 158, fiber: 24, steps: 11240, bed: "22:58", wake: "07:00", workout: true, creatine: true };
  const s = dayScore(day, g);
  assert.equal(s.met, 6);
  assert.equal(s.total, 7);
  assert.equal(Math.round(s.pct * 100), 86);
  assert.deepEqual(s.detail.filter((x) => !x.met).map((x) => x.id), ["fiber"]);
  assert.equal(dayScore(day, { ...g, tracked: ["calories", "fiber"] }).total, 2);
});

test("streaks survive an unfinished today and remember the best run", () => {
  const days = {
    "2026-09-20": { creatine: true },
    "2026-09-21": { creatine: true },
    "2026-09-22": { creatine: true },
    "2026-09-23": { creatine: false },
    "2026-09-24": { creatine: true },
    "2026-09-25": { creatine: true },
    "2026-09-26": { creatine: true },
    "2026-09-27": {},
  };
  assert.deepEqual(streak("creatine", days, g, "2026-09-27"), { current: 3, best: 3 });
  days["2026-09-27"].creatine = true;
  assert.deepEqual(streak("creatine", days, g, "2026-09-27"), { current: 4, best: 4 });
  delete days["2026-09-25"]; // a gap breaks the run
  assert.deepEqual(streak("creatine", days, g, "2026-09-27"), { current: 2, best: 3 });
});

test("weight progress and weekly change", () => {
  const days = {};
  for (let i = 0; i < 14; i++) days[addDays("2026-09-14", i)] = { weight: 164 - i * 0.1 };
  const p = goalProgress(days, g, "2026-09-27");
  assert.equal(+p.current.toFixed(1), 162.7);
  assert.equal(+p.lost.toFixed(1), 9.6);
  assert.equal(+p.remaining.toFixed(1), 17.7);
  assert.equal(Math.round(p.pct * 1000), Math.round((9.6 / 27.3) * 1000));
  const w = weeklyWeight(days, "2026-09-27");
  assert.equal(+w.change.toFixed(2), -0.7);
  assert.equal(w.weeks.length, 8);
  const s = weightSeries(days, "2026-09-14", "2026-09-15");
  assert.equal(s[0].avg, null); // one reading isn't a trend
  assert.equal(+s[1].avg.toFixed(2), 163.95);
});

test("averages skip unlogged days; macros convert to calories", () => {
  const days = { "2026-09-01": { steps: 8000 }, "2026-09-03": { steps: 12000 } };
  assert.equal(average("steps", days, "2026-09-01", "2026-09-03"), 10000);
  assert.deepEqual(macroCalories({ protein: 150, carbs: 200, fat: 60 }), { protein: 600, carbs: 800, fat: 540, total: 1940 });
});

test("sample data ends today at 6/7 with a 13-day protein streak", () => {
  const s = seed("2026-09-27");
  const keys = Object.keys(s.days).sort();
  assert.equal(keys.length, 120);
  assert.equal(keys.at(-1), "2026-09-27");
  assert.equal(s.days[keys[0]].weight, 172.3);
  assert.equal(dayScore(s.days["2026-09-27"], s.goals).met, 6);
  assert.equal(streak("protein", s.days, s.goals, "2026-09-27").current, 13);
});
