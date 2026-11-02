import WaveSurfer from '/vendor/wavesurfer/wavesurfer.esm.js';
import RegionsPlugin from '/vendor/wavesurfer/plugins/regions.esm.js';
import { Engine, Rotation, cueOf } from '/engine.js';
import { renderPad, connect, escapeHtml, padKey, applyTextures, padName } from '/pad.js';
import { CURVES, fitFades, loudness, dbToGain } from '/envelope.js';
import { attachEnvelope, previewer } from '/wave-envelope.js';
import { mountMixer } from '/mixer-ui.js';
import { Midi, MIDI_ACTIONS, describe } from '/midi.js';

const $ = (s) => document.querySelector(s);
const api = async (url, body) =>
  (await fetch(url, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
// Имя трека без расширения: в списках и заголовках .mp3 только мешает
const trackName = (f) => f.replace(/\.[^.]+$/, '');
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
// Эталон для «Авто-громкости» пэда: средняя громкость дропов в отбивках, dBFS (см. loudness в envelope.js)
const PAD_TARGET_DB = -9;
const curveOptions = (value) => Object.entries(CURVES)
  .map(([k, n]) => `<option value="${k}" ${k === (value || 'linear') ? 'selected' : ''}>${n}</option>`).join('');

let settings = await api('/api/settings');
applyTextures();
let activeTab = 'live';

// ---------- Вкладки ----------
document.querySelectorAll('nav button[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + activeTab));
    if (activeTab !== 'jingles') jw?.ws.pause();
    if (activeTab !== 'pads') pw?.ws.pause();
    if (activeTab === 'jingles') { $('#j-show-tags').checked = !!settings.showJingleTags; loadJingleList(); }
    if (activeTab === 'pads') renderPadGrid();
    if (activeTab === 'mixer') mixer.show();
    if (activeTab === 'settings') renderSettings();
  }),
);

// ---------- Waveform с зумом вокруг курсора ----------
// Общий для разметки отбивок и обрезки пэдов
function createWave(container, url, regionsPlugin) {
  const ws = WaveSurfer.create({
    container,
    url,
    height: 150,
    waveColor: '#4b5266',
    progressColor: '#ff6a2b',
    cursorColor: '#ffffff',
    cursorWidth: 2,
    autoScroll: true,
    autoCenter: true, // при воспроизведении курсор держится по центру
    plugins: [regionsPlugin],
  });
  let px = 0; // 0 = весь трек по ширине

  // После зума прокручиваем так, чтобы курсор оказался в центре экрана
  const setZoom = (value) => {
    const fit = ws.getWidth() / (ws.getDuration() || 1);
    px = value <= fit ? 0 : Math.min(value, 2000);
    // волна перерисовывается асинхронно — центрируем, когда она уже стала шире
    const center = () => { if (px) ws.setScrollTime(Math.max(0, ws.getCurrentTime() - ws.getWidth() / px / 2)); };
    ws.once('redrawcomplete', center);
    ws.zoom(px);
    setTimeout(center, 80);
    return px;
  };
  // Колесо мыши: зум с центром на курсоре
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const fit = ws.getWidth() / (ws.getDuration() || 1);
    setZoom((px || fit) * (e.deltaY < 0 ? 1.3 : 1 / 1.3));
  }, { passive: false });
  return { ws, setZoom, zoomIn: () => setZoom((px || ws.getWidth() / (ws.getDuration() || 1)) * 1.6), zoomOut: () => setZoom(px / 1.6), fit: () => setZoom(0) };
}

// ---------- Эфир ----------
let engine, send, showStatus;
let saveTimer, pendingSave = {};

// Громкость крутят часто — пишем на диск не чаще раза в 0.5 с
function saveSettings(patch) {
  Object.assign(settings, patch);
  Object.assign(pendingSave, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { api('/api/settings', pendingSave); pendingSave = {}; }, 500);
}

let mountedKey = null; // какие настройки сейчас отрисованы в эфире
function mountPad() {
  mountedKey = padKey(settings);
  showStatus = renderPad($('#live-pad'), settings, (msg) => engine.command(msg), {
    master: true,
    analyser: () => engine?.strips?.master.analyser,
  });
  if (engine) engine.emit();
}

$('#go-live').addEventListener('click', async () => {
  engine = new Engine(() => settings, (st) => { showStatus?.(st); send?.(st); mixer.refresh(); }, saveSettings);
  send = connect('player', (msg) => {
    if (msg.type === 'connected') engine.emit(); // отдать пультам текущее состояние
    if (msg.type === 'replaced') return goOffline();
    if (msg.type === 'cmd') engine.command(msg);
    if (msg.type === 'remotes') showRemotes(msg);
    if (msg.type === 'settings') {
      const padsChanged = padKey(msg.settings) !== padKey(settings) || padKey(settings) !== mountedKey;
      settings = { ...msg.settings, ...pendingSave };
      if (padsChanged) { mountPad(); engine.preloadPads(); }
      mixer.refresh();
    }
  });
  mountPad();
  await engine.init();
  engine.preloadPads();
  $('#live-off').hidden = true;
  $('#live-on').hidden = false;
  $('#remote-btn').hidden = false;
  $('#on-air').hidden = false;
  const qr = await api('/api/qr');
  if (qr.url) {
    $('#qr').src = qr.qr;
    $('#qr-url').textContent = qr.url;
    if (qr.urls.length > 1) $('#qr-other').textContent = 'Другие адреса: ' + qr.urls.slice(1).join(', ');
  } else {
    $('#qr-url').textContent = 'Нет сети. Подключи ноутбук к точке доступа телефона и обнови страницу.';
  }
});

