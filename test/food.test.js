// Food lookup: provider responses → candidates, ranking, caching, and AI estimates.
// Responses are shaped like the documented APIs; nothing here touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromUsda, fromOff, fromFatSecret, rank, tidyName, consistencyNote, createFoodLookup } from "../server/food.mjs";
import { createEstimator, estimateRequest, toCandidate } from "../server/ai.mjs";
import { parseQuery, suggestEntry, nutrientsFor, unitsFor } from "../js/nutrition.js";
import { n, USDA_EGG, USDA_CHOBANI, USDA_OTHER_YOGURT, USDA_RICE, USDA_FOUNDATION_CHICKEN, OFF_CHOBANI, FS_WAWA } from "./fixtures.js";

test("USDA Branded: label data scaled to the manufacturer's serving, marked verified", () => {
  const f = fromUsda(USDA_CHOBANI);
  assert.equal(f.name, "Zero Sugar Vanilla Yogurt");
  assert.equal(f.brand, "Chobani");
  assert.deepEqual(f.serving, { label: "1 container (150 g)", amount: 1, unit: "serving", grams: 150 });
  assert.deepEqual(f.nutrients, { kcal: 60, protein: 11, carbs: 5, fat: 0, fiber: 0 });
  assert.equal(f.source.kind, "verified");
  assert.match(f.source.url, /^https:\/\/fdc\.nal\.usda\.gov\/food-details\/2034567/);
  // GRM is USDA's older spelling of grams; "1 cup" becomes a cup measure.
  const o = fromUsda(USDA_OTHER_YOGURT);
  assert.equal(o.serving.unit, "cup");
  assert.equal(o.serving.grams, 170);
  assert.equal(o.nutrients.kcal, 136);
});

test("USDA generic: per 100 g, household measures kept, a large egg preferred for eggs", () => {
  const f = fromUsda(USDA_EGG);
  assert.equal(f.source.kind, "database");
  assert.deepEqual(f.serving, { label: "100 g", amount: 100, unit: "g", grams: 100 });
  assert.equal(f.nutrients.kcal, 143); // the kJ row is ignored
  const piece = f.portions.find((p) => p.unit === "piece");
  assert.equal(piece.grams, 50);
  assert.ok(f.portions.find((p) => p.unit === "cup"));
  // "2 eggs" → 2 pieces → 100 g
  const s = suggestEntry(f, parseQuery("2 eggs"));
  assert.equal(s.unit, "piece");
  assert.equal(s.qty, 2);
  assert.equal(s.nutrients.kcal, 143);
  // Atwater energy is used when 208 is missing
  assert.equal(fromUsda(USDA_FOUNDATION_CHICKEN).nutrients.kcal, 106);
  // No energy at all: unusable
  assert.equal(fromUsda({ ...USDA_EGG, foodNutrients: [n("203", 1003, 12)] }), null);
});

test("scaling: 6 oz chicken and 1 cup rice convert exactly; unknown measures are refused", () => {
  const chicken = fromUsda(USDA_FOUNDATION_CHICKEN);
  const s = suggestEntry(chicken, parseQuery("6 oz chicken breast"));
  assert.equal(s.unit, "oz");
  assert.equal(s.nutrients.kcal, Math.round(106 * (6 * 28.349523125) / 100));
  // Chicken has no cup measure: the suggestion falls back to servings and says so
  const c = suggestEntry(chicken, parseQuery("1 cup chicken breast"));
  assert.equal(c.unit, "serving");
  assert.match(c.note, /no cup measure/);
  assert.ok(!unitsFor(chicken).includes("cup"));
  const rice = fromUsda(USDA_RICE);
  assert.equal(nutrientsFor(rice, 1, "cup").kcal, Math.round(130 * 1.58));
});

