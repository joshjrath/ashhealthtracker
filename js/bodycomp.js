/* ──────────────────────────────────────────────────────────────────────────
   Body composition: what your body fat probably is, with an honest range;
   fat mass and fat-free mass; waist-to-height; how your measurements are
   moving against the scale and your strength; and how far off 15 / 12 /
   10% might be. Pure functions, used by the Weight page (and later the
   forecast).

   READINGS — every body-fat number you've entered (with how it was taken),
   Apple Health's smart-scale readings, and Navy-method estimates the site
   works out from your tape measurements. Each method carries its typical
   error (about one standard deviation, in percentage points), from
   validation studies against DEXA or a 4-compartment model: DEXA ~2,
   Bod Pod ~3, skinfolds ~3.5, Navy tape ~3.5 (Hodgdon & Beckett 1984),
   consumer bioimpedance scales ~4.5, BMI formulas ~5 (Deurenberg 1991),
   eyeballing ~5. Nothing is ever estimated from a photo.

   NOW — each recent reading is carried forward to today's weight. Weight
   lost isn't all fat: Forbes' rule puts the lean share of a change at
   10.4 / (10.4 + fat kg) for people who don't lift; resistance training and
   enough protein cut that a lot (Garthe 2011; Longland 2016). So while your
   strength and protein are holding, half of Forbes' share is used; the
   range covers both. Methods are combined weighting each by 1 / error².

   TAPE — measurements are stored in inches. Changes smaller than typical
   re-measurement error (~½ in at the waist, ¼ in at the neck and arms) are
   called "within noise", never progress or regress.
   ────────────────────────────────────────────────────────────────────────── */
import { addDays, range, daysBetween } from "./metrics.js";
import { MEASURES } from "./sources.js";
import { navyBodyFat, bodyFatFromBmi } from "./profile.js";
import { theilSen, KG_PER_LB } from "./energy.js";

export const BF_ERROR = { dexa: 2, bodpod: 3, calipers: 3.5, navy: 3.5, scale: 4.5, other: 4.5, visual: 5, bmi: 5, settings: 5 };
export const BF_LABEL = {
  dexa: "DEXA scan", bodpod: "Bod Pod", calipers: "Skinfold calipers", scale: "Smart scale", navy: "Navy tape method",
  visual: "Visual estimate", other: "Other", bmi: "BMI formula", settings: "Your estimate in Settings",
};
/** Measured by a device or assessment, vs worked out or guessed. */
export const BF_KIND = { dexa: "measured", bodpod: "measured", calipers: "measured", scale: "measured", other: "measured", navy: "estimate", visual: "estimate", bmi: "estimate", settings: "estimate" };
export const MEASURE_LABEL = { waist: "Waist", neck: "Neck", chest: "Chest", shoulders: "Shoulders", hips: "Hips", arm: "Arm", thigh: "Thigh" };
export const NOISE = { waist: 0.5, hips: 0.5, chest: 0.5, shoulders: 0.5, thigh: 0.4, neck: 0.25, arm: 0.25 };
export const BF_STEPS = [25, 20, 18, 15, 12, 10, 8];

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r1 = (v) => Math.round(v * 10) / 10;

/** Fraction of a weight change that's lean tissue, by Forbes (fat in kg). */
export const forbesLeanShare = (fatKg) => 10.4 / (10.4 + Math.max(fatKg, 1));

/** Your 7-day average weight around a day (±3 days), else the nearest weigh-in within two weeks. */
export function weightAt(days, key) {
  const near = range(addDays(key, -3), addDays(key, 3)).map((k) => days[k]?.weight).filter((v) => v != null);
  if (near.length) return mean(near);
  for (let i = 4; i <= 14; i++) for (const k of [addDays(key, -i), addDays(key, i)]) if (days[k]?.weight != null) return days[k].weight;
  return null;
}

/**
 * Carry a body-fat % from one weight to another. `share` is the lean
 * fraction rule: a function of fat kg (Forbes, or a fraction of it).
 */
