/* ──────────────────────────────────────────────────────────────────────────
   Achievements on screen: the Next Unlock card on Today, the trophy room,
   a badge's details, the next-unlocks panel, rewards, and the unlock
   moment. Every number comes from the one engine (achievements.js) via
   ctx.ach — nothing here decides what's unlocked.
   ────────────────────────────────────────────────────────────────────────── */
import { badge, THEMES } from "./badges.js";
import { progressText, remainingText } from "./achievements.js";
import { esc, tip } from "./charts.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateText = (k) => { const [y, m, d] = k.slice(0, 10).split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const shortDate = (k) => { const [, m, d] = k.slice(0, 10).split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
const pctText = (t) => `${Math.floor(t.pct * 100)}%`;
const color = (t) => (THEMES[t.theme] || THEMES.complete).color;

/** How a tier's unlock date reads: a real date, or honestly unknown. */
export function unlockedWhen(t) {
  if (!t.unlocked) return "";
  return t.dateKnown && t.unlockedAt ? `Unlocked ${dateText(t.unlockedAt)}` : "Earned historically · exact date unknown";
}

const art = (t, size, extra = {}) => badge({ theme: t.theme, tier: t.tier, lit: t.pct, unlocked: t.unlocked, size, title: `${t.name}${t.unlocked ? ", unlocked" : `, ${pctText(t)}`}`, ...extra });

const bar = (t) => `<span class="abar" style="--c:${color(t)}"><span style="width:${(t.pct * 100).toFixed(1)}%"></span></span>`;

/* ── Today: the one most relevant next unlock ──────────────────────────── */

export function nextUnlockCard(ctx) {
  const ach = ctx.ach;
  if (!ach) return "";
  const t = ach.next[0];
  if (!t) {
    const done = ach.unlockedCount === ach.total;
    return `<a class="card nextunlock quiet" href="#/achievements">
      <span class="nu-txt"><span class="eyebrow">Next unlock</span><b class="nu-name">${done ? "Every achievement unlocked" : "Log a few days to see what's next"}</b>
      <span class="nu-req">${ach.unlockedCount} / ${ach.total} unlocked · open the trophy room</span></span></a>`;
  }
  const reward = t.rewards.find((r) => !r.claimedAt);
  return `<button type="button" class="card nextunlock" data-act="next-open" style="--c:${color(t)}" aria-label="Next unlock: ${esc(t.name)}, ${pctText(t)}. Show the next few.">
    <span class="nu-badge">${art(t, 60)}</span>
    <span class="nu-txt">
      <span class="eyebrow">Next unlock</span>
      <b class="nu-name">${esc(t.name)}</b>
      <span class="nu-req">${esc(t.requirement)} · ${esc(progressText(t))}</span>
    </span>
    <span class="nu-side"><span class="chip">${esc(t.label)}</span><span class="nu-pct"><b>${Math.floor(t.pct * 100)}</b>%</span></span>
    ${bar(t)}
    ${reward ? `<span class="nu-reward">Reward: ${esc(reward.name)}</span>` : ""}
  </button>`;
}

/* ── the next few, across families ─────────────────────────────────────── */

function nextRow(t) {
  const reward = t.rewards.find((r) => !r.claimedAt);
  return `<button type="button" class="nxrow" data-act="ach-open" data-id="${t.id}" style="--c:${color(t)}">
    <span class="nx-badge">${art(t, 48)}</span>
    <span class="nx-main">
      <span class="nx-top"><b>${esc(t.name)}</b><span class="chip">${esc(t.label)}</span></span>
      <span class="nx-req">${esc(t.requirement)}</span>
      ${bar(t)}
      <span class="nx-prog"><span>${esc(progressText(t))} · ${pctText(t)}</span><span>${esc(remainingText(t))}</span></span>
      <span class="nx-why">${esc(t.why)}${reward ? ` · Reward: ${esc(reward.name)}` : ""}</span>
    </span>
  </button>`;
}

