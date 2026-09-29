/* ──────────────────────────────────────────────────────────────────────────
   The add-food sheet: the fast way into the diary.

     type → your saved foods match instantly
     Enter → USDA / FatSecret / Open Food Facts (cached on the server)
     pick a result → an editable suggestion scaled to what you typed
     nothing right → "Estimate with AI", labelled ESTIMATED, still editable
     Add → the entry is frozen into the day; the food is kept in My foods

   Nothing is saved until you press Add or Save, and every number can be
   changed first. The same sheet builds custom foods and meals.

   It talks to the rest of the page only through the `app` object passed
   to initFoodSheet (state, saving, searching).
   ────────────────────────────────────────────────────────────────────────── */
import { MEALS, NUTRIENTS, UNITS, parseQuery, suggestEntry, nutrientsFor, servingsFor, unitsFor, fmtQty, mealForTime } from "./nutrition.js";
import { cleanFoodEntry } from "./sources.js";
import { matchFoods, recentFoods, favoriteFoods, frequentFoods, customFoods, mealTotals, newId, cleanFood, cleanMeal } from "./library.js";
import { srcTag, macroLine, LIB_TABS } from "./diary.js";
import { fmtInt } from "./metrics.js";
import { esc } from "./charts.js";

const NUT_LABEL = { kcal: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat", fiber: "Fiber" };
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const nowClock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const numOrNull = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));

let app = null;
let dlg = null;
let body = null;
let S = null; // the sheet's state while it's open
let searchSeq = 0;

export function initFoodSheet(api) {
  app = api;
  dlg = document.getElementById("fooddlg");
  body = dlg.querySelector(".fsbody");
  dlg.addEventListener("click", onClick);
  dlg.addEventListener("input", onInput);
  dlg.addEventListener("change", onChange);
  dlg.addEventListener("keydown", onKey);
  dlg.addEventListener("submit", onSubmit);
  dlg.addEventListener("close", () => { S = null; body.innerHTML = ""; });
}

/* ── opening ───────────────────────────────────────────────────────────── */

const defaultMeal = (key) => (key === app.today() ? mealForTime(new Date()) : "dinner");

function show() {
  render();
  if (!dlg.open) dlg.showModal();
  focusFirst();
}

/** Add to a day, optionally to a given meal. */
export function openAdd(key, meal) {
  S = { mode: "diary", key, meal: meal || defaultMeal(key), view: "browse", tab: app.ui().sheetTab || "recent", q: "", remote: null };
  show();
}

/** Edit an entry already in the diary. */
export function openEntry(key, id) {
  const e = (app.state().raw[key]?.manual?.foods || []).find((x) => x.id === id);
  if (!e) return;
  S = { mode: "diary", key, meal: e.meal, view: "edit", q: "", remote: null };
  S.edit = { ...editFromEntry(e, "diary", e.id), meal: e.meal, time: e.time || "", notes: e.notes || "", group: e.group || null };
  show();
}

/**
 * The editor for a logged entry. Entries keep their numbers already
 * scaled; this turns them back into one serving so a new amount scales
 * exactly. If the amount can't be traced back to the serving, what was
 * logged becomes the serving, and nothing is guessed.
 */
function editFromEntry(e, target, entryId) {
  const saved = e.foodId ? foods().find((f) => f.id === e.foodId) : null;
  const portions = saved?.portions || [];
  const k = servingsFor({ serving: e.serving, portions }, e.qty, e.unit);
  let serving = e.serving, qty = e.qty, unit = e.unit;
  const per = {};
  if (k > 0) {
    for (const n of NUTRIENTS) per[n] = e[n] == null ? null : round(e[n] / k, n === "kcal" ? 0 : 1);
  } else {
    for (const n of NUTRIENTS) per[n] = e[n] ?? null;
    serving = { label: fmtQty(e.qty, e.unit, e.serving), amount: 1, unit: "serving" };
    qty = 1; unit = "serving";
  }
  return {
    target, entryId,
    food: { id: saved?.id || null, name: e.name, brand: e.brand || "", serving, nutrients: per, portions, source: e.source, lookupKey: saved?.lookupKey },
    orig: { ...per }, qty, unit, keep: !!e.foodId, favorite: !!saved?.favorite,
  };
}

/** Log a saved food: straight to its editor, at the amount you logged last time. */
export function openLogFood(key, foodId, meal) {
  const f = foods().find((x) => x.id === foodId);
  if (!f) return;
  S = { mode: "diary", key, meal: meal || defaultMeal(key), view: "browse", tab: "recent", q: "", remote: null };
  startEdit(f, f.last ? { qty: f.last.qty, unit: f.last.unit } : null);
  show();
}

/** Create a food, or edit a saved one (My foods). */
export function openFood(foodId) {
  const f = foodId ? foods().find((x) => x.id === foodId) : null;
  S = { mode: "food", view: "edit", q: "", remote: null };
  S.edit = {
    target: "food",
    food: f ? structuredClone(f) : { name: "", brand: "", serving: { label: "1 serving", amount: 1, unit: "serving" }, nutrients: { kcal: null, protein: null, carbs: null, fat: null, fiber: null }, portions: [], source: { kind: "custom" } },
    orig: f ? { ...f.nutrients } : null, qty: 1, unit: "serving", keep: true, favorite: !!f?.favorite, isNew: !f,
  };
  show();
}

