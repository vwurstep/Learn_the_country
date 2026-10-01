// Run: node test/quiz.test.mjs   (no framework)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { MODES, pool, makeQuestion, makePileQuestion, distractors, weight } from '../src/quiz.js';
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

// pools
assert.equal(pool(countries, { region: 'Europe' }).every((c) => c.continent === 'Europe' && c.sovereign), true);
assert.ok(pool(countries, { territories: true }).length > pool(countries).length);

// questions
for (const mode of Object.keys(MODES)) {
  for (let i = 0; i < 200; i++) {
    const q = makeQuestion(mode, pool(countries), countries, { rng });
    assert.equal(q.type, MODES[q.mode].type);
    if (q.type !== 'choice') { assert.equal(q.options.length, 0); continue; }
    assert.equal(q.options.length, 4, mode);
    assert.equal(new Set(q.options.map((c) => c.id)).size, 4, 'distinct options');
    assert.ok(q.options.some((c) => c.id === q.target.id), 'target among options');
  }
}
// distractors prefer the same continent
const fr = countries.find((c) => c.id === 'fr');
assert.ok(distractors(fr, countries, 3, rng).every((c) => c.continent === 'Europe'));
// avoid list respected
const small = pool(countries, { region: 'Europe' });
const q = makeQuestion('flag-name', small, countries, { rng, avoid: small.slice(1).map((c) => c.id) });
assert.equal(q.target.id, small[0].id);
// weighting: missed countries weigh more than known ones
assert.ok(weight({ right: 0, wrong: 3, last: Date.now() }) > weight({ right: 5, wrong: 0, last: Date.now() }));

// hard pile: due cards first, nothing due -> early practice, unknown modes/ids ignored
const byId = new Map(countries.map((c) => [c.id, c]));
const now = Date.now();
const cards = { 'flag-name:fr': { box: 2, due: now + 1e9 }, 'map-name:de': { box: 0, due: now - 1 }, 'bogus:fr': { box: 0, due: 0 }, 'flag-name:zz': { box: 0, due: 0 } };
for (let i = 0; i < 20; i++) {
  const p = makePileQuestion(cards, byId, countries, { rng, now });
  assert.equal(p.mode + ':' + p.target.id, 'map-name:de');
  assert.equal(p.early, false);
}
const early = makePileQuestion({ 'name-flag:fr': { box: 1, due: now + 1e9 } }, byId, countries, { rng, now });
assert.ok(early.early && early.options.length === 4);
assert.equal(makePileQuestion({}, byId, countries, { rng }), null);

// store merge: newest wins, removals beat older cards, stats by last answer
const A = { stats: { fr: { right: 1, wrong: 0, last: 10 } }, hard: { 'a:fr': { box: 1, updated: 5 }, 'b:de': { box: 0, updated: 5 } }, removed: {} };
const B = { stats: { fr: { right: 2, wrong: 1, last: 20 } }, hard: { 'a:fr': { box: 3, updated: 9 } }, removed: { 'b:de': 7 } };
const M = merge(A, B);
assert.equal(M.stats.fr.right, 2);
assert.equal(M.hard['a:fr'].box, 3);
assert.ok(!M.hard['b:de']);
assert.ok(merge(B, { hard: { 'b:de': { box: 0, updated: 8 } } }).hard['b:de'], 're-added after removal survives');

console.log('quiz tests passed:', countries.length, 'countries');
