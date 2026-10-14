/* ──────────────────────────────────────────────────────────────────────────
   Strength on the Fitness page: the week against your training plan, the
   lifting you've logged set by set, and the form to log it. Apple Health
   workouts say a session happened; only your own sets carry weight and
   reps, so volume and overload come from your log alone.
   ────────────────────────────────────────────────────────────────────────── */
import { addDays, mondayOf, range, fmtInt } from "./metrics.js";
import { WEEKDAYS, WEEKDAY_LABELS, PLAN_LABELS, weekStatus, liftHistory, dayVolume, knownExercises, pastSessions, lastTime } from "./training.js";
import { esc, tip } from "./charts.js";
import { cleanLift } from "./sources.js";

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
    return `<div class="lsrow"><button type="button" class="lsess" data-act="lifts-open" data-key="${p.key}">
      <span class="ls-d"><b>${esc(dayText(p.key))}</b><span>${fmtInt(p.volume)} lb volume${p.prs.length ? ` · <em class="pr">${p.prs.length} new best${p.prs.length === 1 ? "" : "s"}</em>` : ""}</span></span>
      <span class="ls-x">${lifts.map((l) => `<span><b>${esc(l.exercise)}</b> ${esc(setsText(l.sets))}</span>`).join("")}</span>
    </button><button type="button" class="btn ls-rep" data-act="lift-repeat-open" data-key="${p.key}" ${tip("Repeat this session", "Opens today's log with these exercises and sets, ready to adjust")}>Repeat</button></div>`;
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

/*
   The form isn't tied to the day you opened it on. `draft.from` is the day
   its lifts were loaded from; `draft.key` is the day they'll be saved on.
   Pick another day before typing and the form shows that day instead;
   pick one after typing (or with a saved session open) and what's in the
   form goes along — added to what that day already has, and taken off the
   day it came from. So a session can be logged, or moved, on any past day.
*/

const savedLifts = (raw, k) => raw[k]?.manual?.lifts || [];
const cleanAll = (lifts) => lifts.map((l) => cleanLift({ ...l, exercise: String(l.exercise ?? "").trim() })).filter(Boolean);

/** Anything typed into the form at all — an empty form can switch days freely. */
export function liftTyped(draft) {
  return draft.lifts.some((l) => String(l.exercise ?? "").trim() || l.sets.some((s) => String(s.reps ?? "").trim() || String(s.weight ?? "").trim()));
}

/** The form differs from what's saved on the day it came from (so leaving it would lose something). */
export function liftDirty(raw, draft) {
  const plain = (lifts) => JSON.stringify(cleanAll(lifts).map(({ id, ...l }) => l));
  return plain(draft.lifts) !== plain(savedLifts(raw, draft.from));
}

/**
 * What saving writes, as [{ key, lifts }] — the day saved on first, so a
 * failed save never leaves a session on neither day.
 */
export function liftWrites(raw, draft, lifts) {
  const { key, from } = draft;
  if (key === from) return [{ key, lifts }];
  const ids = new Set(lifts.map((l) => l.id));
  const writes = [{ key, lifts: [...savedLifts(raw, key).filter((l) => !ids.has(l.id)), ...lifts] }];
  if (savedLifts(raw, from).length) writes.push({ key: from, lifts: [] });
  return writes;
}

/** The "last time" line under an exercise — also redrawn on its own as you type a name. */
export function lastTimeHtml(days, draft, i) {
  const l = draft.lifts[i];
  const last = lastTime(days, l?.exercise, draft.key);
  if (!last) return "";
  const now = (l.sets || []).filter((x) => Number(x.reps) > 0).map((x) => ({ reps: Number(x.reps), weight: Number(x.weight) || 0, unit: x.unit === "kg" ? "kg" : "lb" }));
  const same = setsText(now) === setsText(last.sets);
  return `<span>Last time, ${esc(dayText(last.key))}: <b>${esc(setsText(last.sets))}</b></span>${same ? "" : ` <button type="button" class="linkbtn quiet" data-act="lift-last" data-i="${i}">Use these sets</button>`}`;
}

