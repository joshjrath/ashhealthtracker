// The food diary's arithmetic: parsing what you type, scaling servings, day totals, and the week.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseQuery, suggestEntry, nutrientsFor, unitsFor, gramsFor, dayFood, remainingText, weeklyBudget, mealForTime, fmtQty,
} from "../js/nutrition.js";
import { resolveDay, cleanManual, cleanFoodEntry, cleanApple } from "../js/sources.js";
import { foodStatus, DEFAULT_GOALS } from "../js/metrics.js";

test("parseQuery reads amounts, units and bare counts", () => {
  assert.deepEqual(parseQuery("6 oz chicken breast"), { raw: "6 oz chicken breast", qty: 6, unit: "oz", count: false, term: "chicken breast" });
  assert.deepEqual(parseQuery("2 eggs"), { raw: "2 eggs", qty: 2, unit: null, count: true, term: "egg" });
  assert.equal(parseQuery("1 cup white rice").unit, "cup");
  assert.equal(parseQuery("Wawa turkey hoagie").term, "Wawa turkey hoagie");
  assert.equal(parseQuery("Wawa turkey hoagie").qty, 1);
  assert.equal(parseQuery("1 1/2 cups oats").qty, 1.5);
  assert.equal(parseQuery("½ cup rice").qty, 0.5);
  assert.equal(parseQuery("150g greek yogurt").unit, "g");
  assert.equal(parseQuery("150g greek yogurt").qty, 150);
  assert.deepEqual([parseQuery("1 lb ground beef").qty, parseQuery("1 lb ground beef").unit], [16, "oz"]);
  assert.equal(parseQuery("two slices of toast").unit, "piece");
  assert.equal(parseQuery("two slices of toast").term, "toast");
  assert.equal(parseQuery("a banana").qty, 1);
});

const rice = {
  name: "Rice, white, cooked", serving: { label: "100 g", amount: 100, unit: "g", grams: 100 },
  nutrients: { kcal: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4 },
  portions: [{ label: "1 cup (158 g)", unit: "cup", amount: 1, grams: 158 }],
};
const shake = { name: "Specular Protein Shake", serving: { label: "1 shake", amount: 1, unit: "serving" }, nutrients: { kcal: 210, protein: 35, carbs: 12, fat: 4, fiber: 2 } };
const bread = { name: "Bread", serving: { label: "2 slices (56 g)", amount: 2, unit: "piece", grams: 56 }, nutrients: { kcal: 160, protein: 8, carbs: 28, fat: 2, fiber: null } };

test("scaling converts only what can be converted exactly", () => {
  assert.equal(nutrientsFor(rice, 1, "cup").kcal, 205);
  assert.equal(nutrientsFor(rice, 150, "g").kcal, 195);
  assert.equal(Math.round(gramsFor(rice, 2, "oz")), 57);
  assert.deepEqual(unitsFor(shake), ["serving"], "a shake with no weight can only be logged in shakes");
  assert.equal(nutrientsFor(shake, 1, "g"), null);
  assert.equal(nutrientsFor(shake, 2, "serving").protein, 70);
  // A serving that *is* two slices: one slice is half a serving.
  assert.equal(nutrientsFor(bread, 1, "piece").kcal, 80);
  assert.equal(nutrientsFor(bread, 1, "piece").fiber, null, "unknown stays unknown after scaling");
  assert.ok(unitsFor(bread).includes("g"));
  assert.ok(!unitsFor(bread).includes("cup"));
});

test("suggestions honour your unit when possible and say so when not", () => {
  const s = suggestEntry(rice, parseQuery("1 cup white rice"));
  assert.equal(s.unit, "cup");
  assert.equal(s.nutrients.kcal, 205);
  const t = suggestEntry(shake, parseQuery("12 oz protein shake"));
  assert.equal(t.unit, "serving");
  assert.equal(t.qty, 1);
  assert.match(t.note, /no oz measure/);
});

test("a day's food: diary entries plus quick-add totals, unknowns kept apart", () => {
  const manual = cleanManual({
    kcal: 300, protein: 20,
    foods: [
      { meal: "breakfast", name: "Yogurt", kcal: 60, protein: 11, carbs: 5, fat: 0, fiber: 0 },
      { meal: "lunch", name: "Hoagie", kcal: 680, protein: 38, carbs: 72, fat: 26, fiber: null },
      { meal: "nope", name: "Almonds", kcal: 164, protein: 6 },
      { name: "No calories" },
    ],
  });
  assert.equal(manual.foods.length, 3, "an entry without calories is refused");
  assert.equal(manual.foods[2].meal, "snacks");
  const f = dayFood(manual);
  assert.equal(f.totals.kcal, 1204);
  assert.equal(f.totals.protein, 75);
  assert.equal(f.byMeal.lunch.totals.kcal, 680);
  assert.equal(f.missing.fiber, 2);
  assert.equal(f.totals.fiber, 0, "fiber total only from entries that list it — and the count of those that don't");
  const d = resolveDay({ manual, apple: {} }, "2026-09-29");
  assert.equal(d.kcal, 1204);
  assert.equal(d.key, "2026-09-29");
  assert.equal(foodStatus(d), "partial", "entries alone never mean the day is complete");
  assert.equal(foodStatus(resolveDay({ manual: { ...manual, foodDone: true } })), "complete");
});