export function carryBodyFat(pct, fromLb, toLb, share = forbesLeanShare) {
  if (fromLb == null || toLb == null || fromLb === toLb) return pct;
  let fat = (fromLb * pct) / 100, w = fromLb;
  const step = 0.25 * Math.sign(toLb - fromLb);
  while (Math.abs(toLb - w) > 1e-9) {
    const d = Math.abs(toLb - w) < 0.25 ? toLb - w : step;
    const lean = d * share(fat * KG_PER_LB);
    fat += d - lean;
    w += d;
  }
  return (Math.max(fat, 0) / toLb) * 100;
}

/** Every body-fat reading: what you entered, Apple's scale, and Navy estimates from your tape. Oldest first. */
export function bodyFatReadings(days, g, today) {
  const out = [];
  for (const k of Object.keys(days).filter((x) => x <= today).sort()) {
    const d = days[k];
    if (d?.bodyFat != null) {
      const method = d.bodyFatMethod || "other";
      out.push({ key: k, pct: d.bodyFat, method, kind: BF_KIND[method] || "measured", err: BF_ERROR[method] ?? 4.5, source: d.src?.bodyFat === "apple" ? "apple" : "you" });
    }
    const m = d?.meas;
    if (m?.waist && m?.neck && g?.sex && g?.heightIn > 0 && !(d?.bodyFat != null && d.bodyFatMethod === "navy")) {
      const v = navyBodyFat(g.sex, g.heightIn, m);
      if (v != null && v > 2 && v < 60) out.push({ key: k, pct: v, method: "navy", kind: "estimate", err: BF_ERROR.navy, source: "calc" });
    }
  }
  return out;
}

/**
 * Your body fat now, as { pct, err, low, high, kind, methods, basis, weight, carried, reliable }.
 * `holding`: strength and protein are holding (halves the lean share of losses).
 */
export function currentBodyFat(days, g, today, weightNow, { holding = false } = {}) {
  const share = holding ? (f) => 0.5 * forbesLeanShare(f) : forbesLeanShare;
  const all = bodyFatReadings(days, g, today);
  let use = all.filter((r) => daysBetween(r.key, today) <= 60);
  if (!use.length) use = all.filter((r) => daysBetween(r.key, today) <= 365).slice(-3);
  if (use.length && weightNow != null) {
    const byMethod = {};
    for (const r of use) (byMethod[r.method] ||= []).push(r);
    const parts = Object.entries(byMethod).map(([method, rs]) => {
      const last = rs.at(-1).key;
      const recent = rs.filter((r) => daysBetween(r.key, last) <= 14);
      const carried = recent.map((r) => {
        const w = weightAt(days, r.key) ?? weightNow;
        return { ...r, now: carryBodyFat(r.pct, w, weightNow, share), dw: Math.abs(weightNow - w), age: daysBetween(r.key, today) };
      });
      const err = (BF_ERROR[method] ?? 4.5) * (recent.length >= 3 ? 0.85 : 1)
        + 0.03 * Math.max(...carried.map((c) => c.dw)) + 0.5 * (Math.min(...carried.map((c) => c.age)) / 60);
      return { method, pct: mean(carried.map((c) => c.now)), err, n: recent.length, last, kind: BF_KIND[method] || "measured" };
    });
    const wsum = parts.reduce((s, p) => s + 1 / p.err ** 2, 0);
    const pct = parts.reduce((s, p) => s + p.pct / p.err ** 2, 0) / wsum;
    // methods that disagree widen the range; and their shared biases mean it never gets much tighter than the best one
    const spread = Math.sqrt(parts.reduce((s, p) => s + (p.pct - pct) ** 2 / p.err ** 2, 0) / wsum);
    const err = Math.max(Math.sqrt(1 / wsum + spread ** 2), 0.9 * Math.min(...parts.map((p) => p.err)));
    const top = [...parts].sort((a, b) => a.err - b.err)[0];
    const latest = use.at(-1);
    return {
      pct: r1(pct), err: r1(err), low: r1(pct - err), high: r1(pct + err),
      kind: top.kind, methods: parts, basis: "readings", weight: weightNow,
      carried: daysBetween(latest.key, today) > 3, asOf: latest.key, reliable: err <= 4.6,
    };
  }
  if (g?.bodyFat > 0) return { pct: g.bodyFat, err: BF_ERROR.settings, low: g.bodyFat - 5, high: g.bodyFat + 5, kind: "estimate", methods: [{ method: "settings", pct: g.bodyFat, err: 5 }], basis: "settings", weight: weightNow, reliable: false };
  const bmi = weightNow != null ? bodyFatFromBmi(g, weightNow, today) : null;
  if (bmi != null) return { pct: bmi, err: BF_ERROR.bmi, low: r1(bmi - 5), high: r1(bmi + 5), kind: "estimate", methods: [{ method: "bmi", pct: bmi, err: 5 }], basis: "bmi", weight: weightNow, reliable: false };
  return null;
}

