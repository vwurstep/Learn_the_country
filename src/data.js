/* Data access: loads the country list, shapes and summaries. No DOM or map code here.
   Learning progress lives in store.js. Schema of data/countries.json:
   {id: 'fr', name, capital, lat, lon (of the capital), fx, fy (flag spot, mid-country), continent,
   sovereign}. data/info.json: {id: {about, dates: [[year, event]], known: [..]}} (loaded lazily). */

export const CONTINENTS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];

export const flagUrl = (id) => `flags/${id}.svg`;

export async function loadData() {
  const [countries, world] = await Promise.all([
    fetch('data/countries.json').then((r) => r.json()),
    fetch('data/world.geojson').then((r) => r.json()),
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
  return { countries, byId, world };
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