export function nextPanel(ctx) {
  const list = ctx.ach.next.slice(0, 5);
  return `<header>
      <div><div class="eyebrow">Achievements</div><h2>Up next</h2></div>
      <button type="button" class="x" data-close aria-label="Close">×</button>
    </header>
    <p class="hint">Ordered by what's realistically closest: anything possible today first, then the shortest time at your recent pace — not raw percentage, since a pound, a workout and a day aren't the same size.</p>
    <div class="nxlist">${list.length ? list.map(nextRow).join("") : `<div class="empty-row">Nothing in reach yet — log a few days first.</div>`}</div>
    <footer><a class="btn" href="#/achievements" data-close>Open the trophy room</a></footer>`;
}

/* ── the trophy room ───────────────────────────────────────────────────── */

const dots = (gr) => `<span class="dots" aria-label="${gr.unlockedCount} of ${gr.tiers.length} tiers">${gr.tiers.map((t) => `<i class="${t.unlocked ? "on" : ""}"></i>`).join("")}</span>`;

function familyCard(ctx, gr, fresh) {
  const c = (THEMES[gr.theme] || THEMES.complete).color;
  const next = gr.next;
  const slots = gr.tiers.map((t) => {
    const isNext = next && t.id === next.id && !gr.needsSetup;
    const when = t.unlocked ? (t.dateKnown && t.unlockedAt ? shortDate(t.unlockedAt) : "Historical") : isNext ? pctText(t) : "Locked";
    return `<button type="button" class="bslot${t.unlocked ? " on" : ""}${isNext ? " next" : ""}${fresh.has(t.id) ? " fresh" : ""}" data-act="ach-open" data-id="${t.id}"
        ${tip(t.name, t.requirement, t.unlocked ? unlockedWhen(t) : `${progressText(t)} · ${pctText(t)}`)}>
      ${art(t, 76)}
      <span class="bl">${t.roman}</span>
      <span class="bw">${esc(when)}${fresh.has(t.id) ? ` <em class="new">New</em>` : ""}</span>
    </button>`;
  }).join("");
  const foot = gr.needsSetup
    ? `<div class="famnext setup"><span>${esc(gr.needsSetup)}</span><a class="btn" href="#/settings" data-jump="sec-training">Set training plan</a></div>`
    : next
      ? `<div class="famnext"><div class="fn-top"><span>Next · <b>${esc(next.name)}</b> — ${esc(next.requirement)}</span><span>${esc(progressText(next))} · ${pctText(next)}</span></div>
          ${bar(next)}<div class="fn-sub">${esc(remainingText(next))}</div></div>`
      : `<div class="famnext done"><span>Every tier unlocked.</span></div>`;
  return `<section class="card fam" style="--c:${c}">
    <div class="cardhead"><h2>${esc(gr.name)}</h2><span class="famcount">${dots(gr)}<b>${gr.unlockedCount}/${gr.tiers.length}</b></span></div>
    <div class="bslots">${slots}</div>
    ${foot}
    <p class="foot-note">${esc(gr.about)}</p>
  </section>`;
}

