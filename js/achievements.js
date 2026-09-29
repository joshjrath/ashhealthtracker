/* ──────────────────────────────────────────────────────────────────────────
   The achievement engine — the one place progress is calculated.

     trusted, resolved days (sources.js rules)
       → metrics (below)  → tiers: progress, unlock, unlock date
       → next unlock ranking
       → Today · Achievements · sidebar · rewards all read this result

   The CATALOG is data. A badge family names a metric kind and its tier
   thresholds; adding a family that uses an existing metric kind (goal
   days, workouts of a type, a summed field, a goal streak…) needs no code —
   the server can hold overrides and extra families under the
   "achievementCatalog" setting, and tier thresholds are editable in
   Settings. Only a genuinely new kind of measurement needs a new entry in
   METRIC_KINDS.

   Unlocks come from data every time — never from a stored flag — so the
   same days always give the same answer everywhere. An unlock date is the
   day the data first crossed the threshold; when the data starts beyond
   it (weight you'd lost before you began logging), the date is unknown
   and shown that way rather than invented.

   Safety: no metric here rewards eating less. Nutrition only counts
   complete food days inside your calorie range with protein hit.
   ────────────────────────────────────────────────────────────────────────── */
import {
  addDays, range, mondayOf, daysBetween, goalStatus, dayScore, foodStatus, weightStats, trackedIds,
} from "./metrics.js";
import { planStreak, weekStatus, liftHistory, dayTraining, plannedFor } from "./training.js";

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

export const DEFAULT_CATALOG = [
  {
    id: "weight", name: "Weight Loss", theme: "weight", metric: "weightLost", unit: "lb", decimals: 1,
    tiers: [5, 10, 15, 20, 25],
    requirement: "Lose {n} lb", unlocked: "{n} lb lost",
    about: "Pounds lost from your starting weight, on your 7-day average (or the latest weigh-in when a week has fewer than 3). A single heavy morning can't take a badge back.",
  },
  {
    id: "iron", name: "Iron", theme: "iron", metric: "liftVolume", unit: "lb", decimals: 0,
    tiers: [50000, 100000, 250000, 500000, 1000000],
    requirement: "Lift {n} lb in total", unlocked: "{n} lb lifted",
    about: "Total volume from the sets you log: reps × weight, across every exercise. Apple Health workouts carry no sets, so only your own logs count.",
  },
  {
    id: "training", name: "Training Consistency", theme: "training", metric: "planWeeks", unit: "weeks", decimals: 0,
    tiers: [1, 2, 4, 8, 12],
    requirement: "Complete your training plan {n} week{s} in a row", unlocked: "{n} week{s} on plan",
    about: "A week counts when it holds the strength, cardio and total workout days your plan calls for. Planned rest days never count against you, and moving a session within the week is fine.",
  },
  {
    id: "nutrition", name: "Nutrition Consistency", theme: "nutrition", metric: "nutritionDays", unit: "days", decimals: 0,
    tiers: [7, 14, 30, 60, 100],
    requirement: "{n} complete food days in your calorie range with protein hit", unlocked: "{n} consistent days",
    about: "A day qualifies when its food log is marked complete, calories land inside your range and protein reaches its target. Eating below the range never qualifies — this rewards consistency, not restriction.",
  },
  {
    id: "complete", name: "Complete Days", theme: "complete", metric: "completeDays", unit: "days", decimals: 0,
    tiers: [5, 10, 25, 50, 100],
    requirement: "Hit every daily goal on {n} days", unlocked: "{n} complete days",
    about: "Days where every goal that applied was hit. They don't need to be in a row — one imperfect day never erases progress.",
  },
];

/* ── metric kinds ──────────────────────────────────────────────────────── */
// Each returns { current, best, firstReach(n) → key|null, preData(n) → bool,
//               rate (units per day, recent), eta(remaining, n) → {...} }

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const daysLeftInWeek = (today) => daysBetween(today, addDays(mondayOf(today), 6)) + 1; // incl. today

