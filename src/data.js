/* Data access: loads the country list, shapes and summaries. No DOM or map code here.
   Learning progress lives in store.js. Schema of data/countries.json:
   {id: 'fr', name, capital, lat, lon (of the capital), fx, fy (flag spot, mid-country), continent,
   sovereign}. data/colors.json: {id: {c: national colour hex, alt?, why}}. data/info.json: {id: {about, dates: [[year, event]], known: [..]}} (loaded lazily). */

export const CONTINENTS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];

export const flagUrl = (id) => `flags/${id}.svg`;
/** flag image of a country or a subdivision (those carry their own path, svg or png, or null
    when the place has no official flag, e.g. Chinese and South African provinces) */
export const flagOf = (c) => (c.flag === undefined ? flagUrl(c.id) : c.flag);

export async function loadData() {
  const [countries, world, colors] = await Promise.all([
    fetch('data/countries.json').then((r) => r.json()),
    fetch('data/world.geojson').then((r) => r.json()),
    fetch('data/colors.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]);
  const byId = new Map(countries.map((c) => [c.id, c]));
  // rough on-screen size of each country (bbox area in degrees²), used to give big countries
  // priority when flags would overlap; countries without a polygon get 0
  const size = new Map();
  for (const f of world.features) {
    const id = f.properties.id;
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const [x, y] of poly[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    size.set(id, Math.max(size.get(id) || 0, (x1 - x0) * (y1 - y0)));
  }
  for (const c of countries) c.size = size.get(c.id) || 0;
  return { countries, byId, world, colors };
}

// ---- settings (per device) ------------------------------------------------------------
export function loadSetting(name, fallback) {
  try { const v = JSON.parse(localStorage.getItem('ltc.' + name)); return v ?? fallback; } catch { return fallback; }
}
export function saveSetting(name, value) {
  try { localStorage.setItem('ltc.' + name, JSON.stringify(value)); } catch {}
}

let info = null;
/** Country summaries, loaded on first use. */
export async function loadInfo() {
  if (!info) info = fetch('data/info.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return info;
}

// ---- subdivisions (deep dive into a country) ---------------------------------------------
// data/sub/index.json: [{id: 'us', name, kind: 'state', kinds: 'states', label?}];
// data/sub/<id>.json: [{id: 'us-ca', name, capital, lat, lon, fx, fy, color, flag (or null),
//   local?, capitalLocal? (names in the local language/script, e.g. 广东 / 广州)}];
// data/sub/<id>.geojson: shapes with properties.id.
let subIndex = null;
export async function loadSubIndex() {
  if (!subIndex) subIndex = fetch('data/sub/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return subIndex;
}
const subCache = new Map();
export function loadSub(id) {
  if (!subCache.has(id)) {
    subCache.set(id, Promise.all([
      fetch(`data/sub/${id}.json`).then((r) => r.json()),
      fetch(`data/sub/${id}.geojson`).then((r) => r.json()),
    ]).then(([items, geo]) => {
      const size = new Map();
      for (const f of geo.features) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
        for (const poly of polys) for (const [x, y] of poly[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        size.set(f.properties.id, (x1 - x0) * (y1 - y0));
      }
      for (const c of items) c.size = size.get(c.id) || 0;
      return { items, geo, byId: new Map(items.map((c) => [c.id, c])) };
    }).catch((e) => { subCache.delete(id); throw e; }));
  }
  return subCache.get(id);
}
