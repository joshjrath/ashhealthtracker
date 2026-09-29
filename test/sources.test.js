import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDay, migrateDay, cleanManual, cleanApple, reviewItems, applyReview, RULES, MANUAL_ONLY } from "../js/sources.js";

test("manual-only metrics never read Apple or unconfirmed legacy values", () => {
  for (const f of ["kcal", "protein", "carbs", "fat", "fiber", "bed", "wake", "creatine"]) {
    assert.ok(MANUAL_ONLY.includes(f), f);
    assert.deepEqual(RULES[f], ["manual"]);
  }
  const d = resolveDay({ manual: {}, apple: { kcal: 1984, protein: 158, bed: "23:00", wake: "04:00" }, legacy: { kcal: 2400, fiber: 12 } });
  for (const f of ["kcal", "protein", "fiber", "bed", "wake"]) assert.equal(d[f], undefined, f);
});

test("where both are allowed, what you typed wins, then Apple", () => {
  const d = resolveDay({ manual: { weight: 161.0 }, apple: { weight: 162.4, steps: 9000, activeKcal: 600 }, legacy: { steps: 100 } });
  assert.equal(d.weight, 161.0); assert.equal(d.src.weight, "manual");
  assert.equal(d.steps, 9000); assert.equal(d.src.steps, "apple");
  assert.equal(d.activeKcal, 600);
  assert.equal(d.appleFitness, true);
});

test("workouts come from Apple's list, a manual tick, or legacy yes/no", () => {
  assert.equal(resolveDay({ apple: { workouts: [{ type: "Run", start: "2026-09-27T06:00", id: "x" }] } }).workout, true);
  assert.equal(resolveDay({ manual: { workout: false }, apple: {} }).workout, false);
  assert.equal(resolveDay({ manual: {}, apple: {} }).workout, undefined);
});

test("the doors only open for each source's own fields", () => {
  assert.deepEqual(cleanApple({ steps: 10, kcal: 2000, protein: 150, bed: "23:00", sleepMins: 400, activeKcal: "612.4" }), { steps: 10, activeKcal: 612 });
  assert.deepEqual(cleanManual({ kcal: "1,950", foodDone: "true", bed: "23:10", junk: 1, protein: -3 }), { kcal: 1950, foodDone: true });
  assert.deepEqual(cleanManual({ bed: "23:10", wake: "06:50" }), { bed: "23:10", wake: "06:50" });
});

test("migration: food and sleep go to legacy; Apple sleep is recognised; creatine is yours", () => {
  const m = migrateDay({ kcal: 1900, protein: 150, steps: 8000, bed: "23:00", wake: "07:00", sleepMins: 291, creatine: true, weight: 163 });
  assert.deepEqual(m.manual, { creatine: true });
  assert.deepEqual(m.legacy.appleSleep, { bed: "23:00", wake: "07:00", sleepMins: 291 });
  assert.equal(m.legacy.bed, undefined);
  assert.equal(m.legacy.kcal, 1900);
  assert.equal(m.legacy.savedByHand, true);
  const d = resolveDay(m);
  assert.equal(d.kcal, undefined, "unreviewed food stays out");
  assert.equal(d.steps, 8000, "steps may come from anywhere");
  assert.equal(d.weight, 163);
});

test("review: keep moves food into manual as a complete log; reject sets it aside", () => {
  const raw = { "2026-09-01": migrateDay({ kcal: 1900, protein: 150, bed: "23:00", wake: "07:00", creatine: true }),
    "2026-09-02": migrateDay({ kcal: 3100 }), "2026-09-03": migrateDay({ steps: 5 }) };
  const items = reviewItems(raw);
  assert.deepEqual(items.map((x) => x.key), ["2026-09-02", "2026-09-01"]);
  assert.equal(items[1].savedByHand, true);
  const kept = applyReview(raw["2026-09-01"], true);
  assert.deepEqual(kept.manual, { kcal: 1900, protein: 150, bed: "23:00", wake: "07:00", creatine: true, foodDone: true });
  assert.equal(resolveDay(kept).kcal, 1900);
  const gone = applyReview(raw["2026-09-02"], false);
  assert.deepEqual(gone.legacy.rejected, { kcal: 3100 });
  assert.equal(resolveDay(gone).kcal, undefined);
  assert.equal(reviewItems({ x: gone }).length, 0);
});