/** Cumulative count/sum over days, with unlock dates and a recent rate. */
function cumulative(ctx, valueOfDay, { recent = 14 } = {}) {
  const { keys, today } = ctx;
  let total = 0;
  const points = [];
  for (const k of keys) {
    const v = valueOfDay(k);
    if (v > 0) { total += v; points.push([k, total]); }
  }
  const since = addDays(today, -(recent - 1));
  let recentSum = 0;
  for (const k of keys) if (k >= since) recentSum += valueOfDay(k) || 0;
  return {
    current: total,
    best: total,
    firstReach: (n) => points.find((p) => p[1] >= n - 1e-9)?.[0] ?? null,
    preData: () => false,
    rate: recentSum / recent,
  };
}

const METRIC_KINDS = {
  /** Pounds lost from the starting weight, on the trend weight. */
  weightLost(ctx) {
    const { days, g, keys, today } = ctx;
    const trend = [];
    for (const k of keys) {
      const win = range(addDays(k, -6), k).map((x) => days[x]?.weight).filter((v) => v != null);
      if (!win.length) continue;
      const v = win.length >= 3 ? win.reduce((s, x) => s + x, 0) / win.length : days[range(addDays(k, -6), k).filter((x) => days[x]?.weight != null).pop()].weight;
      trend.push([k, g.startWeight - v]);
    }
    let best = -Infinity;
    const running = trend.map(([k, lost]) => { best = Math.max(best, lost); return [k, best]; });
    const current = trend.length ? trend[trend.length - 1][1] : 0;
    const ws = weightStats(days, g, today);
    const rate = ws.perWeek != null && ws.perWeek < 0 ? -ws.perWeek / 7 : 0;
    return {
      current: Math.max(0, current),
      best: running.length ? Math.max(0, best) : 0,
      firstReach: (n) => running.find((p) => p[1] >= n - 1e-9)?.[0] ?? null,
      // Already past the threshold on the first reading: it happened before tracking began.
      preData: (n) => trend.length > 0 && trend[0][1] >= n,
      rate,
      eta(remaining) {
        const label = `${remaining < 10 ? remaining.toFixed(1) : Math.round(remaining)} lb away`;
        return { days: rate > 0 ? remaining / rate : Infinity, label, why: rate > 0 ? `At your recent rate of ${(rate * 7).toFixed(1)} lb/week` : "No downward trend in the last 4 weeks" };
      },
    };
  },

  /** Total logged lifting volume (lb). */
  liftVolume(ctx) {
    const h = ctx.lifts();
    const byKey = Object.fromEntries(h.perDay.map((p) => [p.key, p.volume]));
    const m = cumulative(ctx, (k) => byKey[k] || 0, { recent: 28 });
    const sessions = h.perDay.slice(-5).map((p) => p.volume).sort((a, b) => a - b);
    const typical = sessions.length ? sessions[Math.floor(sessions.length / 2)] : 0;
    const liftedToday = (ctx.days[ctx.today]?.lifts || []).length > 0;
    return {
      ...m,
      eta(remaining) {
        const possibleToday = !liftedToday && typical > 0 && remaining <= typical;
        return {
          days: possibleToday ? 0.5 : m.rate > 0 ? remaining / m.rate : Infinity,
          possibleToday,
          label: possibleToday ? "Possible today" : `${Math.round(remaining).toLocaleString("en-US")} lb to go`,
          why: possibleToday ? `Your typical session is ${Math.round(typical).toLocaleString("en-US")} lb` : m.rate > 0 ? `At your recent ${Math.round(m.rate * 7).toLocaleString("en-US")} lb/week` : "No lifts logged in the last 4 weeks",
        };
      },
    };
  },

  /** Consecutive weeks completing the training plan. */
  planWeeks(ctx) {
    const { days, g, today, first } = ctx;
    if (!g.plan?.days) {
      return { current: 0, best: 0, firstReach: () => null, preData: () => false, rate: 0, needsSetup: "Set your weekly training plan in Settings to start this family.", eta: () => ({ days: Infinity, label: "Needs a plan", why: "No training plan set" }) };
    }
    const s = planStreak(days, g.plan, today, first);
    const judged = s.weeks.filter((w) => w.status === "hit" || w.status === "miss").slice(-8);
    const f = judged.length ? judged.filter((w) => w.status === "hit").length / judged.length : 0;
    const now = weekStatus(days, g.plan, mondayOf(today), today);
    return {
      current: s.current, // a completed current week is already in the run
      best: s.best,
      firstReach: (n) => s.reachedAt[n] ?? null,
      preData: () => false,
      rate: f / 7,
      eta(remaining) {
        const left = daysLeftInWeek(today);
        if (now.status === "pending" && remaining <= 1) {
          const need = now.left.total;
          return {
            days: left, possibleToday: need === 1 && plannedFor(g.plan, today) !== "rest" && !dayTraining(days[today]).any,
            label: need === 1 ? "1 workout away" : need <= left ? "On pace this week" : `${need} workouts this week`,
            why: `${need} planned session${need === 1 ? "" : "s"} left this week, ${left} day${left === 1 ? "" : "s"} to go`,
          };
        }
        return { days: f > 0 ? (left + (remaining - 1) * 7) / f : Infinity, label: `${remaining} week${remaining === 1 ? "" : "s"} to go`, why: f > 0 ? `You've completed ${Math.round(f * 100)}% of recent weeks` : "No completed weeks recently" };
      },
    };
  },

  /** Complete food days, in range, protein hit — never rewards eating less. */
  nutritionDays(ctx) {
    const { days, g, today } = ctx;
    const ok = (k) => {
      const d = days[k];
      return foodStatus(d) === "complete" && d.kcal >= g.kcalLow && d.kcal <= g.kcalHigh && d.protein != null && d.protein >= g.protein ? 1 : 0;
    };
    const m = cumulative(ctx, ok);
    const d = days[today];
    const stillPossible = !ok(today) && !(d?.kcal > g.kcalHigh);
    return { ...m, eta: countEta(m, today, stillPossible, "qualifying day", "Complete today's food log in range with protein hit") };
  },

  /** Days with every applicable goal hit. */
  completeDays(ctx) {
    const { days, g, today } = ctx;
    const done = (k) => { const s = dayScore(days[k], g, k === today); return s.total > 0 && s.hit === s.total ? 1 : 0; };
    const m = cumulative(ctx, done);
    const s = dayScore(days[today], g, true);
    return { ...m, eta: countEta(m, today, !done(today) && s.miss === 0, "complete day", "Every goal still open today is reachable") };
  },

  /* Kinds ready for future families — usable from the catalog with params. */

  /** Days a goal was hit (params.goal: "protein", "steps", "sleep"…). */
  goalDays(ctx, p) {
    const { days, g, today } = ctx;
    const m = cumulative(ctx, (k) => (goalStatus(p.goal, days[k], g, k === today) === "hit" ? 1 : 0));
    return { ...m, eta: countEta(m, today, goalStatus(p.goal, days[today], g, true) === "pending", "day", "Still open today") };
  },
  /** Longest run of consecutive days a goal was hit (params.goal). */
  goalStreak(ctx, p) {
    const { days, g, keys, today } = ctx;
    let run = 0, best = 0;
    const reached = {};
    for (const k of range(keys[0] || today, today)) {
      const s = goalStatus(p.goal, days[k], g, k === today);
      if (s === "hit") { run += 1; if (run > best) { best = run; reached[run] = reached[run] || k; } }
      else if (s === "miss" || s === "none") run = 0;
    }
    return { current: run, best, firstReach: (n) => reached[n] ?? null, preData: () => false, rate: 1, eta: (r) => ({ days: r, label: `${r} day${r === 1 ? "" : "s"} to go`, why: "One day at a time" }) };
  },
  /** Workouts whose type matches (params.type — a pattern like "pickleball|badminton"). */
  workoutCount(ctx, p) {
    const re = new RegExp(p.type || ".", "i");
    const m = cumulative(ctx, (k) => (ctx.days[k]?.workouts || []).filter((w) => re.test(w.type)).length, { recent: 28 });
    return { ...m, eta: (r) => ({ days: m.rate > 0 ? r / m.rate : Infinity, label: `${r} workout${r === 1 ? "" : "s"} to go`, why: m.rate > 0 ? "At your recent pace" : "None in the last 4 weeks" }) };
  },
  /** A field summed over time (params.field: "steps", "exerciseMin"…). */
  sumField(ctx, p) {
    const m = cumulative(ctx, (k) => ctx.days[k]?.[p.field] || 0, { recent: 28 });
    return { ...m, eta: (r) => ({ days: m.rate > 0 ? r / m.rate : Infinity, label: `${Math.round(r).toLocaleString("en-US")} to go`, why: "At your recent pace" }) };
  },
  /** Progressive-overload increases across logged lifts. */
  overloads(ctx) {
    const h = ctx.lifts();
    const byKey = Object.fromEntries(h.perDay.map((x) => [x.key, x.increases]));
    const m = cumulative(ctx, (k) => byKey[k] || 0, { recent: 28 });
    return { ...m, eta: (r) => ({ days: m.rate > 0 ? r / m.rate : Infinity, label: `${r} increase${r === 1 ? "" : "s"} to go`, why: "At your recent pace" }) };
  },
  /** Strength sessions logged (days with lifts). */
  strengthSessions(ctx) {
    const m = cumulative(ctx, (k) => ((ctx.days[k]?.lifts || []).length ? 1 : 0), { recent: 28 });
    return { ...m, eta: (r) => ({ days: m.rate > 0 ? r / m.rate : Infinity, label: `${r} session${r === 1 ? "" : "s"} to go`, why: "At your recent pace" }) };
  },
};