export function liftForm(ctx, draft) {
  const known = knownExercises(ctx.days).slice(0, 60);
  const { today } = ctx;
  const yesterday = addDays(today, -1);
  const rel = (k) => (k === today ? "Today · " : k === yesterday ? "Yesterday · " : "");
  const moved = draft.key !== draft.from;
  const leaving = moved ? savedLifts(ctx.raw, draft.from) : [];
  const there = moved ? savedLifts(ctx.raw, draft.key) : [];
  const day = dayText(draft.key);
  const notes = [];
  if (leaving.length) {
    notes.push(`Saving moves this session from <b>${esc(dayText(draft.from))}</b> to <b>${esc(day)}</b>.
      <button type="button" class="linkbtn" data-act="lift-keep">Keep it on ${esc(dayText(draft.from))}</button>`);
  }
  if (there.length) {
    notes.push(`${esc(day)} already has ${there.map((l) => `<b>${esc(l.exercise)}</b>`).join(", ")} logged — what's below is added to ${there.length === 1 ? "it" : "them"}.
      <button type="button" class="linkbtn" data-act="lift-view">Edit ${esc(day)}'s lifts instead</button>`);
  }
  if (draft.copiedFrom) {
    notes.push(`Copied from <b>${esc(dayText(draft.copiedFrom))}</b> — change any reps, weights or sets to what you actually did, then save.
      <button type="button" class="linkbtn" data-act="lift-repeat-undo">Undo</button>`);
  }
  if (!moved && draft.key === today && draft.lateNight && !savedLifts(ctx.raw, today).length) {
    notes.push(`Just past midnight — logging last night's session?
      <button type="button" class="linkbtn" data-act="lift-day" data-v="-1">Put it on ${esc(dayText(yesterday))}</button>`);
  }
  const past = pastSessions(ctx.days, draft.key, 8);
  const repeat = past.length ? `<details class="lrepeat"${liftTyped(draft) ? "" : " open"}>
      <summary>Repeat a past session</summary>
      <div class="lrep-list">${past.map((p) => `<button type="button" class="lrep" data-act="lift-repeat" data-key="${p.key}">
          <b>${esc(rel(p.key) + dayText(p.key))}</b><span>${p.lifts.map((l) => esc(l.exercise)).join(" · ")}</span></button>`).join("")}</div>
      <p class="hint small">Copies that day's exercises and sets in here. Nothing is saved until you change what's different this time and press Save.</p>
    </details>` : "";
  const ex = draft.lifts.map((l, i) => `<div class="lx">
      <div class="lx-h"><span class="inp"><input name="ex-${i}" list="exlist" value="${esc(l.exercise)}" placeholder="Exercise, e.g. Bench press" maxlength="80" aria-label="Exercise ${i + 1}"${i === 0 ? " data-focus" : ""}></span>
        <button type="button" class="ib" data-act="lift-del-ex" data-i="${i}" title="Remove exercise" aria-label="Remove exercise">×</button></div>
      <div class="lx-last" data-last="${i}">${lastTimeHtml(ctx.days, draft, i)}</div>
      <div class="lsets">${l.sets.map((s, j) => `<div class="lset">
          <span class="sn">${j + 1}</span>
          <span class="inp"><input name="r-${i}-${j}" type="number" min="1" max="1000" step="1" inputmode="numeric" value="${esc(s.reps ?? "")}" placeholder="reps" aria-label="Reps"><em>reps</em></span>
          <span class="times">×</span>
          <span class="inp"><input name="w-${i}-${j}" type="number" min="0" max="3000" step="0.5" inputmode="decimal" value="${esc(s.weight ?? "")}" placeholder="weight" aria-label="Weight"></span>
          <select name="u-${i}-${j}" aria-label="Unit"><option value="lb"${s.unit !== "kg" ? " selected" : ""}>lb</option><option value="kg"${s.unit === "kg" ? " selected" : ""}>kg</option></select>
          <button type="button" class="ib" data-act="lift-del-set" data-i="${i}" data-j="${j}" title="Remove set" aria-label="Remove set">×</button>
        </div>`).join("")}</div>
      <button type="button" class="linkbtn quiet" data-act="lift-add-set" data-i="${i}">+ Add set</button>
    </div>`).join("");
  return `<form data-form="lifts" data-key="${draft.key}">
    <header>
      <div><div class="eyebrow">${esc(rel(draft.key) + day)}</div><h2>Log lifts</h2></div>
      <button type="button" class="x" data-close aria-label="Close">×</button>
    </header>
    <div class="liftday" role="group" aria-label="Day of this session">
      <span class="ld-l">Day</span>
      <button type="button" class="nav" data-act="lift-day" data-v="-1" aria-label="Previous day">‹</button>
      <span class="inp"><input type="date" name="day" value="${draft.key}" max="${today}" required aria-label="Day of this session"></span>
      <button type="button" class="nav" data-act="lift-day" data-v="1" aria-label="Next day"${draft.key >= today ? " disabled" : ""}>›</button>
      ${draft.key !== today ? `<button type="button" class="nav" data-act="lift-day" data-v="0">Today</button>` : ""}
    </div>
    ${notes.map((n) => `<p class="liftnote">${n}</p>`).join("")}
    ${repeat}
    <p class="hint">Weight is per set as lifted (for dumbbells, one dumbbell). Bodyweight moves can leave weight at 0.</p>
    <div class="lxs">${ex || `<div class="empty-row">No exercises yet.</div>`}</div>
    <button type="button" class="btn" data-act="lift-add-ex">+ Add exercise</button>
    <datalist id="exlist">${known.map((k) => `<option value="${esc(k)}"></option>`).join("")}</datalist>
    <footer>
      ${!moved && savedLifts(ctx.raw, draft.key).length ? `<button type="button" class="btn danger ghost" data-act="lift-clear">Clear this day's lifts</button>` : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">${leaving.length ? `Move to ${esc(dayText(draft.key))}` : "Save lifts"}</button>
    </footer>
  </form>`;
}
