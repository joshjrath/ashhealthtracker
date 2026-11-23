/* ──────────────────────────────────────────────────────────────────────────
   Weight page → Body composition: the physique dashboard, tape
   measurements, progress photos, and the forms to log them. The numbers
   come from js/bodycomp.js. Body fat is always shown with its range and
   how it was arrived at; nothing is read off a photo.
   ────────────────────────────────────────────────────────────────────────── */
import { energyOf } from "./energyview.js";
import { bodyCompAnalysis, BF_LABEL, BF_ERROR, BF_KIND, MEASURE_LABEL, NOISE, measureSeries } from "./bodycomp.js";
import { navyBodyFat } from "./profile.js";
import { MEASURES, BF_METHODS } from "./sources.js";
import { esc, tip } from "./charts.js";
import { fmtInt, addDays, daysBetween } from "./metrics.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayShort = (k) => { const [y, m, d] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${d}${y !== new Date().getFullYear() ? `, ${y}` : ""}`; };
const monthOf = (k) => { const [y, m] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const NOTE = { good: ["ok", "Looks good"], watch: ["mid", "Watch"], info: ["none", "Note"] };
const notesList = (notes) => (notes.length ? `<ul class="snotes">${notes.map((n) => `<li><span class="epill sm ${NOTE[n.kind][0]}">${NOTE[n.kind][1]}</span><span>${esc(n.text)}</span></li>`).join("")}</ul>` : "");
const TAG = { est: "Estimated", logged: "Logged", measured: "Measured" , trend: "Measured trend" };
const tag = (t) => `<span class="etag ${t === "trend" ? "measured" : t}">${TAG[t]}</span>`;
export const POSES = ["front", "side", "back"];
const POSE_LABEL = { front: "Front", side: "Side", back: "Back" };
export const BF_METHOD_LABEL = BF_LABEL;

/** Inches → the unit you chose, as text. */
export const lenOf = (inches, unit) => (unit === "cm" ? inches * 2.54 : inches);
const fmtLen = (inches, unit, dp = 1) => (inches == null ? "—" : `${lenOf(inches, unit).toFixed(dp)}`);
const fmtDelta = (inches, unit) => `${inches > 0 ? "+" : "−"}${Math.abs(lenOf(inches, unit)).toFixed(1)} ${unit}`;

/** The analysis for this draw, worked out once. */
export function bodyOf(ctx) {
  if (ctx._body) return ctx._body;
  const e = energyOf(ctx);
  ctx._body = bodyCompAnalysis({ days: ctx.days, g: ctx.g, today: ctx.today, weight: e.weight, trend: e.trend, strength: e.strength, protein: e.strength?.preservation?.protein });
  return ctx._body;
}

/* ── the physique dashboard ────────────────────────────────────────────── */

export function bodyCompCard(ctx) {
  const b = bodyOf(ctx), e = energyOf(ctx);
  const unit = ctx.g.lengthUnit === "cm" ? "cm" : "in";
  const bf = b.bf, comp = b.comp, w = b.changes.waist;
  const cell = (label, value, note, t) => `<div><span>${label} ${t ? tag(t) : ""}</span><b>${value}</b><em>${note}</em></div>`;
  const methods = bf?.methods?.map((m) => BF_LABEL[m.method]).join(" + ");
  const bfTag = !bf ? null : bf.basis === "readings" && bf.kind === "measured" && !bf.carried && bf.methods.length === 1 ? "measured" : "est";
  const kpis = `<div class="fgrid three ekpis">
    ${cell("Weight", e.weight != null ? `${e.weight.toFixed(1)}<small>lb</small>` : "—", e.trend.enough ? "trend weight today (smoothed)" : "your 7-day average", "trend")}
    ${cell("Body fat", bf ? `${bf.pct.toFixed(1)}<small>%</small>` : "—", bf ? `likely ${bf.low.toFixed(1)}–${bf.high.toFixed(1)}% · ${esc(methods)}${bf.carried ? " (carried to today's weight)" : ""}` : "Log a reading or your waist and neck", bfTag)}
    ${cell("Fat mass", comp ? `${fmtInt(comp.fat)}<small>lb</small>` : "—", comp ? `likely ${fmtInt(comp.fatRange[0])}–${fmtInt(comp.fatRange[1])} lb` : "needs a body-fat estimate", comp ? "est" : null)}
    ${cell("Fat-free mass", comp ? `${fmtInt(comp.lean)}<small>lb</small>` : "—", comp ? `likely ${fmtInt(comp.leanRange[0])}–${fmtInt(comp.leanRange[1])} lb · muscle, bone, water, organs` : "needs a body-fat estimate", comp ? "est" : null)}
    ${cell("Waist-to-height", b.whtr ? b.whtr.v.toFixed(2) : "—", b.whtr ? `${b.whtr.band.word}${b.whtr.band.id === "ok" || b.whtr.band.id === "low" ? " — under 0.5" : ` — ${fmtLen(b.whtr.toHalf, unit)} ${unit} to 0.5`}` : ctx.g.heightIn > 0 ? "Log your waist" : "Add your height in Settings → About you", b.whtr ? "measured" : null)}
    ${cell("Waist", w ? `${fmtLen(w.latest, unit)}<small>${unit}</small>` : "—", w ? (w.change4 == null ? `${dayShort(w.latestKey)} · log again in a week or two` : w.change4Real ? `${fmtDelta(w.change4, unit)} over ~${Math.round((w.span || 28) / 7)} weeks` : `steady over ~${Math.round((w.span || 28) / 7)} weeks (within tape noise)`) : "Log your waist", w ? "measured" : null)}
  </div>`;

  // toward your target
  let target = "";
  if (bf) {
    const t = b.target, start = Math.max(b.startBf ?? bf.pct, bf.pct);
    const span = Math.max(0.1, start - t);
    const at = (v) => Math.max(0, Math.min(100, ((start - v) / span) * 100));
    const fatToGo = comp ? comp.fat - (comp.lean / (1 - t / 100) - comp.lean) : null;
    target = `<div class="bctarget">
      <div class="bct-head"><span class="ea-l">Toward ${t}% body fat</span><span>${bf.pct <= t ? "At or under your target — consider maintenance." : `${(bf.pct - t).toFixed(1)} points to go${fatToGo != null ? ` · about ${fmtInt(fatToGo)} lb of fat at today's weight, if lean mass holds` : ""}`}</span></div>
      <div class="bct-bar"><span class="bct-range" style="left:${at(bf.high).toFixed(1)}%;width:${Math.max(1, at(bf.low) - at(bf.high)).toFixed(1)}%"></span><span class="bct-fill" style="width:${at(bf.pct).toFixed(1)}%"></span><span class="bct-now" style="left:${at(bf.pct).toFixed(1)}%"></span></div>
      <div class="bct-ends"><span>${start.toFixed(1)}% ${b.startBf != null ? "first reading" : "now"}</span><span>${t}%</span></div>
      ${timelinesHtml(b)}
    </div>`;
  }

  const recent = b.milestones.slice(0, 4);
  return `<section class="card energycard bodycard" id="bodycomp">
    <div class="cardhead"><h2>Body composition <span class="sub">what's changing beyond the scale</span></h2>
      <div class="actions"><button type="button" class="btn primary" data-act="meas-open">Log measurements</button><button type="button" class="btn" data-act="photo-open">Add photos</button></div></div>
    ${kpis}
    ${target}
    ${notesList(b.insights)}
    ${recent.length ? `<div class="sec-l">Milestones</div><ul class="bcmiles">${recent.map((m) => `<li><b>${esc(dayShort(m.key))}</b><span>${esc(m.kind === "waist"
      ? `Waist ${unit === "cm" ? `${(m.inches * 2.54).toFixed(1)} cm` : `${m.inches} in`} under your first measurement (${fmtLen(m.base, unit)} ${unit}, ${dayShort(m.from)})`
      : `First reading under ${m.step}% — ${m.pct}% (${BF_LABEL[m.method]}, ±${BF_ERROR[m.method]})`)}</span></li>`).join("")}</ul>` : ""}
    ${b.readings.length ? `<div class="sec-l">Body fat over time <span class="sub">each reading with its typical error · today's combined estimate at the right</span></div>
      <div class="chartbox" data-chart="bodyfat"></div>
      <div class="legend small"><span><i class="lg-dot bf-m"></i>Measured (DEXA, Bod Pod, calipers, scale)</span><span><i class="lg-dot bf-e"></i>Estimated (Navy tape, visual)</span><span><i class="lg-band bf-now"></i>Today's estimate</span></div>` : ""}
    ${readingsHtml(ctx, b)}
    <details class="howto"><summary>How body fat is worked out</summary>
      <ol>
        <li><b>Every method has an error.</b> About one standard deviation versus a reference: DEXA ±${BF_ERROR.dexa}, Bod Pod ±${BF_ERROR.bodpod}, skinfold calipers ±${BF_ERROR.calipers}, the Navy tape method ±${BF_ERROR.navy} (Hodgdon &amp; Beckett 1984), smart scales ±${BF_ERROR.scale}, a visual estimate ±${BF_ERROR.visual} percentage points. A single number is never more precise than its method.</li>
        <li><b>Carried to today.</b> A reading from a few weeks ago is moved to today's weight. Not every pound lost is fat: without lifting, Forbes' rule puts roughly ${fmtInt(100 * 10.4 / (10.4 + (comp?.fat ?? 30) * 0.4536))}% of a loss at your size in lean tissue; lifting with enough protein cuts that a lot. ${b.holding ? "Your strength and protein are holding, so half that share is used." : "Your strength or protein isn't clearly holding, so the full share is used."}</li>
        <li><b>Combined.</b> Recent readings from different methods are averaged by how precise each is, and methods that disagree widen the range.</li>
        <li><b>Never from photos.</b> Photos are for you to compare; no number is read off them.</li>
      </ol>
    </details>
  </section>`;
}

function timelinesHtml(b) {
  const tl = b.timelines;
  if (!tl.ok) return `<p class="hint small">${esc(tl.why)}</p>`;
  const when = (wk) => (wk === 0 ? "now" : wk == null ? "not at this pace" : monthOf(addDays(todayKey(), wk * 7)));
  const rows = tl.rows.map((r) => `<div class="bctl"><b>${r.target}%</b><span>${r.weeks == null ? "Not within three years at this pace" : `around <b>${when(r.weeks)}</b>${r.weight ? ` at ~${fmtInt(r.weight)} lb` : ""}`}</span><em>${r.weeks == null ? "" : `range ${when(r.early)} – ${when(r.late)}`}</em></div>`).join("");
  return `<div class="bctls">${rows}</div>
    <p class="hint small">If your current pace (${tl.rate.toFixed(2)}% of body weight a week) holds — it usually slows as you get leaner, so treat the later end as likelier. The range covers your body fat's uncertainty and a quarter slower pace. Not a promise. <a href="#/forecast">The full forecast</a> models the slowing too, and lets you try changes.</p>`;
}
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function readingsHtml(ctx, b) {
  if (!b.readings.length) return "";
  const list = [...b.readings].reverse().slice(0, 30);
  return `<details class="howto"><summary>Body-fat readings (${b.readings.length})</summary>
    <div class="bfreads">${list.map((r) => `<div class="bfr">
      <b>${esc(dayShort(r.key))}</b><span class="bfv">${r.pct.toFixed(1)}% <em>±${BF_ERROR[r.method] ?? 4.5}</em></span>
      <span>${esc(BF_LABEL[r.method] || r.method)} ${tag(r.kind === "measured" ? "measured" : "est")}</span>
      <span class="bfs">${r.source === "calc" ? "from your tape" : r.source === "apple" ? "Apple Health" : "you"}</span>
      ${r.source === "you" ? `<button type="button" class="ib" data-act="bf-del" data-key="${r.key}" title="Delete this reading" aria-label="Delete this reading">×</button>` : r.source === "calc" ? `<button type="button" class="linkbtn quiet" data-act="meas-open" data-key="${r.key}">Edit tape</button>` : "<span></span>"}
    </div>`).join("")}</div>
  </details>`;
}

/* ── measurements ──────────────────────────────────────────────────────── */

export function chosenMeasure(ctx) {
  const b = bodyOf(ctx);
  const have = MEASURES.filter((m) => b.changes[m]);
  return have.includes(ctx.ui.measure) ? ctx.ui.measure : have[0] || "waist";
}

export function measurementsCard(ctx) {
  const b = bodyOf(ctx);
  const unit = ctx.g.lengthUnit === "cm" ? "cm" : "in";
  const have = MEASURES.filter((m) => b.changes[m]);
  if (!have.length) return `<section class="card" id="measurements">
    <div class="cardhead"><h2>Measurements <span class="sub">tape, in ${unit === "cm" ? "centimetres" : "inches"}</span></h2><button type="button" class="btn primary" data-act="meas-open">Log measurements</button></div>
    <div class="nodata">No measurements yet. Waist is the one that matters most: with your weight, it shows whether you're losing fat or just water — and with your neck and height, it gives a body-fat estimate.</div>
    ${tipsHtml()}
  </section>`;
  const sel = chosenMeasure(ctx);
  const chips = have.map((m) => `<button type="button" class="tab${m === sel ? " on" : ""}" data-act="meas-pick" data-v="${m}">${MEASURE_LABEL[m]}</button>`).join("");
  const rows = have.map((m) => {
    const c = b.changes[m];
    const d = (v, real, span) => (v == null ? `<em>—</em>` : real ? `<b class="${v < 0 ? "dn" : "up"}">${fmtDelta(v, unit)}</b>${span ? `<em>${span}</em>` : ""}` : `<span class="noise">within noise</span>${span ? `<em>${span}</em>` : ""}`);
    return `<div class="mrow"><span class="ml2">${MEASURE_LABEL[m]}</span><span><b>${fmtLen(c.latest, unit)}</b> ${unit}<em>${esc(dayShort(c.latestKey))}${c.stale ? " · a while ago" : ""}</em></span>
      <span>${d(c.change4, c.change4Real, c.change4 == null ? "" : c.refKey ? `over ${Math.round(c.span / 7)} wks` : `trend, last ${Math.round(c.span / 7)} wks`)}</span><span>${d(c.total, c.totalReal, c.n > 1 ? `since ${dayShort(c.firstKey)}` : "")}</span></div>`;
  }).join("");
  return `<section class="card" id="measurements">
    <div class="cardhead"><h2>Measurements <span class="sub">tape, in ${unit === "cm" ? "centimetres" : "inches"} · against your weight</span></h2>
      <div class="actions"><button type="button" class="linkbtn quiet" data-act="meas-unit">Show in ${unit === "in" ? "cm" : "inches"}</button><button type="button" class="btn primary" data-act="meas-open">Log measurements</button></div></div>
    <div class="tabs">${chips}</div>
    <div class="chartbox" data-chart="measure"></div>
    <div class="legend small"><span><i class="lg-dot ms-d"></i>${MEASURE_LABEL[sel]}</span><span><i class="lg-dash"></i>Weight, 7-day average (right axis)</span></div>
    <div class="mtable"><div class="mrow mhead"><span></span><span>Latest</span><span>Per 4 weeks</span><span>Since first</span></div>${rows}</div>
    <p class="hint small">Changes under about ${unit === "cm" ? "1.3 cm" : "½ in"} at the waist (${unit === "cm" ? "0.6 cm" : "¼ in"} at the arms and neck) are normal re-measuring variation, so they're shown as "within noise" rather than progress.</p>
    ${tipsHtml()}
  </section>`;
}

function tipsHtml() {
  return `<details class="howto"><summary>How to measure consistently</summary>
    <ul class="mtips">
      <li><b>Same conditions:</b> morning, after the bathroom, before eating or training. Once a week is plenty.</li>
      <li><b>Waist:</b> at the navel, tape level all round, relaxed after a normal breath out — don't suck in.</li>
      <li><b>Neck:</b> just below the Adam's apple, tape sloping slightly down to the front.</li>
      <li><b>Hips:</b> widest point of the buttocks, feet together.</li>
      <li><b>Chest:</b> at nipple level, arms down, after a normal breath out. <b>Shoulders:</b> around the widest point, arms relaxed.</li>
      <li><b>Arm:</b> mid upper arm, relaxed (or flexed — but always the same). <b>Thigh:</b> midway between hip and knee, same leg each time.</li>
      <li>Snug, not compressing the skin. Two readings and take the average if they differ.</li>
    </ul>
  </details>`;
}

/* ── progress photos ───────────────────────────────────────────────────── */

const photoUrl = (p) => `/api/photos/${encodeURIComponent(p.id)}`;

export function photosCard(ctx) {
  if (ctx.state.demo) return "";
  const photos = ctx.state.photos || [];
  const byDate = {};
  for (const p of photos) (byDate[p.date] ||= []).push(p);
  const dates = Object.keys(byDate).sort();
  const wAt = (k) => ctx.days[k]?.weight ?? null;
  if (!dates.length) return `<section class="card photocard" id="photos">
    <div class="cardhead"><h2>Progress photos <span class="sub">private — only you, signed in, can see them</span></h2><button type="button" class="btn primary" data-act="photo-open">Add photos</button></div>
    <div class="nodata">No photos yet. Front, side and back every 2–4 weeks, in the same spot and light, show changes the scale and tape miss.</div>
    ${photoTips()}
  </section>`;
  const ui = ctx.ui;
  const pose = POSES.includes(ui.photoPose) ? ui.photoPose : POSES.find((x) => photos.some((p) => p.pose === x)) || "front";
  const withPose = dates.filter((d) => byDate[d].some((p) => p.pose === pose));
  const a = withPose.includes(ui.photoA) ? ui.photoA : withPose[0];
  const bDate = withPose.includes(ui.photoB) ? ui.photoB : withPose.at(-1);
  const pa = a && byDate[a].filter((p) => p.pose === pose).at(-1), pb = bDate && byDate[bDate].filter((p) => p.pose === pose).at(-1);
  const opt = (sel) => withPose.map((d) => `<option value="${d}"${d === sel ? " selected" : ""}>${esc(dayShort(d))}${wAt(d) != null ? ` · ${wAt(d).toFixed(1)} lb` : ""}</option>`).join("");
  const mode = ui.photoMode === "slider" ? "slider" : "side";
  const cap = (d) => `${esc(dayShort(d))}${wAt(d) != null ? ` · ${wAt(d).toFixed(1)} lb` : ""}`;
  const compare = withPose.length >= 1 ? `<div class="pcompare">
      <div class="pc-ctl">
        <div class="tabs">${POSES.map((x) => `<button type="button" class="tab${x === pose ? " on" : ""}" data-act="photo-pose" data-v="${x}">${POSE_LABEL[x]}</button>`).join("")}</div>
        <label class="field"><span>Before</span><span class="inp"><select data-photo="A">${opt(a)}</select></span></label>
        <label class="field"><span>After</span><span class="inp"><select data-photo="B">${opt(bDate)}</select></span></label>
        <div class="tabs">${[["side", "Side by side"], ["slider", "Slider"]].map(([v, l]) => `<button type="button" class="tab${v === mode ? " on" : ""}" data-act="photo-mode" data-v="${v}">${l}</button>`).join("")}</div>
        <label class="chk"><input type="checkbox" data-photo="grid"${ui.photoGrid ? " checked" : ""}><i style="--c:#9D8CF5"></i>Grid lines</label>
      </div>
      ${mode === "side" || !pa || !pb
        ? `<div class="pside${ui.photoGrid ? " grid" : ""}">${[[a, pa], [bDate, pb]].map(([d, p]) => (p ? `<figure><div class="pframe"><img src="${photoUrl(p)}" alt="${POSE_LABEL[pose]} photo, ${esc(dayShort(d))}" loading="lazy"></div><figcaption>${cap(d)}</figcaption></figure>` : "")).join("")}</div>`
        : `<div class="pslider${ui.photoGrid ? " grid" : ""}" style="--x:${ui.photoX ?? 50}%">
            <div class="pframe"><img src="${photoUrl(pa)}" alt="Before, ${esc(dayShort(a))}"><img class="after" src="${photoUrl(pb)}" alt="After, ${esc(dayShort(bDate))}"><span class="pdiv"></span></div>
            <input type="range" min="0" max="100" value="${ui.photoX ?? 50}" data-photo="x" aria-label="Before / after">
            <div class="pcaps"><span>Before · ${cap(a)}</span><span>After · ${cap(bDate)}</span></div>
          </div>`}
      ${a && bDate && a !== bDate ? `<p class="hint small">${daysBetween(a, bDate)} days apart${wAt(a) != null && wAt(bDate) != null ? ` · ${(wAt(bDate) - wAt(a) > 0 ? "+" : "−")}${Math.abs(wAt(bDate) - wAt(a)).toFixed(1)} lb` : ""}.</p>` : ""}
    </div>` : "";
  const gallery = [...dates].reverse().map((d) => `<div class="pday"><div class="pday-h"><b>${esc(dayShort(d))}</b>${wAt(d) != null ? `<span>${wAt(d).toFixed(1)} lb</span>` : ""}</div>
      <div class="pthumbs">${POSES.map((x) => byDate[d].filter((p) => p.pose === x).map((p) => `<figure class="pthumb"><img src="${photoUrl(p)}" alt="${POSE_LABEL[x]}, ${esc(dayShort(d))}" loading="lazy"><figcaption>${POSE_LABEL[x]}</figcaption>
        <button type="button" class="ib" data-act="photo-del" data-v="${esc(p.id)}" title="Delete photo" aria-label="Delete photo">×</button></figure>`).join("")).join("")}</div></div>`).join("");
  return `<section class="card photocard" id="photos">
    <div class="cardhead"><h2>Progress photos <span class="sub">private — only you, signed in, can see them</span></h2><button type="button" class="btn primary" data-act="photo-open">Add photos</button></div>
    ${compare}
    <details class="howto"${dates.length <= 3 ? " open" : ""}><summary>All photos (${photos.length})</summary><div class="pgallery">${gallery}</div></details>
    ${photoTips()}
    <p class="hint small">Stored in this site's database and sent only to a signed-in browser, never cached and never on a public link. Location and camera details are stripped on upload. Photos aren't in the Google Sheet copy, automatic backups or exports (they'd be far too large) — right-click a photo to save your own copy.</p>
  </section>`;
}

function photoTips() {
  return `<details class="howto"><summary>Framing photos the same way each time</summary>
    <ul class="mtips">
      <li>Same spot, same light (daylight from the front, or the same lamp), same time of day — mornings are most consistent.</li>
      <li>Phone at chest height, the same distance away (mark the floor), on a shelf or timer rather than a mirror selfie.</li>
      <li>Same clothing, relaxed posture, arms slightly away from the body. Front, a side (same side every time) and back.</li>
      <li>When adding a photo, your last one of that pose shows faintly over it so you can line them up.</li>
    </ul>
  </details>`;
}

/* ── forms (in the panel dialog) ───────────────────────────────────────── */

export function measureForm(ctx, key) {
  const unit = ctx.g.lengthUnit === "cm" ? "cm" : "in";
  const raw = ctx.raw[key]?.manual || {};
  const m = raw.meas || {};
  const last = (k) => { const s = measureSeries(ctx.days, k, addDays(key, -1)); return s.at(-1); };
  const g = ctx.g;
  const navy = g.sex && g.heightIn > 0 ? navyBodyFat(g.sex, g.heightIn, m) : null;
  const field = (k) => {
    const prev = last(k);
    return `<label class="field"><span>${MEASURE_LABEL[k]}</span><span class="inp"><input type="number" name="m-${k}" min="1" max="250" step="0.1" inputmode="decimal" value="${m[k] != null ? lenOf(m[k], unit).toFixed(1) : ""}" placeholder="${prev ? lenOf(prev.v, unit).toFixed(1) : ""}"><em>${unit}</em></span>${prev ? `<small class="fhint">last ${lenOf(prev.v, unit).toFixed(1)} · ${esc(dayShort(prev.key))}</small>` : ""}</label>`;
  };
  return `<form data-form="measure" data-key="${key}" data-unit="${unit}">
    <header><div><div class="eyebrow">${esc(dayShort(key))}</div><h2>Log measurements</h2></div><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="fields"><label class="field"><span>Day</span><span class="inp"><input type="date" name="mday" value="${key}" max="${ctx.today}" data-meas-day></span></label>
      <label class="field"><span>Units</span><span class="inp"><select name="unit" data-meas-unit><option value="in"${unit === "in" ? " selected" : ""}>inches</option><option value="cm"${unit === "cm" ? " selected" : ""}>cm</option></select></span></label></div>
    <h3>Tape</h3>
    <div class="fields">${MEASURES.map(field).join("")}</div>
    <p class="hint small" data-navy>${navyText(g, navy)}</p>
    <h3>Body fat reading <span class="sub">optional — from a scan, calipers, a smart scale…</span></h3>
    <div class="fields">
      <label class="field"><span>Body fat</span><span class="inp"><input type="number" name="bodyFat" min="2" max="75" step="0.1" inputmode="decimal" value="${raw.bodyFat ?? ""}"><em>%</em></span></label>
      <label class="field"><span>How it was measured</span><span class="inp"><select name="bodyFatMethod">${BF_METHODS.map((x) => `<option value="${x}"${(raw.bodyFatMethod || lastMethod(ctx, key)) === x ? " selected" : ""}>${esc(BF_LABEL[x])} (±${BF_ERROR[x]})</option>`).join("")}</select></span></label>
    </div>
    <p class="hint small">The ± is each method's typical error in percentage points. ${BF_KIND.visual === "estimate" ? "Visual guesses count as estimates; scans, calipers and scales as measurements." : ""}</p>
    <footer>
      ${raw.meas || raw.bodyFat != null ? `<button type="button" class="btn danger ghost" data-act="meas-clear">Clear this day</button>` : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </footer>
  </form>`;
}

/** The method of your most recent reading before this day — usually how you'll measure next. */
function lastMethod(ctx, key) {
  const k = Object.keys(ctx.raw).filter((x) => x < key && ctx.raw[x]?.manual?.bodyFatMethod).sort().at(-1);
  return k ? ctx.raw[k].manual.bodyFatMethod : "scale";
}

export function navyText(g, navy) {
  if (!g.sex || !(g.heightIn > 0)) return "Add your sex and height in Settings → About you, and waist + neck here give a Navy-method body-fat estimate.";
  if (navy == null) return `Waist and neck${g.sex === "female" ? " and hips" : ""} give a Navy-method body-fat estimate (±${BF_ERROR.navy} points).`;
  return `From these, the Navy method gives about <b>${navy.toFixed(1)}%</b> (±${BF_ERROR.navy}) — saved automatically as an estimate.`;
}

/** Your most recent photo of a pose (what a new one is lined up against). */
export const lastPhotoOf = (photos, pose) => [...(photos || [])].filter((p) => p.pose === pose).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)).at(-1) || null;
export const photoSrc = photoUrl;
export const ghostLabel = (ghost, pose) => (ghost ? `Your last ${POSE_LABEL[pose].toLowerCase()} photo (${dayShort(ghost.date)}) over it` : `Your next ${POSE_LABEL[pose].toLowerCase()} photo will show this one faintly over it, to line them up.`);

