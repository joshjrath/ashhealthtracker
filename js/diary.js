/* ──────────────────────────────────────────────────────────────────────────
   The Nutrition page's food panels: the diary, the day's summary, the
   week's calories, food history and your saved foods. Each is a function
   of the context, like every other panel (see views.js).

   Food numbers here come only from what you logged: diary entries plus any
   quick-add totals. Where a number came from is always one tap away.
   ────────────────────────────────────────────────────────────────────────── */
import { METRICS, addDays, range, foodStatus, fmtInt, fmt1 } from "./metrics.js";
import { MEALS, NUTRIENTS, fmtQty, remainingText, weeklyBudget } from "./nutrition.js";
import { recentFoods, favoriteFoods, frequentFoods, customFoods, mealTotals } from "./library.js";
import { esc, tip } from "./charts.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parse = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
export const dayLabel = (k, today) => (k === today ? "Today" : k === addDays(today, -1) ? "Yesterday" : `${WD[parse(k).getDay()]}, ${MONTHS[parse(k).getMonth()]} ${parse(k).getDate()}`);
const short = (k) => `${MONTHS[parse(k).getMonth()]} ${parse(k).getDate()}`;

const NUT = {
  kcal: { label: "Calories", unit: "", color: METRICS.calories.color, target: (g) => g.kcalTarget },
  protein: { label: "Protein", unit: "g", color: METRICS.protein.color, target: (g) => g.protein },
  carbs: { label: "Carbs", unit: "g", color: METRICS.carbs.color, target: (g) => g.carbs },
  fat: { label: "Fat", unit: "g", color: METRICS.fat.color, target: (g) => g.fat },
  fiber: { label: "Fiber", unit: "g", color: METRICS.fiber.color, target: (g) => g.fiber },
};
const g1 = (v) => (v == null ? "—" : fmt1(v).replace(/\.0$/, ""));

/* ── provenance ────────────────────────────────────────────────────────── */

const KIND = {
  verified: { word: "Verified", why: "The manufacturer's label data" },
  database: { word: "Database", why: "A food database's values" },
  estimate: { word: "Estimated", why: "An AI estimate — check it" },
  custom: { word: "Custom", why: "Numbers you entered" },
};

/** VERIFIED · DATABASE · ESTIMATED · CUSTOM, with where the numbers came from on hover. */
export function srcTag(source, { edited = source?.edited } = {}) {
  const s = source || { kind: "custom" };
  const k = KIND[s.kind] || KIND.custom;
  const lines = [k.word, s.provider ? `${s.provider}${s.confidence && s.kind === "estimate" ? ` · ${s.confidence} confidence` : ""}` : k.why, s.note || "", edited ? "You edited these numbers" : ""];
  return `<span class="srcTag ${s.kind || "custom"}${edited ? " edited" : ""}" ${tip(...lines)}>${k.word}${edited ? "*" : ""}</span>`;
}

/** "P 11 · C 5 · F 0" — only what's known. */
export function macroLine(x) {
  const part = (v, l) => (v == null ? null : `${l} ${g1(v)}`);
  return [part(x.protein, "P"), part(x.carbs, "C"), part(x.fat, "F")].filter(Boolean).join(" · ") || "Macros not listed";
}

/* ── the diary ─────────────────────────────────────────────────────────── */

function entryRow(e, key) {
  const meta = [e.brand, fmtQty(e.qty, e.unit, e.serving), e.time ? e.time.replace(/^0/, "") : null, e.group ? `from ${e.group.name}` : null].filter(Boolean).join(" · ");
  return `<button type="button" class="fe" data-act="food-edit" data-key="${key}" data-id="${esc(e.id)}" aria-label="Edit ${esc(e.name)}">
    <span class="fn"><b>${esc(e.name)}</b><span>${esc(meta)}</span></span>
    <span class="fs">${srcTag(e.source)}</span>
    <span class="fk"><span><b>${fmtInt(e.kcal)}</b><small>kcal</small></span><span class="fm">${esc(macroLine(e))}</span></span>
  </button>`;
}