export const METRIC_KIND_NAMES = Object.keys(METRIC_KINDS);

function countEta(m, today, stillPossibleToday, noun, todayWhy) {
  return (remaining) => {
    const left = daysLeftInWeek(today);
    const possibleToday = remaining === 1 && stillPossibleToday;
    const days = possibleToday ? 0.5 : m.rate > 0 ? remaining / m.rate : Infinity;
    const label = possibleToday ? "Possible today"
      : days <= left ? "On pace this week"
      : `${remaining} ${noun}${remaining === 1 ? "" : "s"} to go`;
    const why = possibleToday ? todayWhy
      : m.rate > 0 ? `About ${Math.max(1, Math.round(days))} day${Math.round(days) === 1 ? "" : "s"} at your recent pace` : "None in the last two weeks";
    return { days: Math.max(days, remaining - (stillPossibleToday ? 1 : 0)), possibleToday, label, why };
  };
}

/* ── catalog ───────────────────────────────────────────────────────────── */

/** Default families, with any server-side additions and tier overrides applied. */
export function buildCatalog(extra = null, tierOverrides = null) {
  const byId = new Map(DEFAULT_CATALOG.map((c) => [c.id, { ...c }]));
  if (Array.isArray(extra)) {
    for (const c of extra) {
      if (!c?.id || !METRIC_KINDS[c.metric] || !Array.isArray(c.tiers) || !c.tiers.length) continue;
      byId.set(c.id, { theme: "complete", unit: "", decimals: 0, requirement: "{n}", unlocked: "{n}", about: "", ...c });
    }
  }
  for (const [id, tiers] of Object.entries(tierOverrides || {})) {
    const c = byId.get(id);
    if (!c || !Array.isArray(tiers)) continue;
    const clean = tiers.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (clean.length === c.tiers.length && clean.every((n, i) => i === 0 || n > clean[i - 1])) c.tiers = clean;
  }
  return [...byId.values()];
}