/** Fat mass and fat-free mass, lb, with ranges from the body-fat range. */
export function composition(weightLb, bf) {
  if (weightLb == null || !bf) return null;
  const fat = (weightLb * bf.pct) / 100;
  return {
    fat, lean: weightLb - fat,
    fatRange: [(weightLb * bf.low) / 100, (weightLb * bf.high) / 100],
    leanRange: [weightLb - (weightLb * bf.high) / 100, weightLb - (weightLb * bf.low) / 100],
  };
}

/** Waist ÷ height, with the NICE (2022) bands. */
export function waistToHeight(waistIn, heightIn) {
  if (!(waistIn > 0) || !(heightIn > 0)) return null;
  const v = waistIn / heightIn;
  const band = v < 0.4 ? { id: "low", word: "Below 0.4" } : v < 0.5 ? { id: "ok", word: "Healthy range" } : v < 0.6 ? { id: "mid", word: "Increased risk" } : { id: "high", word: "High risk" };
  return { v, band, toHalf: v >= 0.5 ? waistIn - heightIn * 0.499 : 0 };
}

/* ── tape measurements ─────────────────────────────────────────────────── */

export const measureSeries = (days, m, today) => Object.keys(days).filter((k) => k <= today && days[k]?.meas?.[m] != null).sort().map((key) => ({ key, v: days[key].meas[m] }));

/**
 * How one measurement has moved: about four weeks (robust slope when there
 * are 4+ readings in six weeks, else the difference to the reading nearest
 * four weeks earlier) and since your first. `real` means beyond tape noise.
 */
export function measureChange(series, m, today) {
  if (!series.length) return null;
  const latest = series.at(-1), first = series[0];
  const out = { m, latest: latest.v, latestKey: latest.key, first: first.v, firstKey: first.key, n: series.length, noise: NOISE[m] ?? 0.5 };
  out.total = series.length > 1 ? latest.v - first.v : null;
  out.totalReal = out.total != null && Math.abs(out.total) >= out.noise;
  const win = series.filter((s) => daysBetween(s.key, latest.key) <= 42);
  if (win.length >= 4 && daysBetween(win[0].key, latest.key) >= 21) {
    const t = theilSen(win.map((s) => [daysBetween(win[0].key, s.key), s.v]));
    out.change4 = t.slope * 28;
    out.span = daysBetween(win[0].key, latest.key);
  } else {
    const back = series.filter((s) => { const d = daysBetween(s.key, latest.key); return d >= 18 && d <= 49; });
    const ref = back.sort((a, b) => Math.abs(daysBetween(a.key, latest.key) - 28) - Math.abs(daysBetween(b.key, latest.key) - 28))[0];
    out.change4 = ref ? latest.v - ref.v : null;
    out.span = ref ? daysBetween(ref.key, latest.key) : null;
    out.refKey = ref?.key;
  }
  out.change4Real = out.change4 != null && Math.abs(out.change4) >= out.noise;
  out.stale = daysBetween(latest.key, today) > 35;
  return out;
}

/* ── how far to 15 / 12 / 10% ──────────────────────────────────────────── */

/**
 * Weeks until body fat reaches `target`, losing `rate` % of body weight a
 * week, with lean tissue taking `share` of each loss. null when not losing
 * or not within three years.
 */
