import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIngest, parseStamp, cleanDay } from "../server/apple.mjs";

test("Health Auto Export, aggregated by day", () => {
  const out = parseIngest({
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [
          { date: "2026-09-26 00:00:00 -0700", qty: 9812, source: "Apple Watch|iPhone" },
          { date: "2026-09-27 00:00:00 -0700", qty: 11240.4 },
        ] },
        { name: "weight_body_mass", units: "lb", data: [{ date: "2026-09-27 07:02:00 -0700", qty: 162.84 }] },
        { name: "dietary_energy", units: "kcal", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 1984 }] },
        { name: "protein", units: "g", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 158.2 }] },
        { name: "carbohydrates", units: "g", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 186 }] },
        { name: "total_fat", units: "g", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 64 }] },
        { name: "fiber", units: "g", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 24 }] },
        { name: "active_energy", units: "kcal", data: [{ date: "2026-09-27 00:00:00 -0700", qty: 640 }] },
        { name: "sleep_analysis", units: "hr", data: [{
          date: "2026-09-27 00:00:00 -0700", totalSleep: 7.5, inBed: 8.1,
          sleepStart: "2026-09-26 22:58:00 -0700", sleepEnd: "2026-09-27 07:00:00 -0700",
        }] },
      ],
      workouts: [{ name: "Traditional Strength Training", start: "2026-09-27 17:30:00 -0700", end: "2026-09-27 18:20:00 -0700" }],
    },
  });
  assert.deepEqual(out["2026-09-26"], { steps: 9812 });
  assert.deepEqual(out["2026-09-27"], {
    steps: 11240, kcal: 1984, protein: 158, carbs: 186, fat: 64, fiber: 24,
    weight: 162.8, bed: "22:58", wake: "07:00", sleepMins: 450, workout: true,
  });
});

test("Health Auto Export, per sample: sums, last weigh-in, kg and kJ", () => {
  const out = parseIngest({
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [
          { date: "2026-09-27 08:00:00 -0700", qty: 4000 },
          { date: "2026-09-27 12:00:00 -0700", qty: 5000 },
        ] },
        { name: "weight_body_mass", units: "kg", data: [
          { date: "2026-09-27 07:00:00 -0700", qty: 74 },
          { date: "2026-09-27 21:00:00 -0700", qty: 74.5 },
        ] },
        { name: "dietary_energy", units: "kJ", data: [{ date: "2026-09-27 12:00:00 -0700", qty: 8368 }] },
      ],
    },
  });
  assert.deepEqual(out["2026-09-27"], { steps: 9000, kcal: 2000, weight: 164.2 });
});

test("sleep stage samples group into the night they end", () => {
  const seg = (a, b, value) => ({ startDate: a, endDate: b, value, qty: 0 });
  const out = parseIngest({
    data: {
      metrics: [{ name: "sleep_analysis", units: "hr", data: [
        seg("2026-09-26 22:40:00 -0700", "2026-09-27 07:10:00 -0700", "In Bed"),
        seg("2026-09-26 23:05:00 -0700", "2026-09-27 02:00:00 -0700", "Core"),
        seg("2026-09-27 02:00:00 -0700", "2026-09-27 02:20:00 -0700", "Awake"),
        seg("2026-09-27 02:20:00 -0700", "2026-09-27 06:50:00 -0700", "REM"),
        seg("2026-09-27 15:00:00 -0700", "2026-09-27 15:40:00 -0700", "Core"), // nap
      ] }],
    },
  });
  assert.deepEqual(out, { "2026-09-27": { bed: "23:05", wake: "06:50", sleepMins: 445 } });
});

test("simple payloads from a Shortcut", () => {
  assert.deepEqual(parseIngest({ date: "2026-09-27", steps: "11,240", weight: 162.84, workout: "yes", junk: 1 }),
    { "2026-09-27": { steps: 11240, weight: 162.8, workout: true } });
  assert.deepEqual(parseIngest({ days: { "2026-09-26": { kcal: 1950 } } }), { "2026-09-26": { kcal: 1950 } });
  assert.deepEqual(parseIngest([{ date: "2026-09-25T08:00:00Z", fiber: 31 }]), { "2026-09-25": { fiber: 31 } });
  assert.throws(() => parseIngest({ hello: 1 }), /Unrecognised/);
});

test("cleaning keeps only known, valid fields", () => {
  assert.deepEqual(cleanDay({ kcal: -5, protein: "abc", bed: "7:05", wake: "25:99x", creatine: false, extra: "x" }),
    { bed: "07:05", creatine: false });
  assert.equal(parseStamp("2026-09-27 06:55:12 -0700").time, "06:55");
  assert.equal(parseStamp("2026-09-27 06:55:12 -0700").ms, Date.parse("2026-09-27T13:55:12Z"));
});