const fill = (tpl, n, unit, decimals) => tpl
  .replace("{n}", n.toLocaleString("en-US", { maximumFractionDigits: decimals }))
  .replace("{s}", n === 1 ? "" : "s")
  .replace("{unit}", unit);

/* ── evaluation ────────────────────────────────────────────────────────── */

/**
 * Everything the site shows about achievements, computed once:
 *   { groups, tiers (flat), unlockedCount, total, next (ranked), byId }
 */
export function evaluate({ days, g, today, catalog = DEFAULT_CATALOG, rewards = [] }) {
  const keys = Object.keys(days).filter((k) => k <= today && days[k]).sort();
  let liftsMemo = null;
  const ctx = {
    days, g, today, keys, first: keys[0] || today,
    lifts: () => (liftsMemo ||= liftHistory(days, keys)),
  };
  const memo = {};
  const rewardsBy = {};
  for (const r of rewards) if (r.achievementId && !r.archived) (rewardsBy[r.achievementId] ||= []).push(r);

  const groups = catalog.map((def, gi) => {
    const kind = METRIC_KINDS[def.metric];
    const mkey = `${def.metric}:${JSON.stringify(def.params || {})}`;
    const m = kind ? (memo[mkey] ||= kind(ctx, def.params || {})) : null;
    const tiers = def.tiers.map((n, i) => {
      const id = `${def.id}-${i + 1}`;
      const unlocked = !!m && m.best >= n - 1e-9;
      const reachedOn = unlocked ? m.firstReach(n) : null;
      const dateKnown = unlocked && !!reachedOn && !m.preData(n);
      const current = m ? Math.max(0, m.current) : 0;
      return {
        id, group: def.id, groupIndex: gi, tier: i + 1, roman: ROMAN[i] || String(i + 1), theme: def.theme,
        name: `${def.name} ${ROMAN[i] || i + 1}`,
        requirement: fill(def.requirement, n, def.unit, def.decimals),
        unlockedText: fill(def.unlocked || def.requirement, n, def.unit, def.decimals),
        threshold: n, unit: def.unit, decimals: def.decimals,
        unlocked, unlockedAt: dateKnown ? reachedOn : null, dateKnown,
        current: unlocked ? n : Math.min(current, n),
        pct: unlocked ? 1 : clamp01(current / n),
        remaining: unlocked ? 0 : Math.max(0, n - current),
        rewards: rewardsBy[id] || [],
        about: def.about,
      };
    });
    const unlockedCount = tiers.filter((t) => t.unlocked).length;
    return {
      id: def.id, name: def.name, theme: def.theme, unit: def.unit, decimals: def.decimals, about: def.about,
      tiers, unlockedCount, next: tiers.find((t) => !t.unlocked) || null,
      current: m ? m.current : 0, needsSetup: m?.needsSetup || null, metric: m,
    };
  });

  const tiers = groups.flatMap((gr) => gr.tiers);
  return {
    groups, tiers,
    byId: Object.fromEntries(tiers.map((t) => [t.id, t])),
    unlockedCount: tiers.filter((t) => t.unlocked).length,
    total: tiers.length,
    next: rankNext(groups),
  };
}

