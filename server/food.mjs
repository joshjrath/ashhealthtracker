/* ──────────────────────────────────────────────────────────────────────────
   Food lookup: what you type → candidate foods, each saying honestly where
   its numbers came from.

   Most trusted first:
     your saved foods      numbers you've already confirmed (matched on the page)
     USDA Branded Foods    the manufacturer's own label data, submitted by
                           brand owners to USDA FoodData Central   → VERIFIED
     FatSecret (optional)  curated brand and chain-restaurant data → DATABASE
     USDA generic foods    Foundation, SR Legacy and FNDDS         → DATABASE
     Open Food Facts       community-entered label data            → DATABASE
     Claude (on request)   an estimate with its confidence          → ESTIMATE
                           (see ai.mjs — never automatic)

   Every provider is a documented JSON API; nothing here scrapes web pages.
   A search's results are cached for two weeks (items kind "lookup"), and a
   food you log is saved to your library, so repeat foods need no lookup.

   `fetch` is injectable, so the tests run on recorded response shapes.
   ────────────────────────────────────────────────────────────────────────── */
import { createHash } from "node:crypto";
import { parseQuery, singular, NUTRIENTS } from "../js/nutrition.js";

const CACHE_DAYS = 14;
const CACHE_MAX = 500;
const TIMEOUT_MS = 7000;
const UA = "AshHealth/1.0 (personal food diary; self-hosted)";

export const USDA_SIGNUP = "https://fdc.nal.usda.gov/api-key-signup";

/* ── shapes ────────────────────────────────────────────────────────────── */

