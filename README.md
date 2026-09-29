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
| **Today** | Goals hit as *5/8* (percentage second) with a **Finish today** list of what's left per goal · **Next unlock** (the one achievement realistically closest, with its reward) · stat cards · calorie ring with the success zone · macros · today vs your 14-day average · week grid (hit / missed / no data / in progress) · streaks · **this week** review (biggest win, biggest gap, change vs last week) · **consistency** (last 7 / 30 / previous 30 days) · **insights** once there's enough history · goal journey · weekly weight |
| **Weight** | Daily weigh-ins with the 7-day average as the main line · 7-day average, 30-day change, lb/week and trend · an estimated goal date, only once the data supports one |
| **Nutrition** | The **food diary** (breakfast / lunch / dinner / snacks, fast search-or-describe entry, every entry editable) · daily summary as *current / target — remaining* · **weekly calories** (weekly target, logged, target remaining, average available per remaining day, pacing chart) · trends from **complete** food days · food history meal by meal · **My foods** (recent, favorites, frequent, custom, meals) |
| **Fitness** | Active calories / exercise / steps rings · this week's workouts, minutes and calories · **Strength**: the week against your training plan, sets you log, volume and new bests · a week view of workouts as blocks by time of day · exercise per week · workout mix · six months of activity · recent workouts |
| **Sleep** | Bedtime → wake bars from your own logs, with your target window behind them, and average bedtime, wake, spread and nights on schedule |
| **Calendar** | Each day shaded by goals hit; days with no data look empty rather than failed. Click a day for everything logged that day and where each number came from. |
| **Achievements** | The trophy room: 5 badge families × 5 tiers (Weight Loss, Iron, Training Consistency, Nutrition Consistency, Complete Days), progress toward each, unlock dates (or "earned historically" when the date can't be known), what's up next and why, and **rewards you choose** — upcoming, ready to claim, claimed |
| **Settings** | Goals (incl. weekly calories and estimated maintenance), Apple Health (sync status, upload tokens), data sources, **food lookup** keys, **training plan**, **achievement tiers**, dashboard defaults, password, backup, and the review of older entries |

## Where each number comes from

Every stored day keeps each source in its own bucket, `{ manual, apple, legacy }`, and `js/sources.js` decides which buckets each metric may read:

| Metric | Source |
|---|---|
| Calories, protein, carbs, fat, fiber | **Manual only** |
| Sleep (bedtime → wake) | **Manual only** |
| Creatine | Manual only |
| Steps, active calories, exercise minutes | Apple Health, or a value you type (yours wins that day) |
| Workouts | Apple Health's workouts, or your "worked out" tick |
| Weight | A weigh-in you type, else Apple Health's |

Apple Health can't reach a manual-only metric: `/api/ingest` drops food and sleep before anything is stored, and the Apple bucket only accepts the fields above. Days saved before this existed were moved to `legacy` and their food and sleep are left out of every number until you sort them in **Settings → Review older entries**.

Food is itemised in the diary (`manual.foods`, each entry with its numbers frozen at the amount you logged and where they came from). Older days keep their typed totals as a "quick add"; a day's food is the two added together. Lifts live in `manual.lifts`. Neither can arrive from Apple Health.

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

Every result opens editable before anything is saved. Searches are cached for two weeks and any food you log is kept in My foods, so repeat foods need no lookup. Keys are set in **Settings → Food lookup** (stored in the database, never shown in full) or as the optional variables `USDA_API_KEY`, `FATSECRET_CLIENT_ID`, `FATSECRET_CLIENT_SECRET`, `ANTHROPIC_API_KEY`. AI estimates use Claude Opus 5.5 by default with refusal fallbacks enabled, so a declined request is retried on Anthropic's default fallback model.

## Achievements

One engine (`js/achievements.js`) computes every badge from the same trusted, resolved days the charts read, so Today, the trophy room, the sidebar and rewards always agree. Unlocks are recalculated from data each time; the unlock date is the day the data first crossed the threshold, and a badge your history had already earned before tracking began says so instead of showing an invented date. The only thing stored is which unlocks you've already been shown.

Nothing rewards eating less: Nutrition Consistency counts complete food days *inside* your calorie range with protein hit; there are no low-calorie badges or streaks, and the weekly budget never suggests eating below your range to make up for a higher day. Apple Health's food and sleep can't reach any achievement because they never reach the day at all.

The catalog is data. New families that use an existing measurement (goal days, goal streaks, workouts of a type, summed fields like steps, progressive-overload increases, strength sessions) need no new code.

## Deploy to Railway

1. **New Project → Deploy from GitHub repo →** `ashhealthtracker`. Railway reads `railway.json`: it runs `npm start` and health-checks `/healthz`.
2. **+ New → Database → PostgreSQL** in the same project.
3. In the web service's **Variables**, add just two:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_PASSWORD`: the password for your first sign-in
4. **Settings → Networking → Generate Domain.** Open it and sign in.
5. In the site's **Settings**: create an Apple Health upload token and copy the upload URL into your iPhone app. If you like, change the password there too; after that, `APP_PASSWORD` no longer signs in.

Optional: `USDA_API_KEY`, `ANTHROPIC_API_KEY`, `FATSECRET_CLIENT_ID` / `FATSECRET_CLIENT_SECRET` — or paste the same keys in **Settings → Food lookup**.

Nothing else needs Railway after that. The session-signing secret is generated and kept in the database. You can still set `SESSION_SECRET` or `INGEST_TOKEN` as variables if you prefer. On Railway, the site refuses to serve until a password exists. The server creates its tables on first start.

**Locked out?** Add the variable `PASSWORD_RESET` = `1` and redeploy. The password set in Settings is cleared and `APP_PASSWORD` works again. Remove the variable afterwards.

## Layout

```
server.mjs        entry point: reads Railway's variables, picks Postgres or a local file
server/app.mjs    HTTP routes: login, the page's JSON API, /api/ingest, static files
server/apple.mjs  Apple Health payloads (Health Auto Export or plain JSON) → day fields
server/food.mjs   food lookup: USDA, FatSecret, Open Food Facts → ranked candidates, cached
server/ai.mjs     AI nutrition estimates (Claude), labelled as estimates
server/db.mjs     Postgres storage (days, meta, items), or data/local.json without a DATABASE_URL
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
js/strength.js    the Strength card and the lift log
js/app.js         routing, measured chart mounting, tooltip, dialogs, settings
test/             node --test suites. On Postgres, one file at a time (they share the database):
                  TEST_DATABASE_URL=postgres://… node --test --test-concurrency=1 test/*.test.js
```