/** Build or edit a meal. `draft` pre-fills a new one (e.g. from a diary meal). */
export function openMeal(mealId, draft = null) {
  const m = mealId ? meals().find((x) => x.id === mealId) : null;
  S = { mode: "meal", view: "meal", q: "", remote: null, tab: "recent" };
  S.mealDraft = m ? structuredClone(m) : { id: null, name: draft?.name || "", items: draft?.items || [], favorite: false };
  show();
}

/** Add a whole saved meal to a day. */
export function openMealLog(key, mealId) {
  const m = meals().find((x) => x.id === mealId);
  if (!m) return;
  S = { mode: "diary", key, meal: defaultMeal(key), view: "mealLog", mealId, q: "", remote: null };
  show();
}

/* ── data helpers ──────────────────────────────────────────────────────── */

const foods = () => (app.state().library?.foods || []).filter((f) => !f.archived);
const meals = () => (app.state().library?.meals || []).filter((m) => !m.archived);

function startEdit(food, suggestion, extra = {}) {
  const f = structuredClone(food);
  const sug = suggestion || { qty: 1, unit: "serving" };
  const units = unitsFor(f);
  const unit = units.includes(sug.unit) ? sug.unit : "serving";
  S.edit = {
    target: S.mode === "meal" ? "meal-item" : "diary",
    meal: S.meal, time: S.key === app.today() ? nowClock() : "", notes: "",
    food: { ...f, id: f.id && foods().some((x) => x.id === f.id) ? f.id : existingIdFor(f) },
    orig: { ...f.nutrients }, qty: unit === sug.unit ? sug.qty : 1, unit,
    keep: true, favorite: !!f.favorite, note: sug.note || null, ...extra,
  };
  S.view = "edit";
}

/** A saved food this candidate already matches (same lookup result), if any. */
function existingIdFor(f) {
  if (!f.key && !f.lookupKey) return null;
  const k = f.lookupKey || f.key;
  return foods().find((x) => x.lookupKey === k)?.id || null;
}

/* ── rendering ─────────────────────────────────────────────────────────── */

function render() {
  if (!S) return;
  const v = S.view;
  body.innerHTML = v === "edit" ? editView() : v === "meal" ? mealView() : v === "mealLog" ? mealLogView() : searchView();
  if (v === "browse" || v === "results") renderList();
  if (v === "edit") updateTotal();
}

function focusFirst() {
  const el = body.querySelector("[data-autofocus]") || body.querySelector("input:not([type=hidden])");
  if (el && matchMedia("(pointer: fine)").matches) el.focus();
  else if (el && S?.view !== "edit") el.focus();
}

const mealChips = (current) => `<div class="mchips" role="radiogroup" aria-label="Meal">${MEALS.map((m) =>
  `<button type="button" role="radio" class="mchip${m.id === current ? " on" : ""}" aria-checked="${m.id === current}" data-sa="meal" data-v="${m.id}">${m.label}</button>`).join("")}</div>`;

function headerFor(title, back) {
  const day = S.key ? app.dayLabel(S.key) : "";
  return `<header class="fs-h">
    ${back ? `<button type="button" class="x back" data-sa="${back}" aria-label="Back">‹</button>` : ""}
    <div class="fs-t"><div class="eyebrow">${esc(S.mode === "diary" ? day : S.mode === "meal" ? "Meal" : "My foods")}</div><h2>${esc(title)}</h2></div>
    <button type="button" class="x" data-sa="close" aria-label="Close">×</button>
  </header>`;
}

function searchView() {
  const target = S.mode === "meal" ? `Add to “${S.mealDraft.name || "new meal"}”` : "Add food";
  return `${headerFor(target, S.mode === "meal" ? "to-meal" : null)}
    ${S.mode === "diary" ? mealChips(S.meal) : ""}
    <div class="fs-search"><span class="inp"><input name="q" type="search" autocomplete="off" enterkeyhint="search" data-autofocus
      placeholder="Search or describe a food" value="${esc(S.q)}" aria-label="Search foods"></span>
      <button type="button" class="btn primary" data-sa="search">Search</button></div>
    <p class="fs-hint">Try “2 eggs”, “6 oz chicken breast”, “1 cup white rice” or “Wawa turkey hoagie” — amounts are read for you.</p>
    <div class="fs-list" aria-live="polite"></div>`;
}

