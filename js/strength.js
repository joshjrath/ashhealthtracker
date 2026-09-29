/* ──────────────────────────────────────────────────────────────────────────
   Strength on the Fitness page: the week against your training plan, the
   lifting you've logged set by set, and the form to log it. Apple Health
   workouts say a session happened; only your own sets carry weight and
   reps, so volume and overload come from your log alone.
   ────────────────────────────────────────────────────────────────────────── */
import { addDays, mondayOf, range, fmtInt } from "./metrics.js";
import { WEEKDAYS, WEEKDAY_LABELS, PLAN_LABELS, weekStatus, liftHistory, dayVolume, knownExercises } from "./training.js";
import { esc, tip } from "./charts.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayText = (k) => { const [y, m, d] = k.split("-").map(Number); return `${WD[new Date(y, m - 1, d).getDay()]}, ${MONTHS[m - 1]} ${d}`; };

/** "3×8 @ 135 lb" — sets grouped when they repeat. */
export function setsText(sets) {
  const out = [];
  for (const s of sets) {
    const last = out[out.length - 1];
    if (last && last.reps === s.reps && last.weight === s.weight && last.unit === s.unit) last.n += 1;
    else out.push({ ...s, n: 1 });
  }
  return out.map((s) => `${s.n > 1 ? `${s.n}×` : ""}${s.reps}${s.weight ? ` @ ${s.weight} ${s.unit}` : " reps"}`).join(", ");
}

