/**
 * geo.mjs — geometry helpers shared by tools/build_data.mjs and tools/build_subdivisions.mjs.
 *
 * Coordinates are GeoJSON [lon, lat]. A polygon is an array of rings (outer first, then holes).
 * polylabel() is a reimplementation of mapbox/polylabel (ISC license, Copyright (c) 2016 Mapbox).
 */

export const polygonsOf = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates);

// Signed planar area of a ring (shoelace).
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

// Ray-casting point-in-ring test.
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const pointInPolygon = (p, poly) => pointInRing(p, poly[0]) && !poly.slice(1).some((h) => pointInRing(p, h));
export const pointInGeometry = (p, geom) => polygonsOf(geom).some((poly) => pointInPolygon(p, poly));

// Round every coordinate of a geometry to `decimals` places, dropping the duplicate consecutive
// points this creates and rings left with fewer than 4 points (and polygons whose outer ring is gone).
export function roundGeometry(geom, decimals = 3) {
  const f = 10 ** decimals;
  const round = (n) => Math.round(n * f) / f;
  const roundRing = (ring) => {
    const out = [];
    for (const [x, y] of ring) {
      const p = [round(x), round(y)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return out;
  };
  const polys = polygonsOf(geom).map((poly) => poly.map(roundRing).filter((r) => r.length >= 4)).filter((p) => p.length && p[0].length >= 4);
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

// MapLibre's globe cannot handle rings that jump across the antimeridian (+180 -> -180).
export function assertNoAntimeridianJumps(features) {
  for (const f of features) for (const poly of polygonsOf(f.geometry)) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) throw new Error(`antimeridian jump in ${f.properties.id} at ${ring[i - 1]} -> ${ring[i]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pole of inaccessibility (after mapbox/polylabel, ISC license).
// ---------------------------------------------------------------------------

export function polylabel(polygon, precision = 1e-4) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon[0]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const width = maxX - minX, height = maxY - minY;
  const cellSize = Math.min(width, height);
  let h = cellSize / 2;
  if (cellSize === 0) return [minX, minY];

  // distance from point to polygon outline (negative if outside)
  const segDistSq = (px, py, [ax, ay], [bx, by]) => {
    let x = ax, y = ay, dx = bx - ax, dy = by - ay;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = px - x; dy = py - y;
    return dx * dx + dy * dy;
  };
  const pointToPolygonDist = (x, y) => {
    let inside = false, minDistSq = Infinity;
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
        minDistSq = Math.min(minDistSq, segDistSq(x, y, a, b));
      }
    }
    return (inside ? 1 : -1) * Math.sqrt(minDistSq);
  };
  const cell = (x, y, h) => { const d = pointToPolygonDist(x, y); return { x, y, h, d, max: d + h * Math.SQRT2 }; };

  // simple max-heap on `max`
  const heap = [];
  const push = (c) => { heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].max >= heap[i].max) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].max > heap[m].max) m = l; if (r < heap.length && heap[r].max > heap[m].max) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };

  for (let x = minX; x < maxX; x += cellSize) for (let y = minY; y < maxY; y += cellSize) push(cell(x + h, y + h, h));
  let best = cell(minX + width / 2, minY + height / 2, 0);
  // centroid as another candidate
  { let a = 0, cx = 0, cy = 0; const r = polygon[0];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[i][0] * r[j][1] - r[j][0] * r[i][1]; cx += (r[i][0] + r[j][0]) * f; cy += (r[i][1] + r[j][1]) * f; a += f * 3; }
    const c = a === 0 ? cell(r[0][0], r[0][1], 0) : cell(cx / a, cy / a, 0);
    if (c.d > best.d) best = c; }

  while (heap.length) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    h = c.h / 2;
    push(cell(c.x - h, c.y - h, h)); push(cell(c.x + h, c.y - h, h));
    push(cell(c.x - h, c.y + h, h)); push(cell(c.x + h, c.y + h, h));
  }
  return [best.x, best.y];
}

// Flag anchor: pole of inaccessibility of the largest polygon, in a plane where x is scaled
// by cos(mean latitude) of that polygon. Returns [lon, lat].
export function flagPoint(geom) {
  let best = null, bestArea = -1;
  for (const poly of polygonsOf(geom)) {
    const lats = poly[0].map((p) => p[1]);
    const k = Math.cos(((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI / 180);
    const scaled = poly.map((ring) => ring.map(([x, y]) => [x * k, y]));
    const area = Math.abs(ringArea(scaled[0])) - scaled.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
    if (area > bestArea) { bestArea = area; best = { scaled, k, poly }; }
  }
  const [sx, sy] = polylabel(best.scaled, 1e-4);
  const pt = [sx / best.k, sy];
  if (!pointInPolygon(pt, best.poly)) throw new Error('flag point outside its polygon');
  return pt;
}
