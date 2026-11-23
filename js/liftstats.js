/* ──────────────────────────────────────────────────────────────────────────
   Strength analysis: are you keeping (or building) strength while you lose
   fat, which lifts are ready to progress, which have stalled, and how much
   work each muscle group gets a week. Pure functions over resolved days, so
   the page and the server's notifications read the same answers.

   MEASURE — each session's best estimated one-rep max for an exercise
   (Epley: weight × (1 + reps / 30)), from working sets only: sets lighter
   than 60% of that session's top weight are treated as warm-ups. e1RM puts
   different rep ranges on one scale, so 3×5 one week and 3×10 the next
   still compare. Above ~12 reps it gets rough; such sets are marked.
   Bodyweight moves logged at 0 weight are tracked by reps instead.

   TREND — a robust (Theil–Sen) line through the last six weeks of sessions,
   as % per week of that lift. A single bad day can't make a decline: it
   takes a sustained slope AND the last two sessions both short of the
   window's best. Improving needs a slope clear of the noise.

   STRENGTH INDEX — chain-linked week to week (each week compares every lift
   with its own previous week), so swapping exercises doesn't fake a jump.

   VOLUME — working sets per muscle group a week, counted fractionally:
   1 for the muscles a lift mainly trains, ½ for those it helps (as in
   Pelland et al. 2024). Ranges follow the dose-response evidence
   (Schoenfeld 2017; Pelland 2024): roughly 10–20 sets a week for growth,
   far less to keep what you have when intensity stays up (Bickel 2011).

   Strength is a proxy: it moves with skill, fatigue, sleep, glycogen and
   water, so it can't prove muscle was kept or lost — only flag patterns.
   ────────────────────────────────────────────────────────────────────────── */
import { addDays, range, daysBetween, sleepMinutes } from "./metrics.js";
import { exerciseKey, mondayOf, dayTraining } from "./training.js";
import { theilSen } from "./energy.js";

