// Канальная линейка микшера — как в DAW:
//   вход ─ эквалайзер (до 7 полос) ─ компрессор ─ make-up ─ [лимитер, только мастер] ─ фейдер ─ выход
// Всё на встроенных узлах Web Audio: BiquadFilterNode — те же «RBJ-биквады», что в большинстве
// плагинов-эквалайзеров; DynamicsCompressorNode — компрессор с собственным look-ahead.
// Выключенные блоки из цепочки выкидываются целиком, а не просто «обнуляются».

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
    this.bands = [];
    this.comp = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();
    this.limiter = id === 'master' ? ctx.createDynamicsCompressor() : null;
    this.fader = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.75;
    this.fader.connect(this.analyser);
    this.output = this.fader;
    this.wiring = null;
    this.timeData = new Float32Array(this.analyser.fftSize);
  }

  // conf — settings.mixer[id]
  apply(conf) {
    const { ctx } = this;
    const bands = conf.eq.bands;
    while (this.bands.length < bands.length) this.bands.push(ctx.createBiquadFilter());
    bands.forEach((b, i) => {
      const f = this.bands[i];
      f.type = b.type;
      const t = ctx.currentTime;
      f.frequency.setTargetAtTime(b.freq, t, 0.02);
      f.Q.setTargetAtTime(b.q, t, 0.02);
      f.gain.setTargetAtTime(hasGain(b.type) ? b.gain : 0, t, 0.02);
    });
    const c = conf.comp;
    this.comp.threshold.value = c.threshold;
    this.comp.ratio.value = c.ratio;
    this.comp.knee.value = c.knee;
    this.comp.attack.value = c.attack;
    this.comp.release.value = c.release;
    this.makeup.gain.setTargetAtTime(c.on ? 10 ** (c.makeup / 20) : 1, ctx.currentTime, 0.02);
    if (this.limiter) {
      // лимитер: максимальное сжатие, мгновенная атака, без «колена»
      this.limiter.threshold.value = conf.limiter.ceiling;
      this.limiter.ratio.value = 20;
      this.limiter.knee.value = 0;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.1;
    }
    this.rewire(conf);
  }

  // Перестраиваем цепочку, только если включились/выключились блоки
  rewire(conf) {
    const chain = [this.input];
    if (conf.eq.on) conf.eq.bands.forEach((b, i) => b.on && chain.push(this.bands[i]));
    if (conf.comp.on) chain.push(this.comp, this.makeup);
    if (this.limiter && conf.limiter.on) chain.push(this.limiter);
    chain.push(this.fader);
    const key = chain.map((n) => [this.input, ...this.bands, this.comp, this.makeup, this.limiter, this.fader].indexOf(n)).join();
    if (key === this.wiring) return;
    this.wiring = key;
    for (const n of [this.input, ...this.bands, this.comp, this.makeup, this.limiter]) n?.disconnect();
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  }

  // Пиковый уровень после фейдера, дБ
  peak() {
    this.analyser.getFloatTimeDomainData(this.timeData);
    let m = 0;
    for (const v of this.timeData) m = Math.max(m, Math.abs(v));
    return m ? 20 * Math.log10(m) : -Infinity;
  }

  // Насколько сейчас давят компрессор и лимитер, дБ (≤ 0)
  reduction() {
    return { comp: this.comp.reduction, limiter: this.limiter ? this.limiter.reduction : 0 };
  }

  // АЧХ эквалайзера на заданных частотах, дБ — для рисования кривой
  response(freqs, conf) {
    const total = new Float32Array(freqs.length);
    if (!conf.eq.on) return total;
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    conf.eq.bands.forEach((b, i) => {
      if (!b.on) return;
      this.bands[i].getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(mag[k] || 1e-9);
    });
    return total;
  }
}