export function achievementsPage(ctx, fresh = new Set()) {
  const ach = ctx.ach;
  const segs = ach.groups.map((gr) => `<span class="thseg" style="--c:${(THEMES[gr.theme] || THEMES.complete).color}" ${tip(gr.name, `${gr.unlockedCount} of ${gr.tiers.length} tiers`)}>
      ${gr.tiers.map((t) => `<i class="${t.unlocked ? "on" : ""}"></i>`).join("")}</span>`).join("");
  const fams = ach.groups.map((gr) => `<span class="thfam" style="--c:${(THEMES[gr.theme] || THEMES.complete).color}"><i></i>${esc(gr.name)} ${dots(gr)}</span>`).join("");
  const next = ach.next.slice(0, 3);
  return `<section class="card trophyhead">
      <div class="th-count"><b>${ach.unlockedCount}</b><small>/ ${ach.total}</small><span>achievements unlocked</span></div>
      <div class="th-mid"><div class="thsegs">${segs}</div><div class="thfams">${fams}</div></div>
      <div class="th-next">
        <div class="eyebrow">Up next</div>
        ${next.length ? next.map((t) => `<button type="button" class="thn" data-act="ach-open" data-id="${t.id}" style="--c:${color(t)}">${art(t, 34)}<span><b>${esc(t.name)}</b><em>${esc(t.label)} · ${pctText(t)}</em></span></button>`).join("") : `<span class="muted">Nothing in reach yet</span>`}
        ${next.length ? `<button type="button" class="linkbtn quiet" data-act="next-open">See why these</button>` : ""}
      </div>
    </section>
    <div class="grid wide-right trophyroom">
      <div class="famlist">${ach.groups.map((gr) => familyCard(ctx, gr, fresh)).join("")}</div>
      <div class="sidecol">${rewardsCard(ctx)}
        <section class="card howach"><h2>How achievements work</h2>
          <ul class="plain">
            <li>Everything is calculated from your trusted data: food and sleep you logged, lifts you logged, and Apple Health only for steps, workouts, activity and weight.</li>
            <li>Apple Health nutrition and sleep can never unlock anything.</li>
            <li>Nothing rewards eating less. Nutrition badges need complete days inside your calorie range with protein hit.</li>
            <li>Unlocks count from your history too; a badge earned before tracking began says so instead of showing an invented date.</li>
            <li>Tier thresholds can be changed in Settings → Achievements.</li>
          </ul>
        </section>
      </div>
    </div>`;
}

/* ── one badge ─────────────────────────────────────────────────────────── */

export function badgeDetail(ctx, id) {
  const ach = ctx.ach;
  const t = ach.byId[id];
  if (!t) return `<header><h2>Not found</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>`;
  const gr = ach.groups.find((x) => x.id === t.group);
  const nextTier = gr.tiers[t.tier] || null;
  const ranked = ach.next.find((x) => x.id === t.id);
  const rewards = t.rewards.map((r) => `<div class="rwmini">
      <span><b>${esc(r.name)}</b>${r.description ? `<em>${esc(r.description)}</em>` : ""}</span>
      ${r.claimedAt ? `<span class="chip done">Claimed ${esc(shortDate(r.claimedAt))}</span>`
        : t.unlocked ? `<button type="button" class="btn primary" data-act="reward-claim" data-id="${esc(r.id)}">Claim reward</button>`
        : `<span class="chip">Unlocks with this badge</span>`}
    </div>`).join("");
  return `<header>
      <div><div class="eyebrow">${esc(gr.name)} · Tier ${t.roman} of ${gr.tiers[gr.tiers.length - 1].roman}</div><h2>${esc(t.name)}</h2></div>
      <button type="button" class="x" data-close aria-label="Close">×</button>
    </header>
    <div class="bd" style="--c:${color(t)}">
      <div class="bd-badge">${art(t, 150, { title: t.name })}</div>
      <div class="bd-info">
        <div class="bd-status ${t.unlocked ? "on" : ""}">${t.unlocked ? esc(unlockedWhen(t)) : "Locked"}</div>
        <div class="bd-req">${esc(t.unlocked ? t.unlockedText : t.requirement)}</div>
        ${t.unlocked ? "" : `<div class="bd-prog">${bar(t)}<div class="nx-prog"><span>${esc(progressText(t))} · ${pctText(t)}</span><span>${esc(remainingText(t))}</span></div></div>`}
        ${ranked ? `<div class="bd-eta"><span class="chip">${esc(ranked.label)}</span> ${esc(ranked.why)}</div>` : ""}
        <dl class="bd-dl">
          <div><dt>Requirement</dt><dd>${esc(t.requirement)}</dd></div>
          <div><dt>Next tier</dt><dd>${nextTier ? `${esc(nextTier.name)} — ${esc(nextTier.requirement)}` : "This is the top tier"}</dd></div>
          <div><dt>How it's measured</dt><dd>${esc(t.about)}</dd></div>
        </dl>
        <div class="bd-rw"><div class="sec-l">Reward</div>${rewards || `<p class="hint small">No reward linked. You decide what earning this is worth.</p>`}
          <button type="button" class="btn" data-act="reward-new" data-ach="${t.id}">${t.rewards.length ? "Add another reward" : "Add a reward"}</button></div>
      </div>
    </div>`;
}