const KG = 2.2046226218;
const lbOf = (s) => (s.unit === "kg" ? s.weight * KG : s.weight);
const epley = (lb, reps) => lb * (1 + reps / 30);
const med = (a) => { if (!a.length) return null; const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/* ── muscles & classification ──────────────────────────────────────────── */

export const MUSCLES = {
  chest: { label: "Chest", day: "push" },
  shoulders: { label: "Shoulders", day: "push" },
  triceps: { label: "Triceps", day: "push" },
  back: { label: "Back", day: "pull" },
  biceps: { label: "Biceps", day: "pull" },
  quads: { label: "Quads", day: "legs" },
  hamstrings: { label: "Hamstrings", day: "legs" },
  glutes: { label: "Glutes", day: "legs" },
  calves: { label: "Calves", day: "legs" },
  abs: { label: "Abs & core", day: "core" },
};
export const DAY_LABELS = { push: "Push", pull: "Pull", legs: "Legs", core: "Core" };
const LOWER = new Set(["quads", "hamstrings", "glutes", "calves"]);

/*
   First match wins, so the specific patterns come before the general ones
   ("leg curl" before "curl", "glute kickback" before "kickback",
   "lat pulldown" before "lateral raise").
*/
const RULES = [
  [/rear delt|reverse (fly|flye|pec)|face ?pull/, { shoulders: 1, back: 0.5 }, "pull"],
  [/calf|calves/, { calves: 1 }, "legs"],
  [/hip thrust|glute bridge|glute kick|cable kickback.*glute|glute|abduct/, { glutes: 1 }, "legs"],
  [/leg curl|hamstring curl|nordic|glute[- ]ham/, { hamstrings: 1 }, "legs"],
  [/romanian|\brdl\b|stiff[- ]?leg|good ?morning/, { hamstrings: 1, glutes: 0.5, back: 0.5 }, "legs"],
  [/leg extension|sissy/, { quads: 1 }, "legs"],
  [/adduct/, { quads: 0.5, glutes: 0.5 }, "legs"],
  [/back extension|hyperextension|reverse hyper/, { glutes: 0.5, hamstrings: 0.5, back: 0.5 }, "pull"],
  [/rack pull/, { back: 1, glutes: 0.5, hamstrings: 0.5 }, "pull"],
  [/deadlift|trap bar/, { glutes: 1, hamstrings: 0.5, back: 0.5, quads: 0.5 }, "pull"],
  [/squat|leg press|hack|lunge|step[- ]?up|pistol|bulgarian|split/, { quads: 1, glutes: 0.5 }, "legs"],
  [/lat ?pull|pull[- ]?down|pull[- ]?up|chin[- ]?up|pullover|straight[- ]arm/, { back: 1, biceps: 0.5 }, "pull"],
  [/upright row/, { shoulders: 1, back: 0.5 }, "push"],
  [/row\b|rows\b|t[- ]?bar|seal row|inverted row|meadows/, { back: 1, biceps: 0.5, shoulders: 0.5 }, "pull"],
  [/curl/, { biceps: 1 }, "pull"],
  [/shrug/, { back: 1 }, "pull"],
  [/leg raise|hanging|crunch|plank|sit[- ]?up|ab wheel|rollout|russian twist|wood ?chop|pallof|\babs?\b|core|dead bug/, { abs: 1 }, "core"],
  [/lateral raise|side raise|\blat raise|y[- ]raise|front raise/, { shoulders: 1 }, "push"],
  [/overhead press|shoulder press|military|\bohp\b|arnold|push press|landmine press|z press/, { shoulders: 1, triceps: 0.5 }, "push"],
  [/close[- ]grip (bench|press)|\bjm press/, { triceps: 1, chest: 0.5 }, "push"],
  [/dip/, { triceps: 1, chest: 0.5, shoulders: 0.5 }, "push"],
  [/fly|flye|pec deck|crossover|cable cross/, { chest: 1 }, "push"],
  [/bench|chest press|incline|decline|floor press|push[- ]?up|press[- ]?up|svend/, { chest: 1, triceps: 0.5, shoulders: 0.5 }, "push"],
  [/tricep|pushdown|push[- ]down|skull ?crusher|kickback|overhead extension|french press/, { triceps: 1 }, "push"],
];

/**
 * What a lift trains: { groups: { muscle: 1 | 0.5 }, day, known, custom }.
 * `overrides` is your own { exerciseKey: muscle | "none" } for names the
 * rules don't recognise (or get wrong).
 */
export function classify(name, overrides = {}) {
  const k = exerciseKey(name);
  const o = overrides?.[k];
  if (o === "none") return { groups: {}, day: null, known: true, custom: true };
  if (o && MUSCLES[o]) return { groups: { [o]: 1 }, day: MUSCLES[o].day, known: true, custom: true };
  for (const [re, groups, day] of RULES) if (re.test(k)) return { groups, day, known: true, custom: false };
  return { groups: {}, day: null, known: false, custom: false };
}

export function cleanExerciseGroups(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw).slice(0, 300)) {
    const key = exerciseKey(k).slice(0, 80);
    if (key && (v === "none" || MUSCLES[v])) out[key] = v;
  }
  return out;
}

/* ── one exercise in one session ───────────────────────────────────────── */

/** Working sets: drops warm-ups (under 60% of the session's top weight). */
export function workingSets(sets) {
  const ok = (sets || []).filter((s) => s.reps > 0);
  const top = Math.max(0, ...ok.map(lbOf));
  return top > 0 ? ok.filter((s) => lbOf(s) >= 0.6 * top) : ok;
}

/** One session of one exercise, summarised. null when nothing usable. */
export function sessionStat(lift) {
  const work = workingSets(lift.sets);
  if (!work.length) return null;
  const weighted = work.some((s) => s.weight > 0);
  const unit = work.find((s) => s.weight > 0)?.unit || work[0].unit || "lb";
  const topLb = Math.max(...work.map(lbOf));
  const atTop = work.filter((s) => lbOf(s) === topLb);
  let best = work[0], value = 0;
  for (const s of work) {
    const v = weighted ? epley(lbOf(s), s.reps) : s.reps;
    if (v > value) { value = v; best = s; }
  }
  const reps = work.map((s) => s.reps);
  return {
    metric: weighted ? "e1rm" : "reps",
    value,
    best: { reps: best.reps, weight: best.weight, unit: best.unit },
    rough: weighted && best.reps > 12,
    topLb, topWeight: atTop[0].weight, unit,
    repsAtTop: atTop.map((s) => s.reps),
    sets: work.length,
    volumeLb: work.reduce((s, x) => s + x.reps * lbOf(x), 0),
    dropoff: reps.length >= 2 ? reps[0] - reps[reps.length - 1] : 0,
  };
}

