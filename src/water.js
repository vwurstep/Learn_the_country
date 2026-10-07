/* "Rivers & lakes" mode (experimental, 2026-10-07). Everything specific to it lives here plus a
   few hooks in app.js marked `water`; see CLAUDE.md for how to remove it.
   data/water.geojson: lakes + rivers (features with an `id` are learnable); data/water.json:
   [{id, name, kind: river|lake, z, lon, lat (label point), countries, continents}]. */

let loading = null;
/** [items, geo], loaded once (the geo also feeds the plain lakes layer of the country map) */
export function loadWater() {
  if (!loading) loading = Promise.all([
    fetch('data/water.json').then((r) => (r.ok ? r.json() : [])),
    fetch('data/water.geojson').then((r) => (r.ok ? r.json() : { type: 'FeatureCollection', features: [] })),
  ]).catch(() => { loading = null; return [[], { type: 'FeatureCollection', features: [] }]; });
  return loading;
}

/** The set the app's scope machinery works with (like a deep dive). */
export async function waterSet(countryById) {
  const [raw, geo] = await loadWater();
  const items = raw.map((w) => {
    const where = w.countries.map((id) => countryById.get(id)?.name).filter(Boolean);
    return {
      ...w, capital: null, flag: null, fx: w.lon, fy: w.lat,
      size: 10 - w.z,  // bigger first when labels compete for room
      desc: `${w.kind === 'river' ? 'River' : 'Lake'} · ${where.slice(0, 5).join(', ')}${where.length > 5 ? ', …' : ''}`,
    };
  });
  return { id: 'water', name: 'Rivers & lakes', kind: 'river or lake', kinds: 'rivers and lakes', label: 'Rivers & lakes',
    items, byId: new Map(items.map((c) => [c.id, c])), geo, noCapital: true, water: true };
}

// quiz pool filters (setup chips)
export const WATER_LEVELS = [[3, 'Major'], [4, 'More'], [5, 'All']];
export const WATER_KINDS = [['river', 'Rivers'], ['lake', 'Lakes']];
/** regions: continents ([] = world); kinds: ['river', 'lake']; level: max z */
export const waterPool = (items, { regions = [], waterKinds = ['river', 'lake'], waterLevel = 3 } = {}) =>
  items.filter((w) => w.z <= waterLevel && waterKinds.includes(w.kind) && (!regions.length || w.continents.some((c) => regions.includes(c))));
