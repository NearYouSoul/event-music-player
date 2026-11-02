import WaveSurfer from '/vendor/wavesurfer/wavesurfer.esm.js';
import RegionsPlugin from '/vendor/wavesurfer/plugins/regions.esm.js';
import { Engine } from '/engine.js';
import { renderPad, connect, escapeHtml, padKey } from '/pad.js';

const $ = (s) => document.querySelector(s);
const api = async (url, body) =>
  (await fetch(url, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

let settings = await api('/api/settings');
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
  showStatus = renderPad($('#live-pad'), settings, (msg) => engine.command(msg), { master: true });
  if (engine) engine.emit();
}

$('#go-live').addEventListener('click', async () => {
  engine = new Engine(() => settings, (st) => { showStatus?.(st); send?.(st); }, saveSettings);
  send = connect('player', (msg) => {
    if (msg.type === 'connected') engine.emit(); // отдать пультам текущее состояние
    if (msg.type === 'replaced') return goOffline();
    if (msg.type === 'cmd') engine.command(msg);
    if (msg.type === 'remotes') showRemotes(msg);
    if (msg.type === 'settings') {
      const padsChanged = padKey(msg.settings) !== padKey(settings) || padKey(settings) !== mountedKey;
      settings = { ...msg.settings, ...pendingSave };
      if (padsChanged) { mountPad(); engine.preloadPads(); }
    }
  });
  mountPad();
  engine.init();
  engine.preloadPads();
  $('#live-off').hidden = true;
  $('#live-on').hidden = false;
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
}
$('#lock').addEventListener('click', () => send?.({ type: 'acceptRemotes', value: !acceptRemotes }));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (activeTab === 'jingles') return editorKeys(e);
  if (activeTab !== 'live' || !engine) return;
  const map = { ' ': 'jingle', Escape: 'jingleStop' };
  const key = e.key.toLowerCase();
  if (map[e.key]) engine.command({ cmd: map[e.key] });
  else if (['p', 'з'].includes(key)) engine.bgToggle();
  else if (['s', 'ы'].includes(key)) engine.bgStop();
  else if (['n', 'т'].includes(key)) engine.command({ cmd: 'bgNext' });
  else if (e.key >= '1' && e.key <= '8') {
    // цифра = порядковый номер видимого пэда
    const visible = settings.pads.map((p, i) => (p.file ? i : -1)).filter((i) => i >= 0);
    const slot = visible[Number(e.key) - 1];
    if (slot === undefined) return;
    engine.pad(slot);
  } else return;
  e.preventDefault();
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
        <span>${escapeHtml(j.name)}</span><span class="count">${j.cues.length || ''}</span></div>`).join('')
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

// Ручное управление отменяет таймер «Прослушать N с» — иначе он поставит паузу посреди трека
const cancelPreview = () => clearTimeout(previewTimer);

function openJingle(name) {
  if (dirty && !confirm('Точки не сохранены. Перейти к другому треку?')) return;
  cancelPreview();
  current = name;
  cues = [...(jingles.find((j) => j.name === name)?.cues || [])];
  dirty = false;
  jw?.ws.destroy();
  $('#j-editor').innerHTML = `
    <h2>${escapeHtml(name)}</h2>
    <div class="tagbar" id="e-tags"></div>
    <div class="row">
      <button class="btn" id="e-play">▶ / ❚❚</button>
      <button class="btn accent" id="e-add">＋ Точка здесь (M)</button>
      <span id="e-time" class="mono">0:00.0</span>
      <span class="grow"></span>
      <button class="btn" id="e-out" title="Отдалить">−</button>
      <button class="btn" id="e-fit" title="Весь трек">⤢</button>
      <button class="btn" id="e-in" title="Приблизить">＋</button>
    </div>
    <div class="wave" id="waveform"></div>
    <p class="hint">Колесо мыши над волной — зум вокруг курсора. Точки можно перетаскивать.</p>
    <div class="row"><button class="btn" id="e-save">💾 Сохранить точки</button> <span id="e-msg"></span></div>
    <div class="cues" id="e-cues"></div>`;
  regions = RegionsPlugin.create();
  jw = createWave($('#waveform'), '/media/jingles/' + encodeURIComponent(name), regions);
  const ws = jw.ws;
  ws.on('decode', renderRegions);
  ws.on('timeupdate', (t) => ($('#e-time').textContent = fmt(t)));
  regions.on('region-updated', () => {
    cues = regions.getRegions().map((r) => r.start);
    markDirty();
  });
  regions.on('region-clicked', (r, e) => { e.stopPropagation(); cancelPreview(); ws.setTime(r.start); ws.play(); });
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
  cues.push(jw.ws.getCurrentTime());
  markDirty();
  renderRegions();
}

function renderRegions() {
  regions.clearRegions();
  cues.sort((a, b) => a - b);
  cues.forEach((c, i) => regions.addRegion({ start: c, color: '#ff6a2b', drag: true, content: `#${i + 1}` }));
  renderCueList();
}

function renderCueList() {
  $('#e-cues').innerHTML = cues.length
    ? cues.map((c, i) => `<div class="row cue"><b>#${i + 1}</b> <span class="mono">${fmt(c)}</span>
        <button class="btn" data-play="${i}">▶ Прослушать ${settings.jingleDuration} с</button>
        <button class="btn" data-del="${i}">✕</button></div>`).join('')
    : '<p class="muted">Точек нет. Найди дроп, поставь курсор и нажми M.</p>';
  $('#e-cues').querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => previewCue(cues[b.dataset.play])));
  $('#e-cues').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
    cues.splice(Number(b.dataset.del), 1);
    markDirty();
    renderRegions();
  }));
}

