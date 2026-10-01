// Run: node test/quiz.test.mjs   (no framework)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { MODES, pool, makeQuestion, distractors, weight } from '../src/quiz.js';

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
    if (q.answer === 'map') { assert.equal(q.options.length, 0); continue; }
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

console.log('quiz tests passed:', countries.length, 'countries');