/* ── per-exercise history ──────────────────────────────────────────────── */

/** Every exercise you've logged up to `today`: { key, name, cls, sessions: [{ key, ...stat }] }. */
export function exerciseHistory(days, today, overrides = {}) {
  const out = {};
  for (const k of Object.keys(days).filter((x) => x <= today).sort()) {
    for (const l of days[k]?.lifts || []) {
      const ek = exerciseKey(l.exercise);
      if (!ek) continue;
      const st = sessionStat(l);
      if (!st) continue;
      const ex = (out[ek] ||= { key: ek, name: l.exercise, cls: classify(l.exercise, overrides), sessions: [] });
      ex.name = l.exercise; // the newest spelling
      const same = ex.sessions.at(-1);
      // the same exercise twice in a day: keep the better one, add up the work
      if (same?.key === k) {
        if (st.value > same.value) Object.assign(same, { ...st, sets: same.sets + st.sets, volumeLb: same.volumeLb + st.volumeLb, key: k });
        else { same.sets += st.sets; same.volumeLb += st.volumeLb; }
      } else ex.sessions.push({ key: k, ...st });
    }
  }
  return out;
}

const WINDOW = 42; // six weeks
export const STATUS_WORDS = { improving: "Improving", stable: "Stable", declining: "Declining", insufficient: "Not enough data" };

/**
 * One exercise's trend over the last six weeks: status, % per week, best,
 * whether it has stalled. Needs 3+ sessions over 14+ days, the latest
 * within three weeks.
 */
export function exerciseTrend(ex, today) {
  const from = addDays(today, -(WINDOW - 1));
  const s = ex.sessions.filter((x) => x.key >= from);
  const all = ex.sessions;
  const last = all.at(-1);
  const bestEver = all.reduce((b, x) => (x.value > (b?.value ?? -1) ? x : b), null);
  const out = { status: "insufficient", n: s.length, last, bestEver, pctWk: null, change: null, stalled: false, sinceBest: bestEver ? daysBetween(bestEver.key, today) : null };
  if (!last || daysBetween(last.key, today) > 21) return { ...out, dormant: !!last };
  if (s.length < 3 || daysBetween(s[0].key, s.at(-1).key) < 14) return out;
  const pts = s.map((x) => [daysBetween(from, x.key), x.value]);
  const t = theilSen(pts);
  const mid = med(s.map((x) => x.value)) || 1;
  const pctWk = (t.slope * 7 / mid) * 100;
  const sePct = Number.isFinite(t.se) ? (t.se * 7 / mid) * 100 : Infinity;
  const span = pts.at(-1)[0] - pts[0][0];
  const change = (t.slope * span) / (t.at(pts[0][0]) || mid);
  const windowBest = Math.max(...s.map((x) => x.value));
  const lastTwo = s.slice(-2);
  const priorBest = Math.max(...s.slice(0, -2).map((x) => x.value), -Infinity);
  const sustainedDrop = s.length >= 4 && lastTwo.every((x) => x.value < 0.975 * priorBest);
  let status = "stable";
  if (pctWk >= 0.5 && pctWk - sePct > 0) status = "improving";
  else if (pctWk <= -0.5 && pctWk + sePct < 0 && sustainedDrop) status = "declining";
  // stalled: still training it, but no new best for 4+ weeks and no climb
  const sessionsSinceBest = all.filter((x) => x.key > (bestEver?.key || "")).length;
  const stalled = status !== "improving" && out.sinceBest >= 28 && sessionsSinceBest >= 4;
  return { ...out, status, pctWk, sePct, change, windowBest, stalled, sessionsSinceBest, trend: t, from };
}

/* ── what to do next session ───────────────────────────────────────────── */

