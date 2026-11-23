/* ──────────────────────────────────────────────────────────────────────────
   Recipes, the portion calculator's arithmetic, saved combinations and
   grocery lists. Shared by the page and the server (which cleans every
   recipe and combination before storing it).

   RECIPE — { id, name, favorite, archived, example, defaultPortion (g),
     versions: [{ id, label, createdAt, ingredients, cookedWeight,
                  cookedEstimate, per100?, notes }], current, uses, createdAt }
   Each version is one batch: its own ingredients and final cooked weight,
   so a 12 oz-pasta batch and a 14 oz one each keep their own numbers.
   A version without ingredients can carry per-100 g values directly.

   COOKED WEIGHT — the whole pot after cooking. Water lost or gained
   changes the weight, not the calories, so
       per 100 g = recipe totals ÷ cooked weight × 100
       a portion = recipe totals ÷ cooked weight × portion grams.

   INGREDIENT — { name, amount, unit, state: raw|cooked|dry, kcal, protein,
     carbs, fat, fiber, estimate?, basis? }. `basis` is the food it was
   looked up from (serving, nutrients, portions, source), so changing the
   amount rescales it; typing the numbers yourself drops the basis.

   Diary entries copy a portion's numbers when you log them, so editing a
   recipe later never changes what you already logged.
   ────────────────────────────────────────────────────────────────────────── */
import { NUTRIENTS, nutrientsFor, gramsFor } from "./nutrition.js";
import { cleanServing, cleanSource, num } from "./sources.js";

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
const nid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const r1 = (v) => Math.round(v * 10) / 10;

export const ING_UNITS = ["g", "oz", "lb", "cup", "tbsp", "tsp", "ml", "piece"];
export const ING_STATES = ["raw", "cooked", "dry"];
const GRAMS = { g: 1, oz: 28.349523125, lb: 453.59237 };
const ML = { ml: 1, tsp: 4.92892, tbsp: 14.7868, cup: 236.588 };

function cleanNum(v, max = 100000) {
  const n = num(v);
  return n === undefined || n < 0 || n > max ? null : r1(n);
}

function cleanBasis(raw) {
  if (!raw || typeof raw !== "object" || !raw.nutrients) return undefined;
  const nutrients = {};
  for (const n of NUTRIENTS) nutrients[n] = cleanNum(raw.nutrients[n]);
  if (nutrients.kcal == null) return undefined;
  const portions = (Array.isArray(raw.portions) ? raw.portions : []).slice(0, 12).map((p) => {
    const grams = num(p?.grams);
    return grams > 0 && typeof p.unit === "string" ? { label: str(p.label, 40) || p.unit, unit: p.unit, amount: num(p.amount) || 1, grams: r1(grams) } : null;
  }).filter(Boolean);
  return { name: str(raw.name, 120), serving: cleanServing(raw.serving), nutrients, portions, source: cleanSource(raw.source) };
}

export function cleanIngredient(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 100);
  if (!name) return null;
  const out = {
    name,
    amount: cleanNum(raw.amount) ?? 0,
    unit: ING_UNITS.includes(raw.unit) ? raw.unit : "g",
    state: ING_STATES.includes(raw.state) ? raw.state : "raw",
  };
  for (const n of NUTRIENTS) out[n] = cleanNum(raw[n]);
  if (out.kcal == null) out.kcal = 0;
  if (raw.estimate === true) out.estimate = true;
  const basis = cleanBasis(raw.basis);
  if (basis) out.basis = basis;
  const cat = str(raw.category, 30);
  if (cat) out.category = cat;
  return out;
}

function cleanVersion(raw, i) {
  if (!raw || typeof raw !== "object") return null;
  const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : []).slice(0, 60).map(cleanIngredient).filter(Boolean);
  const out = {
    id: str(raw.id, 40) || nid("v"),
    label: str(raw.label, 60) || `Batch ${i + 1}`,
    createdAt: iso(raw.createdAt) || new Date().toISOString(),
    ingredients,
    cookedWeight: cleanNum(raw.cookedWeight, 50000),
    cookedEstimate: raw.cookedEstimate === true,
  };
  if (!ingredients.length && raw.per100 && typeof raw.per100 === "object") {
    const p = {};
    for (const n of NUTRIENTS) p[n] = cleanNum(raw.per100[n], 2000);
    if (p.kcal != null) out.per100 = p;
  }
  const notes = str(raw.notes, 400);
  if (notes) out.notes = notes;
  if (!out.ingredients.length && !out.per100) return null;
  return out;
}