function goOffline() {
  engine.shutdown();
  engine = null;
  send = null;
  $('#live-on').hidden = true;
  $('#live-off').hidden = false;
  $('#remote-btn').hidden = true;
  $('#on-air').hidden = true;
  $('#remote-dlg').close();
  $('#live-off h1').textContent = 'Эфир перехвачен другой вкладкой';
  $('#live-off p').textContent = 'Звук теперь идёт из другой вкладки или окна. Эту можно закрыть.';
  // клон без старого обработчика «Начать эфир»
  const btn = $('#go-live').cloneNode(false);
  btn.textContent = '↻ Забрать эфир сюда';
  btn.onclick = () => location.reload();
  $('#go-live').replaceWith(btn);
}

let acceptRemotes = true;
function showRemotes({ count, devices, accept }) {
  acceptRemotes = accept;
  $('#remotes').textContent = count;
  $('#remote-devices').textContent = devices;
  $('#lock').textContent = accept ? 'Отключить пульты' : 'Разрешить пульты';
  $('#lock').classList.toggle('locked', !accept);
  $('#remote-state').textContent = accept ? 'Пульты разрешены' : 'Пульты заблокированы';
  $('.qr').classList.toggle('locked', !accept);
  $('#remote-btn').classList.toggle('locked', !accept);
}
// QR и управление пультами — во всплывающем окне из шапки, чтобы не занимали место в эфире
$('#remote-btn').addEventListener('click', () => $('#remote-dlg').showModal());
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
$('#lock').addEventListener('click', () => send?.({ type: 'acceptRemotes', value: !acceptRemotes }));

// цифра = порядковый номер видимого пэда в текущем банке
function padByKey(key) {
  const visible = engine.pads().map((p, i) => (p.file ? i : -1)).filter((i) => i >= 0);
  return visible[Number(key) - 1];
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  if (activeTab === 'jingles') return editorKeys(e);
  if (activeTab !== 'live' || !engine) return;
  const map = { ' ': 'jingle', Escape: 'jingleStop' };
  const key = e.key.toLowerCase();
  if (e.repeat) { if (map[e.key] || (e.key >= '1' && e.key <= '8')) e.preventDefault(); return; } // зажатая клавиша не «строчит»
  if (map[e.key]) engine.command({ cmd: map[e.key] });
  else if (['p', 'з'].includes(key)) engine.bgToggle();
  else if (['s', 'ы'].includes(key)) engine.bgStop();
  else if (['n', 'т'].includes(key)) engine.command({ cmd: 'bgNext' });
  else if (['q', 'й'].includes(key)) engine.command({ cmd: 'bankPrev' });
  else if (['w', 'ц'].includes(key)) engine.command({ cmd: 'bankNext' });
  else if (e.key >= '1' && e.key <= '8') {
    const slot = padByKey(e.key);
    if (slot === undefined) return;
    engine.padDown(slot); // для обычных пэдов — то же, что нажатие
  } else return;
  e.preventDefault();
});

// Отпустили цифру — пэд в режиме «пока держишь» затухает
document.addEventListener('keyup', (e) => {
  if (activeTab !== 'live' || !engine || !(e.key >= '1' && e.key <= '8')) return;
  const slot = padByKey(e.key);
  if (slot !== undefined) engine.padUp(slot);
});

// ---------- Разметка отбивок ----------
let jw, regions, current, cues = [], dirty = false;
let jingles = [];
let tagFilter = '*'; // '*' — все, '' — без раздела, иначе имя раздела
const NO_TAG = '';

async function loadJingleList() {
  ({ jingles } = await api('/api/library'));
  renderTagBar();
  const shown = jingles.filter((j) =>
    tagFilter === '*' ? true : tagFilter === NO_TAG ? !j.tags.length : j.tags.includes(tagFilter));
  $('#j-list').innerHTML = shown.length
    ? shown.map((j) => `<div data-name="${escapeHtml(j.name)}" draggable="true" class="${j.name === current ? 'active' : ''}">
        <span>${escapeHtml(trackName(j.name))}</span><span class="count">${j.cues.length || ''}</span></div>`).join('')
    : `<div class="muted">${jingles.length ? 'В этом разделе пусто. Перетащи сюда треки из «Все».' : 'Папка пуста — закинь треки в music/jingles'}</div>`;
  $('#j-list').querySelectorAll('[data-name]').forEach((el) => {
    el.addEventListener('click', () => openJingle(el.dataset.name));
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/jingle', el.dataset.name));
  });
}
$('#j-reload').addEventListener('click', loadJingleList);

function renderTagBar() {
  const count = (t) => jingles.filter((j) => (t === NO_TAG ? !j.tags.length : j.tags.includes(t))).length;
  const chip = (value, label, n, removable) => `<button class="tag ${tagFilter === value ? 'active' : ''}" data-tag="${escapeHtml(value)}">
      ${label}<small>${n}</small>${removable ? '<i data-del-tag title="Удалить раздел">×</i>' : ''}</button>`;
  $('#j-tags').innerHTML =
    chip('*', 'Все', jingles.length) +
    settings.jingleTags.map((t) => chip(t, '#' + escapeHtml(t), count(t), true)).join('') +
    chip(NO_TAG, 'Без раздела', count(NO_TAG)) +
    '<button class="tag add" id="j-tag-add" title="Новый раздел">＋</button>';
  $('#j-tags').querySelectorAll('[data-tag]').forEach((el) => {
    const tag = el.dataset.tag;
    el.onclick = (e) => {
      if (e.target.matches('[data-del-tag]')) return deleteTag(tag);
      tagFilter = tag;
      loadJingleList();
    };
    // перетащил трек на раздел — трек попал в раздел
    if (tag === '*' || tag === NO_TAG) return;
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop'); };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      const name = e.dataTransfer.getData('text/jingle');
      const j = jingles.find((x) => x.name === name);
      if (j && !j.tags.includes(tag)) setTrackTags(name, [...j.tags, tag]);
    };
  });
  $('#j-tag-add').onclick = addTag;
}

