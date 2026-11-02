import { bgSourceLabel } from '/engine.js';

// Значок «перейти к треку» (только на ноутбуке: на телефоне редакторов нет)
const GO_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.5 3H3v10h10V9.5M9.5 2.5h4v4M13.5 2.5 7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Панель эфира: раздел «Игра» (отбивка + пэды), «Фон» и «Уровни» (крутилки громкости).
// Одна и та же на ноутбуке (колонками) и на телефоне (вкладками).
// send(msg) — что делать при нажатии; возвращает функцию для показа статуса.
// analyser — только на ноутбуке: откуда брать спектр для экрана в «Уровнях».
// openTrack(kind, name) — только на ноутбуке: открыть трек в «Разметке отбивок» (jingle) или во вкладке «Фон» (bg).
export function renderPad(root, settings, send, { tabs = false, master = false, analyser = null, openTrack = null } = {}) {
  // Все банки рисуем сразу, видимый переключается статусом — без перерисовки и задержки
  const banks = settings.banks.map((b, bank) => {
    const pads = b.pads.map((p, i) => ({ ...p, bank, slot: i })).filter((p) => p.file);
    // Пэды идут по 2 в ряд; нечётный хвост добиваем пустой ячейкой
    const cells = pads.map(padHtml).join('') + (pads.length % 2 ? '<div class="pad-cell empty"></div>' : '');
    return `<div class="pads" data-bank-grid="${bank}" ${bank === settings.activeBank ? '' : 'hidden'}>${cells ||
      '<p class="muted">В этом банке нет пэдов со звуком. Назначь их на ноутбуке во вкладке «Пэды».</p>'}</div>`;
  }).join('');
  const bankBar = settings.banks.length > 1
    ? `<div class="banks">${settings.banks.map((b, i) => `<button data-bank-btn="${i}">${escapeHtml(b.name)}</button>`).join('')}</div>`
    : '';
  // Переключатель разделов отбивок (включается в «Разметке отбивок»)
  const jtags = settings.showJingleTags && settings.jingleTags.length
    ? `<div class="jtags">${['', ...settings.jingleTags].map((t) =>
        `<button class="jtag" data-jtag="${escapeHtml(t)}">#${t ? escapeHtml(t) : 'случайные'}</button>`).join('')}</div>`
    : '';

  // Откуда играет фон: все треки, закладки, тег или плейлист (настраивается во вкладке «Фон»)
  const lib = settings.bgLibrary || { tags: [], bookmarks: [], playlists: [] };
  const sources = [
    { type: 'all' },
    ...(lib.bookmarks.length ? [{ type: 'bookmarks' }] : []),
    ...lib.tags.map((name) => ({ type: 'tag', name })),
    ...lib.playlists.map((p) => ({ type: 'playlist', name: p.name })),
  ];
  const bgSources = sources.length > 1
    ? `<div class="jtags bgsrc">${sources.map((src) =>
        `<button class="jtag" data-bgsrc='${escapeHtml(JSON.stringify(src))}'>${escapeHtml(bgSourceLabel(src))}</button>`).join('')}</div>`
    : '';

  root.innerHTML = `
    ${tabs ? `<div class="seg">
      <button data-tab="game" class="active">Игра<i class="dot" id="dot-game"></i></button>
      <button data-tab="bg">Фон<i class="dot" id="dot-bg"></i></button>
      <button data-tab="levels">Уровни</button>
    </div>` : ''}
    <div class="toast" id="toast"></div>
    <div class="deck-grid ${tabs ? 'tabs' : ''}">
      <section class="deck game" data-sec="game">
        <h3>Игра</h3>
        <div class="now-jingle" id="nj"><div class="nj-track"><span id="nj-text"></span></div>${openTrack
          ? `<button class="go-track" id="nj-go" hidden title="Открыть в «Разметке отбивок»">${GO_ICON}</button>` : ''}</div>
        <div class="jingle-row">
          <button class="jingle-btn" data-cmd="jingle"><span>Отбивка</span><small id="jingle-mode">случайная</small><b class="bar"></b></button>
          <button class="btn stop" data-cmd="jingleStop">Стоп</button>
        </div>
        ${jtags}
        ${bankBar}
        <div class="pads-scroll">${banks}</div>
      </section>
      <div class="side">
      <section class="deck bg" data-sec="bg" ${tabs ? 'hidden' : ''}>
        <h3>Фон</h3>
        ${bgSources}
        <div class="vinyl-wrap">
          <div class="vinyl" id="vinyl">
            <div class="record"><div class="grooves"></div><div class="label"><div class="hole"></div></div></div>
            <div class="arm"><div class="arm-rod"></div><div class="arm-head"></div></div>
          </div>
          <div class="now">
            <div class="track-row"><div class="track" id="bg-track">—</div>${openTrack
              ? `<button class="go-track" id="bg-go" hidden title="Открыть во вкладке «Фон»">${GO_ICON}</button>` : ''}</div>
            <div class="bg-place" id="bg-place"></div>
            <div class="progress"><b class="bar" id="bg-bar"></b></div>
            <div class="times"><span id="bg-pos">0:00</span><span id="bg-left">-0:00</span></div>
          </div>
        </div>
        <div class="transport">
          <button class="btn go" data-cmd="bgPlay">▶<small>Play</small></button>
          <button class="btn" data-cmd="bgPause">❚❚<small>Pause</small></button>
          <button class="btn stop" data-cmd="bgStop">■<small>Stop</small></button>
          <button class="btn" data-cmd="bgNext">⏭<small>Дальше</small></button>
        </div>
      </section>
      <section class="levels" data-sec="levels" ${tabs ? 'hidden' : ''}>
        <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
        ${analyser ? `<div class="screen">
          <canvas></canvas>
          <div class="screen-scale">${SPECTRUM_MARKS.map(([f, t]) => `<span style="left:${bandPos(f) * 100}%">${t}</span>`).join('')}</div>
        </div>` : ''}
        <div class="knobs">
          <div class="knob" data-target="bg"></div>
          <div class="knob" data-target="jingles"></div>
          <div class="knob" data-target="pads"></div>
          ${master ? '<i class="knob-sep"></i><div class="knob" data-target="master"></div>' : ''}
        </div>
      </section>
      </div>
    </div>`;

  root.querySelectorAll('button[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'cmd', cmd: b.dataset.cmd, slot: b.dataset.slot })),
  );
  // Пэд в режиме «пока держишь»: звук от касания до отпускания
  root.querySelectorAll('[data-hold]').forEach((b) => {
    const slot = b.dataset.slot;
    let down = false;
    b.addEventListener('pointerdown', (e) => {
      down = true;
      b.setPointerCapture(e.pointerId);
      send({ type: 'cmd', cmd: 'padDown', slot });
    });
    const up = () => { if (down) send({ type: 'cmd', cmd: 'padUp', slot }); down = false; };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault()); // долгое касание на телефоне
  });
  root.querySelectorAll('[data-bank-btn]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'cmd', cmd: 'bank', bank: b.dataset.bankBtn })),
  );
  root.querySelectorAll('[data-jtag]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'cmd', cmd: 'jingleTag', tag: b.dataset.jtag })),
  );
  let njName = null, bgName = null; // треки, к которым ведут значки «перейти»
  root.querySelector('#nj-go')?.addEventListener('click', () => njName && openTrack('jingle', njName));
  root.querySelector('#bg-go')?.addEventListener('click', () => bgName && openTrack('bg', bgName));
  root.querySelectorAll('[data-bgsrc]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'cmd', cmd: 'bgSource', source: JSON.parse(b.dataset.bgsrc) })),
  );
  root.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      root.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('active', x === b));
      root.querySelectorAll('[data-sec]').forEach((s) => (s.hidden = s.dataset.sec !== b.dataset.tab));
    }),
  );
  const knobs = {};
  root.querySelectorAll('.knob').forEach((el) => {
    const target = el.dataset.target;
    const label = { master: 'Master', bg: 'Фон', jingles: 'Отбивки', pads: 'Пэды' }[target];
    knobs[target] = makeKnob(el, label, (value) =>
      send({ type: 'cmd', cmd: 'volume', target, value }),
    );
  });
  if (analyser) runSpectrum(root.querySelector('.screen canvas'), analyser);

  const $ = (sel) => root.querySelector(sel);
  let bgClock = null;
  let toastTimer;
  let stickyToast = false;
  let njText = null;

  return function showStatus(st) {
    root.classList.toggle('offline', !st || !!st.offline);
    if (!st || st.offline) return toast('Плеер на ноутбуке не в эфире', true);
    if (st.error) toast(st.error);
    else if (stickyToast) $('#toast').classList.remove('show');
    stickyToast = false;

    // Фон
    const playing = st.bg === 'playing';
    $('#vinyl').classList.toggle('spin', playing);
    $('#vinyl').classList.toggle('loaded', st.bg !== 'stopped');
    $('#bg-track').textContent = st.bgTrack ? trackTitle(st.bgTrack) : 'Фон остановлен';
    bgName = st.bgTrack;
    if ($('#bg-go')) $('#bg-go').hidden = !bgName;
    const src = st.bgSource || { type: 'all' };
    root.querySelectorAll('[data-bgsrc]').forEach((b) => {
      const s = JSON.parse(b.dataset.bgsrc);
      b.classList.toggle('active', s.type === src.type && (s.name || '') === (src.name || ''));
    });
    $('#bg-place').textContent = st.bgPlace ? `${bgSourceLabel(src)} · ${st.bgPlace.i} / ${st.bgPlace.n}`
      : src.type !== 'all' ? bgSourceLabel(src) : '';
    animateBar($('#bg-bar'), st.bgPos, st.bgDur, playing);
    clearInterval(bgClock);
    const t0 = performance.now();
    const tickTime = () => {
      const pos = Math.min(st.bgPos + (playing ? (performance.now() - t0) / 1000 : 0), st.bgDur || 0);
      $('#bg-pos').textContent = fmt(pos);
      $('#bg-left').textContent = '-' + fmt(Math.max((st.bgDur || 0) - pos, 0));
    };
    tickTime();
    if (playing) bgClock = setInterval(tickTime, 250);

    // Игра
    root.querySelectorAll('.on').forEach((b) => b.classList.remove('on'));
    root.querySelectorAll('.pad-cell .bar, .jingle-btn .bar').forEach((b) => animateBar(b, 0, 0, false));
    const fg = st.fg;
    const fgEl = fg && (fg.kind === 'jingle' ? $('.jingle-btn') : $(`.pad-cell[data-bank="${fg.bank}"][data-slot="${fg.slot}"]`));
    if (fgEl) {
      fgEl.classList.add('on');
      animateBar(fgEl.querySelector('.bar'), fg.elapsed, fg.dur, true);
    }
    // Банк: видна его сетка; точка на кнопке банка — там сейчас играет пэд
    root.querySelectorAll('[data-bank-grid]').forEach((g) => (g.hidden = Number(g.dataset.bankGrid) !== st.bank));
    root.querySelectorAll('[data-bank-btn]').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.bankBtn) === st.bank);
      b.classList.toggle('playing', !!fg && fg.kind === 'pad' && fg.bank === Number(b.dataset.bankBtn));
    });
    showNowJingle(fg && fg.kind === 'jingle' ? fg.name : null, st.lastJingle);
    const tag = st.jingleTag || '';
    root.querySelectorAll('[data-jtag]').forEach((b) => b.classList.toggle('active', b.dataset.jtag === tag));
    $('#jingle-mode').textContent = tag ? '#' + tag : 'случайная';
    if (playing) $('[data-cmd=bgPlay]').classList.add('on');
    if (st.bg === 'paused') $('[data-cmd=bgPause]').classList.add('on');
    $('#dot-game')?.classList.toggle('live', !!fg);
    $('#dot-bg')?.classList.toggle('live', playing);

    for (const k in knobs) knobs[k].set(st.volumes?.[k]);
  };

  // Над кнопкой «Отбивка»: что играет сейчас (бегущей строкой, если не влезает)
  // или, приглушённо, что играло последним — чтобы было что ответить «а что это было?»
  function showNowJingle(playingName, lastName) {
    const text = playingName ? trackTitle(playingName) : lastName ? 'Последняя: ' + trackTitle(lastName) : '';
    njName = playingName || lastName;
    if ($('#nj-go')) $('#nj-go').hidden = !njName;
    $('#nj').classList.toggle('live', !!playingName);
    if (text === njText) return; // не перезапускаем бегущую строку на каждом статусе
    njText = text;
    const span = $('#nj-text');
    span.textContent = text;
    span.classList.remove('run');
    const box = span.parentElement;
    if (box.clientWidth && span.scrollWidth > box.clientWidth) {
      const overflow = span.scrollWidth - box.clientWidth + 16; // +16 — чтобы конец вышел из-под затемнения края
      span.style.setProperty('--shift', -overflow + 'px');
      span.style.setProperty('--dur', Math.max(4, overflow / 25).toFixed(1) + 's');
      span.classList.add('run');
    }
  }

  function toast(text, sticky) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    stickyToast = !!sticky;
    if (!sticky) toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }
}

