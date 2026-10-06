/* Wiring: tabs, the map tab's info card, the quiz panels and the sync settings. */
import { loadData, loadInfo, loadSubIndex, loadSub, flagOf, flagUrl, CONTINENTS, loadSetting, saveSetting } from './data.js';
import * as store from './store.js';
import { githubBackend } from './sync-github.js';
import { createMap } from './map.js';
import { MODES, modeFor, pool, makeDeck, makePileDeck, requeue, makeQuestion } from './quiz.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const settings = {
  showFlags: loadSetting('showFlags', true),
  projection: loadSetting('projection', 'globe'),
  mode: MODES[loadSetting('mode', 'flag-name')] ? loadSetting('mode', 'flag-name') : 'flag-name',  // 'mixed' is gone
  // continents to quiz ([] = whole world); older versions stored a single 'region'
  regions: loadSetting('regions', null) ?? ((r) => (r && r !== 'World' ? [r] : []))(loadSetting('region', 'World')),
  territories: loadSetting('territories', false),
  scope: loadSetting('scope', 'world'),
};
const set = (k, v) => { settings[k] = v; saveSetting(k, v); };

let data, world, tab = 'map';

// ---- scope: the world's countries, or the subdivisions of one country (deep dive) -----------
// Both tabs follow the same scope: the map shows that set, the quiz asks about it.
let subIndex = [], scope = 'world', worldSet = null;
const subs = {};  // id -> {id, name, kind, kinds, label?, items, byId, geo, smallSize}
const cur = () => (scope === 'world' ? worldSet : subs[scope]);
const capFirst = (t) => t[0].toUpperCase() + t.slice(1);
const modeLabel = (k) => MODES[k].label.replace('Country', capFirst(cur().kind)).replace('country', cur().kind);
const scopeLabel = (m) => m.label || `${m.name} ${m.kinds}`;
// names with the local form when there is one: "Guangdong · 广东", "Munich · München"
const nameOf = (c) => (c.local ? `${c.name} · ${c.local}` : c.name);
const capOf = (c) => (c.capitalLocal ? `${c.capital} · ${c.capitalLocal}` : c.capital);
const hasFlag = (c) => !!flagOf(c);
// flag questions only where most places have a flag (not for Chinese / South African provinces)
const flagsOk = () => cur().items.filter(hasFlag).length >= cur().items.length / 2;

async function setScope(id) {
  if (id !== 'world' && !subs[id]) {
    const meta = subIndex.find((m) => m.id === id);
    try {
      const sub = await loadSub(id);
      const sizes = sub.items.map((c) => c.size).sort((a, b) => a - b);
      subs[id] = { ...meta, ...sub, smallSize: sizes[Math.floor(sizes.length / 2)] * 0.15 };
      world.addSubdivisions(id, sub.items, sub.geo);
    } catch { id = 'world'; }
  }
  if (id !== scope) { q = null; closeInfo(); }
  scope = id;
  set('scope', id);
  world.useSet(id);
  document.documentElement.classList.toggle('deep', id !== 'world');
  if (id !== 'world') $('#scope-bar .scope-name').textContent = `${subs[id].name} · ${subs[id].kinds}`;
}
async function leaveDeepDive() {
  const parent = data.byId.get(scope);
  await setScope('world');
  if (parent) world.flyToCountry(parent);
  applyFlags();
}

// ---- tabs ---------------------------------------------------------------------------------
function showTab(t) {
  tab = t;
  document.body.className = 'tab-' + t;
  $('#tab-map').setAttribute('aria-selected', t === 'map');
  $('#tab-quiz').setAttribute('aria-selected', t === 'quiz');
  $('#settings').hidden = $('#learn').hidden = true;
  if (t === 'map') {
    $('#setup').hidden = $('#question').hidden = true;
    world.mark({});
    applyFlags();
  } else {
    closeInfo();
    world.setMarkers(false);
    q ? showQuestion() : showSetup();
  }
}

