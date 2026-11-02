// Аудио-движок эфира. Весь звук играет здесь, в браузере ноутбука.
//
// Схема:  фон: deckA ─┐
//                     ├─ bgBus (ducking) ─ [линейка «Фон»] ─────┐
//         фон: deckB ─┘                                         │
//         отбивки: jdeck0/1 ─────────── [линейка «Отбивки»] ────┼─ [линейка «Master»] ─ колонки
//         пэды: buffer ─ огибающая ─ гейн пэда ─ [линейка «Пэды»] ┘
// Линейка = эквалайзер ─ компрессор ─ фейдер (см. mixer.js); на мастере ещё лимитер.
// bgBus приглушается, пока играет отбивка или пэд.

import { Strip, CHANNELS } from '/mixer.js';
import { scheduleEnvelope, fadeOutNow, fitFades, dbToGain } from '/envelope.js';

const enc = (s) => encodeURIComponent(s);
const DOUBLE_TAP_MS = 450; // окно для «двойного тапа» по пэду
const RECENT = 20;         // трек не повторяется, пока не прозвучат столько других (во всех разделах)
const ROTATION_TTL = 8 * 3600 * 1000; // через 8 ч без отбивок счётчик начинается заново (новый день)

const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

// Честная ротация: сначала играют треки, которые звучали меньше всего,
// и ни один не повторяется раньше, чем через RECENT других.
// Счётчик общий для всех разделов: трек, сыгранный в #рок, уходит в конец очереди и в «случайных».
// Хранится в браузере, поэтому переживает перезагрузку вкладки посреди турнира.
export class Rotation {
  constructor(key) {
    this.key = key;
    try { this.data = JSON.parse(localStorage.getItem(key)); } catch {}
    if (!this.data || Date.now() - this.data.at > ROTATION_TTL) this.reset();
  }

  reset() {
    this.data = { at: Date.now(), plays: {}, cues: {}, recent: [] };
    this.save();
  }

  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch {}
  }

  plays(name) { return this.data.plays[name] || 0; }

  // names — из кого выбирать (текущий раздел)
  pick(names) {
    const window = Math.min(RECENT, names.length - 1);
    const recent = window > 0 ? this.data.recent.slice(-window) : [];
    let pool = names.filter((n) => !recent.includes(n));
    if (!pool.length) pool = names;
    const min = Math.min(...pool.map((n) => this.plays(n)));
    return randomOf(pool.filter((n) => this.plays(n) === min));
  }

  // Точку внутри трека — тоже по кругу: сначала те, что звучали реже
  pickCue(name, count) {
    const used = this.data.cues[name] || [];
    const idx = [...Array(count).keys()];
    const min = Math.min(...idx.map((i) => used[i] || 0));
    return randomOf(idx.filter((i) => (used[i] || 0) === min));
  }

  played(name, cue) {
    const d = this.data;
    d.at = Date.now();
    d.plays[name] = this.plays(name) + 1;
    d.recent = [...d.recent, name].slice(-RECENT * 3);
    if (cue !== undefined) {
      const used = (d.cues[name] ||= []);
      used[cue] = (used[cue] || 0) + 1;
    }
    this.save();
  }
}

function waitEvent(el, name) {
  return new Promise((resolve, reject) => {
    el.addEventListener(name, resolve, { once: true });
    el.addEventListener('error', reject, { once: true });
  });
}

// Точка отбивки: число (старт) или объект со своими параметрами
export const cueOf = (c) => (typeof c === 'number' ? { t: c } : c);

export class Engine {
  constructor(getSettings, onStatus, saveSettings) {
    this.s = getSettings;
    this.onStatus = onStatus;
    this.save = saveSettings;
    this.bg = { state: 'stopped', track: null, gen: 0, crossfading: false };
    this.fg = null; // { kind: 'jingle'|'pad', name, bank, slot, dur, loop, startedAt, stop(fadeSec) }
    this.sampleCache = new Map();
    this.ticks = 0;
    this.jingleTag = null;     // выбранный раздел отбивок; null — «случайные» (все)
    this.lastJingle = null;
    this.bank = this.s().activeBank || 0;
    this.jingleRotation = new Rotation('emp-rotation-jingles');
    this.bgRotation = new Rotation('emp-rotation-bg');
  }