function renderList() {
  const el = body.querySelector(".fs-list");
  if (!el) return;
  const q = S.q.trim();
  if (!q) { el.innerHTML = browseList(); return; }
  const parsed = parseQuery(q);
  const local = matchFoods(foods(), parsed.term, 6);
  const quickKcal = /^\s*\d{1,5}\s*(kcal|cal|calories)?\s*$/i.test(q) ? Number(q.match(/\d+/)[0]) : null;
  let html = "";
  if (quickKcal != null) {
    html += `<div class="fs-sec">Quick entry</div><button type="button" class="fsr" data-sa="quick" data-v="${quickKcal}">
      <span class="fn"><b>${fmtInt(quickKcal)} kcal</b><span>Log calories without itemising — add macros if you know them</span></span><span class="fk">${srcTag({ kind: "custom" })}</span></button>`;
  }
  if (local.length) {
    html += `<div class="fs-sec">My foods</div>${local.map((f) => resultRow(f, parsed, "saved")).join("")}`;
  }
  const r = S.remote && S.remote.q === q ? S.remote : null;
  if (S.loading) html += `<div class="fs-sec">Food databases</div><div class="fs-note loading">Searching USDA${app.state().lookup?.fatsecret ? ", FatSecret" : ""}${app.state().lookup?.off !== false ? " and Open Food Facts" : ""}…</div>`;
  else if (r?.error) html += `<div class="fs-sec">Food databases</div><div class="fs-note err">${esc(r.error)}</div>`;
  else if (r) {
    // Results you've already saved show once, under My foods. Rows keep their index into r.results.
    const results = r.results.map((c, i) => [c, i]).filter(([c]) => !local.some((f) => f.lookupKey && f.lookupKey === c.key));
    html += `<div class="fs-sec">Food databases${r.cached ? ` <span class="muted">· saved lookup</span>` : ""}</div>`;
    html += results.length ? results.map(([c, i]) => resultRow(c, parsed, "remote", i)).join("")
      : `<div class="fs-note">Nothing reliable found for “${esc(parsed.term)}”.</div>`;
    for (const n of r.notes || []) html += `<div class="fs-note small">${esc(n.provider)}: ${esc(n.message)}</div>`;
  } else if (quickKcal == null) {
    html += `<button type="button" class="fsr ghost" data-sa="search"><span class="fn"><b>Search food databases for “${esc(parsed.term)}”</b><span>USDA label data first — press Enter</span></span></button>`;
  }
  if (quickKcal == null) html += estimateRow(q, r);
  html += `<button type="button" class="fsr ghost" data-sa="create"><span class="fn"><b>Create a food</b><span>Enter the numbers yourself — like a shake you make every day</span></span></button>`;
  el.innerHTML = html;
}

function estimateRow(q, r) {
  const ai = app.state().lookup?.ai;
  const weak = r && !r.results.some((c) => c.match === "exact");
  if (!ai) {
    return `<div class="fsr ghost disabled"><span class="fn"><b>Estimate with AI</b><span>Add an Anthropic key in Settings → Food lookup to estimate foods no database has</span></span></div>`;
  }
  return `<button type="button" class="fsr ghost${weak ? " hl" : ""}" data-sa="estimate"><span class="fn"><b>${S.estimating ? "Estimating…" : `Estimate “${esc(q)}” with AI`}</b>
    <span>Last resort — labelled ESTIMATED with its confidence, and you check it before saving</span></span>${srcTag({ kind: "estimate", provider: "Claude" })}</button>`;
}

function resultRow(c, parsed, kind, i) {
  const sug = suggestEntry(c, parsed);
  const amount = sug.nutrients ? `${fmtQty(sug.qty, sug.unit, c.serving)} · ${fmtInt(sug.nutrients.kcal)} kcal` : `${esc(c.serving?.label || "1 serving")} · ${fmtInt(c.nutrients.kcal)} kcal`;
  const n = c.nutrients;
  return `<button type="button" class="fsr" data-sa="pick" data-kind="${kind}" data-v="${kind === "saved" ? esc(c.id) : i}">
    <span class="fn"><b>${esc(c.name)}</b><span>${esc([c.brand, c.serving?.label ? `per ${c.serving.label}: ${fmtInt(n.kcal)} kcal · ${macroLine(n)}` : null].filter(Boolean).join(" · "))}</span>
      <span class="sug">${esc(amount)}${sug.note ? ` · ${esc(sug.note)}` : ""}</span></span>
    <span class="fk">${srcTag(c.source)}</span>
  </button>`;
}