const isNum = (v) => v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v));
const r1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** "ZERO SUGAR VANILLA YOGURT" → "Zero Sugar Vanilla Yogurt"; mixed case stays. */
export function tidyName(s) {
  const t = clean(s);
  if (!t || t !== t.toUpperCase() || !/[A-Z]/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

function nutrients(per) {
  const out = {};
  for (const n of NUTRIENTS) out[n] = isNum(per[n]) ? (n === "kcal" ? Math.round(Number(per[n])) : r1(per[n])) : null;
  return out;
}

/** A plain-language warning when a food's calories and macros don't agree. */
export function consistencyNote(n) {
  if (n.kcal == null || n.protein == null || n.carbs == null || n.fat == null || n.kcal < 40) return null;
  const est = n.protein * 4 + n.carbs * 4 + n.fat * 9;
  return Math.abs(est - n.kcal) / n.kcal > 0.35
    ? `Calories (${n.kcal}) and macros (≈${Math.round(est)} kcal) don't agree — check the label before saving.`
    : null;
}

/** "1 cup", "1 large", "2 slices", "1 container (150 g)" → a unit we can scale with. */
function measureOf(text) {
  const t = clean(clean(text).replace(/\(.*?\)/g, " ").replace(/[,;:]/g, " "));
  if (!t || /not specified|^quantity/i.test(t)) return null;
  const p = parseQuery(t);
  if (p.unit === "g" || p.unit === "oz" || p.unit === "ml") return null; // exact units need no measure
  if (p.unit) return { unit: p.unit, amount: p.qty || 1 };
  if (p.count) return { unit: "piece", amount: p.qty || 1 };
  return null;
}

/* ── USDA FoodData Central ─────────────────────────────────────────────── */

// Nutrient numbers (and ids) per FDC. Energy is sometimes only reported with
// Atwater factors (958 specific, 957 general) instead of 208.
const FDC = {
  kcal: [["208", 1008], ["958", 2048], ["957", 2047]],
  protein: [["203", 1003]],
  fat: [["204", 1004]],
  carbs: [["205", 1005]],
  fiber: [["291", 1079]],
};

export function usdaNutrients(list = []) {
  const out = {};
  for (const [n, candidates] of Object.entries(FDC)) {
    out[n] = null;
    for (const [number, id] of candidates) {
      const hit = list.find((x) => (String(x.nutrientNumber ?? x.number ?? "") === number || x.nutrientId === id)
        && (n !== "kcal" || !x.unitName || /kcal/i.test(x.unitName)));
      if (hit && isNum(hit.value ?? hit.amount)) { out[n] = Number(hit.value ?? hit.amount); break; }
    }
  }
  return out;
}

const scale = (per100, grams) => Object.fromEntries(NUTRIENTS.map((n) => [n, per100[n] == null ? null : (per100[n] * grams) / 100]));

/** One FDC search result → a candidate food, or null if it can't be used. */
export function fromUsda(f) {
  if (!f || !f.fdcId || !f.description) return null;
  const per100 = usdaNutrients(f.foodNutrients);
  if (per100.kcal == null) return null;
  const branded = f.dataType === "Branded";
  const url = `https://fdc.nal.usda.gov/food-details/${f.fdcId}/nutrients`;
  if (branded) {
    const unit = String(f.servingSizeUnit || "").toLowerCase();
    const size = Number(f.servingSize);
    const isG = unit === "g" || unit === "grm", isMl = unit === "ml" || unit === "mlt";
    const household = clean(f.householdServingFullText);
    let serving, n;
    if (size > 0 && (isG || isMl)) {
      const exact = `${r1(size)} ${isG ? "g" : "ml"}`;
      const m = measureOf(household);
      serving = { label: household ? `${household} (${exact})` : exact, amount: m?.amount || 1, unit: m?.unit || "serving" };
      if (isG) serving.grams = size; else serving.ml = size;
      n = scale(per100, size); // label values are per 100 g/ml in search results
    } else {
      serving = { label: "100 g", amount: 100, unit: "g", grams: 100 };
      n = per100;
    }
    const brand = tidyName(f.brandName || f.brandOwner) || undefined;
    return {
      key: `usda:${f.fdcId}`,
      name: tidyName(f.description), brand, serving, nutrients: nutrients(n), portions: [],
      source: {
        kind: "verified", provider: "USDA Branded Foods", ref: String(f.fdcId), url,
        note: `Label data from ${tidyName(f.brandOwner || f.brandName) || "the manufacturer"}${f.publishedDate ? `, published ${f.publishedDate}` : ""}.`,
        confidence: "high",
      },
      branded: true,
    };
  }
  // Generic foods: values per 100 g, with household measures when USDA lists them.
  const portions = [];
  const measures = (f.foodMeasures || []).slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const egg = /\begg/i.test(f.description);
  const pieces = [];
  for (const m of measures) {
    const g = Number(m.gramWeight);
    const text = clean(m.disseminationText);
    const mm = measureOf(text);
    if (!(g > 0) || !mm) continue;
    const p = { label: `${text} (${r1(g)} g)`, unit: mm.unit, amount: mm.amount, grams: g };
    if (mm.unit === "piece") pieces.push(p);
    else if (!portions.some((x) => x.unit === p.unit)) portions.push(p);
  }
  if (pieces.length) {
    const prefer = egg ? /^1 large\b/i : /^1 medium\b/i; // "1 large", not "1 extra large"
    portions.push(pieces.find((p) => prefer.test(p.label)) || pieces[0]);
  }
  const kind = { Foundation: "USDA Foundation Foods", "SR Legacy": "USDA SR Legacy", "Survey (FNDDS)": "USDA FNDDS" }[f.dataType] || "USDA FoodData Central";
  return {
    key: `usda:${f.fdcId}`,
    name: clean(f.description), serving: { label: "100 g", amount: 100, unit: "g", grams: 100 },
    nutrients: nutrients(per100), portions,
    source: {
      kind: "database", provider: kind, ref: String(f.fdcId), url,
      note: f.dataType === "Survey (FNDDS)" ? "USDA's typical values for this food as commonly eaten." : "USDA reference values for this food.",
      confidence: "high",
    },
    branded: false,
  };
}

async function usdaSearch(term, { key, fetch }) {
  const call = (dataType, pageSize) => getJson(fetch, "https://api.nal.usda.gov/fdc/v1/foods/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: term, dataType, pageSize }),
  });
  const [generic, branded] = await Promise.all([
    call(["Foundation", "SR Legacy", "Survey (FNDDS)"], 8),
    call(["Branded"], 14),
  ]);
  return [...(generic.foods || []), ...(branded.foods || [])].map(fromUsda).filter(Boolean);
}

/* ── Open Food Facts ───────────────────────────────────────────────────── */

export function fromOff(p) {
  if (!p || !p.code) return null;
  const name = clean(p.product_name_en || p.product_name);
  if (!name) return null;
  const n = p.nutriments || {};
  const sq = Number(p.serving_quantity);
  const sUnit = String(p.serving_quantity_unit || "g").toLowerCase();
  const hasServing = sq > 0 && (sUnit === "g" || sUnit === "ml");
  const pick = (k) => {
    if (hasServing && isNum(n[`${k}_serving`])) return Number(n[`${k}_serving`]);
    if (isNum(n[`${k}_100g`])) return hasServing ? (Number(n[`${k}_100g`]) * sq) / 100 : Number(n[`${k}_100g`]);
    return null;
  };
  let kcal = pick("energy-kcal");
  if (kcal == null) { const kj = pick("energy"); if (kj != null) kcal = kj / 4.184; }
  if (kcal == null) return null;
  const per = { kcal, protein: pick("proteins"), carbs: pick("carbohydrates"), fat: pick("fat"), fiber: pick("fiber") };
  let serving;
  if (hasServing) {
    const label = clean(p.serving_size) || `${r1(sq)} ${sUnit}`;
    const m = measureOf(label);
    serving = { label, amount: m?.amount || 1, unit: m?.unit || "serving" };
    if (sUnit === "g") serving.grams = sq; else serving.ml = sq;
  } else {
    serving = { label: "100 g", amount: 100, unit: "g", grams: 100 };
  }
  const brand = clean(String(p.brands || "").split(",")[0]) || undefined;
  return {
    key: `off:${p.code}`,
    name: tidyName(name), brand, serving, nutrients: nutrients(per), portions: [],
    source: {
      kind: "database", provider: "Open Food Facts", ref: String(p.code), url: `https://world.openfoodfacts.org/product/${encodeURIComponent(p.code)}`,
      note: "Entered by Open Food Facts contributors from the package — worth checking against your label.",
      confidence: "medium",
    },
    branded: !!brand,
  };
}

async function offSearch(term, { fetch }) {
  const q = new URLSearchParams({
    search_terms: term, search_simple: "1", action: "process", json: "1", page_size: "12",
    tagtype_0: "countries", tag_contains_0: "contains", tag_0: "united-states",
    fields: "code,product_name,product_name_en,brands,serving_size,serving_quantity,serving_quantity_unit,nutriments",
  });
  const body = await getJson(fetch, `https://world.openfoodfacts.org/cgi/search.pl?${q}`, { headers: { "user-agent": UA } });
  return (body.products || []).map(fromOff).filter(Boolean);
}

/* ── FatSecret (optional) ──────────────────────────────────────────────── */

const FS_RE = /^Per\s+(.+?)\s+-\s+Calories:\s*([\d.]+)\s*kcal\s*\|\s*Fat:\s*([\d.]+)\s*g\s*\|\s*Carbs:\s*([\d.]+)\s*g\s*\|\s*Protein:\s*([\d.]+)\s*g/i;

/** FatSecret's one-line summary ("Per 1 sandwich - Calories: 520kcal | Fat: …") → a candidate. */
export function fromFatSecret(f) {
  const m = FS_RE.exec(clean(f?.food_description));
  if (!f?.food_id || !m) return null;
  const [, per, kcal, fat, carbs, protein] = m;
  const exact = /^([\d.]+)\s*(g|ml)$/i.exec(per);
  let serving;
  if (exact) {
    const amt = Number(exact[1]);
    serving = exact[2].toLowerCase() === "g" ? { label: `${amt} g`, amount: amt, unit: "g", grams: amt } : { label: `${amt} ml`, amount: amt, unit: "ml", ml: amt };
  } else {
    const mm = measureOf(per);
    serving = { label: per, amount: mm?.amount || 1, unit: mm?.unit || "serving" };
  }
  const brand = clean(f.brand_name) || undefined;
  return {
    key: `fatsecret:${f.food_id}`,
    name: clean(f.food_name), brand, serving,
    nutrients: nutrients({ kcal, protein, carbs, fat, fiber: null }), portions: [],
    source: {
      kind: "database", provider: "FatSecret", ref: String(f.food_id),
      url: /^https:\/\//.test(f.food_url || "") ? f.food_url : undefined,
      note: brand ? `FatSecret's listing for ${brand}. Fiber isn't in the summary — add it if the label lists it.` : "FatSecret's typical values. Fiber isn't in the summary.",
      confidence: brand ? "high" : "medium",
    },
    branded: !!brand,
  };
}

function fatSecretClient({ id, secret, fetch }) {
  let token = null, exp = 0;
  const auth = async () => {
    if (token && Date.now() < exp - 60_000) return token;
    const body = await getJson(fetch, "https://oauth.fatsecret.com/connect/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
      body: "grant_type=client_credentials&scope=basic",
    });
    if (!body.access_token) throw new Error("FatSecret didn't return a token — check the client ID and secret");
    token = body.access_token;
    exp = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return token;
  };
  return async function search(term) {
    const q = new URLSearchParams({ method: "foods.search", search_expression: term, format: "json", max_results: "12" });
    const body = await getJson(fetch, `https://platform.fatsecret.com/rest/server.api?${q}`, { headers: { authorization: `Bearer ${await auth()}` } });
    if (body.error) {
      // 21: the server's IP isn't on the key's allow-list.
      const msg = body.error.code === 21 || body.error.code === "21"
        ? "FatSecret refused this server's IP address — allow it under your FatSecret API key's IP restrictions"
        : `FatSecret: ${body.error.message || "error"}`;
      throw new Error(msg);
    }
    const list = body.foods?.food;
    return (Array.isArray(list) ? list : list ? [list] : []).map(fromFatSecret).filter(Boolean);
  };
}

