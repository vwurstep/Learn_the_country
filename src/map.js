/* World map: MapLibre GL with only our own country shapes (no tiles, no roads, no labels from
   a tile server), plus HTML markers at each capital (dot + flag + name). Knows the data schema
   from data.js but nothing about panels or quiz rules. */
import { flagUrl } from './data.js';

const OCEAN = '#a9cbe0', SPACE = '#0e1726', BORDER = '#ffffff';
// fallback land colours (by hash of the id) for shapes without a national colour
const LAND = ['#e8dcb5', '#d5e3b5', '#f0c9a8', '#cfd9c0', '#e9d1d9', '#d8cfe8'];
const MARK = { sel: '#f2a541', right: '#4caf6a', wrong: '#e0574f', target: '#4caf6a' };

export const REGION_VIEWS = {
  World:           { center: [10, 25], zoom: 1.5 },
  Africa:          { center: [18, 2], zoom: 2.4 },
  Asia:            { center: [90, 30], zoom: 2.0 },
  Europe:          { center: [15, 52], zoom: 3.0 },
  'North America': { center: [-90, 35], zoom: 2.0 },
  'South America': { center: [-60, -20], zoom: 2.4 },
  Oceania:         { center: [150, -15], zoom: 2.4 },
};

// screen boxes (px, relative to the capital point) used to stop flags/names overlapping
const FLAG_W = { 1: 18, 2: 22, 3: 28, 4: 34 };
const LABEL_FROM_ZOOM = 2.6;

// national colours are drawn as tints (mixed with white) so borders, flags and labels stay readable
const TINT = 0.5;
function tint(hex, t = TINT) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0');
  return '#' + ch(n >> 16) + ch((n >> 8) & 255) + ch(n & 255);
}
const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const toRad = (d) => (d * Math.PI) / 180;
function angularDistance([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a))) * 180) / Math.PI;
}

/** Box to zoom to for a country: its biggest part plus the parts near it (Corsica, Java…),
    leaving out far-away territories (French Guiana for France, Alaska/Hawaii for the USA). */
function bboxOf(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const parts = polys.map((p) => {
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
    for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return { b: [x0, y0, x1, y1], cx, cy, area: (x1 - x0) * (y1 - y0) * Math.cos(toRad(cy)) };
  });
  // start from the biggest part and keep adding parts within 20° of one already added, so
  // island chains (Indonesia) stay together while far-away territories drop out
  const dist = (a, b) => Math.hypot((a.cx - b.cx) * Math.cos(toRad((a.cy + b.cy) / 2)), a.cy - b.cy);
  const near = [parts.reduce((a, b) => (b.area > a.area ? b : a))];
  for (let grew = true; grew;) {
    grew = false;
    for (const p of parts) if (!near.includes(p) && near.some((q) => dist(p, q) <= 20)) { near.push(p); grew = true; }
  }
  return [Math.min(...near.map((p) => p.b[0])), Math.min(...near.map((p) => p.b[1])),
          Math.max(...near.map((p) => p.b[2])), Math.max(...near.map((p) => p.b[3]))];
}

/** Country outlines as lines, without the artificial edges where shapes are cut at the date
    line (±180°) or run along the south pole: those would show up as seams on the globe. */
