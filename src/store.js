/* User data: quiz statistics and the "hard pile". Lives in localStorage and can be synced to a
   backend. No DOM here.

   Shape of the user data (one JSON document per user, versioned):
     { v: 1,
       stats:   { [countryId]: {right, wrong, last} },              // all answers, for weighting
       hard:    { [cardKey]: {box, due, added, updated} },           // the hard pile (Leitner boxes)
       removed: { [cardKey]: removedAt } }                            // tombstones so removals sync
   cardKey = `${mode}:${countryId}`, e.g. "flag-name:fr".

   Sync is pluggable: a backend is {id, label, pull(): Promise<doc|null>, push(doc): Promise}
   (see sync-github.js). A future user-account backend only needs the same two methods. */

const KEY = 'ltc.user';
const BACKEND_KEY = 'ltc.sync';
// days until a hard card is due again, by box (box 0 = due now)
export const BOX_DAYS = [0, 1, 3, 7, 21];
const DAY = 864e5;

const empty = () => ({ v: 1, stats: {}, hard: {}, removed: {} });
let doc = load();
const listeners = new Set();

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.v === 1) return { ...empty(), ...d };
    // migrate the prototype's stats
    const old = JSON.parse(localStorage.getItem('ltc.stats'));
    if (old) return { ...empty(), stats: old };
  } catch {}
  return empty();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch {}
  listeners.forEach((fn) => fn());
}
/** Called after every local change (the app uses it to schedule a sync). */
export function onChange(fn) { listeners.add(fn); }

// ---- statistics ----------------------------------------------------------------------------
export function getStats() { return doc.stats; }
export function resetStats() { doc.stats = {}; save(); }

// ---- hard pile -----------------------------------------------------------------------------
export const cardKey = (mode, id) => `${mode}:${id}`;
export const parseKey = (k) => { const i = k.lastIndexOf(':'); return { mode: k.slice(0, i), id: k.slice(i + 1) }; };
export function hardCards() { return doc.hard; }
export function isHard(key) { return !!doc.hard[key]; }
export function addHard(key) {
  const now = Date.now();
  doc.hard[key] = { box: 0, due: now, added: now, updated: now };
  delete doc.removed[key];
  save();
}
export function removeHard(key) {
  delete doc.hard[key];
  doc.removed[key] = Date.now();
  save();
}
export function dueCount(now = Date.now()) {
  return Object.values(doc.hard).filter((c) => c.due <= now).length;
}

/** Record one answer: statistics, and the Leitner box if the card is in the hard pile. */
export function record(mode, id, correct) {
  const now = Date.now();
  const s = (doc.stats[id] ||= { right: 0, wrong: 0, last: 0 });
  correct ? s.right++ : s.wrong++;
  s.last = now;
  const c = doc.hard[cardKey(mode, id)];
  if (c) {
    c.box = correct ? Math.min(c.box + 1, BOX_DAYS.length - 1) : 0;
    c.due = now + BOX_DAYS[c.box] * DAY;
    c.updated = now;
  }
  save();
}

// ---- merge + sync --------------------------------------------------------------------------
/** Merge another copy into ours: per entry, the most recently changed one wins. */
export function merge(a, b) {
  const out = empty();
  for (const id of new Set([...Object.keys(a.stats || {}), ...Object.keys(b.stats || {})])) {
    const x = a.stats?.[id], y = b.stats?.[id];
    out.stats[id] = !x ? y : !y ? x : (y.last > x.last ? y : x);
  }
  for (const [k, t] of [...Object.entries(a.removed || {}), ...Object.entries(b.removed || {})])
    out.removed[k] = Math.max(out.removed[k] || 0, t);
  for (const k of new Set([...Object.keys(a.hard || {}), ...Object.keys(b.hard || {})])) {
    const x = a.hard?.[k], y = b.hard?.[k];
    const c = !x ? y : !y ? x : (y.updated > x.updated ? y : x);
    if (!(out.removed[k] >= c.updated)) out.hard[k] = c;
  }
  return out;
}

export function exportData() { return JSON.parse(JSON.stringify(doc)); }
export function importData(other) { doc = merge(doc, other); save(); }

export function syncConfig() {
  try { return JSON.parse(localStorage.getItem(BACKEND_KEY)); } catch { return null; }
}
export function setSyncConfig(cfg) {
  try { cfg ? localStorage.setItem(BACKEND_KEY, JSON.stringify(cfg)) : localStorage.removeItem(BACKEND_KEY); } catch {}
}

/** Pull the remote copy, merge it in, push the merged copy. */
export async function sync(backend) {
  for (let attempt = 0; ; attempt++) {
    const remote = await backend.pull();
    if (remote) doc = merge(doc, remote);
    try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch {}  // no change event: avoids a sync loop
    try { await backend.push(doc); break; }
    catch (e) { if (!e.conflict || attempt >= 2) throw e; }  // written elsewhere meanwhile: pull again
  }
  setSyncConfig({ ...syncConfig(), last: Date.now() });
}
