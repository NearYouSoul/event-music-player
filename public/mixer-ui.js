// Вкладка «Микшер»: линейки каналов как в DAW и окна плагинов (эквалайзер, компрессор, лимитер).
// Плагины открываются всплывающим окном поверх страницы. Звук меняется сразу, если эфир идёт;
// без эфира настройки просто сохраняются и включатся при старте.
import { CHANNELS, BAND_TYPES, hasGain, hasQ, isCut, SLOPES, STAGES, bandStages, setStage } from '/mixer.js';

const F_MIN = 20, F_MAX = 20000, DB = 18; // сетка эквалайзера: 20 Гц…20 кГц; мини-график на канале — ±18 дБ
const BAND_COLORS = ['#9aa4b2', '#ff5a4e', '#ffb020', '#36e07a', '#4da8ff', '#9b7bff', '#ff6fb5'];

const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f)) + '';
const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1);

// ctx: { settings(), engine(), save(patch) }
export function mountMixer(root, ctx) {
  // Своя «немая» копия фильтров — чтобы рисовать АЧХ даже без эфира
  const offline = new OfflineAudioContext(1, 128, 48000);
  const probe = Array.from({ length: 7 }, () => Array.from({ length: STAGES }, () => offline.createBiquadFilter()));
  const setNow = (p, v) => (p.value = v);
  let raf = null;
  let openWin = null; // { id, kind, draw() }

  const mix = () => ctx.settings().mixer;
  const changed = () => {
    ctx.engine()?.applyMixer();
    ctx.save({ mixer: mix() });
    render.status();
  };

  // АЧХ одной полосы на частотах freqs, дБ — по «немым» копиям её ступеней
  function bandResponse(i, b, freqs, out) {
    out.fill(0);
    const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    bandStages(b, 24000).forEach((st, k) => {
      if (st.type === 'peaking' && !st.gain) return; // пустая ступень ничего не меняет
      setStage(probe[i][k], st, setNow);
      probe[i][k].getFrequencyResponse(freqs, mag, ph);
      for (let j = 0; j < freqs.length; j++) out[j] += 20 * Math.log10(mag[j] || 1e-9);
    });
    return out;
  }

  // АЧХ всего эквалайзера (с «Выходом»), дБ
  function eqResponse(eq, freqs) {
    const total = new Float32Array(freqs.length);
    if (!eq.on) return total;
    const tmp = new Float32Array(freqs.length);
    eq.bands.forEach((b, i) => {
      if (!b.on) return;
      bandResponse(i, b, freqs, tmp);
      for (let k = 0; k < freqs.length; k++) total[k] += tmp[k];
    });
    if (eq.output) for (let k = 0; k < total.length; k++) total[k] += eq.output;
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
  // Каждый плагин нарисован как прибор: эквалайзер — современный экран с анализатором спектра,
  // компрессор и лимитер — «железо» с крутилками, стрелочным и сегментными индикаторами.
  const dlg = document.createElement('dialog');
  dlg.className = 'plugin';
  document.body.append(dlg);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // клик мимо окна
  dlg.addEventListener('close', () => { if (!dlg.open) openWin = null; }); // событие приходит с задержкой — окно могли уже открыть снова

  function openPlugin(id, kind) {
    const name = CHANNELS.find((c) => c.id === id).name;
    // настройки берём заново при каждом действии: после сохранения объект settings заменяется свежим
    const conf = () => mix()[id][kind];
    dlg.className = 'plugin pl-' + kind;
    openWin = { id, kind, ...{ eq: eqWindow, comp: compWindow, limiter: limiterWindow }[kind](dlg, id, conf, name) };
    dlg.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => dlg.close()));
    // кнопка включения прибора — одна и та же для всех трёх
    const power = dlg.querySelector('#pl-on');
    const showPower = () => {
      power.classList.toggle('on', conf().on);
      if (power.type === 'checkbox') power.checked = conf().on;
    };
    power.onclick = () => { conf().on = !conf().on; changed(); showPower(); openWin.refresh?.(); };
    showPower();
    dlg.showModal();
    loop();
  }

  // ===== Эквалайзер: экран в духе современных плагинов =====
  // Под кривой — спектр до и после эквалайзера, у каждой полосы своя цветная «форма»,
  // выбранная полоса открывает панель с крутилками частоты, усиления и ширины (Q).
  const EQ_RANGES = [6, 12, 24]; // масштаб шкалы усиления, ±дБ
  const GAIN_MAX = 24;
  const AN_DB = [-90, -6];       // шкала анализатора спектра, dBFS
  let eqRange = 12;
  let eqAnalyzer = 'both';       // both — до и после, post — только после, off — без спектра

  function eqWindow(root, id, eq, name) {
    root.innerHTML = `
      <div class="dev eqdev">
        <div class="dev-bar">
          <label class="power" title="Включить / выключить эквалайзер"><input type="checkbox" id="pl-on"><span></span></label>
          <b class="dev-title">Эквалайзер</b><span class="dev-ch">${name}</span>
          <span class="grow"></span>
          <span class="muted small">Анализатор</span>
          <div class="seg-mini" id="eq-an">${[['both', 'До и после'], ['post', 'После'], ['off', 'Выкл']]
            .map(([k, n]) => `<button data-an="${k}">${n}</button>`).join('')}</div>
          <button class="btn mini" id="eq-range" title="Масштаб шкалы усиления"></button>
          <button class="btn mini" id="eq-flat" title="Все усиления в 0">Сброс</button>
          <button class="btn mini" data-close title="Закрыть">✕</button>
        </div>
        <div class="eq-stage">
          <canvas class="eq-cv"></canvas>
          <div class="eq-tip" hidden></div>
          <div class="eq-panel" hidden></div>
        </div>
        <div class="dev-foot">
          <span class="small muted">Тяни точку — частота и усиление. Колесо мыши или Alt+тянуть — ширина (Q). Shift — точнее.
            Двойной клик по точке — выключить полосу, по пустому месту — включить свободную полосу там.</span>
          <div class="pk-slot" id="eq-out"></div>
        </div>
      </div>`;
    const stage = root.querySelector('.eq-stage');
    const cv = root.querySelector('.eq-cv');
    const g = cv.getContext('2d');
    const tip = root.querySelector('.eq-tip');
    const panel = root.querySelector('.eq-panel');
    let sel = -1, hover = -1, drag = null;
    let W = 0, H = 0, PW = 0, PH = 0, freqs = null, bins = null;
    const shapes = new Map(); // кэш АЧХ полос: ключ — параметры полосы
    let pre = null, post = null; // сглаженный спектр по пикселям, дБ

    const xOf = (f) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * PW;
    const fOf = (x) => F_MIN * (F_MAX / F_MIN) ** (x / PW);
    const yOf = (db) => PH / 2 - (db / eqRange) * (PH / 2 - 16);
    const dbOf = (y) => ((PH / 2 - y) / (PH / 2 - 16)) * eqRange;
    const anY = (db) => PH - ((db - AN_DB[0]) / (AN_DB[1] - AN_DB[0])) * PH;
    const handle = (b) => [xOf(b.freq), hasGain(b.type) ? yOf(Math.max(-eqRange, Math.min(eqRange, b.gain))) : yOf(0)];

    // Размер холста — по размеру на экране (чётко и на экранах с масштабом)
    function resize() {
      const dpr = devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (w === W && h === H) return;
      W = w; H = h;
      cv.width = w * dpr; cv.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      PW = W - 58; PH = H - 22; // справа — шкала и индикатор, снизу — частоты
      freqs = new Float32Array(Math.ceil(PW)).map((_, x) => fOf(x));
      bins = null;
      pre = post = null;
      shapes.clear();
    }

    function bandShape(i, b) {
      const key = [b.type, b.freq, b.q, b.gain, b.slope, b.on, PW].join();
      if (!shapes.has(i) || shapes.get(i).key !== key) shapes.set(i, { key, db: bandResponse(i, b, freqs, new Float32Array(freqs.length)) });
      return shapes.get(i).db;
    }

    // Спектр из анализатора в пиксели: на низах интерполяция между бинами, на верхах — максимум по бинам пикселя
    function readSpectrum(an, buf, prev) {
      if (!an) return null;
      const data = (an.__data ||= new Float32Array(an.frequencyBinCount));
      an.getFloatFrequencyData(data);
      const hz = an.context.sampleRate / an.fftSize;
      if (!bins) bins = Array.from({ length: freqs.length }, (_, x) => [fOf(x - 0.5) / hz, fOf(x + 0.5) / hz]);
      const out = prev || new Float32Array(freqs.length).fill(AN_DB[0]);
      for (let x = 0; x < freqs.length; x++) {
        const [b0, b1] = bins[x];
        let db;
        if (b1 - b0 < 1) {
          const c = (b0 + b1) / 2, k = Math.floor(c), fr = c - k;
          db = data[k] * (1 - fr) + data[Math.min(k + 1, data.length - 1)] * fr;
        } else {
          db = -Infinity;
          for (let k = Math.floor(b0); k <= Math.min(Math.ceil(b1), data.length - 1); k++) db = Math.max(db, data[k]);
        }
        // наклон +4.5 дБ/окт: музыка на экране выглядит «ровной», как в студийных анализаторах
        db += 4.5 * Math.log2(freqs[x] / 1000);
        out[x] = db > out[x] ? db : Math.max(db, out[x] - 1.2); // быстро растёт, плавно опадает
      }
      return out;
    }

    const spectrumPath = (s) => {
      g.beginPath();
      g.moveTo(0, PH);
      for (let x = 0; x < s.length; x++) g.lineTo(x, Math.max(0, Math.min(PH, anY(s[x]))));
      g.lineTo(s.length, PH);
      g.closePath();
    };

    function draw() {
      resize();
      if (!PW) return;
      const conf = eq();
      const strip = ctx.engine()?.strips[id];
      g.clearRect(0, 0, W, H);
      // сетка: октавы и шаги шкалы усиления
      g.lineWidth = 1;
      g.font = '11px Bahnschrift, sans-serif';
      for (const f of [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000]) {
        const x = Math.round(xOf(f)) + 0.5;
        g.strokeStyle = [100, 1000, 10000].includes(f) ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.04)';
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PH); g.stroke();
        g.fillStyle = '#6f7883';
        if (f < 20000) g.fillText(fmtHz(f), x + 3, H - 7);
      }
      const step = eqRange / 4;
      for (let d = -eqRange; d <= eqRange + 0.01; d += step) {
        const y = Math.round(yOf(d)) + 0.5;
        g.strokeStyle = d === 0 ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.04)';
        g.beginPath(); g.moveTo(0, y); g.lineTo(PW, y); g.stroke();
        g.fillStyle = d === 0 ? '#e9edf2' : '#ffcf4a';
        g.fillText((d > 0 ? '+' : '') + d, PW + 6, y + 4);
      }
      // спектр: «до» — тёмной заливкой, «после» — светлой с контуром
      if (strip && eqAnalyzer !== 'off') {
        if (eqAnalyzer === 'both') {
          pre = readSpectrum(strip.preAnalyser, null, pre);
          spectrumPath(pre);
          g.fillStyle = 'rgba(77, 168, 255, .10)';
          g.fill();
        }
        post = readSpectrum(strip.eqAnalyser, null, post);
        spectrumPath(post);
        g.fillStyle = 'rgba(205, 214, 226, .16)';
        g.fill();
        g.strokeStyle = 'rgba(205, 214, 226, .35)';
        g.stroke();
      }
      // формы полос и общая кривая
      const total = new Float32Array(freqs.length).fill(conf.on ? conf.output || 0 : 0);
      conf.bands.forEach((b, i) => {
        if (!b.on) return;
        const db = bandShape(i, b);
        if (conf.on) for (let x = 0; x < db.length; x++) total[x] += db[x];
        g.beginPath();
        g.moveTo(0, yOf(0));
        for (let x = 0; x < db.length; x++) g.lineTo(x, yOf(Math.max(-eqRange * 1.5, Math.min(eqRange * 1.5, db[x]))));
        g.lineTo(db.length, yOf(0));
        g.closePath();
        const on = i === sel || i === hover;
        g.fillStyle = BAND_COLORS[i] + (on ? '55' : conf.on ? '26' : '12');
        g.fill();
        if (on) { g.strokeStyle = BAND_COLORS[i]; g.lineWidth = 1.5; g.stroke(); }
      });
      g.beginPath();
      for (let x = 0; x < total.length; x++) g.lineTo(x, yOf(Math.max(-eqRange * 1.5, Math.min(eqRange * 1.5, total[x]))));
      g.strokeStyle = conf.on ? '#ffd24a' : '#5d6672';
      g.lineWidth = 2.5;
      g.shadowColor = conf.on ? 'rgba(255, 210, 74, .5)' : 'transparent';
      g.shadowBlur = 8;
      g.stroke();
      g.shadowBlur = 0;
      // точки полос
      conf.bands.forEach((b, i) => {
        const [x, y] = handle(b);
        const r = i === sel ? 9 : 7;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fillStyle = b.on ? BAND_COLORS[i] : '#1b1f25';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = i === sel ? '#fff' : b.on ? 'rgba(0,0,0,.6)' : '#5d6672';
        g.stroke();
        g.fillStyle = b.on ? '#0b0d10' : '#8b94a1';
        g.font = 'bold 10px Bahnschrift, sans-serif';
        g.fillText(i + 1, x - 3, y + 3.5);
      });
      // индикатор выхода канала справа
      if (strip) {
        const [l, r] = strip.peaks();
        const mx = W - 14;
        [l, r].forEach((db, ch) => {
          const v = Math.max(0, Math.min(1, (db + 60) / 60));
          g.fillStyle = '#0b0d10';
          g.fillRect(mx + ch * 6, 0, 5, PH);
          const grad = g.createLinearGradient(0, PH, 0, 0);
          grad.addColorStop(0, '#2bbf6a'); grad.addColorStop(0.75, '#c8e04a'); grad.addColorStop(0.95, '#ff3b30');
          g.fillStyle = grad;
          g.fillRect(mx + ch * 6, PH - v * PH, 5, v * PH);
        });
      }
      if (!conf.on) {
        g.fillStyle = '#8b94a1';
        g.font = '600 13px Bahnschrift, sans-serif';
        g.fillText('Эквалайзер выключен — звук проходит как есть', 14, 22);
      }
    }

    // ----- мышь -----
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const hit = (x, y) => {
      let best = -1, bd = 14;
      eq().bands.forEach((b, i) => {
        const [hx, hy] = handle(b);
        const d = Math.hypot(hx - x, hy - y);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    };
    const showTip = (i) => {
      if (i < 0) return (tip.hidden = true);
      const b = eq().bands[i];
      const [x, y] = handle(b);
      tip.hidden = false;
      tip.style.left = Math.min(PW - 140, x + 14) + 'px';
      tip.style.top = Math.max(4, y - 34) + 'px';
      tip.innerHTML = `<b style="color:${BAND_COLORS[i]}">${i + 1}</b> ${fmtHz(b.freq)} Гц` +
        (hasGain(b.type) ? ` · ${fmtDb(b.gain)} дБ` : '') + (hasQ(b.type) ? ` · Q ${b.q.toFixed(2)}` : '') +
        (isCut(b.type) ? ` · ${b.slope || 12} дБ/окт` : '');
    };
    const setQ = (b, q) => (b.q = Math.round(Math.min(18, Math.max(0.1, q)) * 100) / 100);

    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      const i = hit(x, y);
      if (i < 0) { select(-1); return; }
      select(i);
      cv.setPointerCapture(e.pointerId);
      const b = eq().bands[i];
      drag = { i, x, y, freq: b.freq, gain: b.gain, q: b.q };
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (!drag) {
        hover = hit(x, y);
        cv.style.cursor = hover >= 0 ? 'grab' : 'crosshair';
        return showTip(hover);
      }
      const b = eq().bands[drag.i];
      const k = e.shiftKey ? 0.2 : 1; // Shift — точная подстройка
      if (e.altKey) {
        // Alt + вверх-вниз — ширина полосы
        if (hasQ(b.type)) setQ(b, drag.q * 2 ** ((drag.y - y) / 60 * k));
      } else {
        b.freq = Math.round(Math.min(F_MAX, Math.max(F_MIN, fOf(xOf(drag.freq) + (x - drag.x) * k))));
        if (hasGain(b.type)) {
          const gy = yOf(drag.gain) + (y - drag.y) * k;
          b.gain = Math.round(Math.min(eqRange, Math.max(-eqRange, dbOf(gy))) * 10) / 10;
        }
      }
      changed();
      syncPanel();
      showTip(drag.i);
    });
    cv.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
    });
    cv.addEventListener('pointerleave', () => { if (!drag) { hover = -1; tip.hidden = true; } });
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e);
      const i = hit(x, y);
      const bands = eq().bands;
      if (i >= 0) {
        bands[i].on = !bands[i].on;
      } else {
        // по пустому месту — включаем первую свободную полосу колоколом в этой точке
        const free = bands.findIndex((b) => !b.on);
        if (free < 0) return;
        Object.assign(bands[free], {
          on: true, type: 'peaking', q: 1,
          freq: Math.round(fOf(x)), gain: Math.round(Math.min(eqRange, Math.max(-eqRange, dbOf(y))) * 10) / 10,
        });
        select(free);
      }
      changed();
      renderPanel();
    });
    cv.addEventListener('wheel', (e) => {
      const [x, y] = pos(e);
      const i = hit(x, y) >= 0 ? hit(x, y) : sel;
      if (i < 0) return;
      e.preventDefault();
      const b = eq().bands[i];
      if (!hasQ(b.type)) return;
      const f = e.shiftKey ? 1.03 : 1.15; // Shift — точнее
      setQ(b, e.deltaY < 0 ? b.q * f : b.q / f);
      changed();
      syncPanel();
      showTip(i);
    }, { passive: false });

    // ----- панель выбранной полосы -----
    let pk = {};
    function select(i) {
      sel = i;
      renderPanel();
    }
    function renderPanel() {
      if (sel < 0) { panel.hidden = true; return; }
      const b = eq().bands[sel];
      panel.hidden = false;
      panel.style.setProperty('--band', BAND_COLORS[sel]);
      panel.innerHTML = `
        <button class="eqp-power ${b.on ? 'on' : ''}" title="Включить / выключить полосу">${sel + 1}</button>
        <div class="eqp-sel">
          <select class="eqp-type" title="Тип полосы">${Object.entries(BAND_TYPES).map(([t, n]) => `<option value="${t}" ${t === b.type ? 'selected' : ''}>${n}</option>`).join('')}</select>
          ${isCut(b.type) ? `<select class="eqp-slope" title="Крутизна среза">${SLOPES.map((s) => `<option value="${s}" ${s === (b.slope || 12) ? 'selected' : ''}>${s} дБ/окт</option>`).join('')}</select>` : ''}
        </div>
        <div class="pk-slot" data-k="freq"></div>
        <div class="pk-slot" data-k="gain"></div>
        <div class="pk-slot" data-k="q"></div>
        <button class="eqp-close" title="Закрыть панель">✕</button>`;
      const band = () => eq().bands[sel];
      pk = {
        freq: knob(panel.querySelector('[data-k=freq]'), { name: 'Частота', min: F_MIN, max: F_MAX, log: true, value: b.freq, def: b.freq,
          fmt: (v) => fmtHz(v) + ' Гц', onChange: (v) => { band().freq = Math.round(v); changed(); } }),
        gain: knob(panel.querySelector('[data-k=gain]'), { name: 'Усиление', min: -GAIN_MAX, max: GAIN_MAX, step: 0.1, bipolar: true, value: b.gain, def: 0,
          fmt: (v) => fmtDb(v) + ' дБ', onChange: (v) => { band().gain = Math.round(v * 10) / 10; changed(); } }),
        q: knob(panel.querySelector('[data-k=q]'), { name: 'Ширина (Q)', min: 0.1, max: 18, log: true, value: b.q, def: isCut(b.type) ? 0.71 : 1,
          fmt: (v) => v.toFixed(2), onChange: (v) => { setQ(band(), v); changed(); } }),
      };
      pk.gain.el.classList.toggle('off', !hasGain(b.type));
      pk.q.el.classList.toggle('off', !hasQ(b.type));
      if (!hasQ(b.type)) pk.q.el.title = 'У полок ширина фиксирована';
      // панель стоит под выбранной точкой, но не вылезает за край
      const pw = panel.offsetWidth;
      panel.style.left = Math.max(8, Math.min(stage.clientWidth - pw - 8, xOf(b.freq) - pw / 2)) + 'px';
      panel.querySelector('.eqp-power').onclick = () => { band().on = !band().on; changed(); renderPanel(); };
      panel.querySelector('.eqp-type').onchange = (e) => {
        const t = e.target.value;
        band().type = t;
        if (isCut(t)) band().q = 0.71;
        changed();
        renderPanel();
      };
      const slope = panel.querySelector('.eqp-slope');
      if (slope) slope.onchange = () => { band().slope = Number(slope.value); changed(); };
      panel.querySelector('.eqp-close').onclick = () => select(-1);
    }
    function syncPanel() {
      if (sel < 0 || panel.hidden) return;
      const b = eq().bands[sel];
      pk.freq.set(b.freq);
      pk.gain.set(b.gain);
      pk.q.set(b.q);
      const pw = panel.offsetWidth;
      panel.style.left = Math.max(8, Math.min(stage.clientWidth - pw - 8, xOf(b.freq) - pw / 2)) + 'px';
    }

    // ----- верхняя строка и выход -----
    const anBtns = root.querySelectorAll('[data-an]');
    const showAn = () => anBtns.forEach((b) => b.classList.toggle('active', b.dataset.an === eqAnalyzer));
    anBtns.forEach((b) => (b.onclick = () => { eqAnalyzer = b.dataset.an; pre = post = null; showAn(); }));
    showAn();
    const rangeBtn = root.querySelector('#eq-range');
    const showRange = () => (rangeBtn.textContent = `±${eqRange} дБ`);
    rangeBtn.onclick = () => { eqRange = EQ_RANGES[(EQ_RANGES.indexOf(eqRange) + 1) % EQ_RANGES.length]; showRange(); syncPanel(); };
    showRange();
    root.querySelector('#eq-flat').onclick = () => {
      eq().bands.forEach((b) => (b.gain = 0));
      eq().output = 0;
      outKnob.set(0);
      changed();
      syncPanel();
    };
    const outKnob = knob(root.querySelector('#eq-out'), { name: 'Выход', min: -12, max: 12, step: 0.1, bipolar: true, value: eq().output || 0, def: 0, size: 54,
      fmt: (v) => fmtDb(v) + ' дБ', onChange: (v) => { eq().output = Math.round(v * 10) / 10; changed(); } });

    return { draw, refresh: renderPanel };
  }

  // ===== Компрессор: ламповый «рэковый» прибор со стрелочным индикатором подавления =====
  function compWindow(root, id, c, name) {
    root.innerHTML = `
      <div class="dev hw hw-comp">
        <i class="scr tl"></i><i class="scr tr"></i><i class="scr bl"></i><i class="scr br"></i>
        <button class="hw-x" data-close title="Закрыть">✕</button>
        <div class="hw-brand"><b>КОМПРЕССОР</b><span>Event Player · канал «${name}»</span>
          <p>Всё, что громче порога, прижимается в заданное число раз. Для эфира обычно хватает порога −18…−12 дБ
            и степени 2–4. Компенсация поднимает громкость обратно — сам компрессор её не поднимает.</p></div>
        <div class="hw-knobs">
          <div data-k="threshold"></div><div data-k="ratio"></div><div data-k="makeup"></div>
          <div data-k="attack"></div><div data-k="release"></div><div data-k="knee"></div>
        </div>
        <div class="hw-right">
          <div class="vu"><canvas></canvas></div>
          <div class="hw-power"><button class="hw-btn" id="pl-on" title="Включить / выключить"></button><i class="lamp"></i><span>Вкл</span></div>
        </div>
      </div>`;
    const ms = (v) => (v < 1 ? (v * 1000).toFixed(v < 0.01 ? 1 : 0) + ' мс' : v.toFixed(2) + ' с');
    const K = {
      threshold: { name: 'Порог', min: -50, max: 0, step: 0.5, def: -18, labels: [[0, '0'], [-10, '10'], [-20, '20'], [-30, '30'], [-40, '40'], [-50, '50']], fmt: (v) => v.toFixed(1) + ' дБ' },
      ratio: { name: 'Степень', min: 1, max: 20, log: true, step: 0.1, def: 3, labels: [[1, '1'], [2, '2'], [4, '4'], [10, '10'], [20, '20']], fmt: (v) => v.toFixed(1) + ' : 1' },
      makeup: { name: 'Компенсация', min: 0, max: 24, step: 0.5, def: 0, labels: [[0, '0'], [6, '6'], [12, '12'], [18, '18'], [24, '24']], fmt: (v) => '+' + v.toFixed(1) + ' дБ' },
      attack: { name: 'Атака', min: 0.0005, max: 0.2, log: true, def: 0.01, labels: [[0.001, '1'], [0.01, '10'], [0.1, '100']], fmt: ms },
      release: { name: 'Восстановление', min: 0.02, max: 2, log: true, def: 0.25, labels: [[0.05, '50'], [0.2, '200'], [1, '1с']], fmt: ms },
      knee: { name: 'Колено', min: 0, max: 24, step: 0.5, def: 6, labels: [[0, '0'], [6, '6'], [12, '12'], [18, '18'], [24, '24']], fmt: (v) => v.toFixed(1) + ' дБ' },
    };
    for (const [k, o] of Object.entries(K)) {
      knob(root.querySelector(`[data-k=${k}]`), { ...o, skin: 'black', size: 82, value: c()[k],
        onChange: (v) => { c()[k] = o.step ? v : Math.round(v * 10000) / 10000; changed(); } });
    }
    const vu = root.querySelector('.vu canvas');
    let needle = 0; // показываемое подавление, дБ (стрелка с инерцией, как у настоящего VU)
    return {
      draw() {
        const gr = c().on ? -(ctx.engine()?.strips[id].reduction().comp || 0) : 0;
        needle += (gr - needle) * 0.15;
        drawVu(vu, needle);
      },
    };
  }

  // Стрелочный индикатор: кремовая шкала, 0 справа, стрелка уходит влево с ростом подавления
  const VU_MARKS = [0, 1, 2, 3, 5, 7, 10, 15, 20];
  const vuT = (gr) => 1 - Math.pow(Math.min(20, Math.max(0, gr)) / 20, 0.6);
  function drawVu(cv, gr) {
    const dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const face = g.createRadialGradient(w / 2, h * 1.1, 10, w / 2, h * 0.9, w * 0.8);
    face.addColorStop(0, '#fff4d6'); face.addColorStop(1, '#e2cf9c');
    g.fillStyle = face;
    g.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h * 1.05, R = h * 0.82;
    const ang = (t) => ((-48 + t * 96) * Math.PI) / 180;
    const at = (t, r) => [cx + r * Math.sin(ang(t)), cy - r * Math.cos(ang(t))];
    // шкала: чёрная дуга, красная зона сильного подавления
    g.lineWidth = 2;
    g.strokeStyle = '#2a2116';
    g.beginPath(); g.arc(cx, cy, R, ang(0) - Math.PI / 2, ang(1) - Math.PI / 2); g.stroke();
    g.lineWidth = 5;
    g.strokeStyle = '#c8322a';
    g.beginPath(); g.arc(cx, cy, R + 3, ang(0) - Math.PI / 2, ang(vuT(10)) - Math.PI / 2); g.stroke();
    g.font = '600 11px Bahnschrift, sans-serif';
    g.textAlign = 'center';
    for (const m of VU_MARKS) {
      const t = vuT(m);
      const [x1, y1] = at(t, R), [x2, y2] = at(t, R - 9);
      g.lineWidth = 1.5;
      g.strokeStyle = m >= 10 ? '#c8322a' : '#2a2116';
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      const [tx, ty] = at(t, R + 14);
      g.fillStyle = m >= 10 ? '#c8322a' : '#2a2116';
      g.fillText(m, tx, ty + 4);
    }
    g.fillStyle = '#5a4a30';
    g.font = '700 12px Bahnschrift, sans-serif';
    g.fillText('ПОДАВЛЕНИЕ  дБ', cx, h * 0.62);
    // стрелка
    const [nx, ny] = at(vuT(gr), R + 2);
    g.strokeStyle = '#111';
    g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(nx, ny); g.stroke();
    g.fillStyle = '#1b1f25';
    g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.fill();
    // блик на стекле
    const glare = g.createLinearGradient(0, 0, w, h);
    glare.addColorStop(0, 'rgba(255,255,255,.35)'); glare.addColorStop(0.45, 'rgba(255,255,255,0)');
    g.fillStyle = glare;
    g.fillRect(0, 0, w, h);
    g.textAlign = 'start';
  }

  // ===== Лимитер: светлая «мастеринговая» панель с цифровыми окошками и сегментными индикаторами =====
  function limiterWindow(root, id, l, name) {
    root.innerHTML = `
      <div class="dev hw hw-lim">
        <i class="scr tl"></i><i class="scr tr"></i><i class="scr bl"></i><i class="scr br"></i>
        <button class="hw-x" data-close title="Закрыть">✕</button>
        <div class="hw-brand"><b>ЛИМИТЕР</b><span>Event Player · ${name} · заглядывает на 5 мс вперёд</span></div>
        <div class="lim-main">
          <div class="lim-knobs">
            <div data-k="input"></div><div data-k="ceiling"></div><div data-k="release"></div>
          </div>
          <div class="lim-btns">
            <div class="hw-power"><button class="hw-btn" id="pl-on" title="Включить / выключить"></button><i class="lamp"></i><span>Вкл</span></div>
          </div>
          <div class="lim-meters">
            <div class="seg-meter gr"><em id="lim-gr">0.0</em><div class="sm-bar"><b></b></div>
              <div class="sm-scale">${[0, 2, 4, 6, 8, 10, 12].map((d) => `<span style="top:${(d / 12) * 100}%">${d}</span>`).join('')}</div><small>Подавление</small></div>
            <div class="seg-meter out"><em id="lim-out">−∞</em><div class="sm-bar"><b></b></div>
              <div class="sm-scale">${[0, -6, -12, -18, -24, -30, -36].map((d) => `<span style="top:${(-d / 36) * 100}%">${d}</span>`).join('')}</div><small>Выход</small></div>
          </div>
        </div>
        <p class="lim-note">Всё, что выше потолка, лимитер прижимает, поэтому колонки не хрипят даже от громких сэмплов. «Вход» делает
          эфир плотнее и громче, но пики всё равно не выйдут выше потолка. Держи включённым; потолок −1 дБ — нормально.</p>
      </div>`;
    const ms = (v) => (v < 1 ? (v * 1000).toFixed(0) + ' мс' : v.toFixed(2) + ' с');
    const K = {
      input: { name: 'Вход', min: 0, max: 12, step: 0.1, def: 0, labels: [[0, '0'], [3, '3'], [6, '6'], [9, '9'], [12, '12']], fmt: (v) => '+' + v.toFixed(1) + ' дБ' },
      ceiling: { name: 'Потолок', min: -12, max: 0, step: 0.1, def: -1, size: 112, labels: [[-12, '−12'], [-9, '−9'], [-6, '−6'], [-3, '−3'], [0, '0']], fmt: (v) => v.toFixed(1) + ' дБ' },
      release: { name: 'Восстановление', min: 0.005, max: 1, log: true, def: 0.08, labels: [[0.01, '10'], [0.1, '100'], [1, '1с']], fmt: ms },
    };
    for (const [k, o] of Object.entries(K)) {
      knob(root.querySelector(`[data-k=${k}]`), { size: 84, ...o, skin: 'silver', ticks: 21, value: l()[k] ?? o.def,
        onChange: (v) => { l()[k] = o.step ? v : Math.round(v * 10000) / 10000; changed(); } });
    }
    const grBar = root.querySelector('.gr b'), outBar = root.querySelector('.out b');
    let hold = -Infinity, holdAt = 0;
    return {
      draw() {
        const strip = ctx.engine()?.strips[id];
        const gr = strip ? -strip.reduction().limiter : 0;
        grBar.style.transform = `scaleY(${Math.min(1, gr / 12)})`;
        root.querySelector('#lim-gr').textContent = gr.toFixed(1);
        const db = strip ? Math.max(...strip.peaks()) : -Infinity;
        outBar.style.transform = `scaleY(${Math.max(0, Math.min(1, (db + 36) / 36))})`;
        const now = performance.now();
        if (db >= hold || now - holdAt > 1500) { hold = db; holdAt = now; }
        root.querySelector('#lim-out').textContent = Number.isFinite(hold) ? hold.toFixed(1) : '−∞';
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
    if (openWin) openWin.draw(); // эквалайзер рисует кривые и без эфира
    if (root.offsetParent || openWin) raf = requestAnimationFrame(loop);
  }

  render();
  return { show: () => { render(); loop(); }, refresh: render.status };
}

// Крутилка плагина: тянуть вверх-вниз (с Shift — точнее), колесо мыши, двойной клик — значение по умолчанию.
// o: { name, min, max, value, def, log, step, bipolar, fmt, labels: [[значение, подпись]], ticks, skin, size, onChange }
// skin — вид ручки: dark (экран эквалайзера), black (компрессор), silver (лимитер).
function knob(el, o) {
  const toT = (v) => Math.min(1, Math.max(0, o.log ? Math.log(v / o.min) / Math.log(o.max / o.min) : (v - o.min) / (o.max - o.min))) || 0;
  const fromT = (t) => (o.log ? o.min * (o.max / o.min) ** t : o.min + t * (o.max - o.min));
  const snap = (v) => (o.step ? Math.round(v / o.step) * o.step : v);
  const pt = (t, r) => {
    const a = ((-135 + t * 270) * Math.PI) / 180;
    return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
  };
  const arc = (t0, t1) => {
    const [a, b] = t0 < t1 ? [t0, t1] : [t1, t0];
    if (b - a < 0.002) return '';
    const [x0, y0] = pt(a, 40), [x1, y1] = pt(b, 40);
    return `M${x0} ${y0}A40 40 0 ${(b - a) * 270 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const n = o.ticks ?? 11;
  el.className = `pk ${o.skin || 'dark'}`;
  if (o.size) el.style.setProperty('--size', o.size + 'px');
  el.innerHTML = `
    <div class="pk-body">
      <svg viewBox="-24 -24 148 148" aria-hidden="true">
        ${Array.from({ length: n }, (_, i) => {
          const [x1, y1] = pt(i / (n - 1), 47), [x2, y2] = pt(i / (n - 1), 53);
          return `<line class="pk-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
        }).join('')}
        ${(o.labels || []).map(([v, s]) => { const [x, y] = pt(toT(v), 66); return `<text x="${x}" y="${y + 4}">${s}</text>`; }).join('')}
        <path class="pk-track" d="${arc(0, 1)}"/><path class="pk-fill"/>
      </svg>
      <div class="pk-cap"><i></i></div>
    </div>
    <div class="pk-val"></div>
    ${o.name ? `<div class="pk-name">${o.name}</div>` : ''}`;
  const body = el.querySelector('.pk-body');
  const cap = el.querySelector('.pk-cap');
  const fill = el.querySelector('.pk-fill');
  const val = el.querySelector('.pk-val');
  let v = o.value;
  let t = toT(v);
  const draw = () => {
    cap.style.transform = `rotate(${-135 + toT(v) * 270}deg)`;
    fill.setAttribute('d', arc(o.bipolar ? toT(0) : 0, toT(v)));
    val.textContent = o.fmt ? o.fmt(v) : v;
  };
  const commit = (nv) => {
    nv = Math.min(o.max, Math.max(o.min, nv));
    if (nv === v) return;
    v = nv;
    draw();
    o.onChange(v);
  };
  const off = () => el.classList.contains('off');
  body.addEventListener('pointerdown', (e) => {
    if (off()) return;
    body.setPointerCapture(e.pointerId);
    t = toT(v);
    let y = e.clientY;
    const move = (ev) => {
      t = Math.min(1, Math.max(0, t + (y - ev.clientY) / (ev.shiftKey ? 900 : 180)));
      y = ev.clientY;
      commit(snap(fromT(t)));
    };
    const up = () => {
      body.removeEventListener('pointermove', move);
      body.removeEventListener('pointerup', up);
      body.removeEventListener('pointercancel', up);
    };
    body.addEventListener('pointermove', move);
    body.addEventListener('pointerup', up);
    body.addEventListener('pointercancel', up);
  });
  body.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (off()) return;
    const dir = e.deltaY < 0 ? 1 : -1;
    const before = v;
    commit(snap(fromT(toT(v) + dir * (e.shiftKey ? 0.005 : 0.025))));
    if (v === before && o.step) commit(snap(v + dir * o.step)); // шаг крупнее одного «щелчка» колеса
  }, { passive: false });
  body.addEventListener('dblclick', () => { if (!off() && o.def !== undefined) commit(o.def); });
  draw();
  return { el, set: (nv) => { v = nv; draw(); } };
}