// ---- map tab --------------------------------------------------------------------------------
let infoId = null;
function applyFlags() {
  $('#btn-flags').setAttribute('aria-pressed', settings.showFlags);
  $('#hint').hidden = settings.showFlags;
  // flags hidden = self-test: capital positions stay, without flags or names
  world.setMarkers(true, null, { dots: !settings.showFlags });
}
async function openInfo(id) {
  const c = cur().byId.get(id);
  if (!c) return closeInfo();
  infoId = id;
  world.select(id);
  const card = $('#info');
  // the flag, or (no flag) the local name in its place, e.g. 广东
  const img = card.querySelector('.info-flag'), local = card.querySelector('.info-local');
  img.hidden = !hasFlag(c);
  if (hasFlag(c)) img.src = flagOf(c);
  local.hidden = hasFlag(c) || !c.local;
  local.textContent = c.local || '';
  card.querySelector('.info-name').textContent = hasFlag(c) ? nameOf(c) : c.name;
  card.querySelector('.info-cap').textContent = 'Capital: ' + capOf(c);
  card.querySelector('.info-meta').textContent = scope === 'world'
    ? c.continent + (c.sovereign ? '' : ' · territory') : `${capFirst(cur().kind)} · ${cur().name}`;
  // countries with subdivision data offer a deep dive
  const dive = scope === 'world' && subIndex.find((m) => m.id === id);
  const explore = card.querySelector('.explore');
  explore.hidden = !dive;
  if (dive) explore.textContent = `Explore the ${dive.kinds} →`;
  const hide = !settings.showFlags;
  card.classList.toggle('hidden-answer', hide);
  card.querySelector('.reveal').hidden = !hide;
  const more = card.querySelector('.info-more');
  more.innerHTML = '';
  card.hidden = false;
  card.scrollTop = 0;
  if (scope !== 'world') return;  // summaries exist for countries only
  const x = (await loadInfo())[id];
  if (!x || infoId !== id) return;
  more.innerHTML = `<p class="about">${esc(x.about)}</p>` +
    (x.dates?.length ? `<ul class="dates">${x.dates.map(([y, e]) => `<li><b>${esc(y)}</b> ${esc(e)}</li>`).join('')}</ul>` : '') +
    (x.known?.length ? `<p class="label">Known for</p><div class="known">${x.known.map((k) => `<span>${esc(k)}</span>`).join('')}</div>` : '');
}
function closeInfo() {
  infoId = null;
  $('#info').hidden = true;
  world.select(null);
}

// ---- quiz -----------------------------------------------------------------------------------
// A session is one round through a deck (see quiz.js): every country of the pool once, in random
// order; missed ones go back in at least MIN_GAP questions later. source: 'pool' (mode + regions
// from setup) or 'pile' (the hard pile, each card in its own mode).
let session = { source: 'pool', deck: [] };
let q = null, phase = 'ask', verdict = null;
let score = { right: 0, total: 0, streak: 0 };

const FACETS = ['flag', 'capital', 'name', 'map'];
const facetName = (f) => (f === 'name' ? capFirst(cur().kind) : capFirst(f));
const MODE_HINT = {
  recall: 'Flashcard: think of the answer, reveal it, then say whether you knew it.',
  choice: 'Pick the right flag out of four.',
  map: 'Tap it on the map.',
};

const usesFlag = () => { const m = MODES[settings.mode]; return m.ask === 'flag' || m.answer === 'flag'; };
const poolNow = () => (scope === 'world' ? pool(data.countries, settings) : cur().items.filter((c) => !usesFlag() || hasFlag(c)));
const allNow = () => (scope === 'world' ? data.countries.filter((c) => settings.territories || c.sovereign) : cur().items.filter(hasFlag));