function padHtml(p) {
  const bg = p.image ? `style="--img:url('/media/images/${encodeURIComponent(p.image)}')"` : '';
  const mode = p.mode === 'hold' ? 'data-hold' : 'data-cmd="pad"';
  const badge = { loop: '⟳', hold: '✋' }[p.mode] || '';
  return `<button class="pad-cell h${p.slot} ${p.image ? 'has-img' : ''}" ${mode} data-bank="${p.bank}" data-slot="${p.slot}" ${bg}>
    <span class="hue"></span>${padName(p.name)}${badge ? `<i class="mode">${badge}</i>` : ''}<b class="bar"></b>
  </button>`;
}

// Название пэда крупно и капсом. Размер шрифта CSS считает от ширины пэда и ширины
// самого длинного слова (--w, в долях размера шрифта), чтобы слово целиком влезало в строку.
// Ширина букв в Unbounded разная: Ш и W почти в полтора раза шире A, поэтому считаем примерно по буквам.
const letterWidth = (ch) => (/[MWЖШЩЫЮФ]/i.test(ch) ? 1.35 : /[I1!.,':;|]/.test(ch) ? 0.5 : 0.95);
export function padName(name) {
  const words = String(name).split(/[\s-]+/);
  const w = Math.max(3.5, ...words.map((word) => [...word].reduce((sum, ch) => sum + letterWidth(ch), 0)));
  return `<span class="name" style="--w:${w.toFixed(2)}">${escapeHtml(name)}</span>`;
}

// Полоса прогресса двигается сама CSS-анимацией — без потока сообщений.
// Отрицательная задержка = «начать с середины»; работает и на скрытой вкладке.
// Имена кадров чередуем, чтобы браузер точно перезапустил анимацию.
function animateBar(bar, pos, dur, playing) {
  if (!bar) return;
  if (!dur) {
    bar.style.animation = 'none';
    return;
  }
  bar.dataset.k = bar.dataset.k === 'a' ? 'b' : 'a';
  bar.style.animation = `bar-${bar.dataset.k} ${dur}s linear -${Math.min(pos, dur)}s forwards`;
  bar.style.animationPlayState = playing ? 'running' : 'paused';
}

// Крутилка: тянуть вверх/вниз или колесо мыши
function makeKnob(el, label, onChange) {
  el.innerHTML = `<div class="dial"><svg viewBox="0 0 100 100">
      <circle class="track" cx="50" cy="50" r="40" pathLength="360"/>
      <circle class="fill" cx="50" cy="50" r="40" pathLength="360"/></svg>
      <div class="cap"><i></i></div><div class="val"></div></div><div class="klabel">${label}</div>`;
  const fill = el.querySelector('.fill');
  const cap = el.querySelector('.cap');
  const val = el.querySelector('.val');
  let value = 0;
  let dragging = false;
  let pending = null;

  const draw = () => {
    fill.style.strokeDasharray = `${value * 270} 360`;
    cap.style.transform = `rotate(${-135 + value * 270}deg)`;
    val.textContent = Math.round(value * 100);
  };
  // не чаще одного сообщения на кадр
  const change = (v) => {
    value = Math.min(1, Math.max(0, v));
    draw();
    if (pending === null) requestAnimationFrame(() => { onChange(pending); pending = null; });
    pending = value;
  };
  const dial = el.querySelector('.dial');
  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    let lastY = e.clientY;
    const move = (ev) => { change(value + (lastY - ev.clientY) / 200); lastY = ev.clientY; };
    const up = () => {
      dragging = false;
      dial.removeEventListener('pointermove', move);
      dial.removeEventListener('pointerup', up);
      dial.removeEventListener('pointercancel', up);
    };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
    dial.addEventListener('pointercancel', up);
  });
  dial.addEventListener('wheel', (e) => { e.preventDefault(); change(value - Math.sign(e.deltaY) * 0.05); }, { passive: false });
  draw();
  return { set: (v) => { if (!dragging && pending === null && typeof v === 'number') { value = v; draw(); } } };
}