export function photoForm(ctx, draft) {
  const ghost = lastPhotoOf(ctx.state.photos, draft.pose);
  return `<form data-form="photo">
    <header><div><div class="eyebrow">Private</div><h2>Add progress photos</h2></div><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="fields">
      <label class="field"><span>Taken on</span><span class="inp"><input type="date" name="date" value="${draft.date}" max="${ctx.today}" required></span></label>
      <label class="field"><span>Pose</span><span class="inp"><select name="pose" data-photo-pose>${POSES.map((x) => `<option value="${x}"${x === draft.pose ? " selected" : ""}>${POSE_LABEL[x]}</option>`).join("")}</select></span></label>
    </div>
    <label class="pfile"><input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/heic,image/*" data-photo-file required><span>Choose a photo</span></label>
    <div class="pprev" data-photo-prev hidden>
      <div class="pframe"><img data-prev alt="Preview"><img class="ghost" src="${ghost ? photoUrl(ghost) : ""}" data-ghost alt="Your last photo of this pose, faint, for lining up"${ghost ? "" : " hidden"}></div>
      <label class="field ghostctl"><span data-ghost-l>${esc(ghostLabel(ghost, draft.pose))}</span><input type="range" min="0" max="80" value="35" data-ghost-op aria-label="Overlay strength"${ghost ? "" : " hidden"}></label>
    </div>
    <p class="hint small">Shrunk to at most 1600 px in your browser, then stored privately; location and camera details are removed. Only a signed-in browser can see it.</p>
    <p class="formerr" data-photo-err hidden></p>
    <footer><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" data-photo-save>Save photo</button></footer>
  </form>`;
}