test("Apple Health nutrition never reaches the diary or its totals", () => {
  const apple = cleanApple({ kcal: 2400, protein: 180, foods: [{ name: "x", kcal: 1 }], steps: 9000 });
  assert.deepEqual(apple, { steps: 9000 });
  // Even a bucket that somehow held Apple food is never read for food.
  const d = resolveDay({ manual: {}, apple: { kcal: 2400, protein: 180, foods: [{ name: "x", kcal: 900 }] } });
  assert.equal(d.kcal, undefined);
  assert.equal(d.foods.length, 0);
});

test("entries are cleaned: unknown nutrients null, unsafe links dropped, time checked", () => {
  const e = cleanFoodEntry({ name: "Oats", kcal: "150", protein: "", source: { kind: "verified", url: "javascript:alert(1)" }, time: "25:00", unit: "bucket" });
  assert.equal(e.kcal, 150);
  assert.equal(e.protein, null);
  assert.equal(e.source.url, undefined);
  assert.equal(e.time, undefined);
  assert.equal(e.unit, "serving");
});

test("remaining never goes negative: above target says so plainly", () => {
  assert.equal(remainingText(143, 150, "g"), "7g remaining");
  assert.equal(remainingText(157, 150, "g"), "7g above target");
  assert.equal(remainingText(150, 150, "g"), "On target");
  assert.equal(remainingText(null, 150, "g"), "Nothing logged");
});

test("meal from time of day, and quantity wording", () => {
  assert.equal(mealForTime(new Date(2026, 8, 29, 7, 30)), "breakfast");
  assert.equal(mealForTime(new Date(2026, 8, 29, 12, 30)), "lunch");
  assert.equal(mealForTime(new Date(2026, 8, 29, 19, 0)), "dinner");
  assert.equal(fmtQty(1, "serving", { label: "1 shake" }), "1 shake");
  assert.equal(fmtQty(2, "piece"), "2 pieces");
});

/* ── the week ──────────────────────────────────────────────────────────── */

const G = { ...DEFAULT_GOALS };
const day = (kcal, done = true) => resolveDay({ manual: { kcal, foodDone: done } });
const budget = (days, today) => weeklyBudget(days, G, today, { foodStatus });

test("weekly target: 7 × daily by default, maintenance kept separate", () => {
  const w = budget({}, "2026-09-28"); // a Monday, nothing logged
  assert.equal(w.weekly, 14000);
  assert.equal(w.maintenance, 2500);
  assert.equal(w.daysLeft, 7);
  assert.equal(w.perDay, 2000);
  assert.equal(w.difference, null);
});

test("pace compares complete days only; unknown days count at the target, never as zero", () => {
  const days = { "2026-09-28": day(2100), "2026-09-29": day(900, false), "2026-09-30": day(1950) };
  const w = budget(days, "2026-10-01"); // Thursday
  assert.equal(w.knownDays, 2);
  assert.equal(w.knownTotal, 4050);
  assert.equal(w.knownPace, 4000);
  assert.equal(w.difference, 50);
  // Tuesday was half-logged: it's counted at the daily target, not at 900.
  assert.deepEqual(w.assumed, [{ key: "2026-09-29", counted: 2000, status: "partial" }]);
  assert.equal(w.consumedBefore, 6050);
  assert.equal(w.daysLeft, 4);
  assert.equal(Math.round(w.perDay), Math.round((14000 - 6050) / 4));
});

test("safety: after higher days the page never suggests eating below your range to make up", () => {
  const days = { "2026-09-28": day(3200), "2026-09-29": day(3100), "2026-09-30": day(3000), "2026-10-01": day(2900) };
  const w = budget(days, "2026-10-02");
  assert.ok(w.targetRemaining / w.daysLeft < G.kcalLow);
  assert.equal(w.perDay, null, "no low per-day number is shown");
  assert.equal(w.perDayState, "above");
  // And eating little early in the week doesn't turn into "extra" to spend.
  const low = { "2026-09-28": day(1200), "2026-09-29": day(1100) };
  const x = budget(low, "2026-09-30");
  assert.ok(x.perDay <= G.maintenance || x.perDay === null);
});
