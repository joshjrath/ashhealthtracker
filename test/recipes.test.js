// Recipes: per 100 g from the cooked weight, batches that keep their own
// numbers, rescaling looked-up ingredients, the calculator, grocery lists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanRecipe, cleanCombo, per100, portion, versionTotals, currentVersion, scaleIngredient, calcTotals, portionEntry, groceryList, amountText, proteinEfficiency, EXAMPLE_RECIPES, categoryOf } from "../js/recipes.js";
import { cleanFoodEntry } from "../js/sources.js";
import { openStore } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";

const pot = (cookedWeight, extra = {}) => cleanRecipe({
  name: "Test chili", defaultPortion: 300,
  versions: [{ id: "v1", label: "Batch 1", cookedWeight, ingredients: [
    { name: "Ground turkey", amount: 500, unit: "g", kcal: 750, protein: 95, carbs: 0, fat: 40, fiber: 0 },
    { name: "Kidney beans", amount: 400, unit: "g", kcal: 400, protein: 28, carbs: 64, fat: 2, fiber: 24 },
  ] }], ...extra,
});

test("per 100 g = totals ÷ cooked weight × 100, and a portion is (totals ÷ cooked) × grams", () => {
  const r = pot(1150);
  const v = currentVersion(r);
  assert.deepEqual(versionTotals(v).kcal, 1150);
  assert.equal(Math.round(per100(v).kcal), 100);
  assert.equal(Math.round(portion(v, 250).kcal), 250);
  assert.ok(Math.abs(portion(v, 250).protein - (123 / 1150) * 250) < 1e-9);
  assert.ok(Math.abs(proteinEfficiency(per100(v)) - 1150 / 123) < 1e-9);
});

test("cooking water changes the weight, not the calories: the whole pot is the same either way", () => {
  const wet = currentVersion(pot(1400)), dry = currentVersion(pot(900));
  assert.ok(per100(dry).kcal > per100(wet).kcal);
  assert.equal(Math.round(portion(wet, 1400).kcal), Math.round(portion(dry, 900).kcal));
});

test("batches keep their own numbers; logging copies the current batch's", () => {
  const r = cleanRecipe({ ...pot(1150), versions: [...pot(1150).versions, { id: "v2", label: "Batch 2", cookedWeight: 1150, ingredients: [{ name: "Ground turkey", amount: 700, unit: "g", kcal: 1050, protein: 133 }] }], current: "v2" });
  assert.equal(r.versions.length, 2);
  assert.equal(currentVersion(r).label, "Batch 2");
  assert.equal(Math.round(per100(currentVersion(r, "v1")).kcal), 100);
  const e = portionEntry(r, 200, "dinner");
  assert.equal(e.kcal, Math.round((1050 / 1150) * 200));
  assert.equal(e.unit, "g");
  assert.equal(e.qty, 200);
  assert.match(e.source.ref, /:v2$/);
  assert.ok(cleanFoodEntry(e), "the diary accepts it");
});

test("examples are marked as estimates and cleaned without loss", () => {
  for (const ex of EXAMPLE_RECIPES) {
    const r = cleanRecipe(ex);
    assert.equal(r.example, true);
    assert.equal(r.versions.length, ex.versions.length);
    assert.equal(portionEntry(r, 100, "lunch").source.kind, "estimate");
  }
  const mac = cleanRecipe(EXAMPLE_RECIPES[0]);
  const v12 = currentVersion(mac, "v_mac_12"), v14 = currentVersion(mac, "v_mac_14");
  assert.ok(versionTotals(v14).kcal > versionTotals(v12).kcal, "14 oz of pasta has more in the pot");
  assert.ok(Math.abs(per100(v12).kcal - 195.5) < 1, String(per100(v12).kcal));
});

