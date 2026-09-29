import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIngest, parseStamp, parseWorkout } from "../server/apple.mjs";

const HAE = {
  data: {
    metrics: [
      { name: "step_count", units: "count", data: [
        { date: "2026-09-26 00:00:00 -0700", qty: 9812 },
        { date: "2026-09-27 00:00:00 -0700", qty: 11240.4 },
      ] },
      { name: "active_energy", units: "kcal", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 612.4 }] },
      { name: "apple_exercise_time", units: "min", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 64 }] },
      { name: "weight_body_mass", units: "lb", data: [{ date: "2026-09-27 07:02:00 -0700", qty: 162.84 }] },
      // Manual-only on this site: must never get through.
      { name: "dietary_energy", units: "kcal", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 1984 }] },
      { name: "protein", units: "g", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 158 }] },
      { name: "sleep_analysis", units: "hr", data: [{ date: "2026-09-27 00:00:00 -0700", totalSleep: 4.1,
        sleepStart: "2026-09-26 22:58:00 -0700", sleepEnd: "2026-09-27 07:00:00 -0700" }] },
      { name: "resting_heart_rate", units: "bpm", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 58 }] },
    ],
    workouts: [{
      id: "A1", name: "Traditional Strength Training",
      start: "2026-09-27 17:30:00 -0700", end: "2026-09-27 18:20:00 -0700", duration: 3000,
      activeEnergyBurned: { qty: 318.6, units: "kcal" }, avgHeartRate: { qty: 128, units: "bpm" },
      maxHeartRate: { qty: 161, units: "bpm" }, isIndoor: true,
    }],
  },
};

test("Health Auto Export: only fitness, steps, weight and workouts get in", () => {
  const { days, report } = parseIngest(HAE);
  assert.deepEqual(days["2026-09-26"], { steps: 9812 });
  const d = days["2026-09-27"];
  assert.equal(d.steps, 11240);
  assert.equal(d.activeKcal, 612);
  assert.equal(d.exerciseMin, 64);
  assert.equal(d.weight, 162.8);
  for (const f of ["kcal", "protein", "bed", "wake", "sleepMins"]) assert.equal(d[f], undefined, `${f} must not be imported`);
  assert.deepEqual(d.workouts, [{
    type: "Traditional Strength Training", start: "2026-09-27T17:30", end: "2026-09-27T18:20",
    durationMin: 50, kcal: 318.6, avgHR: 128, maxHR: 161, indoor: true, id: "2026-09-27T17:30|Traditional Strength Training",
  }]);
  assert.deepEqual(Object.keys(report.ignored).sort(), ["dietary_energy", "protein", "resting_heart_rate", "sleep_analysis"]);
  assert.deepEqual(Object.keys(report.accepted).sort(), ["active_energy", "apple_exercise_time", "step_count", "weight_body_mass"]);
  assert.equal(report.workouts, 1);
  assert.equal(report.workoutFields.avgHeartRate, 1);
});

test("per-sample exports sum, keep the last weigh-in, convert kg and kJ", () => {
  const { days } = parseIngest({ data: { metrics: [
    { name: "step_count", units: "count", data: [{ date: "2026-09-27 08:00:00 -0700", qty: 4000 }, { date: "2026-09-27 12:00:00 -0700", qty: 5000 }] },
    { name: "weight_body_mass", units: "kg", data: [{ date: "2026-09-27 07:00:00 -0700", qty: 74 }, { date: "2026-09-27 21:00:00 -0700", qty: 74.5 }] },
    { name: "active_energy", units: "kJ", data: [{ date: "2026-09-27 12:00:00 -0700", qty: 2092 }] },
  ] } });
  assert.deepEqual(days["2026-09-27"], { steps: 9000, weight: 164.2, activeKcal: 500 });
});

test("workouts: duration from times, or seconds; energy from arrays; repeats collapse", () => {
  assert.equal(parseWorkout({ name: "Run", start: "2026-09-27 06:00:00 -0700", duration: 1800 }).durationMin, 30);
  assert.equal(parseWorkout({ name: "Run", start: "2026-09-27 06:00:00 -0700", activeEnergy: [{ qty: 100, units: "kcal" }, { qty: 50, units: "kcal" }] }).kcal, 150);
  const w = { name: "Walk", start: "2026-09-27 12:00:00 -0700", end: "2026-09-27 12:30:00 -0700" };
  const { days } = parseIngest({ data: { workouts: [w, w] } });
  assert.equal(days["2026-09-27"].workouts.length, 1);
});

test("simple payloads: fitness allowed, food and sleep reported and dropped", () => {
  const { days, report } = parseIngest({ date: "2026-09-27", steps: "11,240", activeKcal: 600, exercise: 61, kcal: 1900, bed: "23:00", wake: "07:00", workout: "yes" });
  assert.deepEqual(days, { "2026-09-27": { steps: 11240, activeKcal: 600, exerciseMin: 61, workoutFlag: true } });
  assert.deepEqual(Object.keys(report.ignored).sort(), ["bed", "kcal", "wake"]);
  assert.deepEqual(parseIngest([{ date: "2026-09-25T08:00:00Z", steps: 31 }]).days, { "2026-09-25": { steps: 31 } });
  assert.throws(() => parseIngest({ hello: 1 }), /Unrecognised/);
});

test("timestamps keep the phone's wall clock", () => {
  assert.equal(parseStamp("2026-09-27 06:55:12 -0700").time, "06:55");
  assert.equal(parseStamp("2026-09-27 06:55:12 -0700").ms, Date.parse("2026-09-27T13:55:12Z"));
});
