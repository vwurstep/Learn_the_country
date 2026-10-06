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
   - **Quiz:** questions in several modes (see below), filtered by region, with territories
     optional. Weak and unseen countries come up more often. A **hard pile** holds the
     cards Phil finds hard.
   - Round 2 (2026-10-01), Phil's feedback on the first version:
     - flags sit mid-country and capitals are dark blue dots;
     - name/capital answers are flashcards (reveal, then "knew it" / "didn't know");
     - after every answer Phil is offered "add to / remove from hard pile";
     - progress syncs to GitHub (token), like in the SA app;
     - each country has a summary on the map tab;
     - fixed the date-line seams on the globe.
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
  only where it doesn't overlap one already placed. Flags are placed first; capital dots
  then give way to flags until zoomed in. Names appear from zoom 2.6. On the
  globe, markers on the far side are removed.
- **Zooming to a country** (`flyToCountry`) uses the bbox of its main part plus parts
  chained within 20° (Corsica, Indonesia's islands), not the whole geometry. The full
  geometry of France or the Netherlands includes overseas territories.
- **Country colours = national colours** (2026-10-01, Phil's request; still being iterated).
  - `data/colors.json` gives `{id: {c, alt?, why}}`, chosen by a subagent. It is the colour
    the country identifies with (flag or sports colour).
  - Where an identity colour was weak, the agent picked one that differs from the
    neighbours. Debatable picks: Hungary green, Czechia blue, Brazil green, Germany black
    (shows as grey).
  - Drawn as a tint, mixed 50% with white (`TINT` in map.js). The two-colour stripes idea
    (`alt`) is on hold; it may look messy.
  - Quiz feedback recolours a country with feature-state `mark` (`sel`, `right`, `wrong`,
    `target`) and adds a bold outline (`mark-line`), so it stays visible on a similar
    national colour.
- **Flags hidden on the map tab = self-test:** only the capital dots remain, with no flags
  or names (`setMarkers(true, null, {dots: true})`). Tapping shows the blurred card.
- **Offline:** `sw.js` precaches everything on install: code, data and all flags (256
  files), with no external requests. The settings card (Quiz → Sync & offline…) asks the
  worker via `postMessage` (`offline-status` / `download`, reply on a MessageChannel) and
  shows "✓ Everything is on this phone". Tested with Chrome offline (Playwright
  `channel: 'chrome'`; WebKit in Playwright has no service workers).
- **iOS bottom gap** with the translucent status bar: `fitScreen()` in app.js, the same
  fix as in the SA app. The map extends by `--app-extra` = screen.height − innerHeight
  (standalone, portrait, ≤150 px). It is re-measured on resize, on load and when the app
  returns to the foreground; iOS sometimes reports late. It never shrinks within a session and
  only calls map.resize() on a real change. **Don't** listen to visualViewport resize and don't
  extend html/body: on 2026-10-05 that froze the map (map.resize() cancels gestures) and made
  the layout flip-flop (the reported height reacts to our own change). Phil confirmed it mostly works. If the gap comes back,
  the settings card shows the measured values (tiny grey line).
- **Map questions:** a tap counts if it lands on the target, within 10 px of its shape,
  or within 18 px of its capital. That makes microstates without a polygon answerable.
  Taps on the ocean are ignored.
- **Data kept separate from how it's shown** (as in the SA app):
  - `src/data.js` loads static data and per-device settings (`ltc.<setting>`);
  - `src/store.js` holds **user data**: one JSON doc in localStorage `ltc.user`,
    `{v, stats, hard, removed}`, merged per entry (the newest wins, with tombstones for removals);
  - `src/quiz.js` is pure question logic (testable, injectable RNG);
  - `src/map.js` is the map, and `src/app.js` the wiring and panels.
- **Sync is pluggable, ready for user accounts later:**
  - A backend is `{pull(), push(doc)}`. Today it is `src/sync-github.js`: the file `user.json` on
    branch `userdata` of this repo, written with a fine-grained token that Phil pastes into
    Quiz → Sync…. The token is stored in localStorage `ltc.sync`.
  - The repo is public, so the progress file is publicly readable. That's fine for quiz stats.
  - Accounts later: add a backend with the same two methods and pick it in `backend()` in app.js.
  - Sync runs on start, 5 s after a change, and when the app is hidden or shown.
  - On a conflict (409) it pulls, merges and retries.
  - To read Phil's data: `gh api 'repos/vwurstep/Learn_the_country/contents/user.json?ref=userdata' --jq .content | base64 -d`.
  - Never test against the real `userdata` branch. Use a throwaway branch and delete it.

## Quiz modes (`MODES` in src/quiz.js)

Each mode has a `type`:
- **recall** (flashcard): Flag → country, Capital → country, Country → capital, and
  **Map → country** (`shape-name`, ask `map`, added 2026-10-05). The country is highlighted
  and zoomed to with its neighbours around it; countries under 1 deg² or without a shape
  also get their capital dot. Show answer, then Phil rates himself.
- **choice**: Country → flag, with 4 flags. The wrong options are preferably from the same
  continent.
- **map**: Find the country / flag / capital on the map.
- **Mixed** picks a random mode for each question.

**Rounds (2026-10-06, Phil's request):** a session is a deck (`makeDeck` in quiz.js). Every
country of the pool comes up once, in a new random order each round. A miss (Didn't know,
wrong, Skip) goes back in at a random place with at least `MIN_GAP = 4` other questions
before it (`requeue`), or at the end if fewer are left. The round ends with a summary
(right first time, missed list). Random weighted picking is gone.
**Regions:** `settings.regions` lists continents, and several can be combined (`[]` = World;
the old single `region` setting is migrated). `flyToRegion` takes a list and aims at the
spherical mean of the continent views.

**Hard pile:** cards are keyed `mode:id` and use Leitner boxes. `BOX_DAYS = [0,1,3,7,21]`
days. Right moves a card up a box, wrong sends it back to box 0. Practice is a deck of the due cards
(`makePileDeck`); when nothing is due it practises all cards early. Cards leave
the pile only by hand.

## Deep dives: states and cantons (2026-10-06, option A Phil chose)

- **Countries:** US (50 states, no DC) and Switzerland (26 cantons, names in the local
  language: Genève, Ticino, Luzern…). Each has name, capital and flag only, without
  summaries (Phil's choice: "if I like it we'll add more").
- **Map tab:** a country that has subdivision data shows "Explore the states →" on its card.
  That switches the **scope**: the map shows that set, the other countries are dimmed
  (`dim` layer), and the "‹ World" bar (`#scope-bar`) goes back.
- **Quiz:** the setup has a "Learn" row (Countries / US states / Swiss cantons) that sets the
  same scope. Both tabs follow one scope (`settings.scope`). The mode labels and prompts
  swap "country" for the kind ("Flag → canton", "Which state is this?").
- **Data:** the index is `data/sub/index.json` (`{id, name, kind, kinds, label}`).
  - Items in `data/sub/<id>.json` (`{id: 'us-ca', name, capital, lat, lon, fx, fy, color,
    flag}`), shapes in `data/sub/<id>.geojson`, flags in `flags/sub/` (svg, or 240 px png
    for seal-heavy US flags).
  - Built by `tools/build_subdivisions.mjs`, sharing `tools/geo.mjs` with build_data.mjs.
  - Colours come from greedy graph colouring, so neighbours differ (4 colours suffice).
  - To add a country: extend `SETS` in that script.
- **Map code:** the "sets" in map.js are world + one per deep dive, each with its own markers,
  bboxes and source (`world` / `sub`); `useSet(id)` switches between them.
  - `flyToSet()` shows the core: places within 30° of the median, so the US view is the
    lower 48 without zooming out for Alaska and Hawaii.
  - `flyToSet({full: true})` is used for find-on-map questions, so the view doesn't hint
    at outliers.
  - Subdivision flags are drawn at 0.8× size.
  - World borders are drawn below the deep-dive layers, because the coarse 50m line
    crossed Thurgau.
- The hard pile and its counts are per scope (card ids `mode:us-ca`). The service worker
  precaches all deep-dive files.

## Data (`data/`, `flags/`)

- `data/countries.json`: `{id (iso2 lower), name, capital, lat, lon (capital), continent,
  sovereign}`. Six continents. Russia and Turkey count as Europe; the Caribbean and
  Central America as North America.
- `data/world.geojson`: Natural Earth 1:50m, `properties.id` = iso2.
- `flags/<id>.svg`: lipis/flag-icons 4x3 (MIT).
- `data/info.json`: country summaries `{id: {about, dates: [[year, event]], known: []}}`.
  Written by subagents (brief `tools/briefs/info.md`, batches `data/info/todo-N.json` →
  `part-N.json`) and merged by `node tools/merge_info.mjs`. They come from model
  knowledge without a QA pass yet. Agents flagged unsure details (e.g. exact years for
  small territories). If Phil reports an error, fix it in the part file and re-merge.
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
src/data.js             static data loading + per-device settings
src/store.js            user data (stats, hard pile), merge, sync driver
src/sync-github.js      GitHub sync backend
src/style.css
lib/maplibre-gl.*       vendored MapLibre GL JS (BSD-3)
data/, flags/           country data, shapes, flags
tools/build_data.*      rebuilds data/ and flags/;  tools/release.py stamps sw.js CACHE
test/quiz.test.mjs      node test/quiz.test.mjs
icons/                  app icons (icon-source.html → PNG via headless Chrome at 512, sips to resize)
```
