/* ──────────────────────────────────────────────────────────────────────────
   "Am I On Track?" — where your weight and body composition are likely to
   go, from a dynamic energy-balance model rather than 3,500 kcal a pound.

   THE MODEL (after Hall 2008; Hall et al., Lancet 2011): body = fat mass F
   + lean mass L (+ water that comes and goes with glycogen). Each day
     expenditure E = your adaptive maintenance estimate today
                   + 3.2 kcal/kg × ΔF + 22 kcal/kg × ΔL         (resting cost)
                   + activity cost per kg × Δweight               (moving a lighter body)
                   + 10% × Δintake                                 (digestion)
                   + 14% × Δintake, phased in over ~a week         (adaptive thermogenesis)
                   + any change in activity you try in a scenario
   and the gap (intake − E) is stored or drawn from fat (9,440 kcal/kg) and
   lean tissue (1,816 kcal/kg), split by Forbes' rule p = C / (C + F), C =
   10.4 × 1,816 / 9,440. Because E falls as you get lighter, the same intake
   gives a slowing loss — never a straight line.

   MUSCLE — Forbes' split is for people who don't lift. Regular resistance
   training and higher protein cut the lean share of losses a lot (Weinheimer
   2010; Sardeli 2018; Longland 2016), and losing faster than ~1% a week
   raises it (Helms 2014; Garthe 2011). The lean factor below scales the
   split; it's evidence-informed but approximate, so it's one of the
   things varied in the ranges.

   STARTING POINT — everything is calibrated to what you've logged: the
   adaptive maintenance estimate (js/energy.js) is what you actually burn as
   you log intake, so wearable calorie numbers never enter. Scenario
   activity changes are estimated from steps and sessions and discounted.

   RANGES — the model is run many times, varying maintenance (by its own
   uncertainty), starting body fat (by its error), day-to-day adherence and
   the lean factor; the 10th–90th percentiles are shown.

   NOT FOREVER — by default the simulated you switches to maintenance on
   reaching your target body fat, and can take a maintenance week every
   few weeks (diet breaks; Byrne et al. 2018), rather than cutting forever.
   ────────────────────────────────────────────────────────────────────────── */
import { RHO_F, RHO_L, KG_PER_LB, cutPace } from "./energy.js";
import { addDays, range, daysBetween } from "./metrics.js";

const C = (10.4 * RHO_L) / RHO_F;
const GAMMA_F = 3.2, GAMMA_L = 22, BETA_TEF = 0.1, BETA_AT = 0.14;
export const HORIZON = 3 * 365;
export const STEP_KCAL_PER_KG = 0.0005; // ≈ 0.04 kcal a step at 80 kg (walking costs ~0.5 kcal/kg/km; ~1,300 steps/km)
export const SESSION_KCAL = 150; // net extra burn of a lifting session, beyond what you'd burn anyway

/**
 * How much of Forbes' lean share applies, from lifting sessions a week and
 * protein (g/kg). 1 = Forbes (no lifting); lower keeps more muscle.
 */
export function leanFactor(sessionsPerWeek, proteinGkg) {
  const s = Math.max(0, sessionsPerWeek ?? 0), q = proteinGkg ?? 1.2;
  const train = Math.max(0.35, 1 - 0.2167 * s); // 1 session ≈ 0.78, 2 ≈ 0.57, 3+ ≈ 0.35
  const prot = q >= 2 ? 0.75 : q >= 1.6 ? 0.85 : q >= 1.2 ? 1 : 1.15;
  return train * prot;
}

/** The share of an energy imbalance that lands in lean tissue. */
function energyShare(fatKg, factor, gaining, ratePct) {
  const p = C / (C + Math.max(fatKg, 1));
  if (gaining) return Math.min(0.75, p * (factor < 1 ? 2 - factor : 1)); // lifting steers a surplus toward muscle
  const fast = ratePct > 1 ? 1 + 0.5 * Math.min(1, ratePct - 1) : 1;
  return Math.min(0.9, Math.max(0.01, p * factor * fast));
}

/**
 * One run, day by day. Returns arrays of weight (lb, incl. water), fat and
 * lean (lb), body fat %, expenditure and intake, and the day each phase
 * switch happened.
 *
 * p: { weightLb, bodyFat, tdee, intakeNow, intake, days, factor,
 *      activity (kcal/day change), maintainAt (bf %, or null), breakEvery (weeks, or 0),
 *      adherence (kcal/day offset), floor (kcal) }
 */
