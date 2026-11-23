/* ──────────────────────────────────────────────────────────────────────────
   Nutrition page: the portion calculator (sliders per recipe, combined
   totals, what's left today, saved combinations, one-tap logging) and the
   recipe library (batches, cooked weights, grocery lists). The arithmetic
   is js/recipes.js; this lays it out and patches the numbers in place
   while you drag, so the sliders stay smooth.
   ────────────────────────────────────────────────────────────────────────── */
import { currentVersion, per100, portion, proteinEfficiency, efficiencyWord, calcTotals, versionTotals, ingredientGrams, groceryList, ING_UNITS, ING_STATES } from "./recipes.js";
import { MEALS, mealForTime } from "./nutrition.js";
import { esc, tip } from "./charts.js";
import { fmtInt } from "./metrics.js";
import { ICON } from "./diary.js";

const r1 = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, ""));
const KEY = "ash-health-calc";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateShort = (iso) => { const d = new Date(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };

const liveRecipes = (ctx) => (ctx.state.library?.recipes || []).filter((r) => !r.archived);
const byId = (ctx, id) => (ctx.state.library?.recipes || []).find((r) => r.id === id);

/** The calculator's rows ({ id, grams }), remembered in this browser; first time, your top two recipes. */
export function calcState(ui, ctx) {
  if (!ui.calc) {
    try { ui.calc = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { ui.calc = null; }
  }
  if (!ui.calc || !Array.isArray(ui.calc.rows)) {
    const top = [...liveRecipes(ctx)].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.uses?.count || 0) - (a.uses?.count || 0)).slice(0, 2);
    ui.calc = { rows: top.map((r) => ({ id: r.id, grams: r.defaultPortion })), meal: null };
  }
  ui.calc.rows = ui.calc.rows.filter((x) => byId(ctx, x.id) && !byId(ctx, x.id).archived);
  return ui.calc;
}
export function saveCalc(ui) {
  try { localStorage.setItem(KEY, JSON.stringify(ui.calc)); } catch { /* private mode: fine, it just won't be remembered */ }
}

/** Numbers for the calculator as it stands: rows, totals, today's logged food, targets and what's left. */
export function calcNumbers(ctx, dayKey) {
  const c = calcState(ctx.ui, ctx);
  const rows = c.rows.map((x) => ({ ...x, recipe: byId(ctx, x.id) }));
  const t = calcTotals(rows);
  const d = ctx.days[dayKey] || {};
  const logged = { kcal: d.kcal || 0, protein: d.protein || 0 };
  const g = ctx.g;
  const lo = g.kcalLow || g.kcalTarget - 100, hi = g.kcalHigh || g.kcalTarget + 100;
  const after = { kcal: logged.kcal + t.total.kcal, protein: logged.protein + t.total.protein };
  return { ...t, logged, after, lo, hi, protein: g.protein, eff: proteinEfficiency(t.total) };
}

const leftText = (n) => {
  const kLeftLo = n.lo - n.after.kcal, kLeftHi = n.hi - n.after.kcal;
  const kcal = kLeftHi < 0 ? `<b class="over">${fmtInt(-kLeftHi)} kcal over</b> your ${fmtInt(n.hi)} top end` : kLeftLo > 0 ? `<b>${fmtInt(kLeftLo)}–${fmtInt(kLeftHi)} kcal</b> left` : `<b>in your range</b> (up to ${fmtInt(kLeftHi)} more)`;
  const pLeft = n.protein - n.after.protein;
  const prot = pLeft > 0 ? `<b>${fmtInt(pLeft)} g protein</b> to go` : `<b>protein target met</b> (+${fmtInt(-pLeft)} g)`;
  return `${kcal} · ${prot}`;
};

const effHtml = (e) => (e == null ? "" : `<span class="eff ${e <= 8 ? "a" : e <= 12 ? "b" : e <= 18 ? "c" : "d"}" ${tip("Protein efficiency", `${r1(e)} kcal per gram of protein`, "Lower means more protein for the calories")}>${r1(e)} kcal/g protein</span>`);