/* ── rewards: yours, not the site's ────────────────────────────────────── */

export function rewardState(r, ach) {
  if (r.claimedAt) return "claimed";
  if (!r.achievementId) return "upcoming";
  const t = ach.byId[r.achievementId];
  return t?.unlocked ? "ready" : "upcoming";
}

function rewardRow(ctx, r) {
  const t = r.achievementId ? ctx.ach.byId[r.achievementId] : null;
  const st = rewardState(r, ctx.ach);
  const link = t
    ? `<button type="button" class="rwlink" data-act="ach-open" data-id="${t.id}" style="--c:${color(t)}">${art(t, 26)}<span>${esc(t.name)}${t.unlocked ? "" : ` · ${pctText(t)}`}</span></button>`
    : r.achievementId ? `<span class="muted">Linked achievement no longer exists</span>`
    : `<span class="muted">${esc(r.requirement || "Your own milestone")}</span>`;
  const action = st === "ready" ? `<button type="button" class="btn primary" data-act="reward-claim" data-id="${esc(r.id)}">Claim reward</button>`
    : st === "claimed" ? `<span class="chip done">Claimed ${esc(shortDate(r.claimedAt))}</span><button type="button" class="linkbtn quiet" data-act="reward-unclaim" data-id="${esc(r.id)}">Undo</button>`
    : !r.achievementId ? `<button type="button" class="btn" data-act="reward-claim" data-id="${esc(r.id)}">Mark claimed</button>` : "";
  return `<div class="rwrow ${st}">
    <div class="rw-main"><b>${esc(r.name)}</b>${r.description ? `<em>${esc(r.description)}</em>` : ""}${link}</div>
    <div class="rw-acts">${action}
      <button type="button" class="ib" data-act="reward-edit" data-id="${esc(r.id)}" title="Edit" aria-label="Edit reward"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16l.8-3.2L13.5 4a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L7.2 15.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
    </div>
  </div>`;
}

