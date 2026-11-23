# Ash Health

A personal health dashboard in the same dark style as the Specular dashboard. It shows weight, nutrition, activity and sleep with health-specific charts instead of a generic calorie log.

A small Node server serves the page behind a password, stores the log in Postgres, and takes Apple Health data from your iPhone at `/api/ingest`. Two dependencies: `pg`, and `@anthropic-ai/sdk` for the optional AI food estimates.

```sh
npm install
npm start        # http://localhost:5173: no password, log kept in data/local.json
npm test         # calculations, Apple Health parsing, and the server's auth and API
```

## What's on it

| Page | What it shows |
|---|---|
| **Today** | Goals hit as *5/8* (percentage second) with a **Finish today** list of what's left per goal · **Next unlock** (the one achievement realistically closest, with its reward) · **supplements** checked off one by one · stat cards · calorie ring with the success zone · macros · today vs your 14-day average · week grid (hit / missed / no data / in progress) · streaks · **this week** review (biggest win, biggest gap, change vs last week) · **consistency** (last 7 / 30 / previous 30 days) · **insights** once there's enough history · goal journey · weekly weight |
| **Weight** | Daily weigh-ins with the 7-day average as the main line · 7-day average, 30-day change, lb/week and trend · an estimated goal date, only once the data supports one · **Metabolism & energy balance**: adaptive maintenance estimate with its range and confidence, intake from complete days, deficit, a suggested calorie target you can accept or decline, plateau check · **Body composition**: body fat with its likely range and how it was arrived at (DEXA, Bod Pod, calipers, smart scale, Navy tape estimate…), fat and fat-free mass, waist-to-height, progress toward your target with timelines to 15 / 12 / 10%, what waist, weight and strength say together, milestones · **Measurements** (waist, neck, chest, shoulders, hips, arm, thigh; inches or cm) against weight · **Progress photos**, private, front / side / back, side by side or with a before/after slider |
| **Nutrition** | The **food diary** (breakfast / lunch / dinner / snacks, fast search-or-describe entry, every entry editable, and **placeholders** — just the macros, for eating out) · daily summary as *current / target — remaining* · **weekly calories** (weekly target, logged, target remaining, average available per remaining day, pacing chart) · trends from **complete** food days · food history meal by meal · **My foods** (recent, favorites, frequent, custom, meals) |
| **Fitness** | Active calories / exercise / steps rings · this week's workouts, minutes and calories · **Strength**: the week against your training plan, sets you log (or **repeat a past session** and adjust it), volume and new bests · a week view of workouts as blocks by time of day · exercise per week · workout mix · six months of activity · recent workouts · **Strength & muscle preservation** (status, strength index vs body weight, protein, what to watch) · **Progressive overload** (per lift: est. 1-rep max, six-week trend, ready to add weight / build reps / stalled) · **Training volume & recovery** (sets a week per muscle group, the past seven days as Push / Pull / Legs, rest days, sleep) |
| **Sleep** | Bedtime → wake bars from your own logs, with your target window behind them, and average bedtime, wake, spread and nights on schedule |
| **Calendar** | Each day shaded by goals hit; days with no data look empty rather than failed. Click a day for everything logged that day and where each number came from. |
| **Achievements** | The trophy room: 5 badge families × 5 tiers (Weight Loss, Iron, Training Consistency, Nutrition Consistency, Complete Days), progress toward each, unlock dates (or "earned historically" when the date can't be known), what's up next and why, and **rewards you choose** — upcoming, ready to claim, claimed |
| **Settings** | Goals (incl. weekly calories and estimated maintenance), Apple Health (sync status, upload tokens), data sources, **food lookup** keys, **training plan**, **supplements**, **achievement tiers**, dashboard defaults, password, backup, and the review of older entries |

## Where each number comes from

Every stored day keeps each source in its own bucket, `{ manual, apple, legacy }`, and `js/sources.js` decides which buckets each metric may read:

| Metric | Source |
|---|---|
| Calories, protein, carbs, fat, fiber | **Manual only** |
| Sleep (bedtime → wake) | **Manual only** |
| Supplements | Manual only |
| Steps, active calories, exercise minutes | Apple Health, or a value you type (yours wins that day) |
| Workouts | Apple Health's workouts, or your "worked out" tick |
| Weight | A weigh-in you type, else Apple Health's |

Apple Health can't reach a manual-only metric: `/api/ingest` drops food and sleep before anything is stored, and the Apple bucket only accepts the fields above. Days saved before this existed were moved to `legacy` and their food and sleep are left out of every number until you sort them in **Settings → Review older entries**.

Food is itemised in the diary (`manual.foods`, each entry with its numbers frozen at the amount you logged and where they came from). Older days keep their typed totals as a "quick add"; a day's food is the two added together. Lifts live in `manual.lifts`, on whichever day you pick in the lift log — any past day, so a session logged after midnight (or on the wrong day) can be put back where it belongs. Neither can arrive from Apple Health.

Supplements are a list kept with your goals (`goals.supplements`: name, dose, and the dates each applies between); each day stores a yes/no per supplement (`manual.creatine` for creatine, from before there was a list, and `manual.supps` for the rest). The Supplements goal is hit when everything due that day was taken, and a supplement only counts from the day it's added until the day it's removed, so changing the list never rewrites past days. A **placeholder** is an ordinary diary entry tagged `placeholder`: a name and the macros, with calories worked out from 4/4/9 when left empty.

**Missing is never zero.** Each goal is *hit*, *missed*, *no data* or (today) *in progress*. A hit is final as soon as it happens. A miss needs proof: a finished day, a complete food log, or a value that can't come back into range. Averages skip days without data and need at least 3 real observations. Adherence needs 10 judged goal-days. A goal date needs 14 weigh-ins over 3+ weeks and a real downward trend. Otherwise the page says "Not enough data yet".

## Food lookup

Search looks in your saved foods first, then (most trusted first):

| Source | Shown as | Cost / limits |
|---|---|---|
| USDA FoodData Central — Branded (the manufacturer's label data) | **Verified** | Free. Without a key it uses USDA's shared demo key (a few searches an hour); a free personal key allows ~1,000/hour |
| FatSecret (optional) — brand and chain-restaurant foods | **Database** | Free Basic plan, 5,000 calls/day with attribution; needs the server's IP on the key's allow-list |
| USDA generic foods (Foundation, SR Legacy, FNDDS) | **Database** | as above |
| Open Food Facts — community-entered packaged foods | **Database** ("check against your label") | Free, no key; the server stays under 10 searches/minute |
| Claude — only when you tap "Estimate with AI" | **Estimated**, with confidence, range and basis | About a cent or two per estimate on your Anthropic account; cached |

Every result opens editable before anything is saved. Searches are cached for two weeks and any food you log is kept in My foods, so repeat foods need no lookup. Keys are set in **Settings → Food lookup** (stored in the database, never shown in full) or as the optional variables `USDA_API_KEY`, `FATSECRET_CLIENT_ID`, `FATSECRET_CLIENT_SECRET`, `ANTHROPIC_API_KEY`. The model for AI estimates is chosen in the same place; the default has refusal fallbacks enabled, so a declined request is retried on Anthropic's default fallback model.

## Achievements

One engine (`js/achievements.js`) computes every badge from the same trusted, resolved days the charts read, so Today, the trophy room, the sidebar and rewards always agree. Unlocks are recalculated from data each time; the unlock date is the day the data first crossed the threshold, and a badge your history had already earned before tracking began says so instead of showing an invented date. The only thing stored is which unlocks you've already been shown.

Nothing rewards eating less: Nutrition Consistency counts complete food days *inside* your calorie range with protein hit; there are no low-calorie badges or streaks, and the weekly budget never suggests eating below your range to make up for a higher day. Apple Health's food and sleep can't reach any achievement because they never reach the day at all.

The catalog is data. New families that use an existing measurement (goal days, goal streaks, workouts of a type, summed fields like steps, progressive-overload increases, strength sessions) need no new code.

## Backups & rollback

Your log is backed up on its own — every 3 hours by default (changeable in **Settings → Backups & rollback**), every time the server starts (so before every update touches anything), and before anything that replaces data (erase, import, sorting older entries, a rollback). Unchanged data is never stored twice. Each backup can be rolled back to or downloaded, and rolling back first backs up the present, so it can be undone. Kept: everything from the last 2 days, the newest of each day for 30 days, one a week for 6 months, plus up to 30 you make yourself.

Backups hold your days, diary, lifts, saved foods, meals, rewards, goals, plan and achievement settings — not your password, upload tokens or lookup keys, so a rollback can never lock you out.

Each browser you use also keeps a recovery copy of your log. If the site ever comes back empty, every page offers to put back the server's latest backup or that copy.

### A copy in Google Sheets

Those backups live in the same database as your log, so for a copy that survives anything happening to the server, **Settings → Backups & rollback → Set up the Google Sheet copy** gives you a script to paste into a Google Sheet's Extensions → Apps Script (steps are on the page). Every night around 3am the sheet fetches your log through a read-only backup link and fills in readable tabs — **Days, Food diary, Lifts, Workouts, My foods, Meals, Settings** — plus the full backup of each of the last 7 days in hidden tabs. A failed night changes nothing, and the site never sends an empty log, so a good copy is never replaced by nothing. The site shows when the sheet last copied, and warns if it's been more than two days.

To put everything back: in the sheet, **Ash Health → Restore a backup to the website…**, pick the day, type the site's password. It works even on a brand-new, empty site (the password is the key, and the sheet's link is re-registered so its nightly copies carry on), and the site backs up what it has first, so a restore can be undone.

`npm test` includes a check that restarting the server on the same storage — which is what an update does — leaves every day, food, meal, reward and setting exactly as it was.

## Progress photos

Photos are shrunk to 1600 px and re-encoded in the browser, then the server checks each is a JPEG and strips every metadata segment (EXIF, including any GPS location, XMP, comments) before storing it in the database's `photos` table (or beside the data file locally). An image is only ever sent to a signed-in browser, with `Cache-Control: no-store`; there's no public link, and backup links can't reach photos. They're deliberately left out of the automatic snapshots, the Google Sheet copy and JSON exports (they'd make each one many megabytes) — so on Railway they're as durable as the Postgres database itself, and the way to keep a copy elsewhere is to save them one by one. They aren't encrypted separately from the rest of the database.

## Notifications

One service (`server/notify.mjs`) handles every notification; features and the rules in `server/notify-rules.mjs` report through `emit({ type, category, priority, key, fp, … })`. It dedupes (same key + same content = nothing new), applies cooldowns and minimum gaps, keeps one live notification per key, holds digest topics and anything past your daily limit for a daily/weekly digest, skips reminders in quiet hours, and removes reminders that no longer apply (log a meal and "log your meals" disappears). Rules run every five minutes and shortly after anything is logged, in your time zone (sent by your browser). On first run, anything already true (old PRs, milestones passed long ago) is recorded silently.

The bell in the sidebar opens the history; **Settings → Notifications** sets each topic to right away / daily digest / weekly digest / off, the optional reminders (meals, weigh-in, planned workout or rest day, bedtime — all off by default), quiet hours, digest time and daily limit. **Browser push** (Web Push: RFC 8291 encryption + RFC 8292 VAPID, checked against the RFC's worked example in tests) shows notifications while the site is closed, as long as the browser is running and you allowed it; on iPhone only for a home-screen web app. **Email isn't available** — there's no email service on the server.

## Deploy to Railway

1. **New Project → Deploy from GitHub repo →** `ashhealthtracker`. Railway reads `railway.json`: it runs `npm start` and health-checks `/healthz`.
2. **+ New → Database → PostgreSQL** in the same project. **Required:** Railway erases a service's own disk on every deploy, so without a database every update wipes your log. (A Railway volume works too; the server stores its file there automatically.)
3. In the web service's **Variables**, add just two:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_PASSWORD`: the password for your first sign-in
4. **Settings → Networking → Generate Domain.** Open it and sign in.
5. In the site's **Settings**: create an Apple Health upload token and copy the upload URL into your iPhone app. If you like, change the password there too; after that, `APP_PASSWORD` no longer signs in.

Optional: `USDA_API_KEY`, `ANTHROPIC_API_KEY`, `FATSECRET_CLIENT_ID` / `FATSECRET_CLIENT_SECRET` — or paste the same keys in **Settings → Food lookup**.

Nothing else needs Railway after that. The session-signing secret is generated and kept in the database. You can still set `SESSION_SECRET` or `INGEST_TOKEN` as variables if you prefer. On Railway, the site refuses to serve until a password exists. The server creates its tables on first start.

**Data disappearing after updates?** Your data is on Railway's temporary disk: the server log says so at start, and every page shows a red warning. Export from **Settings → Your data**, do step 2 and the `DATABASE_URL` variable above, then import the file.

**Locked out?** Add the variable `PASSWORD_RESET` = `1` and redeploy. The password set in Settings is cleared and `APP_PASSWORD` works again. Remove the variable afterwards.

## Layout

```
server.mjs        entry point: reads Railway's variables, picks Postgres or a local file
server/app.mjs    HTTP routes: login, the page's JSON API, /api/ingest, static files
server/apple.mjs  Apple Health payloads (Health Auto Export or plain JSON) → day fields
server/food.mjs   food lookup: USDA, FatSecret, Open Food Facts → ranked candidates, cached
server/ai.mjs     AI nutrition estimates (Claude), labelled as estimates
server/storage.mjs where the log lives, and whether it survives an update
server/backup.mjs  automatic backups, rollback, retention
server/sheet.mjs   your log as readable tables for the Google Sheet copy
server/notify.mjs  notifications: dedupe, cooldowns, digests, quiet hours, push
server/notify-rules.mjs  the rules that watch your data
server/webpush.mjs Web Push encryption and VAPID, no third-party code
js/energy.js      adaptive TDEE, weight trend, plateaus, calorie advice
js/energyview.js  the Weight page's Metabolism & energy balance card
js/liftstats.js   strength analysis: muscle groups, e1RM trends, double progression, index, weekly volume
js/strengthview.js the Fitness page's strength preservation, overload and volume cards
js/bodycomp.js    body fat from every reading with its error, fat / fat-free mass, tape changes vs noise, timelines
js/bodyview.js    the Weight page's body composition, measurements and progress photo cards and forms
server/photos.mjs progress photo checks and metadata stripping
js/profile.js     about you: resting energy and body-fat formulas
server/db.mjs     Postgres storage (days, meta, items, snapshots), or a JSON file without a DATABASE_URL
server/auth.mjs   password hashing, signed session cookies, upload tokens, login rate limit
index.html        shell: rail, log dialog, food sheet, panel dialog, tooltip
css/app.css       design tokens shared with Specular + every component
js/sources.js     which source each number may come from; the doors into each bucket
js/nutrition.js   the diary's arithmetic: parsing, serving scaling, day totals, the week's calories
js/library.js     saved foods, meals and rewards
js/training.js    training plan weeks and lifting volume / new bests
js/achievements.js the achievement engine: catalog, progress, unlock dates, next-unlock ranking
js/badges.js      badge artwork (SVG), one theme per family, detail by tier
js/metrics.js     pure calculations: goals, score, streaks, averages, weight progress
js/store.js       the page's API client, import checks, sample data
js/charts.js      SVG builders: rings, weight line, trend chart, sleep timeline, pacing, sparklines
js/views.js       one function per panel, and the pages built from them
js/diary.js       the Nutrition page's food panels
js/foodsheet.js   the add-food sheet: search, suggestions, editing, custom foods, meals
js/trophies.js    Next unlock, trophy room, badge details, rewards, the unlock moment
js/strength.js    the Strength card and the lift log (any day; moving or repeating a session)
js/supplements.js the supplement list, daily check-offs and the Supplements goal
js/recovery.js    this browser's recovery copy of your log
js/notifyview.js  the Notifications page and Settings → Notifications
js/sheetscript.js the Google Sheet's Apps Script (nightly copy, restore menu)
js/app.js         routing, measured chart mounting, tooltip, dialogs, settings
test/             node --test suites. On Postgres, one file at a time (they share the database):
                  TEST_DATABASE_URL=postgres://… node --test --test-concurrency=1 test/*.test.js
```
