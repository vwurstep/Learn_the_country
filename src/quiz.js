/* Quiz logic: pure functions, no DOM, no map. A question is
   {mode, target (country), ask: 'flag'|'name'|'capital'|'map' (country highlighted), answer: 'flag'|'name'|'capital'|'map',
    type: 'recall'|'choice'|'map', options: [country, ...] (only for 'choice')}.
   recall = flashcard: the answer is revealed and Phil says himself whether he knew it.
   Randomness goes through `rng` so tests can seed it. */

// Every mode is a pair: what is shown (ask) and what is asked for (answer). The setup picks
// the two separately; the key names predate that (kept: hard-pile cards and stats use them).
// type: recall = flashcard (reveal, rate yourself), choice = pick one of 4 flags, map = tap it.
export const MODES = {
  'flag-name':      { label: 'Flag → country',    ask: 'flag',    answer: 'name',    type: 'recall' },
  'flag-capital':   { label: 'Flag → capital',    ask: 'flag',    answer: 'capital', type: 'recall' },
  'map-flag':       { label: 'Find the flag',     ask: 'flag',    answer: 'map',     type: 'map' },
  'name-flag':      { label: 'Country → flag',    ask: 'name',    answer: 'flag',    type: 'choice' },
  'name-capital':   { label: 'Country → capital', ask: 'name',    answer: 'capital', type: 'recall' },
  'map-name':       { label: 'Find the country',  ask: 'name',    answer: 'map',     type: 'map' },
  'capital-flag':   { label: 'Capital → flag',    ask: 'capital', answer: 'flag',    type: 'choice' },
  'capital-name':   { label: 'Capital → country', ask: 'capital', answer: 'name',    type: 'recall' },
  'map-capital':    { label: 'Find the capital',  ask: 'capital', answer: 'map',     type: 'map' },
  'shape-flag':     { label: 'Map → flag',        ask: 'map',     answer: 'flag',    type: 'choice' },
  'shape-name':     { label: 'Map → country',     ask: 'map',     answer: 'name',    type: 'recall' },
  'shape-capital':  { label: 'Map → capital',     ask: 'map',     answer: 'capital', type: 'recall' },
  // population (only where items have `pop`): not part of the see → find grid
  'pop-compare':    { label: 'Which is bigger?',  ask: 'pop',     answer: 'compare', type: 'compare' },
  'pop-guess':      { label: 'Guess the population', ask: 'pop',  answer: 'estimate', type: 'estimate' },
};

/** The mode for a (shown, asked-for) pair, e.g. modeFor('flag', 'capital') = 'flag-capital'. */
export const modeFor = (ask, answer) => Object.keys(MODES).find((k) => MODES[k].ask === ask && MODES[k].answer === answer);

/** Countries in the chosen pool. regions: continents to include ([] = the whole world);
    territories: include non-sovereign ones. */
export function pool(countries, { regions = [], territories = false } = {}) {
  return countries.filter((c) => (!regions.length || regions.includes(c.continent)) && (territories || c.sovereign));
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

// ---- sessions: a deck in random order, no repeats except for missed cards ------------------
// A deck item is {id, mode}. The next question is always deck[0].

/** Questions needed between a miss and seeing that card again. */
export const MIN_GAP = 4;

/** Every country of the pool once, in a new random order. */
export function makeDeck(mode, countries, rng = Math.random) {
  return shuffle(countries, rng).map((c) => ({ id: c.id, mode }));
}

/** The hard pile as a deck: the due cards in random order (all cards if none is due). */
export function makePileDeck(cards, byId, rng = Math.random, now = Date.now()) {
  const items = Object.keys(cards).map((k) => { const i = k.lastIndexOf(':'); return { key: k, id: k.slice(i + 1), mode: k.slice(0, i) }; })
    .filter((x) => byId.has(x.id) && MODES[x.mode]);
  const due = items.filter((x) => cards[x.key].due <= now);
  const from = due.length ? due : items;
  return { deck: shuffle(from, rng).map(({ id, mode }) => ({ id, mode })), early: !due.length && items.length > 0 };
}

/** Put a missed item back at a random place with at least `gap` other questions before it
    (at the end if fewer are left). */
export function requeue(deck, item, rng = Math.random, gap = MIN_GAP) {
  const pos = deck.length <= gap ? deck.length : gap + Math.floor(rng() * (deck.length - gap + 1));
  return [...deck.slice(0, pos), item, ...deck.slice(pos)];
}

/** The question for a deck item. `all` = countries to draw wrong options from. */
export function makeQuestion(item, byId, all, rng = Math.random, nOptions = 4) {
  const target = byId.get(item.id);
  const { ask, answer, type } = MODES[item.mode];
  const options = type === 'choice' ? shuffle([target, ...distractors(target, all, nOptions - 1, rng)], rng)
    : type === 'compare' ? shuffle([target, opponent(target, all, rng)], rng) : [];
  return { mode: item.mode, target, ask, answer, type, options };
}

// ---- population ---------------------------------------------------------------------------
/** A country to compare with: populations a bit apart (factor 1.15–6) so it's neither a coin
    toss nor obvious; anything else if there is no such one. */
export function opponent(target, all, rng = Math.random) {
  const others = all.filter((c) => c.id !== target.id && c.pop);
  const d = (c) => Math.abs(Math.log10(c.pop / target.pop));
  const fair = others.filter((c) => d(c) >= 0.06 && d(c) <= 0.78);
  const from = fair.length ? fair : others;
  return from[Math.floor(rng() * from.length)];
}

/** How far a guess is off: the factor between guess and truth (1 = exact, 2 = half or double). */
export const offBy = (guess, truth) => Math.max(guess / truth, truth / guess);
/** A guess counts as right within ±50% (factor 1.5). */
export const GUESS_OK = 1.5;