function browseList() {
  const tab = S.tab || "recent";
  const tabs = `<div class="tabs" role="tablist">${LIB_TABS.filter(([v]) => S.mode !== "meal" || v !== "meals").map(([v, l]) =>
    `<button type="button" role="tab" class="tab${v === tab ? " on" : ""}" aria-selected="${v === tab}" data-sa="tab" data-v="${v}">${l}</button>`).join("")}</div>`;
  let rows = "";
  if (tab === "meals") {
    const list = meals().sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name));
    rows = list.length ? list.map((m) => {
      const t = mealTotals(m).totals;
      return `<div class="fsrow"><button type="button" class="fsr" data-sa="meal-log" data-v="${esc(m.id)}"><span class="fn"><b>${esc(m.name)}</b>
        <span>${m.items.length} item${m.items.length === 1 ? "" : "s"} · ${fmtInt(t.kcal)} kcal · ${esc(macroLine(t))}</span></span></button></div>`;
    }).join("") : `<div class="fs-note">No meals yet. <button type="button" class="linkbtn" data-sa="new-meal">Build one</button></div>`;
  } else {
    const list = { recent: recentFoods, favorites: favoriteFoods, frequent: frequentFoods, custom: customFoods }[tab](foods(), 25);
    rows = list.length ? list.map((f) => `<div class="fsrow">
        <button type="button" class="fsr" data-sa="pick" data-kind="saved" data-v="${esc(f.id)}"><span class="fn"><b>${esc(f.name)}</b>
          <span>${esc([f.brand, f.last ? fmtQty(f.last.qty, f.last.unit, f.serving) : f.serving?.label].filter(Boolean).join(" · "))} · ${fmtInt((f.last && nutrientsFor(f, f.last.qty, f.last.unit)?.kcal) ?? f.nutrients.kcal)} kcal</span></span>
          <span class="fk">${srcTag(f.source)}</span></button>
        ${S.mode === "diary" ? `<button type="button" class="ib add" data-sa="quick-add" data-v="${esc(f.id)}" title="Add ${esc(f.last ? fmtQty(f.last.qty, f.last.unit, f.serving) : "1 serving")} now" aria-label="Add now">+</button>` : ""}
      </div>`).join("")
      : `<div class="fs-note">${{ recent: "Foods you log will show up here for one-tap re-logging.", favorites: "Star foods to keep them here.", frequent: "Foods you log more than once show up here.", custom: "Foods you create yourself show up here." }[tab]}</div>`;
  }
  return `${tabs}<div class="fs-rows">${rows}</div>
    <button type="button" class="fsr ghost" data-sa="create"><span class="fn"><b>Create a food</b><span>Enter the numbers yourself</span></span></button>`;
}

