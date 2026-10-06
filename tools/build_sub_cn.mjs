#!/usr/bin/env node
/**
 * build_sub_cn.mjs — offline data for the "deep dive" into China's provinces (the 31 mainland
 * provincial-level divisions: 22 provinces, 5 autonomous regions, 4 municipalities; Hong Kong,
 * Macau and Taiwan are separate entries of the world set).
 *
 *   node tools/build_sub_cn.mjs       (downloads sources into a cache dir, then writes:)
 *     data/sub/cn.json          one entry per province, sorted by name:
 *                               {id, name, local, capital, capitalLocal, lat, lon, fx, fy, color, flag: null}
 *     data/sub/cn.geojson       province polygons, properties.id = the json id
 *     data/sub/index.json       only the `cn` entry is added or replaced (other sets keep theirs)
 *
 * Same conventions as build_subdivisions.mjs (US states, Swiss cantons); the differences:
 *   - Shapes: Natural Earth 1:10m admin-1 (public domain, the GeoJSON from nvkelso/natural-earth-vector),
 *       the 31 features with an ISO 3166-2:CN alpha code (NE's "Paracel Islands" pseudo-feature is
 *       dropped). Raw they weigh 1.2 MB, so they are simplified with mapshaper (run through
 *       `npx mapshaper`, a build tool, not a dependency of the app): topology-preserving Visvalingam
 *       simplification keeping SIMPLIFY of the vertices, islands under MIN_ISLAND removed, 3 decimals.
 *       Neighbours share arcs, so their common border stays identical on both sides; the script
 *       checks that the neighbour graph of the simplified shapes equals that of the raw ones.
 *   - Names: English (pinyin) and simplified Chinese short names from the table below; the Chinese
 *       ones are cross-checked against Wikidata's zh-hans labels and Natural Earth's name_zh.
 *   - Capital coordinates (lat, lon): Wikidata (CC0), the province's "capital" (P36) and its
 *       "coordinate location" (P625); the English label of P36 must match the table. For the four
 *       municipalities the capital is the municipality itself (Wikidata's P36 names a district), so
 *       their own P625 (the city centre) is used.
 *   - Flags: none. Chinese provinces have no official flags, so `flag` is null and the app shows
 *       the Chinese name instead.
 *
 * Only data/sub/ and the cache directory ($CACHE_DIR or <os tmp>/learn_the_country_cache) are
 * written. Runs on Node >= 18 (global fetch) with npx available.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { polygonsOf, ringArea, pointInGeometry, roundGeometry, flagPoint, assertNoAntimeridianJumps } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const DATA_DIR = path.join(ROOT, 'data', 'sub');

const USER_AGENT = 'LearnTheCountry-build/1.0 (https://github.com/vwurstep/Learn_the_country; philippe.vonwurstemberger@gmail.com) node';
const MAPSHAPER = process.env.MAPSHAPER ? [process.env.MAPSHAPER] : ['npx', '--yes', 'mapshaper'];
const SIMPLIFY = '35%';     // share of vertices kept (Visvalingam, weighted); ~300 KB at 3 decimals
const MIN_ISLAND = '5km2';  // smaller detached rings (islets) are dropped
const DECIMALS = 3;

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const SRC = {
  ne10: NE + 'ne_10m_admin_1_states_provinces.geojson',
  sparql: 'https://query.wikidata.org/sparql',
};

// Saturated hues; the app draws them mixed 50% with white. Index order = preference order.
const PALETTE = ['#e0393e', '#2f6fd0', '#2fa84f', '#f29e1f', '#8b5cd6', '#19a3a3'];

const SET = { id: 'cn', name: 'China', kind: 'province', kinds: 'provinces', label: 'Chinese provinces', adm0: 'CHN', iso: 'CN' };

// ---------------------------------------------------------------------------
// Curation table: ISO 3166-2:CN code -> [name, local, capital, capitalLocal]
// ---------------------------------------------------------------------------

const PROVINCES = {
  AH: ['Anhui', '安徽', 'Hefei', '合肥'],
  BJ: ['Beijing', '北京', 'Beijing', '北京'],
  CQ: ['Chongqing', '重庆', 'Chongqing', '重庆'],
  FJ: ['Fujian', '福建', 'Fuzhou', '福州'],
  GD: ['Guangdong', '广东', 'Guangzhou', '广州'],
  GS: ['Gansu', '甘肃', 'Lanzhou', '兰州'],
  GX: ['Guangxi', '广西', 'Nanning', '南宁'],
  GZ: ['Guizhou', '贵州', 'Guiyang', '贵阳'],
  HA: ['Henan', '河南', 'Zhengzhou', '郑州'],
  HB: ['Hubei', '湖北', 'Wuhan', '武汉'],
  HE: ['Hebei', '河北', 'Shijiazhuang', '石家庄'],
  HI: ['Hainan', '海南', 'Haikou', '海口'],
  HL: ['Heilongjiang', '黑龙江', 'Harbin', '哈尔滨'],
  HN: ['Hunan', '湖南', 'Changsha', '长沙'],
  JL: ['Jilin', '吉林', 'Changchun', '长春'],
  JS: ['Jiangsu', '江苏', 'Nanjing', '南京'],
  JX: ['Jiangxi', '江西', 'Nanchang', '南昌'],
  LN: ['Liaoning', '辽宁', 'Shenyang', '沈阳'],
  NM: ['Inner Mongolia', '内蒙古', 'Hohhot', '呼和浩特'],
  NX: ['Ningxia', '宁夏', 'Yinchuan', '银川'],
  QH: ['Qinghai', '青海', 'Xining', '西宁'],
  SC: ['Sichuan', '四川', 'Chengdu', '成都'],
  SD: ['Shandong', '山东', 'Jinan', '济南'],
  SH: ['Shanghai', '上海', 'Shanghai', '上海'],
  SN: ['Shaanxi', '陕西', "Xi'an", '西安'],
  SX: ['Shanxi', '山西', 'Taiyuan', '太原'],
  TJ: ['Tianjin', '天津', 'Tianjin', '天津'],
  XJ: ['Xinjiang', '新疆', 'Ürümqi', '乌鲁木齐'],
  XZ: ['Tibet', '西藏', 'Lhasa', '拉萨'],
  YN: ['Yunnan', '云南', 'Kunming', '昆明'],
  ZJ: ['Zhejiang', '浙江', 'Hangzhou', '杭州'],
};

// Capital = the municipality itself; its own Wikidata coordinate (the city centre) is used.
const MUNICIPALITIES = new Set(['BJ', 'SH', 'TJ', 'CQ']);

// Wikidata lists more than one "capital" for a few subdivisions; pick this item then.
const CAPITAL_QID = {};

// Suffixes that Wikidata / Natural Earth append to the short Chinese names.
const PROVINCE_SUFFIXES = ['省', '市', '自治区', '壮族自治区', '回族自治区', '维吾尔自治区'];
const CAPITAL_SUFFIXES = ['', '市'];

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

// The 31 Natural Earth features, as {id, wikidata, nameZh} + geometry, sorted by id.
function rawShapes(ne) {
  const byCode = new Map();
  for (const f of ne.features) {
    const p = f.properties;
    if (p.adm0_a3 !== SET.adm0) continue;
    const m = /^([A-Z]{2})-([A-Z]{2})$/.exec(p.iso_3166_2 || ''); // "CN-X01~" (Paracel Islands) does not match
    if (!m || m[1] !== SET.iso) continue;
    if (!(m[2] in PROVINCES)) throw new Error(`cn: unexpected Natural Earth feature ${p.iso_3166_2} (${p.name})`);
    if (byCode.has(m[2])) throw new Error(`cn: duplicate feature for ${m[2]}`);
    byCode.set(m[2], f);
  }
  const missing = Object.keys(PROVINCES).filter((c) => !byCode.has(c));
  if (missing.length) throw new Error(`cn: no shape for ${missing.join(', ')}`);
  const features = [...byCode].map(([code, f]) => ({
    type: 'Feature',
    properties: { id: `cn-${code.toLowerCase()}`, wikidata: f.properties.wikidataid, nameZh: f.properties.name_zh },
    geometry: f.geometry,
  }));
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));
  return features;
}

// Topology-preserving simplification with mapshaper; returns the features with rounded coordinates.
function simplify(rawFile, outFile) {
  const args = ['-i', rawFile, '-simplify', SIMPLIFY, 'keep-shapes', '-filter-islands', `min-area=${MIN_ISLAND}`,
    '-o', outFile, 'format=geojson', `precision=${10 ** -DECIMALS}`, 'force'];
  console.log(`mapshaper -simplify ${SIMPLIFY} -filter-islands min-area=${MIN_ISLAND}`);
  execFileSync(MAPSHAPER[0], [...MAPSHAPER.slice(1), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  const features = readJson(outFile).features.map((f) => ({ ...f, geometry: roundGeometry(f.geometry, DECIMALS) }));
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));
  assertNoAntimeridianJumps(features);
  return features;
}

// Neighbour graph: ids whose rounded rings share at least one vertex (a shared border, or a
// corner). Returns Map id -> Map of neighbour id -> number of shared vertices.
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
  const adj = new Map(features.map((f) => [f.properties.id, new Map()]));
  for (const ids of owners.values()) {
    for (const a of ids) for (const b of ids) if (a !== b) adj.get(a).set(b, (adj.get(a).get(b) || 0) + 1);
  }
  return adj;
}

// The simplified shapes must have the same neighbours as the raw ones, and every shared border
// (>= 2 common vertices raw) must still be a shared border: that is what "gap-free" means here,
// since mapshaper keeps one arc per border and both sides reference it.
function checkTopology(rawAdj, adj) {
  for (const [id, rawN] of rawAdj) {
    const n = adj.get(id);
    for (const [o, k] of rawN) {
      if (!n.has(o)) throw new Error(`${id} and ${o} touch in the raw data but not after simplification`);
      if (k >= 2 && n.get(o) < 2) throw new Error(`${id} and ${o} lost their shared border`);
    }
    for (const o of n.keys()) if (!rawN.has(o)) throw new Error(`${id} and ${o} touch only after simplification`);
  }
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
      const used = new Set([...adj.get(id).keys()].map((o) => col.get(o)).filter((c) => c !== undefined));
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
// 2. Capitals and Chinese names from Wikidata
// ---------------------------------------------------------------------------

const ZH = ['zh-hans', 'zh-cn', 'zh']; // label languages, in order of preference
const simplifyLatin = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').toLowerCase();
const stripSuffix = (label, short, suffixes) => label.startsWith(short) && suffixes.includes(label.slice(short.length));

// Map id -> {lat, lon}; throws when Wikidata disagrees with the curation table.
async function capitalCoords(features) {
  const qids = features.map((f) => f.properties.wikidata);
  if (qids.some((q) => !/^Q\d+$/.test(q || ''))) throw new Error('feature without wikidataid');
  const query = `SELECT ?adm ?admZh ?admCoord ?cap ?capEn ?capZh ?capCoord WHERE {
    VALUES ?adm { ${qids.map((q) => 'wd:' + q).join(' ')} }
    OPTIONAL { ?adm wdt:P625 ?admCoord }
    OPTIONAL { ?adm rdfs:label ?admZh FILTER(lang(?admZh) IN (${ZH.map((l) => `"${l}"`).join(', ')})) }
    OPTIONAL { ?adm wdt:P36 ?cap .
      OPTIONAL { ?cap wdt:P625 ?capCoord }
      OPTIONAL { ?cap rdfs:label ?capEn FILTER(lang(?capEn) = "en") }
      OPTIONAL { ?cap rdfs:label ?capZh FILTER(lang(?capZh) IN (${ZH.map((l) => `"${l}"`).join(', ')})) } }
  }`;
  const file = await download(`${SRC.sparql}?format=json&query=${encodeURIComponent(query)}`, 'wikidata-sub-capitals-cn.json', { headers: { Accept: 'application/sparql-results+json' } });
  const point = (v) => {
    const m = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(v);
    if (!m) throw new Error(`bad coordinate ${v}`);
    return { lon: +m[1], lat: +m[2] };
  };
  // Rows are a cross product over the optional labels; collect per province and per capital.
  const byAdm = new Map();
  for (const b of readJson(file).results.bindings) {
    const adm = b.adm.value.split('/').pop();
    const a = byAdm.get(adm) ?? byAdm.set(adm, { zh: {}, coord: b.admCoord && point(b.admCoord.value), caps: new Map() }).get(adm);
    if (b.admZh) a.zh[b.admZh['xml:lang']] = b.admZh.value;
    if (!b.cap) continue;
    const cap = b.cap.value.split('/').pop();
    const c = a.caps.get(cap) ?? a.caps.set(cap, { en: b.capEn?.value, zh: {}, coord: b.capCoord && point(b.capCoord.value) }).get(cap);
    if (b.capZh) c.zh[b.capZh['xml:lang']] = b.capZh.value;
  }
  const zhLabel = (labels) => ZH.map((l) => labels[l]).find(Boolean);

  const out = new Map();
  for (const f of features) {
    const { id, wikidata, nameZh } = f.properties;
    const code = id.slice(3).toUpperCase();
    const [name, local, capital, capitalLocal] = PROVINCES[code];
    const a = byAdm.get(wikidata);
    if (!a) throw new Error(`${id}: ${wikidata} not on Wikidata`);
    const admZh = zhLabel(a.zh);
    if (!admZh || !stripSuffix(admZh, local, PROVINCE_SUFFIXES)) throw new Error(`${id}: Wikidata calls ${wikidata} "${admZh}", table says "${local}"`);
    if (!stripSuffix(nameZh || '', local, PROVINCE_SUFFIXES)) throw new Error(`${id}: Natural Earth calls it "${nameZh}", table says "${local}"`);

    let caps = [...a.caps.keys()];
    if (caps.length > 1) {
      if (!CAPITAL_QID[id]) throw new Error(`${id}: several capitals on Wikidata (${caps.join(', ')}), add CAPITAL_QID`);
      caps = caps.filter((q) => q === CAPITAL_QID[id]);
    }
    let pos;
    if (MUNICIPALITIES.has(code)) {
      if (capital !== name || capitalLocal !== local) throw new Error(`${id}: a municipality is its own capital`);
      if (!a.coord) throw new Error(`${id}: no coordinates on Wikidata (${wikidata})`);
      pos = a.coord;
    } else {
      if (!caps.length) throw new Error(`${id}: no capital on Wikidata (${wikidata})`);
      const c = a.caps.get(caps[0]);
      if (!c.coord) throw new Error(`${id}: capital ${caps[0]} has no coordinates on Wikidata`);
      if (simplifyLatin(c.en || '') !== simplifyLatin(capital)) throw new Error(`${id}: Wikidata's capital is "${c.en}" (${caps[0]}), table says "${capital}"`);
      const capZh = zhLabel(c.zh);
      if (!capZh || !stripSuffix(capZh, capitalLocal, CAPITAL_SUFFIXES)) throw new Error(`${id}: Wikidata calls the capital "${capZh}", table says "${capitalLocal}"`);
      pos = c.coord;
    }
    if (!nearGeometry([pos.lon, pos.lat], f.geometry)) throw new Error(`${id}: capital ${pos.lat},${pos.lon} is outside its shape`);
    out.set(id, [round3(pos.lat), round3(pos.lon)]);
  }
  return out;
}

// Inside the geometry, or within `km` of its outline (coastal capitals and the simplified coastline).
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
// 3. Output
// ---------------------------------------------------------------------------

// Add or replace this set's entry in data/sub/index.json, leaving the other entries (written by
// other build scripts, possibly at the same time) untouched; the file is read right before writing.
function updateIndex(entry) {
  const file = path.join(DATA_DIR, 'index.json');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]';
  const index = JSON.parse(text);
  const i = index.findIndex((e) => e.id === entry.id);
  if (i >= 0) index[i] = entry; else index.push(entry);
  const pretty = /^\[\n \{/.test(text); // keep the file's layout: JSON.stringify(_, null, 1) or one entry per line
  writeIfChanged(file, pretty ? JSON.stringify(index, null, 1) + '\n' : '[\n' + index.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');
}

function validate(rows, fc, adj) {
  const n = Object.keys(PROVINCES).length;
  if (rows.length !== n) throw new Error(`cn: ${rows.length} entries, expected ${n}`);
  const geom = new Map(fc.features.map((f) => [f.properties.id, f.geometry]));
  if (geom.size !== n) throw new Error(`cn: ${geom.size} shapes, expected ${n}`);
  const colour = new Map(rows.map((e) => [e.id, e.color]));
  const cjk = /^[一-鿿]+$/;
  for (const e of rows) {
    const g = geom.get(e.id);
    if (!g) throw new Error(`${e.id}: no geometry`);
    if (!/^cn-[a-z]{2}$/.test(e.id)) throw new Error(`${e.id}: bad id`);
    if (!cjk.test(e.local) || !cjk.test(e.capitalLocal)) throw new Error(`${e.id}: local names must be Chinese`);
    if (e.flag !== null) throw new Error(`${e.id}: flag must be null`);
    if (!pointInGeometry([e.fx, e.fy], g)) throw new Error(`${e.id}: fx/fy outside`);
    if (!nearGeometry([e.lon, e.lat], g)) throw new Error(`${e.id}: capital outside`);
    for (const o of adj.get(e.id).keys()) if (colour.get(o) === e.color) throw new Error(`${e.id} and ${o} are neighbours with the same colour`);
    if (!/^#[0-9a-f]{6}$/.test(e.color)) throw new Error(`${e.id}: bad colour`);
  }
  assertNoAntimeridianJumps(fc.features);
  for (const f of fc.features) {
    if (Object.keys(f.properties).join() !== 'id') throw new Error(`${f.properties.id}: properties must be {id}`);
    for (const poly of polygonsOf(f.geometry)) if (ringArea(poly[0]) === 0) throw new Error(`${f.properties.id}: degenerate ring`);
    for (const poly of polygonsOf(f.geometry)) for (const ring of poly) for (const [x, y] of ring) {
      if (round3(x) !== x || round3(y) !== y) throw new Error(`${f.properties.id}: coordinate with more than ${DECIMALS} decimals`);
    }
  }
  const index = readJson(path.join(DATA_DIR, 'index.json'));
  if (index.filter((e) => e.id === SET.id).length !== 1) throw new Error('index.json: cn entry missing or duplicated');
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // shapes: extract, simplify, round
  const ne = readJson(await download(SRC.ne10, path.basename(SRC.ne10)));
  const raw = rawShapes(ne);
  const rawFile = path.join(CACHE, 'cn-raw.geojson');
  const simplifiedFile = path.join(CACHE, 'cn-simplified.geojson');
  writeIfChanged(rawFile, JSON.stringify({ type: 'FeatureCollection', features: raw }));
  const features = simplify(rawFile, simplifiedFile);
  if (features.length !== raw.length) throw new Error(`cn: ${features.length} shapes after simplification, expected ${raw.length}`);
  const rawAdj = adjacency(raw.map((f) => ({ ...f, geometry: roundGeometry(f.geometry, DECIMALS) })));
  const adj = adjacency(features);
  checkTopology(rawAdj, adj);
  const { n: nColours, col } = colourGraph(adj);

  // capitals
  const coords = await capitalCoords(features);

  const entries = [];
  for (const f of features) {
    const id = f.properties.id;
    const [name, local, capital, capitalLocal] = PROVINCES[id.slice(3).toUpperCase()];
    const [lat, lon] = coords.get(id);
    const [fx, fy] = flagPoint(f.geometry).map(round3);
    if (!pointInGeometry([fx, fy], f.geometry)) throw new Error(`${id}: flag point outside its shape`);
    entries.push({ id, name, local, capital, capitalLocal, lat, lon, fx, fy, color: PALETTE[col.get(id)], flag: null });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  // geojson (properties: only id)
  const fc = { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: { id: f.properties.id }, geometry: f.geometry })) };
  const geoPath = path.join(DATA_DIR, 'cn.geojson');
  writeIfChanged(geoPath, JSON.stringify(fc));
  const geoBytes = fs.statSync(geoPath).size;
  if (geoBytes > 400_000) console.warn(`  warning: cn.geojson is ${geoBytes} bytes (> 400 KB), lower SIMPLIFY`);

  // json
  const jsonPath = path.join(DATA_DIR, 'cn.json');
  writeIfChanged(jsonPath, '[\n' + entries.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');

  // index
  updateIndex({ id: SET.id, name: SET.name, kind: SET.kind, kinds: SET.kinds, label: SET.label, count: entries.length });

  validate(entries, fc, adj);
  const nPolys = features.reduce((s, f) => s + polygonsOf(f.geometry).length, 0);
  const nVerts = features.reduce((s, f) => s + polygonsOf(f.geometry).reduce((t, p) => t + p.reduce((u, r) => u + r.length, 0), 0), 0);
  console.log(`cn: ${entries.length} ${SET.kinds}, ${nColours} colours, cn.geojson ${geoBytes} B (${nPolys} polygons, ${nVerts} vertices), cn.json ${fs.statSync(jsonPath).size} B, no flags`);
}

main().catch((e) => { console.error(e); process.exit(1); });