// ---- what to learn: one button in the setup, opening a searchable list grouped by continent ----
const learnIcon = (id) => (id === 'world' ? '<span class="globe">🌍</span>' : `<img src="${flagUrl(id)}" alt="">`);
function renderLearnButton() {
  const m = subIndex.find((x) => x.id === scope);
  $('#learn-btn').innerHTML = `${learnIcon(scope)}<span>${esc(m ? scopeLabel(m) : 'Countries of the world')}</span><span class="chev">›</span>`;
}
function showLearn() {
  $('#setup').hidden = true;
  $('#learn').hidden = false;
  $('#learn-search').value = '';
  renderLearnList();
}
function renderLearnList() {
  const term = $('#learn-search').value.trim().toLowerCase();
  const hit = (...texts) => !term || texts.some((t) => t && t.toLowerCase().includes(term));
  const row = (id, title, sub) => `<button class="learn-row" data-scope="${id}" aria-pressed="${id === scope}">${learnIcon(id)}<span><b>${esc(title)}</b><small>${esc(sub)}</small></span></button>`;
  let html = hit('countries of the world', 'world') ? row('world', 'Countries of the world', `${data.countries.filter((c) => c.sovereign).length} countries`) : '';
  const groups = {};
  for (const m of subIndex.filter((m) => hit(m.name, m.label, m.kinds))) (groups[data.byId.get(m.id)?.continent || 'Other'] ||= []).push(m);
  for (const cont of [...CONTINENTS, 'Other']) {
    if (!groups[cont]) continue;
    html += `<p class="label">${esc(cont)}</p>` + groups[cont].sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => row(m.id, m.name, m.count ? `${m.count} ${m.kinds}` : capFirst(m.kinds))).join('');
  }
  $('#learn-list').innerHTML = html || '<p class="muted">Nothing found.</p>';
}

function showSetup() {
  $('#question').hidden = true;
  $('#settings').hidden = $('#learn').hidden = true;
  renderLearnButton();
  $('#world-options').hidden = scope !== 'world';
  // mode = what is shown + what is asked for; no flag questions where places have no flags
  if (!flagsOk() && usesFlag()) set('mode', 'name-capital');
  const { ask, answer, type } = MODES[settings.mode];
  const chips = (which, sel, off) => FACETS.map((f) => `<button data-${which}="${f}" aria-pressed="${f === sel}"${
    f === off || (f === 'flag' && !flagsOk()) ? ' disabled' : ''}>${esc(facetName(f))}</button>`).join('');
  $('#ask').innerHTML = chips('ask', ask, null);
  $('#answer').innerHTML = chips('answer', answer, ask);
  $('#mode-hint').textContent = MODE_HINT[type];
  $('#regions').innerHTML = ['World', ...CONTINENTS]
    .map((r) => `<button data-region="${esc(r)}" aria-pressed="${r === 'World' ? !settings.regions.length : settings.regions.includes(r)}">${esc(r)}</button>`).join('');
  $('#territories').checked = settings.territories;
  const st = Object.values(store.getStats());
  const right = st.reduce((s, x) => s + x.right, 0), total = st.reduce((s, x) => s + x.right + x.wrong, 0);
  const n = poolNow().length, all = scope === 'world' ? n : cur().items.length;
  $('#progress').textContent = (n < all ? `${n} of ${all} ${cur().kinds} per round (the others have no flag). ` : `${n} ${cur().kinds} per round. `) +
    (total ? `So far: ${total} answers, ${Math.round((100 * right) / total)}% correct.` : 'No answers yet.');
  // the hard pile of this scope (cards of countries, or of this country's subdivisions)
  const cards = Object.entries(store.hardCards()).filter(([k]) => cur().byId.has(store.parseKey(k).id));
  const nHard = cards.length, due = cards.filter(([, c]) => c.due <= Date.now()).length;
  $('#pile-info').innerHTML = nHard ? `<b>Hard pile</b> · ${nHard} card${nHard > 1 ? 's' : ''}, ${due} due` : '<b>Hard pile</b> · empty. Add cards after answering.';
  $('#start-pile').disabled = !nHard;
  showSyncStatus();
  $('#setup').hidden = false;
  $('#setup').scrollTop = 0;
}

function startQuiz(source) {
  let deck, early = false;
  if (source === 'pile') ({ deck, early } = makePileDeck(store.hardCards(), cur().byId));
  else deck = makeDeck(settings.mode, poolNow());
  if (!deck.length) return showSetup();
  session = { source, deck, early, size: deck.length, seen: new Set(), firstRight: 0, missed: [] };
  score = { right: 0, total: 0, streak: 0 };
  q = null;
  nextQuestion();
}

function nextQuestion() {
  if (!session.deck.length) return showRoundDone();
  [session.current, ...session.deck] = session.deck;
  q = makeQuestion(session.current, cur().byId, allNow());
  q.early = session.early;
  phase = 'ask';
  verdict = null;
  world.mark({});
  world.setMarkers(false);
  if (q.type === 'map') {
    if (scope !== 'world') world.flyToSet({ full: true });
    else world.flyToRegion(session.source === 'pile' ? [q.target.continent] : settings.regions);
  }
  if (q.ask === 'map') showOnMap(q.target);
  showQuestion();
}