function editView() {
  const e = S.edit;
  const f = e.food;
  const t = e.target;
  const title = t === "food" ? (e.isNew ? "New food" : "Edit food") : e.entryId != null ? "Edit entry" : t === "meal-item" ? "Add to meal" : "Add food";
  const back = e.entryId != null || t === "food" ? null : "back";
  const src = f.source || { kind: "custom" };
  const est = f.estimate;
  const provenance = `<div class="prov ${src.kind}">
      <div class="pv-top">${srcTag(src, { edited: false })}<span>${esc(src.provider || (src.kind === "custom" ? "Your numbers" : ""))}${src.kind === "estimate" && src.confidence ? ` · ${esc(src.confidence)} confidence` : ""}</span>
        ${src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a>` : ""}</div>
      ${src.note ? `<p>${esc(src.note)}</p>` : ""}
      ${est?.range ? `<p>Likely range: <b>${fmtInt(est.range[0])}–${fmtInt(est.range[1])} kcal</b> per serving.</p>` : ""}
      ${est?.ask ? `<p class="ask">To sharpen it: ${esc(est.ask)}</p>` : ""}
      ${src.kind === "estimate" ? `<p><a href="https://www.google.com/search?q=${encodeURIComponent(`${f.brand || ""} ${f.name} nutrition facts`.trim())}" target="_blank" rel="noopener noreferrer">Check official nutrition ↗</a>${est?.officialSource ? ` — ${esc(est.officialSource)}` : ""}</p>` : ""}
      ${e.note ? `<p class="warn">${esc(e.note)}</p>` : ""}
    </div>`;
  const units = unitsFor(previewFood());
  const unitOpts = units.map((u) => `<option value="${u}"${u === e.unit ? " selected" : ""}>${u === "serving" ? esc(f.serving?.label || "serving") : UNITS[u].many}</option>`).join("");
  const nutInputs = NUTRIENTS.map((n) => `<label class="field"><span>${NUT_LABEL[n]}</span><span class="inp"><input name="n-${n}" type="number" min="0" step="${n === "kcal" ? 1 : 0.1}" inputmode="decimal"
      value="${f.nutrients?.[n] ?? ""}"${n === "kcal" ? " required" : ""} placeholder="${n === "kcal" ? "" : "not listed"}"><em>${n === "kcal" ? "kcal" : "g"}</em></span></label>`).join("");
  const servingEdit = t === "food" || src.kind === "custom" || e.showServing;
  return `<form class="fe-form" novalidate>
    ${headerFor(title, back)}
    ${t === "food" && e.isNew ? "" : provenance}
    <div class="fields two">
      <label class="field"><span>Food</span><span class="inp"><input name="name" maxlength="120" required value="${esc(f.name || "")}"${t === "food" && e.isNew ? " data-autofocus" : ""} placeholder="Specular Protein Shake"></span></label>
      <label class="field"><span>Brand or restaurant</span><span class="inp"><input name="brand" maxlength="80" value="${esc(f.brand || "")}" placeholder="optional"></span></label>
    </div>
    ${t !== "food" ? `<div class="amount">
      <label class="field"><span>Amount</span><span class="inp"><input name="qty" type="number" min="0" step="any" inputmode="decimal" value="${esc(e.qty)}" data-autofocus></span></label>
      <label class="field"><span>Unit</span><span class="inp"><select name="unit">${unitOpts}</select></span></label>
      <div class="grams" data-grams></div>
    </div>` : ""}
    <div class="sec-l">Per serving${f.serving?.label ? ` · ${esc(f.serving.label)}` : ""}</div>
    <div class="fields five">${nutInputs}</div>
    ${servingEdit ? `<div class="fields two">
      <label class="field"><span>One serving is</span><span class="inp"><input name="s-label" maxlength="60" value="${esc(f.serving?.label || "1 serving")}" placeholder="1 shake"></span></label>
      <label class="field"><span>Weighing (optional)</span><span class="inp"><input name="s-grams" type="number" min="0" step="any" inputmode="decimal" value="${esc(f.serving?.grams ?? "")}" placeholder="unknown"><em>g</em></span></label>
    </div><p class="hint small">A weight lets you log this in grams or ounces too. Leave it empty if you don't know it — it won't be guessed.</p>`
      : `<button type="button" class="linkbtn quiet" data-sa="show-serving">Change the serving size</button>`}
    ${t !== "food" ? `<div class="fe-total" data-total></div>` : ""}
    ${t === "diary" ? `${mealChips(e.meal)}
      <div class="fields two">
        <label class="field"><span>Time</span><span class="inp"><input name="time" type="time" value="${esc(e.time || "")}"></span></label>
        <label class="field"><span>Notes</span><span class="inp"><input name="notes" maxlength="300" value="${esc(e.notes || "")}" placeholder="optional"></span></label>
      </div>` : ""}
    <div class="toggles">
      ${t !== "food" ? `<label class="chk"><input type="checkbox" name="keep"${e.keep ? " checked" : ""}><i style="--c:#62D6C4"></i>Keep in My foods${src.kind === "estimate" ? " (stays marked Estimated)" : ""}</label>` : ""}
      <label class="chk"><input type="checkbox" name="favorite"${e.favorite ? " checked" : ""}><i style="--c:#F3E96C"></i>Favorite</label>
    </div>
    <p class="err" data-err hidden></p>
    <footer>
      ${e.entryId != null ? `<button type="button" class="btn danger ghost" data-sa="delete-entry">${t === "meal-item" ? "Remove from meal" : "Delete entry"}</button>` : ""}
      <button type="button" class="btn" data-sa="${back || "close"}">${back ? "Back" : "Cancel"}</button>
      <button type="submit" class="btn primary">${t === "food" ? "Save food" : e.entryId != null ? "Save" : t === "meal-item" ? "Add to meal" : `Add to ${MEALS.find((m) => m.id === e.meal)?.label || "diary"}`}</button>
    </footer>
  </form>`;
}

function mealView() {
  const m = S.mealDraft;
  const { totals } = mealTotals(m);
  const items = m.items.map((it, i) => `<div class="fsrow"><button type="button" class="fsr" data-sa="meal-item" data-v="${i}">
      <span class="fn"><b>${esc(it.name)}</b><span>${esc([it.brand, fmtQty(it.qty, it.unit, it.serving)].filter(Boolean).join(" · "))} · ${esc(macroLine(it))}</span></span>
      <span class="fk"><span><b>${fmtInt(it.kcal)}</b><small>kcal</small></span></span></button>
      <button type="button" class="ib" data-sa="meal-remove" data-v="${i}" aria-label="Remove ${esc(it.name)}" title="Remove">×</button></div>`).join("");
  return `<form class="meal-form" novalidate>
    ${headerFor(m.id ? "Edit meal" : "New meal", null)}
    <label class="field"><span>Name</span><span class="inp"><input name="mname" maxlength="80" required value="${esc(m.name)}" placeholder="Usual breakfast" data-autofocus></span></label>
    <div class="sec-l">Items${m.items.length ? ` · ${fmtInt(totals.kcal)} kcal · ${esc(macroLine(totals))}` : ""}</div>
    <div class="fs-rows">${items || `<div class="fs-note">No items yet.</div>`}</div>
    <button type="button" class="btn" data-sa="meal-add-item">+ Add an item</button>
    <div class="toggles"><label class="chk"><input type="checkbox" name="mfav"${m.favorite ? " checked" : ""}><i style="--c:#F3E96C"></i>Favorite</label></div>
    <p class="hint small">Adding a meal to your diary copies each item in as its own entry, so you can still change any of them that day.</p>
    <p class="err" data-err hidden></p>
    <footer>
      ${m.id ? `<button type="button" class="btn danger ghost" data-sa="meal-delete">Delete</button><button type="button" class="btn" data-sa="meal-dup">Duplicate</button>` : ""}
      <button type="button" class="btn" data-sa="close">Cancel</button>
      <button type="submit" class="btn primary">Save meal</button>
    </footer>
  </form>`;
}

function mealLogView() {
  const m = meals().find((x) => x.id === S.mealId);
  if (!m) return headerFor("Meal not found", null);
  const { totals } = mealTotals(m);
  return `${headerFor(`Add ${m.name}`, "back")}
    ${mealChips(S.meal)}
    <div class="fs-rows">${m.items.map((it) => `<div class="fsr static"><span class="fn"><b>${esc(it.name)}</b><span>${esc(fmtQty(it.qty, it.unit, it.serving))} · ${esc(macroLine(it))}</span></span>
      <span class="fk"><span><b>${fmtInt(it.kcal)}</b><small>kcal</small></span></span></div>`).join("")}</div>
    <div class="fe-total"><b>${fmtInt(totals.kcal)}</b> kcal · ${esc(macroLine(totals))}</div>
    <p class="hint small">Each item goes into the diary as its own entry — change any of them afterwards.</p>
    <footer><button type="button" class="btn" data-sa="back">Back</button>
      <button type="button" class="btn primary" data-sa="meal-add-all">Add to ${MEALS.find((x) => x.id === S.meal).label}</button></footer>`;
}

/* ── the editor's live numbers ─────────────────────────────────────────── */

/** The food as the form currently describes it. */
function previewFood() {
  const e = S.edit;
  const form = body.querySelector(".fe-form");
  const f = structuredClone(e.food);
  if (form) {
    for (const n of NUTRIENTS) {
      const el = form.elements[`n-${n}`];
      if (el) f.nutrients[n] = numOrNull(el.value);
    }
    const sl = form.elements["s-label"], sg = form.elements["s-grams"];
    if (sl || sg) {
      f.serving = { ...(f.serving || {}), label: sl?.value.trim() || f.serving?.label || "1 serving" };
      const grams = numOrNull(sg?.value);
      if (grams) f.serving.grams = grams; else if (sg) delete f.serving.grams;
      if (f.serving.unit === "g" && !grams) f.serving.unit = "serving";
    }
  }
  return f;
}

function readForm() {
  const e = S.edit;
  const form = body.querySelector(".fe-form");
  if (!form) return;
  const f = previewFood();
  f.name = form.elements.name.value.trim();
  f.brand = form.elements.brand.value.trim();
  e.food = f;
  if (form.elements.qty) e.qty = numOrNull(form.elements.qty.value) ?? e.qty;
  if (form.elements.unit) e.unit = form.elements.unit.value;
  if (form.elements.time) e.time = form.elements.time.value;
  if (form.elements.notes) e.notes = form.elements.notes.value.trim();
  if (form.elements.keep) e.keep = form.elements.keep.checked;
  if (form.elements.favorite) e.favorite = form.elements.favorite.checked;
}

function updateTotal() {
  const el = body.querySelector("[data-total]");
  if (!el) return;
  const form = body.querySelector(".fe-form");
  const f = previewFood();
  const qty = numOrNull(form.elements.qty?.value);
  const unit = form.elements.unit?.value || "serving";
  const v = qty == null ? null : nutrientsFor(f, qty, unit);
  const g = body.querySelector("[data-grams]");
  if (g) {
    const s = f.serving || {};
    g.textContent = unit === "serving" && s.grams ? `= ${round((qty || 0) * s.grams, 0)} g` : "";
  }
  el.innerHTML = v?.kcal != null
    ? `<span class="lbl">This entry</span><b>${fmtInt(v.kcal)}</b> kcal · ${esc(macroLine(v))}${v.fiber != null ? ` · Fiber ${round(v.fiber)}` : ""}`
    : `<span class="lbl">This entry</span><span class="muted">Enter an amount and calories</span>`;
}

/* ── saving ────────────────────────────────────────────────────────────── */

function fail(msg) {
  const el = body.querySelector("[data-err]");
  if (el) { el.textContent = msg; el.hidden = false; }
}

function changedFrom(orig, now) {
  if (!orig) return false;
  return NUTRIENTS.some((n) => (orig[n] ?? null) !== (now[n] ?? null));
}

/** The saved-food record for what's in the editor. */
function libraryFood() {
  const e = S.edit;
  const f = e.food;
  const saved = f.id ? (app.state().library?.foods || []).find((x) => x.id === f.id) : null;
  const edited = f.source?.kind !== "custom" && (changedFrom(e.orig, f.nutrients) || !!f.source?.edited);
  return cleanFood({
    ...(saved || {}),
    // A sample food becomes your own copy the first time you keep it.
    id: saved?.id && !saved.id.startsWith("demo_") ? saved.id : newId("food_"),
    name: f.name, brand: f.brand || undefined, serving: f.serving, nutrients: f.nutrients, portions: f.portions || saved?.portions || [],
    source: { ...(f.source || { kind: "custom" }), ...(edited ? { edited: true } : {}) },
    lookupKey: f.lookupKey || f.key || saved?.lookupKey,
    favorite: e.favorite,
    last: e.target === "food" ? saved?.last : { qty: e.qty, unit: e.unit },
    uses: saved?.uses,
    archived: false,
    createdAt: saved?.createdAt,
  });
}

async function saveEdit() {
  readForm();
  const e = S.edit;
  const f = e.food;
  if (!f.name) return fail("Give the food a name.");
  if (f.nutrients.kcal == null) return fail("Calories are needed — everything else can stay “not listed”.");
  if (e.target === "food") {
    const food = libraryFood();
    await app.saveFood(food);
    close();
    return;
  }
  const n = nutrientsFor(f, e.qty, e.unit);
  if (!n || !(e.qty > 0)) return fail(`That amount can't be converted for this food — pick another unit.`);
  const edited = f.source?.kind !== "custom" && (changedFrom(e.orig, f.nutrients) || !!f.source?.edited);
  let foodId = null;
  if (e.keep) {
    const food = libraryFood();
    foodId = food.id;
    app.saveFoodLater(food);
  }
  const entry = cleanFoodEntry({
    id: e.entryId || undefined, meal: e.meal, name: f.name, brand: f.brand, qty: e.qty, unit: e.unit, serving: f.serving,
    ...n, source: { ...(f.source || { kind: "custom" }), ...(edited ? { edited: true } : {}) },
    foodId: foodId || undefined, time: e.time, notes: e.notes, group: e.group || undefined,
  });
  if (e.target === "meal-item") {
    delete entry.meal; delete entry.time; delete entry.group;
    const items = S.mealDraft.items;
    if (e.entryId != null && items[e.entryId]) items[e.entryId] = entry; else items.push(entry);
    S.view = "meal";
    render();
    return;
  }
  await app.saveEntries(S.key, [entry], { replace: e.entryId ? [e.entryId] : [] });
  close();
}