async function addTag() {
  const name = (prompt('Название раздела (например: хаус, рок, смешное)') || '').trim().replace(/^#/, '');
  if (!name || settings.jingleTags.includes(name)) return;
  settings = await api('/api/settings', { jingleTags: [...settings.jingleTags, name] });
  loadJingleList();
}

async function deleteTag(tag) {
  if (!confirm(`Удалить раздел #${tag}? Треки и их точки останутся, просто без этого раздела.`)) return;
  settings = await (await fetch('/api/tags/' + encodeURIComponent(tag), { method: 'DELETE' })).json();
  if (tagFilter === tag) tagFilter = '*';
  await loadJingleList();
  if (current) renderTrackTags();
}

async function setTrackTags(name, tags) {
  await api('/api/tags/' + encodeURIComponent(name), { tags });
  await loadJingleList();
  if (name === current) renderTrackTags();
}

// Разделы открытого трека: клик включает/выключает, сохраняется сразу
function renderTrackTags() {
  const j = jingles.find((x) => x.name === current);
  if (!j || !$('#e-tags')) return;
  $('#e-tags').innerHTML = settings.jingleTags.length
    ? settings.jingleTags.map((t) => `<button class="tag ${j.tags.includes(t) ? 'active' : ''}" data-t="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')
    : '<span class="muted small">Разделов пока нет — создай их кнопкой ＋ над списком треков.</span>';
  $('#e-tags').querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.t;
    setTrackTags(current, j.tags.includes(t) ? j.tags.filter((x) => x !== t) : [...j.tags, t]);
  }));
}

$('#j-show-tags').addEventListener('change', async (e) => {
  settings = await api('/api/settings', { showJingleTags: e.target.checked });
});

// Ручное управление отменяет прослушку точки — иначе она поставит паузу посреди трека
const cancelPreview = () => jPreview?.stop();

// Точка отбивки в редакторе — всегда объект; свои параметры (len, fadeIn…) есть, только если их меняли.
// Без своих параметров действуют общие из «Настроек».
const cueDefaults = () => ({ len: settings.jingleDuration, fadeIn: 0.05, fadeOut: settings.jingleFadeOut, curveIn: 'linear', curveOut: 'linear' });
const cueFull = (c) => ({ ...cueDefaults(), ...c });
const isCustom = (c) => Object.keys(c).length > 1;

let jPreview;

function openJingle(name) {
  if (dirty && !confirm('Точки не сохранены. Перейти к другому треку?')) return;
  cancelPreview();
  current = name;
  cues = (jingles.find((j) => j.name === name)?.cues || []).map((c) => ({ ...cueOf(c) }));
  dirty = false;
  jw?.ws.destroy();
  $('#j-editor').innerHTML = `
    <div class="ed-head">
      <h2>${escapeHtml(trackName(name))}</h2>
      <span id="e-msg"></span>
      <button class="btn" id="e-save">💾 Сохранить точки</button>
    </div>
    <div class="row"><span class="muted small">Разделы:</span><div class="tagbar" id="e-tags"></div></div>
    <div class="row">
      <button class="btn" id="e-play" title="Пробел">▶ / ❚❚</button>
      <button class="btn" id="e-add" title="Клавиша M">＋ Точка здесь <kbd>M</kbd></button>
      <span id="e-time" class="mono">0:00.0</span>
      <span class="grow"></span>
      <button class="btn" id="e-out" title="Отдалить">−</button>
      <button class="btn" id="e-fit" title="Весь трек">⤢</button>
      <button class="btn" id="e-in" title="Приблизить">＋</button>
    </div>
    <div class="wave" id="waveform"></div>
    <p class="hint">Колесо мыши — зум. Область отбивки двигается целиком, правый край — длина.
      Белые ручки внутри — где кончается плавный вход и начинается затухание.</p>
    <div class="cues" id="e-cues"></div>`;
  regions = RegionsPlugin.create();
  jw = createWave($('#waveform'), '/media/jingles/' + encodeURIComponent(name), regions);
  const ws = jw.ws;
  jPreview = previewer(ws);
  ws.on('decode', renderRegions);
  ws.on('timeupdate', (t) => ($('#e-time').textContent = fmt(t)));
  // пока тянут — перерисовываем дугу; отпустили — запоминаем
  regions.on('region-update', (r) => r.env?.redraw());
  regions.on('region-updated', (r) => {
    const c = cues[r.cueIndex];
    c.t = Math.round(r.start * 1000) / 1000;
    const len = Math.round((r.end - r.start) * 100) / 100;
    if (Math.abs(len - settings.jingleDuration) < 0.05) delete c.len;
    else c.len = len;
    markDirty();
    setTimeout(renderRegions); // пересоздаём области уже после события самого wavesurfer
  });
  regions.on('region-clicked', (r, e) => { e.stopPropagation(); previewCue(r.cueIndex); });
  ws.on('interaction', cancelPreview); // клик/перемотка по волне
  $('#e-play').onclick = () => { cancelPreview(); ws.playPause(); };
  $('#e-add').onclick = addCue;
  $('#e-in').onclick = jw.zoomIn;
  $('#e-out').onclick = jw.zoomOut;
  $('#e-fit').onclick = jw.fit;
  $('#e-save').onclick = saveCues;
  renderCueList();
  renderTrackTags();
  loadJingleList();
}

function addCue() {
  cues.push({ t: jw.ws.getCurrentTime() });
  markDirty();
  renderRegions();
}

function renderRegions() {
  if (!jw.ws.getDuration()) return; // волна ещё не загрузилась — отрисуем по decode
  regions.clearRegions();
  cues.sort((a, b) => a.t - b.t);
  cues.forEach((c, i) => {
    const f = cueFull(c);
    const r = regions.addRegion({
      start: c.t,
      end: Math.min(c.t + f.len, jw.ws.getDuration()),
      color: 'rgba(255, 106, 43, .13)',
      drag: true,
      resize: true,
      content: `#${i + 1}`,
    });
    r.cueIndex = i;
    const env = { fadeIn: f.fadeIn, fadeOut: f.fadeOut, curveIn: f.curveIn, curveOut: f.curveOut };
    r.env = attachEnvelope(r, env, (e) => {
      setCueParam(c, 'fadeIn', e.fadeIn);
      setCueParam(c, 'fadeOut', e.fadeOut);
      markDirty();
    });
  });
  renderCueList();
}