/** "Which country is this?": highlight it with its neighbours around; tiny countries (or ones
    without a shape) also get their capital dot so they can be found. */
function showOnMap(c) {
  world.mark({ [c.id]: 'sel' });
  const small = scope === 'world' ? 1 : cur().smallSize;
  world.setMarkers(false, c.size < small ? [c.id] : null, { dots: true });
  world.flyToCountry(c, { context: true });
}

const askHtml = (c, what) => what === 'map'
  ? `<div class="q-text">Which ${cur().kind} is this?</div>`
  : what === 'flag'
  ? `<img class="q-flag" src="${flagOf(c)}" alt="Flag">`
  : what === 'capital' ? `<div class="q-text"><small>Capital</small>${esc(capOf(c))}</div>`
  : `<div class="q-text"><small>${capFirst(cur().kind)}</small>${esc(nameOf(c))}</div>`;

const hint = { recall: '', map: 'Tap it on the map', choice: '' };

function showQuestion() {
  $('#setup').hidden = true;
  $('#settings').hidden = $('#learn').hidden = true;
  const card = $('#question');
  card.hidden = false;
  card.classList.toggle('map-q', q.type === 'map' || q.ask === 'map');
  card.classList.toggle('answered', phase === 'done');
  $('#q-mode').textContent = (session.source === 'pile' ? 'Hard pile · ' : '') + modeLabel(q.mode);
  updateScore();
  $('#q-prompt').innerHTML = askHtml(q.target, q.ask) +
    (hint[q.type] ? `<p class="muted center">${hint[q.type]}</p>` : '') +
    (q.early && phase === 'ask' ? '<p class="muted center">Nothing due — practising early</p>' : '');
  const opts = $('#q-options');
  opts.className = q.answer === 'flag' ? 'grid flags' : 'grid';
  opts.innerHTML = q.options.map((c) => `<button data-id="${c.id}">${
    q.answer === 'flag' ? `<img src="${flagOf(c)}" alt="">` : esc(q.answer === 'capital' ? c.capital : c.name)}</button>`).join('');
  renderPhase();
}

function updateScore() {
  const left = session.deck.length + (phase === 'done' ? 0 : 1);
  $('#q-score').innerHTML = `${score.right}/${score.total}` + (score.streak > 2 ? ` · 🔥${score.streak}` : '') +
    `<small>${left} left</small>`;
}

/** End of the deck: summary, then go again (new order) or back to setup. */
function showRoundDone() {
  q = null;
  world.mark({});
  world.setMarkers(false);
  $('#setup').hidden = true;
  const card = $('#question');
  card.hidden = false;
  card.classList.remove('map-q', 'answered');
  $('#q-mode').textContent = session.source === 'pile' ? 'Hard pile' : modeLabel(settings.mode);
  $('#q-score').textContent = '';
  const { size, firstRight, missed } = session;
  const what = session.source === 'pile' ? 'cards' : cur().kinds;
  const names = [...new Set(missed)].map((id) => nameOf(cur().byId.get(id)));
  $('#q-prompt').innerHTML = '<div class="q-text">🎉 Round complete</div>';
  $('#q-options').innerHTML = '';
  const r = $('#q-result');
  r.innerHTML = `<p>All ${size} ${what} done. Right the first time: <b>${firstRight} of ${size}</b>.</p>` +
    (names.length ? `<p class="muted">Missed: ${names.map(esc).join(', ')}</p>` : '<p class="muted">No misses!</p>');
  r.hidden = false;
  $('#q-buttons').innerHTML = '<button data-act="setup" class="ghost">Setup</button><button data-act="again" class="primary">New round</button>';
}

const answerHtml = (c) => `<div class="answer">${
  q.ask === 'flag' ? '' : hasFlag(c) ? `<img src="${flagOf(c)}" alt="">` : c.local ? `<span class="q-local">${esc(c.local)}</span>` : ''
}<div><b>${esc(nameOf(c))}</b><br>Capital: ${esc(capOf(c))}</div></div>`;