export function foodDiaryCard(ctx, key) {
  const { today } = ctx;
  const d = ctx.days[key];
  const food = d?.food;
  const status = foodStatus(d);
  const meals = MEALS.map((m) => {
    const slot = food?.byMeal?.[m.id] || { entries: [], totals: {} };
    const t = slot.totals;
    const sum = slot.entries.length ? `<span class="mt"><b>${fmtInt(t.kcal)}</b> kcal<span class="mac"> · ${esc(macroLine(t))}</span></span>` : `<span class="mt muted">—</span>`;
    return `<div class="meal" data-meal="${m.id}">
      <div class="mh">
        <b>${m.label}</b>${sum}
        ${slot.entries.length >= 2 ? `<button type="button" class="linkbtn quiet" data-act="meal-from" data-key="${key}" data-meal="${m.id}">Save as meal</button>` : ""}
        <button type="button" class="ib add" data-act="food-add" data-key="${key}" data-meal="${m.id}" aria-label="Add to ${m.label.toLowerCase()}" title="Add to ${m.label.toLowerCase()}">+</button>
      </div>
      ${slot.entries.length ? `<div class="entries">${slot.entries.map((e) => entryRow(e, key)).join("")}</div>` : ""}
    </div>`;
  }).join("");
  const q = food?.quick;
  const quick = q ? `<div class="meal quick"><div class="mh"><b>Quick add</b><span class="mt"><b>${q.kcal != null ? fmtInt(q.kcal) : "—"}</b> kcal · ${esc(macroLine(q))}</span>
      <button type="button" class="linkbtn quiet" data-act="log" data-key="${key}">Edit</button></div>
      <p class="hint small">Totals typed without itemising${food.itemized ? " — they add to the entries above" : ""}.</p></div>` : "";
  const t = food?.totals || {};
  const missFiber = food?.missing?.fiber ? ` <span class="muted" ${tip("Fiber", `${food.missing.fiber} entr${food.missing.fiber === 1 ? "y doesn't" : "ies don't"} list fiber`, "so this total may be low")}>(${food.missing.fiber} not listed)</span>` : "";
  const total = t.kcal != null
    ? `<div class="dtotal"><span class="lbl">Total</span><b>${fmtInt(t.kcal)}</b> kcal · ${esc(macroLine(t))}${t.fiber != null ? ` · Fiber ${g1(t.fiber)}` : ""}${missFiber}</div>`
    : `<div class="dtotal muted">Nothing logged${key === today ? " yet" : ""}</div>`;
  const ctl = status === "complete"
    ? `<span class="fstat complete">Complete</span><button type="button" class="linkbtn quiet" data-act="food-done" data-key="${key}" data-v="0">Reopen</button>`
    : status === "partial"
      ? `<span class="fstat partial">In progress</span><button type="button" class="btn" data-act="food-done" data-key="${key}" data-v="1">Mark day complete</button>`
      : "";
  return `<section class="card diary" id="diary">
    <div class="cardhead">
      <h2>Food diary <span class="sub">${esc(dayLabel(key, today))}${key !== today ? ` · ${esc(short(key))}` : ""}</span></h2>
      <div class="pager">
        <button type="button" class="nav" data-act="food-day" data-v="-1" aria-label="Previous day">‹</button>
        <button type="button" class="nav" data-act="food-day" data-v="0"${key === today ? " disabled" : ""}>Today</button>
        <button type="button" class="nav" data-act="food-day" data-v="1" aria-label="Next day"${key >= today ? " disabled" : ""}>›</button>
      </div>
    </div>
    <button type="button" class="addfood" data-act="food-add" data-key="${key}">
      <span class="plus">+</span><span class="ph">Add food<span> — search or describe it: “2 eggs”, “6 oz chicken breast”, “Wawa turkey hoagie”</span></span>
    </button>
    <div class="meals">${meals}${quick}</div>
    <footer class="dfoot">${total}<div class="dctl">${ctl}</div></footer>
    ${status === "partial" ? `<p class="foot-note">A day counts toward averages and badges once you mark it complete — a half-logged day is never read as everything you ate.</p>` : ""}
  </section>`;
}

/* ── the day's summary: current / target / remaining ───────────────────── */

