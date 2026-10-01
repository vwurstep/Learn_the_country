/* Quiz logic: pure functions, no DOM, no map. A question is
   {mode, target (country), ask: 'flag'|'name'|'capital', answer: 'flag'|'name'|'capital'|'map',
    options: [country, ...] (for multiple choice; empty for 'map')}.
   Randomness goes through `rng` so tests can seed it. */

export const MODES = {
  'flag-name':      { label: 'Flag → country',    ask: 'flag',    answer: 'name' },
  'name-flag':      { label: 'Country → flag',    ask: 'name',    answer: 'flag' },
  'capital-name':   { label: 'Capital → country', ask: 'capital', answer: 'name' },
  'name-capital':   { label: 'Country → capital', ask: 'name',    answer: 'capital' },
  'map-name':       { label: 'Find the country',  ask: 'name',    answer: 'map' },
  'map-flag':       { label: 'Find the flag',     ask: 'flag',    answer: 'map' },
  'map-capital':    { label: 'Find the capital',  ask: 'capital', answer: 'map' },
  'mixed':          { label: 'Mixed',             ask: null,      answer: null },
};

/** Countries in the chosen pool. region: 'World' or a continent; territories: include non-sovereign. */
export function pool(countries, { region = 'World', territories = false } = {}) {
  return countries.filter((c) => (region === 'World' || c.continent === region) && (territories || c.sovereign));
}

/** Weight for picking a country: unseen and often-missed countries come up more. */
export function weight(s, now = Date.now()) {
  if (!s) return 3;
  const total = s.right + s.wrong;
  const missRate = (s.wrong + 1) / (total + 2);
  const hours = (now - s.last) / 3.6e6;
  return 0.3 + 4 * missRate + Math.min(hours / 24, 1);
}

function pickWeighted(items, weights, rng) {
  let sum = 0;
  for (const w of weights) sum += w;
  let r = rng() * sum;
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
  return items[items.length - 1];
}

export function shuffle(a, rng) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Wrong options: preferably from the same continent (harder and more useful), never with a
    duplicate capital/name to the target. */
export function distractors(target, all, n, rng) {
  const ok = (c) => c.id !== target.id && c.capital !== target.capital && c.name !== target.name;
  const near = shuffle(all.filter((c) => ok(c) && c.continent === target.continent), rng);
  const far = shuffle(all.filter((c) => ok(c) && c.continent !== target.continent), rng);
  return [...near, ...far].slice(0, n);
}

/**
 * Next question. `countries` is the pool to ask from; `all` the full list (for distractors);
 * `stats` from data.js; `avoid` = recent target ids not to repeat; `hasShape(id)` tells whether a
 * country is drawn on the map (map questions about microstates still work via the capital dot).
 */
export function makeQuestion(mode, countries, all, { stats = {}, avoid = [], rng = Math.random, nOptions = 4 } = {}) {
  if (mode === 'mixed') {
    const modes = Object.keys(MODES).filter((m) => m !== 'mixed');
    mode = modes[Math.floor(rng() * modes.length)];
  }
  const { ask, answer } = MODES[mode];
  let cands = countries.filter((c) => !avoid.includes(c.id));
  if (!cands.length) cands = countries;
  const now = Date.now();
  const target = pickWeighted(cands, cands.map((c) => weight(stats[c.id], now)), rng);
  const options = answer === 'map' ? [] : shuffle([target, ...distractors(target, all, nOptions - 1, rng)], rng);
  return { mode, target, ask, answer, options };
}
