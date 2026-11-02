// Огибающие громкости: формы фейдов, расписание для Web Audio и измерение громкости.
// Общие для движка (эфир) и редакторов (прослушка и рисование дуги на волне).

// Формы — как в анимации: «прогресс» фейда p = ease(x), где x — доля времени фейда (0..1).
// Вход: громкость = p. Затухание: громкость = 1 − p.
// Ease-in — фейд стартует медленно и ускоряется к концу, Ease-out — наоборот.
export const CURVES = {
  linear: 'Линейная',
  easeIn: 'Ease-in',
  easeOut: 'Ease-out',
  sCurve: 'S-кривая',
  equalPower: 'Equal power',
};

const EASE = {
  linear: (x) => x,
  easeIn: (x) => x * x,
  easeOut: (x) => 1 - (1 - x) * (1 - x),
  sCurve: (x) => x * x * (3 - 2 * x),
  equalPower: (x) => Math.sin((x * Math.PI) / 2),
};

const ease = (curve) => EASE[curve] || EASE.linear;

// Громкость фейда в точке x (0..1)
export function fadeInValue(curve, x) {
  return ease(curve)(Math.min(1, Math.max(0, x)));
}
export function fadeOutValue(curve, x) {
  x = Math.min(1, Math.max(0, x));
  // у equal power затухание — косинус, а не 1 − синус: так сумма мощностей постоянна
  return curve === 'equalPower' ? Math.cos((x * Math.PI) / 2) : 1 - ease(curve)(x);
}

// Громкость огибающей в момент t (секунды от начала куска длиной dur)
export function envelopeAt(env, t) {
  const { dur, fadeIn = 0, fadeOut = 0, curveIn, curveOut } = env;
  let v = 1;
  if (fadeIn > 0 && t < fadeIn) v = Math.min(v, fadeInValue(curveIn, t / fadeIn));
  if (fadeOut > 0 && t > dur - fadeOut) v = Math.min(v, fadeOutValue(curveOut, (t - (dur - fadeOut)) / fadeOut));
  return t < 0 || t > dur ? 0 : v;
}

// Входы и затухания длиннее куска ужимаем пропорционально; минимум 20 мс, чтобы не щёлкало
export function fitFades(dur, fadeIn, fadeOut) {
  let fi = Math.max(fadeIn || 0, 0.02);
  let fo = Math.max(fadeOut || 0, 0.02);
  const k = Math.min(1, dur / (fi + fo));
  return [fi * k, fo * k];
}

const POINTS = 64;
function curveArray(fn, peak) {
  const a = new Float32Array(POINTS);
  for (let i = 0; i < POINTS; i++) a[i] = fn(i / (POINTS - 1)) * peak;
  return a;
}

// Расписать на AudioParam: вход, полка, затухание (loop = без затухания в конце)
export function scheduleEnvelope(param, t, { dur, fadeIn, fadeOut, curveIn, curveOut, loop = false }) {
  // Кривые начинаются с 0 и кончаются на 1 (и наоборот), поэтому между ними громкость просто держится.
  // Кривая не может пересекаться с другими событиями — отсюда зазоры в пару миллисекунд.
  param.cancelScheduledValues(t);
  param.setValueCurveAtTime(curveArray((x) => fadeInValue(curveIn, x), 1), t, fadeIn);
  if (loop) return;
  const outAt = t + Math.max(dur - fadeOut, fadeIn + 0.002);
  param.setValueCurveAtTime(curveArray((x) => fadeOutValue(curveOut, x), 1), outAt, Math.max(fadeOut - 0.002, 0.01));
}

// Затухание из текущей громкости (кнопка «Стоп», вытеснение, повторное нажатие)
export function fadeOutNow(ctx, param, sec, curve = 'linear') {
  const t = ctx.currentTime;
  sec = Math.max(sec, 0.01);
  // cancelAndHoldAtTime (Chrome/Edge) замирает ровно на текущем значении посреди кривой
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
  const from = param.value;
  param.setValueCurveAtTime(curveArray((x) => fadeOutValue(curve, x), from), t + 0.005, sec);
}

// Громкость куска [from, to] в dBFS: RMS по блокам 400 мс, тихие блоки (ниже −45 дБ)
// не считаются — как «гейт» в измерении LUFS. Паузы в сэмпле не занижают результат.
export function loudness(buffer, from = 0, to = buffer.duration) {
  const rate = buffer.sampleRate;
  const a = Math.floor(from * rate);
  const b = Math.min(Math.floor(to * rate), buffer.length);
  const block = Math.floor(rate * 0.4);
  const chans = [...Array(buffer.numberOfChannels).keys()].map((c) => buffer.getChannelData(c));
  let sum = 0, n = 0;
  for (let s = a; s + block <= b || (s === a && s < b); s += block) {
    const e = Math.min(s + block, b);
    let p = 0;
    for (const ch of chans) for (let i = s; i < e; i++) p += ch[i] * ch[i];
    p /= (e - s) * chans.length;
    if (p > 10 ** (-45 / 10)) { sum += p; n++; }
  }
  return n ? 10 * Math.log10(sum / n) : -Infinity;
}

export const dbToGain = (db) => 10 ** ((db || 0) / 20);
