# Learn the Country

Personal app for Phil to learn the **flags and capitals** of the world's countries. It runs
on his phone (iPhone), installed from GitHub Pages like `../Phils_2048` and
`../LP_South_Africa`.

## Goal and phases

1. **Prototype (now, started 2026-10-01):** two tabs.
   - **Map:** a plain political world map (country shapes only, no roads or tile server).
     Tapping a country shows its flag, name and capital. A toggle shows every capital on
     the map as a dot with its flag and name. The toggle can hide them so Phil can test
     himself: with flags hidden, tapping a country shows a blurred card with a Reveal
     button.
   - **Quiz:** flashcard-style questions in several modes (see below), filtered by region,
     with territories optional. Weak and unseen countries come up more often.
2. **Later (ideas, not decided):** shaded-relief background (Natural Earth raster), more
   quiz modes (type the answer, borders/neighbours, time attack), per-mode statistics,
   spaced repetition, more panels.

## Decisions (and why)

- **PWA on GitHub Pages**, the same setup as the sibling projects: plain HTML/CSS/JS
  (ES modules), no build step, no framework. "Add to Home Screen" in iOS Safari. A
  service worker (`sw.js`) precaches the app, the data and every flag, so it works
  offline.
- **Map: MapLibre GL (vendored in `lib/`) with only our own GeoJSON.** The style is built
  inline in `src/map.js`: an ocean background plus country fills and borders. No tiles, no
  glyph server. That's why capital names and flags are **HTML markers**, not symbol
  layers. Globe projection by default, with a toggle to the flat (Mercator) map. Rotation
  is turned off.
- **Decluttering:** `layout()` in map.js runs on every move and handles markers greedily.
  Sovereign states come first, then bigger countries (bbox area). A flag or name is shown
  only where it doesn't overlap one already placed. Names appear from zoom 2.6. On the
  globe, markers on the far side are removed.
- **Country colours** come from a hash of the id, so neighbours can share a colour. Quiz
  feedback recolours a country with feature-state `mark`: `sel`, `right`, `wrong` or
  `target`.
- **Map questions:** a tap counts if it lands on the target, within 10 px of its shape,
  or within 18 px of its capital. That makes microstates without a polygon answerable.
  Taps on the ocean are ignored.
- **Data kept separate from how it's shown** (as in the SA app): `src/data.js` handles
  loading and progress (localStorage `ltc.*`), `src/quiz.js` is pure question logic
  (testable, injectable RNG), `src/map.js` is the map, `src/app.js` the wiring and panels.

## Quiz modes (`MODES` in src/quiz.js)

Flag → country, Country → flag, Capital → country, Country → capital (4 options each;
the wrong options are preferably from the same continent), Find the country / flag /
capital on the map, and Mixed. Progress is `ltc.stats = {id: {right, wrong, last}}`. The
picking weight is `0.3 + 4·missRate + min(daysSinceSeen, 1)`, and unseen countries get 3.

## Data (`data/`, `flags/`)

- `data/countries.json`: `{id (iso2 lower), name, capital, lat, lon (capital), continent,
  sovereign}`. Six continents. Russia and Turkey count as Europe; the Caribbean and
  Central America as North America.
- `data/world.geojson`: Natural Earth 1:50m, `properties.id` = iso2.
- `flags/<id>.svg`: lipis/flag-icons 4x3 (MIT).
- Built by `tools/build_data.*`. Sources and licences are in `LICENSES.md`.

## Working style for Claude

- Same as the sibling projects. The main session orchestrates, and substantial
  programming or data work goes to subagents (`fable`) with tight briefs. Be economical
  with tokens and post short progress notes.
- **Before pushing:** `node test/quiz.test.mjs`, a visual check (Playwright WebKit or
  headless Chrome; the claude-in-chrome skill doesn't work here), then
  `python3 tools/release.py` so phones pick up the new files.

## Layout

```
index.html              page: map, tabs, info card, quiz setup + question cards
src/app.js              wiring, tabs, panels
src/map.js              MapLibre map, capital markers, declutter, hit testing
src/quiz.js             pure quiz logic (modes, pools, weighting, distractors)
src/data.js             data loading + progress/settings in localStorage
src/style.css
lib/maplibre-gl.*       vendored MapLibre GL JS (BSD-3)
data/, flags/           country data, shapes, flags
tools/build_data.*      rebuilds data/ and flags/;  tools/release.py stamps sw.js CACHE
test/quiz.test.mjs      node test/quiz.test.mjs
icons/                  app icons (icon-source.html → PNG via headless Chrome at 512, sips to resize)
```
