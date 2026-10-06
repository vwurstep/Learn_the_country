#!/usr/bin/env node
/**
 * build_subdivisions.mjs — offline data for the "deep dive" into subdivisions (US states,
 * Swiss cantons, German and Austrian states, Italian and French regions, UK nations).
 *
 *   node tools/build_subdivisions.mjs       (downloads sources into a cache dir, then writes:)
 *     data/sub/index.json       the sets: [{id, name, kind, kinds, label, count}] (label: quiz chip
 *                               text). Entries of sets built by other scripts are kept.
 *     data/sub/<set>.json       one entry per subdivision, sorted by name:
 *                               {id, name, local?, capital, capitalLocal?, lat, lon, fx, fy, color, flag}
 *                               local/capitalLocal: the name in the local language when it differs
 *                               (Bayern, München); flag: path, or null when there is no official flag.
 *     data/sub/<set>.geojson    subdivision polygons, properties.id = the json id
 *     flags/sub/<id>.svg|.png   one flag per subdivision (path in the json `flag` field)
 *
 * Sources (all downloaded at build time, cached in $CACHE_DIR or <os tmp>/learn_the_country_cache):
 *   - Shapes: Natural Earth admin-1 states/provinces (public domain), the GeoJSON from
 *       nvkelso/natural-earth-vector. 1:50m for the US states (it has all 50, Alaska and Hawaii
 *       included; its Alaska stops at 178°W, so no ring crosses the antimeridian), 1:10m for the
 *       others (not in the 50m set). US and CH: coordinates are rounded (3 and 4 decimals), nothing
 *       else is simplified, so shared borders stay identical between neighbours. The other sets go
 *       through mapshaper (npm, run with npx): Italian provinces, French départements and UK
 *       districts are dissolved into regions / nations (`key` below picks the region of a feature),
 *       then the set is simplified topologically (Visvalingam, weighted, `simplify` = share of
 *       vertices kept, small shapes kept), so neighbours still share identical borders without gaps.
 *   - Names and capitals: the tables below. Cantons use their own official spelling
 *       (Zürich, Genève, Ticino...), capitals are the official Hauptort / chef-lieu. The other sets
 *       use the common English names (Bavaria, Tuscany, Munich) with the local name alongside.
 *   - Capital coordinates (lat, lon): Wikidata (CC0), the subdivision's "capital" (P36) and its
 *       "coordinate location" (P625), one SPARQL query. Subdivisions are matched through the
 *       `wikidataid` that Natural Earth carries (US, CH) or, for the other sets, through their
 *       ISO 3166-2 code (P300) or an explicit `qid` in the table. A city-state (Berlin, Vienna) has
 *       no P36 and uses its own coordinates. Checked to lie inside the subdivision.
 *   - Flag position (fx, fy): pole of inaccessibility (polylabel, tools/geo.mjs, shared with
 *       build_data.mjs) of the largest polygon, cos(lat)-scaled.
 *   - Colours: greedy graph colouring (palette below, 6 hues) over the neighbour graph; two
 *       subdivisions are neighbours when their rounded rings share a vertex. Random restarts with a
 *       fixed seed keep the result reproducible and the number of colours minimal.
 *   - Flags: Wikimedia Commons, the original SVG of "Flag of <state>.svg" /
 *       "Flag of Canton of <canton>.svg" (or the title in the table; `flag: null` = no official
 *       flag, e.g. Northern Ireland), found through the Commons API (which also gives the licence,
 *       recorded in LICENSES.md). Files above 100 KB (seal-heavy US state flags) are rendered to a
 *       240 px wide PNG with headless Google Chrome and downscaled with sips (macOS), which keeps
 *       the app's offline cache small. Requests carry a descriptive User-Agent and are sent at most
 *       once per second (Wikimedia policy).
 *
 * Only data/sub/, flags/sub/ and the cache directory are written. Runs on Node >= 18 (global
 * fetch) with npm (npx mapshaper); the PNG rendering needs macOS with Google Chrome installed.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { polygonsOf, ringArea, pointInGeometry, roundGeometry, flagPoint, assertNoAntimeridianJumps } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const DATA_DIR = path.join(ROOT, 'data', 'sub');
const FLAGS_DIR = path.join(ROOT, 'flags', 'sub');
const FLAG_REL = 'flags/sub'; // as written into the json

const USER_AGENT = 'LearnTheCountry-build/1.0 (https://github.com/vwurstep/Learn_the_country; philippe.vonwurstemberger@gmail.com) node';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_SVG_BYTES = 100_000; // bigger flags are rendered to PNG
const PNG_WIDTH = 240;
const RENDER_WIDTH = 1200;     // Chrome wants a window of at least ~500 px; render big, then downscale

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const SRC = {
  ne50: NE + 'ne_50m_admin_1_states_provinces.geojson',
  ne10: NE + 'ne_10m_admin_1_states_provinces.geojson',
  commonsApi: 'https://commons.wikimedia.org/w/api.php',
  sparql: 'https://query.wikidata.org/sparql',
};

// Saturated hues; the app draws them mixed 50% with white. Index order = preference order.
const PALETTE = ['#e0393e', '#2f6fd0', '#2fa84f', '#f29e1f', '#8b5cd6', '#19a3a3'];

// ---------------------------------------------------------------------------
// Curation tables: code -> [name, capital, Commons flag title]
// ---------------------------------------------------------------------------

const US_STATES = {
  AL: ['Alabama', 'Montgomery'], AK: ['Alaska', 'Juneau'], AZ: ['Arizona', 'Phoenix'], AR: ['Arkansas', 'Little Rock'],
  CA: ['California', 'Sacramento'], CO: ['Colorado', 'Denver'], CT: ['Connecticut', 'Hartford'], DE: ['Delaware', 'Dover'],
  FL: ['Florida', 'Tallahassee'], GA: ['Georgia', 'Atlanta', 'Flag of Georgia (U.S. state).svg'], HI: ['Hawaii', 'Honolulu'],
  ID: ['Idaho', 'Boise'], IL: ['Illinois', 'Springfield'], IN: ['Indiana', 'Indianapolis'], IA: ['Iowa', 'Des Moines'],
  KS: ['Kansas', 'Topeka'], KY: ['Kentucky', 'Frankfort'], LA: ['Louisiana', 'Baton Rouge'], ME: ['Maine', 'Augusta'],
  MD: ['Maryland', 'Annapolis'], MA: ['Massachusetts', 'Boston'], MI: ['Michigan', 'Lansing'], MN: ['Minnesota', 'Saint Paul'],
  MS: ['Mississippi', 'Jackson'], MO: ['Missouri', 'Jefferson City'], MT: ['Montana', 'Helena'], NE: ['Nebraska', 'Lincoln'],
  NV: ['Nevada', 'Carson City'], NH: ['New Hampshire', 'Concord'], NJ: ['New Jersey', 'Trenton'], NM: ['New Mexico', 'Santa Fe'],
  NY: ['New York', 'Albany'], NC: ['North Carolina', 'Raleigh'], ND: ['North Dakota', 'Bismarck'], OH: ['Ohio', 'Columbus'],
  OK: ['Oklahoma', 'Oklahoma City'], OR: ['Oregon', 'Salem'], PA: ['Pennsylvania', 'Harrisburg'], RI: ['Rhode Island', 'Providence'],
  SC: ['South Carolina', 'Columbia'], SD: ['South Dakota', 'Pierre'], TN: ['Tennessee', 'Nashville'], TX: ['Texas', 'Austin'],
  UT: ['Utah', 'Salt Lake City'], VT: ['Vermont', 'Montpelier'], VA: ['Virginia', 'Richmond'], WA: ['Washington', 'Olympia'],
  WV: ['West Virginia', 'Charleston'], WI: ['Wisconsin', 'Madison'], WY: ['Wyoming', 'Cheyenne'],
};

// Commons names the cantons in English ("Flag of Canton of Lucerne.svg"); the app uses the local names.
const CH_CANTONS = {
  ZH: ['Zürich', 'Zürich', 'Flag of Canton of Zürich.svg'],
  BE: ['Bern', 'Bern', 'Flag of Canton of Bern.svg'],
  LU: ['Luzern', 'Luzern', 'Flag of Canton of Lucerne.svg'],
  UR: ['Uri', 'Altdorf', 'Flag of Canton of Uri.svg'],
  SZ: ['Schwyz', 'Schwyz', 'Flag of Canton of Schwyz.svg'],
  OW: ['Obwalden', 'Sarnen', 'Flag of Canton of Obwalden.svg'],
  NW: ['Nidwalden', 'Stans', 'Flag of Canton of Nidwalden.svg'],
  GL: ['Glarus', 'Glarus', 'Flag of Canton of Glarus.svg'],
  ZG: ['Zug', 'Zug', 'Flag of Canton of Zug.svg'],
  FR: ['Fribourg', 'Fribourg', 'Flag of Canton of Fribourg.svg'],
  SO: ['Solothurn', 'Solothurn', 'Flag of Canton of Solothurn.svg'],
  BS: ['Basel-Stadt', 'Basel', 'Flag of Canton of Basel.svg'],
  BL: ['Basel-Landschaft', 'Liestal', 'Flag of Canton of Basel-Landschaft.svg'],
  SH: ['Schaffhausen', 'Schaffhausen', 'Flag of Canton of Schaffhausen.svg'],
  AR: ['Appenzell Ausserrhoden', 'Herisau', 'Flag of Canton of Appenzell Ausserrhoden.svg'],
  AI: ['Appenzell Innerrhoden', 'Appenzell', 'Flag of Canton of Appenzell Innerrhoden.svg'],
  SG: ['St. Gallen', 'St. Gallen', 'Flag of Canton of Sankt Gallen.svg'],
  GR: ['Graubünden', 'Chur', 'Flag of Canton of Graubünden.svg'],
  AG: ['Aargau', 'Aarau', 'Flag of Canton of Aargau.svg'],
  TG: ['Thurgau', 'Frauenfeld', 'Flag of Canton of Thurgau.svg'],
  TI: ['Ticino', 'Bellinzona', 'Flag of Canton of Ticino.svg'],
  VD: ['Vaud', 'Lausanne', 'Flag of Canton of Vaud.svg'],
  VS: ['Valais', 'Sion', 'Flag of Canton of Valais.svg'],
  NE: ['Neuchâtel', 'Neuchâtel', 'Flag of Canton of Neuchâtel.svg'],
  GE: ['Genève', 'Genève', 'Flag of Canton of Geneva.svg'],
  JU: ['Jura', 'Delémont', 'Flag of Canton of Jura.svg'],
};

// The tables below use objects: {name, capital, local?, capitalLocal?, flag?, qid?}. `flag` is the
// Commons title (default "Flag of <name>.svg"; null = no official flag), `qid` the Wikidata item
// when the ISO 3166-2 code does not find exactly one.

// Common English names; capitals as on Wikidata. The civil flags ("Flag of <state>.svg") are all
// different from each other.
const DE_STATES = {
  BW: { name: 'Baden-Württemberg', capital: 'Stuttgart' },
  BY: { name: 'Bavaria', local: 'Bayern', capital: 'Munich', capitalLocal: 'München' },
  BE: { name: 'Berlin', capital: 'Berlin' },
  BB: { name: 'Brandenburg', capital: 'Potsdam' },
  HB: { name: 'Bremen', capital: 'Bremen' },
  HH: { name: 'Hamburg', capital: 'Hamburg' },
  HE: { name: 'Hesse', local: 'Hessen', capital: 'Wiesbaden' },
  MV: { name: 'Mecklenburg-Vorpommern', capital: 'Schwerin', flag: 'Flag of Mecklenburg-Western Pomerania.svg' },
  NI: { name: 'Lower Saxony', local: 'Niedersachsen', capital: 'Hanover', capitalLocal: 'Hannover' },
  NW: { name: 'North Rhine-Westphalia', local: 'Nordrhein-Westfalen', capital: 'Düsseldorf' },
  RP: { name: 'Rhineland-Palatinate', local: 'Rheinland-Pfalz', capital: 'Mainz' },
  SL: { name: 'Saarland', capital: 'Saarbrücken' },
  SN: { name: 'Saxony', local: 'Sachsen', capital: 'Dresden' },
  ST: { name: 'Saxony-Anhalt', local: 'Sachsen-Anhalt', capital: 'Magdeburg' },
  SH: { name: 'Schleswig-Holstein', capital: 'Kiel' },
  TH: { name: 'Thuringia', local: 'Thüringen', capital: 'Erfurt' },
};

// The plain civil flags (Landesfarben) repeat (Vienna = Salzburg = Vorarlberg, Tyrol = Upper
// Austria), so the quiz uses the state flags with the coat of arms ("Flag of <state> (state).svg").
const AT_STATES = {
  1: { name: 'Burgenland', capital: 'Eisenstadt', flag: 'Flag of Burgenland (state).svg' },
  2: { name: 'Carinthia', local: 'Kärnten', capital: 'Klagenfurt', flag: 'Flag of Carinthia (state).svg' },
  3: { name: 'Lower Austria', local: 'Niederösterreich', capital: 'St. Pölten', flag: 'Flag of Lower Austria (state).svg' },
  4: { name: 'Upper Austria', local: 'Oberösterreich', capital: 'Linz', flag: 'Flag of Upper Austria (state).svg' },
  5: { name: 'Salzburg', capital: 'Salzburg', flag: 'Flag of Salzburg (state).svg' },
  6: { name: 'Styria', local: 'Steiermark', capital: 'Graz', flag: 'Flag of Styria (state).svg' },
  7: { name: 'Tyrol', local: 'Tirol', capital: 'Innsbruck', flag: 'Flag of Tirol (state).svg' },
  8: { name: 'Vorarlberg', capital: 'Bregenz', flag: 'Flag of Vorarlberg (state).svg' },
  9: { name: 'Vienna', local: 'Wien', capital: 'Vienna', capitalLocal: 'Wien', flag: 'Flag of Vienna (state).svg' },
};

// Codes are the ISO 3166-2 region codes; Natural Earth's provinces carry them as `region_cod`.
const IT_REGIONS = {
  65: { name: 'Abruzzo', capital: "L'Aquila" },
  77: { name: 'Basilicata', capital: 'Potenza' },
  78: { name: 'Calabria', capital: 'Catanzaro' },
  72: { name: 'Campania', capital: 'Naples', capitalLocal: 'Napoli' },
  45: { name: 'Emilia-Romagna', capital: 'Bologna' },
  36: { name: 'Friuli-Venezia Giulia', capital: 'Trieste' },
  62: { name: 'Lazio', capital: 'Rome', capitalLocal: 'Roma' },
  42: { name: 'Liguria', capital: 'Genoa', capitalLocal: 'Genova' },
  25: { name: 'Lombardy', local: 'Lombardia', capital: 'Milan', capitalLocal: 'Milano' },
  57: { name: 'Marche', capital: 'Ancona' },
  67: { name: 'Molise', capital: 'Campobasso' },
  21: { name: 'Piedmont', local: 'Piemonte', capital: 'Turin', capitalLocal: 'Torino' },
  75: { name: 'Apulia', local: 'Puglia', capital: 'Bari' },
  88: { name: 'Sardinia', local: 'Sardegna', capital: 'Cagliari' },
  82: { name: 'Sicily', local: 'Sicilia', capital: 'Palermo', qid: 'Q1460' }, // IT-82 is also on a second item
  52: { name: 'Tuscany', local: 'Toscana', capital: 'Florence', capitalLocal: 'Firenze' },
  32: { name: 'Trentino-Alto Adige', capital: 'Trento', flag: 'Flag of Trentino-South Tyrol.svg' },
  55: { name: 'Umbria', capital: 'Perugia' },
  23: { name: 'Aosta Valley', local: "Valle d'Aosta", capital: 'Aosta' },
  34: { name: 'Veneto', capital: 'Venice', capitalLocal: 'Venezia' },
};

// The 13 metropolitan regions of 2016 and the 5 overseas regions. Codes as in Natural Earth's
// `region_cod` (FR_REGION_CODE maps its overseas codes to the usual two letters). Wikidata keys
// Corsica and the overseas regions under other ISO codes (FR-20R, FR-971...), hence the qids.
// Flags: what Commons has as "Flag of <region>" (official or logo flags); null where that is the
// French tricolour (Guadeloupe, Réunion) or only a fan proposal (Grand Est, Hauts-de-France).
const FR_REGIONS = {
  ARA: { name: 'Auvergne-Rhône-Alpes', capital: 'Lyon' },
  BFC: { name: 'Bourgogne-Franche-Comté', capital: 'Dijon' },
  BRE: { name: 'Brittany', local: 'Bretagne', capital: 'Rennes' },
  CVL: { name: 'Centre-Val de Loire', capital: 'Orléans' },
  COR: { name: 'Corsica', local: 'Corse', capital: 'Ajaccio', qid: 'Q14112' },
  GES: { name: 'Grand Est', capital: 'Strasbourg', flag: null },
  HDF: { name: 'Hauts-de-France', capital: 'Lille', flag: null },
  IDF: { name: 'Île-de-France', capital: 'Paris' },
  NOR: { name: 'Normandy', local: 'Normandie', capital: 'Rouen', flag: 'Flag of Normandie.svg' }, // the two leopards, not the Nordic-cross design
  NAQ: { name: 'Nouvelle-Aquitaine', capital: 'Bordeaux' },
  OCC: { name: 'Occitania', local: 'Occitanie', capital: 'Toulouse', flag: 'Flag of Occitanie.svg' }, // the region's flag, not the Occitan cross
  PDL: { name: 'Pays de la Loire', capital: 'Nantes' },
  PAC: { name: "Provence-Alpes-Côte d'Azur", capital: 'Marseille' },
  GP: { name: 'Guadeloupe', capital: 'Basse-Terre', qid: 'Q17012', flag: null },
  MQ: { name: 'Martinique', capital: 'Fort-de-France', qid: 'Q17054' },
  GF: { name: 'French Guiana', local: 'Guyane', capital: 'Cayenne', qid: 'Q3769' },
  RE: { name: 'Réunion', local: 'La Réunion', capital: 'Saint-Denis', qid: 'Q17070', flag: null },
  YT: { name: 'Mayotte', capital: 'Mamoudzou', qid: 'Q17063' },
};
const FR_REGION_CODE = { GUA: 'GP', MTQ: 'MQ', GUF: 'GF', LRE: 'RE', MAY: 'YT' };

// Northern Ireland has had no official flag since 1972 (the Ulster Banner is not used).
const GB_NATIONS = {
  ENG: { name: 'England', capital: 'London' },
  SCT: { name: 'Scotland', capital: 'Edinburgh' },
  WLS: { name: 'Wales', capital: 'Cardiff' },
  NIR: { name: 'Northern Ireland', capital: 'Belfast', flag: null },
};
const GB_NATION_CODE = { England: 'ENG', Scotland: 'SCT', Wales: 'WLS', 'Northern Ireland': 'NIR' };

// Wikidata lists more than one "capital" for a few subdivisions; pick this item then.
const CAPITAL_QID = {
  'ch-ar': 'Q63970', // Herisau is the seat of government; Trogen (also listed) only hosts the cantonal court
  'fr-bfc': 'Q7003', // Dijon is the préfecture; Besançon (also listed) hosts the regional council
  'fr-yt': 'Q132676', // Mamoudzou is the préfecture; Dzaoudzi (also listed) was the capital until 1977
};

// id: country id in data/countries.json (the app links the deep dive through it), so the UK is `gb`.
// key(properties): table code of a Natural Earth feature, or undefined to leave it out (default:
// the feature's ISO 3166-2 code). Features with the same code are dissolved. simplify: share of
// vertices kept (mapshaper); without it the shapes are used as they are.
const SETS = [
  { id: 'us', name: 'United States', kind: 'state', kinds: 'states', label: 'US states', adm0: 'USA', iso: 'US', shapes: 'ne50', decimals: 3, table: US_STATES },
  { id: 'ch', name: 'Switzerland', kind: 'canton', kinds: 'cantons', label: 'Swiss cantons', adm0: 'CHE', iso: 'CH', shapes: 'ne10', decimals: 4, table: CH_CANTONS },
  { id: 'de', name: 'Germany', kind: 'state', kinds: 'states', label: 'German states', adm0: 'DEU', iso: 'DE', shapes: 'ne10', decimals: 3, simplify: '50%', table: DE_STATES },
  { id: 'at', name: 'Austria', kind: 'state', kinds: 'states', label: 'Austrian states', adm0: 'AUT', iso: 'AT', shapes: 'ne10', decimals: 3, simplify: '50%', table: AT_STATES },
  { id: 'it', name: 'Italy', kind: 'region', kinds: 'regions', label: 'Italian regions', adm0: 'ITA', iso: 'IT', shapes: 'ne10', decimals: 3, simplify: '50%', table: IT_REGIONS,
    key: (p) => (p.region_cod || '').trim().replace(/^IT-/, '') },
  { id: 'fr', name: 'France', kind: 'region', kinds: 'regions', label: 'French regions', adm0: 'FRA', iso: 'FR', shapes: 'ne10', decimals: 3, simplify: '50%', table: FR_REGIONS,
    key: (p) => { const c = (p.region_cod || '').trim().replace(/^FR-/, ''); return FR_REGION_CODE[c] || c; } }, // NE: "FR-IDF\t"
  { id: 'gb', name: 'United Kingdom', kind: 'nation', kinds: 'nations', label: 'UK nations', adm0: 'GBR', iso: 'GB', shapes: 'ne10', decimals: 3, simplify: '50%', table: GB_NATIONS,
    key: (p) => GB_NATION_CODE[p.geonunit] },
];

// Table entry as an object (the US and CH tables use arrays: [name, capital, Commons title]).
const entryOf = (raw) => (Array.isArray(raw) ? { name: raw[0], capital: raw[1], flag: raw[2] } : raw);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const round3 = (n) => Math.round(n * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'User-Agent': USER_AGENT };

let lastRequest = 0;
async function politeFetch(url, init = {}) { // at most one request per second to the Wikimedia servers
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function download(url, file, init) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  console.log(`downloading ${url}`);
  const res = await politeFetch(url, init);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// Write a file only if its content changed (keeps mtimes and iCloud quiet).
function writeIfChanged(file, content) {
  if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), Buffer.from(content)) === 0) return;
  fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------------------
// 1. Shapes
// ---------------------------------------------------------------------------

const isoCode = (set, p) => {
  const m = /^([A-Z]{2})-([A-Z0-9]{1,3})$/.exec(p.iso_3166_2 || '');
  return m && m[1] === set.iso ? m[2] : undefined;
};

async function buildShapes(ne, set) {
  const byCode = new Map();
  for (const f of ne.features) {
    const p = f.properties;
    if (p.adm0_a3 !== set.adm0) continue;
    const code = (set.key || ((q) => isoCode(set, q)))(p);
    if (!code || !(code in set.table)) continue; // DC, territories, Jervis Bay...
    (byCode.get(code) ?? byCode.set(code, []).get(code)).push(f);
  }
  const missing = Object.keys(set.table).filter((c) => !byCode.has(c));
  if (missing.length) throw new Error(`${set.id}: no shape for ${missing.join(', ')}`);

  let shapes; // Map code -> {geometry, wikidataid?}
  const needsDissolve = [...byCode.values()].some((fs) => fs.length > 1);
  if (set.simplify || needsDissolve) {
    shapes = mapshape(set, byCode);
  } else {
    shapes = new Map([...byCode].map(([code, [f]]) => [code, { geometry: f.geometry, wikidataid: f.properties.wikidataid }]));
  }

  // Wikidata item of every subdivision: the table's qid, else (sets matched by ISO code) the item
  // carrying that ISO 3166-2 code, else the id Natural Earth carries.
  const codes = [...byCode.keys()].sort();
  const byIso = set.key || set.simplify ? await itemsByIso(set, codes.filter((c) => !entryOf(set.table[c]).qid)) : new Map();
  const features = codes.map((code) => {
    const { geometry, wikidataid } = shapes.get(code);
    const wikidata = entryOf(set.table[code]).qid || byIso.get(`${set.iso}-${code}`) || wikidataid;
    if (!/^Q\d+$/.test(wikidata || '')) throw new Error(`${set.id}-${code}: no Wikidata item (add qid to the table)`);
    return {
      type: 'Feature',
      properties: { id: `${set.id}-${code.toLowerCase()}`, wikidata },
      geometry: roundGeometry(geometry, set.decimals),
    };
  });
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));
  assertNoAntimeridianJumps(features);
  return features;
}

// Dissolve the features of each code into one shape and simplify the set with mapshaper (npm,
// via npx), which builds a shared topology first: neighbours keep identical borders, no gaps or
// overlaps appear, and `keep-shapes` keeps every small island or region. Output coordinates are
// rounded to the set's decimals by mapshaper itself, so both sides of a border round alike.
function mapshape(set, byCode) {
  const dir = path.join(CACHE, 'mapshaper');
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, `${set.id}-in.geojson`);
  const output = path.join(dir, `${set.id}-out.geojson`);
  const features = [];
  for (const [code, fs_] of byCode) for (const f of fs_) features.push({ type: 'Feature', properties: { code }, geometry: f.geometry });
  fs.writeFileSync(input, JSON.stringify({ type: 'FeatureCollection', features }));
  const args = [input, '-dissolve', 'code'];
  if (set.simplify) args.push('-simplify', 'weighted', set.simplify, 'keep-shapes');
  args.push('-clean', '-o', output, 'format=geojson', `precision=${10 ** -set.decimals}`, 'force');
  console.log(`mapshaper ${set.id}: ${features.length} features -> ${byCode.size}${set.simplify ? `, simplify ${set.simplify}` : ''}`);
  execFileSync('npx', ['--yes', 'mapshaper', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  const out = new Map();
  for (const f of readJson(output).features) {
    if (!f.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type)) throw new Error(`${set.id}-${f.properties.code}: mapshaper dropped the geometry`);
    if (out.has(f.properties.code)) throw new Error(`${set.id}-${f.properties.code}: several features after dissolve`);
    out.set(f.properties.code, { geometry: f.geometry });
  }
  for (const code of byCode.keys()) if (!out.has(code)) throw new Error(`${set.id}-${code}: missing after mapshaper`);
  return out;
}

// Wikidata items by ISO 3166-2 code (P300): Map "DE-BY" -> "Q980". Codes that match no item or
// several are left out (the table's qid then decides).
async function itemsByIso(set, codes) {
  if (!codes.length) return new Map();
  const isos = codes.map((c) => `${set.iso}-${c}`);
  const query = `SELECT ?iso ?adm WHERE { VALUES ?iso { ${isos.map((i) => JSON.stringify(i)).join(' ')} } ?adm wdt:P300 ?iso . }`;
  const file = await download(`${SRC.sparql}?format=json&query=${encodeURIComponent(query)}`, `wikidata-sub-items-${set.id}.json`, { headers: { Accept: 'application/sparql-results+json' } });
  const items = new Map();
  for (const b of readJson(file).results.bindings) (items.get(b.iso.value) ?? items.set(b.iso.value, new Set()).get(b.iso.value)).add(b.adm.value.split('/').pop());
  const out = new Map();
  for (const [iso, qids] of items) {
    if (qids.size > 1) console.warn(`  ${iso}: several Wikidata items (${[...qids].join(', ')}), add qid to the table`);
    else out.set(iso, [...qids][0]);
  }
  return out;
}

// Neighbour graph: ids whose rounded rings share at least one vertex (a shared border, or a
// corner such as the Four Corners). Returns Map id -> Set of ids.
function adjacency(features) {
  const owners = new Map();
  for (const f of features) {
    const seen = new Set();
    for (const poly of polygonsOf(f.geometry)) for (const ring of poly) for (const [x, y] of ring) {
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      (owners.get(k) ?? owners.set(k, []).get(k)).push(f.properties.id);
    }
  }
  const adj = new Map(features.map((f) => [f.properties.id, new Set()]));
  for (const ids of owners.values()) {
    for (const a of ids) for (const b of ids) if (a !== b) adj.get(a).add(b);
  }
  return adj;
}

// Greedy colouring with random restarts (seeded, so the build is reproducible). Vertices are
// taken in the given order and get the lowest colour not used by a coloured neighbour; the order
// is shuffled on every restart and the colouring with the fewest colours wins.
function colourGraph(adj, restarts = 3000) {
  const ids = [...adj.keys()];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const order = ids.slice();
    if (r > 0) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    else order.sort((a, b) => adj.get(b).size - adj.get(a).size); // first try: most neighbours first
    const col = new Map();
    let n = 0;
    for (const id of order) {
      const used = new Set([...adj.get(id)].map((o) => col.get(o)).filter((c) => c !== undefined));
      let c = 0;
      while (used.has(c)) c++;
      col.set(id, c);
      n = Math.max(n, c + 1);
      if (best && n >= best.n) break;
    }
    if (col.size === ids.length && (!best || n < best.n)) best = { n, col };
  }
  if (best.n > PALETTE.length) throw new Error(`need ${best.n} colours, palette has ${PALETTE.length}`);
  return best;
}

// ---------------------------------------------------------------------------
// 2. Capital coordinates from Wikidata
// ---------------------------------------------------------------------------

// A subdivision that is its own capital (Berlin, Vienna) has no P36 on Wikidata; its own
// coordinates (P625) are used then.
async function capitalCoords(features, set) {
  const qids = features.map((f) => f.properties.wikidata);
  if (qids.some((q) => !/^Q\d+$/.test(q || ''))) throw new Error('feature without wikidataid');
  const query = `SELECT ?adm ?own ?cap ?coord WHERE { VALUES ?adm { ${qids.map((q) => 'wd:' + q).join(' ')} } OPTIONAL { ?adm wdt:P625 ?own . } OPTIONAL { ?adm wdt:P36 ?cap . ?cap wdt:P625 ?coord . } }`;
  const file = await download(`${SRC.sparql}?format=json&query=${encodeURIComponent(query)}`, `wikidata-sub-capitals-${set.id}.json`, { headers: { Accept: 'application/sparql-results+json' } });
  const point = (v) => {
    const m = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(v);
    if (!m) throw new Error(`bad coordinate ${v}`);
    return { lon: +m[1], lat: +m[2] };
  };
  const rows = readJson(file).results.bindings.map((b) => ({
    adm: b.adm.value.split('/').pop(),
    cap: b.cap?.value.split('/').pop(),
    ...(b.coord ? point(b.coord.value) : {}),
    own: b.own ? point(b.own.value) : null,
  }));
  const out = new Map();
  for (const f of features) {
    const id = f.properties.id;
    const mine = rows.filter((r) => r.adm === f.properties.wikidata);
    let cands = mine.filter((r) => r.cap && r.lat !== undefined);
    const caps = [...new Set(cands.map((r) => r.cap))];
    if (caps.length > 1) {
      if (!CAPITAL_QID[id]) throw new Error(`${id}: several capitals on Wikidata (${caps.join(', ')}), add CAPITAL_QID`);
      cands = cands.filter((r) => r.cap === CAPITAL_QID[id]);
    }
    const entry = entryOf(set.table[id.slice(set.id.length + 1).toUpperCase()]);
    if (!cands.length && entry.capital === entry.name && mine.some((r) => r.own)) cands = [mine.find((r) => r.own).own];
    if (!cands.length) throw new Error(`${id}: no capital coordinates on Wikidata (${f.properties.wikidata})`);
    const { lat, lon } = cands[0];
    if (!nearGeometry([lon, lat], f.geometry)) throw new Error(`${id}: capital ${lat},${lon} is outside its shape`);
    out.set(id, [round3(lat), round3(lon)]);
  }
  return out;
}

// Inside the geometry, or within `km` of its outline: coastal capitals (Juneau, Annapolis) fall
// just off the generalised 1:50m coastline.
function nearGeometry([lon, lat], geom, km = 3) {
  if (pointInGeometry([lon, lat], geom)) return true;
  const k = Math.cos((lat * Math.PI) / 180);
  const segDist = (px, py, [ax, ay], [bx, by]) => {
    let x = ax, y = ay, dx = bx - ax, dy = by - ay;
    if (dx || dy) { const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; } }
    return Math.hypot(px - x, py - y);
  };
  let d = Infinity;
  for (const poly of polygonsOf(geom)) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
    d = Math.min(d, segDist(lon * k, lat, [ring[i - 1][0] * k, ring[i - 1][1]], [ring[i][0] * k, ring[i][1]]));
  }
  return d * 111 <= km;
}

// ---------------------------------------------------------------------------
// 3. Flags from Wikimedia Commons
// ---------------------------------------------------------------------------

// Commons API: title -> {title (after redirects), url, size, width, height, license, artist}.
async function commonsInfo(titles, cacheName) {
  const file = path.join(CACHE, cacheName);
  if (!fs.existsSync(file)) {
    const pages = [];
    for (let i = 0; i < titles.length; i += 50) {
      const body = new URLSearchParams({
        action: 'query', format: 'json', redirects: '1', prop: 'imageinfo',
        iiprop: 'url|size|extmetadata', iiextmetadatafilter: 'LicenseShortName|Artist|AttributionRequired',
        titles: titles.slice(i, i + 50).map((t) => 'File:' + t).join('|'),
      });
      console.log(`querying Commons for ${Math.min(50, titles.length - i)} files`);
      const res = await politeFetch(SRC.commonsApi, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      pages.push(await res.json());
    }
    fs.writeFileSync(file, JSON.stringify(pages));
  }
  const info = new Map();
  for (const j of readJson(file)) {
    const q = j.query;
    const alias = new Map([...(q.normalized || []), ...(q.redirects || [])].map((r) => [r.from, r.to]));
    const byTitle = new Map(Object.values(q.pages).map((p) => [p.title, p]));
    for (const t of titles) {
      let title = 'File:' + t;
      for (let i = 0; i < 3 && alias.has(title); i++) title = alias.get(title);
      const p = byTitle.get(title);
      if (!p) continue;
      if (p.missing !== undefined || !p.imageinfo) throw new Error(`Commons: ${t} not found`);
      const ii = p.imageinfo[0], m = ii.extmetadata || {};
      const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/(Unknown author)\1/, '$1').trim();
      info.set(t, {
        title: p.title.replace(/^File:/, ''), url: ii.url.split('?')[0], size: ii.size, width: ii.width, height: ii.height,
        license: strip(m.LicenseShortName?.value) || 'unknown', artist: strip(m.Artist?.value),
        attributionRequired: strip(m.AttributionRequired?.value) === 'true',
      });
    }
  }
  return info;
}

// Render an SVG to a PNG_WIDTH px wide PNG. Chrome's new headless mode often does not exit
// after --screenshot, so we wait for the file and then kill it.
async function renderPng(svgFile, width, height, outFile) {
  const dir = path.join(CACHE, 'render');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(svgFile, '.svg');
  const h = Math.round((RENDER_WIDTH * height) / width);
  const html = path.join(dir, `${base}.html`);
  const big = path.join(dir, `${base}-big.png`);
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:${RENDER_WIDTH}px;height:${h}px}</style></head><body><img src="file://${svgFile}"></body></html>`);
  fs.rmSync(big, { force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--default-background-color=00000000', `--window-size=${RENDER_WIDTH},${h}`,
    `--user-data-dir=${path.join(dir, 'chrome-profile')}`, `--screenshot=${big}`, `file://${html}`,
  ], { stdio: 'ignore' });
  let exited = false;
  chrome.on('exit', () => { exited = true; });
  const t0 = Date.now();
  for (;;) {
    await sleep(200);
    if (exited) break;
    if (fs.existsSync(big) && fs.statSync(big).size > 0 && Date.now() - t0 > 1500) { await sleep(300); chrome.kill('SIGKILL'); break; }
    if (Date.now() - t0 > 60_000) { chrome.kill('SIGKILL'); throw new Error(`Chrome timed out rendering ${svgFile}`); }
  }
  if (!fs.existsSync(big)) throw new Error(`Chrome produced no screenshot for ${svgFile}`);
  execFileSync('sips', ['--resampleWidth', String(PNG_WIDTH), big, '--out', outFile], { stdio: 'ignore' });
}

async function buildFlags(entries, set) {
  fs.mkdirSync(FLAGS_DIR, { recursive: true });
  fs.mkdirSync(path.join(CACHE, 'commons'), { recursive: true });
  const withFlag = entries.filter((e) => e.commonsTitle);
  const info = withFlag.length ? await commonsInfo(withFlag.map((e) => e.commonsTitle), `commons-sub-${set.id}.json`) : new Map();
  const credits = [];
  let bytes = 0;
  for (const e of entries) {
    if (!e.commonsTitle) { // no official flag
      for (const ext of ['svg', 'png']) fs.rmSync(path.join(FLAGS_DIR, `${e.id}.${ext}`), { force: true });
      continue;
    }
    const fi = info.get(e.commonsTitle);
    if (!fi) throw new Error(`no Commons info for ${e.commonsTitle}`);
    const cached = await download(fi.url, path.join('commons', `${e.id}.svg`));
    const usePng = fs.statSync(cached).size > MAX_SVG_BYTES;
    const out = path.join(FLAGS_DIR, `${e.id}.${usePng ? 'png' : 'svg'}`);
    fs.rmSync(path.join(FLAGS_DIR, `${e.id}.${usePng ? 'svg' : 'png'}`), { force: true }); // stale counterpart
    if (usePng) {
      if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(cached).mtimeMs) {
        console.log(`rendering ${e.id} (${fi.size} B svg) to png`);
        await renderPng(cached, fi.width, fi.height, out);
      }
    } else {
      writeIfChanged(out, fs.readFileSync(cached));
    }
    e.flag = `${FLAG_REL}/${path.basename(out)}`;
    bytes += fs.statSync(out).size;
    credits.push({ id: e.id, file: fi.title, license: fi.license, artist: fi.artist, attributionRequired: fi.attributionRequired });
  }
  return { bytes, credits };
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const shapeFiles = {};
  for (const key of new Set(SETS.map((s) => s.shapes))) shapeFiles[key] = readJson(await download(SRC[key], path.basename(SRC[key])));

  const allCredits = [];
  const counts = new Map();
  for (const set of SETS) {
    const features = await buildShapes(shapeFiles[set.shapes], set);
    const coords = await capitalCoords(features, set);
    const adj = adjacency(features);
    const { n: nColours, col } = colourGraph(adj);

    const entries = [];
    for (const f of features) {
      const id = f.properties.id;
      const code = id.slice(set.id.length + 1).toUpperCase();
      const { name, local, capital, capitalLocal, flag: title } = entryOf(set.table[code]);
      const commonsTitle = title === null ? null : title || `Flag of ${name}.svg`;
      const [lat, lon] = coords.get(id);
      const [fx, fy] = flagPoint(f.geometry).map(round3);
      if (!pointInGeometry([fx, fy], f.geometry)) throw new Error(`${id}: flag point outside its shape`);
      entries.push({ id, name, ...(local && local !== name ? { local } : {}), capital, ...(capitalLocal && capitalLocal !== capital ? { capitalLocal } : {}), lat, lon, fx, fy, color: PALETTE[col.get(id)], flag: null, commonsTitle });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

    const { bytes: flagBytes, credits } = await buildFlags(entries, set);
    allCredits.push(...credits);

    // geojson (properties: only id)
    const fc = { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: { id: f.properties.id }, geometry: f.geometry })) };
    const geoPath = path.join(DATA_DIR, `${set.id}.geojson`);
    writeIfChanged(geoPath, JSON.stringify(fc));
    const geoBytes = fs.statSync(geoPath).size;
    if (geoBytes > 500_000) console.warn(`  warning: ${set.id}.geojson is ${geoBytes} bytes (> 500 KB)`);

    // json
    const rows = entries.map(({ commonsTitle, ...e }) => e);
    const jsonPath = path.join(DATA_DIR, `${set.id}.json`);
    writeIfChanged(jsonPath, '[\n' + rows.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');

    // final checks
    validate(set, rows, fc, adj);
    counts.set(set.id, rows.length);
    const nPng = rows.filter((e) => e.flag && e.flag.endsWith('.png')).length;
    const nNull = rows.filter((e) => !e.flag).length;
    console.log(`${set.id}: ${rows.length} ${set.kinds}, ${nColours} colours, ${set.id}.geojson ${geoBytes} B, ${set.id}.json ${fs.statSync(jsonPath).size} B, flags ${flagBytes} B (${rows.length - nPng - nNull} svg, ${nPng} png${nNull ? `, ${nNull} without flag: ${rows.filter((e) => !e.flag).map((e) => e.id).join(' ')}` : ''})`);
  }

  // index.json: other scripts add their own sets to it, so only this script's entries are
  // replaced (in place) or appended; the file is re-read right before writing.
  const indexPath = path.join(DATA_DIR, 'index.json');
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : [];
  for (const { id, name, kind, kinds, label } of SETS) {
    const entry = { id, name, kind, kinds, label, count: counts.get(id) };
    const i = index.findIndex((e) => e.id === id);
    if (i >= 0) index[i] = entry; else index.push(entry);
  }
  writeIfChanged(indexPath, '[\n' + index.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');

  // Flag credits for LICENSES.md
  const byLicense = {};
  for (const c of allCredits) (byLicense[c.license] ??= []).push(c);
  const lines = ['| id | Commons file | licence | author |', '|---|---|---|---|'];
  for (const c of allCredits) lines.push(`| ${c.id} | [${c.file}](https://commons.wikimedia.org/wiki/File:${encodeURI(c.file.replace(/ /g, '_'))}) | ${c.license} | ${c.artist.replace(/\|/g, '/')} |`);
  const creditsFile = path.join(CACHE, 'sub-flag-credits.md');
  fs.writeFileSync(creditsFile, lines.join('\n') + '\n');
  console.log(`flag licences: ${Object.entries(byLicense).map(([l, c]) => `${l} ×${c.length}`).join(', ')}; table written to ${creditsFile}`);
}

function validate(set, rows, fc, adj) {
  const n = Object.keys(set.table).length;
  if (rows.length !== n) throw new Error(`${set.id}: ${rows.length} entries, expected ${n}`);
  const geom = new Map(fc.features.map((f) => [f.properties.id, f.geometry]));
  if (geom.size !== n) throw new Error(`${set.id}: ${geom.size} shapes, expected ${n}`);
  const colour = new Map(rows.map((e) => [e.id, e.color]));
  for (const e of rows) {
    const g = geom.get(e.id);
    if (!g) throw new Error(`${e.id}: no geometry`);
    const code = e.id.slice(set.id.length + 1).toUpperCase();
    if (e.flag === null) { if (entryOf(set.table[code]).flag !== null) throw new Error(`${e.id}: flag missing`); }
    else if (!/^flags\/sub\/[a-z0-9-]+\.(svg|png)$/.test(e.flag) || !fs.existsSync(path.join(ROOT, e.flag))) throw new Error(`${e.id}: flag file ${e.flag} missing`);
    if (!pointInGeometry([e.fx, e.fy], g)) throw new Error(`${e.id}: fx/fy outside`);
    if (!nearGeometry([e.lon, e.lat], g)) throw new Error(`${e.id}: capital outside`);
    for (const o of adj.get(e.id)) if (colour.get(o) === e.color) throw new Error(`${e.id} and ${o} are neighbours with the same colour`);
    if (!/^#[0-9a-f]{6}$/.test(e.color)) throw new Error(`${e.id}: bad colour`);
  }
  assertNoAntimeridianJumps(fc.features);
  for (const f of fc.features) for (const poly of polygonsOf(f.geometry)) if (ringArea(poly[0]) === 0) throw new Error(`${f.properties.id}: degenerate ring`);
}

main().catch((e) => { console.error(e); process.exit(1); });