/** The rep range you usually work in for this lift, from your history. */
export function repRange(ex) {
  const recent = ex.sessions.slice(-8).map((x) => Math.min(...x.repsAtTop));
  const lo = Math.max(1, Math.round(med(recent) || 8));
  return [lo, lo + (lo >= 12 ? 3 : 2)];
}

/**
 * The smallest sensible jump: barbell and machine lifts 10 lb lower body /
 * 5 lb upper (5 / 2.5 kg); dumbbells the next pair up (5 lb / 2 kg);
 * light cable and isolation loads 2.5 lb (1.25 kg).
 */
export function increment(ex, weight, unit) {
  const kg = unit === "kg";
  const lower = Object.keys(ex.cls.groups).some((m) => LOWER.has(m) && ex.cls.groups[m] === 1);
  if (/dumbbell|\bdb\b|kettlebell|\bkb\b/.test(ex.key)) return kg ? 2 : 5;
  if (weight < (kg ? 20 : 45)) return kg ? 1.25 : 2.5;
  return lower ? (kg ? 5 : 10) : (kg ? 2.5 : 5);
}

/**
 * Double progression: build reps at a weight until every working set
 * reaches your usual range, twice running (or the top of it once), then
 * add the smallest jump and build back up. Returns { kind, title, text }.
 * kind: "add-weight" · "add-reps" · "hold" · "stalled" · "declining" · "reps" · "insufficient"
 */
export function nextStep(ex, trend) {
  const s = ex.sessions;
  const last = s.at(-1);
  if (!last || trend.dormant) return { kind: "insufficient", title: "Not done lately", text: "No session in the last three weeks." };
  const [lo, hi] = repRange(ex);
  if (last.metric === "reps") {
    const target = Math.max(...last.repsAtTop) + 1;
    return { kind: "reps", title: "Add a rep", text: `Bodyweight: aim for ${target} on your first set${target >= 15 ? ", or add a little weight and drop back to 8–12" : ""}.` };
  }
  if (trend.status === "declining") {
    return { kind: "declining", title: "Hold the weight", text: `Down over several sessions. Keep ${fmtW(last.topWeight, last.unit)} and match your reps before adding anything; check sleep, protein and the size of your deficit.` };
  }
  const sameWeight = s.slice(-2).length === 2 && s.at(-2).topLb === last.topLb;
  const allHit = (x, r) => x.repsAtTop.length > 0 && x.repsAtTop.every((v) => v >= r);
  const ready = allHit(last, hi) || (sameWeight && allHit(last, lo) && allHit(s.at(-2), lo));
  if (ready) {
    const inc = increment(ex, last.topWeight, last.unit);
    return { kind: "add-weight", title: `Ready: ${fmtW(last.topWeight + inc, last.unit)}`, text: `You hit ${lo}+ reps on every working set${allHit(last, hi) ? "" : " twice running"} at ${fmtW(last.topWeight, last.unit)}. Try ${fmtW(last.topWeight + inc, last.unit)} for ${lo}–${lo + 1} — a rep or two fewer at first is normal — then build back to ${hi}.`, inc };
  }
  if (trend.stalled) {
    const alt = hi >= 12 ? `${Math.max(4, lo - 5)}–${Math.max(6, lo - 3)}, heavier` : `${hi + 2}–${hi + 4}, lighter`;
    return { kind: "stalled", title: "Stalled", text: `No new best in ${Math.round(trend.sinceBest / 7)} weeks. ${trend.inDeficit ? "Holding strength in a deficit is a win — " : ""}try a different rep range (e.g. ${alt}), one fewer set if recovery's short, or a close variation; don't just add weight.` };
  }
  const short = last.repsAtTop.filter((v) => v < lo).length;
  if (!short) return { kind: "add-reps", title: "Confirm, then add", text: `You hit ${lo}+ on every working set at ${fmtW(last.topWeight, last.unit)}. Match that next time (or add a rep toward ${hi}) and it's time to add weight.` };
  return { kind: "add-reps", title: "Build reps", text: `Stay at ${fmtW(last.topWeight, last.unit)}: aim for ${lo} on every working set (${short} set${short === 1 ? " was" : "s were"} short last time), then up to ${hi}.` };
}
const fmtW = (w, unit) => `${Math.round(w * 10) / 10} ${unit === "kg" ? "kg" : "lb"}`;

