// Strength analysis: classification, working sets, trends that ignore one bad
// day, double progression, an index that survives swapping exercises, and
// fractional volume counting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDay } from "../js/sources.js";
import { DEFAULT_GOALS, addDays } from "../js/metrics.js";
import { classify, cleanExerciseGroups, workingSets, sessionStat, exerciseHistory, exerciseTrend, nextStep, strengthIndex, muscleVolume, strengthAnalysis, sessionDay, zoneOf } from "../js/liftstats.js";
import { RULES } from "../server/notify-rules.mjs";
import { isLiftDay, weekStatus, cleanPlan } from "../js/training.js";

const TODAY = "2026-11-23"; // a Monday
const sets = (n, reps, weight, unit = "lb") => Array.from({ length: n }, () => ({ reps, weight, unit }));
const day = (k, lifts, extra = {}) => resolveDay({ manual: { lifts: lifts.map((l, i) => ({ id: `${k}-${i}`, ...l })), ...extra } }, k);

/** One lift every `every` days for `n` sessions ending today, weight from fn(i). */
function series(exercise, n, every, fn) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const k = addDays(TODAY, -(n - 1 - i) * every);
    out[k] = { exercise, sets: fn(i) };
  }
  return out;
}
function daysFrom(...lists) {
  const by = {};
  for (const l of lists) for (const [k, lift] of Object.entries(l)) (by[k] ||= []).push(lift);
  return Object.fromEntries(Object.entries(by).map(([k, lifts]) => [k, day(k, lifts)]));
}

test("common lifts map to muscles, with helpers at half; your own choice wins", () => {
  assert.deepEqual(classify("Bench Press").groups, { chest: 1, triceps: 0.5, shoulders: 0.5 });
  assert.equal(classify("Lat pulldown").day, "pull");
  assert.equal(classify("Lateral raise").day, "push");
  assert.deepEqual(classify("Leg curl").groups, { hamstrings: 1 });
  assert.deepEqual(classify("Incline dumbbell curl").groups, { biceps: 1 });
  assert.equal(classify("Romanian deadlift").day, "legs");
  assert.equal(classify("Mystery machine").known, false);
  assert.deepEqual(classify("Mystery machine", { "mystery machine": "back" }).groups, { back: 1 });
  assert.deepEqual(classify("Bench press", { "bench press": "none" }).groups, {});
  assert.deepEqual(cleanExerciseGroups({ "  Bench   Press ": "chest", hack: "elbows", x: "none", y: 3 }), { "bench press": "chest", x: "none" });
});

test("warm-ups (under 60% of the top weight) aren't working sets", () => {
  const w = workingSets([{ reps: 10, weight: 45, unit: "lb" }, { reps: 5, weight: 95, unit: "lb" }, { reps: 8, weight: 135, unit: "lb" }, { reps: 8, weight: 135, unit: "lb" }]);
  assert.deepEqual(w.map((s) => s.weight), [95, 135, 135]);
});

test("e1RM by Epley, kg converted; bodyweight moves tracked by reps", () => {
  const s = sessionStat({ exercise: "Bench", sets: sets(3, 10, 100) });
  assert.ok(Math.abs(s.value - 133.33) < 0.01);
  const kg = sessionStat({ exercise: "Bench", sets: sets(1, 5, 100, "kg") });
  assert.ok(Math.abs(kg.value - 100 * 2.2046226218 * (1 + 5 / 30)) < 0.01);
  const bw = sessionStat({ exercise: "Pull-up", sets: [{ reps: 12, weight: 0, unit: "lb" }, { reps: 9, weight: 0, unit: "lb" }] });
  assert.equal(bw.metric, "reps");
  assert.equal(bw.value, 12);
  assert.equal(bw.dropoff, 3);
});