async function saveMeal() {
  const form = body.querySelector(".meal-form");
  const m = S.mealDraft;
  m.name = form.elements.mname.value.trim();
  m.favorite = form.elements.mfav.checked;
  if (!m.name) return fail("Name the meal.");
  if (!m.items.length) return fail("Add at least one item.");
  const meal = cleanMeal({ ...m, id: m.id || newId("meal_") });
  await app.saveMeal(meal);
  close();
}

function close() { if (dlg.open) dlg.close(); }
/** Leaving the page closes the sheet; nothing unsaved is kept. */
export function closeSheet() { close(); }

/* ── events ────────────────────────────────────────────────────────────── */

async function doSearch() {
  const q = S.q.trim();
  if (!q) return;
  const seq = (searchSeq += 1);
  S.loading = true;
  renderList();
  try {
    const r = await app.search(q);
    if (seq !== searchSeq || !S) return;
    S.remote = { q, ...r };
  } catch (err) {
    if (seq !== searchSeq || !S) return;
    S.remote = { q, error: err.message || "The lookup failed", results: [], notes: [] };
  }
  S.loading = false;
  renderList();
}

async function doEstimate() {
  const q = S.q.trim();
  if (!q || S.estimating) return;
  S.estimating = true;
  renderList();
  try {
    const food = await app.estimate(q);
    if (!S) return;
    S.estimating = false;
    startEdit(food, food.estimate ? { qty: food.estimate.qty, unit: food.estimate.unit } : null);
    render();
    focusFirst();
  } catch (err) {
    if (!S) return;
    S.estimating = false;
    S.remote = { q, error: err.message, results: S.remote?.results || [], notes: S.remote?.notes || [] };
    renderList();
  }
}