// Значение, равное общему из настроек, не храним — тогда точка следует за настройками
function setCueParam(c, key, value) {
  if (value === cueDefaults()[key]) delete c[key];
  else c[key] = value;
}

function renderCueList() {
  // Таблица точек: «свои» — параметры точки отличаются от общих из «Настроек»
  $('#e-cues').innerHTML = cues.length
    ? `<div class="cue cue-head"><span>#</span><span>Начало</span><span>Длина</span><span>Вход</span><span>Затухание</span><span></span></div>` +
      cues.map((c, i) => {
        const f = cueFull(c);
        return `<div class="cue ${isCustom(c) ? 'custom' : ''}" data-i="${i}">
          <b>${i + 1}</b>
          <span class="mono">${fmt(c.t)}</span>
          <span class="mono">${f.len.toFixed(1)} с</span>
          <span><span class="mono">${f.fadeIn.toFixed(2)} с</span> <select data-curve="curveIn">${curveOptions(f.curveIn)}</select></span>
          <span><span class="mono">${f.fadeOut.toFixed(2)} с</span> <select data-curve="curveOut">${curveOptions(f.curveOut)}</select></span>
          <span class="cue-acts">
            ${isCustom(c) ? `<button class="btn" data-reset="${i}" title="Свои настройки. Нажми, чтобы вернуть общие длину и затухания">↺ свои</button>` : ''}
            <button class="btn" data-play="${i}" title="Прослушать как в эфире">▶</button>
            <button class="btn" data-del="${i}" title="Удалить точку">✕</button>
          </span></div>`;
      }).join('')
    : '<p class="muted">Точек нет. Найди дроп, поставь курсор и нажми M.</p>';
  $('#e-cues').querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => previewCue(Number(b.dataset.play))));
  $('#e-cues').querySelectorAll('[data-curve]').forEach((sel) => (sel.onchange = () => {
    setCueParam(cues[sel.closest('[data-i]').dataset.i], sel.dataset.curve, sel.value);
    markDirty();
    renderRegions();
  }));
  $('#e-cues').querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.reset);
    cues[i] = { t: cues[i].t };
    markDirty();
    renderRegions();
  }));
  $('#e-cues').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
    cues.splice(Number(b.dataset.del), 1);
    markDirty();
    renderRegions();
  }));
}

// Прослушать точку так, как она прозвучит в эфире: с её длиной, входом и затуханием
function previewCue(i) {
  const f = cueFull(cues[i]);
  const [fadeIn, fadeOut] = fitFades(f.len, f.fadeIn, f.fadeOut);
  jPreview.play(cues[i].t, cues[i].t + f.len, { fadeIn, fadeOut, curveIn: f.curveIn, curveOut: f.curveOut });
}

function markDirty() {
  dirty = true;
  $('#e-msg').innerHTML = '<span class="dirty">● не сохранено</span>';
  $('#e-save').classList.add('accent'); // кнопка загорается, только когда есть что сохранять
  renderCueList();
}

async function saveCues() {
  const res = await api('/api/cues/' + encodeURIComponent(current), { cues });
  cues = res.cues.map((c) => ({ ...cueOf(c) }));
  dirty = false;
  $('#e-msg').textContent = '✓ Сохранено';
  $('#e-save').classList.remove('accent');
  loadJingleList();
}

function editorKeys(e) {
  if (!jw) return;
  if (e.key === ' ') { cancelPreview(); jw.ws.playPause(); }
  else if (['m', 'ь'].includes(e.key.toLowerCase())) addCue();
  else return;
  e.preventDefault();
}

window.addEventListener('beforeunload', (e) => {
  if (dirty || engine) e.preventDefault();
});

// ---------- Пэды ----------
let selectedPad = null, pw, padRegion, padEnv, padPreview;
let editBank = settings.activeBank || 0; // какой банк открыт в редакторе (не обязательно тот, что в эфире)

const emptyPad = (n) => ({
  name: `Пэд ${n}`, file: null, image: null, start: 0, end: null,
  fadeIn: 0, fadeOut: 0, curveIn: 'linear', curveOut: 'linear', gain: 0, mode: 'oneshot',
});
const bankPads = () => settings.banks[editBank].pads;

