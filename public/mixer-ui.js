// Вкладка «Микшер»: линейки каналов как в DAW и окна плагинов (эквалайзер, компрессор, лимитер).
// Плагины открываются всплывающим окном поверх страницы. Звук меняется сразу, если эфир идёт;
// без эфира настройки просто сохраняются и включатся при старте.
import { CHANNELS, BAND_TYPES, hasGain } from '/mixer.js';

const F_MIN = 20, F_MAX = 20000, DB = 18; // сетка эквалайзера: 20 Гц…20 кГц, ±18 дБ
const BAND_COLORS = ['#8b94a1', '#ff5a4e', '#ffb020', '#36e07a', '#4da8ff', '#9b7bff', '#ff6fb5'];

const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f)) + '';
const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1);

// ctx: { settings(), engine(), save(patch) }
export function mountMixer(root, ctx) {
  // Своя «немая» копия фильтров — чтобы рисовать АЧХ даже без эфира
  const offline = new OfflineAudioContext(1, 128, 48000);
  const probe = Array.from({ length: 7 }, () => offline.createBiquadFilter());
  let raf = null;
  let openWin = null; // { id, kind, draw() }

  const mix = () => ctx.settings().mixer;
  const changed = () => {
    ctx.engine()?.applyMixer();
    ctx.save({ mixer: mix() });
    render.status();
  };

  // АЧХ эквалайзера на частотах freqs, дБ — по «немым» копиям фильтров (работает и без эфира)
  function eqResponse(eq, freqs) {
    const total = new Float32Array(freqs.length);
    if (!eq.on) return total;
    const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    eq.bands.forEach((b, i) => {
      if (!b.on) return;
      const f = probe[i];
      f.type = b.type;
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = hasGain(b.type) ? b.gain : 0;
      f.getFrequencyResponse(freqs, mag, ph);
      for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(mag[k] || 1e-9);
    });
    return total;
  }

  // Отметки на шкале фейдера: фейдер линейный (как крутилки на пульте), поэтому децибелы стоят неравномерно
  const FADER_MARKS = [0, -3, -6, -10, -20];
  // Шкала индикатора: −60…0 дБ
  const METER_MARKS = [0, -6, -12, -24, -40, -60];
  const meterPos = (db) => Math.max(0, Math.min(1, (db + 60) / 60));

  function render() {
    const s = ctx.settings();
    root.innerHTML = `
      <div class="console">
        <div class="console-plate">
          <span class="screw"></span><b>Микшер эфира</b>
          <span class="plate-note">Цепочка канала: эквалайзер → компрессор → фейдер. На Master в конце лимитер.</span>
          <span class="screw"></span>
        </div>
        <div class="strips">
          ${CHANNELS.map((c) => `
            <div class="strip ch-${c.id}" data-strip="${c.id}">
              <div class="scribble"><b>${c.name}</b><span class="scribble-db"></span></div>
              <button class="eq-thumb" data-open="eq" title="Открыть эквалайзер"><canvas width="240" height="88"></canvas></button>
              <div class="inserts">
                <button class="key" data-open="eq"><i class="led"></i>EQ</button>
                <button class="key" data-open="comp"><i class="led"></i>Comp</button>
                ${c.id === 'master' ? '<button class="key" data-open="limiter"><i class="led"></i>Limit</button>' : ''}
              </div>
              <div class="bay">
                <div class="fader-scale">${FADER_MARKS.map((d) => `<span style="bottom:${10 ** (d / 20) * 100}%">${d}</span>`).join('')}<span style="bottom:0">−∞</span></div>
                <div class="fader-slot"><input type="range" class="fader" min="0" max="1" step="0.005" value="${s[c.volume]}" aria-label="Громкость: ${c.name}"></div>
                <div class="meter">
                  <div class="meter-bar"><b></b><i class="hold"></i></div>
                  <div class="meter-bar"><b></b><i class="hold"></i></div>
                  <div class="meter-gr" title="Подавление компрессора и лимитера"><b></b></div>
                </div>
                <div class="meter-scale">${METER_MARKS.map((d) => `<span style="bottom:${meterPos(d) * 100}%">${d}</span>`).join('')}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
      <p class="muted small mixer-hint">Фейдеры — те же крутилки, что на пульте. Индикаторы и спектр оживают, когда идёт эфир.
        Плагин открывается кнопкой на канале или кликом по маленькому графику эквалайзера.</p>`;
    for (const c of CHANNELS) {
      const el = root.querySelector(`[data-strip="${c.id}"]`);
      const fader = el.querySelector('.fader');
      fader.oninput = () => {
        const v = Number(fader.value);
        const engine = ctx.engine();
        if (engine) engine.setVolume(c.id, v);
        else ctx.save({ [c.volume]: v });
        render.status();
      };
      // двойной клик по фейдеру — вернуть 0 дБ
      fader.ondblclick = () => { fader.value = 1; fader.oninput(); };
      el.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openPlugin(c.id, b.dataset.open)));
    }
    render.status();
  }

  // Мини-график эквалайзера на канале
  const thumbFreqs = new Float32Array(240).map((_, i) => F_MIN * (F_MAX / F_MIN) ** (i / 240));
  function drawThumb(cv, eq) {
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(160, 180, 200, .25)';
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    const total = eqResponse(eq, thumbFreqs);
    g.beginPath();
    for (let x = 0; x < W; x++) g.lineTo(x, H / 2 - (Math.max(-DB, Math.min(DB, total[x])) / DB) * (H / 2 - 6));
    g.strokeStyle = eq.on ? getComputedStyle(cv).color : 'rgba(170, 185, 200, .75)';
    g.lineWidth = 3;
    g.stroke();
  }

  // Подсветка включённых плагинов, подписи фейдеров, мини-графики EQ
  render.status = () => {
    const s = ctx.settings();
    for (const c of CHANNELS) {
      const el = root.querySelector(`[data-strip="${c.id}"]`);
      if (!el) continue;
      const m = mix()[c.id];
      el.querySelector('.key[data-open=eq]').classList.toggle('on', m.eq.on);
      el.querySelector('.key[data-open=comp]').classList.toggle('on', m.comp.on);
      el.querySelector('.key[data-open=limiter]')?.classList.toggle('on', m.limiter.on);
      const v = s[c.volume];
      const fader = el.querySelector('.fader');
      if (document.activeElement !== fader) fader.value = v;
      el.querySelector('.scribble-db').textContent = v > 0.001 ? fmtDb(20 * Math.log10(v)) : '−∞';
      drawThumb(el.querySelector('.eq-thumb canvas'), m.eq);
    }
  };

  // ---------- Окна плагинов ----------
  const dlg = document.createElement('dialog');
  dlg.className = 'popup plugin';
  document.body.append(dlg);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // клик мимо окна
  dlg.addEventListener('close', () => { if (!dlg.open) openWin = null; }); // событие приходит с задержкой — окно могли уже открыть снова

  function openPlugin(id, kind) {
    const name = CHANNELS.find((c) => c.id === id).name;
    const title = { eq: 'Эквалайзер', comp: 'Компрессор', limiter: 'Лимитер' }[kind];
    // настройки берём заново при каждом действии: после сохранения объект settings заменяется свежим
    const conf = () => mix()[id][kind];
    dlg.innerHTML = `
      <div class="popup-head">
        <label class="power"><input type="checkbox" id="pl-on" ${conf().on ? 'checked' : ''}><span></span></label>
        <h3>${title} · ${name}</h3><span class="grow"></span>
        ${kind === 'eq' ? '<button class="btn" id="pl-flat" title="Все усиления в 0">Сброс</button>' : ''}
        <button class="btn" data-close>✕</button>
      </div>
      <div id="pl-body"></div>`;
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.querySelector('#pl-on').onchange = (e) => { conf().on = e.target.checked; changed(); openWin?.draw(); };
    const body = dlg.querySelector('#pl-body');
    openWin = { id, kind, ...{ eq: eqWindow, comp: compWindow, limiter: limiterWindow }[kind](body, id, conf) };
    if (kind === 'eq') dlg.querySelector('#pl-flat').onclick = () => {
      conf().bands.forEach((b) => (b.gain = 0));
      changed();
      openWin.refresh();
    };
    dlg.showModal();
    loop();
  }

  // Эквалайзер: кривая АЧХ поверх спектра, точки полос тянутся мышкой
  function eqWindow(body, id, eq) {
    body.innerHTML = `
      <canvas class="eq-canvas" width="900" height="320"></canvas>
      <p class="hint">Тяни точку: влево-вправо — частота, вверх-вниз — усиление. Колесо мыши над точкой — ширина (Q).
        Двойной клик — включить/выключить полосу.</p>
      <div class="bands"></div>`;
    const cv = body.querySelector('canvas');
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const xOf = (f) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
    const fOf = (x) => F_MIN * (F_MAX / F_MIN) ** (x / W);
    const yOf = (db) => H / 2 - (db / DB) * (H / 2 - 12);
    const dbOf = (y) => ((H / 2 - y) / (H / 2 - 12)) * DB;
    const freqs = new Float32Array(W).map((_, i) => fOf(i));
    const handleY = (b) => yOf(hasGain(b.type) ? b.gain : 0);

    const curve = () => eqResponse(eq(), freqs);

    let spectrum = null;
    function draw() {
      g.clearRect(0, 0, W, H);
      // сетка
      g.strokeStyle = '#232830';
      g.fillStyle = '#5d6672';
      g.font = '11px Consolas, monospace';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        g.beginPath(); g.moveTo(xOf(f), 0); g.lineTo(xOf(f), H); g.stroke();
        g.fillText(fmtHz(f), xOf(f) + 3, H - 4);
      }
      for (const d of [-12, -6, 0, 6, 12]) {
        g.strokeStyle = d ? '#232830' : '#2e343e';
        g.beginPath(); g.moveTo(0, yOf(d)); g.lineTo(W, yOf(d)); g.stroke();
        g.fillText(fmtDb(d), 4, yOf(d) - 3);
      }
      // спектр того, что сейчас звучит в канале (только в эфире)
      const strip = ctx.engine()?.strips[id];
      if (strip) {
        const a = strip.analyser;
        spectrum ||= new Float32Array(a.frequencyBinCount);
        a.getFloatFrequencyData(spectrum);
        const rate = a.context.sampleRate;
        g.beginPath();
        for (let x = 0; x < W; x++) {
          const bin = Math.min(spectrum.length - 1, Math.round((fOf(x) / (rate / 2)) * spectrum.length));
          const v = Math.max(0, (spectrum[bin] + 100) / 80); // −100…−20 дБ → 0…1
          g.lineTo(x, H - v * (H - 20));
        }
        g.lineTo(W, H); g.lineTo(0, H);
        g.fillStyle = 'rgba(77, 168, 255, .12)';
        g.fill();
      }
      // АЧХ
      const total = curve();
      g.beginPath();
      for (let x = 0; x < W; x++) g.lineTo(x, yOf(Math.max(-DB, Math.min(DB, total[x]))));
      g.strokeStyle = eq().on ? '#e9edf2' : '#5d6672';
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
      // точки полос
      eq().bands.forEach((b, i) => {
        g.beginPath();
        g.arc(xOf(b.freq), handleY(b), 8, 0, Math.PI * 2);
        g.fillStyle = b.on && eq().on ? BAND_COLORS[i] : '#2e343e';
        g.fill();
        g.fillStyle = '#14171b';
        g.font = 'bold 10px Segoe UI, sans-serif';
        g.fillText(i + 1, xOf(b.freq) - 3, handleY(b) + 4);
      });
    }

    // мышь: какая полоса под курсором
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    const hit = (e) => {
      const [x, y] = pos(e);
      return eq().bands.findIndex((b) => Math.hypot(xOf(b.freq) - x, handleY(b) - y) < 14);
    };
    cv.addEventListener('pointerdown', (e) => {
      const i = hit(e);
      if (i < 0) return;
      cv.setPointerCapture(e.pointerId);
      const b = eq().bands[i];
      const move = (ev) => {
        const [x, y] = pos(ev);
        b.freq = Math.round(Math.min(F_MAX, Math.max(F_MIN, fOf(x))));
        if (hasGain(b.type)) b.gain = Math.round(Math.min(DB, Math.max(-DB, dbOf(y))) * 10) / 10;
        changed();
        refresh();
      };
      const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
    });
    cv.addEventListener('dblclick', (e) => {
      const i = hit(e);
      if (i < 0) return;
      eq().bands[i].on = !eq().bands[i].on;
      changed();
      refresh();
    });
    cv.addEventListener('wheel', (e) => {
      const i = hit(e);
      if (i < 0) return;
      e.preventDefault();
      const b = eq().bands[i];
      b.q = Math.round(Math.min(18, Math.max(0.1, b.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) * 100) / 100;
      changed();
      refresh();
    }, { passive: false });

    // таблица полос — точные значения цифрами
    const table = body.querySelector('.bands');
    function refresh() {
      table.innerHTML = eq().bands.map((b, i) => `
        <div class="band" data-i="${i}">
          <label class="check"><input type="checkbox" data-k="on" ${b.on ? 'checked' : ''}><b style="color:${BAND_COLORS[i]}">${i + 1}</b></label>
          <select data-k="type">${Object.entries(BAND_TYPES).map(([t, n]) => `<option value="${t}" ${t === b.type ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <label>Гц <input type="number" data-k="freq" min="20" max="20000" step="1" value="${b.freq}"></label>
          <label>дБ <input type="number" data-k="gain" min="-18" max="18" step="0.5" value="${b.gain}" ${hasGain(b.type) ? '' : 'disabled'}></label>
          <label>Q <input type="number" data-k="q" min="0.1" max="18" step="0.1" value="${b.q}"></label>
        </div>`).join('');
      table.querySelectorAll('[data-k]').forEach((inp) => (inp.onchange = () => {
        const b = eq().bands[inp.closest('[data-i]').dataset.i];
        const k = inp.dataset.k;
        b[k] = k === 'on' ? inp.checked : k === 'type' ? inp.value : Number(inp.value);
        changed();
        refresh();
      }));
      draw();
    }
    refresh();
    return { draw, refresh };
  }

  // Компрессор: ручки + график «вход → выход» + индикатор подавления
  function compWindow(body, id, c) {
    const P = [
      ['threshold', 'Порог', -60, 0, 0.5, 'дБ'],
      ['ratio', 'Степень (ratio)', 1, 20, 0.1, ': 1'],
      ['knee', 'Колено (knee)', 0, 40, 0.5, 'дБ'],
      ['attack', 'Атака', 0, 0.2, 0.001, 'с'],
      ['release', 'Восстановление', 0.01, 1, 0.01, 'с'],
      ['makeup', 'Компенсация (make-up)', 0, 24, 0.5, 'дБ'],
    ];
    body.innerHTML = `
      <div class="comp">
        <canvas class="comp-canvas" width="260" height="260"></canvas>
        <div class="params">
          ${P.map(([k, n, min, max, step, u]) => `
            <label class="param"><span>${n}</span>
              <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${c()[k]}">
              <b class="mono" data-v="${k}"></b><small>${u}</small></label>`).join('')}
          <div class="gr-meter"><span>Подавление</span><div><b></b></div><b class="mono" id="gr-val"></b></div>
        </div>
      </div>
      <p class="hint">Компрессор выравнивает громкость: всё, что громче порога, прижимается в заданное число раз.
        Для эфира обычно хватает порога −18…−12 дБ и ratio 2–4. Компенсацию добавляй руками: сам компрессор громкость не поднимает.</p>`;
    const cv = body.querySelector('canvas');
    const g = cv.getContext('2d');
    const S = cv.width;
    const out = (x) => { // статическая кривая компрессора с мягким коленом, дБ
      const { threshold: T, ratio: R, knee: K } = c();
      if (2 * (x - T) < -K) return x;
      if (2 * Math.abs(x - T) <= K) return x + ((1 / R - 1) * (x - T + K / 2) ** 2) / (2 * K || 1);
      return T + (x - T) / R;
    };
    const showVals = () => P.forEach(([k]) => (body.querySelector(`[data-v="${k}"]`).textContent = k === 'attack' || k === 'release' ? c()[k].toFixed(3) : c()[k]));
    function draw() {
      g.clearRect(0, 0, S, S);
      const p = (db) => S - ((db + 60) / 60) * S;
      g.strokeStyle = '#232830';
      for (let d = -60; d <= 0; d += 12) {
        g.beginPath(); g.moveTo(S - p(d), 0); g.lineTo(S - p(d), S); g.stroke();
        g.beginPath(); g.moveTo(0, p(d)); g.lineTo(S, p(d)); g.stroke();
      }
      g.strokeStyle = '#2e343e';
      g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.stroke();
      g.beginPath();
      for (let x = 0; x <= S; x++) g.lineTo(x, p(out((x / S) * 60 - 60) + (c().on ? c().makeup : 0)));
      g.strokeStyle = c().on ? '#ffb020' : '#5d6672';
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
      const gr = ctx.engine()?.strips[id].reduction().comp || 0;
      body.querySelector('.gr-meter div b').style.width = Math.min(100, (-gr / 20) * 100) + '%';
      body.querySelector('#gr-val').textContent = gr.toFixed(1);
    }
    body.querySelectorAll('[data-k]').forEach((inp) => (inp.oninput = () => {
      c()[inp.dataset.k] = Number(inp.value);
      showVals();
      changed();
      draw();
    }));
    showVals();
    draw();
    return { draw };
  }

  function limiterWindow(body, id, l) {
    body.innerHTML = `
      <label class="param"><span>Потолок</span>
        <input type="range" id="lim-ceil" min="-12" max="0" step="0.1" value="${l().ceiling}">
        <b class="mono" id="lim-val"></b><small>дБ</small></label>
      <div class="gr-meter"><span>Подавление</span><div><b></b></div><b class="mono" id="gr-val"></b></div>
      <p class="hint">Лимитер стоит последним на Master: всё, что выше потолка, он прижимает, поэтому колонки
        не хрипят даже при громких сэмплах. Он заглядывает на 5 мс вперёд, поэтому выше потолка не выходит ни один отсчёт.
        Держи включённым; −1 дБ — нормальный потолок.</p>`;
    const inp = body.querySelector('#lim-ceil');
    const show = () => (body.querySelector('#lim-val').textContent = l().ceiling.toFixed(1));
    inp.oninput = () => { l().ceiling = Number(inp.value); show(); changed(); };
    show();
    return {
      draw() {
        const gr = ctx.engine()?.strips[id].reduction().limiter || 0;
        body.querySelector('.gr-meter div b').style.width = Math.min(100, (-gr / 12) * 100) + '%';
        body.querySelector('#gr-val').textContent = gr.toFixed(1);
      },
    };
  }

  // ---------- Индикаторы ----------
  const holds = {}; // пиковые отметки: держатся 1.2 с, потом медленно опускаются
  function loop() {
    cancelAnimationFrame(raf);
    const engine = ctx.engine();
    if (engine && root.offsetParent) {
      const now = performance.now();
      for (const c of CHANNELS) {
        const el = root.querySelector(`[data-strip="${c.id}"]`);
        const strip = engine.strips[c.id];
        strip.peaks().forEach((db, ch) => {
          const bar = el.querySelectorAll('.meter-bar')[ch];
          const pos = meterPos(db);
          bar.querySelector('b').style.transform = `scaleY(${pos})`;
          const key = c.id + ch;
          const h = holds[key] || { pos: 0, at: 0 };
          if (pos >= h.pos) holds[key] = { pos, at: now };
          else if (now - h.at > 1200) holds[key] = { pos: Math.max(pos, h.pos - 0.01), at: h.at };
          bar.querySelector('.hold').style.bottom = holds[key].pos * 100 + '%';
          bar.classList.toggle('clip', db > -0.5);
        });
        const r = strip.reduction();
        el.querySelector('.meter-gr b').style.transform = `scaleY(${Math.min(1, -(r.comp + r.limiter) / 20)})`;
      }
    }
    if (openWin && engine) openWin.draw();
    if (root.offsetParent || openWin) raf = requestAnimationFrame(loop);
  }

  render();
  return { show: () => { render(); loop(); }, refresh: render.status };
}