export function simulate(p) {
  const days = p.days ?? HORIZON;
  const W0 = p.weightLb * KG_PER_LB;
  let F = (W0 * p.bodyFat) / 100, L = W0 - F;
  const F0 = F, L0 = L;
  const rmr = 370 + 21.6 * L0; // Katch–McArdle
  const pa = Math.max(0, p.tdee - rmr - BETA_TEF * p.intakeNow);
  const perKg = pa / W0;
  let at = 0, water = 0, maintaining = false;
  const out = { w: [], fat: [], lean: [], bf: [], e: [], ei: [], reachedAt: null };
  for (let t = 0; t <= days; t++) {
    const W = F + L;
    const bf = (F / W) * 100;
    if (p.maintainAt != null && !maintaining && bf <= p.maintainAt) { maintaining = true; out.reachedAt = t; }
    const onBreak = p.breakEvery > 0 && !maintaining && t >= 7 * p.breakEvery && Math.floor(t / 7) % (p.breakEvery + 1) === p.breakEvery;
    const activity = (p.activity || 0) * (W / W0);
    const base = p.tdee + GAMMA_F * (F - F0) + GAMMA_L * (L - L0) + perKg * (W - W0) + activity;
    // planned intake, or what holds weight steady (maintenance after the goal, or a diet break)
    let ei = p.intake + (p.adherence || 0);
    // (solved so that intake equals expenditure today, given how adaptation updates below)
    if (maintaining || onBreak) ei = (base + (6 / 7) * at - BETA_TEF * p.intakeNow - (BETA_AT / 7) * p.intakeNow) / (1 - BETA_TEF - BETA_AT / 7);
    if (p.floor && ei < p.floor) ei = p.floor;
    // adaptive thermogenesis follows a change of intake over about a week
    at += (BETA_AT * (ei - p.intakeNow) - at) / 7;
    const e = base + BETA_TEF * (ei - p.intakeNow) + at;
    // glycogen and its water follow carbs and calories within days: ~1 lb per 500 kcal of change, capped
    const wTarget = Math.max(-0.7, Math.min(0.7, ((ei - p.intakeNow) / 500) * 0.45));
    water += (wTarget - water) / 3;
    out.w.push((W + water) / KG_PER_LB); out.fat.push(F / KG_PER_LB); out.lean.push(L / KG_PER_LB); out.bf.push(bf); out.e.push(e); out.ei.push(ei);
    const gap = ei - e;
    const p0 = Math.min(0.9, (C / (C + F)) * (p.factor ?? 1));
    const ratePct = gap < 0 ? ((-(p0 * gap) / RHO_L - ((1 - p0) * gap) / RHO_F) * 7 / W) * 100 : 0; // % of body weight a week
    const share = energyShare(F, p.factor ?? 1, gap > 0, ratePct);
    F += ((1 - share) * gap) / RHO_F;
    L += (share * gap) / RHO_L;
    if (F < 1) F = 1;
  }
  return out;
}

/** A small seeded random source, so the ranges don't flicker between draws. */
function rng(seed = 12345) {
  let s = seed;
  const u = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const n = () => { let a = 0; for (let i = 0; i < 6; i++) a += u(); return (a - 3) * Math.SQRT2; }; // ≈ N(0, 1)
  return { u, n };
}

const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };

/**
 * Many runs with the uncertain parts varied. Returns per-day 10th / 50th /
 * 90th percentiles of weight and body fat, the central lean and fat paths,
 * and when each body-fat / weight milestone is crossed (median and range).
 */
export function project(base, { runs = 80, milestones = [], goalWeight = null } = {}) {
  const r = rng(base.seed || 12345);
  const all = [];
  for (let i = 0; i < runs; i++) {
    const tdee = base.tdee + r.n() * (base.tdeeSd || 120);
    const bodyFat = Math.max(4, base.bodyFat + r.n() * (base.bodyFatErr || 3));
    const factor = (base.factor ?? 1) * Math.exp(r.n() * 0.35);
    const adherence = r.n() * 60;
    const activity = (base.activity || 0) * (1 + r.n() * 0.3);
    all.push(simulate({ ...base, tdee, bodyFat, factor, adherence, activity }));
  }
  const central = simulate(base);
  const days = central.w.length;
  const q = (key, qq) => Array.from({ length: days }, (_, t) => pct(all.map((s) => s[key][t]), qq));
  const res = {
    days, central,
    w: { p10: q("w", 0.1), p50: q("w", 0.5), p90: q("w", 0.9) },
    bf: { p10: q("bf", 0.1), p50: q("bf", 0.5), p90: q("bf", 0.9) },
    lean: { p10: q("lean", 0.1), p50: q("lean", 0.5), p90: q("lean", 0.9) },
  };
  const firstBelow = (s, key, v) => { const i = s[key].findIndex((x) => x <= v); return i < 0 ? null : i; };
  const cross = (key, v) => {
    const each = all.map((s) => firstBelow(s, key, v));
    const hit = each.filter((x) => x != null);
    if (hit.length < runs * 0.5) return { median: null, early: hit.length ? pct(hit, 0.1) : null, late: null, share: hit.length / runs };
    const filled = each.map((x) => (x == null ? Infinity : x));
    const late = pct(filled, 0.9);
    return { median: Math.round(pct(filled, 0.5)), early: Math.round(pct(filled, 0.1)), late: Number.isFinite(late) ? Math.round(late) : null, share: hit.length / runs };
  };
  res.milestones = milestones.map((m) => ({ bf: m, ...cross("bf", m) }));
  // each run's crossing day (Infinity when never), for paired comparisons between scenarios
  res.runs = Object.fromEntries(milestones.map((m) => [m, all.map((s) => firstBelow(s, "bf", m) ?? Infinity)]));
  res.leanRuns = all.map((s) => s.lean[Math.min(182, days - 1)] - s.lean[0]);
  if (goalWeight) res.goal = { weight: goalWeight, ...cross("w", goalWeight) };
  return res;
}