/* ── strength index ────────────────────────────────────────────────────── */

/**
 * Weekly chain-linked index (100 at the first week): each week, every lift
 * trained is compared with its own most recent earlier week (within six
 * weeks), and the index moves by the average log change. Overall and per
 * Push / Pull / Legs. Reps-only lifts are left out.
 */
export function strengthIndex(exs, today, weeks = 16) {
  const mon = mondayOf(today);
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(mon, -7 * (weeks - 1 - i)));
  const weekOf = (k) => mondayOf(k);
  const per = Object.values(exs).filter((e) => e.sessions.some((x) => x.metric === "e1rm")).map((e) => {
    const byWeek = {};
    for (const x of e.sessions) if (x.metric === "e1rm") { const w = weekOf(x.key); byWeek[w] = Math.max(byWeek[w] || 0, x.value); }
    return { day: e.cls.day, byWeek };
  });
  const groups = { all: () => true, push: (e) => e.day === "push", pull: (e) => e.day === "pull", legs: (e) => e.day === "legs" };
  const out = mondays.map((m) => ({ monday: m, end: addDays(m, 6) > today ? today : addDays(m, 6) }));
  for (const [name, keep] of Object.entries(groups)) {
    const list = per.filter(keep);
    let idx = null;
    mondays.forEach((m, i) => {
      const logs = [];
      let present = 0;
      for (const e of list) {
        if (e.byWeek[m] == null) continue;
        present += 1;
        for (let j = 1; j <= 6; j++) {
          const p = e.byWeek[addDays(m, -7 * j)];
          if (p) { logs.push(Math.log(e.byWeek[m] / p)); break; }
        }
      }
      if (idx == null && present) idx = 100;
      else if (idx != null && logs.length) idx *= Math.exp(mean(logs));
      out[i][name] = present ? idx : null;
      out[i][`${name}N`] = present;
    });
  }
  return out;
}

/* ── weekly volume by muscle group ─────────────────────────────────────── */

export const VOLUME_ZONES = [
  { max: 0, id: "none", word: "Not logged" },
  { max: 4, id: "low", word: "Low" },
  { max: 10, id: "keep", word: "Maintenance" },
  { max: 20.5, id: "grow", word: "Productive" },
  { max: Infinity, id: "high", word: "High" },
];
export const zoneOf = (sets) => VOLUME_ZONES[sets <= 0 ? 0 : sets < 4 ? 1 : sets < 10 ? 2 : sets <= 20.5 ? 3 : 4];

/**
 * Sets per muscle group for the current week (so far) and the average of
 * the previous four complete weeks, plus how many days each got direct
 * work, and the push / pull / legs split.
 */
export function muscleVolume(days, today, overrides = {}, weeks = 4) {
  const mon = mondayOf(today);
  const tally = (a, b) => {
    const sets = Object.fromEntries(Object.keys(MUSCLES).map((m) => [m, 0]));
    const freq = Object.fromEntries(Object.keys(MUSCLES).map((m) => [m, 0]));
    let total = 0, sessions = 0, unclassified = 0;
    for (const k of range(a, b)) {
      const lifts = days[k]?.lifts || [];
      if (!lifts.length) continue;
      sessions += 1;
      const hit = new Set();
      for (const l of lifts) {
        const n = workingSets(l.sets).length;
        total += n;
        const c = classify(l.exercise, overrides);
        if (!c.known) unclassified += n;
        for (const [m, w] of Object.entries(c.groups)) { sets[m] += n * w; if (w === 1) hit.add(m); }
      }
      for (const m of hit) freq[m] += 1;
    }
    return { sets, freq, total, sessions, unclassified };
  };
  const current = tally(mon, today);
  const past = Array.from({ length: weeks }, (_, i) => tally(addDays(mon, -7 * (i + 1)), addDays(mon, -7 * i - 1)));
  const trained = past.filter((w) => w.sessions > 0);
  const avg = {
    sets: Object.fromEntries(Object.keys(MUSCLES).map((m) => [m, trained.length ? trained.reduce((s, w) => s + w.sets[m], 0) / trained.length : 0])),
    freq: Object.fromEntries(Object.keys(MUSCLES).map((m) => [m, trained.length ? trained.reduce((s, w) => s + w.freq[m], 0) / trained.length : 0])),
    total: trained.length ? trained.reduce((s, w) => s + w.total, 0) / trained.length : 0,
    sessions: trained.length ? trained.reduce((s, w) => s + w.sessions, 0) / trained.length : 0,
    unclassified: trained.length ? trained.reduce((s, w) => s + w.unclassified, 0) / trained.length : 0,
  };
  const side = (src, d) => Object.entries(src).filter(([m]) => MUSCLES[m].day === d).reduce((s, [, v]) => s + v, 0);
  const pushSets = side(avg.sets, "push"), pullSets = side(avg.sets, "pull");
  return { current, avg, weeks: trained.length, past, pushPull: pullSets > 0 ? pushSets / pullSets : null };
}