let previewTimer;
function previewCue(t) {
  clearTimeout(previewTimer);
  jw.ws.setTime(t);
  jw.ws.play();
  previewTimer = setTimeout(() => jw.ws.pause(), settings.jingleDuration * 1000);
}

function markDirty() {
  dirty = true;
  $('#e-msg').innerHTML = '<span class="dirty">● есть несохранённые изменения</span>';
  renderCueList();
}

async function saveCues() {
  const res = await api('/api/cues/' + encodeURIComponent(current), { cues });
  cues = res.cues;
  dirty = false;
  $('#e-msg').textContent = '✓ Сохранено';
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
let selectedPad = null, pw, padRegion;

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
  settings = await api('/api/settings', { pads: settings.pads });
  if (engine) { mountPad(); engine.preloadPads(); }
}

// Перетащили файл на пэд: звук или картинка — определяем по расширению
async function dropFiles(slot, files) {
  const pad = settings.pads[slot];
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

function renderPadGrid() {
  $('#p-grid').innerHTML = settings.pads.map((p, i) => `
    <div class="pad-cell edit h${i} ${p.image ? 'has-img' : ''} ${p.file ? '' : 'unset'} ${i === selectedPad ? 'selected' : ''}"
         data-slot="${i}" ${p.image ? `style="--img:url('/media/images/${encodeURIComponent(p.image)}')"` : ''}>
      <span class="hue"></span>
      <span class="name">${escapeHtml(p.name)}</span>
      <small class="sub">${p.file ? '♪' : 'перетащи звук'}${p.image ? ' · 🖼' : ''}</small>
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
  const p = settings.pads[slot];
  pw?.ws.destroy();
  pw = null;
  padRegion = null;
  $('#p-grid').querySelectorAll('[data-slot]').forEach((el) => el.classList.toggle('selected', Number(el.dataset.slot) === slot));
  $('#p-editor').innerHTML = `
    <div class="row">
      <h2>Пэд ${slot + 1}</h2>
      <input id="p-name" value="${escapeHtml(p.name)}" maxlength="24" placeholder="Название">
      <span class="grow"></span>
      <button class="btn" id="p-file">♪ Выбрать звук</button>
      <button class="btn" id="p-img">🖼 Картинка</button>
      ${p.image ? '<button class="btn" id="p-noimg">Убрать картинку</button>' : ''}
      <button class="btn stop" id="p-clear">Очистить пэд</button>
      <input type="file" id="p-input" hidden>
    </div>
    ${p.file ? `
      <p class="muted mono">${escapeHtml(p.file)}</p>
      <div class="row">
        <button class="btn accent" id="p-play">▶ Прослушать обрезку</button>
        <button class="btn" id="p-stop">■</button>
        <span class="mono" id="p-range"></span>
        <span class="grow"></span>
        <button class="btn" id="p-out">−</button><button class="btn" id="p-fit">⤢</button><button class="btn" id="p-in">＋</button>
      </div>
      <div class="wave" id="p-wave"></div>
      <p class="hint">Тяни края оранжевой области, чтобы задать начало и конец. Колесо мыши — зум.</p>
      <div class="row fades">
        <label>Плавный вход <input type="number" id="p-fadein" min="0" step="0.1" value="${p.fadeIn || 0}"> с</label>
        <label>Затухание <input type="number" id="p-fadeout" min="0" step="0.1" value="${p.fadeOut || 0}"> с</label>
      </div>`
    : '<p class="muted">Перетащи mp3 на пэд или нажми «Выбрать звук». Картинку — так же.</p>'}
    <div class="row"><button class="btn" id="p-save">💾 Сохранить пэд</button> <span id="p-msg"></span></div>`;

  const pick = (accept) => {
    const input = $('#p-input');
    input.accept = accept;
    input.onchange = () => dropFiles(slot, [...input.files]).catch((err) => alert(err.message));
    input.click();
  };
  $('#p-file').onclick = () => pick('audio/*');
  $('#p-img').onclick = () => pick('image/*');
  if ($('#p-noimg')) $('#p-noimg').onclick = async () => { p.image = null; await savePads(); renderPadGrid(); openPad(slot); };
  $('#p-clear').onclick = async () => {
    if (!confirm('Очистить пэд? Файлы останутся в папках music/.')) return;
    settings.pads[slot] = { name: `Пэд ${slot + 1}`, file: null, image: null, start: 0, end: null, fadeIn: 0, fadeOut: 0 };
    await savePads();
    renderPadGrid();
    openPad(slot);
  };
  $('#p-save').onclick = async () => {
    p.name = $('#p-name').value.trim() || `Пэд ${slot + 1}`;
    if ($('#p-fadein')) {
      p.fadeIn = Math.max(0, Number($('#p-fadein').value) || 0);
      p.fadeOut = Math.max(0, Number($('#p-fadeout').value) || 0);
    }
    if (padRegion) {
      p.start = Math.round(padRegion.start * 100) / 100;
      // конец «до самого конца» храним как null
      p.end = padRegion.end >= pw.ws.getDuration() - 0.05 ? null : Math.round(padRegion.end * 100) / 100;
    }
    await savePads();
    renderPadGrid();
    $('#p-msg').textContent = '✓ Сохранено';
  };
  if (!p.file) return;

  const regs = RegionsPlugin.create();
  pw = createWave($('#p-wave'), '/media/samples/' + encodeURIComponent(p.file), regs);
  const showRange = () => ($('#p-range').textContent = `${fmt(padRegion.start)} → ${fmt(padRegion.end)}  (${(padRegion.end - padRegion.start).toFixed(1)} с)`);
  pw.ws.on('decode', (duration) => {
    padRegion = regs.addRegion({ start: p.start || 0, end: p.end ?? duration, color: 'rgba(255,106,43,.22)', drag: true, resize: true });
    showRange();
  });
  regs.on('region-updated', () => { showRange(); $('#p-msg').innerHTML = '<span class="dirty">● не сохранено</span>'; });
  // Прослушка с теми же входом и затуханием, что будут в эфире
  let fadeTimer;
  const previewFades = () => {
    clearInterval(fadeTimer);
    const fi = Math.max(0, Number($('#p-fadein').value) || 0);
    const fo = Math.max(0, Number($('#p-fadeout').value) || 0);
    fadeTimer = setInterval(() => {
      if (!pw || !pw.ws.isPlaying()) { clearInterval(fadeTimer); pw?.ws.setVolume(1); return; }
      const now = pw.ws.getCurrentTime();
      const vIn = fi ? (now - padRegion.start) / fi : 1;
      const vOut = fo ? (padRegion.end - now) / fo : 1;
      pw.ws.setVolume(Math.max(0, Math.min(1, vIn, vOut)));
    }, 25);
  };
  $('#p-play').onclick = () => {
    if (!padRegion) return;
    pw.ws.setVolume(Number($('#p-fadein').value) > 0 ? 0 : 1);
    padRegion.play(true);
    previewFades();
  };
  $('#p-stop').onclick = () => pw.ws.pause();
  $('#p-editor').querySelectorAll('.fades input').forEach((el) =>
    (el.oninput = () => ($('#p-msg').innerHTML = '<span class="dirty">● не сохранено</span>')));
  $('#p-in').onclick = pw.zoomIn;
  $('#p-out').onclick = pw.zoomOut;
  $('#p-fit').onclick = pw.fit;
}

// ---------- Настройки ----------
const FIELDS = [
  ['bgCrossfade', 'Переход между фоновыми треками', 'сек'],
  ['bgStopFade', 'Затухание фона по Pause / Stop', 'сек'],
  ['jingleDuration', 'Длительность отбивки', 'сек'],
  ['jingleFadeOut', 'Затухание отбивки (в конце и по «Стоп»)', 'сек'],
  ['duckLevel', 'Громкость фона во время отбивки (0–1)', ''],
];

function renderSettings() {
  $('#set-form').innerHTML = FIELDS.map(([k, label, unit]) => `
    <label for="f-${k}">${label}</label>
    <input id="f-${k}" type="number" min="0" step="${k === 'duckLevel' ? 0.05 : 0.5}" value="${settings[k]}">
    <span class="muted">${unit}</span>`).join('');
}

$('#set-save').addEventListener('click', async () => {
  const patch = {};
  for (const [k] of FIELDS) patch[k] = Math.max(0, Number($('#f-' + k).value) || 0);
  patch.duckLevel = Math.min(1, patch.duckLevel);
  settings = await api('/api/settings', patch);
  $('#set-msg').textContent = '✓ Сохранено';
});
