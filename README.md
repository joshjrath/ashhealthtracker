# Ash Health

A personal health dashboard in the same dark style as the Specular dashboard. It shows weight, nutrition, activity and sleep with health-specific charts instead of a generic calorie log.

A small Node server (one dependency, `pg`) serves the page behind a password, stores the log in Postgres, and takes Apple Health data from your iPhone at `/api/ingest`.

```sh
npm install
npm start        # http://localhost:5173: no password, log kept in data/local.json
npm test         # calculations, Apple Health parsing, and the server's auth and API
```

## What's on it

| Page | What it shows |
|---|---|
| **Today** | Goals hit as *5/8* (percentage second) with a **Finish today** list of what's left per goal · stat cards · calorie ring with the success zone · macros · today vs your 14-day average · week grid (hit / missed / no data / in progress) · streaks · **this week** review (biggest win, biggest gap, change vs last week) · **consistency** (last 7 / 30 / previous 30 days) · **insights** once there's enough history · goal journey · weekly weight |
| **Weight** | Daily weigh-ins with the 7-day average as the main line · 7-day average, 30-day change, lb/week and trend · an estimated goal date, only once the data supports one |
| **Nutrition** | Trends from your own logs only; averages use **complete** food days, partial days are drawn faintly and left out |
| **Fitness** | Active calories / exercise / steps rings · this week's workouts, minutes and calories · a week view of workouts as blocks by time of day · exercise per week · workout mix · six months of activity · recent workouts |
| **Sleep** | Bedtime → wake bars from your own logs, with your target window behind them, and average bedtime, wake, spread and nights on schedule |
| **Calendar** | Each day shaded by goals hit; days with no data look empty rather than failed. Click a day for everything logged that day and where each number came from. |
| **Settings** | Goals, Apple Health (sync status, upload tokens), data sources (and every field your phone has sent), dashboard defaults, password, backup, and the review of older entries |

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

**Missing is never zero.** Each goal is *hit*, *missed*, *no data* or (today) *in progress*. A hit is final as soon as it happens. A miss needs proof: a finished day, a complete food log, or a value that can't come back into range. Averages skip days without data and need at least 3 real observations. Adherence needs 10 judged goal-days. A goal date needs 14 weigh-ins over 3+ weeks and a real downward trend. Otherwise the page says "Not enough data yet".

## Deploy to Railway

1. **New Project → Deploy from GitHub repo →** `ashhealthtracker`. Railway reads `railway.json`: it runs `npm start` and health-checks `/healthz`.
2. **+ New → Database → PostgreSQL** in the same project.
3. In the web service's **Variables**, add just two:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_PASSWORD`: the password for your first sign-in
4. **Settings → Networking → Generate Domain.** Open it and sign in.
5. In the site's **Settings**: create an Apple Health upload token and copy the upload URL into your iPhone app. If you like, change the password there too; after that, `APP_PASSWORD` no longer signs in.

Nothing else needs Railway after that. The session-signing secret is generated and kept in the database. You can still set `SESSION_SECRET` or `INGEST_TOKEN` as variables if you prefer. On Railway, the site refuses to serve until a password exists. The server creates its tables on first start.

**Locked out?** Add the variable `PASSWORD_RESET` = `1` and redeploy. The password set in Settings is cleared and `APP_PASSWORD` works again. Remove the variable afterwards.

## Layout

```
server.mjs        entry point: reads Railway's variables, picks Postgres or a local file
server/app.mjs    HTTP routes: login, the page's JSON API, /api/ingest, static files
server/apple.mjs  Apple Health payloads (Health Auto Export or plain JSON) → day fields
server/db.mjs     Postgres storage, or data/local.json without a DATABASE_URL
server/auth.mjs   password hashing, signed session cookies, upload tokens, login rate limit
index.html        shell: rail, log dialog, tooltip
css/app.css       design tokens shared with Specular + every component
js/metrics.js     pure calculations: goals, score, streaks, averages, weight progress
js/store.js       the page's API client, import checks, sample data
js/charts.js      SVG builders: rings, weight line, trend chart, sleep timeline, sparklines
js/views.js       one function per panel, and the pages built from them
js/app.js         routing, measured chart mounting, tooltip, log dialog, settings
test/             node --test suites (set TEST_DATABASE_URL to run the server tests on Postgres)
```