test("trend statuses: climbing → improving, flat → stable, few sessions → not enough data", () => {
  const up = exerciseHistory(daysFrom(series("Bench press", 12, 3, (i) => sets(3, 8, 135 + i * 2.5))), TODAY);
  assert.equal(exerciseTrend(up["bench press"], TODAY).status, "improving");
  const flat = exerciseHistory(daysFrom(series("Bench press", 12, 3, () => sets(3, 8, 155))), TODAY);
  assert.equal(exerciseTrend(flat["bench press"], TODAY).status, "stable");
  const few = exerciseHistory(daysFrom(series("Bench press", 2, 5, () => sets(3, 8, 155))), TODAY);
  assert.equal(exerciseTrend(few["bench press"], TODAY).status, "insufficient");
  const old = exerciseHistory(daysFrom(series("Bench press", 8, 3, () => sets(3, 8, 155))), addDays(TODAY, 30));
  const t = exerciseTrend(old["bench press"], addDays(TODAY, 30));
  assert.equal(t.status, "insufficient");
  assert.equal(t.dormant, true);
});

test("one bad session is never a decline; a drop that lasts is", () => {
  const oneBad = exerciseHistory(daysFrom(series("Squat", 12, 3, (i) => sets(3, i === 11 ? 4 : 6, 225))), TODAY);
  assert.notEqual(exerciseTrend(oneBad.squat, TODAY).status, "declining");
  const slide = exerciseHistory(daysFrom(series("Squat", 12, 3, (i) => sets(3, 6, i < 6 ? 225 : 225 - (i - 5) * 7.5))), TODAY);
  assert.equal(exerciseTrend(slide.squat, TODAY).status, "declining");
});

test("double progression: same reps twice at a weight → add the smallest jump; short sets → build reps", () => {
  const go = (name, fn, n = 6) => {
    const ex = exerciseHistory(daysFrom(series(name, n, 4, fn)), TODAY)[name.toLowerCase()];
    return nextStep(ex, exerciseTrend(ex, TODAY));
  };
  const bench = go("Bench press", () => sets(3, 8, 135));
  assert.equal(bench.kind, "add-weight");
  assert.equal(bench.inc, 5);
  const squat = go("Back squat", () => sets(3, 8, 225));
  assert.equal(squat.inc, 10, "lower body jumps 10 lb");
  const db = go("Dumbbell curl", () => sets(3, 12, 30));
  assert.equal(db.inc, 5);
  const short = go("Bench press", (i) => (i === 5 ? [{ reps: 8, weight: 140, unit: "lb" }, { reps: 7, weight: 140, unit: "lb" }, { reps: 6, weight: 140, unit: "lb" }] : sets(3, 8, 135)));
  assert.equal(short.kind, "add-reps");
  assert.match(short.text, /2 sets were short/);
  const pullups = go("Pull-up", () => sets(3, 10, 0));
  assert.equal(pullups.kind, "reps");
});

test("the strength index doesn't jump when you swap one exercise for another", () => {
  const lifts = {};
  for (let w = 15; w >= 0; w--) {
    const k = addDays(TODAY, -7 * w - 1); // Sundays
    lifts[k] = w >= 8 ? { exercise: "Bench press", sets: sets(3, 8, 185) } : { exercise: "Dumbbell press", sets: sets(3, 10, 70) };
  }
  const idx = strengthIndex(exerciseHistory(daysFrom(lifts), TODAY), TODAY).filter((w) => w.all != null);
  assert.ok(idx.length >= 15);
  assert.ok(idx.every((w) => Math.abs(w.all - 100) < 1e-9), idx.map((w) => w.all.toFixed(1)).join(" "));
});

