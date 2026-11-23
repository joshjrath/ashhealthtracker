/* ──────────────────────────────────────────────────────────────────────────
   Fitness page: strength & muscle preservation, progressive overload, and
   training volume & recovery. The numbers come from js/liftstats.js (worked
   out once per draw, alongside the energy balance, in energyOf); this file
   only lays them out.

   Estimated one-rep maxes are estimates; sets and reps are what you logged;
   weight trend is measured. Strength stands in for muscle — it can't
   measure it — and the page says so.
   ────────────────────────────────────────────────────────────────────────── */
import { energyOf } from "./energyview.js";
import { MUSCLES, DAY_LABELS, STATUS_WORDS, zoneOf, VOLUME_ZONES, classify, sessionDay, workingSets } from "./liftstats.js";
import { setsText } from "./strength.js";
import { esc, tip } from "./charts.js";
import { fmtInt, addDays, range } from "./metrics.js";
import { plannedFor, PLAN_LABELS, dayTraining } from "./training.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayShort = (k) => { const [y, m, d] = k.split("-").map(Number); return `${WD[new Date(y, m - 1, d).getDay()]} ${MONTHS[m - 1]} ${d}`; };
const pct = (v, dp = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}%`;
const ST_CLS = { improving: "ok", stable: "ok", declining: "bad", insufficient: "none" };
const NOTE = { good: ["ok", "Looks good"], watch: ["mid", "Watch"], concern: ["bad", "Concern"], info: ["none", "Note"] };
const TAG = { est: "Estimated", logged: "Logged", measured: "Measured trend" };
const tag = (t) => `<span class="etag ${t}">${TAG[t]}</span>`;
const notesList = (notes) => (notes.length ? `<ul class="snotes">${notes.map((n) => `<li><span class="epill sm ${NOTE[n.kind][0]}">${NOTE[n.kind][1]}</span><span>${esc(n.text)}</span></li>`).join("")}</ul>` : "");

/** The strength analysis for this draw (shared with the energy card's calorie suggestion). */
export const strengthOf = (ctx) => energyOf(ctx).strength;

/** The exercise the per-lift chart shows: your pick, else the one with most recent sessions. */
export function chosenLift(ctx) {
  const a = strengthOf(ctx);
  const pick = a.exercises.find((e) => e.key === ctx.ui.liftEx);
  if (pick) return pick;
  const since = addDays(ctx.today, -41);
  return [...a.exercises].sort((x, y) => y.sessions.filter((s) => s.key >= since).length - x.sessions.filter((s) => s.key >= since).length)[0] || null;
}

/* ── strength & muscle preservation ────────────────────────────────────── */

export function preservationCard(ctx) {
  const a = strengthOf(ctx);
  if (!a.exercises.length) return "";
  const p = a.preservation;
  const week = (from, to) => {
    const ks = range(from, to).filter((k) => ctx.days[k]?.lifts?.length);
    return { sessions: ks.length, sets: ks.reduce((s, k) => s + ctx.days[k].lifts.reduce((t, l) => t + workingSets(l.sets).length, 0), 0) };
  };
  const cur = week(addDays(ctx.today, -6), ctx.today), last = week(addDays(ctx.today, -13), addDays(ctx.today, -7));
  const prs7 = a.recentPRs.filter((x) => x.key >= addDays(ctx.today, -6)).length;
  const cell = (label, value, note, t) => `<div><span>${label} ${tag(t)}</span><b>${value}</b><em>${note}</em></div>`;
  const summary = `Past 7 days: <b>${cur.sessions} lifting session${cur.sessions === 1 ? "" : "s"}</b>, ${cur.sets} working sets${last.sessions ? ` (the 7 before: ${last.sessions} · ${last.sets})` : ""}${prs7 ? ` · <b>${prs7} new best${prs7 === 1 ? "" : "s"}</b>` : ""}.
    ${a.live ? `Over six weeks: ${a.counts.improving} lift${a.counts.improving === 1 ? "" : "s"} improving, ${a.counts.stable} stable, ${a.counts.declining} declining.` : ""}`;
  return `<section class="card energycard strengthcard" id="strength-preservation">
    <div class="cardhead"><h2>Strength &amp; muscle preservation <span class="sub">are you keeping strength while you lose fat?</span></h2>
      <span class="epill ${ST_CLS[a.status]}" ${tip(STATUS_WORDS[a.status], a.status === "insufficient" ? "Needs 2+ lifts with 3+ sessions over two weeks or more." : `Median trend across ${a.live} lift${a.live === 1 ? "" : "s"}: ${pct(a.medPct ?? 0, 2)} a week`)}>${STATUS_WORDS[a.status]}</span></div>
    <p class="ssum">${summary}</p>
    <div class="fgrid four ekpis">
      ${cell("Strength, 6 weeks", a.strengthChange == null ? "—" : `${pct(a.strengthChange * 100)}`, a.strengthChange == null ? "Needs ~6 weeks of logged sets" : "strength index across your lifts", "est")}
      ${cell("Relative strength", p.relative == null ? "—" : pct(p.relative * 100), p.relative == null ? "Needs weigh-ins too" : "strength ÷ body weight, 6 weeks", "est")}
      ${cell("Body weight", p.weightPct == null ? "—" : `${pct(p.weightPct, 2)}<small>/wk</small>`, p.weightPct == null ? "Needs ~8 weigh-ins over 14+ days" : `${(energyOf(ctx).trend.lbPerWeek).toFixed(1)} lb a week, 28 days`, "measured")}
      ${cell("Protein", p.protein == null ? "—" : `${p.protein.toFixed(1)}<small>g/kg</small>`, p.protein == null ? "Needs complete food days" : "complete days, last 14", "logged")}
    </div>
    <div class="sec-l">Strength index by week <span class="sub">100 = your first week shown; each lift compared with itself</span></div>
    <div class="chartbox" data-chart="sindex"></div>
    <div class="legend small"><span><i class="lg-line si-all"></i>All lifts</span><span><i class="lg-line si-push"></i>Push</span><span><i class="lg-line si-pull"></i>Pull</span><span><i class="lg-line si-legs"></i>Legs</span><span><i class="lg-dash"></i>Body weight (right axis)</span></div>
    ${notesList([...p.notes])}
    <p class="hint small">Strength stands in for muscle; it can't measure it. It also moves with sleep, fatigue, carbs, water and technique, so only a drop that lasts several sessions across several lifts is treated as a warning — never one bad day.</p>
  </section>`;
}

/* ── progressive overload ──────────────────────────────────────────────── */

export function overloadCard(ctx) {
  const a = strengthOf(ctx);
  if (!a.exercises.length) return "";
  const sel = chosenLift(ctx);
  const chip = (e, cls) => `<button type="button" class="ochip ${cls}" data-act="liftex" data-v="${esc(e.key)}">${esc(e.name)}${e.next.kind === "add-weight" ? ` → ${esc(e.next.title.replace("Ready: ", ""))}` : ""}</button>`;
  const shown = a.exercises.filter((e) => !e.trend.dormant || e.sessions.length >= 3);
  const SHOW = 8;
  const rows = (ctx.ui.liftAll ? shown.slice(0, 40) : shown.slice(0, SHOW)).map((e) => {
    const t = e.trend, l = t.last, best = t.bestEver;
    const day = e.cls.day ? `<span class="dtag ${e.cls.day}">${DAY_LABELS[e.cls.day]}</span>` : `<span class="dtag none">No group</span>`;
    const val = (s) => (s.metric === "reps" ? `${s.value} reps` : `${fmtInt(s.value)} lb`);
    return `<div class="orow${sel?.key === e.key ? " on" : ""}">
      <button type="button" class="o-name" data-act="liftex" data-v="${esc(e.key)}"><b>${esc(e.name)}</b>${day}</button>
      <div class="o-last"><span>${esc(dayShort(l.key))}</span><b>${esc(setsText(ctxLift(ctx, l.key, e.key)?.sets || []))}</b></div>
      <div class="o-e1"><span>Est. 1RM ${tag("est")}</span><b>${val(l)}</b><em>best ${val(best)}${best.key === l.key ? " (this session)" : `, ${esc(dayShort(best.key))}`}</em></div>
      <div class="o-tr"><span class="epill sm ${ST_CLS[t.status]}">${t.dormant ? "Not lately" : STATUS_WORDS[t.status]}</span><em>${t.pctWk == null ? `${t.n} session${t.n === 1 ? "" : "s"} in 6 wks` : `${pct(t.pctWk, 1)}/wk`}</em></div>
      <div class="o-next ${e.next.kind}"><b>${esc(e.next.title)}</b><span>${esc(e.next.text)}</span></div>
    </div>`;
  }).join("");
  const groups = a.exercises.slice(0, 60);
  const unknown = a.unclassified.length;
  const groupForm = `<details class="howto"${unknown ? " open" : ""}><summary>Muscle groups for your lifts${unknown ? ` — ${unknown} not matched yet` : ""}</summary>
    <form data-form="exgroups" class="exgroups">
      ${groups.map((e, i) => {
        const auto = classify(e.name, {});
        const set = ctx.g.exerciseGroups?.[e.key] || "";
        const autoLabel = auto.known ? Object.entries(auto.groups).filter(([, w]) => w === 1).map(([m]) => MUSCLES[m].label).join(" + ") : "not recognised";
        return `<label class="field"><span>${esc(e.name)}</span><span class="inp"><input type="hidden" name="gk-${i}" value="${esc(e.key)}"><select name="g-${i}">
          <option value=""${set ? "" : " selected"}>Automatic (${esc(autoLabel)})</option>
          ${Object.entries(MUSCLES).map(([m, x]) => `<option value="${m}"${set === m ? " selected" : ""}>${x.label}</option>`).join("")}
          <option value="none"${set === "none" ? " selected" : ""}>Don't count</option></select></span></label>`;
      }).join("")}
      <div class="actions"><button class="btn primary" type="submit">Save muscle groups</button><span class="saved" data-saved hidden></span></div>
    </form>
    <p class="hint small">Automatic matching knows common lifts by name (bench, row, squat, curl…) and counts helper muscles at half a set. Picking a group here counts the lift fully for that one group.</p>
  </details>`;
  return `<section class="card overloadcard" id="overload">
    <div class="cardhead"><h2>Progressive overload <span class="sub">what to do next session, lift by lift</span></h2></div>
    ${a.ready.length ? `<div class="ochips"><span class="ol">Ready to add weight</span>${a.ready.map((e) => chip(e, "ready")).join("")}</div>` : ""}
    ${a.stalled.length ? `<div class="ochips"><span class="ol">Stalled</span>${a.stalled.map((e) => chip(e, "stall")).join("")}</div>` : ""}
    <div class="otable">${rows}</div>
    ${shown.length > SHOW ? `<button type="button" class="linkbtn quiet" data-act="lift-all">${ctx.ui.liftAll ? "Show fewer" : `Show all ${shown.length} lifts`}</button>` : ""}
    ${sel ? `<div class="sec-l">${esc(sel.name)} <span class="sub">${sel.sessions.at(-1).metric === "reps" ? "best reps" : "estimated 1-rep max"} by session · rings mark new bests · line is the six-week trend</span></div>
    <div class="chartbox" data-chart="liftex"></div>` : ""}
    <details class="howto"><summary>How next steps are worked out</summary>
      <ol>
        <li><b>Double progression.</b> Your usual rep range for each lift is read from your log (e.g. 8–10). Build reps at a weight until every working set reaches the range twice running, or the top of it once — then add the smallest jump (5 lb upper, 10 lb lower, 5 lb dumbbells, 2.5 lb light cable work) and build back up.</li>
        <li><b>Training close to failure.</b> You can't add reps you don't have, so a lift that's held for a while is called <i>stalled</i> rather than pushed. On big compound lifts, stopping 1–2 reps short keeps form and later sets intact for about the same muscle growth (Refalo 2023); taking isolation work to failure is lower-risk.</li>
        <li><b>In a deficit, holding is a win.</b> Gains slow when eating less (Murphy &amp; Koehler 2022). For a stalled lift the suggestion is a change of rep range or variation, or a set less — not more load.</li>
        <li><b>Warm-ups are left out.</b> Sets under 60% of a session's top weight don't count. Estimated maxes use Epley's formula and get rough above ~12 reps.</li>
      </ol>
    </details>
    ${groupForm}
  </section>`;
}

/** The logged lift for an exercise on a day (for its "last session" sets). */
function ctxLift(ctx, key, ek) {
  return (ctx.days[key]?.lifts || []).find((l) => String(l.exercise || "").trim().toLowerCase().replace(/\s+/g, " ") === ek);
}

/* ── training volume & recovery ────────────────────────────────────────── */

export function volumeCard(ctx) {
  const a = strengthOf(ctx);
  if (!a.exercises.length) return "";
  const v = a.volume, r = a.recovery, ov = ctx.g.exerciseGroups || {};
  const strip = range(addDays(ctx.today, -6), ctx.today).map((k) => {
    const d = ctx.days[k];
    const did = sessionDay(d?.lifts, ov);
    const t = dayTraining(d);
    const planned = plannedFor(ctx.g.plan, k);
    const label = did ? DAY_LABELS[did] : t.strength ? "Lifting" : t.cardio ? "Cardio" : t.any ? "Workout" : k === ctx.today ? "—" : "Rest";
    const cls = did || (t.any ? "other" : "rest");
    return `<span class="pd ${cls}${k === ctx.today ? " today" : ""}" ${tip(dayShort(k), planned ? `Planned: ${PLAN_LABELS[planned]}` : "No plan set", did ? `${DAY_LABELS[did]} session logged` : t.any ? "Workout synced" : "Nothing logged")}><em>${esc(dayShort(k).slice(0, 3))}</em><b>${label}</b>${planned && planned !== "strength" && planned !== "any" && planned !== "cardio" && PLAN_LABELS[planned] !== label ? `<i>${planned === "rest" ? "Rest day" : `Plan: ${PLAN_LABELS[planned]}`}</i>` : ""}</span>`;
  }).join("");
  const max = Math.max(22, ...Object.values(v.avg.sets), ...Object.values(v.current.sets));
  const bars = Object.entries(MUSCLES).map(([m, info]) => {
    const avg = v.avg.sets[m], now = v.current.sets[m], z = zoneOf(avg);
    return `<div class="vrow" ${tip(info.label, v.weeks ? `~${fmtSets(avg)} sets a week (last ${v.weeks} week${v.weeks === 1 ? "" : "s"})` : "No complete weeks yet", `This week so far: ${fmtSets(now)}`, `Direct work ~${v.avg.freq[m].toFixed(1)} days a week`)}>
      <span class="vl">${info.label}</span>
      <span class="vbar"><span class="vzone" style="left:${(4 / max * 100).toFixed(1)}%;width:${((20.5 - 4) / max * 100).toFixed(1)}%"></span><span class="vfill z-${z.id}" style="width:${Math.min(100, (avg / max) * 100).toFixed(1)}%"></span>${now > 0 ? `<span class="vnow" style="left:${Math.min(100, (now / max) * 100).toFixed(1)}%"></span>` : ""}</span>
      <span class="vn"><b>${fmtSets(avg)}</b>${v.avg.freq[m] >= 0.5 ? `<em>${v.avg.freq[m].toFixed(1).replace(/\.0$/, "")}×/wk</em>` : ""}</span>
      <span class="vz z-${z.id}">${z.word}</span>
    </div>`;
  }).join("");
  const sleep = r.sleep == null ? "—" : `${Math.floor(r.sleep / 60)}h ${String(Math.round(r.sleep % 60)).padStart(2, "0")}m`;
  const facts = `<div class="fgrid four">
    <div><span>Training days</span><b>${r.trainDays7}<small>of 7</small></b><em>${r.restDays7} rest day${r.restDays7 === 1 ? "" : "s"} this past week</em></div>
    <div><span>Longest run</span><b>${r.longestRun}<small>days</small></b><em>without a rest day, last 4 weeks</em></div>
    <div><span>Sleep</span><b>${sleep}</b><em>${r.sleep == null ? "Log 5+ nights in two weeks" : `average, ${r.sleepN} nights logged`}</em></div>
    <div><span>Check-ins</span><b>${r.fatigue == null ? "—" : `${r.fatigue.toFixed(1)}<small>/5 fatigue</small>`}</b><em>${r.checkins ? `${r.checkins} this week${r.soreness != null ? ` · soreness ${r.soreness.toFixed(1)}/5` : ""}` : "None this week — add one from Log today"}</em></div>
  </div>`;
  return `<section class="card volumecard" id="volume">
    <div class="cardhead"><h2>Training volume &amp; recovery <span class="sub">working sets per muscle group, and how much rest you're getting</span></h2></div>
    <div class="sec-l">The past seven days</div>
    <div class="planweek ppl">${strip}</div>
    <div class="sec-l">Sets a week by muscle group <span class="sub">average of the last ${v.weeks || 4} weeks · tick = this week so far</span></div>
    <div class="vbars">${bars}</div>
    <div class="legend small">${VOLUME_ZONES.slice(1).map((z) => `<span><i class="lg-sq z-${z.id}"></i>${z.word} ${z.id === "low" ? "(<4)" : z.id === "keep" ? "(4–9)" : z.id === "grow" ? "(10–20)" : "(20+)"}</span>`).join("")}</div>
    ${facts}
    ${notesList(a.balance)}
    <p class="hint small">Sets for the muscles a lift mainly works count 1; helpers count ½ (Pelland 2024). About 10–20 hard sets a muscle a week suits growth (Schoenfeld 2017); while cutting, far fewer keep muscle as long as the weights stay heavy (Bickel 2011). Only what you log is counted.</p>
  </section>`;
}
const fmtSets = (n) => (n >= 10 ? String(Math.round(n)) : (Math.round(n * 2) / 2).toFixed(1).replace(/\.0$/, ""));