export function dailySummaryCard(ctx, key) {
  const { g, today } = ctx;
  const d = ctx.days[key] || {};
  const status = foodStatus(d);
  const food = d.food;
  const rows = NUTRIENTS.map((n) => {
    const m = NUT[n];
    const v = d[n];
    const target = m.target(g);
    const pct = v == null ? 0 : Math.min(1, v / target);
    const above = v != null && v > target;
    const rem = remainingText(v, target, n === "kcal" ? " kcal" : m.unit);
    const miss = n !== "kcal" && food?.missing?.[n] ? food.missing[n] : 0;
    const unit = n === "kcal" ? " kcal" : m.unit;
    return `<div class="sr${above ? " above" : ""}" style="--c:${m.color}" ${tip(m.label, v == null ? "Nothing logged" : `${n === "kcal" ? fmtInt(v) : g1(v)}${unit} of ${fmtInt(target)}${unit}`, n === "kcal" ? `Range ${fmtInt(g.kcalLow)}–${fmtInt(g.kcalHigh)}` : "", miss ? `${miss} entr${miss === 1 ? "y doesn't" : "ies don't"} list ${m.label.toLowerCase()}` : "")}>
      <span class="nm"><i></i>${m.label}</span>
      <span class="cv"><b>${v == null ? "—" : n === "kcal" ? fmtInt(v) : g1(v)}</b> / ${fmtInt(target)}${unit}</span>
      <span class="rem">${esc(rem)}${miss ? "*" : ""}</span>
      <span class="bar"><span style="width:${(pct * 100).toFixed(1)}%"></span></span>
    </div>`;
  }).join("");
  const word = { complete: "complete log", partial: key === today ? "so far — log in progress" : "partial log", none: "nothing logged" }[status];
  const inRange = d.kcal != null && d.kcal >= g.kcalLow && d.kcal <= g.kcalHigh;
  return `<section class="card dsum">
    <h2>Daily summary <span class="sub">${esc(dayLabel(key, today))} · ${word}</span></h2>
    <div class="sumrows">${rows}</div>
    <p class="foot-note">Calorie range ${fmtInt(g.kcalLow)}–${fmtInt(g.kcalHigh)}${inRange ? " · in range" : ""}. ${food?.missing && Object.entries(food.missing).some(([n, c]) => n !== "kcal" && c) ? "* Some entries don't list every nutrient, so those totals may be low." : ""}</p>
  </section>`;
}

/* ── the week's calories ───────────────────────────────────────────────── */

export function weeklyBudgetCard(ctx) {
  const { g, today } = ctx;
  const w = weeklyBudget(ctx.days, g, today, { foodStatus });
  const logged = w.rows.reduce((s, r) => s + (r.kcal || 0), 0);
  const counted = w.consumedBefore + (w.todaySoFar || 0);
  const remaining = w.weekly - counted;
  const cell = (name, val, note, cls = "") => `<div class="${cls}"><span>${name}</span><b>${val}</b>${note ? `<em>${note}</em>` : ""}</div>`;
  const perDay = w.perDay != null
    ? cell("Avg available per remaining day", fmtInt(w.perDay), `${w.daysLeft} day${w.daysLeft === 1 ? "" : "s"} incl. today`)
    : w.perDayState === "above"
      ? cell("Avg available per remaining day", "—", `The week is above target so far. Your daily target stays ${fmtInt(w.daily)} — no need to make up for it.`, "note")
      : cell("Avg available per remaining day", "—", `More than your estimated maintenance — some days may be missing logs.`, "note");
  const pace = w.knownDays
    ? `${fmtInt(w.knownTotal)} kcal over ${w.knownDays} complete day${w.knownDays === 1 ? "" : "s"} · target pace ${fmtInt(w.knownPace)} · ${w.difference > 0 ? "+" : w.difference < 0 ? "−" : "±"}${fmtInt(Math.abs(w.difference))}`
    : "No complete days yet this week";
  const assumed = w.assumed.length
    ? `${w.assumed.map((a) => WD[parse(a.key).getDay()]).join(", ")} ${w.assumed.length === 1 ? "isn't" : "aren't"} marked complete, so ${w.assumed.length === 1 ? "it's" : "they're"} counted at ${fmtInt(w.daily)} (or what you logged, if more) — never as zero.`
    : "";
  return `<section class="card wbudget">
    <h2>Weekly calories <span class="sub">${esc(short(w.rows[0].key))} – ${esc(short(w.rows[6].key))}</span></h2>
    <div class="wbstats">
      ${cell("Weekly target", fmtInt(w.weekly), g.weeklyTarget ? "set in Settings" : `7 × ${fmtInt(w.daily)} daily`)}
      ${cell("Logged so far", fmtInt(logged), `${w.rows.filter((r) => r.kcal != null).length} day${w.rows.filter((r) => r.kcal != null).length === 1 ? "" : "s"} with food`)}
      ${cell("Weekly target remaining", remaining >= 0 ? fmtInt(remaining) : "0", remaining >= 0 ? "after today so far" : `${fmtInt(-remaining)} above the weekly target`, "wbhl")}
      ${perDay}
    </div>
    <div class="chartbox" data-chart="pacing"></div>
    <div class="pacerow">
      <div><span>Weekly pacing</span><b>${esc(pace)}</b></div>
      <div><span>Daily average</span><b>${w.average == null ? "Not enough data yet" : `${fmtInt(w.average)} kcal <em>· complete days only</em>`}</b></div>
      <div><span>Est. maintenance</span><b>${w.maintenance ? `${fmtInt(w.maintenance)} kcal <em>· context, not a target</em>` : "—"}</b></div>
    </div>
    ${assumed ? `<p class="foot-note">${esc(assumed)}</p>` : ""}
  </section>`;
}

