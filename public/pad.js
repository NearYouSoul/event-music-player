// Панель эфира: раздел «Игра» (отбивка + пэды) и раздел «Фон».
// Одна и та же на ноутбуке (колонками) и на телефоне (вкладками).
// send(msg) — что делать при нажатии; возвращает функцию для показа статуса.
export function renderPad(root, settings, send, { tabs = false, master = false } = {}) {
  const pads = settings.pads.map((p, i) => ({ ...p, slot: i })).filter((p) => p.file);
  // Пэды идут по 2 в ряд; нечётный хвост добиваем пустой ячейкой
  const cells = pads.map(padHtml).join('') + (pads.length % 2 ? '<div class="pad-cell empty"></div>' : '');
  // Переключатель разделов отбивок (включается в «Разметке отбивок»)
  const jtags = settings.showJingleTags && settings.jingleTags.length
    ? `<div class="jtags">${['', ...settings.jingleTags].map((t) =>
        `<button class="jtag" data-jtag="${escapeHtml(t)}">#${t ? escapeHtml(t) : 'случайные'}</button>`).join('')}</div>`
    : '';

  root.innerHTML = `
    ${tabs ? `<div class="seg">
      <button data-tab="game" class="active">Игра<i class="dot" id="dot-game"></i></button>
      <button data-tab="bg">Фон<i class="dot" id="dot-bg"></i></button>
    </div>` : ''}
    <div class="toast" id="toast"></div>
    <div class="deck-grid ${tabs ? 'tabs' : ''}">
      <section class="deck game" data-sec="game">
        <h3>Игра</h3>
        <div class="now-jingle" id="nj"><div class="nj-track"><span id="nj-text"></span></div></div>
        <div class="jingle-row">
          <button class="jingle-btn" data-cmd="jingle"><span>Отбивка</span><small id="jingle-mode">случайная</small><b class="bar"></b></button>
          <button class="btn stop" data-cmd="jingleStop">Стоп</button>
        </div>
        ${jtags}
        <div class="pads-scroll"><div class="pads">${cells || '<p class="muted">Пэды не настроены. Назначь звуки на ноутбуке во вкладке «Пэды».</p>'}</div></div>
      </section>
      <section class="deck bg" data-sec="bg" ${tabs ? 'hidden' : ''}>
        <h3>Фон</h3>
        <div class="vinyl-wrap">
          <div class="vinyl" id="vinyl">
            <div class="record"><div class="grooves"></div><div class="label"><div class="hole"></div></div></div>
            <div class="arm"><div class="arm-rod"></div><div class="arm-head"></div></div>
          </div>
          <div class="now">
            <div class="track" id="bg-track">—</div>
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
        <div class="knobs">
          <div class="knob" data-target="bg"></div>
          ${master ? '<div class="knob master" data-target="master"></div>' : ''}
        </div>
      </section>
    </div>`;

  root.querySelectorAll('button[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'cmd', cmd: b.dataset.cmd, slot: b.dataset.slot })),
  );
  root.querySelectorAll('[data-jtag]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'cmd', cmd: 'jingleTag', tag: b.dataset.jtag })),
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
    knobs[target] = makeKnob(el, target === 'master' ? 'Master' : 'Громкость фона', (value) =>
      send({ type: 'cmd', cmd: 'volume', target, value }),
    );
  });

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
    const fgEl = fg && (fg.kind === 'jingle' ? $('.jingle-btn') : $(`[data-slot="${fg.slot}"]`));
    if (fgEl) {
      fgEl.classList.add('on');
      animateBar(fgEl.querySelector('.bar'), fg.elapsed, fg.dur, true);
    }
    showNowJingle(fg && fg.kind === 'jingle' ? fg.name : null, st.lastJingle);
    const tag = st.jingleTag || '';
    root.querySelectorAll('[data-jtag]').forEach((b) => b.classList.toggle('active', b.dataset.jtag === tag));
    $('#jingle-mode').textContent = tag ? '#' + tag : 'случайная';
    if (playing) $('[data-cmd=bgPlay]').classList.add('on');
    if (st.bg === 'paused') $('[data-cmd=bgPause]').classList.add('on');
    $('#dot-game')?.classList.toggle('live', !!fg);
    $('#dot-bg')?.classList.toggle('live', playing);

    if (knobs.bg) knobs.bg.set(st.bgVolume);
    if (knobs.master) knobs.master.set(st.masterVolume);
  };

  // Над кнопкой «Отбивка»: что играет сейчас (бегущей строкой, если не влезает)
  // или, приглушённо, что играло последним — чтобы было что ответить «а что это было?»
  function showNowJingle(playingName, lastName) {
    const text = playingName ? trackTitle(playingName) : lastName ? 'Последняя: ' + trackTitle(lastName) : '';
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
  return `<button class="pad-cell h${p.slot} ${p.image ? 'has-img' : ''}" data-cmd="pad" data-slot="${p.slot}" ${bg}>
    <span class="hue"></span><span class="name">${escapeHtml(p.name)}</span><b class="bar"></b>
  </button>`;
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

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const trackTitle = (f) => f.replace(/\.[^.]+$/, '').replace(/_/g, ' ');

// Что из настроек видно на пульте: при изменении пульт перерисовывается
export const padKey = (s) => JSON.stringify([s.pads, s.jingleTags, s.showJingleTags]);

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
