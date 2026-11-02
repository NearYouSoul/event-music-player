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

export class Strip {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;
    this.input = ctx.createGain();
    // EQ: вход делится на «обработанный» (через полосы) и «чистый»; включение — перекрёстный фейд
    this.bands = Array.from({ length: 7 }, () => ctx.createBiquadFilter());
    this.eqWet = ctx.createGain();
    this.eqDry = ctx.createGain();
    this.eqOut = ctx.createGain();
    this.eqWet.gain.value = 0; // до первых настроек — чистый звук
    this.bands.reduce((a, b) => (a.connect(b), b), this.input).connect(this.eqWet).connect(this.eqOut);
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
    conf.eq.bands.forEach((b, i) => {
      const f = this.bands[i];
      if (f.type !== b.type) f.type = b.type;
      // выключенная полоса не вынимается из цепочки, а становится прозрачной — плавно, без щелчка
      const off = !b.on;
      smooth(f.frequency, off && b.type === 'highpass' ? 10 : off && b.type === 'lowpass' ? Math.min(22000, nyq * 0.92) : b.freq);
      smooth(f.Q, off && b.type === 'notch' ? 1000 : b.q);
      smooth(f.gain, off || !hasGain(b.type) ? 0 : b.gain);
    });
    smooth(this.eqWet.gain, conf.eq.on ? 1 : 0);
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
