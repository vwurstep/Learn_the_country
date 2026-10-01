/* Wiring: tabs, the map tab's info card, and the quiz panels. */
import { loadData, flagUrl, CONTINENTS, getStats, record, resetStats, loadSetting, saveSetting } from './data.js';
import { createMap } from './map.js';
import { MODES, pool, makeQuestion } from './quiz.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

const settings = {
  showFlags: loadSetting('showFlags', true),
  projection: loadSetting('projection', 'globe'),
  mode: loadSetting('mode', 'flag-name'),
  region: loadSetting('region', 'World'),
  territories: loadSetting('territories', false),
};
const set = (k, v) => { settings[k] = v; saveSetting(k, v); };

let data, world, tab = 'map';

// ---- tabs ---------------------------------------------------------------------------------
function showTab(t) {
  tab = t;
  document.body.className = 'tab-' + t;
  $('#tab-map').setAttribute('aria-selected', t === 'map');
  $('#tab-quiz').setAttribute('aria-selected', t === 'quiz');
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
  world.setMarkers(settings.showFlags);
}
function openInfo(id) {
  const c = data.byId.get(id);
  if (!c) return closeInfo();
  infoId = id;
  world.select(id);
  const card = $('#info');
  card.querySelector('.info-flag').src = flagUrl(id);
  card.querySelector('.info-name').textContent = c.name;
  card.querySelector('.info-cap').textContent = 'Capital: ' + c.capital;
  card.querySelector('.info-meta').textContent = c.continent + (c.sovereign ? '' : ' · territory');
  const hide = !settings.showFlags;
  card.classList.toggle('hidden-answer', hide);
  card.querySelector('.reveal').hidden = !hide;
  card.hidden = false;
}
function closeInfo() {
  infoId = null;
  $('#info').hidden = true;
  world.select(null);
}

// ---- quiz -----------------------------------------------------------------------------------
let q = null, answered = false, recent = [];
let score = { right: 0, total: 0, streak: 0 };

function showSetup() {
  $('#question').hidden = true;
  const modes = $('#modes');
  modes.innerHTML = Object.entries(MODES)
    .map(([k, m]) => `<button data-mode="${k}" aria-pressed="${k === settings.mode}">${esc(m.label)}</button>`).join('');
  $('#regions').innerHTML = ['World', ...CONTINENTS]
    .map((r) => `<button data-region="${esc(r)}" aria-pressed="${r === settings.region}">${esc(r)}</button>`).join('');
  $('#territories').checked = settings.territories;
  const st = Object.values(getStats());
  const right = st.reduce((s, x) => s + x.right, 0), total = st.reduce((s, x) => s + x.right + x.wrong, 0);
  const n = pool(data.countries, settings).length;
  $('#progress').textContent = `${n} countries in this pool. ` +
    (total ? `So far: ${total} answers, ${Math.round((100 * right) / total)}% correct.` : 'No answers yet.');
  $('#setup').hidden = false;
}

function startQuiz() {
  score = { right: 0, total: 0, streak: 0 };
  recent = [];
  q = null;
  nextQuestion();
}

function nextQuestion() {
  const list = pool(data.countries, settings);
  if (!list.length) return;
  q = makeQuestion(settings.mode, list, data.countries.filter((c) => settings.territories || c.sovereign),
    { stats: getStats(), avoid: recent });
  recent = [q.target.id, ...recent].slice(0, Math.min(15, Math.floor(list.length / 2)));
  answered = false;
  world.mark({});
  world.setMarkers(false);
  if (q.answer === 'map') world.flyToRegion(settings.region);
  showQuestion();
}

const askHtml = (c, what) => what === 'flag'
  ? `<img class="q-flag" src="${flagUrl(c.id)}" alt="Flag">`
  : what === 'capital' ? `<div class="q-text"><small>Capital</small>${esc(c.capital)}</div>`
  : `<div class="q-text"><small>Country</small>${esc(c.name)}</div>`;