/** Buttons and result area for the current phase: ask → (revealed, flashcards only) → done. */
function renderPhase() {
  const r = $('#q-result'), btns = $('#q-buttons');
  const key = store.cardKey(q.mode, q.target.id);
  if (phase === 'ask') {
    r.hidden = true;
    btns.innerHTML = q.type === 'recall'
      ? '<button data-act="reveal" class="primary wide">Show answer</button>'
      : '<button data-act="skip" class="ghost">Skip</button>';
    return;
  }
  if (phase === 'revealed') {
    r.innerHTML = answerHtml(q.target);
    r.hidden = false;
    btns.innerHTML = '<button data-act="wrong" class="btn-bad wide">✗ Didn\'t know</button><button data-act="right" class="btn-ok wide">✓ Knew it</button>';
    return;
  }
  const { correct, chosenId } = verdict;
  $('#question').classList.add('answered');
  for (const b of $('#q-options').querySelectorAll('button')) {
    b.disabled = true;
    if (b.dataset.id === q.target.id) b.classList.add('right');
    else if (b.dataset.id === chosenId) b.classList.add('wrong');
  }
  const chosen = chosenId && chosenId !== q.target.id ? cur().byId.get(chosenId) : null;
  r.innerHTML = `<p class="verdict ${correct ? 'ok' : 'bad'}">${correct ? '✓ Correct' : verdict.skipped ? 'Skipped' : q.type === 'recall' ? '✗ Not yet' : '✗ Not quite'}</p>` +
    answerHtml(q.target) +
    (chosen ? `<p class="muted">You picked ${esc(nameOf(chosen))} (${esc(capOf(chosen))})</p>` : '');
  r.hidden = false;
  const inPile = store.isHard(key);
  btns.innerHTML = `<button data-act="pile" class="pile ${!inPile && !correct ? 'suggest' : ''}">${
    inPile ? '★ In hard pile · remove' : '☆ Add to hard pile'}</button><button data-act="next" class="primary">${session.deck.length ? 'Next' : 'Finish'}</button>`;
}

function answer(correct, chosenId, skipped = false) {
  if (phase === 'done') return;
  phase = 'done';
  verdict = { correct, chosenId, skipped };
  store.record(q.mode, q.target.id, correct);
  const itemKey = store.cardKey(q.mode, q.target.id);
  if (!session.seen.has(itemKey) && correct) session.firstRight++;
  session.seen.add(itemKey);
  if (!correct) {  // back into this round, at least MIN_GAP questions later
    session.missed.push(q.target.id);
    session.deck = requeue(session.deck, session.current);
  }
  score.total++;
  if (correct) { score.right++; score.streak++; } else score.streak = 0;
  updateScore();
  const marks = { [q.target.id]: correct ? 'right' : 'target' };
  if (!correct && chosenId && chosenId !== q.target.id) marks[chosenId] = 'wrong';
  world.mark(marks);
  world.setMarkers(false, Object.keys(marks));
  if (q.ask !== 'map') world.flyToCountry(q.target);
  renderPhase();
}

// ---- sync settings --------------------------------------------------------------------------
let syncing = false, syncTimer = 0;
function backend() {
  const cfg = store.syncConfig();
  return cfg?.kind === 'github' && cfg.token ? githubBackend(cfg) : null;
}
function showSyncStatus(msg) {
  const cfg = store.syncConfig();
  const text = msg || (backend()
    ? (cfg.last ? `Synced ${new Date(cfg.last).toLocaleString()}` : 'Sync on')
    : 'Not synced: progress is kept on this phone only.');
  $('#sync-status').textContent = text;
  $('#sync-line').textContent = text;
  $('#sync-off').hidden = $('#sync-now').hidden = !backend();
}
async function runSync() {
  const b = backend();
  if (!b || syncing || !navigator.onLine) return;
  syncing = true;
  showSyncStatus('Syncing…');
  try { await store.sync(b); showSyncStatus(); if (!$('#setup').hidden) showSetup(); }
  catch (e) { showSyncStatus(`Sync failed (${e.message}). Will retry.`); }
  finally { syncing = false; }
}
store.onChange(() => { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, 5000); });

