// Run: node test/quiz.test.mjs   (no framework)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { MODES, pool, makeDeck, makePileDeck, requeue, makeQuestion, distractors, MIN_GAP } from '../src/quiz.js';
import { merge } from '../src/store.js';

const countries = JSON.parse(readFileSync(new URL('../data/countries.json', import.meta.url)));
let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// data sanity
const ids = new Set(countries.map((c) => c.id));
assert.equal(ids.size, countries.length, 'ids unique');
for (const c of countries) {
  for (const k of ['id', 'name', 'capital', 'continent']) assert.ok(c[k], `${c.id} has ${k}`);
  assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180, `${c.id} coords`);
  assert.ok(existsSync(new URL(`../flags/${c.id}.svg`, import.meta.url)), `flag for ${c.id}`);
}
assert.ok(countries.filter((c) => c.sovereign).length >= 193, 'all UN members');

// pools: several continents combine, [] = whole world
assert.equal(pool(countries, { regions: ['Europe'] }).every((c) => c.continent === 'Europe' && c.sovereign), true);
const americas = pool(countries, { regions: ['North America', 'South America'] });
assert.equal(americas.length, pool(countries, { regions: ['North America'] }).length + pool(countries, { regions: ['South America'] }).length);
assert.equal(pool(countries, { regions: [] }).length, pool(countries).length);
assert.ok(pool(countries, { territories: true }).length > pool(countries).length);

// questions for every mode
const byId = new Map(countries.map((c) => [c.id, c]));
for (const mode of Object.keys(MODES).filter((m) => m !== 'mixed')) {
  for (const c of pool(countries).slice(0, 60)) {
    const q = makeQuestion({ id: c.id, mode }, byId, countries, rng);
    assert.equal(q.target.id, c.id);
    assert.equal(q.type, MODES[mode].type);
    if (q.type !== 'choice') { assert.equal(q.options.length, 0); continue; }
    assert.equal(q.options.length, 4, mode);
    assert.equal(new Set(q.options.map((o) => o.id)).size, 4, 'distinct options');
    assert.ok(q.options.some((o) => o.id === c.id), 'target among options');
  }
}
// distractors prefer the same continent
const fr = countries.find((c) => c.id === 'fr');
assert.ok(distractors(fr, countries, 3, rng).every((c) => c.continent === 'Europe'));

// decks: every country exactly once, order differs between rounds, mixed gives concrete modes
const europe = pool(countries, { regions: ['Europe'] });
const d1 = makeDeck('flag-name', europe, rng), d2 = makeDeck('flag-name', europe, rng);
assert.deepEqual(d1.map((x) => x.id).sort(), europe.map((c) => c.id).sort());
assert.notDeepEqual(d1.map((x) => x.id), d2.map((x) => x.id));
assert.ok(makeDeck('mixed', europe, rng).every((x) => MODES[x.mode] && x.mode !== 'mixed'));

// requeue: at least MIN_GAP others before the missed card; at the end when fewer are left
for (let i = 0; i < 500; i++) {
  const deck = d1.slice(0, 1 + Math.floor(rng() * 20));
  const item = { id: 'xx', mode: 'flag-name' };
  const out = requeue(deck, item, rng);
  const pos = out.indexOf(item);
  assert.equal(out.length, deck.length + 1);
  assert.ok(deck.length <= MIN_GAP ? pos === deck.length : pos >= MIN_GAP);
}
// a whole simulated round with random misses: no card twice unless missed, gap kept
{
  let deck = makeDeck('flag-name', europe, rng);
  const lastAsked = new Map(), missed = new Set();
  let t = 0;
  while (deck.length) {
    const [cur, ...rest] = deck;
    deck = rest;
    if (lastAsked.has(cur.id)) {
      assert.ok(missed.has(cur.id), `${cur.id} repeated without a miss`);
      assert.ok(t - lastAsked.get(cur.id) > MIN_GAP || deck.length < MIN_GAP, `${cur.id} came back too soon`);
    }
    lastAsked.set(cur.id, t++);
    missed.delete(cur.id);
    if (rng() < 0.3) { missed.add(cur.id); deck = requeue(deck, cur, rng); }
  }
  assert.equal(lastAsked.size, europe.length);
}

// hard pile deck: only due cards (in random order), all cards when none is due, junk ignored
const now = Date.now();
const cards = { 'flag-name:fr': { box: 2, due: now + 1e9 }, 'map-name:de': { box: 0, due: now - 1 }, 'shape-name:it': { box: 1, due: now - 5 }, 'bogus:fr': { box: 0, due: 0 }, 'flag-name:zz': { box: 0, due: 0 } };
const pd = makePileDeck(cards, byId, rng, now);
assert.deepEqual(pd.deck.map((x) => x.mode + ':' + x.id).sort(), ['map-name:de', 'shape-name:it']);
assert.equal(pd.early, false);
const pe = makePileDeck({ 'name-flag:fr': { box: 1, due: now + 1e9 } }, byId, rng, now);
assert.ok(pe.early && pe.deck.length === 1);
assert.equal(makePileDeck({}, byId, rng).deck.length, 0);

// store merge: newest wins, removals beat older cards, stats by last answer
const A = { stats: { fr: { right: 1, wrong: 0, last: 10 } }, hard: { 'a:fr': { box: 1, updated: 5 }, 'b:de': { box: 0, updated: 5 } }, removed: {} };
const B = { stats: { fr: { right: 2, wrong: 1, last: 20 } }, hard: { 'a:fr': { box: 3, updated: 9 } }, removed: { 'b:de': 7 } };
const M = merge(A, B);
assert.equal(M.stats.fr.right, 2);
assert.equal(M.hard['a:fr'].box, 3);
assert.ok(!M.hard['b:de']);
assert.ok(merge(B, { hard: { 'b:de': { box: 0, updated: 8 } } }).hard['b:de'], 're-added after removal survives');

console.log('quiz tests passed:', countries.length, 'countries');
