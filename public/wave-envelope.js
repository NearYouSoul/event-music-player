// Огибающая громкости поверх области на волне (регион wavesurfer):
// дуга входа и затухания + две ручки, которые тянутся мышкой.
// Рисуется внутри region.element, поэтому сама следует за зумом, прокруткой и краями области.
import { envelopeAt } from '/envelope.js';

const STEPS = 80;

// region — регион wavesurfer; env — { fadeIn, fadeOut, curveIn, curveOut } в секундах;
// onChange(env) — после перетаскивания ручки
export function attachEnvelope(region, env, onChange) {
  const el = region.element;
  // wavesurfer рисует волну в Shadow DOM — стили страницы туда не доходят, поэтому они здесь, в разметке
  el.style.overflow = 'visible';
  const handle = (cls, title) => `
    <div class="env-handle ${cls}" title="${title}" style="position:absolute;top:0;bottom:0;width:14px;margin-left:-7px;cursor:ew-resize;z-index:3;touch-action:none">
      <i style="position:absolute;left:3px;top:4px;width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #ff6a2b,0 0 8px rgba(0,0,0,.8)"></i>
      <b style="position:absolute;left:6px;top:12px;bottom:0;width:1px;background:rgba(255,255,255,.3)"></b>
    </div>`;
  el.insertAdjacentHTML('beforeend', `
    <svg class="env" viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
      <path class="env-fill" fill="rgba(255,255,255,.08)"/>
      <path class="env-line" fill="none" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke" opacity=".9"/>
    </svg>
    ${handle('in', 'Конец плавного входа — тяни')}
    ${handle('out', 'Начало затухания — тяни')}`);
  const fill = el.querySelector('.env-fill');
  const line = el.querySelector('.env-line');
  const hIn = el.querySelector('.env-handle.in');
  const hOut = el.querySelector('.env-handle.out');

  const len = () => Math.max(region.end - region.start, 0.01);

  function redraw() {
    const dur = len();
    // ручки и фейды не вылезают за область, даже если её укоротили
    env.fadeIn = Math.min(env.fadeIn, dur);
    env.fadeOut = Math.min(env.fadeOut, dur - env.fadeIn);
    const pts = [];
    for (let i = 0; i <= STEPS; i++) {
      const x = i / STEPS;
      pts.push(`${(x * 100).toFixed(2)},${(100 - envelopeAt({ ...env, dur }, x * dur) * 92).toFixed(2)}`);
    }
    line.setAttribute('d', 'M' + pts.join('L'));
    fill.setAttribute('d', 'M0,100L' + pts.join('L') + 'L100,100Z');
    hIn.style.left = (env.fadeIn / dur) * 100 + '%';
    hOut.style.left = (1 - env.fadeOut / dur) * 100 + '%';
  }

  const drag = (handle, isIn) => {
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // иначе потащится вся область
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = el.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        const dur = len();
        // фейды по 0.01 с, вход и затухание не заходят друг на друга
        if (isIn) env.fadeIn = Math.round(Math.min(x * dur, dur - env.fadeOut) * 100) / 100;
        else env.fadeOut = Math.round(Math.min((1 - x) * dur, dur - env.fadeIn) * 100) / 100;
        redraw();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        onChange(env);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  };
  drag(hIn, true);
  drag(hOut, false);
  redraw();
  return { redraw };
}

// Прослушка в редакторе: звук волны идёт через GainNode, громкость которого
// каждые 20 мс ставится по огибающей (и гейну пэда). Так слышно ровно то, что будет в эфире.
let ctx;
export function previewer(ws) {
  ctx ||= new AudioContext();
  const gain = ctx.createGain();
  ctx.createMediaElementSource(ws.getMediaElement()).connect(gain).connect(ctx.destination);
  let timer;
  const stop = () => { clearInterval(timer); gain.gain.value = 1; };
  return {
    // from/to — кусок в секундах трека; env — огибающая; trim — множитель гейна
    play(from, to, env, trim = 1) {
      ctx.resume();
      stop();
      const dur = to - from;
      gain.gain.value = envelopeAt({ ...env, dur }, 0) * trim;
      ws.setTime(from);
      ws.play();
      timer = setInterval(() => {
        const t = ws.getCurrentTime() - from;
        if (!ws.isPlaying() || t >= dur) { if (t >= dur) ws.pause(); return stop(); }
        gain.gain.setTargetAtTime(envelopeAt({ ...env, dur }, t) * trim, ctx.currentTime, 0.01);
      }, 20);
    },
    stop,
  };
}