function showQuestion() {
  $('#setup').hidden = true;
  const card = $('#question');
  card.hidden = false;
  card.classList.toggle('map-q', q.answer === 'map');
  card.classList.toggle('answered', answered);
  $('#q-mode').textContent = MODES[q.mode].label;
  updateScore();
  $('#q-prompt').innerHTML = askHtml(q.target, q.ask) +
    (q.answer === 'map' ? '<p class="muted center">Tap it on the map</p>' : '');
  const opts = $('#q-options');
  opts.className = q.answer === 'flag' ? 'grid flags' : 'grid';
  opts.innerHTML = q.options.map((c) => `<button data-id="${c.id}">${
    q.answer === 'flag' ? `<img src="${flagUrl(c.id)}" alt="">` : esc(q.answer === 'capital' ? c.capital : c.name)}</button>`).join('');
  $('#q-result').hidden = true;
  $('#q-next').hidden = true;
  $('#q-skip').hidden = false;
  if (answered) renderResult();
}

function updateScore() {
  $('#q-score').textContent = `${score.right}/${score.total}` + (score.streak > 2 ? ` · 🔥${score.streak}` : '');
}

let lastResult = null;
function answer(correct, chosenId) {
  if (answered) return;
  answered = true;
  record(q.target.id, correct);
  score.total++;
  if (correct) { score.right++; score.streak++; } else score.streak = 0;
  const marks = { [q.target.id]: correct ? 'right' : 'target' };
  if (!correct && chosenId && chosenId !== q.target.id) marks[chosenId] = 'wrong';
  lastResult = { correct, chosenId };
  world.mark(marks);
  world.setMarkers(false, Object.keys(marks));
  world.flyToCountry(q.target);
  renderResult();
}

function renderResult() {
  const { correct, chosenId } = lastResult;
  updateScore();
  for (const b of $('#q-options').querySelectorAll('button')) {
    b.disabled = true;
    if (b.dataset.id === q.target.id) b.classList.add('right');
    else if (b.dataset.id === chosenId) b.classList.add('wrong');
  }
  const c = q.target;
  const chosen = chosenId && chosenId !== c.id ? data.byId.get(chosenId) : null;
  $('#question').classList.add('answered');
  const r = $('#q-result');
  r.innerHTML = `<p class="verdict ${correct ? 'ok' : 'bad'}">${correct ? '✓ Correct' : chosenId ? '✗ Not quite' : 'Skipped'}</p>
    <div class="answer"><img src="${flagUrl(c.id)}" alt=""><div><b>${esc(c.name)}</b><br>Capital: ${esc(c.capital)}</div></div>` +
    (chosen ? `<p class="muted">You picked ${esc(chosen.name)} (${esc(chosen.capital)})</p>` : '');
  r.hidden = false;
  $('#q-skip').hidden = true;
  $('#q-next').hidden = false;
}

// ---- events -------------------------------------------------------------------------------
function onMapClick(id, viaMarker, point) {
  if (tab === 'map') { id ? openInfo(id) : closeInfo(); return; }
  if (!q || answered || q.answer !== 'map') return;
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
  $('#info .reveal').onclick = () => {
    $('#info').classList.remove('hidden-answer');
    $('#info .reveal').hidden = true;
  };

  $('#modes').onclick = (e) => { const b = e.target.closest('button'); if (b) { set('mode', b.dataset.mode); showSetup(); } };
  $('#regions').onclick = (e) => { const b = e.target.closest('button'); if (b) { set('region', b.dataset.region); world.flyToRegion(b.dataset.region); showSetup(); } };
  $('#territories').onchange = (e) => { set('territories', e.target.checked); showSetup(); };
  $('#reset').onclick = () => { if (confirm('Forget all quiz progress?')) { resetStats(); showSetup(); } };
  $('#start').onclick = startQuiz;
  $('#q-back').onclick = () => { q = null; world.mark({}); world.setMarkers(false); showSetup(); };
  $('#q-next').onclick = nextQuestion;
  $('#q-skip').onclick = () => answer(false, null);
  $('#q-options').onclick = (e) => {
    const b = e.target.closest('button');
    if (b && !answered) answer(b.dataset.id === q.target.id, b.dataset.id);
  };
}

async function start() {
  data = await loadData();
  world = createMap($('#map'), {
    countries: data.countries, world: data.world, projection: settings.projection, onClick: onMapClick,
  });
  window.__app = { data, world };  // for debugging / screenshots
  wire();
  world.map.on('load', () => showTab('map'));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
start();