async function upload(kind, file) {
  const res = await fetch('/api/upload/' + kind, {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return (await res.json()).file;
}

async function savePads() {
  settings = await api('/api/settings', { banks: settings.banks });
  editBank = Math.min(editBank, settings.banks.length - 1);
  if (engine) { mountPad(); engine.preloadPads(); }
}

// Перетащили файл на пэд: звук или картинка — определяем по расширению
async function dropFiles(slot, files) {
  const pad = bankPads()[slot];
  for (const f of files) {
    if (AUDIO_RE.test(f.name)) {
      pad.file = await upload('samples', f);
      engine?.sampleCache.delete(pad.file); // файл с тем же именем мог замениться
      pad.start = 0;
      pad.end = null;
      if (/^Пэд \d$/.test(pad.name)) pad.name = f.name.replace(/\.[^.]+$/, '').slice(0, 24);
    } else if (IMAGE_RE.test(f.name)) {
      pad.image = await upload('images', f);
    }
  }
  await savePads();
  renderPadGrid();
  openPad(slot);
}

// Банки: переключение, добавление, переименование (двойной клик), удаление
function renderBankBar() {
  $('#p-banks').innerHTML = settings.banks.map((b, i) => `
    <button class="tag ${i === editBank ? 'active' : ''}" data-b="${i}" title="Двойной клик — переименовать">
      ${escapeHtml(b.name)}${settings.banks.length > 1 ? '<i data-del-bank title="Удалить банк">×</i>' : ''}</button>`).join('') +
    '<button class="tag add" id="p-bank-add" title="Новый банк из 8 пустых пэдов">＋ банк</button>';
  $('#p-banks').querySelectorAll('[data-b]').forEach((el) => {
    const i = Number(el.dataset.b);
    el.onclick = async (e) => {
      if (e.target.matches('[data-del-bank]')) {
        if (!confirm(`Удалить банк «${settings.banks[i].name}» со всеми его пэдами? Файлы останутся в music/.`)) return;
        settings.banks.splice(i, 1);
        editBank = Math.max(0, Math.min(editBank, settings.banks.length - 1));
        await savePads();
      } else editBank = i;
      selectedPad = null;
      pw?.ws.destroy();
      pw = null;
      renderPadGrid();
      $('#p-editor').innerHTML = '<p class="muted">Выбери пэд, чтобы настроить название и обрезку.</p>';
    };
    el.ondblclick = async () => {
      const name = (prompt('Название банка', settings.banks[i].name) || '').trim();
      if (!name) return;
      settings.banks[i].name = name.slice(0, 16);
      await savePads();
      renderPadGrid();
    };
  });
  $('#p-bank-add').onclick = async () => {
    settings.banks.push({ name: String.fromCharCode(65 + settings.banks.length), pads: Array.from({ length: 8 }, (_, i) => emptyPad(i + 1)) });
    editBank = settings.banks.length - 1;
    await savePads();
    renderPadGrid();
  };
}

let knownSamples = null; // файлы в music/samples — чтобы пометить пэды, чей звук не перенесли
async function renderPadGrid() {
  editBank = Math.min(editBank, settings.banks.length - 1);
  renderBankBar();
  knownSamples = new Set((await api('/api/library')).samples);
  const badge = (p) => (p.gain ? ` · ${p.gain > 0 ? '+' : ''}${p.gain} дБ` : '') + ({ loop: ' · ⟳', hold: ' · ✋' }[p.mode] || '');
  $('#p-grid').innerHTML = bankPads().map((p, i) => `
    <div class="pad-cell edit h${i} ${p.image ? 'has-img' : ''} ${p.file ? '' : 'unset'} ${p.file && !knownSamples.has(p.file) ? 'missing' : ''} ${i === selectedPad ? 'selected' : ''}"
         data-slot="${i}" ${p.image ? `style="--img:url('/media/images/${encodeURIComponent(p.image)}')"` : ''}>
      <span class="hue"></span>
      ${padName(p.name)}
      <small class="sub">${p.file ? (knownSamples.has(p.file) ? '♪' : '⚠ нет файла') : 'перетащи звук'}${p.image ? ' · 🖼' : ''}${badge(p)}</small>
    </div>`).join('');
  $('#p-grid').querySelectorAll('[data-slot]').forEach((el) => {
    const slot = Number(el.dataset.slot);
    el.onclick = () => openPad(slot);
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop'); };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      dropFiles(slot, [...e.dataTransfer.files]).catch((err) => alert(err.message));
    };
  });
}

function openPad(slot) {
  selectedPad = slot;
  const p = bankPads()[slot];
  pw?.ws.destroy();
  pw = null;
  padRegion = null;
  padEnv = null;
  $('#p-grid').querySelectorAll('[data-slot]').forEach((el) => el.classList.toggle('selected', Number(el.dataset.slot) === slot));
  const mode = (v, title, text) => `<label class="seg-opt"><input type="radio" name="p-mode" value="${v}"
      ${(p.mode || 'oneshot') === v ? 'checked' : ''}><span><b>${title}</b><small>${text}</small></span></label>`;
  // Сверху — что это за пэд, посередине — звук и картинка, снизу — как он звучит, в самом низу — сохранить
  $('#p-editor').innerHTML = `
    <div class="ed-head">
      <span class="ed-slot">${escapeHtml(settings.banks[editBank].name)}${slot + 1}</span>
      <input id="p-name" value="${escapeHtml(p.name)}" maxlength="24" placeholder="Название пэда">
      <button class="btn stop" id="p-clear" title="Убрать звук, картинку и настройки">Очистить пэд</button>
      <input type="file" id="p-input" hidden>
    </div>
    <div class="ed-media">
      <div class="ed-sound">
        <div class="row">
          <span class="ed-file mono">${p.file ? escapeHtml(p.file) : 'Звука нет'}</span>
          <span class="grow"></span>
          <button class="btn" id="p-file">♪ ${p.file ? 'Заменить звук' : 'Выбрать звук'}</button>
        </div>
        ${p.file ? `
          <div class="row">
            <button class="btn accent" id="p-play">▶ Прослушать</button>
            <button class="btn" id="p-stop" title="Стоп">■</button>
            <span class="mono" id="p-range"></span>
            <span class="grow"></span>
            <button class="btn" id="p-out" title="Отдалить">−</button><button class="btn" id="p-fit" title="Весь звук">⤢</button><button class="btn" id="p-in" title="Приблизить">＋</button>
          </div>
          <div class="wave" id="p-wave"></div>
          <p class="hint">Края оранжевой области — начало и конец куска. Белые ручки внутри — длина входа и затухания. Колесо мыши — зум.</p>`
        : '<p class="muted">Перетащи mp3 на пэд в сетке или нажми «Выбрать звук».</p>'}
      </div>
      <div class="ed-art">
        <div class="pad-art ${p.image ? 'has' : ''}" id="p-art" title="Перетащи сюда картинку или нажми, чтобы выбрать"
          ${p.image ? `style="background-image:url('/media/images/${encodeURIComponent(p.image)}')"` : ''}>
          ${p.image ? '' : '<span>Картинка<br><small>перетащи сюда</small></span>'}
        </div>
        <div class="row"><button class="btn" id="p-img">${p.image ? 'Заменить' : 'Выбрать'}</button>
          ${p.image ? '<button class="btn" id="p-noimg" title="Убрать картинку">✕</button>' : ''}</div>
      </div>
    </div>
    ${p.file ? `
      <div class="modules pad-props">
        <fieldset class="module mod-mode"><legend>Режим</legend>
          <div class="seg-opts">
            ${mode('oneshot', 'Один раз', 'играет кусок целиком')}
            ${mode('loop', 'По кругу', 'до повторного нажатия')}
            ${mode('hold', 'Пока держишь', 'отпустил — затух')}
          </div>
        </fieldset>
        <fieldset class="module"><legend>Вход</legend>
          <label><input type="number" id="p-fadein" min="0" step="0.1" value="${p.fadeIn || 0}"> с</label>
          <select id="p-curvein">${curveOptions(p.curveIn)}</select>
        </fieldset>
        <fieldset class="module"><legend>Затухание</legend>
          <label><input type="number" id="p-fadeout" min="0" step="0.1" value="${p.fadeOut || 0}"> с</label>
          <select id="p-curveout">${curveOptions(p.curveOut)}</select>
        </fieldset>
        <fieldset class="module mod-gain"><legend>Громкость</legend>
          <div class="row gain">
            <input type="range" id="p-gain" min="-12" max="12" step="0.5" value="${p.gain || 0}">
            <b class="mono" id="p-gain-val"></b>
            <button class="btn" id="p-auto" title="Подогнать к громкости отбивок">Авто</button>
          </div>
          <span class="muted small" id="p-loud"></span>
        </fieldset>
      </div>` : ''}
    <div class="ed-foot">
      <button class="btn accent" id="p-save">💾 Сохранить пэд</button> <span id="p-msg"></span>
      <span class="grow"></span>
      <span class="muted small">Всё хранится в папке <span class="mono">music/</span> и переезжает вместе с ней.</span>
    </div>`;

  const pick = (accept) => {
    const input = $('#p-input');
    input.accept = accept;
    input.onchange = () => dropFiles(slot, [...input.files]).catch((err) => alert(err.message));
    input.click();
  };
  $('#p-file').onclick = () => pick('audio/*');
  $('#p-img').onclick = () => pick('image/*');
  const art = $('#p-art');
  art.onclick = () => pick('image/*');
  art.ondragover = (e) => { e.preventDefault(); art.classList.add('drop'); };
  art.ondragleave = () => art.classList.remove('drop');
  art.ondrop = (e) => {
    e.preventDefault();
    art.classList.remove('drop');
    dropFiles(slot, [...e.dataTransfer.files].filter((f) => IMAGE_RE.test(f.name))).catch((err) => alert(err.message));
  };
  if ($('#p-noimg')) $('#p-noimg').onclick = async () => { bankPads()[slot].image = null; await savePads(); renderPadGrid(); openPad(slot); };
  $('#p-clear').onclick = async () => {
    if (!confirm('Очистить пэд? Файлы останутся в папках music/.')) return;
    bankPads()[slot] = emptyPad(slot + 1);
    await savePads();
    renderPadGrid();
    openPad(slot);
  };
  const unsaved = () => ($('#p-msg').innerHTML = '<span class="dirty">● не сохранено</span>');
  $('#p-save').onclick = async () => {
    const pad = bankPads()[slot];
    pad.name = $('#p-name').value.trim() || `Пэд ${slot + 1}`;
    if ($('#p-fadein')) {
      pad.fadeIn = Math.max(0, Number($('#p-fadein').value) || 0);
      pad.fadeOut = Math.max(0, Number($('#p-fadeout').value) || 0);
      pad.curveIn = $('#p-curvein').value;
      pad.curveOut = $('#p-curveout').value;
      pad.mode = $('[name=p-mode]:checked').value;
      pad.gain = Number($('#p-gain').value);
    }
    if (padRegion) {
      pad.start = Math.round(padRegion.start * 100) / 100;
      // конец «до самого конца» храним как null
      pad.end = padRegion.end >= pw.ws.getDuration() - 0.05 ? null : Math.round(padRegion.end * 100) / 100;
    }
    await savePads();
    renderPadGrid();
    $('#p-msg').textContent = '✓ Сохранено';
  };
  if (!p.file) return;

  const regs = RegionsPlugin.create();
  pw = createWave($('#p-wave'), '/media/samples/' + encodeURIComponent(p.file), regs);
  padPreview = previewer(pw.ws);
  const showRange = () => ($('#p-range').textContent = `${fmt(padRegion.start)} → ${fmt(padRegion.end)}  (${(padRegion.end - padRegion.start).toFixed(1)} с)`);
  // Громкость обрезанного куска — для сравнения с эталоном отбивок
  const showLoud = () => {
    const buf = pw.ws.getDecodedData();
    if (!buf || !padRegion) return null;
    const l = loudness(buf, padRegion.start, padRegion.end);
    const g = Number($('#p-gain').value);
    $('#p-loud').textContent = Number.isFinite(l)
      ? `Кусок: ${l.toFixed(1)} дБ, с усилением ${(l + g).toFixed(1)} дБ (отбивки в среднем ${PAD_TARGET_DB} дБ)`
      : 'Кусок слишком тихий для измерения';
    return l;
  };
  const showGain = () => {
    const g = Number($('#p-gain').value);
    $('#p-gain-val').textContent = (g > 0 ? '+' : '') + g.toFixed(1) + ' дБ';
    showLoud();
  };
  const env = () => ({
    fadeIn: Math.max(0, Number($('#p-fadein').value) || 0),
    fadeOut: Math.max(0, Number($('#p-fadeout').value) || 0),
    curveIn: $('#p-curvein').value,
    curveOut: $('#p-curveout').value,
  });
  pw.ws.on('decode', (duration) => {
    padRegion = regs.addRegion({ start: p.start || 0, end: p.end ?? duration, color: 'rgba(255,106,43,.22)', drag: true, resize: true });
    padEnv = env();
    // ручки на волне и цифры в полях — одно и то же, правятся с обеих сторон
    padRegion.envView = attachEnvelope(padRegion, padEnv, (e) => {
      $('#p-fadein').value = e.fadeIn;
      $('#p-fadeout').value = e.fadeOut;
      unsaved();
    });
    showRange();
    showGain();
  });
  regs.on('region-update', () => { padRegion?.envView.redraw(); showRange(); });
  regs.on('region-updated', () => { showRange(); showLoud(); unsaved(); });
  $('#p-editor').querySelectorAll('.pad-props input, .pad-props select').forEach((el) => (el.oninput = () => {
    if (padEnv) { Object.assign(padEnv, env()); padRegion.envView.redraw(); }
    if (el.id === 'p-gain') showGain();
    unsaved();
  }));
  $('#p-auto').onclick = () => {
    const l = showLoud();
    if (!Number.isFinite(l)) return;
    $('#p-gain').value = Math.max(-12, Math.min(12, Math.round((PAD_TARGET_DB - l) * 2) / 2));
    showGain();
    unsaved();
  };
  // Прослушка с теми же входом, затуханием и громкостью, что будут в эфире
  $('#p-play').onclick = () => {
    if (!padRegion) return;
    const e = env();
    const [fadeIn, fadeOut] = fitFades(padRegion.end - padRegion.start, e.fadeIn, e.fadeOut);
    padPreview.play(padRegion.start, padRegion.end, { ...e, fadeIn, fadeOut }, dbToGain(Number($('#p-gain').value)));
  };
  $('#p-stop').onclick = () => { pw.ws.pause(); padPreview.stop(); };
  $('#p-in').onclick = pw.zoomIn;
  $('#p-out').onclick = pw.zoomOut;
  $('#p-fit').onclick = pw.fit;
}

// ---------- Настройки ----------
const FIELDS = [
  ['bgCrossfade', 'Переход между фоновыми треками', 'сек'],
  ['bgStopFade', 'Затухание фона по Pause / Stop', 'сек'],
  ['jingleDuration', 'Длительность отбивки (если у точки не задана своя)', 'сек'],
  ['jingleFadeOut', 'Затухание отбивки (в конце и по «Стоп»)', 'сек'],
  ['duckLevel', 'Громкость фона во время отбивки (0–1)', ''],
];

function renderSettings() {
  $('#set-form').innerHTML = FIELDS.map(([k, label, unit]) => `
    <label for="f-${k}">${label}</label>
    <input id="f-${k}" type="number" min="0" step="${k === 'duckLevel' ? 0.05 : 0.5}" value="${settings[k]}">
    <span class="muted">${unit}</span>`).join('');
  renderRotation();
  renderMidi();
}

$('#set-save').addEventListener('click', async () => {
  const patch = {};
  for (const [k] of FIELDS) patch[k] = Math.max(0, Number($('#f-' + k).value) || 0);
  patch.duckLevel = Math.min(1, patch.duckLevel);
  settings = await api('/api/settings', patch);
  $('#set-msg').textContent = '✓ Сохранено';
});

// Ротация: сколько треков уже прозвучало в текущем круге
const jingleRotation = () => engine?.jingleRotation || new Rotation('emp-rotation-jingles');

async function renderRotation() {
  const { jingles: all } = await api('/api/library');
  const rot = jingleRotation();
  const ready = all.filter((j) => j.cues.length);
  const counts = ready.map((j) => rot.plays(j.name));
  const total = counts.reduce((a, b) => a + b, 0);
  const min = counts.length ? Math.min(...counts) : 0;
  const left = counts.filter((c) => c === min).length;
  $('#rot-stats').innerHTML = total
    ? `Сыграно отбивок: <b>${total}</b>. Идёт круг №${min + 1}: в нём ещё не звучали <b>${left}</b> из ${ready.length} треков.`
    : `Счётчик пуст: все ${ready.length} размеченных треков в равных условиях.`;
}

$('#rot-reset').addEventListener('click', () => {
  if (!confirm('Обнулить счётчик? Все треки снова станут «ещё не звучавшими».')) return;
  jingleRotation().reset();
  renderRotation();
});

// ---------- MIDI ----------
const midi = new Midi(() => settings.midi || {}, midiAction, () => { midiDot(); if (activeTab === 'settings') renderMidiState(); });
let learning = null; // действие, которое сейчас ждёт контроллер

function midiAction(action, ev) {
  if (!engine) return;
  const [kind, arg] = action.split(':');
  if (kind === 'vol') return engine.setVolume(arg, ev.value);
  if (kind === 'pad') return ev.on ? engine.padDown(Number(arg)) : engine.padUp(Number(arg));
  if (!ev.on) return; // остальным кнопкам отпускание не важно
  if (kind === 'bank') { if (Number(arg) < settings.banks.length) engine.setBank(Number(arg)); return; }
  engine.command({ cmd: action });
}

function midiDot() {
  $('#midi-dot').hidden = !midi.inputs().length;
}

async function startMidi() {
  try {
    await midi.start();
    try { localStorage.setItem('emp-midi', '1'); } catch {}
  } catch {
    alert('Браузер не дал доступ к MIDI. Разреши его в настройках сайта (значок слева от адреса).');
  }
  renderMidi();
}

function renderMidi() {
  if (!Midi.supported()) {
    $('#midi').innerHTML = '<p class="muted">Этот браузер не умеет MIDI. Открой плеер в Chrome или Edge.</p>';
    return;
  }
  if (!midi.access) {
    $('#midi').innerHTML = `<p class="muted small">Подключи контроллер к ноутбуку по USB и нажми кнопку. Браузер один раз спросит разрешение.</p>
      <button class="btn accent" id="midi-on">🎹 Включить MIDI</button>`;
    $('#midi-on').onclick = startMidi;
    return;
  }
  const b = settings.midi || {};
  $('#midi').innerHTML = `
    <div class="row small"><span id="midi-devices"></span><span class="grow"></span><span class="muted mono" id="midi-last"></span></div>
    <p class="muted small">Нажми «Назначить», затем пэд, кнопку или крутилку на контроллере. Esc — отмена.</p>
    <div class="midi-map">${MIDI_ACTIONS.map((a) => `
      <div class="midi-row ${learning === a.id ? 'learning' : ''}" data-a="${a.id}">
        <span>${a.name}${a.knob ? ' <small class="muted">(крутилка)</small>' : ''}</span>
        <span class="mono small ${b[a.id] ? '' : 'muted'}">${learning === a.id ? 'жду контроллер…' : b[a.id] ? describe(b[a.id]) : '—'}</span>
        <button class="btn" data-learn>Назначить</button>
        ${b[a.id] ? '<button class="btn" data-unbind title="Убрать">✕</button>' : '<span></span>'}
      </div>`).join('')}</div>`;
  $('#midi').querySelectorAll('[data-learn]').forEach((btn) => (btn.onclick = () => learn(btn.closest('[data-a]').dataset.a)));
  $('#midi').querySelectorAll('[data-unbind]').forEach((btn) => (btn.onclick = () => {
    const map = { ...settings.midi };
    delete map[btn.closest('[data-a]').dataset.a];
    saveMidi(map);
  }));
  renderMidiState();
}

function renderMidiState() {
  if (!$('#midi-devices')) return;
  const inputs = midi.inputs();
  $('#midi-devices').innerHTML = inputs.length ? '🟢 ' + inputs.map(escapeHtml).join(', ') : '⚪ Контроллер не найден — подключи по USB';
  const l = midi.last;
  // последнее сообщение: удобно проверить, что вообще шлёт контроллер
  $('#midi-last').textContent = l ? `${l.device}: ${describe(l)}${l.type === 'cc' ? ' = ' + l.value : l.on ? ' ▼' : ' ▲'}` : '';
}

async function learn(action) {
  learning = action;
  renderMidi();
  const binding = await midi.learn(action);
  learning = null;
  if (!binding) return renderMidi();
  // одна кнопка — одно действие: убираем эту же привязку у других
  const map = Object.fromEntries(Object.entries(settings.midi || {})
    .filter(([, b]) => !(b.type === binding.type && b.channel === binding.channel && b.number === binding.number)));
  map[action] = binding;
  saveMidi(map);
}

async function saveMidi(map) {
  settings = await api('/api/settings', { midi: map });
  renderMidi();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && learning) { midi.cancelLearn(); learning = null; renderMidi(); }
});

// MIDI включали раньше — подключаемся сразу, чтобы контроллер работал без захода в настройки
try { if (localStorage.getItem('emp-midi') === '1' && Midi.supported()) midi.start().then(midiDot).catch(() => {}); } catch {}

// ---------- Микшер ----------
const mixer = mountMixer($('#mixer'), { settings: () => settings, engine: () => engine, save: saveSettings });