export function rewardsCard(ctx) {
  const list = (ctx.state.library?.rewards || []).filter((r) => !r.archived);
  const by = { ready: [], upcoming: [], claimed: [] };
  for (const r of list) by[rewardState(r, ctx.ach)].push(r);
  by.upcoming.sort((a, b) => (ctx.ach.byId[b.achievementId]?.pct ?? -1) - (ctx.ach.byId[a.achievementId]?.pct ?? -1));
  by.claimed.sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
  const sec = (title, rows, empty) => `<div class="rwsec"><div class="sec-l">${title}${rows.length ? ` · ${rows.length}` : ""}</div>${rows.length ? rows.map((r) => rewardRow(ctx, r)).join("") : `<p class="hint small">${empty}</p>`}</div>`;
  return `<section class="card rewards" id="rewards">
    <div class="cardhead"><h2>Rewards <span class="sub">you choose them</span></h2><button type="button" class="btn" data-act="reward-new">Add reward</button></div>
    ${list.length ? `${sec("Unlocked · unclaimed", by.ready, "Nothing waiting to be claimed.")}${sec("Upcoming", by.upcoming, "Link a reward to an achievement and it shows here with its progress.")}${sec("Claimed", by.claimed, "Rewards you've claimed are kept here.")}`
      : `<p class="hint">Pick something you'd genuinely enjoy and link it to an achievement — new running shoes for Weight Loss II, say. The site never picks rewards for you.</p>`}
  </section>`;
}

export function rewardForm(ctx, r = null, achId = null) {
  const linked = r ? r.achievementId : achId;
  const options = ctx.ach.groups.map((gr) => `<optgroup label="${esc(gr.name)}">${gr.tiers.map((t) =>
    `<option value="${t.id}"${t.id === linked ? " selected" : ""}>${esc(t.name)} — ${esc(t.requirement)}${t.unlocked ? " (unlocked)" : ""}</option>`).join("")}</optgroup>`).join("");
  return `<form data-form="reward" data-id="${esc(r?.id || "")}">
    <header>
      <div><div class="eyebrow">Rewards</div><h2>${r ? "Edit reward" : "New reward"}</h2></div>
      <button type="button" class="x" data-close aria-label="Close">×</button>
    </header>
    <label class="field"><span>Reward</span><span class="inp"><input name="name" maxlength="100" required value="${esc(r?.name || "")}" placeholder="New running shoes"></span></label>
    <label class="field"><span>Unlocks with</span><span class="inp"><select name="achievementId"><option value="">My own milestone (I'll mark it myself)</option>${options}</select></span></label>
    <label class="field"><span>Milestone, if it's your own</span><span class="inp"><input name="requirement" maxlength="200" value="${esc(r?.requirement || "")}" placeholder="Run a 5K without stopping"></span></label>
    <label class="field"><span>Notes (optional)</span><span class="inp"><input name="description" maxlength="400" value="${esc(r?.description || "")}" placeholder="The blue ones"></span></label>
    <footer>
      ${r ? `<button type="button" class="btn danger ghost" data-act="reward-delete" data-id="${esc(r.id)}">Delete</button>` : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save reward</button>
    </footer>
  </form>`;
}

/* ── the unlock moment ─────────────────────────────────────────────────── */

/**
 * Shown once per unlock, on any page, until acknowledged. Unlocks your
 * history already held when achievements arrived get one quiet summary
 * instead of a parade.
 */
export function celebration(ctx, unseen, ledger) {
  if (!unseen.length) return "";
  const historical = unseen.filter((t) => ledger?.entries?.[t.id]?.historical);
  const fresh = unseen.filter((t) => !ledger?.entries?.[t.id]?.historical);
  if (!fresh.length) {
    return `<div class="cb-inner hist">
      <div class="cb-badges">${historical.slice(0, 3).map((t) => art(t, 44)).join("")}</div>
      <div class="cb-txt"><span class="eyebrow">Achievements</span><b>${historical.length} earned from your history</b><span>Counted from the days you'd already logged.</span></div>
      <div class="cb-acts"><button type="button" class="btn primary" data-act="celebrate-view" data-id="">View trophy room</button>
        <button type="button" class="x" data-act="celebrate-dismiss" aria-label="Dismiss">×</button></div>
    </div>`;
  }
  // The newest, highest unlock leads.
  const t = [...fresh].sort((a, b) => (b.unlockedAt || "").localeCompare(a.unlockedAt || "") || b.tier - a.tier)[0];
  const reward = t.rewards.find((r) => !r.claimedAt);
  const more = unseen.length - 1;
  return `<div class="cb-inner" style="--c:${color(t)}">
    <div class="cb-badge">${art(t, 64)}</div>
    <div class="cb-txt"><span class="eyebrow">Achievement unlocked</span><b>${esc(t.name)}</b>
      <span>${esc(t.unlockedText)} · ${t.dateKnown && t.unlockedAt ? `Unlocked ${esc(shortDate(t.unlockedAt))}` : "Earned historically"}</span>
      ${reward ? `<span class="cb-reward">Reward ready: ${esc(reward.name)}</span>` : ""}
      ${more ? `<span class="cb-more">+${more} more</span>` : ""}</div>
    <div class="cb-acts"><button type="button" class="btn primary" data-act="celebrate-view" data-id="${t.id}">View achievement</button>
      <button type="button" class="x" data-act="celebrate-dismiss" aria-label="Dismiss">×</button></div>
  </div>`;
}