/**
 * How much sooner (+) or later (−) scenario B reaches a milestone than A, in
 * days: the median of run-by-run differences. Both must come from project()
 * with the same seed and number of runs, so each pair shares its random
 * draws — far steadier than subtracting two medians.
 */
export function pairedSooner(a, b, milestone, horizon = HORIZON) {
  const ra = a.runs?.[milestone], rb = b.runs?.[milestone];
  if (!ra || !rb) return null;
  const d = [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    if (!Number.isFinite(ra[i]) && !Number.isFinite(rb[i])) continue;
    d.push(Math.min(ra[i], horizon) - Math.min(rb[i], horizon));
  }
  return d.length >= ra.length * 0.5 ? pct(d, 0.5) : null;
}

/** Median run-by-run difference in lean mass change over six months (b − a), lb. */
export function pairedLean(a, b) {
  const d = a.leanRuns.map((v, i) => b.leanRuns[i] - v);
  return pct(d, 0.5);
}

/* ── from your data to a starting point ────────────────────────────────── */

/**
 * Where you are and what you're doing, from the energy engine, body
 * composition and strength analyses. null when there isn't enough.
 */
export function startingPoint({ energy, trend, intake, bf, strength, recovery, g, weight, days, today }) {
  if (weight == null) return null;
  const perLb = energy.perLb;
  const intakeNow = intake?.kcal ?? (trend?.enough ? energy.estimate + (trend.lbPerWeek * perLb) / 7 : energy.estimate);
  const since = addDays(today, -27);
  const liftDays = range(since, today).filter((k) => days[k]?.lifts?.length || (days[k]?.workouts || []).some((w) => /strength|weight|functional/i.test(w.type || ""))).length;
  const sessions = liftDays / 4;
  const kg = weight * KG_PER_LB;
  const protein = intake?.protein != null ? intake.protein / kg : null;
  const steps = (() => { const v = range(addDays(today, -13), today).map((k) => days[k]?.steps).filter((x) => x != null); return v.length >= 5 ? v.reduce((s, x) => s + x, 0) / v.length : null; })();
  return {
    weight, bodyFat: bf?.pct ?? 20, bodyFatErr: bf?.err ?? 5, bodyFatKind: bf ? bf.basis : "assumed",
    tdee: energy.estimate, tdeeSd: energy.sd, confidence: energy.confidence,
    intakeNow: Math.round(intakeNow), intakeDays: intake?.days ?? 0,
    sessions, protein, proteinG: intake?.protein ?? null, steps,
    factor: leanFactor(sessions, protein),
    ratePct: trend?.enough ? trend.pctPerWeek : null, lbPerWeek: trend?.enough ? trend.lbPerWeek : null,
    strength: strength?.status || "insufficient", sleep: recovery?.sleep ?? null,
    target: g.targetBodyFat || 10, goalWeight: g.goalWeight || null, targetDate: g.targetDate || null,
    pace: cutPace(bf?.pct ?? null, g.targetPace), phase: g.phase || "cut",
  };
}

/** A scenario: your sliders' changes applied to the starting point. */
export function scenarioInputs(start, sc = {}) {
  const intake = sc.kcal ?? start.intakeNow;
  const sessions = sc.sessions ?? start.sessions;
  const protein = sc.protein != null ? sc.protein / (start.weight * KG_PER_LB) : start.protein;
  const dSteps = sc.steps != null && start.steps != null ? sc.steps - start.steps : 0;
  const dSessions = sessions - start.sessions;
  const activity = dSteps * STEP_KCAL_PER_KG * start.weight * KG_PER_LB + (dSessions * SESSION_KCAL) / 7;
  return {
    weightLb: start.weight, bodyFat: start.bodyFat, bodyFatErr: start.bodyFatErr,
    tdee: start.tdee, tdeeSd: start.tdeeSd, intakeNow: start.intakeNow, intake,
    factor: leanFactor(sessions, protein), activity,
    maintainAt: sc.maintainAtGoal === false ? null : start.target,
    breakEvery: sc.breakEvery || 0, floor: sc.floor || 0,
  };
}