/** Rows for the pacing chart: Monday → Sunday with each day's status. */
export function pacingRows(ctx) {
  return weeklyBudget(ctx.days, ctx.g, ctx.today, { foodStatus }).rows;
}

/* ── food history ──────────────────────────────────────────────────────── */

export function foodHistoryCard(ctx) {
  const { today, ui } = ctx;
  const n = ui.histDays || 14;
  const keys = range(addDays(today, -(n - 1)), today).reverse();
  const rows = keys.map((k) => {
    const d = ctx.days[k];
    const st = foodStatus(d);
    const f = d?.food;
    const word = { complete: "Complete", partial: "Partial", none: "No data" }[st];
    if (st === "none") {
      return `<div class="fh none"><span class="fd"><b>${esc(dayLabel(k, today))}</b><span class="fstat none">${word}</span></span><span class="ft muted">Nothing logged</span>
        <button type="button" class="linkbtn quiet" data-act="food-open" data-key="${k}">Log food</button></div>`;
    }
    const meals = f.itemized
      ? MEALS.map((m) => {
        const t = f.byMeal[m.id].totals;
        return `<span class="fmeal${t.kcal == null ? " empty" : ""}" ${tip(`${m.label} · ${dayLabel(k, today)}`, t.kcal == null ? "Nothing logged" : `${fmtInt(t.kcal)} kcal`, t.kcal == null ? "" : macroLine(t))}>
          <em>${m.label}</em><b>${t.kcal == null ? "—" : fmtInt(t.kcal)}</b><span>${t.kcal == null ? "" : esc(macroLine(t))}</span></span>`;
      }).join("") + (f.quick ? `<span class="fmeal"><em>Quick add</em><b>${f.quick.kcal != null ? fmtInt(f.quick.kcal) : "—"}</b><span>${esc(macroLine(f.quick))}</span></span>` : "")
      : `<span class="fmeal wide"><em>Quick add</em><span>Totals typed without itemising</span></span>`;
    return `<button type="button" class="fh" data-act="food-open" data-key="${k}">
      <span class="fd"><b>${esc(dayLabel(k, today))}</b><span class="fstat ${st}">${word}</span></span>
      <span class="ft"><b>${fmtInt(d.kcal)}</b> kcal · ${esc(macroLine(d))}</span>
      <span class="fmeals">${meals}</span>
    </button>`;
  }).join("");
  return `<section class="card fhist">
    <h2>Food history <span class="sub">meal by meal · last ${n} days</span></h2>
    <div class="fhlist">${rows}</div>
    ${n < 56 ? `<button type="button" class="btn more" data-act="hist-more">Show older days</button>` : ""}
  </section>`;
}

/* ── your foods and meals ──────────────────────────────────────────────── */