export function weeksToBodyFat({ pct, weight, ratePct, target, share = forbesLeanShare }) {
  if (pct <= target) return { weeks: 0, weight };
  if (!(ratePct < -0.05)) return null;
  let fat = (weight * pct) / 100, w = weight;
  for (let wk = 1; wk <= 156; wk++) {
    const dw = (w * ratePct) / 100;
    fat += dw - dw * share(fat * KG_PER_LB);
    w += dw;
    if ((fat / w) * 100 <= target) return { weeks: wk, weight: w };
  }
  return null;
}

/**
 * Timelines to each body-fat step under your current one, at your current
 * pace in % of body weight a week (it usually slows as you get leaner), with
 * an optimistic and a cautious bound. Only when the estimate is reliable
 * (a real reading or tape estimate, not BMI) and the trend is clearly down.
 */
export function bodyFatTimelines(bf, trend, targets, { holding = false } = {}) {
  if (!bf) return { ok: false, why: "Needs a body-fat reading or tape measurements first." };
  if (!bf.reliable) return { ok: false, why: "Needs a body-fat reading or waist and neck measurements — a BMI-based guess is too rough to forecast from." };
  if (!trend?.enough) return { ok: false, why: "Needs a weight trend (about 8 weigh-ins over two weeks or more)." };
  if (!(trend.pctPerWeek < -0.05)) return { ok: false, why: "Your weight isn't trending down at the moment, so there's no timeline to give." };
  const w = trend.now;
  const mid = holding ? (f) => 0.5 * forbesLeanShare(f) : forbesLeanShare;
  const rate = trend.pctPerWeek;
  const rows = targets.filter((t) => t < bf.pct).map((t) => {
    const c = weeksToBodyFat({ pct: bf.pct, weight: w, ratePct: rate, target: t, share: mid });
    // the range: your body fat at the low or high end of its range; the late end also lets the pace slow by a quarter
    const o = weeksToBodyFat({ pct: bf.low, weight: w, ratePct: rate, target: t, share: mid });
    const p = weeksToBodyFat({ pct: bf.high, weight: w, ratePct: rate * 0.75, target: t, share: mid });
    return { target: t, weeks: c?.weeks ?? null, weight: c?.weight ?? null, early: o?.weeks ?? null, late: p?.weeks ?? null };
  });
  return { ok: true, rows, rate };
}

/* ── is the scale telling the whole story? ─────────────────────────────── */

/**
 * Waist, weight and strength read together over the same weeks. Each note
 * is { kind: "good" | "watch" | "info", text }. Small changes are left alone.
 */
