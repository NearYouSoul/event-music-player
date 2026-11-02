// Компрессор и лимитер, которые считают звук сами (AudioWorklet), вместо встроенного DynamicsCompressorNode.
// Почему не встроенный: он сам добавляет скрытую «компенсацию громкости» (по спецификации Web Audio),
// а его лимитирование не гарантирует потолок. Здесь всё предсказуемо:
//   comp  — классический компрессор: пиковый детектор, мягкое колено, атака/восстановление, make-up
//   limit — лимитер с заглядыванием вперёд на 5 мс: громче потолка не выйдет ни один отсчёт
// Включение/выключение — плавный переход 10 мс между обработанным и чистым звуком, без щелчков.
// Настройки приходят сообщением в port, подавление (дБ) уходит обратно ~25 раз в секунду.

const dbToLin = (db) => Math.pow(10, db / 20);
const LOOKAHEAD = 0.005;

class Dynamics extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.mode = processorOptions.mode; // 'comp' | 'limit'
    this.conf = { on: false, threshold: -18, ratio: 3, knee: 6, attack: 0.01, release: 0.25, makeup: 0, ceiling: -1 };
    this.port.onmessage = (e) => Object.assign(this.conf, e.data);
    this.mix = 0;        // 0 — чистый звук, 1 — обработанный
    this.gr = 0;         // текущее подавление компрессора, дБ (≤ 0)
    this.reportMin = 0;  // наибольшее подавление с прошлого отчёта
    this.blocks = 0;
    if (this.mode === 'limit') {
      const L = Math.max(1, Math.round(LOOKAHEAD * sampleRate));
      this.L = L;
      this.delay = [new Float32Array(L), new Float32Array(L)]; // задержка L−1 отсчётов (кольцо длины L)
      this.pos = 0;
      // скользящий минимум требуемого усиления за L отсчётов (монотонная очередь)
      this.qVal = new Float64Array(L + 1);
      this.qIdx = new Float64Array(L + 1);
      this.qHead = 0;
      this.qTail = 0;
      this.n = 0;
      this.held = 1;      // после мгновенной атаки и плавного восстановления
      this.box = new Float64Array(L); // скользящее среднее за L — сглаживает ступеньки
      this.boxSum = L;
      this.box.fill(1);
      this.boxPos = 0;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    const chans = output.length;
    const inp = (c, i) => (input[c] ? input[c][i] : input[0] ? input[0][i] : 0);
    const c = this.conf;
    const mixStep = 1 / (0.01 * sampleRate);
    let minGain = 0;

    if (this.mode === 'comp') {
      const att = Math.exp(-1 / (Math.max(c.attack, 0.0001) * sampleRate));
      const rel = Math.exp(-1 / (Math.max(c.release, 0.001) * sampleRate));
      const { threshold: T, ratio: R, knee: K } = c;
      const makeup = dbToLin(c.makeup);
      for (let i = 0; i < frames; i++) {
        let peak = 0;
        for (let ch = 0; ch < chans; ch++) peak = Math.max(peak, Math.abs(inp(ch, i)));
        const x = 20 * Math.log10(peak + 1e-12);
        // кривая с мягким коленом: сколько дБ должно остаться на выходе
        let y = x;
        if (2 * (x - T) > K) y = T + (x - T) / R;
        else if (K > 0 && 2 * Math.abs(x - T) <= K) y = x + ((1 / R - 1) * (x - T + K / 2) ** 2) / (2 * K);
        const target = y - x; // ≤ 0
        this.gr = target < this.gr ? target + (this.gr - target) * att : target + (this.gr - target) * rel;
        const g = dbToLin(this.gr) * makeup;
        this.mix += Math.max(-mixStep, Math.min(mixStep, (c.on ? 1 : 0) - this.mix));
        for (let ch = 0; ch < chans; ch++) {
          const dry = inp(ch, i);
          output[ch][i] = dry * (1 - this.mix) + dry * g * this.mix;
        }
        if (c.on) minGain = Math.min(minGain, this.gr);
      }
    } else {
      const L = this.L;
      const ceil = dbToLin(c.ceiling);
      const rel = Math.exp(-1 / (0.08 * sampleRate));
      for (let i = 0; i < frames; i++) {
        let peak = 0;
        for (let ch = 0; ch < chans; ch++) peak = Math.max(peak, Math.abs(inp(ch, i)));
        const need = peak > ceil ? ceil / peak : 1;
        // монотонная очередь: минимум need за последние L отсчётов
        const n = this.n++;
        while (this.qTail !== this.qHead && this.qVal[(this.qTail + L) % (L + 1)] >= need) this.qTail = (this.qTail + L) % (L + 1);
        this.qVal[this.qTail] = need;
        this.qIdx[this.qTail] = n;
        this.qTail = (this.qTail + 1) % (L + 1);
        while (this.qIdx[this.qHead] <= n - L) this.qHead = (this.qHead + 1) % (L + 1);
        const minNeed = this.qVal[this.qHead];
        this.held = minNeed < this.held ? minNeed : minNeed + (this.held - minNeed) * rel;
        this.boxSum += this.held - this.box[this.boxPos];
        this.box[this.boxPos] = this.held;
        this.boxPos = (this.boxPos + 1) % L;
        const g = Math.min(1, this.boxSum / L);
        this.mix += Math.max(-mixStep, Math.min(mixStep, (c.on ? 1 : 0) - this.mix));
        // задержанный на L−1 отсчётов звук — и с лимитером, и без (задержка не прыгает при переключении)
        const p = this.pos;
        const out = (p + 1) % L;
        for (let ch = 0; ch < chans; ch++) {
          const d = this.delay[Math.min(ch, 1)];
          d[p] = inp(ch, i);
          const dry = L > 1 ? d[out] : d[p];
          output[ch][i] = dry * (1 - this.mix) + dry * g * this.mix;
        }
        this.pos = out;
        if (c.on) minGain = Math.min(minGain, 20 * Math.log10(g));
      }
    }
    this.reportMin = Math.min(this.reportMin, minGain);
    if (++this.blocks % 15 === 0) {
      this.port.postMessage(this.reportMin);
      this.reportMin = 0;
    }
    return true;
  }
}

registerProcessor('dynamics', Dynamics);