// ---- offline ------------------------------------------------------------------------------
// The service worker saves every file on install; this asks it how many are saved and can
// re-download them all (e.g. before a flight).
async function askWorker(type) {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg?.active) throw new Error('offline support not available');
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
    reg.active.postMessage({ type }, [ch.port2]);
    setTimeout(() => reject(new Error('no answer')), 60000);
  });
}
async function showOffline(type = 'offline-status') {
  const out = $('#offline-status');
  out.textContent = type === 'download' ? 'Downloading…' : 'Checking…';
  try {
    const { done, total } = await askWorker(type);
    out.textContent = done === total ? `✓ Everything is on this phone (${total} files). Works offline.`
      : `${done} of ${total} files saved. Tap Download while online.`;
  } catch (e) { out.textContent = `Couldn't check (${e.message}).`; }
}

// ---- events -------------------------------------------------------------------------------
function onMapClick(id, viaMarker, point) {
  if (tab === 'map') { id ? openInfo(id) : closeInfo(); return; }
  if (!q || phase !== 'ask' || q.type !== 'map') return;
  if (!id) return;  // tap on the ocean: ignore
  const t = q.target.id;
  // generous for small countries: a few px around the shape or the capital counts
  const hit = id === t || (point && (world.hitTest(point, 10).includes(t) || world.nearestCapital(point, 18) === t));
  answer(hit, hit ? t : id);
}

function wire() {
  $('#tab-map').onclick = () => showTab('map');
  $('#tab-quiz').onclick = () => showTab('quiz');
  $('#btn-flags').onclick = () => {
    set('showFlags', !settings.showFlags);
    applyFlags();
    if (infoId) openInfo(infoId);
  };
  $('#btn-globe').onclick = () => {
    set('projection', settings.projection === 'globe' ? 'mercator' : 'globe');
    world.setProjection(settings.projection);
  };
  $('#info .close').onclick = closeInfo;
  $('#info .explore').onclick = async () => {
    const id = infoId;
    await setScope(id);
    world.flyToSet();
    applyFlags();
  };
  $('#scope-bar .back').onclick = leaveDeepDive;
  $('#learn-btn').onclick = showLearn;
  $('#learn .close').onclick = showSetup;
  $('#learn-search').oninput = renderLearnList;
  $('#learn-list').onclick = async (e) => {
    const id = e.target.closest('button')?.dataset.scope;
    if (!id) return;
    if (id !== scope) {
      await setScope(id);
      if (id === 'world') world.flyToRegion(settings.regions); else world.flyToSet();
    }
    showSetup();
  };
  $('#info .reveal').onclick = () => {
    $('#info').classList.remove('hidden-answer');
    $('#info .reveal').hidden = true;
  };

  $('#ask').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const a = b.dataset.ask;
    let { answer } = MODES[settings.mode];
    if (answer === a) answer = a === 'name' ? (flagsOk() ? 'flag' : 'capital') : 'name';  // can't ask for what is shown
    set('mode', modeFor(a, answer));
    showSetup();
  };
  $('#answer').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    set('mode', modeFor(MODES[settings.mode].ask, b.dataset.answer));
    showSetup();
  };
  // World = everything; continents can be combined (tap again to remove one)
  $('#regions').onclick = (e) => {
    const r = e.target.closest('button')?.dataset.region;
    if (!r) return;
    const cur = settings.regions;
    const next = r === 'World' ? [] : cur.includes(r) ? cur.filter((x) => x !== r) : CONTINENTS.filter((x) => x === r || cur.includes(x));
    set('regions', next.length === CONTINENTS.length ? [] : next);
    world.flyToRegion(settings.regions);
    showSetup();
  };
  $('#territories').onchange = (e) => { set('territories', e.target.checked); showSetup(); };
  $('#reset').onclick = () => { if (confirm('Forget all answer statistics? (The hard pile stays.)')) { store.resetStats(); showSetup(); } };
  $('#start').onclick = () => startQuiz('pool');
  $('#start-pile').onclick = () => startQuiz('pile');
  $('#q-back').onclick = () => { q = null; world.mark({}); world.setMarkers(false); showSetup(); };
  $('#q-options').onclick = (e) => {
    const b = e.target.closest('button');
    if (b && phase === 'ask') answer(b.dataset.id === q.target.id, b.dataset.id);
  };
  $('#q-buttons').onclick = (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'reveal') {
      phase = 'revealed';
      world.mark({ [q.target.id]: 'target' });
      world.setMarkers(false, [q.target.id]);
      if (q.ask !== 'map') world.flyToCountry(q.target);  // a map question is already in view
      renderPhase();
    } else if (act === 'right' || act === 'wrong') answer(act === 'right', null);
    else if (act === 'skip') answer(false, null, true);
    else if (act === 'next') nextQuestion();
    else if (act === 'again') startQuiz(session.source);
    else if (act === 'setup') showSetup();
    else if (act === 'pile') {
      const key = store.cardKey(q.mode, q.target.id);
      store.isHard(key) ? store.removeHard(key) : store.addHard(key);
      renderPhase();
    }
  };

  $('#open-settings').onclick = () => { $('#setup').hidden = true; $('#settings').hidden = false; showSyncStatus(); showOffline(); $('#screen-info').textContent = screenInfo; };
  $('#offline-download').onclick = () => showOffline('download');
  $('#settings .close').onclick = showSetup;
  $('#sync-save').onclick = () => {
    const token = $('#sync-token').value.trim();
    if (!token) return;
    store.setSyncConfig({ kind: 'github', token });
    $('#sync-token').value = '';
    runSync();
  };
  $('#sync-now').onclick = runSync;
  $('#sync-off').onclick = () => { if (confirm('Turn off sync on this phone? Progress stays on the phone.')) { store.setSyncConfig(null); showSyncStatus(); } };
  // sync when the app is put away (save) and when it comes back (pick up changes from elsewhere)
  document.addEventListener('visibilitychange', runSync);
}

