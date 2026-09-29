/* ──────────────────────────────────────────────────────────────────────────
   AI nutrition estimates — the last resort, only when you ask for one.

   Claude reads what you typed ("Wawa turkey hoagie") and returns its best
   estimate for one serving, how many servings you described, a calorie
   range, its confidence, and what the numbers are based on. The page
   labels the result ESTIMATED and opens it for editing; nothing is saved
   until you confirm it.

   The key and model are set in Settings → Food lookup (or the
   ANTHROPIC_API_KEY variable). Refusal fallbacks are on: if the model
   declines a request, the API retries it on its default fallback model.
   ────────────────────────────────────────────────────────────────────────── */
import { createHash } from "node:crypto";
import { UNIT_IDS } from "../js/nutrition.js";

export const AI_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — most accurate" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — cheaper" },
];
export const DEFAULT_MODEL = AI_MODELS[0].id;
const CACHE_DAYS = 30;

const nullable = (type, description) => ({ anyOf: [{ type }, { type: "null" }], description });

export const ESTIMATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    isFood: { type: "boolean", description: "false if the text isn't a food or drink" },
    name: { type: "string", description: "Short name for the food, e.g. 'Turkey hoagie (classic)'" },
    brand: nullable("string", "Brand or restaurant, if any"),
    servingLabel: { type: "string", description: "One serving as a person would say it: '1 classic hoagie', '1 large egg', '1 cup cooked'" },
    servingUnit: { type: "string", enum: UNIT_IDS, description: "Unit of one serving; 'serving' when it's a whole item like a sandwich" },
    servingAmount: { type: "number", description: "How many servingUnits make one serving (1 for '1 large egg'; 100 for '100 g')" },
    servingGrams: nullable("number", "Approximate weight of one serving in grams, if meaningful"),
    quantity: { type: "number", description: "How many servings the text describes (2 for '2 eggs'; 1 if not stated)" },
    kcal: { type: "number", description: "Calories in ONE serving" },
    protein: nullable("number", "Grams of protein in one serving"),
    carbs: nullable("number", "Grams of carbohydrate in one serving"),
    fat: nullable("number", "Grams of fat in one serving"),
    fiber: nullable("number", "Grams of fiber in one serving"),
    kcalLow: { type: "number", description: "Low end of a realistic calorie range for one serving" },
    kcalHigh: { type: "number", description: "High end of a realistic calorie range for one serving" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    basis: { type: "string", description: "One or two plain sentences: what the numbers are based on and what's uncertain" },
    officialSource: nullable("string", "Where official numbers could be checked, e.g. 'Wawa's nutrition guide on wawa.com'"),
    ask: nullable("string", "One short question that would sharpen the estimate (size, toppings, preparation), or null"),
  },
  required: [
    "isFood", "name", "brand", "servingLabel", "servingUnit", "servingAmount", "servingGrams", "quantity",
    "kcal", "protein", "carbs", "fat", "fiber", "kcalLow", "kcalHigh", "confidence", "basis", "officialSource", "ask",
  ],
};

const SYSTEM = `You estimate nutrition for one food a person is logging in their personal food diary. They will review and edit your numbers before anything is saved.

- If you know the manufacturer's or restaurant's published nutrition for this exact item, use it, say so in "basis", and note that menus and recipes change.
- Otherwise estimate from typical recipes and portions, and say that's what you did.
- Nutrients are for ONE serving; "quantity" is how many servings they described.
- Never imply more precision than you have. confidence: "high" for published values you're sure of, "medium" for typical values of a well-defined food, "low" when the item, size or recipe is unclear.
- Give a realistic calorie range for one serving in kcalLow and kcalHigh.
- Use null for a nutrient you can't reasonably estimate. Never use 0 to mean unknown.
- If the description is ambiguous, estimate the most common version and put one short question in "ask".
- If the text isn't a food or drink, set isFood to false and fill the rest with your best neutral placeholders.`;

export class EstimateError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function defaultClient(apiKey) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return { sdk: Anthropic, client: new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 }) };
}

/** The request body. The default model also opts into refusal fallbacks ("default"). */
export function estimateRequest(text, model = DEFAULT_MODEL) {
  const req = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: ESTIMATE_SCHEMA } },
    messages: [{ role: "user", content: `Food: ${text}` }],
  };
  if (model === "claude-opus-5-5") {
    req.betas = ["server-side-fallback-2026-07-01"];
    req.fallbacks = "default";
  }
  return req;
}