/**
 * The closest locked tier in each family, ranked by how soon it can
 * realistically happen — not by raw percentage, since a pound, a workout
 * and a day aren't the same unit. Order: things possible today first,
 * then the shortest estimated time at your recent pace, then the higher
 * percentage. Each carries a plain-language reason.
 */
export function rankNext(groups) {
  const out = [];
  for (const gr of groups) {
    const t = gr.next;
    if (!t || !gr.metric || gr.needsSetup) continue;
    const e = gr.metric.eta(t.remaining, t.threshold);
    out.push({ ...t, eta: e.days, possibleToday: !!e.possibleToday, label: e.label, why: e.why });
  }
  return out.sort((a, b) =>
    Number(b.possibleToday) - Number(a.possibleToday)
    || a.eta - b.eta
    || b.pct - a.pct
    || a.groupIndex - b.groupIndex);
}

/** "12.4 / 15 lb", "3 / 4 weeks", "18,400 / 50,000 lb". */
export function progressText(t) {
  const f = (v) => v.toLocaleString("en-US", { maximumFractionDigits: t.decimals, minimumFractionDigits: t.unit === "lb" && t.decimals ? 1 : 0 });
  return `${f(t.current)} / ${f(t.threshold)} ${t.unit}`;
}

export function remainingText(t) {
  if (t.unlocked) return "Unlocked";
  const v = t.remaining.toLocaleString("en-US", { maximumFractionDigits: t.decimals, minimumFractionDigits: t.unit === "lb" && t.decimals ? 1 : 0 });
  const unit = t.remaining === 1 && t.unit.endsWith("s") ? t.unit.slice(0, -1) : t.unit;
  return `${v} ${unit} remaining`;
}

/** Tiers unlocked but not yet celebrated, given the stored ledger. */
export function unseenUnlocks(result, ledger) {
  if (!ledger?.initializedAt) return [];
  return result.tiers.filter((t) => t.unlocked && !ledger.entries?.[t.id]?.ackAt);
}

export { trackedIds };
