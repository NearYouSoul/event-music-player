// Аудио-движок эфира. Весь звук играет здесь, в браузере ноутбука.
//
// Схема:  фон: deckA ─┐                отбивки: jdeck0/1 ─┐
//                     ├─ bgBus ─ bgVol ─┐                  ├─ fgBus ─┐
//         фон: deckB ─┘                 ├── master ─ колонки   пэды ─┘  │
//                                       └───────────────────────────────┘
// bgBus приглушается (ducking), пока играет отбивка или пэд.
// bgVol — крутилка «Фон», master — крутилка «Master».

const enc = (s) => encodeURIComponent(s);
const DOUBLE_TAP_MS = 450; // окно для «двойного тапа» по пэду
const RECENT_JINGLES = 20; // отбивка не повторяется, пока не прозвучат столько других

function pick(list, avoid) {
  const pool = list.length > 1 ? list.filter((x) => x !== avoid) : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

function waitEvent(el, name) {
  return new Promise((resolve, reject) => {
    el.addEventListener(name, resolve, { once: true });
    el.addEventListener('error', reject, { once: true });
  });
}

export class Engine {
  constructor(getSettings, onStatus, saveSettings) {
    this.s = getSettings;
    this.onStatus = onStatus;
    this.save = saveSettings;
    this.bg = { state: 'stopped', track: null, gen: 0, crossfading: false };
    this.fg = null; // { kind: 'jingle'|'pad', name, slot, dur, startedAt, stop(fadeSec) }
    this.sampleCache = new Map();
    this.ticks = 0;
    this.jingleTag = null;     // выбранный раздел отбивок; null — «случайные» (все)
    this.recentJingles = [];   // последние сыгранные отбивки — для памяти от повторов
    this.lastJingle = null;
  }

  init() {
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = this.s().masterVolume;
    this.master.connect(ctx.destination);
    this.bgVol = ctx.createGain();
    this.bgVol.gain.value = this.s().bgVolume;
    this.bgVol.connect(this.master);
    this.bgBus = ctx.createGain();
    this.bgBus.connect(this.bgVol);
    this.fgBus = ctx.createGain();
    this.fgBus.connect(this.master);

    const deck = (bus) => {
      const el = new Audio();
      el.preload = 'auto';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(el).connect(gain).connect(bus);
      return { el, gain };
    };
    this.decks = [deck(this.bgBus), deck(this.bgBus)];
    this.cur = 0;
    this.jdecks = [deck(this.fgBus), deck(this.fgBus)];
    this.jcur = 0;

    for (const d of this.decks) {
      d.el.addEventListener('ended', () => {
        if (d === this.decks[this.cur] && this.bg.state === 'playing' && !this.bg.crossfading) this.bgNext();
      });
      d.el.addEventListener('error', () => {
        if (d === this.decks[this.cur] && this.bg.state === 'playing') setTimeout(() => this.bgNext(), 500);
      });
      // длительность известна только после загрузки — сообщаем пультам
      d.el.addEventListener('playing', () => { if (d === this.decks[this.cur]) this.emit(); });
    }
    this.tickTimer = setInterval(() => this.tick(), 250);
    this.emit();
  }

  fade(param, to, sec) {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(to, t + Math.max(sec, 0.01));
  }

  async library() {
    return (await fetch('/api/library')).json();
  }

  // Пульты сами анимируют прогресс от присланной позиции, поэтому
  // статус шлётся только при изменениях (плюс редкая синхронизация в tick)
  emit(extra = {}) {
    const el = this.decks?.[this.cur].el;
    const fg = this.fg;
    this.onStatus({
      type: 'status',
      bg: this.bg.state,
      bgTrack: this.bg.track,
      bgPos: el && this.bg.track ? el.currentTime : 0,
      bgDur: el && this.bg.track && el.duration ? el.duration : 0,
      fg: fg ? { kind: fg.kind, name: fg.name, slot: fg.slot, dur: fg.dur, elapsed: (performance.now() - fg.startedAt) / 1000 } : null,
      jingleTag: this.jingleTag,
      lastJingle: this.lastJingle,
      masterVolume: this.s().masterVolume,
      bgVolume: this.s().bgVolume,
      ...extra,
    });
  }

  setVolume(target, value) {
    const v = Math.min(1, Math.max(0, Number(value)));
    if (target === 'master') this.fade(this.master.gain, v, 0.05);
    else if (target === 'bg') this.fade(this.bgVol.gain, v, 0.05);
    else return;
    this.save({ [target === 'master' ? 'masterVolume' : 'bgVolume']: v });
    this.emit();
  }

  // ---------- Фон ----------
  async startOnDeck(d, fadeIn) {
    const { background } = await this.library();
    if (!background.length) {
      this.bg.state = 'stopped';
      this.emit({ error: 'Папка music/background пуста' });
      return false;
    }
    if (this.bg.state !== 'playing') return false; // пока грузился список, нажали Pause/Stop
    const track = pick(background, this.bg.track);
    this.bg.track = track;
    d.el.src = '/media/background/' + enc(track);
    d.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    d.gain.gain.value = 0;
    await d.el.play().catch(() => {});
    this.fade(d.gain.gain, 1, fadeIn);
    this.emit();
    return true;
  }

  async bgPlay() {
    const gen = ++this.bg.gen;
    if (this.bg.state === 'playing') return;
    if (this.bg.state === 'paused') {
      const d = this.decks[this.cur];
      this.bg.state = 'playing';
      await d.el.play().catch(() => {});
      this.fade(d.gain.gain, 1, 1);
      this.emit();
      return;
    }
    // Stop: новый случайный трек на свободной деке, пока прежняя догасает
    const prev = this.decks[this.cur];
    this.cur = 1 - this.cur;
    setTimeout(() => { if (prev !== this.decks[this.cur]) prev.el.pause(); }, this.s().bgStopFade * 1000 + 100);
    this.bg.state = 'playing';
    if (gen === this.bg.gen) await this.startOnDeck(this.decks[this.cur], 1.5);
  }

  // Перекрёстный переход на следующий случайный трек
  async bgNext() {
    if (this.bg.crossfading) return;
    const cf = this.s().bgCrossfade;
    const gen = this.bg.gen;
    const old = this.decks[this.cur];
    this.cur = 1 - this.cur;
    this.bg.crossfading = true;
    this.fade(old.gain.gain, 0, cf);
    await this.startOnDeck(this.decks[this.cur], cf);
    setTimeout(() => {
      if (gen !== this.bg.gen) return;
      old.el.pause();
      this.bg.crossfading = false;
    }, cf * 1000 + 100);
  }

  tick() {
    if (this.bg.state === 'playing' && ++this.ticks % 20 === 0) this.emit(); // раз в 5 с
    if (this.bg.state !== 'playing' || this.bg.crossfading) return;
    const el = this.decks[this.cur].el;
    if (el.duration && !el.paused && el.duration - el.currentTime <= this.s().bgCrossfade) this.bgNext();
  }

  // Pause и Stop оба гасят плавно; разница — Stop забывает трек
  bgFadeOut(nextState) {
    if (this.bg.state === 'stopped') return;
    if (this.bg.state === 'paused' && nextState === 'paused') return;
    const gen = ++this.bg.gen;
    const sec = this.bg.state === 'paused' ? 0.01 : this.s().bgStopFade;
    // Переход между треками прерываем: остаётся только новый трек
    const old = this.decks[1 - this.cur];
    if (this.bg.crossfading) old.el.pause();
    this.bg.crossfading = false;
    this.bg.state = nextState;
    for (const d of this.decks) this.fade(d.gain.gain, 0, sec);
    this.emit();
    setTimeout(() => {
      if (gen !== this.bg.gen) return;
      for (const d of this.decks) d.el.pause();
      if (nextState === 'stopped') {
        for (const d of this.decks) d.el.removeAttribute('src');
        this.bg.track = null;
        this.emit();
      }
    }, sec * 1000 + 50);
  }

  bgPause() { this.bgFadeOut('paused'); }
  bgStop() { this.bgFadeOut('stopped'); }

  bgToggle() {
    if (this.bg.state === 'playing') this.bgPause();
    else this.bgPlay();
  }

  // ---------- Передний план: отбивки и сэмплы ----------
  duck(on) {
    this.fade(this.bgBus.gain, on ? this.s().duckLevel : 1, on ? 0.4 : 1.5);
  }

  // Новый звук переднего плана вытесняет текущий (быстрое затухание)
  claimForeground(item) {
    if (this.fg) this.fg.stop(0.3);
    this.fg = item;
    this.duck(true);
    this.emit();
  }

  releaseForeground(item) {
    if (this.fg !== item) return;
    this.fg = null;
    this.duck(false);
    this.emit();
  }

  async jingle() {
    const { jingles } = await this.library();
    // Раздел мог быть удалён, пока был выбран — тогда снова «случайные»
    if (this.jingleTag && !this.s().jingleTags.includes(this.jingleTag)) this.jingleTag = null;
    const tag = this.jingleTag;
    const ready = jingles.filter((j) => j.cues.length && (!tag || j.tags.includes(tag)));
    if (!ready.length) return this.emit({ error: tag ? `В разделе #${tag} нет размеченных отбивок` : 'Нет размеченных отбивок' });
    // Память: трек не повторяется, пока не прозвучат 20 других (или все, если их меньше)
    const window = Math.min(RECENT_JINGLES, ready.length - 1);
    const recent = window > 0 ? this.recentJingles.slice(-window) : [];
    const fresh = ready.filter((x) => !recent.includes(x.name));
    const j = pick(fresh.length ? fresh : ready);
    this.recentJingles = [...this.recentJingles, j.name].slice(-RECENT_JINGLES * 3);
    this.lastJingle = j.name;
    const cue = j.cues[Math.floor(Math.random() * j.cues.length)];
    const { jingleDuration: dur, jingleFadeOut: fadeOut } = this.s();

    const d = this.jdecks[(this.jcur = 1 - this.jcur)];
    let timer;
    const item = {
      kind: 'jingle',
      name: j.name,
      dur,
      startedAt: performance.now(),
      stop: (sec) => {
        clearTimeout(timer);
        if (d.owner !== item) return this.releaseForeground(item);
        this.fade(d.gain.gain, 0, sec);
        timer = setTimeout(() => { if (d.owner === item) d.el.pause(); }, sec * 1000 + 50);
        this.releaseForeground(item);
      },
    };
    this.claimForeground(item);
    d.owner = item;

    d.el.pause();
    d.el.src = '/media/jingles/' + enc(j.name);
    try {
      await waitEvent(d.el, 'loadedmetadata');
      d.el.currentTime = cue;
      await waitEvent(d.el, 'seeked');
    } catch {
      return this.releaseForeground(item);
    }
    if (this.fg !== item) return; // пока грузилось, нажали что-то другое
    const g = d.gain.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.value = 0;
    await d.el.play().catch(() => {});
    const t = this.ctx.currentTime;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + 0.05);
    g.setValueAtTime(1, t + Math.max(dur - fadeOut, 0.05));
    g.linearRampToValueAtTime(0, t + dur);
    item.startedAt = performance.now();
    this.emit();
    timer = setTimeout(() => {
      if (d.owner === item) d.el.pause();
      this.releaseForeground(item);
    }, dur * 1000 + 50);
  }

  stopJingle() {
    if (this.fg && this.fg.kind === 'jingle') this.fg.stop(this.s().jingleFadeOut);
  }

  async loadSample(file) {
    if (!this.sampleCache.has(file)) {
      const buf = await (await fetch('/media/samples/' + enc(file))).arrayBuffer();
      this.sampleCache.set(file, await this.ctx.decodeAudioData(buf));
    }
    return this.sampleCache.get(file);
  }

  preloadPads() {
    for (const p of this.s().pads) if (p.file) this.loadSample(p.file).catch(() => {});
  }

  async pad(slot) {
    const conf = this.s().pads[slot];
    if (!conf || !conf.file) return this.emit({ error: `На пэд ${slot + 1} не назначен звук` });
    // Повторное нажатие на играющий пэд — плавная остановка (затухание пэда, минимум 0.4 с)
    if (this.fg && this.fg.kind === 'pad' && this.fg.slot === slot) {
      this.padStopped = { slot, at: performance.now(), item: this.fg };
      return this.fg.stop(Math.max(conf.fadeOut || 0, 0.4));
    }
    // Ещё одно нажатие сразу следом (двойной тап) — обрубаем затухание, без перезапуска
    const ps = this.padStopped;
    this.padStopped = null;
    if (ps && ps.slot === slot && performance.now() - ps.at < DOUBLE_TAP_MS) return ps.item.stop(0.03);
    let buffer;
    try {
      buffer = await this.loadSample(conf.file);
    } catch {
      return this.emit({ error: `Не удалось загрузить ${conf.file}` });
    }
    // Обрезка: играем только кусок [start, end]
    const from = Math.min(conf.start || 0, buffer.duration);
    const to = Math.min(conf.end ?? buffer.duration, buffer.duration);
    const dur = Math.max(to - from, 0.05);
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buffer;
    src.connect(gain).connect(this.fgBus);
    const item = {
      kind: 'pad',
      name: conf.name,
      slot,
      dur,
      startedAt: performance.now(),
      stop: (sec) => {
        this.fade(gain.gain, 0, sec);
        try { src.stop(this.ctx.currentTime + sec + 0.05); } catch {}
        this.releaseForeground(item);
      },
    };
    src.onended = () => this.releaseForeground(item);
    this.claimForeground(item);
    // Плавный вход и затухание из настроек пэда; минимум 20 мс, чтобы не щёлкало.
    // Если вместе они длиннее куска — ужимаем пропорционально.
    let fadeIn = Math.max(conf.fadeIn || 0, 0.02);
    let fadeOut = Math.max(conf.fadeOut || 0, 0.02);
    const k = Math.min(1, dur / (fadeIn + fadeOut));
    fadeIn *= k;
    fadeOut *= k;
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + fadeIn);
    gain.gain.setValueAtTime(1, t + dur - fadeOut);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    src.start(t, from, dur);
  }

  // Эфир забрала другая вкладка: плавно глушим всё
  shutdown() {
    this.fade(this.master.gain, 0, 0.5);
    clearInterval(this.tickTimer);
    setTimeout(() => this.ctx.close(), 700);
  }

  command(msg) {
    switch (msg.cmd) {
      case 'bgPlay': return this.bgPlay();
      case 'bgPause': return this.bgPause();
      case 'bgStop': return this.bgStop();
      case 'jingle': return this.jingle();
      case 'jingleStop': return this.stopJingle();
      case 'jingleTag': this.jingleTag = msg.tag || null; return this.emit();
      case 'bgNext': return this.bg.state === 'playing' && this.bgNext();
      case 'pad': return this.pad(Number(msg.slot));
      case 'volume': return this.setVolume(msg.target, msg.value);
    }
  }
}