/** Claude's answer → a candidate food shaped like the lookup results, labelled as an estimate. */
export function toCandidate(out, text, model) {
  const unit = UNIT_IDS.includes(out.servingUnit) ? out.servingUnit : "serving";
  const serving = { label: String(out.servingLabel || "1 serving").slice(0, 60), amount: out.servingAmount > 0 ? out.servingAmount : 1, unit };
  if (out.servingGrams > 0) serving.grams = Math.round(out.servingGrams * 10) / 10;
  if (unit === "g") serving.grams = serving.amount;
  const nz = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
  const low = nz(out.kcalLow), high = nz(out.kcalHigh);
  const conf = ["high", "medium", "low"].includes(out.confidence) ? out.confidence : "low";
  const qty = out.quantity > 0 ? out.quantity : 1;
  return {
    key: `ai:${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 16)}`,
    name: String(out.name || text).slice(0, 120),
    brand: out.brand ? String(out.brand).slice(0, 80) : undefined,
    serving,
    nutrients: { kcal: Math.round(nz(out.kcal) ?? 0), protein: nz(out.protein), carbs: nz(out.carbs), fat: nz(out.fat), fiber: nz(out.fiber) },
    portions: [],
    source: {
      kind: "estimate", provider: "Claude", ref: model,
      note: String(out.basis || "An AI estimate.").slice(0, 300),
      confidence: conf,
    },
    estimate: {
      range: low != null && high != null && high >= low ? [Math.round(low), Math.round(high)] : null,
      ask: out.ask ? String(out.ask).slice(0, 200) : null,
      officialSource: out.officialSource ? String(out.officialSource).slice(0, 200) : null,
      qty: unit === "piece" ? qty * serving.amount : qty,
      unit: unit === "piece" ? "piece" : "serving",
    },
    branded: !!out.brand,
  };
}

/**
 * createEstimator({ store, keys: () => ({ anthropicKey, anthropicModel }), makeClient })
 *   .estimate(text) → candidate
 * Answers are cached per model and text for 30 days, so asking twice gives
 * the same numbers and costs nothing.
 */
export function createEstimator({ store, keys, makeClient = defaultClient }) {
  let cached = null, cachedFor = "";

  async function estimate(rawText) {
    const text = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) throw new EstimateError("Type a food first", 400);
    const { anthropicKey, anthropicModel } = keys();
    if (!anthropicKey) throw new EstimateError("Add an Anthropic API key in Settings → Food lookup to use AI estimates", 400);
    const model = AI_MODELS.some((m) => m.id === anthropicModel) ? anthropicModel : DEFAULT_MODEL;
    const id = createHash("sha256").update(`${model}|${text.toLowerCase()}`).digest("hex").slice(0, 32);
    const hit = await store.getItem("estimate", id);
    if (hit && Date.parse(hit.at) > Date.now() - CACHE_DAYS * 86400_000) return { ...hit.food, cached: true };

    if (!cached || cachedFor !== anthropicKey) { cached = await makeClient(anthropicKey); cachedFor = anthropicKey; }
    const { sdk, client } = cached;
    let res;
    try {
      res = await client.beta.messages.create(estimateRequest(text, model));
    } catch (e) {
      if (sdk && e instanceof sdk.AuthenticationError) throw new EstimateError("Anthropic refused the API key — check it in Settings → Food lookup", 400);
      if (sdk && e instanceof sdk.PermissionDeniedError) throw new EstimateError("This Anthropic key can't use that model — pick another in Settings → Food lookup", 400);
      if (sdk && e instanceof sdk.RateLimitError) throw new EstimateError("Anthropic's rate limit was reached — try again in a minute", 429);
      if (sdk && e instanceof sdk.APIConnectionError) throw new EstimateError("Couldn't reach Anthropic — check the server's network", 502);
      if (sdk && e instanceof sdk.APIError) throw new EstimateError(`Anthropic returned an error (${e.status ?? "unknown"})`, 502);
      throw e;
    }
    if (res.stop_reason === "refusal") throw new EstimateError("The model declined to estimate this — enter the numbers yourself", 422);
    if (res.stop_reason === "max_tokens") throw new EstimateError("The estimate was cut off — try a shorter description", 502);
    const block = (res.content || []).find((b) => b.type === "text");
    let out;
    try { out = JSON.parse(block?.text ?? ""); } catch { throw new EstimateError("The estimate came back unreadable — try again", 502); }
    if (!out.isFood) throw new EstimateError("That doesn't look like a food or drink", 422);
    const food = toCandidate(out, text, res.model || model);
    await store.putItem("estimate", id, { id, at: new Date().toISOString(), text, food });
    return food;
  }

  /** Settings' test button: checks the key and model without generating anything. */
  async function test() {
    const { anthropicKey, anthropicModel } = keys();
    if (!anthropicKey) return { ok: false, message: "No key yet" };
    const model = AI_MODELS.some((m) => m.id === anthropicModel) ? anthropicModel : DEFAULT_MODEL;
    if (!cached || cachedFor !== anthropicKey) { cached = await makeClient(anthropicKey); cachedFor = anthropicKey; }
    const { sdk, client } = cached;
    try {
      await client.models.retrieve(model);
      return { ok: true, message: `Working — ${model} is available to this key` };
    } catch (e) {
      if (sdk && e instanceof sdk.AuthenticationError) return { ok: false, message: "Anthropic refused this key" };
      if (sdk && (e instanceof sdk.NotFoundError || e instanceof sdk.PermissionDeniedError)) return { ok: false, message: `This key can't use ${model}` };
      if (sdk && e instanceof sdk.APIConnectionError) return { ok: false, message: "Couldn't reach Anthropic from the server" };
      if (sdk && e instanceof sdk.APIError) return { ok: false, message: `Anthropic returned an error (${e.status ?? "unknown"})` };
      throw e;
    }
  }

  return { estimate, test };
}
