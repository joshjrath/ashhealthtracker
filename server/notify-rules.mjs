/* ──────────────────────────────────────────────────────────────────────────
   What's worth telling you — rules that watch your data.

   Every few minutes (and shortly after you log something) the server builds
   one picture of your data and runs each rule. A rule may emit() a
   notification or cancel() one that no longer applies; the notifier then
   applies your settings, quiet hours, cooldowns and dedupe (notify.mjs).

   Each rule only speaks when its feature exists and its data is there, and
   only about sustained or meaningful changes — never single noisy days.
   Rules marked `prime` don't announce anything that was already true the
   first time they ran (old PRs, milestones passed long ago).

   Adding a rule: push an object { id, category, run(ctx, n) } onto RULES —
   or, from a feature, call notifier.emit() directly with its own `type`.
   Planned features hook in the same way: weekly reports ("insights.report"),
   the daily briefing ("insights.briefing"), readiness ("recovery.readiness"),
   nutrient gaps ("nutrition.micros"), progressive overload and strength
   trends ("fitness.overload", "fitness.decline"), custom challenges
   ("achievements.challenge") and phase transitions ("phases.transition").
   ────────────────────────────────────────────────────────────────────────── */
import { DEFAULT_GOALS, addDays, range, foodStatus, sleepMinutes, mondayOf, fmtDur } from "../js/metrics.js";
import { resolveDay, reviewItems } from "../js/sources.js";
import { evaluate, buildCatalog } from "../js/achievements.js";
import { plannedFor, weekStatus, liftHistory, PLAN_LABELS } from "../js/training.js";
import { adaptiveTdee, plateau, calorieAdvice } from "../js/energy.js";
import { hm, localNow } from "./notify.mjs";

const H = 3600_000;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sdev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/** One picture of everything, in your time zone. */
export async function buildContext({ store, cfg, storage, settings, at }) {
  const local = localNow(settings.timeZone, at);
  const today = local.key;
  const [all, plan, tiers, catalog, rewards] = await Promise.all([
    store.getAll(), store.getMeta("trainingPlan"), store.getMeta("achievementTiers"), store.getMeta("achievementCatalog"),
    store.listItems("reward"),
  ]);
  const lastSync = all.lastSync;
  const raw = all.days || {};
  const days = Object.fromEntries(Object.keys(raw).filter((k) => k <= today).map((k) => [k, resolveDay(raw[k], k)]));
  const g = { ...DEFAULT_GOALS, ...(all.goals || {}), plan: plan || null };
  const hasData = Object.keys(days).length > 0;
  let energy = null, plat = null, advice = null;
  if (hasData) {
    energy = adaptiveTdee(days, g, today);
    plat = plateau(days, g, today, energy, "cut");
    const w = plat.t28?.now ?? plat.nowAvg ?? null;
    advice = w ? calorieAdvice({ days, g, today, energy, plat, phase: "cut", weight: w }) : null;
  }
  const ach = hasData ? evaluate({ days, g, today, catalog: buildCatalog(catalog, tiers), rewards: rewards || [] }) : null;
  return { local, today, min: local.minutes, days, raw, g, energy, plat, advice, ach, lastSync, cfg, storage, settings, at, hasData };
}

const avg7 = (days, today) => {
  const v = range(addDays(today, -6), today).map((k) => days[k]?.weight).filter((x) => x != null);
  return v.length >= 3 ? mean(v) : null;
};
const doneWorkout = (d) => !!(d?.lifts?.length || d?.workouts?.length || d?.workout === true);