test("Open Food Facts: per-serving values preferred, marked community data", () => {
  const f = fromOff(OFF_CHOBANI);
  assert.equal(f.nutrients.kcal, 60);
  assert.equal(f.nutrients.protein, 11);
  assert.equal(f.nutrients.fiber, null); // not listed → unknown, not zero
  assert.equal(f.serving.grams, 150);
  assert.equal(f.source.kind, "database");
  assert.equal(f.source.provider, "Open Food Facts");
  // per-100 g only, no serving: stays per 100 g
  const g = fromOff({ code: "1", product_name: "Oats", nutriments: { "energy-kcal_100g": 380, proteins_100g: 13 } });
  assert.equal(g.serving.label, "100 g");
  assert.equal(g.nutrients.kcal, 380);
  // energy only in kJ
  assert.equal(fromOff({ code: "2", product_name: "Juice", nutriments: { energy_100g: 184 } }).nutrients.kcal, 44);
});

test("FatSecret: the one-line summary becomes a per-sandwich food with fiber unknown", () => {
  const f = fromFatSecret(FS_WAWA);
  assert.equal(f.brand, "Wawa");
  assert.deepEqual(f.nutrients, { kcal: 520, protein: 30, carbs: 55, fat: 20, fiber: null });
  assert.equal(f.serving.label, "1 sandwich");
  assert.equal(f.serving.unit, "piece");
  const g = fromFatSecret({ food_id: "9", food_name: "Rice", food_description: "Per 100g - Calories: 130kcal | Fat: 0.28g | Carbs: 28.17g | Protein: 2.69g" });
  assert.deepEqual(g.serving, { label: "100 g", amount: 100, unit: "g", grams: 100 });
});

test("ranking: a named brand leads; with no brand, USDA's generic foods lead", () => {
  const cands = [fromUsda(USDA_OTHER_YOGURT), fromOff(OFF_CHOBANI), fromUsda(USDA_CHOBANI)];
  const r = rank("Chobani Zero Sugar vanilla yogurt", cands);
  assert.equal(r[0].key, "usda:2034567");
  assert.equal(r[0].brandMatch, true);
  const other = r.findIndex((x) => x.key === "usda:2099999");
  assert.ok(other === -1 || other > r.findIndex((x) => x.key.startsWith("off:")), "another brand never outranks the one you named");
  const rice = rank("white rice", [fromUsda({ ...USDA_OTHER_YOGURT, fdcId: 5, description: "WHITE RICE", brandName: "ACME" }), fromUsda(USDA_RICE)]);
  assert.equal(rice[0].key, "usda:169757");
  // Unrelated results drop out
  assert.equal(rank("white rice", [fromUsda(USDA_EGG)]).length, 0);
});

test("honesty: calories that don't match the macros are flagged, low confidence", () => {
  assert.equal(consistencyNote({ kcal: 200, protein: 10, carbs: 20, fat: 8 }), null);
  assert.match(consistencyNote({ kcal: 500, protein: 10, carbs: 20, fat: 5 }), /don't agree/);
  const bad = fromOff({ code: "3", product_name: "Mystery Bar", nutriments: { "energy-kcal_100g": 900, proteins_100g: 10, carbohydrates_100g: 20, fat_100g: 5 } });
  const [r] = rank("mystery bar", [bad]);
  assert.equal(r.source.confidence, "low");
});

test("tidyName only rewrites ALL CAPS", () => {
  assert.equal(tidyName("TURKEY HOAGIE (CLASSIC)"), "Turkey Hoagie (Classic)");
  assert.equal(tidyName("Rice, white"), "Rice, white");
});

/* ── the service, with a fake network and store ────────────────────────── */

function memStore() {
  const items = {};
  return {
    items,
    async getItem(kind, id) { return items[kind]?.[id] ? structuredClone(items[kind][id]) : null; },
    async putItem(kind, id, data) { (items[kind] ||= {})[id] = structuredClone(data); },
    async deleteItem(kind, id) { delete items[kind]?.[id]; },
    async listItems(kind) { return Object.values(items[kind] || {}); },
  };
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, reply] of routes) {
      if (re.test(String(url))) {
        const r = typeof reply === "function" ? reply(String(url), init) : reply;
        return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
      }
    }
    throw new TypeError("fetch failed");
  };
  fn.calls = calls;
  return fn;
}