function pick(el) {
  const parsed = parseQuery(S.q || "");
  let food;
  if (el.dataset.kind === "saved") food = foods().find((f) => f.id === el.dataset.v);
  else food = S.remote?.results?.[Number(el.dataset.v)];
  if (!food) return;
  const fromSearch = !!S.q.trim();
  const sug = fromSearch ? suggestEntry(food, parsed) : food.last ? { qty: food.last.qty, unit: food.last.unit } : null;
  startEdit(food, sug);
  render();
  focusFirst();
}

async function onClick(ev) {
  if (ev.target === dlg) { close(); return; }
  const el = ev.target.closest("[data-sa]");
  if (!el || !S) return;
  const a = el.dataset.sa;
  if (a === "close") return close();
  if (a === "meal") {
    S.meal = el.dataset.v;
    if (S.edit && S.view === "edit") { readForm(); S.edit.meal = el.dataset.v; }
    const keepFocus = document.activeElement?.name;
    render();
    if (keepFocus) body.querySelector(`[name="${keepFocus}"]`)?.focus();
    return;
  }
  if (a === "search") { S.q = body.querySelector("input[name=q]")?.value ?? S.q; if (S.view === "browse" && S.q.trim()) S.view = "results"; return doSearch(); }
  if (a === "estimate") return doEstimate();
  if (a === "tab") { S.tab = el.dataset.v; app.ui().sheetTab = S.tab; renderList(); return; }
  if (a === "pick") return pick(el);
  if (a === "quick-add") {
    const f = foods().find((x) => x.id === el.dataset.v);
    if (!f) return;
    const qty = f.last?.qty ?? 1, unit = f.last && unitsFor(f).includes(f.last.unit) ? f.last.unit : "serving";
    const n = nutrientsFor(f, qty, unit);
    const entry = cleanFoodEntry({ meal: S.meal, name: f.name, brand: f.brand, qty, unit, serving: f.serving, ...n, source: f.source, foodId: f.id, time: S.key === app.today() ? nowClock() : undefined });
    app.saveFoodLater(cleanFood({ ...f, last: { qty, unit } }));
    await app.saveEntries(S.key, [entry], { replace: [] });
    el.classList.add("done");
    el.textContent = "✓";
    app.toast(`Added ${f.name} to ${MEALS.find((m) => m.id === S.meal).label.toLowerCase()}`);
    return;
  }
  if (a === "quick") {
    S.edit = null;
    startEdit({ name: "Quick calories", serving: { label: "1 entry", amount: 1, unit: "serving" }, nutrients: { kcal: Number(el.dataset.v), protein: null, carbs: null, fat: null, fiber: null }, source: { kind: "custom" } }, { qty: 1, unit: "serving" }, { keep: false });
    render();
    return;
  }
  if (a === "create") {
    const name = S.q.trim() && !/^\d/.test(S.q.trim()) ? S.q.trim() : "";
    startEdit({ name, brand: "", serving: { label: "1 serving", amount: 1, unit: "serving" }, nutrients: { kcal: null, protein: null, carbs: null, fat: null, fiber: null }, portions: [], source: { kind: "custom" } }, { qty: 1, unit: "serving" }, { showServing: true });
    render();
    body.querySelector("input[name=name]")?.focus();
    return;
  }
  if (a === "back") { S.view = S.q.trim() ? "results" : "browse"; S.edit = null; render(); focusFirst(); return; }
  if (a === "show-serving") { readForm(); S.edit.showServing = true; render(); return; }
  if (a === "delete-entry") {
    const e = S.edit;
    if (e.target === "meal-item") { S.mealDraft.items.splice(e.entryId, 1); S.view = "meal"; render(); return; }
    await app.removeEntry(S.key, e.entryId);
    close();
    return;
  }
  // meals
  if (a === "new-meal") { openMeal(null); return; }
  if (a === "meal-log") { S.mealId = el.dataset.v; S.view = "mealLog"; render(); return; }
  if (a === "meal-add-all") {
    const m = meals().find((x) => x.id === S.mealId);
    const t = S.key === app.today() ? nowClock() : undefined;
    const entries = m.items.map((it) => cleanFoodEntry({ ...it, id: undefined, meal: S.meal, time: t, group: { id: m.id, name: m.name } })).filter(Boolean);
    await app.saveEntries(S.key, entries, { replace: [] });
    app.toast(`Added ${m.name} — ${entries.length} item${entries.length === 1 ? "" : "s"}`);
    close();
    return;
  }
  if (a === "meal-item") {
    syncMealName();
    const i = Number(el.dataset.v);
    S.edit = editFromEntry(S.mealDraft.items[i], "meal-item", i);
    S.view = "edit";
    render();
    return;
  }
  if (a === "meal-remove") { syncMealName(); S.mealDraft.items.splice(Number(el.dataset.v), 1); render(); return; }
  if (a === "meal-add-item") { syncMealName(); S.view = "browse"; S.q = ""; S.remote = null; render(); focusFirst(); return; }
  if (a === "to-meal") { S.view = "meal"; render(); return; }
  if (a === "meal-delete") {
    if (!confirm(`Delete “${S.mealDraft.name}”? Diary entries already logged from it stay.`)) return;
    await app.deleteMeal(S.mealDraft.id);
    close();
    return;
  }
  if (a === "meal-dup") {
    syncMealName();
    S.mealDraft = { ...structuredClone(S.mealDraft), id: null, name: `${S.mealDraft.name} (copy)`, favorite: false };
    render();
    return;
  }
}

