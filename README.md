# Ash Health

A personal health dashboard in the same dark style as the Specular dashboard. It shows weight, nutrition, activity and sleep with health-specific charts instead of a generic calorie log.

A small Node server (one dependency, `pg`) serves the page behind a password, stores the log in Postgres, and takes Apple Health data from your iPhone at `/api/ingest`.

```sh
npm install
npm start        # http://localhost:5173: no password, log kept in data/local.json
npm test         # calculations, Apple Health parsing, and the server's auth and API
```

## What's on it

| Page | Visualizers |
|---|---|
| **Today** | Daily score with the goals behind it · stat cards (weight, calories, protein, steps, sleep, workout, creatine) · calorie ring with the 1,900–2,100 success zone · macro rings with protein as the primary macro · calorie composition bar · today vs 14-day average · week-at-a-glance heatmap · streaks with best streak alongside · goal journey · weekly weight trend · steps ring with a 7-day bar chart · sleep timeline |
| **Weight** | Weight journey: daily weigh-ins, 7-day average and the goal line, with 30D / 90D / All ranges · goal journey · weekly trend |
| **Nutrition** | Calorie ring, macros, today vs average · 7D / 30D / 90D trends for calories, protein, carbs, fat and fiber against their targets |
| **Activity & sleep** | Steps · bedtime-to-wake timeline for 7 or 14 nights with average bedtime, wake time and bedtime spread · heatmap and streaks |
| **Calendar** | Month grid. Each day shows kcal, protein, steps, weight and a goal count, and is shaded by how many goals it hit. Click a day to edit it. |
| **Settings** | Laid out like a phone's Settings: goals, Apple Health (sync status, upload URL, upload tokens), dashboard defaults, password and sign-out, and backup/import/erase. Anything that used to mean editing Railway variables is here. |

The daily score is simply the number of tracked goals met, never an invented health metric. The goal list sits right under the percentage.

## Apple Health / Apple Watch

Apple Health has no web API; the data only leaves the iPhone when an app there sends it. Your Watch writes to Health on the phone, and one of these posts it to `https://<your-site>/api/ingest` with the header `Authorization: Bearer <token>`. Create the token in **Settings → Apple Health**. Give each app its own token so any one can be renamed, replaced or revoked there without touching the others. (An `INGEST_TOKEN` variable also works, as a fallback.)

- **Health Auto Export – JSON+CSV** (recommended). Use a REST API automation in JSON format, with Aggregate data on and Summarize by Day. Pick Step Count, Weight & Body Mass, Dietary Energy, Protein, Carbohydrates, Total Fat, Fiber and Sleep Analysis, and add a Workouts automation too. Run it hourly over the last 7 days, and do one manual export over a long range to backfill.
- **An iOS Shortcut** (free). Post `{ "date": "2026-09-27", "steps": 11240, "weight": 162.8, "sleepMins": 450, "workout": true }`. Any of `weight kcal protein carbs fat fiber steps bed wake sleepMins workout creatine` works.

Each sync merges field by field. Apple's numbers replace that day's copy of the same fields, and anything Apple doesn't send (creatine, hand-typed notes) stays. Calories and macros only arrive if your food app (MyFitnessPal, Lose It!, Cronometer…) writes them to Apple Health. Settings shows when the last sync landed and which token sent it.

Sleep belongs to the morning you woke up. For Sunday's entry, the bedtime is Saturday night. When Apple sends measured time asleep, that is used instead of bedtime → wake.

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