test("weekly sets per muscle count helpers at half, and warm-ups not at all", () => {
  const mon = "2026-11-16";
  const days = { [mon]: day(mon, [{ exercise: "Bench press", sets: [{ reps: 10, weight: 45, unit: "lb" }, ...sets(3, 8, 135)] }, { exercise: "Lat pulldown", sets: sets(4, 10, 120) }]) };
  const v = muscleVolume(days, TODAY);
  assert.equal(v.avg.sets.chest, 3);
  assert.equal(v.avg.sets.triceps, 1.5);
  assert.equal(v.avg.sets.back, 4);
  assert.equal(v.avg.sets.biceps, 2);
  assert.equal(v.avg.freq.chest, 1);
  assert.equal(v.avg.freq.triceps, 0, "half-credit work isn't a direct-work day");
  assert.equal(zoneOf(0).id, "none"); assert.equal(zoneOf(3).id, "low"); assert.equal(zoneOf(4).id, "keep"); assert.equal(zoneOf(12).id, "grow"); assert.equal(zoneOf(24).id, "high");
  assert.equal(sessionDay(days[mon].lifts), "pull", "more pulling sets than pushing");
});

test("overall status needs several lifts; two lifts sliding makes it declining; the calorie suggestion then eases off", async () => {
  const g = { ...DEFAULT_GOALS };
  assert.equal(strengthAnalysis({}, g, TODAY).status, "insufficient");
  const slide = (name) => series(name, 12, 3, (i) => sets(3, 6, i < 6 ? 225 : 225 - (i - 5) * 7.5));
  const days = daysFrom(slide("Back squat"), slide("Bench press"), series("Barbell row", 12, 3, () => sets(3, 8, 155)));
  const a = strengthAnalysis(days, g, TODAY);
  assert.equal(a.status, "declining");
  assert.equal(a.counts.declining, 2);
  assert.ok(a.preservation.notes.some((n) => n.kind === "concern"));
  const { calorieAdvice } = await import("../js/energy.js");
  const energy = { estimate: 2400, confidence: "established", perLb: 2800, bodyFat: { pct: 18, kind: "settings" } };
  const base = calorieAdvice({ days: {}, g: { ...g, kcalTarget: 2000 }, today: TODAY, energy, plat: null, phase: "cut", weight: 180 });
  const easy = calorieAdvice({ days: {}, g: { ...g, kcalTarget: 2000 }, today: TODAY, energy, plat: null, phase: "cut", weight: 180, strength: { status: "declining" } });
  assert.ok(easy.target > base.target, `${easy.target} vs ${base.target}`);
});

test("the decline notification only speaks on a sustained decline, and steps back when it ends", () => {
  const rule = RULES.find((r) => r.id === "fitness.decline");
  const out = [], cancelled = [];
  const n = { emit: (x) => out.push(x), cancel: (k) => cancelled.push(k) };
  rule.run({ strength: { status: "stable" }, today: TODAY }, n);
  assert.equal(out.length, 0);
  assert.deepEqual(cancelled, ["fit:decline"]);
  const slide = (name) => series(name, 12, 3, (i) => sets(3, 6, i < 6 ? 225 : 225 - (i - 5) * 7.5));
  const a = strengthAnalysis(daysFrom(slide("Back squat"), slide("Bench press")), DEFAULT_GOALS, TODAY);
  rule.run({ strength: a, today: TODAY }, n);
  assert.equal(out.length, 1);
  assert.match(out[0].body, /Back squat|Bench press/);
});

test("push / pull / legs plan days count as strength days", () => {
  assert.ok(isLiftDay("push") && isLiftDay("legs") && !isLiftDay("cardio"));
  const plan = cleanPlan({ days: { mon: "push", tue: "pull", wed: "legs", thu: "push", fri: "pull", sat: "legs", sun: "rest" } });
  assert.equal(plan.days.mon, "push");
  const mon = "2026-11-16";
  const days = {};
  for (let i = 0; i < 6; i++) { const k = addDays(mon, i); days[k] = day(k, [{ exercise: "Bench press", sets: sets(3, 8, 135) }]); }
  const w = weekStatus(days, plan, mon, TODAY);
  assert.equal(w.need.strength, 6);
  assert.equal(w.status, "hit");
});
