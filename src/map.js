/* World map: MapLibre GL with only our own country shapes (no tiles, no roads, no labels from
   a tile server), plus HTML markers at each capital (dot + flag + name). Knows the data schema
   from data.js but nothing about panels or quiz rules. */
import { flagOf } from './data.js';

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
  // start from the biggest part and keep adding parts within 15° of one already added, so
  // island chains (Indonesia) stay together while far-away territories drop out
  const dist = (a, b) => Math.hypot((a.cx - b.cx) * Math.cos(toRad((a.cy + b.cy) / 2)), a.cy - b.cy);
  const near = [parts.reduce((a, b) => (b.area > a.area ? b : a))];
  for (let grew = true; grew;) {
    grew = false;
    for (const p of parts) if (!near.includes(p) && near.some((q) => dist(p, q) <= 15)) { near.push(p); grew = true; }
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

  const markState = ['coalesce', ['feature-state', 'mark'], ''];
  const fillColor = ['match', markState, 'sel', MARK.sel, 'right', MARK.right, 'wrong', MARK.wrong, 'target', MARK.target, ['get', 'col']];
  const markLine = {
    'line-color': ['match', markState, 'sel', '#c77700', 'right', '#1e7a3c', 'target', '#1e7a3c', 'wrong', '#b3261e', 'rgba(0,0,0,0)'],
    'line-width': ['match', markState, '', 0, 2.5],
  };
  const empty = { type: 'FeatureCollection', features: [] };
  const map = new maplibregl.Map({
    container: el,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
    maxZoom: 10,
    ...REGION_VIEWS.World,
    style: {
      version: 8,
      projection: { type: projection },
      sources: {
        world: { type: 'geojson', data: world, promoteId: 'id' },
        borders: { type: 'geojson', data: borderLines(world) },
        sub: { type: 'geojson', data: empty, promoteId: 'id' },  // states/cantons of a deep dive
      },
      layers: [
        { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN } },
        { id: 'land', type: 'fill', source: 'world', paint: { 'fill-color': fillColor } },
        // country borders sit below the deep-dive layers: the coarser world shapes would otherwise
        // draw stray lines across states/cantons (e.g. through Lake Constance)
        { id: 'border', type: 'line', source: 'borders', paint: { 'line-color': BORDER, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 4, 1.2, 8, 2] } },
        // deep dive: every other country fades to grey
        { id: 'dim', type: 'fill', source: 'world', layout: { visibility: 'none' }, paint: { 'fill-color': '#e9ecf0', 'fill-opacity': 0.8 } },
        { id: 'sub-fill', type: 'fill', source: 'sub', layout: { visibility: 'none' }, paint: { 'fill-color': fillColor } },
        { id: 'sub-border', type: 'line', source: 'sub', layout: { visibility: 'none' }, paint: { 'line-color': BORDER, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.5] } },
        // bold outline for selected / quiz-marked places (their fill alone can blend in with a
        // similar colour)
        { id: 'mark-line', type: 'line', source: 'world', paint: markLine },
        { id: 'sub-mark-line', type: 'line', source: 'sub', layout: { visibility: 'none' }, paint: markLine },
      ],
    },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  el.style.background = SPACE;

  // ---- sets ------------------------------------------------------------------------------
  // A set is what the map shows markers for and answers taps with: the world's countries, or
  // the subdivisions of one country (deep dive). Items: {id, capital, lat, lon, fx, fy, size,
  // flag?, sovereign?}.
  const sets = new Map();
  let cur = null;
  function makeSet(id, items, geo, opts) {
    const markers = new Map();  // id -> {item, flag, cap} (each {el, marker, on})
    const mk = (node, lngLat) => ({ el: node, on: false,
      marker: new maplibregl.Marker({ element: node, anchor: 'center', opacity: '1', opacityWhenCovered: '0' }).setLngLat(lngLat) });
    for (const c of items) {
      // the pin in the middle: the flag, or (no flag) the local name, e.g. 广东; or nothing
      let f = null;
      if (flagOf(c)) {
        f = document.createElement('img');
        f.className = 'flagpin';
        f.alt = '';
        f.loading = 'lazy';
        f.src = flagOf(c);
      } else if (c.local) {
        f = document.createElement('span');
        f.className = 'flagpin namepin';
        f.textContent = c.local;
      }
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.innerHTML = '<i class="dot"></i><span class="lbl"></span>';
      cap.querySelector('.lbl').textContent = c.capital;
      for (const node of [f, cap].filter(Boolean)) node.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(c.id, true); });
      markers.set(c.id, { item: c, flag: f && mk(f, [c.fx ?? c.lon, c.fy ?? c.lat]), cap: mk(cap, [c.lon, c.lat]) });
    }
    const bboxes = new Map(geo.features.map((f) => [f.properties.id, bboxOf(f.geometry)]));
    const all = [...bboxes.values()];
    const extent = all.length ? [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])),
      Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))] : null;
    const order = items.slice().sort((a, b) => (!!b.sovereign - !!a.sovereign) || (b.size - a.size));
    sets.set(id, { id, items, geo, markers, bboxes, extent, order, ...opts });
  }
  makeSet('world', countries, world, {
    source: 'world', fill: 'land', labelZoom: LABEL_FROM_ZOOM, maxZoom: 5, ctxZoom: 6, minCtx: [14, 9], flagScale: 1,
  });
  cur = sets.get('world');

  let showAll = false, only = null, selected = null, dotsOnly = false;

  // Greedy declutter: big places first; a flag or a name is only shown where it has room.
  // Capital dots give way to flags when zoomed out; they reappear as the map is zoomed in.
  let raf = 0;
  function layout() {
    raf = 0;
    const z = map.getZoom();
    const fw = Math.round(FLAG_W[Math.max(1, Math.min(4, Math.floor(z)))] * cur.flagScale);
    el.style.setProperty('--flag-w', fw + 'px');
    const center = map.getCenter().toArray();
    const globe = map.getProjection()?.type === 'globe';
    const taken = [];
    const free = (b) => !taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
    const { markers, order } = cur;
    const list = selected ? [markers.get(selected)?.item, ...order].filter(Boolean) : order;
    const seen = new Set();
    // pass 1: flags; pass 2: capital dots (hidden while they'd sit on a flag) and names
    const shown = [];
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const m = markers.get(c.id);
      const want = showAll || (only && only.has(c.id));
      const force = !showAll || c.id === selected;  // quiz feedback / selection: always show
      if (dotsOnly || !m.flag) {  // self-test (capital positions only), or nothing to pin mid-place
        setOn(m.flag, false);
        if (want) shown.push([c, m, dotsOnly ? false : force]);  // still forced for quiz feedback
        else setOn(m.cap, false);
        continue;
      }
      const fp = [c.fx ?? c.lon, c.fy ?? c.lat];
      if (want && !(globe && angularDistance(center, fp) > 75)) {
        const p = map.project(fp);
        const img = m.flag.el, name = img.tagName !== 'IMG';
        const ar = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.75;
        const w = name ? c.local.length * 14 + 12 : fw, h = name ? 22 : Math.round(fw * ar);  // name pin: 13px text
        const box = [p.x - w / 2 - 1, p.y - h / 2 - 1, p.x + w / 2 + 1, p.y + h / 2 + 1];
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
      const showLabel = !dotsOnly && (z >= cur.labelZoom || force) && free(label);
      if (showLabel) taken.push(label);
      m.cap.el.classList.toggle('nolabel', !showLabel);
      m.cap.el.classList.toggle('sel', c.id === selected);
    }
  }
  function setOn(m, on) {
    if (!m || m.on === on) return;
    m.on = on;
    on ? m.marker.addTo(map) : m.marker.remove();
  }
  const relayout = () => { if (!raf) raf = requestAnimationFrame(layout); };
  map.on('move', relayout);
  map.on('load', relayout);

  // ---- clicks ---------------------------------------------------------------------------
  // A tap hits a place if its shape is under the finger; tiny ones also count when the tap is
  // within a few px of their shape or of their capital dot.
  function hitTest(point, pad = 0) {
    const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
    return [...new Set(map.queryRenderedFeatures(pad ? box : point, { layers: [cur.fill] }).map((f) => f.properties.id))];
  }
  function nearestCapital(point, maxPx) {
    let best = null, bd = maxPx;
    const center = map.getCenter().toArray();
    for (const c of cur.items) {
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

  let marked = [];
  const setMark = (id, mark) => {
    if (!cur.bboxes.has(id)) return;
    map.setFeatureState({ source: cur.source, id }, { mark });
  };
  const clearMarks = () => { for (const x of marked) setMark(x, null); marked = []; };

  // Fit a box [x0, y0, x1, y1] on screen. MapLibre's fitBounds drifts on the globe away from
  // the equator (South Africa ended up near the top), so only its zoom is used and the camera
  // is centred on the middle of the box (inside the padded area).
  const fitBox = ([x0, y0, x1, y1], pad, maxZoom) => {
    const cam = map.cameraForBounds([[x0, y0], [x1, y1]], { padding: pad, maxZoom });
    map.flyTo({ center: [(x0 + x1) / 2, (y0 + y1) / 2], zoom: cam?.zoom ?? map.getZoom(), padding: pad, duration: 900 });
  };
  const padding = () => {
    const pad = Math.min(80, el.clientWidth / 6);
    return { top: pad, left: pad, right: pad, bottom: Math.max(pad, el.clientHeight * 0.4) };
  };

  return {
    map,
    hitTest,
    nearestCapital,
    /** Register the subdivisions of a country (deep dive). items as for countries, flag paths
        in item.flag, colours in item.color (tinted here). */
    addSubdivisions(id, items, geo) {
      if (sets.has(id)) return;
      const color = new Map(items.map((c) => [c.id, c.color]));
      for (const f of geo.features) f.properties.col = color.get(f.properties.id) ? tint(color.get(f.properties.id)) : LAND[hash(f.properties.id) % LAND.length];
      // smaller flags: subdivisions are small and their flags often square
      makeSet(id, items, geo, { source: 'sub', fill: 'sub-fill', labelZoom: 0, maxZoom: 9, ctxZoom: 9, parent: id, flagScale: 0.8 });
      const s = sets.get(id), [x0, y0, x1, y1] = s.extent;
      s.minCtx = [Math.min(14, (x1 - x0) * 0.4), Math.min(9, (y1 - y0) * 0.4)];
      // core: the places within 30° of the median flag point, i.e. without far-away parts like
      // Alaska and Hawaii, so the explore view isn't zoomed out to half the globe
      const med = (a) => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
      const mx = med(items.map((c) => c.fx)), my = med(items.map((c) => c.fy));
      const core = items.filter((c) => Math.hypot((c.fx - mx) * Math.cos(toRad(my)), c.fy - my) <= 30)
        .map((c) => s.bboxes.get(c.id)).filter(Boolean);
      s.core = [Math.min(...core.map((b) => b[0])), Math.min(...core.map((b) => b[1])),
        Math.max(...core.map((b) => b[2])), Math.max(...core.map((b) => b[3]))];
    },
    /** Switch between the world ('world') and a deep dive (a country id added before). */
    useSet(id) {
      const next = sets.get(id) || sets.get('world');
      if (next === cur) return;
      clearMarks();
      selected = null;
      for (const m of cur.markers.values()) { setOn(m.flag, false); setOn(m.cap, false); }
      cur = next;
      if (cur.source === 'sub') map.getSource('sub').setData(cur.geo);
      for (const l of ['sub-fill', 'sub-border', 'sub-mark-line']) map.setLayoutProperty(l, 'visibility', cur.source === 'sub' ? 'visible' : 'none');
      map.setLayoutProperty('dim', 'visibility', cur.parent ? 'visible' : 'none');
      // the deep-dive country's own (coarser) world shape is covered fully: where it sticks out
      // from under the finer state/canton shapes it then looks like the dimmed neighbours
      // instead of leaving slivers in its national colour along the border
      if (cur.parent) map.setPaintProperty('dim', 'fill-opacity', ['case', ['==', ['get', 'id'], cur.parent], 1, 0.8]);
      relayout();
    },
    /** fit the current deep-dive country on screen: its core (default) or everything (full,
        for find-on-map questions, so the view doesn't hint at outlying answers) */
    flyToSet({ full = false } = {}) {
      if (!cur.extent || cur.id === 'world') { map.flyTo({ ...REGION_VIEWS.World, duration: 900 }); return; }
      // exploring: no card at the bottom, so use the whole screen below the top bars
      const pad = full ? padding() : { top: 130, bottom: 24, left: 16, right: 16 };
      fitBox(full ? cur.extent : cur.core, pad, cur.maxZoom);
    },
    /** show all markers (explore) or only some ids (quiz feedback); dots: capital dots only */
    setMarkers(all, onlyIds = null, { dots = false } = {}) { showAll = all; only = onlyIds ? new Set(onlyIds) : null; dotsOnly = dots; relayout(); },
    select(id) {
      clearMarks();
      selected = id;
      if (id) { setMark(id, 'sel'); marked.push(id); }
      relayout();
    },
    /** colour places: marks = {id: 'sel'|'right'|'wrong'|'target'} */
    mark(marks) {
      clearMarks();
      marked = Object.keys(marks);
      selected = null;
      for (const [id, m] of Object.entries(marks)) setMark(id, m);
      relayout();
    },
    /** context: zoom out to show the neighbours too (for "which country is this?") */
    flyToCountry(c, { context = false } = {}) {
      let b = cur.bboxes.get(c.id);
      const maxZoom = context ? cur.ctxZoom : cur.maxZoom;
      if (!b || b[2] - b[0] > 150) {  // no shape, or spans the date line (Russia, Fiji, USA…)
        map.flyTo({ center: [c.fx ?? c.lon, c.fy ?? c.lat], zoom: context ? (b ? 2 : 4) : Math.max(map.getZoom(), 3), duration: 900 });
        return;
      }
      if (context) {
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        // room around it for the neighbours: generous for small places, capped for big ones
        const bw = b[2] - b[0], bh = b[3] - b[1], [mw, mh] = cur.minCtx;
        const w = Math.max(bw + Math.min(bw * 1.1, 30), mw), h = Math.max(bh + Math.min(bh * 1.1, 20), mh);
        b = [cx - w / 2, Math.max(-80, cy - h / 2), cx + w / 2, Math.min(84, cy + h / 2)];
      }
      fitBox(b, padding(), maxZoom);
    },
    /** regions: a continent name or a list of them ([] or 'World' = whole world) */
    flyToRegion(regions) {
      const list = (Array.isArray(regions) ? regions : [regions]).filter((r) => REGION_VIEWS[r] && r !== 'World');
      if (list.length <= 1) { map.flyTo({ ...(REGION_VIEWS[list[0]] || REGION_VIEWS.World), duration: 900 }); return; }
      // several continents: aim at the middle of their views (averaged on the sphere), zoomed out
      let x = 0, y = 0, z = 0;
      for (const r of list) {
        const [lon, lat] = REGION_VIEWS[r].center.map(toRad);
        x += Math.cos(lat) * Math.cos(lon); y += Math.cos(lat) * Math.sin(lon); z += Math.sin(lat);
      }
      const center = [Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI];
      const zoom = Math.max(REGION_VIEWS.World.zoom, Math.min(...list.map((r) => REGION_VIEWS[r].zoom)) - 0.5 * (list.length - 1));
      map.flyTo({ center, zoom, duration: 900 });
    },
    setProjection(type) { map.setProjection({ type }); relayout(); },
  };
}