const STAR = (on) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const PEN = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l.8-3.2L13.5 4a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L7.2 15.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const BOX = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6.5h13v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5zM2.5 3.5h15v3h-15zM8 10h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const COPY = `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 4.8A1.8 1.8 0 0 0 11.2 3.5H5.3a1.8 1.8 0 0 0-1.8 1.8v5.9A1.8 1.8 0 0 0 4.8 13" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const PLUS = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const ICON = { star: STAR, pen: PEN, box: BOX, copy: COPY, plus: PLUS };

export function foodRow(f, { acts = true } = {}) {
  const n = f.nutrients || {};
  const serving = f.serving?.label || "1 serving";
  return `<div class="lrow">
    <button type="button" class="lmain" data-act="lib-log" data-id="${esc(f.id)}">
      <span class="fn"><b>${esc(f.name)}</b><span>${esc([f.brand, serving].filter(Boolean).join(" · "))}</span></span>
      ${srcTag(f.source)}
      <span class="fk"><span><b>${fmtInt(n.kcal)}</b><small>kcal</small></span><span class="fm">${esc(macroLine(n))}</span></span>
    </button>
    ${acts ? `<span class="lacts">
      <button type="button" class="ib${f.favorite ? " on" : ""}" data-act="lib-fav" data-id="${esc(f.id)}" aria-pressed="${!!f.favorite}" title="${f.favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="Favorite">${STAR(f.favorite)}</button>
      <button type="button" class="ib" data-act="lib-edit" data-id="${esc(f.id)}" title="Edit food" aria-label="Edit food">${PEN}</button>
      <button type="button" class="ib" data-act="lib-archive" data-id="${esc(f.id)}" title="Archive — hides it; past entries stay" aria-label="Archive food">${BOX}</button>
    </span>` : ""}
  </div>`;
}

export function mealRow(m) {
  const { totals } = mealTotals(m);
  return `<div class="lrow">
    <button type="button" class="lmain" data-act="meal-log" data-id="${esc(m.id)}">
      <span class="fn"><b>${esc(m.name)}</b><span>${m.items.length} item${m.items.length === 1 ? "" : "s"} · ${esc(m.items.slice(0, 3).map((x) => x.name).join(", "))}${m.items.length > 3 ? "…" : ""}</span></span>
      <span class="fk"><span><b>${fmtInt(totals.kcal)}</b><small>kcal</small></span><span class="fm">${esc(macroLine(totals))}</span></span>
    </button>
    <span class="lacts">
      <button type="button" class="ib${m.favorite ? " on" : ""}" data-act="meal-fav" data-id="${esc(m.id)}" aria-pressed="${!!m.favorite}" title="${m.favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="Favorite">${STAR(m.favorite)}</button>
      <button type="button" class="ib" data-act="meal-edit" data-id="${esc(m.id)}" title="Edit or rename" aria-label="Edit meal">${PEN}</button>
      <button type="button" class="ib" data-act="meal-dup" data-id="${esc(m.id)}" title="Duplicate" aria-label="Duplicate meal">${COPY}</button>
      <button type="button" class="ib" data-act="meal-archive" data-id="${esc(m.id)}" title="Archive" aria-label="Archive meal">${BOX}</button>
    </span>
  </div>`;
}

export const LIB_TABS = [["recent", "Recent"], ["favorites", "Favorites"], ["frequent", "Frequent"], ["custom", "Custom"], ["meals", "Meals"]];

export function libraryList(lib, tab) {
  const foods = lib.foods || [];
  if (tab === "meals") {
    const meals = (lib.meals || []).filter((m) => !m.archived).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name));
    return meals.length ? meals.map(mealRow).join("") : `<div class="empty-row">No meals yet. Build one from “New meal”, or tap “Save as meal” on a meal in your diary.</div>`;
  }
  const list = { recent: recentFoods, favorites: favoriteFoods, frequent: frequentFoods, custom: customFoods }[tab](foods, 30);
  const empty = {
    recent: "Foods you log show up here.",
    favorites: "Star a food to keep it here.",
    frequent: "Foods you've logged more than once show up here.",
    custom: "Foods you create yourself — like a shake you make every day.",
  }[tab];
  return list.length ? list.map((f) => foodRow(f)).join("") : `<div class="empty-row">${empty}</div>`;
}

export function libraryCard(ctx) {
  const tab = ctx.ui.libTab || "recent";
  const lib = ctx.state.library || {};
  const archived = (lib.foods || []).filter((f) => f.archived).length + (lib.meals || []).filter((m) => m.archived).length;
  return `<section class="card libcard">
    <div class="cardhead">
      <h2>My foods <span class="sub">saved once, logged in a tap</span></h2>
      <div class="actions"><button type="button" class="btn" data-act="food-new">New food</button><button type="button" class="btn" data-act="meal-new">New meal</button></div>
    </div>
    <div class="tabs" role="tablist">${LIB_TABS.map(([v, l]) => `<button type="button" role="tab" class="tab${v === tab ? " on" : ""}" aria-selected="${v === tab}" data-act="lib-tab" data-v="${v}">${l}</button>`).join("")}</div>
    <div class="llist">${libraryList(lib, tab)}</div>
    ${archived ? `<p class="foot-note">${archived} archived item${archived === 1 ? "" : "s"} hidden. Past diary entries keep their own numbers, so archiving never changes your history. <button type="button" class="linkbtn quiet" data-act="lib-unarchive">Restore all</button></p>` : ""}
  </section>`;
}