/**
 * The headline: ahead, on track, slower, or too aggressive — your measured
 * pace against the pace you chose (or one set by your body fat), and
 * against your target date if you set one.
 */
export function onTrack(start, proj, today) {
  if (!start || start.ratePct == null || start.confidence === "preliminary") {
    return { id: "insufficient", word: "Not enough data yet", text: "This needs about two weeks of weigh-ins and complete food days to judge your pace." };
  }
  const rate = -start.ratePct; // % of body weight lost a week
  const pace = start.pace;
  const tooFast = rate > Math.max(1, pace * 1.6) || (rate > 0.8 && start.strength === "declining");
  if (start.phase === "maintain") {
    const ok = Math.abs(start.ratePct) < 0.2;
    return { id: ok ? "on" : "slow", word: ok ? "On track" : "Drifting", text: ok ? "Weight is holding steady, as planned for maintenance." : `Weight is moving ${Math.abs(start.ratePct).toFixed(2)}% a week ${start.ratePct < 0 ? "down" : "up"} — more than maintenance should.` };
  }
  if (start.phase === "bulk") {
    const g2 = start.ratePct;
    if (g2 > 0.6) return { id: "fast", word: "Gaining fast", text: `Gaining ${g2.toFixed(2)}% a week — above the ~0.25–0.5% that keeps fat gain down.` };
    if (g2 >= 0.15) return { id: "on", word: "On track", text: `Gaining ${g2.toFixed(2)}% a week, in the lean-bulk range.` };
    return { id: "slow", word: "Slower than planned", text: "Weight isn't climbing yet — a lean bulk aims for ~0.25–0.5% a week." };
  }
  if (tooFast) return { id: "fast", word: "Possibly too aggressive", text: `Losing ${rate.toFixed(2)}% of body weight a week${start.strength === "declining" ? " while strength slips" : ""}. Faster than ~1% a week raises the share of muscle lost, especially when lean.` };
  let id = rate < pace * 0.75 ? "slow" : rate > pace * 1.35 ? "ahead" : "on";
  let text = id === "on" ? `Losing ${rate.toFixed(2)}% a week against a planned ${pace.toFixed(2)}% — right where it should be.`
    : id === "ahead" ? `Losing ${rate.toFixed(2)}% a week, faster than the planned ${pace.toFixed(2)}% but within a safe pace.`
    : rate <= 0.05 ? "Weight isn't trending down at the moment." : `Losing ${rate.toFixed(2)}% a week against a planned ${pace.toFixed(2)}%.`;
  const m = proj?.milestones?.find((x) => x.bf === start.target);
  if (start.targetDate && m && start.bodyFat > start.target) {
    const due = daysBetween(today, start.targetDate);
    if (m.median == null) { id = "slow"; text += ` At this pace ${start.target}% isn't reached by your target date.`; }
    else if (m.median < due - 14) { if (id !== "fast") id = "ahead"; text += ` ${start.target}% is projected about ${Math.round((due - m.median) / 7)} weeks before your target date.`; }
    else if (m.median > due + 14) { id = "slow"; text += ` ${start.target}% is projected about ${Math.round((m.median - due) / 7)} weeks after your target date.`; }
    else text += ` ${start.target}% lands around your target date.`;
  }
  const word = { on: "On track", ahead: "Ahead of schedule", slow: "Slower than planned" }[id];
  return { id, word, text };
}

/**
 * What the model expected six weeks ago (from that week's maintenance
 * estimate and what you then ate), to set against what actually happened.
 */
export function backtest({ days, today, energy, bodyFatNow, weightAt, carry, lookback = 42 }) {
  const t0 = addDays(today, -lookback);
  const w0 = weightAt(days, t0);
  const wk = energy.weeks.filter((w) => w.end <= addDays(t0, 3) && w.estimate != null).at(-1);
  const eaten = range(t0, today).map((k) => days[k]).filter((d) => d?.foodDone && d.kcal != null).map((d) => d.kcal);
  if (w0 == null || !wk || eaten.length < 10 || bodyFatNow == null) return null;
  const nowW = weightAt(days, today);
  const bf0 = nowW != null ? carry(bodyFatNow, nowW, w0) : bodyFatNow;
  const intake = eaten.reduce((s, v) => s + v, 0) / eaten.length;
  const sim = simulate({ weightLb: w0, bodyFat: bf0, tdee: wk.estimate, intakeNow: intake, intake, days: lookback, factor: 0.6 });
  return { from: t0, w: sim.w, intake: Math.round(intake), tdee: Math.round(wk.estimate) };
}