  // AudioContext создаётся сразу (браузер разрешает звук только в обработчике клика), потом грузится worklet
  async init() {
    const ctx = (this.ctx = new AudioContext());
    await ctx.audioWorklet.addModule('/dynamics-worklet.js');
    this.strips = Object.fromEntries(CHANNELS.map((c) => [c.id, new Strip(ctx, c.id)]));
    for (const c of CHANNELS) if (c.id !== 'master') this.strips[c.id].output.connect(this.strips.master.input);
    this.strips.master.output.connect(ctx.destination);
    this.applyMixer();
    for (const c of CHANNELS) this.strips[c.id].fader.gain.value = this.s()[c.volume];
    this.bgBus = ctx.createGain();
    this.bgBus.connect(this.strips.bg.input);

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
    this.jdecks = [deck(this.strips.jingles.input), deck(this.strips.jingles.input)];
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

  // Эквалайзеры, компрессоры и лимитер — из settings.mixer
  applyMixer() {
    const m = this.s().mixer;
    for (const id in this.strips) this.strips[id].apply(m[id]);
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

  pads(bank = this.bank) {
    const { banks } = this.s();
    if (this.bank >= banks.length) this.bank = 0; // активный банк удалили в редакторе
    return banks[bank]?.pads || [];
  }

  // Пульты сами анимируют прогресс от присланной позиции, поэтому
  // статус шлётся только при изменениях (плюс редкая синхронизация в tick)
  emit(extra = {}) {
    const el = this.decks?.[this.cur].el;
    const fg = this.fg;
    const s = this.s();
    this.onStatus({
      type: 'status',
      bg: this.bg.state,
      bgTrack: this.bg.track,
      bgPos: el && this.bg.track ? el.currentTime : 0,
      bgDur: el && this.bg.track && el.duration ? el.duration : 0,
      fg: fg ? { kind: fg.kind, name: fg.name, bank: fg.bank, slot: fg.slot, dur: fg.dur, loop: !!fg.loop, elapsed: (performance.now() - fg.startedAt) / 1000 } : null,
      bank: this.bank,
      jingleTag: this.jingleTag,
      lastJingle: this.lastJingle,
      volumes: Object.fromEntries(CHANNELS.map((c) => [c.id, s[c.volume]])),
      ...extra,
    });
  }

  setVolume(target, value) {
    const ch = CHANNELS.find((c) => c.id === target);
    if (!ch) return;
    const v = Math.min(1, Math.max(0, Number(value)));
    this.fade(this.strips[target].fader.gain, v, 0.05);
    this.save({ [ch.volume]: v });
    this.emit();
  }

  setBank(i) {
    const n = this.s().banks.length;
    this.bank = ((i % n) + n) % n;
    this.save({ activeBank: this.bank });
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
    const track = this.bgRotation.pick(background);
    this.bgRotation.played(track);
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
    const name = this.jingleRotation.pick(ready.map((j) => j.name));
    const j = ready.find((x) => x.name === name);
    const cueIdx = this.jingleRotation.pickCue(name, j.cues.length);
    this.jingleRotation.played(name, cueIdx);
    this.lastJingle = name;
    const s = this.s();
    const cue = cueOf(j.cues[cueIdx]);
    const dur = cue.len ?? s.jingleDuration;
    const [fadeIn, fadeOut] = fitFades(dur, cue.fadeIn ?? 0.05, cue.fadeOut ?? s.jingleFadeOut);
    const env = { dur, fadeIn, fadeOut, curveIn: cue.curveIn, curveOut: cue.curveOut };

    const d = this.jdecks[(this.jcur = 1 - this.jcur)];
    let timer;
    const item = {
      kind: 'jingle',
      name,
      dur,
      startedAt: performance.now(),
      stop: (sec) => {
        clearTimeout(timer);
        if (d.owner !== item) return this.releaseForeground(item);
        fadeOutNow(this.ctx, d.gain.gain, sec, cue.curveOut);
        timer = setTimeout(() => { if (d.owner === item) d.el.pause(); }, sec * 1000 + 50);
        this.releaseForeground(item);
      },
    };
    this.claimForeground(item);
    d.owner = item;

    d.el.pause();
    d.el.src = '/media/jingles/' + enc(name);
    try {
      await waitEvent(d.el, 'loadedmetadata');
      d.el.currentTime = cue.t;
      await waitEvent(d.el, 'seeked');
    } catch {
      return this.releaseForeground(item);
    }
    if (this.fg !== item) return; // пока грузилось, нажали что-то другое
    const g = d.gain.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.value = 0;
    await d.el.play().catch(() => {});
    scheduleEnvelope(g, this.ctx.currentTime, env);
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
    for (const b of this.s().banks) for (const p of b.pads) if (p.file) this.loadSample(p.file).catch(() => {});
  }

  isPlaying(slot, bank = this.bank) {
    return this.fg && this.fg.kind === 'pad' && this.fg.slot === slot && this.fg.bank === bank;
  }

  // Нажатие пэда (oneshot и loop). Для hold — padDown/padUp.
  async pad(slot) {
    const conf = this.pads()[slot];
    if (!conf || !conf.file) return this.emit({ error: `На пэд ${slot + 1} не назначен звук` });
    if (conf.mode === 'hold') return this.padDown(slot);
    // Повторное нажатие на играющий пэд — плавная остановка (затухание пэда, минимум 0.4 с)
    if (this.isPlaying(slot)) {
      this.padStopped = { slot, bank: this.bank, at: performance.now(), item: this.fg };
      return this.fg.stop(Math.max(conf.fadeOut || 0, 0.4));
    }
    // Ещё одно нажатие сразу следом (двойной тап) — обрубаем затухание, без перезапуска
    const ps = this.padStopped;
    this.padStopped = null;
    if (ps && ps.slot === slot && ps.bank === this.bank && performance.now() - ps.at < DOUBLE_TAP_MS) return ps.item.stop(0.03);
    return this.startPad(slot, conf);
  }

  padDown(slot) {
    const conf = this.pads()[slot];
    if (!conf || !conf.file) return;
    if (conf.mode !== 'hold') return this.pad(slot);
    if (!this.isPlaying(slot)) return this.startPad(slot, conf);
  }

  padUp(slot) {
    const conf = this.pads()[slot];
    if (!conf || conf.mode !== 'hold') return;
    this.holdReleased = slot; // отпустили раньше, чем звук загрузился
    if (this.isPlaying(slot)) this.fg.stop(Math.max(conf.fadeOut || 0, 0.05));
  }

  async startPad(slot, conf) {
    const bank = this.bank;
    this.holdReleased = null;
    let buffer;
    try {
      buffer = await this.loadSample(conf.file);
    } catch {
      return this.emit({ error: `Не удалось загрузить ${conf.file}` });
    }
    if (conf.mode === 'hold' && this.holdReleased === slot) return;
    // Обрезка: играем только кусок [start, end]
    const from = Math.min(conf.start || 0, buffer.duration);
    const to = Math.min(conf.end ?? buffer.duration, buffer.duration);
    const dur = Math.max(to - from, 0.05);
    const loop = conf.mode === 'loop';
    const src = this.ctx.createBufferSource();
    const env = this.ctx.createGain();
    const trim = this.ctx.createGain();
    trim.gain.value = dbToGain(conf.gain);
    src.buffer = buffer;
    src.connect(env).connect(trim).connect(this.strips.pads.input);
    const item = {
      kind: 'pad',
      name: conf.name,
      bank,
      slot,
      dur: loop ? 0 : dur,
      loop,
      startedAt: performance.now(),
      stop: (sec) => {
        fadeOutNow(this.ctx, env.gain, sec, conf.curveOut);
        try { src.stop(this.ctx.currentTime + sec + 0.05); } catch {}
        this.releaseForeground(item);
      },
    };
    src.onended = () => this.releaseForeground(item);
    this.claimForeground(item);
    const [fadeIn, fadeOut] = fitFades(dur, conf.fadeIn, conf.fadeOut);
    const t = this.ctx.currentTime;
    scheduleEnvelope(env.gain, t, { dur, fadeIn, fadeOut, curveIn: conf.curveIn, curveOut: conf.curveOut, loop });
    if (loop) {
      src.loop = true;
      src.loopStart = from;
      src.loopEnd = to;
      src.start(t, from);
    } else {
      src.start(t, from, dur);
    }
  }

  // Эфир забрала другая вкладка: плавно глушим всё
  shutdown() {
    this.fade(this.strips.master.fader.gain, 0, 0.5);
    clearInterval(this.tickTimer);
    setTimeout(() => this.ctx.close(), 700);
  }

  command(msg) {
    switch (msg.cmd) {
      case 'bgPlay': return this.bgPlay();
      case 'bgPause': return this.bgPause();
      case 'bgStop': return this.bgStop();
      case 'bgToggle': return this.bgToggle();
      case 'jingle': return this.jingle();
      case 'jingleStop': return this.stopJingle();
      case 'jingleTag': this.jingleTag = msg.tag || null; return this.emit();
      case 'bgNext': return this.bg.state === 'playing' && this.bgNext();
      case 'pad': return this.pad(Number(msg.slot));
      case 'padDown': return this.padDown(Number(msg.slot));
      case 'padUp': return this.padUp(Number(msg.slot));
      case 'bank': return this.setBank(Number(msg.bank));
      case 'bankNext': return this.setBank(this.bank + 1);
      case 'bankPrev': return this.setBank(this.bank - 1);
      case 'volume': return this.setVolume(msg.target, msg.value);
    }
  }
}