/* ── the portion calculator ────────────────────────────────────────────── */

export function calculatorCard(ctx, dayKey) {
  const c = calcState(ctx.ui, ctx);
  const n = calcNumbers(ctx, dayKey);
  const all = liveRecipes(ctx);
  const combos = ctx.state.library?.combos || [];
  const add = all.filter((r) => !c.rows.some((x) => x.id === r.id));
  const meal = c.meal || mealForTime();
  const rows = n.rows.map((x, i) => {
    const v = currentVersion(x.recipe), p = per100(v);
    return `<div class="crow" data-crow="${i}">
      <div class="cr-h"><b>${esc(x.recipe.name)}</b><span class="cr-v">${esc(v.label)}${x.recipe.example ? ` <span class="etag est">Example</span>` : ""}</span>
        <button type="button" class="ib" data-act="calc-del" data-i="${i}" title="Remove" aria-label="Remove ${esc(x.recipe.name)}">×</button></div>
      <div class="cr-s"><input type="range" min="0" max="1000" step="25" value="${Math.min(1000, x.grams)}" data-calc="slide" data-i="${i}" aria-label="${esc(x.recipe.name)} portion in grams">
        <span class="inp"><input type="number" min="0" max="5000" step="1" inputmode="numeric" value="${x.grams}" data-calc="grams" data-i="${i}" aria-label="Grams"><em>g</em></span></div>
      <div class="cr-n"><span><b data-k="kcal">${fmtInt(x.n.kcal)}</b> kcal</span><span><b data-k="protein">${r1(x.n.protein)}</b> g protein</span><span><b data-k="carbs">${r1(x.n.carbs)}</b> g carbs</span><span><b data-k="fat">${r1(x.n.fat)}</b> g fat</span><span><b data-k="fiber">${r1(x.n.fiber)}</b> g fiber</span></div>
      <div class="cr-meta">per 100 g: ${p ? `${fmtInt(p.kcal)} kcal · ${r1(p.protein)} g protein` : "needs a cooked weight"} · ${effHtml(proteinEfficiency(p))}${x.grams !== x.recipe.defaultPortion ? ` · <button type="button" class="linkbtn quiet" data-act="calc-default" data-i="${i}">Make ${x.grams} g the default</button>` : ` · default portion`}</div>
    </div>`;
  }).join("");
  const pct = (v, max) => Math.max(0, Math.min(100, (v / max) * 100));
  const kmax = Math.max(n.hi * 1.15, n.after.kcal), pmax = Math.max(n.protein * 1.2, n.after.protein);
  return `<section class="card calccard" id="calculator">
    <div class="cardhead"><h2>Portion calculator <span class="sub">weigh it, slide it, see how it fits</span></h2>
      <div class="actions">${add.length ? `<span class="inp"><select data-calc="add" aria-label="Add a recipe"><option value="">+ Add a recipe…</option>${add.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select></span>` : ""}<button type="button" class="btn" data-act="rec-new">New recipe</button></div></div>
    ${combos.length ? `<div class="ochips"><span class="ol">Saved</span>${combos.map((cb) => `<span class="combo"><button type="button" class="ochip" data-act="combo-load" data-v="${cb.id}">${esc(cb.name)}</button><button type="button" class="ib" data-act="combo-del" data-v="${cb.id}" title="Delete" aria-label="Delete ${esc(cb.name)}">×</button></span>`).join("")}</div>` : ""}
    <div class="crows">${rows || `<div class="nodata">Add a recipe above to size a portion.</div>`}</div>
    ${n.rows.length ? `<div class="ctotal">
      <div class="ct-n"><span class="ea-l">${n.rows.length > 1 ? "Together" : "This portion"}</span>
        <div class="ct-v"><span><b data-t="kcal">${fmtInt(n.total.kcal)}</b> kcal</span><span><b data-t="protein">${r1(n.total.protein)}</b> g protein</span><span><b data-t="carbs">${r1(n.total.carbs)}</b> g carbs</span><span><b data-t="fat">${r1(n.total.fat)}</b> g fat</span><span><b data-t="fiber">${r1(n.total.fiber)}</b> g fiber</span><span data-t="eff">${effHtml(n.eff)}</span></div></div>
      <div class="ct-bars">
        <div class="ctb"><span>Calories today</span><div class="ctb-bar"><i class="zone" style="left:${pct(n.lo, kmax).toFixed(1)}%;width:${(pct(n.hi, kmax) - pct(n.lo, kmax)).toFixed(1)}%"></i><i class="logged" style="width:${pct(n.logged.kcal, kmax).toFixed(1)}%"></i><i class="adds" data-bar="kcal" style="left:${pct(n.logged.kcal, kmax).toFixed(1)}%;width:${(pct(n.after.kcal, kmax) - pct(n.logged.kcal, kmax)).toFixed(1)}%"></i></div><em data-t="kcalline">${fmtInt(n.logged.kcal)} logged + <b>${fmtInt(n.total.kcal)}</b> here = ${fmtInt(n.after.kcal)} of ${fmtInt(n.lo)}–${fmtInt(n.hi)}</em></div>
        <div class="ctb"><span>Protein today</span><div class="ctb-bar"><i class="zone p" style="left:${pct(n.protein - 10, pmax).toFixed(1)}%;width:${(pct(n.protein + 10, pmax) - pct(n.protein - 10, pmax)).toFixed(1)}%"></i><i class="logged" style="width:${pct(n.logged.protein, pmax).toFixed(1)}%"></i><i class="adds p" data-bar="protein" style="left:${pct(n.logged.protein, pmax).toFixed(1)}%;width:${(pct(n.after.protein, pmax) - pct(n.logged.protein, pmax)).toFixed(1)}%"></i></div><em data-t="proteinline">${fmtInt(n.logged.protein)} g logged + <b>${r1(n.total.protein)}</b> here = ${fmtInt(n.after.protein)} of ${fmtInt(n.protein)} g</em></div>
      </div>
      <p class="ct-left" data-t="left">${leftText(n)}</p>
      <div class="actions ct-act">
        <span class="inp"><select data-calc="meal" aria-label="Meal">${MEALS.map((m) => `<option value="${m.id}"${m.id === meal ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select></span>
        <button type="button" class="btn primary" data-act="calc-log">Log to diary</button>
        <button type="button" class="btn" data-act="combo-save">Save combination</button>
        <button type="button" class="btn" data-act="calc-reset">Reset portions</button>
      </div>
    </div>` : ""}
    <p class="hint small">Calories and protein are from each recipe's ingredients ÷ its cooked weight. Logging copies today's numbers into the diary, so editing a recipe later never changes what you logged.</p>
  </section>`;
}

/** Patch the numbers in place while a slider moves (no redraw, so the drag isn't interrupted). */
export function patchCalc(root, ctx, dayKey) {
  const n = calcNumbers(ctx, dayKey);
  n.rows.forEach((x, i) => {
    const el = root.querySelector(`[data-crow="${i}"]`);
    if (!el) return;
    for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) { const b = el.querySelector(`[data-k="${k}"]`); if (b) b.textContent = k === "kcal" ? fmtInt(x.n[k]) : r1(x.n[k]); }
  });
  for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) { const b = root.querySelector(`[data-t="${k}"]`); if (b) b.textContent = k === "kcal" ? fmtInt(n.total[k]) : r1(n.total[k]); }
  const set = (sel, html) => { const el = root.querySelector(sel); if (el) el.innerHTML = html; };
  set('[data-t="eff"]', effHtml(n.eff));
  set('[data-t="left"]', leftText(n));
  set('[data-t="kcalline"]', `${fmtInt(n.logged.kcal)} logged + <b>${fmtInt(n.total.kcal)}</b> here = ${fmtInt(n.after.kcal)} of ${fmtInt(n.lo)}–${fmtInt(n.hi)}`);
  set('[data-t="proteinline"]', `${fmtInt(n.logged.protein)} g logged + <b>${r1(n.total.protein)}</b> here = ${fmtInt(n.after.protein)} of ${fmtInt(n.protein)} g`);
  const kmax = Math.max(n.hi * 1.15, n.after.kcal), pmax = Math.max(n.protein * 1.2, n.after.protein);
  const bar = (k, v0, v1, max) => { const b = root.querySelector(`[data-bar="${k}"]`); if (b) { b.style.left = `${Math.min(100, (v0 / max) * 100)}%`; b.style.width = `${Math.max(0, Math.min(100, (v1 / max) * 100) - Math.min(100, (v0 / max) * 100))}%`; } };
  bar("kcal", n.logged.kcal, n.after.kcal, kmax);
  bar("protein", n.logged.protein, n.after.protein, pmax);
}

/* ── the recipe library ────────────────────────────────────────────────── */

export function recipesCard(ctx) {
  const list = (ctx.state.library?.recipes || []).filter((r) => ctx.ui.recArchived || !r.archived)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.uses?.lastUsedAt || "").localeCompare(a.uses?.lastUsedAt || "") || a.name.localeCompare(b.name));
  const archived = (ctx.state.library?.recipes || []).filter((r) => r.archived).length;
  const rows = list.map((r) => {
    const v = currentVersion(r), p = per100(v), t = versionTotals(v);
    return `<div class="rrow${r.archived ? " arch" : ""}">
      <div class="rr-main"><div class="rr-h"><button type="button" class="star${r.favorite ? " on" : ""}" data-act="rec-fav" data-v="${r.id}" aria-label="${r.favorite ? "Unfavorite" : "Favorite"}" title="Favorite">★</button><b>${esc(r.name)}</b>${r.example ? `<span class="etag est">Example</span>` : ""}</div>
        <div class="rr-sub">${r.versions.length > 1 ? `<span class="inp sm"><select data-rec-cur="${r.id}" aria-label="Batch">${r.versions.map((x) => `<option value="${x.id}"${x.id === v.id ? " selected" : ""}>${esc(x.label)} · ${dateShort(x.createdAt)}</option>`).join("")}</select></span>` : `<span>${esc(v.label)}</span>`}
          <span>${v.ingredients.length ? `${v.ingredients.length} ingredient${v.ingredients.length === 1 ? "" : "s"} · ${fmtInt(t.kcal)} kcal total` : "per-100 g values"}</span>
          ${v.cookedWeight ? `<span>${fmtInt(v.cookedWeight)} g cooked${v.cookedEstimate ? ` <span class="etag est">Estimated</span>` : ""}</span>` : v.ingredients.length ? `<span class="warn">no cooked weight yet</span>` : ""}</div></div>
      <div class="rr-n">${p ? `<b>${fmtInt(p.kcal)}</b> kcal · <b>${r1(p.protein)}</b> g protein <em>per 100 g</em>` : "—"}<div>${effHtml(proteinEfficiency(p))}</div></div>
      <div class="rr-act">
        <button type="button" class="btn sm" data-act="calc-add" data-v="${r.id}">Use</button>
        <button type="button" class="btn sm" data-act="rec-edit" data-v="${r.id}">Edit</button>
        <button type="button" class="btn sm" data-act="rec-batch" data-v="${r.id}" ${tip("New batch", "Start from this batch's ingredients; older batches keep their numbers")}>New batch</button>
        <button type="button" class="ib" data-act="rec-dup" data-v="${r.id}" title="Duplicate" aria-label="Duplicate">${ICON.copy}</button>
        <button type="button" class="ib" data-act="rec-arch" data-v="${r.id}" title="${r.archived ? "Restore" : "Archive"}" aria-label="${r.archived ? "Restore" : "Archive"}">${r.archived ? "↺" : ICON.box}</button>
      </div>
    </div>`;
  }).join("");
  return `<section class="card reccard" id="recipes">
    <div class="cardhead"><h2>Recipes <span class="sub">enter once, weigh the pot, log portions in seconds</span></h2>
      <div class="actions"><button type="button" class="btn" data-act="grocery-open">Grocery list</button><button type="button" class="btn primary" data-act="rec-new">New recipe</button></div></div>
    <div class="rrows">${rows || `<div class="nodata">No recipes yet.</div>`}</div>
    ${archived ? `<p class="foot-note">${archived} archived. <button type="button" class="linkbtn quiet" data-act="rec-show-arch">${ctx.ui.recArchived ? "Hide them" : "Show them"}</button></p>` : ""}
    <p class="hint small">Per 100 g = everything in the pot ÷ its cooked weight × 100. Cooking changes the weight (water), not the calories — so weigh the whole pot when it's done. A new batch keeps earlier batches' numbers, e.g. 12 oz of pasta one week and 14 oz the next.</p>
  </section>`;
}

/* ── the recipe editor (panel) ─────────────────────────────────────────── */

export function recipeForm(ctx, d) {
  const t = versionTotals({ ingredients: d.ingredients });
  const p = d.cookedWeight > 0 ? Object.fromEntries(Object.entries(t).filter(([k]) => ["kcal", "protein", "carbs", "fat", "fiber"].includes(k)).map(([k, v]) => [k, (v / d.cookedWeight) * 100])) : null;
  const known = (ctx.state.library?.foods || []).filter((f) => !f.archived).map((f) => f.name);
  const prevIng = [...new Set((ctx.state.library?.recipes || []).flatMap((r) => r.versions.flatMap((v) => v.ingredients.map((i) => i.name))))];
  const rows = d.ingredients.map((g, i) => `<div class="ing" data-ing="${i}">
      <span class="inp ing-name"><input name="in-${i}" value="${esc(g.name)}" list="inglist" placeholder="Ingredient" aria-label="Ingredient ${i + 1}"></span>
      <span class="inp ing-amt"><input name="ia-${i}" type="number" min="0" step="any" inputmode="decimal" value="${g.amount ?? ""}" aria-label="Amount"></span>
      <span class="inp ing-unit"><select name="iu-${i}" aria-label="Unit">${ING_UNITS.map((u) => `<option${u === g.unit ? " selected" : ""}>${u}</option>`).join("")}</select></span>
      <span class="inp ing-state"><select name="is-${i}" aria-label="Raw or cooked">${ING_STATES.map((s) => `<option${s === g.state ? " selected" : ""}>${s}</option>`).join("")}</select></span>
      ${["kcal", "protein", "carbs", "fat", "fiber"].map((k) => `<span class="inp ing-${k}"><input name="i${k}-${i}" type="number" min="0" step="any" inputmode="decimal" value="${g[k] ?? ""}" aria-label="${k}"><em>${k === "kcal" ? "kcal" : `g ${k === "protein" ? "P" : k === "carbs" ? "C" : k === "fat" ? "F" : "fib"}`}</em></span>`).join("")}
      <span class="ing-tools"><label class="chk bare" title="Mark as an estimate"><input type="checkbox" name="ie-${i}"${g.estimate ? " checked" : ""}><i style="--c:#9D8CF5"></i>est.</label>
        <button type="button" class="linkbtn quiet" data-act="ing-lookup" data-i="${i}">Look up</button>
        <button type="button" class="ib" data-act="ing-del" data-i="${i}" aria-label="Remove ingredient">×</button></span>
      ${g.basis ? `<span class="ing-basis">From ${esc(g.basis.name || "a saved food")} (${esc(g.basis.source?.provider || g.basis.source?.kind || "")}) — rescales when you change the amount${ingredientGrams(g) != null ? ` · ${fmtInt(ingredientGrams(g))} g` : ""}</span>` : ""}
      ${d.lookup?.i === i ? lookupHtml(d.lookup, i) : ""}
    </div>`).join("");
  const title = d.mode === "batch" ? `New batch of ${d.name}` : d.id ? `Edit ${d.name}` : "New recipe";
  return `<form data-form="recipe">
    <header><div><div class="eyebrow">${d.mode === "batch" ? "Earlier batches keep their numbers" : "Recipe"}</div><h2>${esc(title)}</h2></div><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="fields">
      <label class="field"><span>Name</span><span class="inp"><input name="name" value="${esc(d.name)}" required maxlength="100" data-focus></span></label>
      <label class="field"><span>Batch name</span><span class="inp"><input name="label" value="${esc(d.label)}" maxlength="60" placeholder="e.g. 12 oz pasta"></span></label>
      <label class="field"><span>Default portion</span><span class="inp"><input name="defaultPortion" type="number" min="0" max="2000" step="5" value="${d.defaultPortion}"><em>g</em></span></label>
    </div>
    <h3>Ingredients <span class="sub">totals for the whole pot — raw, cooked or dry as you measured them</span></h3>
    <div class="ings">${rows || `<div class="empty-row">No ingredients yet.</div>`}</div>
    <datalist id="inglist">${[...new Set([...prevIng, ...known])].slice(0, 200).map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
    <div class="actions"><button type="button" class="btn" data-act="ing-add">+ Ingredient</button></div>
    <h3>Cooked weight <span class="sub">weigh the whole pot when it's done (subtract the pot)</span></h3>
    <div class="fields">
      <label class="field"><span>Cooked weight</span><span class="inp"><input name="cookedWeight" type="number" min="0" step="1" inputmode="numeric" value="${d.cookedWeight || ""}" placeholder="${t.rawWeight ? `raw ingredients ≈ ${fmtInt(t.rawWeight)} g` : ""}"><em>g</em></span></label>
      <label class="chk"><input type="checkbox" name="cookedEstimate"${d.cookedEstimate ? " checked" : ""}><i style="--c:#9D8CF5"></i>This weight is an estimate</label>
    </div>
    <div class="rtot" data-rtot>${totalsHtml(t, p, d.cookedWeight)}</div>
    <label class="field"><span>Notes</span><span class="inp"><input name="notes" value="${esc(d.notes || "")}" maxlength="400"></span></label>
    <footer>
      ${d.id && d.mode !== "batch" && !d.dup ? `<button type="button" class="btn danger ghost" data-act="rec-delete">Delete recipe</button>` : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">${d.mode === "batch" ? "Save new batch" : "Save recipe"}</button>
    </footer>
  </form>`;
}

export function totalsHtml(t, p, cooked) {
  const miss = Object.entries(t.missing || {}).filter(([k, v]) => v && k !== "kcal").map(([k, v]) => `${v} without ${k}`);
  return `<div><span class="ea-l">Whole pot</span><b>${fmtInt(t.kcal)} kcal</b><em>${r1(t.protein)} g P · ${r1(t.carbs)} g C · ${r1(t.fat)} g F · ${r1(t.fiber)} g fiber</em></div>
    <div><span class="ea-l">Per 100 g cooked</span>${p ? `<b>${fmtInt(p.kcal)} kcal</b><em>${r1(p.protein)} g P · ${r1(p.carbs)} g C · ${r1(p.fat)} g F · ${effHtml(proteinEfficiency(p))}</em>` : `<b>—</b><em>add the cooked weight</em>`}</div>
    ${t.rawWeight && cooked ? `<div><span class="ea-l">Cooking</span><b>${cooked > t.rawWeight ? "+" : "−"}${fmtInt(Math.abs(cooked - t.rawWeight))} g</b><em>${cooked < t.rawWeight ? "water lost" : "water absorbed (pasta, rice)"} — calories unchanged</em></div>` : ""}
    ${miss.length ? `<p class="hint small">${esc(miss.join(", "))} — those count as 0 in the totals.</p>` : ""}`;
}

function lookupHtml(l, i) {
  if (l.loading) return `<div class="ing-look">Searching…</div>`;
  if (l.error) return `<div class="ing-look">${esc(l.error)}</div>`;
  if (!l.results?.length) return `<div class="ing-look">Nothing found — type the numbers from the label.</div>`;
  return `<div class="ing-look">${l.results.slice(0, 6).map((r, j) => `<button type="button" class="ing-pick" data-act="ing-pick" data-i="${i}" data-j="${j}"><b>${esc(r.name)}</b>${r.brand ? ` · ${esc(r.brand)}` : ""}<span>${esc(r.serving?.label || "")}: ${fmtInt(r.nutrients?.kcal)} kcal · ${r1(r.nutrients?.protein)} g P · ${esc(r.source?.provider || r.source?.kind || "")}</span></button>`).join("")}
    <button type="button" class="linkbtn quiet" data-act="ing-look-close" data-i="${i}">Close</button></div>`;
}

/* ── grocery list (panel) ──────────────────────────────────────────────── */

export function groceryForm(ctx, picks, onHand) {
  const all = liveRecipes(ctx);
  const chosen = all.filter((r) => picks[r.id] > 0).map((r) => ({ recipe: r, batches: picks[r.id] }));
  const list = groceryList(chosen, onHand);
  return `<form data-form="grocery" onsubmit="return false">
    <header><div><div class="eyebrow">From your recipes</div><h2>Grocery list</h2></div><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="gpicks">${all.map((r) => `<label class="gpick"><span>${esc(r.name)} <em>${esc(currentVersion(r).label)}</em></span><span class="inp sm"><input type="number" min="0" max="20" step="0.5" value="${picks[r.id] || 0}" data-gpick="${r.id}" aria-label="Batches of ${esc(r.name)}"><em>batch${(picks[r.id] || 0) === 1 ? "" : "es"}</em></span></label>`).join("")}</div>
    ${list.length ? `<div class="glist">${list.map((c) => `<div class="gcat"><span class="ea-l">${esc(c.category)}</span>${c.items.map((x) => `<div class="gitem${x.done ? " done" : ""}">
        <span class="gname">${esc(x.name)}<em>${esc(x.from.join(", "))}</em></span>
        <span class="gneed">${x.done ? "✓ have enough" : esc(x.text)}${x.mixed.length ? ` <em>${esc(x.mixed.join(" "))}</em>` : ""}</span>
        ${x.unit ? `<span class="inp sm ghave"><input type="number" min="0" step="any" value="${onHand[x.key] ?? ""}" placeholder="have" data-ghave="${esc(x.key)}" aria-label="Already have, ${x.unit}"><em>${x.unit === "piece" ? "have" : `${x.unit} have`}</em></span>` : ""}
      </div>`).join("")}</div>`).join("")}</div>
      <div class="actions"><button type="button" class="btn primary" data-act="grocery-copy">Copy list</button></div>` : `<div class="nodata">Pick how many batches of each recipe you're making.</div>`}
    <p class="hint small">The same ingredient across recipes is added up; enter what you already have (in grams, ml or pieces) and it's taken off.</p>
  </form>`;
}

export function groceryText(ctx, picks, onHand) {
  const chosen = liveRecipes(ctx).filter((r) => picks[r.id] > 0).map((r) => ({ recipe: r, batches: picks[r.id] }));
  return groceryList(chosen, onHand).map((c) => `${c.category}\n${c.items.filter((x) => !x.done).map((x) => `- ${x.name}: ${x.text}`).join("\n")}`).join("\n\n");
}