export function cleanRecipe(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 100);
  if (!name) return null;
  const versions = (Array.isArray(raw.versions) ? raw.versions : []).slice(-30).map(cleanVersion).filter(Boolean);
  if (!versions.length) return null;
  const current = versions.some((v) => v.id === raw.current) ? raw.current : versions.at(-1).id;
  return {
    id: str(raw.id, 60) || nid("rec_"),
    name, versions, current,
    defaultPortion: Math.max(0, Math.min(2000, Math.round(num(raw.defaultPortion) || 300))),
    favorite: raw.favorite === true,
    archived: raw.archived === true,
    ...(raw.example === true ? { example: true } : {}),
    uses: { count: Math.max(0, Math.round(num(raw.uses?.count) || 0)), lastUsedAt: iso(raw.uses?.lastUsedAt) || null },
    createdAt: iso(raw.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** A saved combination: recipes and portions you eat together. */
export function cleanCombo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 80);
  const parts = (Array.isArray(raw.parts) ? raw.parts : []).slice(0, 12).map((p) => {
    const recipeId = str(p?.recipeId, 60), grams = num(p?.grams);
    return recipeId && grams >= 0 && grams <= 5000 ? { recipeId, grams: Math.round(grams) } : null;
  }).filter(Boolean);
  if (!name || !parts.length) return null;
  return { id: str(raw.id, 60) || nid("combo_"), name, parts, createdAt: iso(raw.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString() };
}

/* ── arithmetic ────────────────────────────────────────────────────────── */

export const currentVersion = (r, id) => r?.versions?.find((v) => v.id === (id || r.current)) || r?.versions?.at(-1) || null;

/** An ingredient's amount in grams, when it can be known (weight units, or its food's measures). */
export function ingredientGrams(ing) {
  if (GRAMS[ing.unit]) return ing.amount * GRAMS[ing.unit];
  return ing.basis ? gramsFor(ing.basis, ing.amount, ing.unit) : null;
}

/** Rescale an ingredient from its looked-up food to its amount. null when the unit can't be converted. */
export function scaleIngredient(ing) {
  if (!ing.basis) return null;
  const qty = ing.unit === "lb" ? ing.amount * 16 : ing.amount;
  const unit = ing.unit === "lb" ? "oz" : ing.unit;
  const v = nutrientsFor({ serving: ing.basis.serving, portions: ing.basis.portions, nutrients: ing.basis.nutrients }, qty, unit);
  return v && v.kcal != null ? v : null;
}

/** A batch's totals. `missing` counts ingredients without a value for each nutrient. */
export function versionTotals(v) {
  const t = Object.fromEntries(NUTRIENTS.map((n) => [n, 0]));
  const missing = Object.fromEntries(NUTRIENTS.map((n) => [n, 0]));
  for (const ing of v?.ingredients || []) for (const n of NUTRIENTS) { if (ing[n] == null) missing[n] += 1; else t[n] += ing[n]; }
  const rawWeight = (v?.ingredients || []).reduce((s, i) => s + (ingredientGrams(i) ?? 0), 0);
  return { ...t, missing, rawWeight, estimates: (v?.ingredients || []).filter((i) => i.estimate).length };
}

/** Per 100 g of the cooked dish: totals ÷ cooked weight × 100 (or the values you entered directly). */
export function per100(v) {
  if (!v) return null;
  if (v.per100 && !v.ingredients?.length) return { ...v.per100 };
  if (!(v.cookedWeight > 0)) return null;
  const t = versionTotals(v);
  return Object.fromEntries(NUTRIENTS.map((n) => [n, (t[n] / v.cookedWeight) * 100]));
}

/** A portion's numbers: (totals ÷ cooked weight) × grams. */
export function portion(v, grams) {
  const p = per100(v);
  if (!p) return null;
  return Object.fromEntries(NUTRIENTS.map((n) => [n, p[n] == null ? null : (p[n] * grams) / 100]));
}

/** Calories per gram of protein — lower means more protein for the calories. */
export const proteinEfficiency = (p) => (p && p.protein > 0 ? p.kcal / p.protein : null);
export const efficiencyWord = (e) => (e == null ? "" : e <= 8 ? "very lean" : e <= 12 ? "lean" : e <= 18 ? "moderate" : "calorie-dense for its protein");

/** Add up rows of { recipe, grams } → { rows: [{ ..., n }], total }. */
export function calcTotals(rows) {
  const total = Object.fromEntries(NUTRIENTS.map((n) => [n, 0]));
  const out = rows.map((r) => {
    const n = portion(currentVersion(r.recipe), r.grams) || Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
    for (const k of NUTRIENTS) total[k] += n[k] || 0;
    return { ...r, n };
  });
  return { rows: out, total };
}

/** A diary entry for a portion, with its numbers frozen at logging. */
export function portionEntry(recipe, grams, meal, { time, id } = {}) {
  const v = currentVersion(recipe);
  const n = portion(v, grams);
  if (!n) return null;
  const estimated = recipe.example || v.cookedEstimate || v.ingredients.some((i) => i.estimate);
  return {
    ...(id ? { id } : {}), meal, name: recipe.name, qty: Math.round(grams), unit: "g",
    serving: { label: "100 g", amount: 100, unit: "g", grams: 100 },
    kcal: Math.round(n.kcal), protein: r1(n.protein ?? 0), carbs: n.carbs == null ? null : r1(n.carbs), fat: n.fat == null ? null : r1(n.fat), fiber: n.fiber == null ? null : r1(n.fiber),
    source: { kind: estimated ? "estimate" : "custom", provider: "Recipe", ref: `${recipe.id}:${v.id}`, note: `${v.label}${v.cookedWeight ? ` · ${Math.round(v.cookedWeight)} g cooked` : ""}${estimated ? " · includes estimated amounts" : ""}` },
    ...(time ? { time } : {}),
  };
}

/* ── grocery list ──────────────────────────────────────────────────────── */

const CATEGORIES = [
  ["Produce", /bell pepper|jalape|onion|garlic|ginger|lemon|lime|tomato|spinach|cilantro|parsley|lettuce|potato|carrot|broccoli|celery|avocado|banana|apple|berr|cucumber|zucchini|mushroom|scallion|kale|cabbage|corn|peas\b|herb/],
  ["Meat & seafood", /chicken|beef|pork|turkey|fish|salmon|shrimp|tuna|bacon|sausage|steak|lamb|ham\b/],
  ["Dairy & eggs", /milk|cheese|cheddar|mozzarella|parmesan|cream|butter|yogurt|yoghurt|egg/],
  ["Pasta, grains & bread", /pasta|macaroni|noodle|rice|bread|tortilla|oat|flour|quinoa|couscous|wrap|bun\b|panko|breadcrumb/],
  ["Spices, sauces & oils", /salt|pepper|paprika|cumin|masala|chili|chilli|cayenne|turmeric|coriander|spice|seasoning|sauce|ketchup|mustard|vinegar|oil|mayo|honey|sugar|stock|broth|bouillon/],
];
export const categoryOf = (name) => (CATEGORIES.find(([, re]) => re.test(name.toLowerCase()))?.[0]) || "Other";
export const CATEGORY_ORDER = [...CATEGORIES.map((c) => c[0]), "Other"];
const norm = (s) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\b(raw|cooked|dry|uncooked|fresh|boneless|skinless|shredded|chopped|diced|minced)\b/g, "").replace(/\s+/g, " ").trim().replace(/s$/, "");