test("a looked-up ingredient rescales with its amount and unit", () => {
  const basis = { name: "Rice, dry", serving: { label: "100 g", amount: 100, unit: "g", grams: 100 }, nutrients: { kcal: 360, protein: 7, carbs: 79, fat: 0.6, fiber: 1.3 }, portions: [{ label: "1 cup", unit: "cup", amount: 1, grams: 185 }] };
  assert.equal(scaleIngredient({ amount: 200, unit: "g", basis }).kcal, 720);
  assert.equal(scaleIngredient({ amount: 1, unit: "lb", basis }).kcal, Math.round(360 * 4.5359237));
  assert.equal(scaleIngredient({ amount: 2, unit: "cup", basis }).kcal, Math.round(360 * 3.7));
  assert.equal(scaleIngredient({ amount: 1, unit: "piece", basis }), null, "no piece weight known");
});

test("the calculator adds portions up", () => {
  const a = pot(1150), b = pot(1150, { id: "b" });
  const t = calcTotals([{ recipe: a, grams: 100 }, { recipe: b, grams: 300 }]);
  assert.equal(Math.round(t.total.kcal), 400);
  assert.equal(t.rows.length, 2);
});

test("grocery list: combines the same ingredient, converts units, subtracts what you have, groups by aisle", () => {
  const a = cleanRecipe({ name: "A", versions: [{ cookedWeight: 1000, ingredients: [
    { name: "Chicken breast, raw", amount: 1, unit: "lb", kcal: 545 }, { name: "Onion", amount: 1, unit: "piece", kcal: 44 }, { name: "Olive oil", amount: 1, unit: "tbsp", kcal: 119 } ] }] });
  const b = cleanRecipe({ name: "B", versions: [{ cookedWeight: 1000, ingredients: [
    { name: "chicken breast", amount: 8, unit: "oz", kcal: 272 }, { name: "Olive oil", amount: 2, unit: "tbsp", kcal: 238 } ] }] });
  const list = groceryList([{ recipe: a, batches: 2 }, { recipe: b, batches: 1 }], { onion: 2 });
  const flat = list.flatMap((c) => c.items.map((x) => ({ ...x, category: c.category })));
  const chicken = flat.find((x) => x.key === "chicken breast");
  assert.ok(Math.abs(chicken.need - (2 * 453.59237 + 8 * 28.349523125)) < 0.01);
  assert.equal(chicken.category, "Meat & seafood");
  assert.equal(chicken.text, "2 lb 8 oz (1134 g)");
  assert.equal(flat.find((x) => x.key === "onion").done, true, "two on hand covers two");
  assert.equal(flat.find((x) => x.key === "olive oil").text, "0.25 cup");
  assert.equal(list[0].category, "Produce");
  assert.equal(categoryOf("Black pepper"), "Spices, sauces & oils");
  assert.equal(categoryOf("Red bell pepper"), "Produce");
  assert.equal(amountText(80 * 16 * 28.349523125, "g"), "80 lb (36287 g)");
});

test("combinations need a name and real portions", () => {
  assert.equal(cleanCombo({ name: "", parts: [{ recipeId: "x", grams: 100 }] }), null);
  assert.deepEqual(cleanCombo({ name: "Dinner", parts: [{ recipeId: "x", grams: 250.4 }, { recipeId: "", grams: 1 }] }).parts, [{ recipeId: "x", grams: 250 }]);
});

/* the server seeds the two examples once */
let dir, store, server, base;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ash-rec-"));
  store = await openStore({ file: join(dir, "db.json") });
  server = await createApp({ store, root: join(dirname(fileURLToPath(import.meta.url)), ".."), notifySchedule: false });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });

test("the example recipes are added once, and stay gone once deleted", async () => {
  const s1 = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(s1.library.recipes.map((r) => r.name).sort(), ["Buffalo Chicken Mac & Cheese", "Spicy Chicken Tikka"]);
  for (const r of s1.library.recipes) assert.equal((await fetch(`${base}/api/items/recipe/${r.id}`, { method: "DELETE" })).status, 200);
  const s2 = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s2.library.recipes.length, 0);
  const put = await fetch(`${base}/api/items/recipe/rec_x`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(pot(1000)) });
  assert.equal(put.status, 200);
  const s3 = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s3.library.recipes[0].versions[0].cookedWeight, 1000);
});
