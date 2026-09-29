/* ──────────────────────────────────────────────────────────────────────────
   Your library: saved foods, custom meals and rewards. Shared by the page
   and the server; the server runs every item through these before storing.

   SAVED FOOD — any food you've logged or created, with its confirmed
   numbers and where they came from:
     { id, name, brand, serving, nutrients, portions, source, lookupKey,
       favorite, archived, uses: { count, lastUsedAt }, last: { qty, unit },
       createdAt }
   `lookupKey` ("usda:2034567") ties it to the search result it came from,
   so logging the same result again reuses it; `last` is the amount you
   logged most recently, offered first next time.
   Recent = last used; frequent = most used; favorites = starred;
   custom = ones you typed in yourself (source.kind "custom").

   MEAL — a reusable group of items; adding it to a day copies each item
   into the diary as its own editable entry, tagged with the meal.

   REWARD — something you choose to give yourself when an achievement
   unlocks. The site never decides what it is.
   ────────────────────────────────────────────────────────────────────────── */
import { NUTRIENTS, UNIT_IDS } from "./nutrition.js";
import { cleanSource, cleanServing, cleanFoodEntry, num } from "./sources.js";

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
export const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function cleanNutrients(raw) {
  const out = {};
  for (const n of NUTRIENTS) {
    const v = num(raw?.[n]);
    out[n] = v === undefined ? null : Math.round(v * 10) / 10;
  }
  if (out.kcal != null) out.kcal = Math.round(out.kcal);
  return out;
}

export function cleanFood(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 120);
  const nutrients = cleanNutrients(raw.nutrients);
  if (!name || nutrients.kcal == null) return null;
  const portions = (Array.isArray(raw.portions) ? raw.portions : []).slice(0, 12).map((p) => {
    const grams = num(p?.grams);
    if (!grams || !UNIT_IDS.includes(p?.unit)) return null;
    return { label: str(p.label, 40) || p.unit, unit: p.unit, amount: num(p.amount) || 1, grams: Math.round(grams * 100) / 100 };
  }).filter(Boolean);
  const out = {
    id: str(raw.id, 60) || newId("food_"),
    name,
    serving: cleanServing(raw.serving),
    nutrients,
    portions,
    source: cleanSource(raw.source),
    favorite: raw.favorite === true,
    archived: raw.archived === true,
    uses: { count: Math.max(0, Math.round(num(raw.uses?.count) || 0)), lastUsedAt: iso(raw.uses?.lastUsedAt) || null },
    createdAt: iso(raw.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const brand = str(raw.brand, 80), lookupKey = str(raw.lookupKey, 80);
  if (brand) out.brand = brand;
  if (lookupKey) out.lookupKey = lookupKey;
  const lastQty = num(raw.last?.qty);
  if (lastQty > 0 && UNIT_IDS.includes(raw.last?.unit)) out.last = { qty: Math.round(lastQty * 1000) / 1000, unit: raw.last.unit };
  return out;
}

export function cleanMeal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 80);
  if (!name) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 40).map((x) => {
    const e = cleanFoodEntry({ ...x, meal: "snacks" });
    if (!e) return null;
    delete e.meal; delete e.time; delete e.group;
    return e;
  }).filter(Boolean);
  return {
    id: str(raw.id, 60) || newId("meal_"),
    name,
    items,
    favorite: raw.favorite === true,
    archived: raw.archived === true,
    createdAt: iso(raw.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function cleanReward(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name, 100);
  if (!name) return null;
  const out = {
    id: str(raw.id, 60) || newId("rew_"),
    name,
    achievementId: typeof raw.achievementId === "string" && /^[a-z0-9_-]{1,40}-\d{1,2}$/i.test(raw.achievementId) ? raw.achievementId : null,
    claimedAt: iso(raw.claimedAt) || null,
    archived: raw.archived === true,
    createdAt: iso(raw.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const description = str(raw.description, 400), requirement = str(raw.requirement, 200);
  if (description) out.description = description;
  if (requirement) out.requirement = requirement;
  return out;
}

export const CLEAN = { food: cleanFood, meal: cleanMeal, reward: cleanReward };

/* ── lists ─────────────────────────────────────────────────────────────── */

const live = (list) => (list || []).filter((x) => !x.archived);
export const recentFoods = (foods, n = 12) => live(foods).filter((f) => f.uses?.lastUsedAt).sort((a, b) => b.uses.lastUsedAt.localeCompare(a.uses.lastUsedAt)).slice(0, n);
export const frequentFoods = (foods, n = 12) => live(foods).filter((f) => f.uses?.count > 1).sort((a, b) => b.uses.count - a.uses.count || a.name.localeCompare(b.name)).slice(0, n);
export const favoriteFoods = (foods) => live(foods).filter((f) => f.favorite).sort((a, b) => a.name.localeCompare(b.name));
export const customFoods = (foods) => live(foods).filter((f) => f.source?.kind === "custom").sort((a, b) => a.name.localeCompare(b.name));

/** Saved foods matching a search term (every word must appear in the name or brand). */
export function matchFoods(foods, term, n = 6) {
  const words = String(term || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return live(foods)
    .map((f) => {
      const hay = `${f.name} ${f.brand || ""}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w) || hay.includes(w.replace(/s$/, ""))).length;
      return { f, score: hits / words.length + Math.min(0.3, (f.uses?.count || 0) / 50) };
    })
    .filter((x) => x.score >= 0.99)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.f);
}

/** A meal's totals from its items. */
export function mealTotals(meal) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  const missing = { protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const it of meal?.items || []) {
    for (const n of NUTRIENTS) {
      if (it[n] == null) { if (n !== "kcal") missing[n] += 1; continue; }
      t[n] += Number(it[n]);
    }
  }
  for (const n of NUTRIENTS) t[n] = Math.round(t[n] * (n === "kcal" ? 1 : 10)) / (n === "kcal" ? 1 : 10);
  return { totals: t, missing };
}