/**
 * Ingredients for the batches you choose, combined: the same ingredient
 * in different recipes is added up (weights in grams, volumes in ml,
 * pieces counted), then what you have on hand is taken off.
 * picks: [{ recipe, batches }]; onHand: { key: amount in the line's unit }
 */
export function groceryList(picks, onHand = {}) {
  const lines = {};
  for (const { recipe, batches } of picks) {
    const v = currentVersion(recipe);
    for (const ing of v?.ingredients || []) {
      const key = norm(ing.name) || ing.name.toLowerCase();
      const L = (lines[key] ||= { key, name: ing.name, category: ing.category || categoryOf(ing.name), g: 0, ml: 0, pieces: 0, other: [], from: new Set() });
      L.from.add(recipe.name);
      const amt = ing.amount * batches;
      if (GRAMS[ing.unit]) L.g += amt * GRAMS[ing.unit];
      else if (ML[ing.unit]) L.ml += amt * ML[ing.unit];
      else if (ing.unit === "piece") L.pieces += amt;
      else L.other.push(`${amt} ${ing.unit}`);
    }
  }
  const out = Object.values(lines).map((L) => {
    const unit = L.g ? "g" : L.ml ? "ml" : L.pieces ? "piece" : null;
    const need = L.g || L.ml || L.pieces || 0;
    const have = Number(onHand[L.key]) || 0;
    const left = Math.max(0, need - have);
    return { key: L.key, name: L.name, category: L.category, unit, need, have, left, done: unit != null && left <= 0, text: amountText(left || need, unit), needText: amountText(need, unit), mixed: [L.g && L.ml ? `+ ${amountText(L.ml, "ml")}` : "", ...L.other].filter(Boolean), from: [...L.from] };
  });
  return CATEGORY_ORDER.map((c) => ({ category: c, items: out.filter((x) => x.category === c).sort((a, b) => a.name.localeCompare(b.name)) })).filter((c) => c.items.length);
}

