/* Wiring: tabs, the map tab's info card and the quiz panels. */
import { loadData, loadInfo, loadSubIndex, loadSub, flagOf, flagUrl, formatPop, CONTINENTS, loadSetting, saveSetting } from './data.js';
import * as store from './store.js';
import { createMap } from './map.js';
import { loadWater, waterSet, waterPool, WATER_LEVELS, WATER_KINDS } from './water.js';  // experimental
import { MODES, modeFor, pool, makeDeck, makePileDeck, requeue, makeQuestion, offBy, GUESS_OK } from './quiz.js';

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
  waterKinds: loadSetting('waterKinds', ['river', 'lake']),  // "Rivers & lakes" quiz filters
  waterLevel: loadSetting('waterLevel', 3),
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
// nested deep dives (Geneva's communes inside Switzerland's cantons) name their parent set
const metaOf = (id) => subIndex.find((m) => m.id === id);
// sets whose items have no capital (communes): the capital facet is off
const capsOk = () => !cur().noCapital;
// flag questions only where most places have a flag (not for Chinese / South African provinces)
const flagsOk = () => cur().items.filter(hasFlag).length >= cur().items.length / 2;

async function setScope(id) {
  if (id === 'water' && !subs.water) {  // "Rivers & lakes" (experimental)
    subs.water = await waterSet(data.byId);
    world.addWaterSet(subs.water.items, subs.water.geo);
  } else if (id !== 'world' && !subs[id]) {
    const meta = subIndex.find((m) => m.id === id);
    try {
      const sub = await loadSub(id);
      const sizes = sub.items.map((c) => c.size).sort((a, b) => a - b);
      subs[id] = { ...meta, ...sub, smallSize: sizes[Math.floor(sizes.length / 2)] * 0.15 };
      // the world country it belongs to (dimmed fully underneath): 'ch' also for 'ch-ge'
      world.addSubdivisions(id, sub.items, sub.geo, meta.parent || id, { landOnly: !!meta.landOnly });
    } catch { id = 'world'; }
  }
  if (id !== scope) { q = null; closeInfo(); }
  scope = id;
  set('scope', id);
  world.useSet(id);
  document.documentElement.classList.toggle('deep', id !== 'world');
  $('#btn-water').setAttribute('aria-pressed', id === 'water');
  if (id !== 'world') {
    $('#scope-bar .scope-name').textContent = id === 'water' ? subs[id].name : `${subs[id].name} · ${subs[id].kinds}`;
    $('#scope-bar .back').textContent = '‹ ' + (subs[id].parent ? subs[subs[id].parent]?.name || 'Back' : id === 'water' ? 'Countries' : 'World');
  }
}
/** "‹ World" / "‹ Switzerland": one level up */
async function leaveDeepDive() {
  const meta = metaOf(scope);
  if (meta?.parent) {
    await setScope(meta.parent);
    world.flyToSet();
  } else {
    const parent = data.byId.get(scope);
    await setScope('world');
    if (parent) world.flyToCountry(parent);
  }
  applyFlags();
}

