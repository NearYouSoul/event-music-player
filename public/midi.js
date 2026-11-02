// MIDI-контроллеры через Web MIDI API (Chrome/Edge, без драйверов и программ).
// Назначения хранятся в settings.midi: действие -> { type: 'note'|'cc', channel, number }.
// «Назначить» (MIDI Learn): следующее нажатие или поворот на контроллере становится привязкой.

export const MIDI_ACTIONS = [
  { id: 'jingle', name: 'Отбивка' },
  { id: 'jingleStop', name: 'Стоп отбивки' },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `pad:${i}`, name: `Пэд ${i + 1} (ячейка в текущем банке)` })),
  { id: 'bankPrev', name: 'Банк пэдов ←' },
  { id: 'bankNext', name: 'Банк пэдов →' },
  ...Array.from({ length: 4 }, (_, i) => ({ id: `bank:${i}`, name: `Банк ${i + 1}` })),
  { id: 'bgToggle', name: 'Фон play / pause' },
  { id: 'bgStop', name: 'Фон stop' },
  { id: 'bgNext', name: 'Фон: следующий трек' },
  { id: 'vol:master', name: 'Громкость Master', knob: true },
  { id: 'vol:bg', name: 'Громкость фона', knob: true },
  { id: 'vol:jingles', name: 'Громкость отбивок', knob: true },
  { id: 'vol:pads', name: 'Громкость пэдов', knob: true },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const describe = (b) => b.type === 'note'
  ? `Нота ${NOTE_NAMES[b.number % 12]}${Math.floor(b.number / 12) - 1} · канал ${b.channel + 1}`
  : `CC ${b.number} · канал ${b.channel + 1}`;

// Разбор сырого сообщения: нота вкл/выкл или контроллер (CC)
function parse(data) {
  const kind = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  if (kind === 0x90 || kind === 0x80) return { type: 'note', channel, number: data[1], on: kind === 0x90 && data[2] > 0 };
  if (kind === 0xb0) return { type: 'cc', channel, number: data[1], value: data[2] };
  return null;
}

export class Midi {
  // onAction(action, ev) — ev: { on } для кнопок, { value: 0..1 } для крутилок
  constructor(getBindings, onAction, onState) {
    this.getBindings = getBindings;
    this.onAction = onAction;
    this.onState = onState;
    this.access = null;
    this.learning = null;
    this.last = null;
  }

  static supported() { return !!navigator.requestMIDIAccess; }

  async start() {
    if (this.access) return;
    this.access = await navigator.requestMIDIAccess();
    const bind = () => {
      for (const input of this.access.inputs.values()) input.onmidimessage = (e) => this.message(e.data, input.name);
      this.onState();
    };
    this.access.onstatechange = bind;
    bind();
  }

  inputs() {
    return this.access ? [...this.access.inputs.values()].filter((i) => i.state === 'connected').map((i) => i.name) : [];
  }

  // Ждём следующее сообщение с контроллера; resolve(binding) или null при отмене
  learn(actionId) {
    this.cancelLearn();
    return new Promise((resolve) => (this.learning = { actionId, resolve }));
  }

  cancelLearn() {
    this.learning?.resolve(null);
    this.learning = null;
  }

  message(data, device) {
    const ev = parse(data);
    if (!ev) return;
    this.last = { ...ev, device };
    if (this.learning) {
      // отпускание ноты и «возврат» кнопки-CC в 0 не считаем — ждём нажатие
      if ((ev.type === 'note' && !ev.on) || (ev.type === 'cc' && ev.value === 0 && !this.isKnob(this.learning.actionId))) return;
      const { resolve } = this.learning;
      this.learning = null;
      resolve({ type: ev.type, channel: ev.channel, number: ev.number });
      this.onState();
      return;
    }
    this.onState();
    const bindings = this.getBindings();
    for (const [action, b] of Object.entries(bindings)) {
      if (!b || b.type !== ev.type || b.channel !== ev.channel || b.number !== ev.number) continue;
      if (this.isKnob(action)) {
        if (ev.type === 'cc') this.onAction(action, { value: ev.value / 127 });
      } else {
        // кнопки, присылающие CC (так часто делают контроллеры в MIDI-режиме): ≥ 64 — нажата
        this.onAction(action, { on: ev.type === 'note' ? ev.on : ev.value >= 64 });
      }
    }
  }

  isKnob(action) {
    return !!MIDI_ACTIONS.find((a) => a.id === action)?.knob;
  }
}
