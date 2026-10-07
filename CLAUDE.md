# Learn the Country

Personal app for Phil to learn the **flags and capitals** of the world's countries. It runs
on his phone (iPhone), installed from GitHub Pages like `../Phils_2048` and
`../LP_South_Africa`.

## TODO (open)

- **User accounts** (Phil, 2026-10-07): progress lives only on the phone. The GitHub token
  sync UI was removed; `store.sync(backend)` and `sync-github.js` stay, so a real account
  backend (Firebase was suggested) can be plugged in later.

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
  chained within 15° (Corsica, Indonesia's islands; 20° pulled in South Africa's
  Prince Edward Islands), not the whole geometry. The full
  geometry of France or the Netherlands includes overseas territories.
- **Quiz mode = "You see → You find"** (2026-10-06): two columns of four buttons (flag /
  capital / country / map) with an arrow between them. Phil found two chip rows
  confusing. The 12 pairs are in `MODES` (old keys kept, `modeFor(ask, answer)`). Mixed
  was removed at Phil's request.
- **Setup card** (2026-10-07): no mode hints and no "per round"/"so far" text, just the count
  ("26 cantons"). The tabs sit above all cards (`#top` z-index 20), and cards stop below
  them; Phil couldn't get back to the map from the setup.
- **Camera insets:** `createMap({insets})` → app's `mapInsets()` reports the free screen area
  (below the tabs or the deep-dive bar, above the open card). `fitBox` fits the box with a 6%
  margin into it, with the zoom from Mercator maths (MapLibre's cameraForBounds threw on
  the globe). Show the card first, then fly (nextQuestion, answer).
- **Lakes and rivers** (2026-10-07): `data/water.geojson` (1.6 MB, Natural Earth 10m plus the
  Europe supplements, `tools/build_water.mjs`) has features `{k: lake|river, z, n}`.
  - The `lakes`/`rivers` layers show a feature from zoom `z` on (giants at 1, Lake Zurich
    and the Aare at 5, Thun/Zug/Reuss/Limmat at 6). Loaded after start.
  - Lakes are drawn above the land and above state shapes, but below Geneva's communes,
    which are clipped to land (`landOnly` in index.json).
  - The deep-dive `dim` layer is a mask polygon (world minus the set's outline, built with
    `outlineMask`), drawn above the water, so the neighbours' rivers are dimmed too. The
    parent's own world shape is painted grey (`DIMMED`), so no slivers show along the
    finer border.
- **Nested deep dive: Geneva's communes** (Phil's Easter egg for his mum, 2026-10-07): set
  `ch-ge` with `parent: 'ch'` and `parentItem: 'ch-ge'`.
  - The Geneva canton card in the CH deep dive shows "Explore the communes →", and the bar
    shows "‹ Switzerland".
  - 45 communes with their coats of arms (Wikidata P94) and BFS population 2025.
    swisstopo boundaries, with the Léman clipped out using the OSM lake polygon (ODbL).
  - Communes have no capital (`noCapital`): the capital facet is off, and the name sits
    under the coat of arms (`.cap.nameonly`).
- **Population** (2026-10-07): `pop` in countries.json comes from the World Bank SP.POP.TOTL
  latest year, with Wikidata for 21 territories (build_data.mjs).
  - The info card shows "Population: 68.7 million" (`formatPop`).
  - Two modes in a "Population" chip row under the see → find grid:
    - `pop-compare`: two places, tap the bigger one; the opponent is within a factor of
      1.15–6.
    - `pop-guess`: a log slider from 100 to 3 bn with −/+ (±5%) and ticks 1k…1B; right
      within ±50% (`GUESS_OK`).
  - Only shown where items have `pop`.
- **Learn picker:** a single button in the setup ("🇨🇭 Swiss cantons ›") opens `#learn`, a
  searchable list (World first, then deep dives grouped by the parent's continent, with
  counts). Phil plans about 11 deep dives, not 100.
- **Places without a flag** (`flag: null`): Chinese and South African provinces, Northern
  Ireland, maybe some French regions.
  - The local name is pinned instead (`.namepin`, e.g. 广东), and the info card shows it in
    the flag's place.
  - Flag questions are off when fewer than half of a set have flags (`flagsOk`).
  - Flagless items are left out of flag questions (`poolNow`).
- **Local names:** `local`/`capitalLocal` are shown as "Guangdong · 广东" (`nameOf`, `capOf`).
  China has characters at Phil's request; DE/AT/IT/FR have local spellings.
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
- **Offline:** `sw.js` precaches everything, including all deep dives, listed in `files.json`
  with a content hash per file. `tools/release.py` writes files.json.
  - **An update downloads only files whose hash changed** and copies the rest from the
    previous cache (tested: one changed flag means one download).
  - Always run release.py before pushing, or phones won't get the new files. The settings card (Quiz → Sync & offline…) asks the
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

- **Countries (11, 2026-10-06):**
  - US (50 states, no DC) and CH (26 cantons, names in the local language: Genève,
    Ticino, Luzern…).
  - DE 16, AT 9, IT 20, FR 18 (13 + 5 overseas), GB 4 nations (set id `gb`, matching the
    country id, otherwise the Explore link breaks).
  - CA 13, AU 8, ZA 9 (no flags), CN 31 (no flags, Chinese names).
  - Phil wants about this many, not 100. Name, capital and flag only, no summaries.
  - Builders: `tools/build_subdivisions.mjs` (US CH DE AT IT FR GB), `build_sub_cn.mjs`,
    `build_sub_ca_au_za.mjs`, `build_sub_ch_ge.mjs`. Each merges only its own entries into index.json.
    Simplification uses `npx mapshaper`.
  - Null flags: all of CN and ZA, Northern Ireland, Grand Est, Hauts-de-France,
    Guadeloupe and Réunion.
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
  - Views use `fitBox` (camera centred on the box, zoom from cameraForBounds), because
    MapLibre's fitBounds drifts on the globe away from the equator.
  - `flyToSet()` shows the core: places within 30° of the median, so the US view is the
    lower 48 without zooming out for Alaska and Hawaii.
  - `flyToSet({full: true})` is used for find-on-map questions, so the view doesn't hint
    at outliers.
  - Subdivision flags are drawn at 0.8× size.
  - World borders are drawn below the deep-dive layers, because the coarse 50m line
    crossed Thurgau.
  - The parent's own world shape is covered fully by the `dim` layer, so its 50m outline
    doesn't leave national-colour slivers along the finer 10m border.
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
