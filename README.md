# Ash Health

A personal health dashboard in the same dark style as the Specular dashboard. It shows weight, nutrition, activity and sleep with health-specific charts instead of a generic calorie log.

Plain HTML, CSS and ES modules, with no build step and no dependencies.

```sh
npm start        # http://localhost:5173
npm test         # unit tests for every calculation behind the charts
```

Any static host works (GitHub Pages, Netlify, `python3 -m http.server`). The page loads ES modules, so it has to be served over HTTP; opening `index.html` from disk won't work.

## What's on it

| Page | Visualizers |
|---|---|
| **Today** | Daily score with the goals behind it · stat cards (weight, calories, protein, steps, sleep, workout, creatine) · calorie ring with the 1,900–2,100 success zone · macro rings with protein as the primary macro · calorie composition bar · today vs 14-day average · week-at-a-glance heatmap · streaks with best streak alongside · goal journey · weekly weight trend · steps ring with a 7-day bar chart · sleep timeline |
| **Weight** | Weight journey: daily weigh-ins, 7-day average and the goal line, with 30D / 90D / All ranges · goal journey · weekly trend |
| **Nutrition** | Calorie ring, macros, today vs average · 7D / 30D / 90D trends for calories, protein, carbs, fat and fiber against their targets |
| **Activity & sleep** | Steps · bedtime-to-wake timeline for 7 or 14 nights with average bedtime, wake time and bedtime spread · heatmap and streaks |
| **Calendar** | Month grid. Each day shows kcal, protein, steps, weight and a goal count, and is shaded by how many goals it hit. Click a day to edit it. |
| **Goals & data** | Every target, which goals count toward the daily score, and JSON export, import and erase |

The daily score is simply the number of tracked goals met, never an invented health metric. The goal list sits right under the percentage.

## Data

Everything is stored in this browser's `localStorage`. The first visit is seeded with four months of sample days so the charts have something to draw. The banner (or Goals & data) clears the samples and keeps your goals. Use **Export JSON** to back up your log or move it to another device.

Sleep belongs to the morning you woke up. For Sunday's entry, the bedtime is Saturday night.

## Layout

```
index.html        shell: rail, log dialog, tooltip
css/app.css       design tokens shared with Specular + every component
js/metrics.js     pure calculations: goals, score, streaks, averages, weight progress
js/store.js       localStorage, import/export, sample data
js/charts.js      SVG builders: rings, weight line, trend chart, sleep timeline, sparklines
js/views.js       one function per panel, and the pages built from them
js/app.js         routing, measured chart mounting, tooltip, log dialog, settings
test/             node --test suite for metrics.js and the sample data
```