export const RULES = [
  /* ── reminders (they cancel themselves once done) ── */
  {
    id: "reminder.meal", category: "nutrition",
    run({ days, today, min, settings }, n) {
      const r = settings.reminders.meal, key = `rem:meal:${today}`;
      const d = days[today];
      if (d?.foods?.length || d?.kcal != null) return n.cancel(key);
      if (r.on && min >= hm(r.time)) n.emit({ type: "reminder.meal", category: "nutrition", priority: "reminder", key, title: "Log today's meals?", body: "Nothing's in today's food diary yet — a quick search or a placeholder is enough.", link: "#/nutrition" });
    },
  },
  {
    id: "reminder.weighIn", category: "weight",
    run({ days, today, min, settings }, n) {
      const r = settings.reminders.weighIn, key = `rem:weigh:${today}`;
      if (days[today]?.weight != null) return n.cancel(key);
      const habit = range(addDays(today, -14), addDays(today, -1)).filter((k) => days[k]?.weight != null).length;
      if (r.on && habit >= 3 && min >= hm(r.time)) n.emit({ type: "reminder.weighIn", category: "weight", priority: "reminder", key, title: "Morning weigh-in?", body: "Same time and conditions each day keeps the trend clean.", link: "#/weight" });
    },
  },
  {
    id: "reminder.workout", category: "fitness",
    run({ days, today, min, settings, g }, n) {
      const r = settings.reminders.workout, key = `rem:workout:${today}`;
      const p = plannedFor(g.plan, today);
      if (!p || doneWorkout(days[today])) return n.cancel(key);
      if (!r.on || min < hm(r.time)) return;
      if (p === "rest") n.emit({ type: "reminder.rest", category: "fitness", priority: "reminder", key, title: "Planned rest day", body: "Rest is part of the plan — it counts toward your week.", link: "#/fitness" });
      else n.emit({ type: "reminder.workout", category: "fitness", priority: "reminder", key, title: `Today's plan: ${PLAN_LABELS[p]}`, body: "Nothing logged yet today. Already trained? Log it and this goes away.", link: "#/fitness" });
    },
  },
  {
    id: "reminder.bedtime", category: "recovery",
    run({ today, min, settings, g }, n) {
      const r = settings.reminders.bedtime;
      if (!r.on || !g.bedTarget) return;
      const bed = hm(g.bedTarget), start = (bed - r.before + 1440) % 1440;
      const inWin = start <= bed ? min >= start && min < bed + 30 : min >= start || min < bed + 30;
      if (inWin) n.emit({ type: "reminder.bedtime", category: "recovery", priority: "reminder", key: `rem:bed:${today}`, title: `Bedtime in ${r.before} minutes`, body: `Aiming for ${g.bedTarget}.`, link: "#/sleep" });
    },
  },

  /* ── nutrition ── */
  {
    id: "nutrition.today", category: "nutrition",
    run({ days, today, min, g }, n) {
      const d = days[today];
      if (min < 14 * 60 || !d?.foods?.length) return;
      const parts = [];
      if (d.kcal != null && d.kcal >= g.kcalHigh - 200 && d.kcal < g.kcalHigh) parts.push(`about ${fmt(g.kcalHigh - d.kcal)} kcal left in today's range`);
      if (d.protein != null && d.protein >= g.protein * 0.8 && d.protein < g.protein) parts.push(`${fmt(g.protein - d.protein)} g protein to reach ${g.protein} g`);
      if (!parts.length) return;
      n.emit({ type: "nutrition.near", category: "nutrition", priority: "info", key: `nut:today:${today}`, fp: parts.length, minGapH: 3, title: "Close to today's targets", body: `${parts.join(" · ")}.`, link: "#/nutrition" });
    },
  },
  {
    id: "nutrition.protein", category: "nutrition",
    run({ days, today, g }, n) {
      const done = range(addDays(today, -7), addDays(today, -1)).map((k) => days[k]).filter((d) => foodStatus(d) === "complete" && d.protein != null);
      if (done.length < 5) return;
      const low = done.filter((d) => d.protein < g.protein);
      if (low.length < 5) return;
      n.emit({ type: "nutrition.proteinLow", category: "nutrition", priority: "important", key: `nut:protein:${mondayOf(today)}`, title: "Protein has been under target", body: `Below ${g.protein} g on ${low.length} of the last ${done.length} complete days (averaging ${fmt(mean(done.map((d) => d.protein)))} g). Protein supports keeping muscle while you lose fat.`, link: "#/nutrition" });
    },
  },
  {
    id: "nutrition.fiber", category: "nutrition",
    run({ days, today, g }, n) {
      const done = range(addDays(today, -7), addDays(today, -1)).map((d) => days[d]).filter((d) => foodStatus(d) === "complete" && d.fiber != null);
      if (done.length < 5 || !g.fiber) return;
      const low = done.filter((d) => d.fiber < g.fiber * 0.7);
      if (low.length < 5) return;
      n.emit({ type: "nutrition.fiberLow", category: "nutrition", priority: "info", key: `nut:fiber:${mondayOf(today)}`, title: "Fiber is running low", body: `Under ${Math.round(g.fiber * 0.7)} g on ${low.length} of ${done.length} complete days (target ${g.fiber} g). Beans, berries, oats and vegetables are easy adds.`, link: "#/nutrition" });
    },
  },
  {
    id: "nutrition.week", category: "nutrition",
    run({ days, local, today, settings }, n) {
      if (local.weekday !== 1 || local.minutes < hm(settings.digestTime)) return;
      const mon = addDays(mondayOf(today), -7);
      const done = range(mon, addDays(mon, 6)).map((k) => days[k]).filter((d) => foodStatus(d) === "complete" && d.kcal != null);
      if (done.length < 3) return;
      n.emit({ type: "nutrition.weekly", category: "nutrition", priority: "info", key: `nut:week:${mon}`, title: "Last week's nutrition", body: `${done.length} complete days · averaged ${fmt(mean(done.map((d) => d.kcal)))} kcal and ${fmt(mean(done.map((d) => d.protein || 0)))} g protein.`, link: "#/nutrition" });
    },
  },

  /* ── weight & body ── */
  {
    id: "weight.milestones", category: "weight", prime: true,
    run({ days, today, g }, n) {
      const a = avg7(days, today);
      if (a == null) return;
      if (a <= g.goalWeight) n.emit({ type: "goal.weight", category: "achievements", priority: "important", key: "wt:goal", title: "Goal weight reached", body: `Your 7-day average is ${a.toFixed(1)} lb — at or under your ${g.goalWeight} lb goal. A good moment to think about maintenance.`, link: "#/weight" });
      else if (a - g.goalWeight <= 2) n.emit({ type: "phases.approach", category: "phases", priority: "info", key: "wt:near", title: "Close to your goal weight", body: `${(a - g.goalWeight).toFixed(1)} lb to go on your 7-day average.`, link: "#/weight" });
      for (let t = Math.floor(g.startWeight / 5) * 5; t > g.goalWeight; t -= 5) {
        if (a <= t) n.emit({ type: "weight.milestone", category: "weight", priority: "info", key: `wt:ms:${t}`, title: `Under ${t} lb`, body: `Your 7-day average is ${a.toFixed(1)} lb.`, link: "#/weight" });
      }
    },
  },
  {
    id: "weight.week", category: "weight",
    run({ days, local, today, settings }, n) {
      if (local.weekday !== 1 || local.minutes < hm(settings.digestTime)) return;
      const end = addDays(today, -1);
      const a = avg7(days, end), b = avg7(days, addDays(end, -7));
      if (a == null || b == null) return;
      const d = a - b;
      n.emit({ type: "weight.weekly", category: "weight", priority: "info", key: `wt:week:${end}`, title: "Last week's weight", body: `7-day average ${a.toFixed(1)} lb (${d <= 0 ? "−" : "+"}${Math.abs(d).toFixed(1)} on the week before). Single days swing with water; the average is what counts.`, link: "#/weight" });
    },
  },
  {
    id: "weight.plateau", category: "weight",
    run({ plat, seen }, n) {
      if (!plat || plat.status === "insufficient") return;
      if (plat.status === "confirmed") {
        n.emit({ type: "weight.plateau", category: "weight", priority: "important", key: "wt:plateau", fp: "confirmed", repeat: true, cooldownH: 14 * 24, title: "Your weight trend has been flat for 3–4 weeks", body: `${plat.factors[0] ? `${plat.factors[0].text} ` : ""}${plat.next}`, link: "#/weight" });
      } else if (plat.status === "progressing" && seen("wt:plateau")?.fp === "confirmed") {
        n.emit({ type: "weight.plateauOver", category: "weight", priority: "info", key: "wt:plateau", fp: "resolved", title: "The trend is moving again", body: `Losing about ${Math.abs(plat.t28.lbPerWeek).toFixed(1)} lb a week over the last four weeks.`, link: "#/weight" });
      }
    },
  },

  /* ── insights & targets ── */
  {
    // Off until the Metabolism & Energy Balance card exists to show and explain it.
    id: "insights.tdee", category: "insights", prime: true, enabled: false,
    run({ energy, seen }, n) {
      if (!energy || energy.confidence === "preliminary") return;
      const last = Number(seen("ins:tdee")?.fp);
      if (Number.isFinite(last) && Math.abs(energy.estimate - last) < 100) return;
      n.emit({ type: "insights.tdee", category: "insights", priority: "important", key: "ins:tdee", fp: energy.estimate, minGapH: 14 * 24, title: `Estimated maintenance: ${fmt(energy.estimate)} kcal`, body: `${Number.isFinite(last) ? `${energy.estimate > last ? "Up" : "Down"} from ${fmt(last)}, ` : ""}from your logged intake and weight trend (likely ${fmt(energy.low)}–${fmt(energy.high)}, ${energy.confidence}). An estimate, not a measurement.`, link: "#/weight" });
    },
  },
  {
    // Off until that card exists to accept or decline it on.
    id: "insights.advice", category: "insights", enabled: false,
    run({ advice }, n) {
      if (!advice?.suggest) return;
      n.emit({ type: "insights.calorieTarget", category: "insights", priority: "important", key: "ins:advice", fp: advice.target, minGapH: 72, title: `Suggested calorie target: ${fmt(advice.target)} kcal`, body: `${advice.diff > 0 ? "Up" : "Down"} ${fmt(Math.abs(advice.diff))} from your current ${fmt(advice.current)}. Nothing changes unless you accept it on the Weight page.`, link: "#/weight" });
    },
  },

  /* ── training ── */
  {
    id: "fitness.prs", category: "fitness", prime: true,
    run({ days, today }, n) {
      const keys = Object.keys(days).sort();
      const h = liftHistory(days, keys);
      for (const p of h.perDay.filter((x) => x.key >= addDays(today, -2) && x.prs.length)) {
        n.emit({ type: "fitness.pr", category: "fitness", priority: "info", key: `fit:pr:${p.key}`, fp: p.prs.map((x) => x.exercise).join(","), title: p.prs.length === 1 ? `New best: ${p.prs[0].exercise}` : `${p.prs.length} new bests`, body: p.prs.map((x) => `${x.exercise}: est. 1-rep max ${fmt(x.from)} → ${fmt(x.to)} lb`).join(" · "), link: "#/fitness" });
      }
    },
  },
  {
    id: "fitness.planWeek", category: "fitness",
    run({ days, today, g }, n) {
      if (!g.plan) return;
      const mon = mondayOf(today);
      if (weekStatus(days, g.plan, mon, today).status === "hit") n.emit({ type: "fitness.planWeek", category: "fitness", priority: "info", key: `fit:plan:${mon}`, title: "Training plan done for the week", body: "Every planned session this week is in. Rest days count too.", link: "#/fitness" });
    },
  },

  /* ── sleep & recovery ── */
  {
    id: "recovery.sleep", category: "recovery",
    run({ days, today, g }, n) {
      const mins = range(addDays(today, -6), today).map((k) => sleepMinutes(days[k])).filter((x) => x != null);
      if (mins.length < 5) return;
      const a = mean(mins);
      if (a >= g.sleepHours * 60 - 45) return;
      n.emit({ type: "recovery.sleepLow", category: "recovery", priority: "important", key: `rec:sleep:${mondayOf(today)}`, title: "Sleep has been short this week", body: `Averaging ${fmtDur(a)} over ${mins.length} nights (goal ${g.sleepHours} h). Short sleep makes recovery and appetite harder while you cut.`, link: "#/sleep" });
    },
  },
  {
    id: "recovery.heart", category: "recovery",
    run({ days, today }, n) {
      const base = (f) => range(addDays(today, -28), addDays(today, -1)).map((k) => days[k]?.[f]).filter((x) => x != null);
      const rhr = base("restingHR"), hrv = base("hrv");
      const t = days[today];
      if (t?.restingHR != null && rhr.length >= 14) {
        const m = mean(rhr), s = sdev(rhr);
        if (t.restingHR >= m + Math.max(2 * s, 5)) n.emit({ type: "recovery.rhr", category: "recovery", priority: "info", key: "rec:rhr", fp: today, minGapH: 72, title: "Resting heart rate is above your usual", body: `${Math.round(t.restingHR)} bpm vs a usual ${Math.round(m)}. Often from short sleep, alcohol, a hard session or a cold coming on — worth noting if it lasts a few days. Not a diagnosis.`, link: "#/fitness" });
      }
      if (t?.hrv != null && hrv.length >= 14) {
        const m = mean(hrv), s = sdev(hrv);
        if (t.hrv <= m - Math.max(2 * s, 0.2 * m)) n.emit({ type: "recovery.hrv", category: "recovery", priority: "info", key: "rec:hrv", fp: today, minGapH: 72, title: "HRV is below your usual", body: `${Math.round(t.hrv)} ms vs a usual ${Math.round(m)} ms. One low reading is common; a run of them can mean you need more recovery.`, link: "#/fitness" });
      }
    },
  },

  /* ── achievements ── */
  {
    id: "achievements.unlocks", category: "achievements", prime: true,
    run({ ach }, n) {
      for (const t of ach?.tiers || []) if (t.unlocked) n.emit({ type: "achievements.unlock", category: "achievements", priority: "info", key: `ach:${t.id}`, title: `Unlocked: ${t.name}`, body: t.unlockedText, link: "#/achievements" });
    },
  },

  /* ── sync, backups, data ── */
  {
    id: "system.storage", category: "system",
    run({ storage }, n) {
      if (storage && storage.persistent === false) n.emit({ type: "system.storage", category: "system", priority: "critical", key: "sys:storage", fp: "temporary", repeat: true, cooldownH: 72, title: "Your data is on temporary storage", body: "The next update will erase it. Connect the Postgres database in Railway (Settings → Backups shows how).", link: "#/settings" });
    },
  },
  {
    id: "system.sync", category: "system",
    run({ cfg, lastSync, at }, n) {
      if (!cfg?.tokens?.length || !lastSync?.at) return;
      const age = at - Date.parse(lastSync.at);
      if (age > 48 * H) n.emit({ type: "sync.stale", category: "system", priority: "important", key: "sys:sync", fp: lastSync.at, title: "Apple Health hasn't synced in 2 days", body: `Last sync ${new Date(lastSync.at).toISOString().slice(0, 10)}. Open Health Auto Export (or your Shortcut) on your iPhone and check its automation.`, link: "#/settings" });
    },
  },
  {
    id: "system.review", category: "system",
    run({ raw }, n) {
      const c = reviewItems(raw).length;
      if (c) n.emit({ type: "data.review", category: "system", priority: "important", key: "sys:review", fp: c, repeat: true, cooldownH: 14 * 24, title: `${c} older day${c === 1 ? "" : "s"} need a quick review`, body: "Food or sleep values from before sources were tracked are left out of every number until you confirm them.", link: "#/settings" });
    },
  },
];

/**
 * Run every rule. On the very first run, rules marked `prime` only record
 * what's already true, so you aren't flooded with history.
 */
export async function runRules(notifier, base) {
  const settings = await notifier.settings();
  const ctx = await buildContext({ ...base, settings });
  const st = await notifier.loadState();
  const prime = !st.primed;
  const seen = (key) => st.seen[key] || null;
  const out = [];
  for (const rule of RULES) {
    if (rule.enabled === false) continue;
    const pending = [];
    const n = {
      emit: (x) => pending.push(["emit", x]),
      cancel: (m) => pending.push(["cancel", m]),
    };
    try { rule.run({ ...ctx, seen }, n); } catch (e) { base.log?.error?.(`[notify] rule ${rule.id} failed:`, e.message); continue; }
    for (const [op, x] of pending) {
      if (op === "cancel") await notifier.cancel(x);
      else {
        const item = await notifier.emit(x, { prime: prime && rule.prime });
        if (item) out.push(item);
      }
    }
  }
  if (prime) await notifier.serial(async () => { const s = await notifier.loadState(); s.primed = true; await notifier.saveState(s); });
  return out;
}
