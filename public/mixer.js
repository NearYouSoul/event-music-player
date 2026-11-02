// Канальная линейка микшера — как в DAW:
//   вход ─ эквалайзер (7 полос) ─ компрессор ─ [лимитер, только Master] ─ фейдер ─ выход
// Эквалайзер — BiquadFilterNode (те же «RBJ-биквады», что в большинстве плагинов-эквалайзеров).
// Компрессор и лимитер — свои, в dynamics-worklet.js (предсказуемее встроенного DynamicsCompressor).
// Схема собрана один раз и больше не пересоединяется: выключение блока — плавный переход
// между обработанным и чистым звуком, поэтому щелчков при переключении в эфире нет.

export const CHANNELS = [
  { id: 'bg', name: 'Фон', volume: 'bgVolume' },
  { id: 'jingles', name: 'Отбивки', volume: 'jingleVolume' },
  { id: 'pads', name: 'Пэды', volume: 'padVolume' },
  { id: 'master', name: 'Master', volume: 'masterVolume' },
];

export const BAND_TYPES = {
  highpass: 'Срез НЧ',
  lowshelf: 'Полка НЧ',
  peaking: 'Колокол',
  highshelf: 'Полка ВЧ',
  lowpass: 'Срез ВЧ',
  notch: 'Режекция',
};
// у каких типов есть усиление (у срезов и режекции — только частота и Q)
export const hasGain = (type) => ['lowshelf', 'peaking', 'highshelf'].includes(type);
export const isCut = (type) => type === 'highpass' || type === 'lowpass';
// у полок Web Audio не использует Q — их крутизна фиксирована
export const hasQ = (type) => !['lowshelf', 'highshelf'].includes(type);
export const SLOPES = [12, 24, 36, 48]; // крутизна срезов, дБ на октаву
export const STAGES = 4;                // биквадов на полосу: срез 48 дБ/окт = 4 ступени по 12

// Ступени одной полосы. Срез собирается из нескольких биквадов с добротностями фильтра Баттерворта
// (ровная АЧХ без горба), резонанс полосы (Q) добавляется к самой «острой» ступени.
// Колокол, полка и режекция — одна ступень; лишние ступени — колокол с усилением 0, он ничего не меняет.
// Выключенная полоса становится прозрачной, сохраняя тип, — поэтому выключение без щелчка.
export function bandStages(b, nyq) {
  const idle = { type: 'peaking', freq: b.freq, q: 1, gain: 0 };
  if (isCut(b.type)) {
    const n = (b.slope || 12) / 12;
    const freq = b.on ? b.freq : b.type === 'highpass' ? 10 : Math.min(22000, nyq * 0.92);
    return Array.from({ length: STAGES }, (_, k) => {
      if (k >= n) return idle;
      const q = 1 / (2 * Math.sin(((2 * k + 1) * Math.PI) / (4 * n)));
      return { type: b.type, freq, q: k === 0 ? q * (b.q / Math.SQRT1_2) : q, gain: 0 };
    });
  }
  const main = {
    type: b.type,
    freq: b.freq,
    q: !b.on && b.type === 'notch' ? 1000 : b.q,
    gain: b.on && hasGain(b.type) ? b.gain : 0,
  };
  return [main, idle, idle, idle];
}

// Настроить биквад на ступень. У срезов Web Audio принимает Q в децибелах (так в спецификации),
// у остальных типов — обычное число.
export function setStage(f, st, set) {
  if (f.type !== st.type) f.type = st.type;
  set(f.frequency, st.freq);
  set(f.Q, isCut(st.type) ? 20 * Math.log10(st.q) : st.q);
  set(f.gain, st.gain);
}

export class Strip {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.input = ctx.createGain();
    // EQ: вход делится на «обработанный» (через полосы) и «чистый»; включение — перекрёстный фейд
    this.bands = Array.from({ length: 7 }, () => Array.from({ length: STAGES }, () => ctx.createBiquadFilter()));
    this.eqWet = ctx.createGain();
    this.eqDry = ctx.createGain();
    this.eqOut = ctx.createGain();
    this.eqWet.gain.value = 0; // до первых настроек — чистый звук
    this.bands.flat().reduce((a, b) => (a.connect(b), b), this.input).connect(this.eqWet).connect(this.eqOut);
    // спектр до эквалайзера — окно эквалайзера показывает «до» и «после»
    this.preAnalyser = ctx.createAnalyser();
    this.preAnalyser.fftSize = 4096;
    this.preAnalyser.smoothingTimeConstant = 0.75;
    this.input.connect(this.preAnalyser);
    this.eqAnalyser = ctx.createAnalyser();
    this.eqAnalyser.fftSize = 4096;
    this.eqAnalyser.smoothingTimeConstant = 0.75;
    this.eqOut.connect(this.eqAnalyser);
    this.input.connect(this.eqDry).connect(this.eqOut);
    const dyn = (mode) => {
      const node = new AudioWorkletNode(ctx, 'dynamics', {
        processorOptions: { mode }, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      });
      node.gr = 0;
      node.port.onmessage = (e) => (node.gr = e.data);
      return node;
    };
    this.comp = dyn('comp');
    this.limiter = id === 'master' ? dyn('limit') : null;
    this.fader = ctx.createGain();
    let last = this.eqOut.connect(this.comp);
    if (this.limiter) last = last.connect(this.limiter);
    last.connect(this.fader);
    this.output = this.fader;
    // спектр (окно эквалайзера) и стерео-индикатор после фейдера
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.75;
    this.fader.connect(this.analyser);
    const split = ctx.createChannelSplitter(2);
    this.fader.connect(split);
    this.meters = [0, 1].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      split.connect(a, ch);
      return a;
    });
    this.timeData = new Float32Array(1024);
  }

  // conf — settings.mixer[id]
  apply(conf) {
    const t = this.ctx.currentTime;
    const smooth = (param, v) => param.setTargetAtTime(v, t, 0.015);
    const nyq = this.ctx.sampleRate / 2;
    // выключенная полоса не вынимается из цепочки, а становится прозрачной — плавно, без щелчка
    conf.eq.bands.forEach((b, i) => bandStages(b, nyq).forEach((st, k) => setStage(this.bands[i][k], st, smooth)));
    // «Выход» эквалайзера — общее усиление после полос
    smooth(this.eqWet.gain, conf.eq.on ? 10 ** ((conf.eq.output || 0) / 20) : 0);
    smooth(this.eqDry.gain, conf.eq.on ? 0 : 1);
    this.comp.port.postMessage(conf.comp);
    if (this.limiter) this.limiter.port.postMessage(conf.limiter);
  }

  // Пиковый уровень левого и правого канала после фейдера, дБ
  peaks() {
    return this.meters.map((a) => {
      a.getFloatTimeDomainData(this.timeData);
      let m = 0;
      for (const v of this.timeData) m = Math.max(m, Math.abs(v));
      return m ? 20 * Math.log10(m) : -Infinity;
    });
  }

  // Насколько сейчас давят компрессор и лимитер, дБ (≤ 0)
  reduction() {
    return { comp: this.comp.gr, limiter: this.limiter ? this.limiter.gr : 0 };
  }
}