// Экран спектра в «Уровнях»: полосы одним цветом, как на старых приборах с вакуумным дисплеем.
// Полосы — по октавам в логарифмической шкале, у каждой «светодиоды» и пиковая отметка.
const F_LO = 40, F_HI = 16000, BANDS = 30, SEGS = 16;
const bandPos = (f) => Math.log(f / F_LO) / Math.log(F_HI / F_LO);
const SPECTRUM_MARKS = [[60, '60'], [125, '125'], [250, '250'], [500, '500'], [1000, '1k'], [2000, '2k'], [4000, '4k'], [8000, '8k']];

function runSpectrum(canvas, getAnalyser) {
  const g = canvas.getContext('2d');
  const level = new Float32Array(BANDS), peak = new Float32Array(BANDS), peakAt = new Float64Array(BANDS);
  let data = null, last = performance.now();
  const frame = (now) => {
    if (!canvas.isConnected) return; // панель перерисовали — этот экран больше не нужен
    requestAnimationFrame(frame);
    if (!canvas.offsetParent) return; // открыта другая вкладка — не рисуем зря
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const an = getAnalyser();
    if (an && (!data || data.length !== an.frequencyBinCount)) data = new Float32Array(an.frequencyBinCount);
    if (an) an.getFloatFrequencyData(data);
    const hz = an ? an.context.sampleRate / 2 / data.length : 1;
    for (let i = 0; i < BANDS; i++) {
      let v = 0;
      if (an) {
        // громче всего звучащий бин внутри полосы: −80…−10 дБ → 0…1
        const b0 = Math.floor(F_LO * (F_HI / F_LO) ** (i / BANDS) / hz);
        const b1 = Math.max(b0 + 1, Math.floor(F_LO * (F_HI / F_LO) ** ((i + 1) / BANDS) / hz));
        let db = -Infinity;
        for (let k = b0; k < b1; k++) db = Math.max(db, data[k]);
        v = Math.max(0, Math.min(1, (db + 80) / 70));
      }
      level[i] = Math.max(v, level[i] - dt * 1.6); // растёт сразу, опадает плавно
      if (level[i] >= peak[i]) { peak[i] = level[i]; peakAt[i] = now; }
      else if (now - peakAt[i] > 700) peak[i] = Math.max(level[i], peak[i] - dt * 0.7);
    }
    draw();
  };
  function draw() {
    const dpr = devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    g.clearRect(0, 0, W, H);
    const color = getComputedStyle(canvas).color;
    const gap = 2 * dpr;
    const bw = (W - gap * (BANDS - 1)) / BANDS;
    const sh = (H - gap * (SEGS - 1)) / SEGS;
    const seg = (i, s) => g.rect(i * (bw + gap), H - (s + 1) * (sh + gap) + gap, bw, sh);
    // погашенные сегменты чуть видны — как на настоящем дисплее
    g.fillStyle = color;
    g.globalAlpha = 0.07;
    g.beginPath();
    for (let i = 0; i < BANDS; i++) for (let s = 0; s < SEGS; s++) seg(i, s);
    g.fill();
    g.globalAlpha = 1;
    g.shadowColor = color;
    g.shadowBlur = 8 * dpr;
    g.beginPath();
    for (let i = 0; i < BANDS; i++) {
      const n = Math.round(level[i] * SEGS);
      for (let s = 0; s < n; s++) seg(i, s);
      const p = Math.round(peak[i] * SEGS) - 1;
      if (p >= n) seg(i, p);
    }
    g.fill();
    g.shadowBlur = 0;
  }
  requestAnimationFrame(frame);
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const trackTitle = (f) => f.replace(/\.[^.]+$/, '').replace(/_/g, ' ');

// Что из настроек видно на пульте: при изменении пульт перерисовывается
export const padKey = (s) => JSON.stringify([s.banks, s.jingleTags, s.showJingleTags,
  s.bgLibrary?.tags, s.bgLibrary?.playlists.map((p) => p.name), !!s.bgLibrary?.bookmarks.length]);

// Текстуры оформления из public/textures (если их туда положили): aluminum.jpg -> класс tex-aluminum на body
export async function applyTextures() {
  try {
    const files = await (await fetch('/api/textures')).json();
    for (const f of files) document.body.classList.add('tex-' + f.replace(/\.[^.]+$/, '').toLowerCase());
  } catch {}
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Постоянный id браузера: все вкладки одного телефона считаются одним устройством.
// crypto.randomUUID недоступен на http по локальной сети, поэтому Math.random.
function deviceId() {
  const fresh = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    let id = localStorage.getItem('emp-device');
    if (!id) localStorage.setItem('emp-device', (id = fresh()));
    return id;
  } catch {
    return fresh();
  }
}

// WebSocket с автопереподключением (телефон может терять сеть)
export function connect(role, onMessage) {
  let ws;
  let retry = 1500;
  let dead = false; // вкладку вытеснили — больше не переподключаемся
  let takeover = true; // только первое подключение после «Начать эфир» забирает эфир
  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role, takeover, deviceId: deviceId() }));
      takeover = false;
      onMessage({ type: 'connected' });
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      retry = msg.type === 'rejected' ? 4000 : 1500; // заблокированный пульт стучится реже
      if (msg.type === 'replaced') dead = true;
      onMessage(msg);
    };
    ws.onclose = () => {
      if (dead) return;
      onMessage({ type: 'disconnected' });
      setTimeout(open, retry);
    };
  };
  open();
  return (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
}