export function recompInsights({ days, today, waist, strengthStatus, phase = "cut" }) {
  const notes = [];
  if (!waist || waist.change4 == null || waist.stale) {
    notes.push({ kind: "info", text: "Measure your waist once a week, same way each time (morning, before eating, relaxed, tape level at the navel) — it shows fat loss the scale can hide." });
    return notes;
  }
  const end = waist.latestKey, start = waist.refKey || addDays(end, -(waist.span || 28));
  const w1 = weightAt(days, end), w0 = weightAt(days, start);
  const dw = w1 != null && w0 != null ? w1 - w0 : null;
  const dWaist = waist.change4;
  const wks = Math.max(1, Math.round((waist.span || 28) / 7));
  const f = (v, u) => `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} ${u}`;
  const strengthOk = strengthStatus === "stable" || strengthStatus === "improving";
  if (dw == null) {
    notes.push({ kind: "info", text: `Waist ${waist.change4Real ? f(dWaist, "in") : "steady (within tape noise)"} over ~${wks} weeks. Weigh in a few times a week to read it against your weight.` });
    return notes;
  }
  const lostWeight = dw <= -1.5, flatWeight = Math.abs(dw) < 1.5, gained = dw >= 1.5;
  if (lostWeight && waist.change4Real && dWaist < 0) {
    notes.push({ kind: "good", text: `Weight ${f(dw, "lb")} and waist ${f(dWaist, "in")} over ~${wks} weeks${strengthOk ? ", with strength holding" : ""} — consistent with losing fat${strengthOk ? " while keeping muscle" : ""}.` });
  } else if (flatWeight && waist.change4Real && dWaist < 0) {
    notes.push({ kind: "good", text: `Waist ${f(dWaist, "in")} while weight held steady (${f(dw, "lb")}) over ~${wks} weeks${strengthOk ? " and strength held or rose" : ""} — a possible recomposition: less fat, similar weight.` });
  } else if (lostWeight && !waist.change4Real) {
    notes.push({ kind: strengthStatus === "declining" ? "watch" : "info", text: `Weight ${f(dw, "lb")} but waist unchanged (within tape noise) over ~${wks} weeks. Early losses are partly water and glycogen; the waist usually follows.${strengthStatus === "declining" ? " With strength slipping too, some of it may be lean tissue — protein and training matter most here." : ""}` });
  } else if (gained && waist.change4Real && dWaist > 0) {
    notes.push({ kind: phase === "bulk" ? "info" : "watch", text: phase === "bulk" ? `Weight ${f(dw, "lb")} and waist ${f(dWaist, "in")} over ~${wks} weeks — some fat gain comes with a surplus; if the waist climbs faster than about ½ in a month, ease the surplus.` : `Weight ${f(dw, "lb")} and waist ${f(dWaist, "in")} over ~${wks} weeks — both up.` });
  } else if (flatWeight && waist.change4Real && dWaist > 0) {
    notes.push({ kind: "info", text: `Waist ${f(dWaist, "in")} at a steady weight — often bloating, a big meal or a different tape position. Check it again under the same conditions before reading anything into it.` });
  } else if (gained && !waist.change4Real && strengthStatus === "improving") {
    notes.push({ kind: "good", text: `Weight ${f(dw, "lb")} with the waist unchanged and strength rising — the pattern of gaining lean tissue.` });
  } else {
    notes.push({ kind: "info", text: `Waist ${waist.change4Real ? f(dWaist, "in") : "steady"} and weight ${f(dw, "lb")} over ~${wks} weeks — no clear change yet beyond normal variation.` });
  }
  return notes;
}

/** Firsts worth marking: each inch off the waist since your first measurement, and each body-fat step crossed. */
export function bodyMilestones(days, g, today) {
  const out = [];
  const waist = measureSeries(days, "waist", today);
  if (waist.length > 1) {
    const base = waist[0].v;
    for (let n = 1; n <= 12; n++) {
      const hit = waist.find((s) => s.v <= base - n);
      if (!hit) break;
      out.push({ key: hit.key, kind: "waist", inches: n, base, from: waist[0].key });
    }
  }
  const rs = bodyFatReadings(days, g, today).filter((r) => r.err <= 4.5);
  if (rs.length > 1) {
    const start = rs[0].pct;
    for (const t of BF_STEPS.filter((s) => s <= start - 1)) {
      const hit = rs.find((r) => r.pct < t);
      if (hit) out.push({ key: hit.key, kind: "bf", step: t, pct: hit.pct, method: hit.method });
    }
  }
  return out.sort((a, b) => b.key.localeCompare(a.key));
}

/** Everything the Weight page's body composition section shows. */
export function bodyCompAnalysis({ days, g, today, weight, trend, strength, protein }) {
  const holding = strength && (strength.status === "stable" || strength.status === "improving") && (protein == null || protein >= 1.6);
  const bf = currentBodyFat(days, g, today, weight, { holding });
  const comp = composition(weight, bf);
  const changes = Object.fromEntries(MEASURES.map((m) => [m, measureChange(measureSeries(days, m, today), m, today)]));
  const whtr = changes.waist ? waistToHeight(changes.waist.latest, g.heightIn) : null;
  const targets = [...new Set([15, 12, 10, g.targetBodyFat || 10])].sort((a, b) => b - a);
  const timelines = bodyFatTimelines(bf, trend, targets, { holding });
  const insights = recompInsights({ days, today, waist: changes.waist, strengthStatus: strength?.status, phase: g.phase || "cut" });
  const readings = bodyFatReadings(days, g, today);
  const startBf = readings.find((r) => r.err <= 4.5)?.pct ?? null;
  return { bf, comp, changes, whtr, timelines, insights, readings, milestones: bodyMilestones(days, g, today), holding: !!holding, startBf, target: g.targetBodyFat || 10 };
}
