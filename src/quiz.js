/* Quiz logic: pure functions, no DOM, no map. A question is
   {mode, target (country), ask: 'flag'|'name'|'capital', answer: 'flag'|'name'|'capital'|'map',
    type: 'recall'|'choice'|'map', options: [country, ...] (only for 'choice')}.
   recall = flashcard: the answer is revealed and Phil says himself whether he knew it.
   Randomness goes through `rng` so tests can seed it. */

export const MODES = {
  'flag-name':      { label: 'Flag → country',    ask: 'flag',    answer: 'name',    type: 'recall' },
  'name-flag':      { label: 'Country → flag',    ask: 'name',    answer: 'flag',    type: 'choice' },
  'capital-name':   { label: 'Capital → country', ask: 'capital', answer: 'name',    type: 'recall' },
  'name-capital':   { label: 'Country → capital', ask: 'name',    answer: 'capital', type: 'recall' },
  'map-name':       { label: 'Find the country',  ask: 'name',    answer: 'map',     type: 'map' },
  'map-flag':       { label: 'Find the flag',     ask: 'flag',    answer: 'map',     type: 'map' },
  'map-capital':    { label: 'Find the capital',  ask: 'capital', answer: 'map',     type: 'map' },
  'mixed':          { label: 'Mixed',             ask: null,      answer: null,      type: null },
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
 * `stats` from store.js; `avoid` = recent target ids not to repeat.
 */
export function makeQuestion(mode, countries, all, { stats = {}, avoid = [], rng = Math.random, nOptions = 4 } = {}) {
  if (mode === 'mixed') {
    const modes = Object.keys(MODES).filter((m) => m !== 'mixed');
    mode = modes[Math.floor(rng() * modes.length)];
  }
  let cands = countries.filter((c) => !avoid.includes(c.id));
  if (!cands.length) cands = countries;
  const now = Date.now();
  const target = pickWeighted(cands, cands.map((c) => weight(stats[c.id], now)), rng);
  return build(mode, target, all, rng, nOptions);
}

function build(mode, target, all, rng, nOptions = 4) {
  const { ask, answer, type } = MODES[mode];
  const options = type === 'choice' ? shuffle([target, ...distractors(target, all, nOptions - 1, rng)], rng) : [];
  return { mode, target, ask, answer, type, options };
}

/**
 * Next question from the hard pile. `cards` = {key: {box, due}} with key "mode:id"; due cards
 * come first (lower box = more likely); when nothing is due, any card may come ("practising
 * early"). Returns null for an empty pile.
 */
export function makePileQuestion(cards, byId, all, { avoid = [], rng = Math.random, now = Date.now() } = {}) {
  let keys = Object.keys(cards).filter((k) => byId.has(k.slice(k.lastIndexOf(':') + 1)) && MODES[k.slice(0, k.lastIndexOf(':'))]);
  if (!keys.length) return null;
  const fresh = keys.filter((k) => !avoid.includes(k));
  if (fresh.length) keys = fresh;
  const due = keys.filter((k) => cards[k].due <= now);
  const from = due.length ? due : keys;
  const key = pickWeighted(from, from.map((k) => 1 / (1 + cards[k].box)), rng);
  const i = key.lastIndexOf(':');
  return { ...build(key.slice(0, i), byId.get(key.slice(i + 1)), all, rng), early: !due.length };
}