async function start() {
  data = await loadData();
  world = createMap($('#map'), {
    countries: data.countries, world: data.world, colors: data.colors, projection: settings.projection, onClick: onMapClick,
  });
  worldSet = { id: 'world', name: 'World', kind: 'country', kinds: 'countries', items: data.countries, byId: data.byId };
  subIndex = await loadSubIndex();
  window.__app = { data, world, store, setScope };  // for debugging / screenshots
  wire();
  world.map.on('load', async () => {
    fitScreen();
    if (settings.scope !== 'world') { await setScope(settings.scope); world.flyToSet(); }
    showTab('map');
  });
  runSync();
}

// iOS home-screen app with a translucent status bar: iOS moves the window up under the status
// bar but doesn't make it taller, leaving an empty strip at the bottom. Measure the gap and let
// the map extend into it (same fix as in the LP_South_Africa app). Only when the quirk is present.
function fitScreen() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;height:0;padding-top:env(safe-area-inset-top);visibility:hidden';
  document.body.appendChild(probe);
  const safeTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  const portrait = innerHeight > innerWidth;
  // In the home-screen app the map reaches down to the physical bottom of the screen.
  const measured = navigator.standalone && portrait ? Math.max(0, Math.min(150, screen.height - innerHeight)) : 0;
  // Never shrink within the same screen setup: our own change can make iOS report a taller
  // window, and reacting to that made the layout flip back and forth (2026-10-05). Only touch
  // the map when the value really changes: map.resize() cancels a running pinch/drag.
  const key = `${screen.width}x${screen.height}:${portrait}`;
  const extra = key === fit.key ? Math.max(fit.extra, measured) : measured;
  screenInfo = `screen ${screen.height}, window ${innerHeight}, top inset ${safeTop}, standalone ${!!navigator.standalone}, extra ${extra}`;
  if (key === fit.key && extra === fit.extra) return;
  fit = { key, extra };
  document.documentElement.style.setProperty('--app-extra', `${extra}px`);
  world?.map.resize();
}
let fit = { key: '', extra: -1 }, screenInfo = '';
addEventListener('resize', fitScreen);
addEventListener('orientationchange', () => setTimeout(fitScreen, 300));
// iOS can change the window size when the app comes back from the background without a
// resize event: measure again then
const refit = () => { fitScreen(); setTimeout(fitScreen, 300); setTimeout(fitScreen, 1000); };
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refit());
addEventListener('pageshow', refit);
fitScreen();
setTimeout(fitScreen, 500);
setTimeout(fitScreen, 2000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
start();