export function strengthCard(ctx) {
  const { days, today, g } = ctx;
  const keys = Object.keys(days).filter((k) => k <= today).sort();
  const h = liftHistory(days, keys);
  const mon = mondayOf(today);
  const weekVol = range(mon, today).reduce((s, k) => s + dayVolume(days[k]), 0);
  const weekSessions = range(mon, today).filter((k) => days[k]?.lifts?.length).length;
  const since30 = addDays(today, -29);
  const inc30 = h.perDay.filter((p) => p.key >= since30).reduce((s, p) => s + p.increases, 0);
  const plan = g.plan;
  const ws = plan ? weekStatus(days, plan, mon, today) : null;
  const planLine = plan
    ? `<div class="planweek">${WEEKDAYS.map((d, i) => {
        const k = addDays(mon, i);
        const p = plan.days[d];
        const t = days[k];
        const did = (t?.lifts?.length || 0) > 0 || (t?.workouts?.length || 0) > 0 || t?.workout === true;
        const cls = p === "rest" ? "rest" : did ? "done" : k < today ? "missed" : k === today ? "today" : "";
        return `<span class="pd ${cls}" ${tip(`${WEEKDAY_LABELS[d]} · ${PLAN_LABELS[p]}`, p === "rest" ? "Planned rest" : did ? "Trained" : k > today ? "Upcoming" : k === today ? "Today" : "Nothing logged")}><em>${WEEKDAY_LABELS[d].slice(0, 2)}</em><b>${p === "rest" ? "Rest" : PLAN_LABELS[p].replace("Any workout", "Any")}</b></span>`;
      }).join("")}</div>
      <p class="hint small">${ws?.status === "hit" ? "This week's plan is complete." : ws?.need ? `This week: ${ws.got.strength}/${ws.need.strength} strength · ${ws.got.cardio}/${ws.need.cardio} cardio · ${ws.got.total}/${ws.need.total} sessions. Moving a session to another day is fine.` : ""}</p>`
    : `<p class="hint">Set your weekly training plan in <a href="#/settings" data-jump="sec-training"><b>Settings → Training plan</b></a> so planned rest days never count against you.</p>`;
  const recent = h.perDay.slice(-5).reverse().map((p) => {
    const lifts = days[p.key]?.lifts || [];
    return `<button type="button" class="lsess" data-act="lifts-open" data-key="${p.key}">
      <span class="ls-d"><b>${esc(dayText(p.key))}</b><span>${fmtInt(p.volume)} lb volume${p.prs.length ? ` · <em class="pr">${p.prs.length} new best${p.prs.length === 1 ? "" : "s"}</em>` : ""}</span></span>
      <span class="ls-x">${lifts.map((l) => `<span><b>${esc(l.exercise)}</b> ${esc(setsText(l.sets))}</span>`).join("")}</span>
    </button>`;
  }).join("");
  const cell = (name, val, note) => `<div><span>${name}</span><b>${val}</b>${note ? `<em>${note}</em>` : ""}</div>`;
  return `<section class="card strength">
    <div class="cardhead"><h2>Strength <span class="sub">sets you logged</span></h2>
      <button type="button" class="btn primary" data-act="lifts-open" data-key="${today}">Log lifts</button></div>
    ${planLine}
    <div class="fgrid four">
      ${cell("Volume this week", `${fmtInt(weekVol)}<small>lb</small>`, `${weekSessions} session${weekSessions === 1 ? "" : "s"}`)}
      ${cell("Total volume", `${fmtInt(h.volume)}<small>lb</small>`, `${h.sessions} session${h.sessions === 1 ? "" : "s"} logged`)}
      ${cell("New bests", inc30, "last 30 days · est. 1-rep max")}
      ${cell("Exercises", Object.keys(h.bestByExercise).length, "tracked")}
    </div>
    ${recent ? `<div class="sec-l">Recent sessions</div><div class="lsessions">${recent}</div>` : `<div class="nodata">No lifts logged yet. Log sets, reps and weight after a session — Apple Health can't see them.</div>`}
  </section>`;
}

/* ── the log form ──────────────────────────────────────────────────────── */

export function liftForm(ctx, draft) {
  const known = knownExercises(ctx.days).slice(0, 60);
  const ex = draft.lifts.map((l, i) => `<div class="lx">
      <div class="lx-h"><span class="inp"><input name="ex-${i}" list="exlist" value="${esc(l.exercise)}" placeholder="Exercise, e.g. Bench press" maxlength="80" aria-label="Exercise ${i + 1}"></span>
        <button type="button" class="ib" data-act="lift-del-ex" data-i="${i}" title="Remove exercise" aria-label="Remove exercise">×</button></div>
      <div class="lsets">${l.sets.map((s, j) => `<div class="lset">
          <span class="sn">${j + 1}</span>
          <span class="inp"><input name="r-${i}-${j}" type="number" min="1" max="1000" step="1" inputmode="numeric" value="${esc(s.reps ?? "")}" aria-label="Reps"><em>reps</em></span>
          <span class="times">×</span>
          <span class="inp"><input name="w-${i}-${j}" type="number" min="0" max="3000" step="0.5" inputmode="decimal" value="${esc(s.weight ?? "")}" placeholder="weight" aria-label="Weight"></span>
          <select name="u-${i}-${j}" aria-label="Unit"><option value="lb"${s.unit !== "kg" ? " selected" : ""}>lb</option><option value="kg"${s.unit === "kg" ? " selected" : ""}>kg</option></select>
          <button type="button" class="ib" data-act="lift-del-set" data-i="${i}" data-j="${j}" title="Remove set" aria-label="Remove set">×</button>
        </div>`).join("")}</div>
      <button type="button" class="linkbtn quiet" data-act="lift-add-set" data-i="${i}">+ Add set</button>
    </div>`).join("");
  return `<form data-form="lifts" data-key="${draft.key}">
    <header>
      <div><div class="eyebrow">${esc(dayText(draft.key))}</div><h2>Log lifts</h2></div>
      <button type="button" class="x" data-close aria-label="Close">×</button>
    </header>
    <p class="hint">Weight is per set as lifted (for dumbbells, one dumbbell). Bodyweight moves can leave weight at 0.</p>
    <div class="lxs">${ex || `<div class="empty-row">No exercises yet.</div>`}</div>
    <button type="button" class="btn" data-act="lift-add-ex">+ Add exercise</button>
    <datalist id="exlist">${known.map((k) => `<option value="${esc(k)}"></option>`).join("")}</datalist>
    <footer>
      ${(ctx.raw[draft.key]?.manual?.lifts || []).length ? `<button type="button" class="btn danger ghost" data-act="lift-clear">Clear this day's lifts</button>` : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save lifts</button>
    </footer>
  </form>`;
}
