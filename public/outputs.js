// Куда идёт звук. Две «линии»:
//   air — эфир: всё, что звучит на мероприятии (движок: фон, отбивки, пэды, микшер);
//   cue — прослушка: волны во вкладках «Фон», «Разметка отбивок», «Пэды» (наушники ведущего).
// Звук отправляется на устройство через setSinkId (Chrome / Edge) — у AudioContext и у <audio>.
// Выбор хранится в браузере этого компьютера: звуковые карты у каждого компьютера свои.
// Устройство ищется по id, а если id сменился — по названию; не нашлось — звук идёт на системное.

const KEY = 'emp-outputs';
export const ROLES = { air: 'Эфир', cue: 'Прослушка' };
export const canRoute = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

let chosen = { air: { id: '', label: '' }, cue: { id: '', label: '' } };
try { chosen = { ...chosen, ...JSON.parse(localStorage.getItem(KEY)) }; } catch {}

const targets = { air: [], cue: [] }; // WeakRef на AudioContext и <audio>, которые звучат по этой линии
const listeners = new Set();
export const state = { air: null, cue: null }; // { label, missing } — куда звук идёт сейчас

export const chosenOf = (role) => chosen[role];
export const onChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

// Устройства вывода. Без разрешения браузер прячет их названия — ask=true просит доступ
// к микрофону (сам микрофон не используется: поток сразу закрывается).
export async function devices(ask = false) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  if (ask) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  }
  return (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audiooutput' && d.deviceId && !['default', 'communications'].includes(d.deviceId));
}

// Какой id отдать в setSinkId: '' — системное устройство по умолчанию
async function resolve(role) {
  const c = chosen[role];
  if (!c.id) return { id: '', label: '', missing: false };
  const list = await devices();
  const dev = list.find((d) => d.deviceId === c.id) || list.find((d) => d.label && d.label === c.label);
  return dev ? { id: dev.deviceId, label: dev.label || c.label, missing: false } : { id: '', label: c.label, missing: true };
}

async function apply(role) {
  const r = await resolve(role);
  state[role] = r;
  targets[role] = targets[role].filter((w) => w.deref());
  for (const w of targets[role]) {
    const t = w.deref();
    try { if (t.sinkId !== r.id) await t.setSinkId(r.id); } catch (e) { r.error = e.message; }
  }
  notify();
  return r;
}

// Подключить AudioContext или <audio> к линии; возвращает, куда пошёл звук
export function route(role, target) {
  if (!canRoute || !target?.setSinkId) return Promise.resolve(null);
  targets[role].push(new WeakRef(target));
  return apply(role);
}

export function choose(role, dev) {
  chosen[role] = dev ? { id: dev.deviceId, label: dev.label } : { id: '', label: '' };
  try { localStorage.setItem(KEY, JSON.stringify(chosen)); } catch {}
  return apply(role);
}

// Короткий сигнал на выбранное устройство линии — проверить, туда ли идёт звук
export async function beep(role) {
  const { id } = await resolve(role);
  const ctx = new AudioContext();
  if (id) await ctx.setSinkId(id);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = role === 'air' ? 880 : 660;
  g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.02);
  g.gain.setValueAtTime(0.2, ctx.currentTime + 0.35);
  g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.45);
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.5);
  osc.onended = () => ctx.close();
}

// Подключили или выдернули устройство (Bluetooth отвалился и вернулся) — переназначаем обе линии
navigator.mediaDevices?.addEventListener?.('devicechange', () => { apply('air'); apply('cue'); });