test("search: providers queried once, cached for repeat searches, keys sent as headers", async () => {
  const fetch = fakeFetch([
    [/api\.nal\.usda\.gov/, (url, init) => ({ body: { foods: JSON.parse(init.body).dataType.includes("Branded") ? [USDA_CHOBANI] : [] } })],
    [/openfoodfacts/, { body: { products: [OFF_CHOBANI] } }],
  ]);
  const store = memStore();
  const lookup = createFoodLookup({ store, keys: () => ({ usdaKey: "abc123" }), fetch });
  const a = await lookup.search("Chobani zero sugar vanilla yogurt");
  assert.equal(a.cached, false);
  assert.equal(a.results[0].key, "usda:2034567");
  assert.deepEqual(a.providers, { usda: "ok", off: "ok" });
  const usdaCall = fetch.calls.find((c) => c.url.includes("nal.usda.gov"));
  assert.equal(usdaCall.init.headers["x-api-key"], "abc123");
  assert.ok(!usdaCall.url.includes("abc123"), "the key never goes in the URL");
  assert.match(fetch.calls.find((c) => c.url.includes("openfoodfacts")).init.headers["user-agent"], /AshHealth/);
  const before = fetch.calls.length;
  const b = await lookup.search("chobani ZERO sugar vanilla yogurt");
  assert.equal(b.cached, true);
  assert.equal(fetch.calls.length, before, "a repeat search costs no lookups");
});

test("search: a failing provider is reported, the rest still answer, and nothing is cached", async () => {
  const fetch = fakeFetch([
    [/api\.nal\.usda\.gov/, { status: 429, body: {} }],
    [/openfoodfacts/, { body: { products: [OFF_CHOBANI] } }],
  ]);
  const store = memStore();
  const lookup = createFoodLookup({ store, keys: () => ({}), fetch });
  const r = await lookup.search("chobani vanilla");
  assert.equal(r.providers.usda, "error");
  assert.match(r.notes[0].message, /demo key/);
  assert.equal(r.results[0].source.provider, "Open Food Facts");
  assert.equal(Object.keys(store.items.lookup || {}).length, 0);
  // USDA rests after a rate limit instead of being hammered
  const again = await lookup.search("chobani vanilla");
  assert.equal(again.providers.usda, "skipped");
});

test("search: FatSecret joins when its keys are set; an IP refusal is explained", async () => {
  const fetch = fakeFetch([
    [/oauth\.fatsecret\.com/, { body: { access_token: "tok", expires_in: 86400 } }],
    [/platform\.fatsecret\.com/, (url, init) => {
      assert.equal(init.headers.authorization, "Bearer tok");
      return { body: { foods: { food: FS_WAWA } } }; // a single result comes back as an object
    }],
    [/api\.nal\.usda\.gov/, { body: { foods: [] } }],
  ]);
  const lookup = createFoodLookup({ store: memStore(), keys: () => ({ usdaKey: "k", fatsecretId: "id", fatsecretSecret: "s", offEnabled: false }), fetch });
  const r = await lookup.search("wawa turkey hoagie");
  assert.equal(r.results[0].key, "fatsecret:123");
  assert.equal(r.results[0].brandMatch, true);
  const blocked = createFoodLookup({
    store: memStore(), keys: () => ({ usdaKey: "k", fatsecretId: "id", fatsecretSecret: "s", offEnabled: false }),
    fetch: fakeFetch([
      [/oauth\.fatsecret\.com/, { body: { access_token: "tok", expires_in: 86400 } }],
      [/platform\.fatsecret\.com/, { body: { error: { code: 21, message: "Invalid IP address detected" } } }],
      [/api\.nal\.usda\.gov/, { body: { foods: [] } }],
    ]),
  });
  const b = await blocked.search("wawa turkey hoagie");
  assert.equal(b.providers.fatsecret, "error");
  assert.match(b.notes[0].message, /IP address/);
});

/* ── AI estimates ──────────────────────────────────────────────────────── */