/* ── ranking ───────────────────────────────────────────────────────────── */

const words = (s) => clean(s).toLowerCase().replace(/[^a-z0-9%' ]+/g, " ").split(" ").filter((w) => w.length > 1).map(singular);
// "Chobani, LLC" names the brand "chobani".
const CORPORATE = new Set(["llc", "inc", "co", "company", "corp", "corporation", "ltd", "the", "brand", "food", "usa", "us", "and"]);
const brandWords = (s) => words(s).filter((w) => !CORPORATE.has(w));

/**
 * Order results by how well they answer what you typed. A brand you named
 * puts that brand's foods first; with no brand named, USDA's generic foods
 * lead (a "cup of rice" is rarely a specific brand's dry-rice label).
 */
export function rank(term, candidates) {
  const q = words(term);
  if (!q.length) return [];
  const brandIntent = (c) => {
    const b = brandWords(c.brand || "");
    return b.length > 0 && b.every((w) => q.includes(w));
  };
  const anyBrand = candidates.some(brandIntent);
  const scored = candidates.map((c) => {
    const hay = new Set([...words(c.name), ...words(c.brand || "")]);
    const hits = q.filter((w) => hay.has(w)).length;
    const rel = hits / q.length;
    const extra = Math.max(0, words(c.name).length - q.length);
    let score = rel - Math.min(0.25, extra * 0.03);
    const intent = brandIntent(c);
    if (intent) score += 1;
    else if (anyBrand && c.branded) score -= 0.3; // another brand than the one you named
    if (!anyBrand) score += c.branded ? -0.15 : 0.2;
    score += { verified: 0.15, database: 0.1 }[c.source.kind] || 0;
    if (c.source.provider === "Open Food Facts") score -= 0.1;
    return { c, rel, score, intent };
  });
  const seen = new Set();
  return scored
    .filter((x) => x.rel >= 0.5)
    .sort((a, b) => b.score - a.score)
    .filter(({ c }) => {
      const k = `${words(c.brand || "").join(" ")}|${words(c.name).join(" ")}|${c.nutrients.kcal}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(({ c, rel, intent }) => {
      const warn = consistencyNote(c.nutrients);
      const out = { ...c, match: rel >= 0.99 ? "exact" : "partial" };
      if (intent) out.brandMatch = true;
      if (warn) out.source = { ...c.source, note: `${c.source.note ? `${c.source.note} ` : ""}${warn}`, confidence: "low" };
      return out;
    });
}

/* ── the lookup service ────────────────────────────────────────────────── */

async function getJson(fetch, url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) throw Object.assign(new Error("rate limit reached"), { code: "rate", status: 429 });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`refused the request (${res.status})`), { code: "auth", status: res.status });
  if (!res.ok) throw Object.assign(new Error(`answered ${res.status}`), { status: res.status });
  return res.json();
}

/** A sliding one-minute window, so a busy afternoon can't get the server IP banned. */
function perMinute(n) {
  let stamps = [];
  return () => {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < 60_000);
    if (stamps.length >= n) return false;
    stamps.push(now);
    return true;
  };
}

const why = (e) => (e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out"
  : e?.message === "fetch failed" ? "couldn't be reached" : e?.message || "failed");

/**
 * createFoodLookup({ store, keys: () => ({ usdaKey, fatsecretId, fatsecretSecret, offEnabled }), fetch })
 *   .search(text) → { query, results, notes, cached, providers }
 */
export function createFoodLookup({ store, keys, fetch = globalThis.fetch }) {
  const offAllowed = perMinute(8); // Open Food Facts asks for ≤ 10 searches a minute
  const cooldown = {}; // provider → time it may be tried again after a rate limit
  let fatsecret = null, fsFor = "";
  let writes = 0;

  const providers = () => {
    const k = keys();
    const list = [];
    list.push({ id: "usda", name: "USDA", run: (t) => usdaSearch(t, { key: k.usdaKey || "DEMO_KEY", fetch }) });
    if (k.fatsecretId && k.fatsecretSecret) {
      if (fsFor !== `${k.fatsecretId}:${k.fatsecretSecret}`) {
        fatsecret = fatSecretClient({ id: k.fatsecretId, secret: k.fatsecretSecret, fetch });
        fsFor = `${k.fatsecretId}:${k.fatsecretSecret}`;
      }
      list.push({ id: "fatsecret", name: "FatSecret", run: (t) => fatsecret(t) });
    }
    if (k.offEnabled !== false) list.push({ id: "off", name: "Open Food Facts", run: (t) => offSearch(t, { fetch }), gate: offAllowed });
    return { list, sig: `${k.usdaKey ? "u" : "d"}${k.fatsecretId ? "f" : ""}${k.offEnabled !== false ? "o" : ""}` };
  };

  async function prune() {
    const all = await store.listItems("lookup");
    const cutoff = Date.now() - CACHE_DAYS * 86400_000;
    const stale = all.filter((x) => !x.at || Date.parse(x.at) < cutoff);
    const keep = all.filter((x) => !stale.includes(x)).sort((a, b) => b.at.localeCompare(a.at));
    for (const x of [...stale, ...keep.slice(CACHE_MAX)]) await store.deleteItem("lookup", x.id);
  }

  /** `fresh` skips the cache (Settings' test button); `only` asks one provider. */
  async function search(text, { fresh = false, only = null } = {}) {
    const query = parseQuery(text);
    const term = query.term.slice(0, 120);
    if (words(term).length === 0) return { query, results: [], notes: [], cached: false, providers: {} };
    const all = providers();
    const list = only ? all.list.filter((p) => p.id === only) : all.list;
    const id = createHash("sha256").update(`${all.sig}|${term.toLowerCase()}`).digest("hex").slice(0, 32);
    const hit = fresh || only ? null : await store.getItem("lookup", id);
    if (hit && Date.parse(hit.at) > Date.now() - CACHE_DAYS * 86400_000) {
      return { query, results: hit.results, notes: [], cached: true, providers: hit.providers || {} };
    }
    const notes = [];
    const status = {};
    const found = await Promise.all(list.map(async (p) => {
      if (cooldown[p.id] > Date.now()) { status[p.id] = "skipped"; notes.push({ provider: p.name, message: "resting after a rate limit — try again in a few minutes" }); return []; }
      if (p.gate && !p.gate()) { status[p.id] = "skipped"; notes.push({ provider: p.name, message: "skipped to stay under its rate limit" }); return []; }
      try {
        const r = await p.run(term);
        status[p.id] = "ok";
        return r;
      } catch (e) {
        status[p.id] = "error";
        if (e.code === "rate") cooldown[p.id] = Date.now() + 10 * 60_000;
        const own = !!keys().usdaKey;
        const msg = p.id === "usda" && e.code === "rate" && !own
          ? `the shared demo key is used up for now — add your own free key in Settings (${USDA_SIGNUP})`
          : p.id === "usda" && e.code === "auth"
            ? own ? `refused your key (${e.status}) — check it in Settings` : `refused the shared demo key (${e.status}) — add your own free key in Settings`
          : p.id === "fatsecret" && e.code === "auth" ? `refused the request (${e.status}) — check the client ID, secret and IP allow-list`
          : why(e);
        notes.push({ provider: p.name, message: msg });
        return [];
      }
    }));
    const results = rank(term, found.flat()).slice(0, 15);
    // Only complete answers are cached; a provider that failed gets another chance next time.
    if (!fresh && !only && Object.values(status).every((s) => s === "ok")) {
      await store.putItem("lookup", id, { id, at: new Date().toISOString(), term, results, providers: status });
      if ((writes += 1) % 20 === 1) prune().catch(() => {});
    }
    return { query, results, notes, cached: false, providers: status };
  }

  return { search, prune };
}