/** "1 lb 4 oz (567 g)", "1½ cups", "3". */
export function amountText(v, unit) {
  if (unit === "g") {
    const oz = v / GRAMS.oz;
    const whole = Math.round(oz), lbs = Math.floor(whole / 16), rest = whole % 16;
    const imperial = lbs ? `${lbs} lb${rest ? ` ${rest} oz` : ""}` : `${Math.max(0.5, Math.round(oz * 2) / 2)} oz`;
    return `${imperial} (${Math.round(v)} g)`;
  }
  if (unit === "ml") {
    const cups = v / ML.cup;
    if (cups >= 0.25) return `${Math.round(cups * 4) / 4} cup${cups > 1.125 ? "s" : ""}`;
    const tbsp = v / ML.tbsp;
    return tbsp >= 1 ? `${Math.round(tbsp * 2) / 2} tbsp` : `${Math.max(0.25, Math.round((v / ML.tsp) * 4) / 4)} tsp`;
  }
  if (unit === "piece") return `${Math.ceil(v * 2) / 2}`;
  return "";
}

/* ── the two examples you asked for ────────────────────────────────────── */

const ing = (name, amount, unit, state, kcal, protein, carbs, fat, fiber, extra = {}) => ({ name, amount, unit, state, kcal, protein, carbs, fat, fiber, estimate: true, ...extra });
const MAC = [
  ing("Chicken breast, boneless skinless", 680, "g", "raw", 816, 153, 0, 17.7, 0),
  ing("Cheddar cheese, shredded", 8, "oz", "raw", 911, 56.3, 2.9, 74.8, 0),
  ing("Cream cheese", 4, "oz", "raw", 386, 7, 4.6, 38.6, 0),
  ing("Milk, 2%", 1, "cup", "raw", 122, 8.1, 11.7, 4.8, 0),
  ing("Butter", 2, "tbsp", "raw", 201, 0.2, 0, 22.7, 0),
  ing("Buffalo hot sauce", 0.5, "cup", "raw", 18, 0.6, 2, 0.5, 0),
];
/**
 * Typical amounts and USDA values (FoodData Central SR Legacy) — examples
 * to edit, not your recipes. Weigh your cooked batch and adjust the
 * ingredients, and the numbers become yours.
 */
export const EXAMPLE_RECIPES = [
  {
    id: "rec_example_buffalo_mac", name: "Buffalo Chicken Mac & Cheese", example: true, defaultPortion: 350,
    versions: [
      { id: "v_mac_12", label: "12 oz pasta", createdAt: "2026-11-01T12:00:00.000Z", cookedWeight: 1900, cookedEstimate: true,
        ingredients: [ing("Elbow macaroni", 12, "oz", "dry", 1261, 44.2, 254, 5.1, 10.9), ...MAC],
        notes: "Example with typical amounts — weigh your finished pot and edit the ingredients to match." },
      { id: "v_mac_14", label: "14 oz pasta", createdAt: "2026-11-08T12:00:00.000Z", cookedWeight: 2025, cookedEstimate: true,
        ingredients: [ing("Elbow macaroni", 14, "oz", "dry", 1471, 51.6, 296.5, 6, 12.7), ...MAC],
        notes: "Same as the 12 oz batch with 2 oz more pasta — a second batch keeps the first one's numbers." },
    ],
    current: "v_mac_14",
  },
  {
    id: "rec_example_chicken_tikka", name: "Spicy Chicken Tikka", example: true, defaultPortion: 250,
    versions: [
      { id: "v_tikka_1", label: "Batch 1", createdAt: "2026-11-01T12:00:00.000Z", cookedWeight: 950, cookedEstimate: true,
        ingredients: [
          ing("Chicken breast, boneless skinless", 2, "lb", "raw", 1088, 204, 0, 23.6, 0),
          ing("Greek yogurt, nonfat plain", 1, "cup", "raw", 134, 23.2, 8.2, 0.9, 0),
          ing("Onion", 1, "piece", "raw", 44, 1.2, 10.3, 0.1, 1.9),
          ing("Garlic and ginger paste", 2, "tbsp", "raw", 20, 0.6, 4.5, 0.1, 0.4),
          ing("Lemon juice", 2, "tbsp", "raw", 7, 0.1, 2.1, 0.1, 0.1),
          ing("Tikka spice mix (chili, garam masala, paprika, cumin)", 2, "tbsp", "raw", 40, 1.5, 7, 1.5, 4),
          ing("Olive oil", 1, "tbsp", "raw", 119, 0, 0, 13.5, 0),
        ],
        notes: "Example with typical amounts — weigh your cooked batch and edit to match." },
    ],
    current: "v_tikka_1",
  },
];