/* ── the session's day type (Push / Pull / Legs) ───────────────────────── */

/** "push" · "pull" · "legs" · "core" · null — whichever the session's sets mostly were. */
export function sessionDay(lifts, overrides = {}) {
  const t = {};
  for (const l of lifts || []) {
    const c = classify(l.exercise, overrides);
    if (c.day) t[c.day] = (t[c.day] || 0) + workingSets(l.sets).length;
  }
  const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/* ── recovery context ──────────────────────────────────────────────────── */

/** Training days, rest days and the longest run without rest; sleep; check-ins. */
export function recoveryContext(days, today) {
  const last7 = range(addDays(today, -6), today);
  const trained = (k) => dayTraining(days[k]).any;
  const trainDays7 = last7.filter(trained).length;
  let run = 0, longest = 0, current = 0;
  for (const k of range(addDays(today, -27), today)) {
    if (trained(k)) { run += 1; longest = Math.max(longest, run); } else run = 0;
  }
  for (const k of [...range(addDays(today, -27), today)].reverse()) { if (trained(k)) current += 1; else break; }
  const sl = range(addDays(today, -13), today).map((k) => sleepMinutes(days[k])).filter((v) => v != null);
  const ci = last7.map((k) => days[k]?.checkin).filter(Boolean);
  const avgCi = (f) => { const v = ci.map((c) => c[f]).filter((x) => x != null); return v.length ? mean(v) : null; };
  return {
    trainDays7, restDays7: 7 - trainDays7, longestRun: longest, currentRun: current,
    sleep: sl.length >= 5 ? mean(sl) : null, sleepN: sl.length,
    checkins: ci.length, soreness: avgCi("soreness"), fatigue: avgCi("fatigue"), motivation: avgCi("motivation"), energy: avgCi("energy"),
  };
}

/* ── everything together ───────────────────────────────────────────────── */

/**
 * The whole picture for the Fitness page, the weekly report, notifications
 * and the calorie suggestion. `energy` is the energyOf() bundle when the
 * page has it (weight trend, deficit, protein); it's optional.
 */
export function strengthAnalysis(days, g, today, energy = null) {
  const overrides = g?.exerciseGroups || {};
  const exs = exerciseHistory(days, today, overrides);
  const inDeficit = energy?.energy && energy?.intake?.kcal != null ? energy.energy.estimate - energy.intake.kcal > 150 : g?.phase ? g.phase === "cut" : true;
  const list = Object.values(exs).map((ex) => {
    const trend = { ...exerciseTrend(ex, today), inDeficit };
    return { ...ex, trend, next: nextStep(ex, trend), range: repRange(ex) };
  }).sort((a, b) => (b.trend.last?.key || "").localeCompare(a.trend.last?.key || "") || b.sessions.length - a.sessions.length);
  const live = list.filter((e) => e.trend.status !== "insufficient");
  const count = (st) => live.filter((e) => e.trend.status === st).length;
  const pcts = live.map((e) => e.trend.pctWk).filter((v) => v != null);
  const medPct = med(pcts);
  let status = "insufficient";
  if (live.length >= 2) {
    const D = count("declining"), I = count("improving");
    if ((D >= 2 && D >= live.length / 3) || medPct <= -0.5) status = "declining";
    else if (medPct >= 0.4 && D <= 1 && I >= 1) status = "improving";
    else status = "stable";
  }
  const index = strengthIndex(exs, today);
  // six weeks back from the latest week with lifting (this week may not have any yet)
  const lastI = index.findLastIndex((w) => w.all != null);
  const baseI = lastI >= 6 ? index.slice(0, lastI - 5).findLastIndex((w) => w.all != null) : -1;
  const strengthChange = lastI >= 0 && baseI >= 0 && lastI - baseI >= 4 ? index[lastI].all / index[baseI].all - 1 : null;
  const volume = muscleVolume(days, today, overrides);
  const recovery = recoveryContext(days, today);
  const since14 = addDays(today, -13);
  const recentPRs = [];
  for (const e of list) {
    const s = e.sessions;
    for (let i = 1; i < s.length; i++) {
      if (s[i].key < since14) continue;
      const before = s.slice(0, i).filter((x) => x.metric === s[i].metric);
      if (!before.length) continue;
      const prev = Math.max(...before.map((x) => x.value));
      if (s[i].value > prev * 1.005) recentPRs.push({ exercise: e.name, key: s[i].key, from: prev, to: s[i].value, metric: s[i].metric, set: s[i].best });
    }
  }
  const unclassified = list.filter((e) => !e.cls.known).map((e) => ({ key: e.key, name: e.name, sessions: e.sessions.length }));
  const out = {
    status, medPct, exercises: list, live: live.length,
    counts: { improving: count("improving"), stable: count("stable"), declining: count("declining") },
    ready: list.filter((e) => e.next.kind === "add-weight"), stalled: list.filter((e) => e.next.kind === "stalled"),
    index, strengthChange, volume, recovery, recentPRs, unclassified, inDeficit,
  };
  out.preservation = preservation(out, energy, g);
  out.balance = balance(out);
  return out;
}

/**
 * Strength set against weight loss, the deficit, protein and sleep. Each
 * note is { kind: "good" | "watch" | "concern" | "info", text }.
 */
function preservation(a, energy, g) {
  const notes = [];
  const trend = energy?.trend;
  const wPct = trend?.enough ? trend.pctPerWeek : null;
  const kg = energy?.weight ? energy.weight / KG : null;
  const protein = energy?.intake?.protein != null && kg ? energy.intake.protein / kg : null;
  const deficit = energy?.energy && energy?.intake?.kcal != null ? energy.energy.estimate - energy.intake.kcal : null;
  const sc = a.strengthChange;
  const weight6 = wPct != null ? (wPct / 100) * 6 : null;
  const relative = sc != null && weight6 != null ? (1 + sc) / (1 + weight6) - 1 : null;
  if (a.status === "insufficient") {
    notes.push({ kind: "info", text: "Log the same main lifts for 3+ sessions over two weeks or more to see whether strength is holding." });
  } else if (a.status !== "declining") {
    if (wPct != null && wPct < -0.1) notes.push({ kind: "good", text: `Strength ${a.status === "improving" ? "rising" : "holding"} while body weight falls ${Math.abs(wPct).toFixed(2)}% a week — the pattern you'd expect when muscle is being kept.` });
    else notes.push({ kind: "good", text: `Strength ${a.status === "improving" ? "is rising" : "is holding steady"} across your main lifts.` });
  } else {
    notes.push({ kind: "concern", text: `Strength has slipped on ${a.counts.declining} lift${a.counts.declining === 1 ? "" : "s"} over several sessions — not one bad day. Worth acting on before it continues.` });
  }
  if (wPct != null && wPct < -1) notes.push({ kind: a.status === "declining" ? "concern" : "watch", text: `Losing ${Math.abs(wPct).toFixed(1)}% of body weight a week. Faster than ~1% a week is linked to more lean-mass loss, especially when lean (Helms 2014; Garthe 2011).` });
  if (protein != null) {
    if (protein < 1.6) notes.push({ kind: a.status === "declining" ? "concern" : "watch", text: `Protein is averaging ${protein.toFixed(1)} g/kg. In a deficit, 1.6–2.4 g/kg (≈${Math.round(1.6 * kg)}–${Math.round(2.4 * kg)} g) best supports keeping muscle (Morton 2018; Helms 2014).` });
    else notes.push({ kind: "good", text: `Protein ${protein.toFixed(1)} g/kg on complete days — in the range that supports keeping muscle.` });
  }
  if (deficit != null && energy?.energy?.estimate && deficit > 0.25 * energy.energy.estimate) notes.push({ kind: "watch", text: `The estimated deficit (~${Math.round(deficit)} kcal, ${Math.round((deficit / energy.energy.estimate) * 100)}% of maintenance) is large — training quality usually suffers first.` });
  const r = a.recovery;
  if (r.sleep != null && r.sleep < 420) notes.push({ kind: a.status === "declining" ? "concern" : "watch", text: `Sleep is averaging ${Math.floor(r.sleep / 60)}h ${String(Math.round(r.sleep % 60)).padStart(2, "0")}m. Under 7 hours is linked to worse strength and more lean loss in a deficit (Nedeltcheva 2010).` });
  if (relative != null) notes.push({ kind: "info", text: `Relative strength (strength index ÷ body weight) ${relative >= 0 ? "up" : "down"} about ${Math.abs(relative * 100).toFixed(1)}% over six weeks.` });
  return { notes, protein, deficit, weightPct: wPct, relative };
}

/** Volume, frequency and rest, read against recovery. Each note is { kind, text }. */
function balance(a) {
  const notes = [];
  const v = a.volume, r = a.recovery;
  const declining = new Set(a.exercises.filter((e) => e.trend.status === "declining").flatMap((e) => Object.keys(e.cls.groups).filter((m) => e.cls.groups[m] === 1)));
  if (v.weeks) {
    for (const [m, sets] of Object.entries(v.avg.sets)) {
      if (sets > 20.5 && declining.has(m)) notes.push({ kind: "watch", text: `${MUSCLES[m].label}: ~${Math.round(sets)} sets a week while its lifts trend down — possibly more than you're recovering from in a deficit. Trimming a few sets often helps more than adding.` });
    }
    const low = Object.entries(v.avg.sets).filter(([m, s]) => s > 0 && s < 4 && m !== "abs").map(([m]) => MUSCLES[m].label);
    if (low.length) notes.push({ kind: "info", text: `Light on ${low.join(", ")} (under 4 sets a week). Even a few hard sets a week helps keep muscle in a deficit, if those matter to you.` });
    if (v.pushPull != null && (v.pushPull > 1.6 || v.pushPull < 0.6)) notes.push({ kind: "info", text: `Push-to-pull sets are about ${v.pushPull.toFixed(1)}:1 — ${v.pushPull > 1 ? "more pressing than pulling" : "more pulling than pressing"}. Roughly even is a common default for shoulder health.` });
    if (v.current.total > 1.3 * v.avg.total && v.avg.total > 0 && v.current.sessions >= 2) notes.push({ kind: "watch", text: `This week's ${v.current.total} working sets are well above your recent ~${Math.round(v.avg.total)} — a sudden jump is the classic setup for extra fatigue.` });
    if (v.avg.unclassified > 0) notes.push({ kind: "info", text: "Some exercises aren't matched to a muscle group yet — pick one for them below so the volume counts." });
  }
  if (r.longestRun >= 8) notes.push({ kind: "watch", text: `${r.longestRun} days in a row without a rest day in the last four weeks. Your six-day split already has a rest day — keeping it protects recovery.` });
  if (r.fatigue != null && r.fatigue >= 4) notes.push({ kind: "watch", text: `Check-ins report high fatigue this week (${r.fatigue.toFixed(1)}/5).` });
  if (r.soreness != null && r.soreness >= 4) notes.push({ kind: "watch", text: `Check-ins report high soreness this week (${r.soreness.toFixed(1)}/5).` });
  const dropoff = a.exercises.filter((e) => e.trend.status !== "insufficient" && e.sessions.slice(-3).length === 3 && e.sessions.slice(-3).every((x) => x.dropoff >= 3));
  if (dropoff.length) notes.push({ kind: "info", text: `Reps fall off 3+ between first and last set on ${dropoff.slice(0, 3).map((e) => e.name).join(", ")} — a sign the early sets go to (or near) failure. Resting 2–3 minutes, or stopping 1–2 reps short on early sets, keeps later sets productive (Schoenfeld 2016; Refalo 2023).` });
  return notes;
}