const ANSWER = {
  isFood: true, name: "Turkey hoagie (classic)", brand: "Wawa", servingLabel: "1 classic hoagie", servingUnit: "serving",
  servingAmount: 1, servingGrams: 310, quantity: 1, kcal: 680, protein: 38, carbs: 72, fat: 26, fiber: null,
  kcalLow: 560, kcalHigh: 820, confidence: "medium",
  basis: "Typical deli turkey hoagie on a 10-inch roll with cheese; Wawa's published numbers may differ.",
  officialSource: "Wawa's nutrition guide on wawa.com", ask: "Shorti or classic? Cheese?",
};

function fakeClient(reply) {
  class APIError extends Error {}
  class AuthenticationError extends APIError {}
  const sdk = { APIError, AuthenticationError, PermissionDeniedError: class extends APIError {}, RateLimitError: class extends APIError {}, APIConnectionError: class extends APIError {}, NotFoundError: class extends APIError {} };
  const calls = [];
  const client = {
    beta: { messages: { create: async (req) => { calls.push(req); if (reply instanceof Error) throw reply; return reply; } } },
    models: { retrieve: async (id) => ({ id }) },
  };
  return { sdk, client, calls, AuthenticationError };
}

test("estimate request: structured JSON output, low effort, default refusal fallbacks", () => {
  const req = estimateRequest("wawa turkey hoagie");
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.output_config.effort, "low");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.fallbacks, "default");
  const schema = req.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.equal(estimateRequest("x", "claude-sonnet-5-5").fallbacks, undefined);
});

test("estimate: labelled ESTIMATE with confidence, range and basis; cached; never treated as verified", async () => {
  const fake = fakeClient({ stop_reason: "end_turn", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(ANSWER) }] });
  const store = memStore();
  const est = createEstimator({ store, keys: () => ({ anthropicKey: "sk-test" }), makeClient: async () => fake });
  const f = await est.estimate("Wawa turkey hoagie");
  assert.equal(f.source.kind, "estimate");
  assert.equal(f.source.confidence, "medium");
  assert.match(f.source.note, /may differ/);
  assert.deepEqual(f.estimate.range, [560, 820]);
  assert.equal(f.nutrients.fiber, null);
  assert.equal(f.nutrients.kcal, 680);
  const again = await est.estimate("wawa turkey hoagie");
  assert.equal(again.cached, true);
  assert.equal(fake.calls.length, 1);
});

test("estimate: no key, refusals, non-food and bad keys all fail politely", async () => {
  const none = createEstimator({ store: memStore(), keys: () => ({}), makeClient: async () => fakeClient({}) });
  await assert.rejects(none.estimate("eggs"), /Anthropic API key/);
  const refuse = createEstimator({ store: memStore(), keys: () => ({ anthropicKey: "k" }), makeClient: async () => fakeClient({ stop_reason: "refusal", content: [] }) });
  await assert.rejects(refuse.estimate("eggs"), /declined/);
  const notFood = createEstimator({ store: memStore(), keys: () => ({ anthropicKey: "k" }), makeClient: async () => fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ...ANSWER, isFood: false }) }] }) });
  await assert.rejects(notFood.estimate("a chair"), /doesn't look like a food/);
  const f = fakeClient(null);
  const badKey = createEstimator({ store: memStore(), keys: () => ({ anthropicKey: "k" }), makeClient: async () => ({ ...f, client: { beta: { messages: { create: async () => { throw new f.AuthenticationError("401"); } } } } }) });
  await assert.rejects(badKey.estimate("eggs"), /refused the API key/);
});

test("estimate: pieces stay pieces — '2 eggs' becomes 2 × one large egg", () => {
  const c = toCandidate({ ...ANSWER, name: "Egg", brand: null, servingLabel: "1 large egg", servingUnit: "piece", servingAmount: 1, servingGrams: 50, quantity: 2, kcal: 72 }, "2 eggs", "m");
  assert.equal(c.estimate.unit, "piece");
  assert.equal(c.estimate.qty, 2);
  assert.equal(nutrientsFor(c, 2, "piece").kcal, 144);
});
