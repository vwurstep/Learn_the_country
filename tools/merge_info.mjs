// Merge the subagents' summary batches data/info/part-*.json into data/info.json.
// Checks that every country in countries.json has an entry with all fields.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const dir = new URL('../data/', import.meta.url);
const countries = JSON.parse(readFileSync(new URL('countries.json', dir)));
const all = {};
for (const f of readdirSync(new URL('info/', dir)).filter((f) => /^part-\d+\.json$/.test(f)).sort())
  Object.assign(all, JSON.parse(readFileSync(new URL('info/' + f, dir))));
const missing = countries.filter((c) => !all[c.id]?.about || !all[c.id]?.dates || !all[c.id]?.known).map((c) => c.id);
const out = Object.fromEntries(countries.filter((c) => all[c.id]).map((c) => [c.id, all[c.id]]));
writeFileSync(new URL('info.json', dir), JSON.stringify(out));
console.log(Object.keys(out).length, 'summaries;', missing.length ? 'missing: ' + missing.join(' ') : 'none missing');