function borderLines(world) {
  const cut = (a, b) => (Math.abs(a[0]) >= 179.99 && Math.abs(b[0]) >= 179.99) || (a[1] <= -89.99 && b[1] <= -89.99);
  const lines = [];
  for (const f of world.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) {
      let cur = [ring[0]];
      for (let i = 1; i < ring.length; i++) {
        if (cut(ring[i - 1], ring[i])) { if (cur.length > 1) lines.push(cur); cur = [ring[i]]; }
        else cur.push(ring[i]);
      }
      if (cur.length > 1) lines.push(cur);
    }
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

export function createMap(el, { countries, world, colors = {}, projection = 'globe', onClick }) {
  for (const f of world.features) {
    const nat = colors[f.properties.id]?.c;
    f.properties.col = nat ? tint(nat) : LAND[hash(f.properties.id) % LAND.length];
  }
  const bboxes = new Map(world.features.map((f) => [f.properties.id, bboxOf(f.geometry)]));

  const markState = ['coalesce', ['feature-state', 'mark'], ''];
  const map = new maplibregl.Map({
    container: el,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
    maxZoom: 9,
    ...REGION_VIEWS.World,
    style: {
      version: 8,
      projection: { type: projection },
      sources: {
        world: { type: 'geojson', data: world, promoteId: 'id' },
        borders: { type: 'geojson', data: borderLines(world) },
      },
      layers: [
        { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
        {
          id: 'land', type: 'fill', source: 'world',
          paint: {
            'fill-color': ['match', markState,
              'sel', MARK.sel, 'right', MARK.right, 'wrong', MARK.wrong, 'target', MARK.target,
              ['get', 'col']],
          },
        },
        {
          id: 'border', type: 'line', source: 'borders',
          paint: { 'line-color': BORDER, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 4, 1.2, 8, 2] },
        },
        {
          // bold outline for selected / quiz-marked countries (their fill alone can blend in
          // with a similar national colour)
          id: 'mark-line', type: 'line', source: 'world',
          paint: {
            'line-color': ['match', markState, 'sel', '#c77700', 'right', '#1e7a3c', 'target', '#1e7a3c', 'wrong', '#b3261e', 'rgba(0,0,0,0)'],
            'line-width': ['match', markState, '', 0, 2.5],
          },
        },
      ],
    },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  el.style.background = SPACE;

  // ---- markers: a flag in the middle of each country, a dot + name at its capital ------------
  const markers = new Map();  // id -> {country, flag, cap} (each {el, marker, on})
  const mk = (el, lngLat) => ({ el, on: false,
    marker: new maplibregl.Marker({ element: el, anchor: 'center', opacity: '1', opacityWhenCovered: '0' }).setLngLat(lngLat) });
  for (const c of countries) {
    const f = document.createElement('img');
    f.className = 'flagpin';
    f.alt = '';
    f.loading = 'lazy';
    f.src = flagUrl(c.id);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.innerHTML = '<i class="dot"></i><span class="lbl"></span>';
    cap.querySelector('.lbl').textContent = c.capital;
    for (const el of [f, cap]) el.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(c.id, true); });
    markers.set(c.id, { country: c, flag: mk(f, [c.fx ?? c.lon, c.fy ?? c.lat]), cap: mk(cap, [c.lon, c.lat]) });
  }
  let showAll = false, only = null, selected = null, dotsOnly = false;
  const order = countries.slice().sort((a, b) => (b.sovereign - a.sovereign) || (b.size - a.size));

  // Greedy declutter: big countries first; a flag or a name is only shown where it has room.
  // Capital dots give way to flags when zoomed out; they reappear as the map is zoomed in.
  let raf = 0;
  function layout() {
    raf = 0;
    const z = map.getZoom();
    const fw = FLAG_W[Math.max(1, Math.min(4, Math.floor(z)))];
    const fh = Math.round(fw * 0.75);
    el.style.setProperty('--flag-w', fw + 'px');
    const center = map.getCenter().toArray();
    const globe = map.getProjection()?.type === 'globe';
    const taken = [];
    const free = (b) => !taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
    const list = selected ? [markers.get(selected)?.country, ...order].filter(Boolean) : order;
    const seen = new Set();
    // pass 1: flags; pass 2: capital dots (hidden while they'd sit on a flag) and names
    const shown = [];
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const m = markers.get(c.id);
      const want = showAll || (only && only.has(c.id));
      const force = !showAll || c.id === selected;  // quiz feedback / selection: always show
      if (dotsOnly) {  // self-test on the map: capital positions only, no flags, no names
        setOn(m.flag, false);
        if (want) shown.push([c, m, false]);
        else setOn(m.cap, false);
        continue;
      }
      const fp = [c.fx ?? c.lon, c.fy ?? c.lat];
      if (want && !(globe && angularDistance(center, fp) > 75)) {
        const p = map.project(fp);
        const box = [p.x - fw / 2 - 1, p.y - fh / 2 - 1, p.x + fw / 2 + 1, p.y + fh / 2 + 1];
        const show = force || free(box);
        if (show) taken.push(box);
        setOn(m.flag, show);
      } else setOn(m.flag, false);
      m.flag.el.classList.toggle('sel', c.id === selected);
      if (want) shown.push([c, m, force]);
      else setOn(m.cap, false);
    }
    for (const [c, m, force] of shown) {
      const capOk = !(globe && angularDistance(center, [c.lon, c.lat]) > 75);
      const p = capOk && map.project([c.lon, c.lat]);
      const dot = p && [p.x - 5, p.y - 5, p.x + 5, p.y + 5];
      const showDot = capOk && (force || dotsOnly || free(dot));
      setOn(m.cap, showDot);
      if (!showDot) continue;
      taken.push(dot);
      const lw = c.capital.length * 6.4 + 8;
      const label = [p.x + 5, p.y - 7, p.x + 5 + lw, p.y + 7];
      const showLabel = !dotsOnly && (z >= LABEL_FROM_ZOOM || force) && free(label);
      if (showLabel) taken.push(label);
      m.cap.el.classList.toggle('nolabel', !showLabel);
      m.cap.el.classList.toggle('sel', c.id === selected);
    }
  }
  function setOn(m, on) {
    if (m.on === on) return;
    m.on = on;
    on ? m.marker.addTo(map) : m.marker.remove();
  }
  const relayout = () => { if (!raf) raf = requestAnimationFrame(layout); };
  map.on('move', relayout);
  map.on('load', relayout);

  // ---- clicks ---------------------------------------------------------------------------
  // A tap hits a country if its shape is under the finger; tiny countries also count when the
  // tap is within a few px of their shape or of their capital dot.
  function hitTest(point, pad = 0) {
    const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
    return [...new Set(map.queryRenderedFeatures(pad ? box : point, { layers: ['land'] }).map((f) => f.properties.id))];
  }
  function nearestCapital(point, maxPx) {
    let best = null, bd = maxPx;
    const center = map.getCenter().toArray();
    for (const c of countries) {
      if (map.getProjection()?.type === 'globe' && angularDistance(center, [c.lon, c.lat]) > 80) continue;
      const p = map.project([c.lon, c.lat]);
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bd) { bd = d; best = c.id; }
    }
    return best;
  }
  map.on('click', (e) => {
    const under = hitTest(e.point)[0];
    onClick?.(under || nearestCapital(e.point, 14) || null, false, e.point);
  });

  const setMark = (id, mark) => {
    if (!bboxes.has(id)) return;
    map.setFeatureState({ source: 'world', id }, { mark });
  };
  let marked = [];

  return {
    map,
    hitTest,
    nearestCapital,
    /** show all markers (explore) or only some ids (quiz feedback); dots: capital dots only */
    setMarkers(all, onlyIds = null, { dots = false } = {}) { showAll = all; only = onlyIds ? new Set(onlyIds) : null; dotsOnly = dots; relayout(); },
    select(id) {
      for (const x of marked) setMark(x, null);
      marked = [];
      selected = id;
      if (id) { setMark(id, 'sel'); marked.push(id); }
      relayout();
    },
    /** colour countries: marks = {id: 'right'|'wrong'|'target'} */
    mark(marks) {
      for (const x of marked) setMark(x, null);
      marked = Object.keys(marks);
      selected = null;
      for (const [id, m] of Object.entries(marks)) setMark(id, m);
      relayout();
    },
    /** context: zoom out to show the neighbours too (for "which country is this?") */
    flyToCountry(c, { maxZoom = 5, context = false } = {}) {
      let b = bboxes.get(c.id);
      if (!b || b[2] - b[0] > 150) {  // no shape, or spans the date line (Russia, Fiji, USA…)
        map.flyTo({ center: [c.fx ?? c.lon, c.fy ?? c.lat], zoom: context ? (b ? 2 : 4) : Math.max(map.getZoom(), 3), duration: 900 });
        return;
      }
      if (context) {
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        // room around it for the neighbours: generous for small countries, capped for big ones
        const bw = b[2] - b[0], bh = b[3] - b[1];
        const w = Math.max(bw + Math.min(bw * 1.1, 30), 14), h = Math.max(bh + Math.min(bh * 1.1, 20), 9);
        b = [cx - w / 2, Math.max(-80, cy - h / 2), cx + w / 2, Math.min(84, cy + h / 2)];
      }
      const pad = Math.min(80, el.clientWidth / 6);
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
        padding: { top: pad, left: pad, right: pad, bottom: Math.max(pad, el.clientHeight * 0.4) },
        maxZoom, duration: 900,
      });
    },
    flyToRegion(region) {
      const v = REGION_VIEWS[region] || REGION_VIEWS.World;
      map.flyTo({ ...v, duration: 900 });
    },
    setProjection(type) { map.setProjection({ type }); relayout(); },
    hasShape: (id) => bboxes.has(id),
  };
}