function syncMealName() {
  const form = body.querySelector(".meal-form");
  if (form) { S.mealDraft.name = form.elements.mname.value; S.mealDraft.favorite = form.elements.mfav.checked; }
}

let typing;
function onInput(ev) {
  if (!S) return;
  const t = ev.target;
  if (t.name === "q") {
    S.q = t.value;
    S.view = S.q.trim() ? "results" : "browse";
    clearTimeout(typing);
    typing = setTimeout(renderList, 60);
    return;
  }
  if (S.view === "edit") {
    if (t.name === "s-grams" || t.name === "s-label") refreshUnits();
    updateTotal();
  }
}

function onChange(ev) {
  if (!S || S.view !== "edit") return;
  if (ev.target.name === "s-grams" || ev.target.name === "s-label") refreshUnits();
  updateTotal();
}

/** A new serving weight changes which units make sense; only the unit list is redrawn. */
function refreshUnits() {
  const sel = body.querySelector("select[name=unit]");
  if (!sel) return;
  const f = previewFood();
  const units = unitsFor(f);
  const current = units.includes(sel.value) ? sel.value : "serving";
  sel.innerHTML = units.map((u) => `<option value="${u}"${u === current ? " selected" : ""}>${u === "serving" ? esc(f.serving?.label || "serving") : UNITS[u].many}</option>`).join("");
}

function onKey(ev) {
  if (!S) return;
  if (ev.key === "Enter" && ev.target.name === "q") {
    ev.preventDefault();
    S.q = ev.target.value;
    if (!S.q.trim()) return;
    S.view = "results";
    doSearch();
  }
}

function onSubmit(ev) {
  ev.preventDefault();
  if (!S) return;
  const p = S.view === "edit" ? saveEdit() : S.view === "meal" ? saveMeal() : null;
  p?.catch((err) => fail(err.message || "Couldn't save"));
}