// ---- tabs ---------------------------------------------------------------------------------
function showTab(t) {
  tab = t;
  document.body.className = 'tab-' + t;
  $('#tab-map').setAttribute('aria-selected', t === 'map');
  $('#tab-quiz').setAttribute('aria-selected', t === 'quiz');
  $('#learn').hidden = true;
  world.setWaterByZoom(t === 'map');
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
let infoId = null, exploreId = null;
function applyFlags() {
  $('#btn-flags').setAttribute('aria-pressed', settings.showFlags);
  $('#hint').hidden = settings.showFlags;
  $('#hint').textContent = scope === 'water' ? 'Names hidden: tap a river or lake to test yourself' : 'Flags hidden: tap a country to test yourself';
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
  card.querySelector('.info-cap').textContent = c.capital ? 'Capital: ' + capOf(c) : '';
  const pop = card.querySelector('.info-pop');
  pop.hidden = !c.pop;
  pop.textContent = c.pop ? 'Population: ' + formatPop(c.pop) : '';
  card.querySelector('.info-meta').textContent = scope === 'world'
    ? c.continent + (c.sovereign ? '' : ' · territory') : c.desc || `${capFirst(cur().kind)} · ${cur().name}`;
  // countries with subdivision data offer a deep dive
  const dive = subIndex.find((m) => (scope === 'world' ? m.id === id && !m.parent : m.parent === scope && m.parentItem === id));
  exploreId = dive?.id;
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

const usesFlag = () => { const m = MODES[settings.mode]; return m.ask === 'flag' || m.answer === 'flag'; };
const isPop = (mode = settings.mode) => MODES[mode].ask === 'pop';
// population questions only where (most) places have a population
const popOk = () => cur().items.filter((c) => c.pop).length >= cur().items.length / 2;
const fits = (c) => (!usesFlag() || hasFlag(c)) && (!isPop() || c.pop);
const poolNow = () => (scope === 'world' ? pool(data.countries, settings) : scope === 'water' ? waterPool(cur().items, settings) : cur().items).filter(fits);
const allNow = () => (scope === 'world' ? data.countries.filter((c) => settings.territories || c.sovereign) : cur().items)
  .filter(isPop() ? (c) => c.pop : hasFlag);

// ---- what to learn: one button in the setup, opening a searchable list grouped by continent ----
const learnIcon = (id) => {
  if (id === 'world') return '<span class="globe">🌍</span>';
  if (id === 'water') return '<span class="globe">🌊</span>';
  const m = metaOf(id);
  const src = m?.parentItem ? `flags/sub/${m.parentItem}.svg` : flagUrl(id);
  return `<img src="${src}" alt="" onerror="this.onerror=null;this.src=this.src.replace('.svg','.png')">`;
};
function renderLearnButton() {
  const m = subIndex.find((x) => x.id === scope);
  const label = m ? scopeLabel(m) : scope === 'water' ? 'Rivers & lakes' : 'Countries of the world';
  $('#learn-btn').innerHTML = `${learnIcon(scope)}<span>${esc(label)}</span><span class="chev">›</span>`;
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
  if (hit('rivers', 'lakes', 'water')) html += row('water', 'Rivers & lakes', 'Major rivers and lakes of the world');
  const groups = {};
  for (const m of subIndex.filter((m) => hit(m.name, m.label, m.kinds))) (groups[data.byId.get(m.parent || m.id)?.continent || 'Other'] ||= []).push(m);
  for (const cont of [...CONTINENTS, 'Other']) {
    if (!groups[cont]) continue;
    html += `<p class="label">${esc(cont)}</p>` + groups[cont].sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => row(m.id, m.parent ? `${m.name} (${metaOf(m.parent)?.name || ''})` : m.name, m.count ? `${m.count} ${m.kinds}` : capFirst(m.kinds))).join('');
  }
  $('#learn-list').innerHTML = html || '<p class="muted">Nothing found.</p>';
}

function showSetup() {
  $('#question').hidden = true;
  $('#learn').hidden = true;
  renderLearnButton();
  $('#world-options').hidden = scope !== 'world' && scope !== 'water';
  $('#territories').parentElement.hidden = scope !== 'world';
  $('#water-options').hidden = scope !== 'water';
  if (scope === 'water') {
    $('#water-kinds').innerHTML = WATER_KINDS.map(([k, l]) => `<button data-wkind="${k}" aria-pressed="${settings.waterKinds.includes(k)}">${l}</button>`).join('');
    $('#water-level').innerHTML = WATER_LEVELS.map(([z, l]) => `<button data-wlevel="${z}" aria-pressed="${settings.waterLevel === z}">${l}</button>`).join('');
  }
  // mode = what is shown + what is asked for; no flag questions where places have no flags
  const usesCap = () => { const m = MODES[settings.mode]; return m.ask === 'capital' || m.answer === 'capital'; };
  if ((!flagsOk() && usesFlag()) || (!popOk() && isPop()) || (!capsOk() && usesCap()))
    set('mode', capsOk() ? 'name-capital' : flagsOk() ? 'flag-name' : 'shape-name');
  const { ask, answer } = MODES[settings.mode];
  $('#pop-row').hidden = !popOk();
  $('#popmodes').innerHTML = ['pop-compare', 'pop-guess']
    .map((k) => `<button data-mode="${k}" aria-pressed="${k === settings.mode}">${esc(MODES[k].label)}</button>`).join('');
  const chips = (which, sel, off) => FACETS.map((f) => `<button data-${which}="${f}" aria-pressed="${f === sel}"${
    f === off || (f === 'flag' && !flagsOk()) || (f === 'capital' && !capsOk()) ? ' disabled' : ''}>${esc(facetName(f))}</button>`).join('');
  $('#ask').innerHTML = chips('ask', ask, null);
  $('#answer').innerHTML = chips('answer', answer, ask);
  $('#regions').innerHTML = ['World', ...CONTINENTS]
    .map((r) => `<button data-region="${esc(r)}" aria-pressed="${r === 'World' ? !settings.regions.length : settings.regions.includes(r)}">${esc(r)}</button>`).join('');
  $('#territories').checked = settings.territories;
  const n = poolNow().length, all = scope === 'world' ? pool(data.countries, settings).length : scope === 'water' ? n : cur().items.length;
  $('#progress').textContent = n < all ? `${n} of ${all} ${cur().kinds} (the others have no flag)` : `${n} ${cur().kinds}`;
  // the hard pile of this scope (cards of countries, or of this country's subdivisions)
  const cards = Object.entries(store.hardCards()).filter(([k]) => cur().byId.has(store.parseKey(k).id));
  const nHard = cards.length, due = cards.filter(([, c]) => c.due <= Date.now()).length;
  $('#pile-info').innerHTML = nHard ? `<b>Hard pile</b> · ${nHard} card${nHard > 1 ? 's' : ''}, ${due} due` : '<b>Hard pile</b> · empty. Add cards after answering.';
  $('#start-pile').disabled = !nHard;
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
  showQuestion();  // first, so the camera knows how much of the screen the card covers
  if (q.type === 'map') {
    if (scope !== 'world' && scope !== 'water') world.flyToSet({ full: true });
    else world.flyToRegion(session.source === 'pile' ? [q.target.continent || q.target.continents?.[0]] : settings.regions);
  }
  if (q.ask === 'map' || q.type === 'estimate') showOnMap(q.target);
}

/** Free screen area for the map camera: below the tabs (and the deep-dive bar on the map tab),
    above whichever card is open at the bottom. */
function mapInsets() {
  const h = innerHeight;
  let top = $('#top').getBoundingClientRect().bottom;
  const bar = $('#scope-bar');
  if (getComputedStyle(bar).display !== 'none') top = bar.getBoundingClientRect().bottom;
  const card = [...document.querySelectorAll('.card')].find((c) => !c.hidden && getComputedStyle(c).display !== 'none');
  return { top, bottom: card ? h - card.getBoundingClientRect().top : 0 };
}

/** "Which country is this?": highlight it with its neighbours around; tiny countries (or ones
    without a shape) also get their capital dot so they can be found. */
function showOnMap(c) {
  world.mark({ [c.id]: 'sel' });
  const small = scope === 'world' ? 1 : scope === 'water' ? 0 : cur().smallSize;
  world.setMarkers(false, c.size < small ? [c.id] : null, { dots: true });
  world.flyToCountry(c, { context: true });
}

// estimate slider: log10 of the population, from 100 to ~3 billion
const EST = { min: 2, max: 9.5, start: 7 };
const estPct = (n) => ((Math.log10(n) - EST.min) / (EST.max - EST.min)) * 100;
const estHtml = () => `<div class="est">
  <div class="est-val"></div>
  <div class="est-row"><button data-step="-1" aria-label="Less">−</button>
    <div class="est-track"><input id="est" type="range" min="${EST.min}" max="${EST.max}" step="0.005" value="${EST.start}">
      <i class="est-truth" hidden></i>
      <div class="est-ticks">${[3, 4, 5, 6, 7, 8, 9].map((e) => `<span style="left:${((e - EST.min) / (EST.max - EST.min)) * 100}%">${['1k', '10k', '100k', '1M', '10M', '100M', '1B'][e - 3]}</span>`).join('')}</div>
    </div>
    <button data-step="1" aria-label="More">+</button></div></div>`;
const estValue = () => 10 ** parseFloat($('#est').value);
const showEst = () => { $('.est-val').textContent = '≈ ' + formatPop(estValue(), 2); };

const askHtml = (c, what) => q?.type === 'compare' ? '<div class="q-text">Which has more people?</div>'
  : q?.type === 'estimate' ? `${hasFlag(c) ? `<img class="q-flag small" src="${flagOf(c)}" alt="">` : ''}<div class="q-text"><small>How many people live in</small>${esc(nameOf(c))}?</div>`
  : what === 'map'
  ? `<div class="q-text">Which ${cur().kind} is this?</div>`
  : what === 'flag'
  ? `<img class="q-flag" src="${flagOf(c)}" alt="Flag">`
  : what === 'capital' ? `<div class="q-text"><small>Capital</small>${esc(capOf(c))}</div>`
  : `<div class="q-text"><small>${capFirst(cur().kind)}</small>${esc(nameOf(c))}</div>`;

const hint = { recall: '', map: 'Tap it on the map', choice: '' };

function showQuestion() {
  $('#setup').hidden = true;
  $('#learn').hidden = true;
  const card = $('#question');
  card.hidden = false;
  card.classList.toggle('map-q', q.type === 'map' || q.ask === 'map' || q.type === 'estimate');
  card.classList.toggle('answered', phase === 'done');
  $('#q-mode').textContent = (session.source === 'pile' ? 'Hard pile · ' : '') + modeLabel(q.mode);
  updateScore();
  $('#q-prompt').innerHTML = askHtml(q.target, q.ask) +
    (hint[q.type] ? `<p class="muted center">${hint[q.type]}</p>` : '') +
    (q.early && phase === 'ask' ? '<p class="muted center">Nothing due — practising early</p>' : '');
  const opts = $('#q-options');
  opts.className = q.answer === 'flag' ? 'grid flags' : q.type === 'compare' ? 'grid compare' : q.type === 'estimate' ? '' : 'grid';
  if (q.type === 'estimate') { opts.innerHTML = estHtml(); showEst(); }
  else opts.innerHTML = q.options.map((c) => `<button data-id="${c.id}">${
    q.answer === 'flag' ? `<img src="${flagOf(c)}" alt="">`
    : q.type === 'compare' ? `${hasFlag(c) ? `<img src="${flagOf(c)}" alt="">` : ''}<span>${esc(nameOf(c))}</span>`
    : esc(q.answer === 'capital' ? c.capital : c.name)}</button>`).join('');
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
}<div><b>${esc(nameOf(c))}</b>${c.capital ? `<br>Capital: ${esc(capOf(c))}` : c.desc ? `<br><span class="muted">${esc(c.desc)}</span>` : ''}</div></div>`;

/** Buttons and result area for the current phase: ask → (revealed, flashcards only) → done. */
function renderPhase() {
  const r = $('#q-result'), btns = $('#q-buttons');
  const key = store.cardKey(q.mode, q.target.id);
  if (phase === 'ask') {
    r.hidden = true;
    btns.innerHTML = q.type === 'recall'
      ? '<button data-act="reveal" class="primary wide">Show answer</button>'
      : q.type === 'estimate' ? '<button data-act="skip" class="ghost">Skip</button><button data-act="guess" class="primary">Guess</button>'
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
    if (b.dataset.id === rightId()) b.classList.add('right');
    else if (b.dataset.id === chosenId) b.classList.add('wrong');
  }
  if (q.type === 'estimate') {
    $('#est').disabled = true;
    const t = $('.est-truth');
    t.style.left = estPct(q.target.pop) + '%';
    t.hidden = false;
  }
  const chosen = chosenId && chosenId !== q.target.id ? cur().byId.get(chosenId) : null;
  if (q.type === 'compare') {
    const [a, b] = q.options;
    r.innerHTML = `<p class="verdict ${correct ? 'ok' : 'bad'}">${correct ? '✓ Correct' : verdict.skipped ? 'Skipped' : '✗ Not quite'}</p>` +
      [a, b].map((c) => `<p class="pop-line"><b>${esc(nameOf(c))}</b> ${formatPop(c.pop)}</p>`).join('') +
      `<p class="muted">${esc(nameOf(a.pop > b.pop ? a : b))} has ${formatPop(Math.max(a.pop, b.pop) / Math.min(a.pop, b.pop), 2)}× as many people.</p>`;
  } else if (q.type === 'estimate') {
    const f = verdict.guess ? offBy(verdict.guess, q.target.pop) : 0;
    const word = !verdict.guess ? 'Skipped' : f <= 1.2 ? '🎯 Spot on' : f <= GUESS_OK ? '✓ Close' : f <= 2 ? '✗ Not far' : '✗ Way off';
    r.innerHTML = `<p class="verdict ${correct ? 'ok' : 'bad'}">${word}</p>` +
      `<p class="pop-line"><b>${esc(nameOf(q.target))}</b> ${formatPop(q.target.pop)}</p>` +
      (verdict.guess ? `<p class="muted">Your guess: ${formatPop(verdict.guess, 2)} (${verdict.guess > q.target.pop ? 'too high' : 'too low'}, ${
        f < 2 ? Math.round((f - 1) * 100) + '%' : formatPop(f, 2) + '×'} off)</p>` : '');
  } else r.innerHTML = `<p class="verdict ${correct ? 'ok' : 'bad'}">${correct ? '✓ Correct' : verdict.skipped ? 'Skipped' : q.type === 'recall' ? '✗ Not yet' : '✗ Not quite'}</p>` +
    answerHtml(q.target) +
    (chosen ? `<p class="muted">You picked ${esc(nameOf(chosen))}${chosen.capital ? ` (${esc(capOf(chosen))})` : ''}</p>` : '');
  r.hidden = false;
  const inPile = store.isHard(key);
  btns.innerHTML = `<button data-act="pile" class="pile ${!inPile && !correct ? 'suggest' : ''}">${
    inPile ? '★ In hard pile · remove' : '☆ Add to hard pile'}</button><button data-act="next" class="primary">${session.deck.length ? 'Next' : 'Finish'}</button>`;
}

/** The option that is right: the target, or for "which is bigger" the more populous one. */
const rightId = () => (q.type === 'compare' ? q.options.reduce((a, b) => (b.pop > a.pop ? b : a)).id : q.target.id);

function answer(correct, chosenId, skipped = false, guess = null) {
  if (phase === 'done') return;
  phase = 'done';
  verdict = { correct, chosenId, skipped, guess };
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
  const marks = { [rightId()]: correct ? 'right' : 'target' };
  if (!correct && chosenId && chosenId !== rightId()) marks[chosenId] = 'wrong';
  world.mark(marks);
  world.setMarkers(false, Object.keys(marks));
  renderPhase();  // first: the result makes the card taller, the camera fits above it
  if (q.ask !== 'map' && q.type !== 'compare' && q.type !== 'estimate') world.flyToCountry(q.target);
}

// Progress lives on the phone (store.js). Sync was removed from the UI on 2026-10-07 (Phil):
// user accounts are a TODO; store.sync(backend) + sync-github.js stay for that.

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
    await setScope(exploreId);
    world.flyToSet();
    applyFlags();
  };
  $('#scope-bar .back').onclick = leaveDeepDive;
  // "Rivers & lakes" (experimental): map toggle and quiz filters
  $('#btn-water').onclick = async () => {
    const to = scope === 'water' ? 'world' : 'water';
    await setScope(to);
    world.flyToRegion(to === 'water' ? settings.regions : []);
    applyFlags();
  };
  $('#water-kinds').onclick = (e) => {
    const k = e.target.closest('button')?.dataset.wkind;
    if (!k) return;
    const next = settings.waterKinds.includes(k) ? settings.waterKinds.filter((x) => x !== k) : [...settings.waterKinds, k];
    set('waterKinds', next.length ? next : [k]);
    showSetup();
  };
  $('#water-level').onclick = (e) => { const z = e.target.closest('button')?.dataset.wlevel; if (z) { set('waterLevel', +z); showSetup(); } };
  $('#popmodes').onclick = (e) => { const b = e.target.closest('button'); if (b) { set('mode', b.dataset.mode); showSetup(); } };
  $('#learn-btn').onclick = showLearn;
  $('#learn .close').onclick = showSetup;
  $('#learn-search').oninput = renderLearnList;
  $('#learn-list').onclick = async (e) => {
    const id = e.target.closest('button')?.dataset.scope;
    if (!id) return;
    if (id !== scope) await setScope(id);
    showSetup();  // first, so the camera fits above the setup card
    if (id === 'world') world.flyToRegion(settings.regions); else world.flyToSet();
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
    if (isPop()) answer = null;  // coming from a population mode
    if (!answer || answer === a) answer = a === 'name' ? (flagsOk() ? 'flag' : 'capital') : 'name';  // can't ask for what is shown
    if (answer === 'capital' && !capsOk()) answer = a === 'name' ? 'map' : 'name';
    set('mode', modeFor(a, answer));
    showSetup();
  };
  $('#answer').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    let { ask } = MODES[settings.mode];
    if (isPop()) ask = b.dataset.answer === 'name' ? 'map' : 'name';  // coming from a population mode
    set('mode', modeFor(ask, b.dataset.answer));
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
    if (!b || phase !== 'ask') return;
    if (b.dataset.step) {  // estimate: fine steps of about ±5%
      const el = $('#est');
      el.value = Math.min(EST.max, Math.max(EST.min, parseFloat(el.value) + 0.02 * b.dataset.step));
      return showEst();
    }
    if (b.dataset.id) answer(b.dataset.id === rightId(), b.dataset.id);
  };
  $('#q-options').oninput = (e) => { if (e.target.id === 'est') showEst(); };
  $('#q-buttons').onclick = (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'reveal') {
      phase = 'revealed';
      world.mark({ [q.target.id]: 'target' });
      world.setMarkers(false, [q.target.id]);
      renderPhase();
      if (q.ask !== 'map') world.flyToCountry(q.target);  // a map question is already in view
    } else if (act === 'right' || act === 'wrong') answer(act === 'right', null);
    else if (act === 'skip') answer(false, null, true);
    else if (act === 'guess') { const g = estValue(); answer(offBy(g, q.target.pop) <= GUESS_OK, null, false, g); }
    else if (act === 'next') nextQuestion();
    else if (act === 'again') startQuiz(session.source);
    else if (act === 'setup') showSetup();
    else if (act === 'pile') {
      const key = store.cardKey(q.mode, q.target.id);
      store.isHard(key) ? store.removeHard(key) : store.addHard(key);
      renderPhase();
    }
  };
}

async function start() {
  data = await loadData();
  world = createMap($('#map'), {
    countries: data.countries, world: data.world, colors: data.colors, projection: settings.projection, onClick: onMapClick, insets: mapInsets,
  });
  worldSet = { id: 'world', name: 'World', kind: 'country', kinds: 'countries', items: data.countries, byId: data.byId };
  subIndex = await loadSubIndex();
  loadWater().then(([, geo]) => world.setWater(geo));  // the lakes of the country map
  window.__app = { data, world, store, setScope };  // for debugging / screenshots
  wire();
  world.map.on('load', async () => {
    fitScreen();
    if (settings.scope !== 'world') { await setScope(settings.scope); scope === 'water' ? world.flyToRegion(settings.regions) : world.flyToSet(); }
    showTab('map');
  });
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
