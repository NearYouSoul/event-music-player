// Event Music Player — локальный сервер.
// Раздаёт интерфейс, треки из music/, хранит точки и настройки,
// пересылает команды с телефона (пульт) на ноутбук (плеер) через WebSocket.
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const MUSIC = path.join(ROOT, 'music');
const CATEGORIES = ['background', 'jingles', 'samples', 'images'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];
// Все данные пользователя — в одной папке music/: звуки, картинки, разметка и настройки.
// Скопировал её на другой компьютер — переехало всё. Код (эта папка без music/) — отдельно.
const SETTINGS_FILE = path.join(MUSIC, 'settings.json');
const OLD_SETTINGS_FILE = path.join(ROOT, 'settings.json'); // где настройки лежали раньше
const TEXTURES = path.join(ROOT, 'public', 'textures');
const PAD_COUNT = 8;

// Пэд: file — из music/samples, image — из music/images; start/end — обрезка в секундах (end: null = до конца).
// fadeIn/fadeOut — вход и затухание (сек), curveIn/curveOut — их форма, gain — усиление в дБ,
// mode: oneshot — играет кусок целиком, loop — по кругу до повторного нажатия, hold — пока держишь.
const emptyPad = (n) => ({
  name: `Пэд ${n}`, file: null, image: null, start: 0, end: null,
  fadeIn: 0, fadeOut: 0, curveIn: 'linear', curveOut: 'linear', gain: 0, mode: 'oneshot',
});
const fillPads = (pads = []) => Array.from({ length: PAD_COUNT }, (_, i) => ({ ...emptyPad(i + 1), ...pads[i] }));

// Канальная линейка микшера (фон, отбивки, пэды, мастер). Описание — в public/mixer.js
const defaultStrip = (id) => ({
  eq: {
    on: false,
    bands: [
      { type: 'highpass', freq: 30, q: 0.71, gain: 0, on: false },
      { type: 'lowshelf', freq: 100, q: 0.71, gain: 0, on: true },
      { type: 'peaking', freq: 300, q: 1, gain: 0, on: true },
      { type: 'peaking', freq: 1000, q: 1, gain: 0, on: true },
      { type: 'peaking', freq: 3500, q: 1, gain: 0, on: true },
      { type: 'highshelf', freq: 10000, q: 0.71, gain: 0, on: true },
      { type: 'lowpass', freq: 18000, q: 0.71, gain: 0, on: false },
    ],
  },
  comp: { on: false, threshold: -18, ratio: 3, knee: 6, attack: 0.01, release: 0.25, makeup: 0 },
  ...(id === 'master' ? { limiter: { on: true, ceiling: -1, input: 0, release: 0.08 } } : {}),
});
const MIXER_IDS = ['bg', 'jingles', 'pads', 'master'];

const DEFAULT_SETTINGS = {
  banks: [{ name: 'A', pads: fillPads() }], // банки по 8 пэдов
  activeBank: 0,
  bgCrossfade: 6,     // сек: перекрытие фоновых треков
  jingleDuration: 10, // сек: сколько играет отбивка от точки (если у точки не задан свой конец)
  jingleFadeOut: 2,   // сек: затухание в конце отбивки и по «Стоп отбивки»
  bgStopFade: 3,      // сек: затухание фона по Pause/Stop
  duckLevel: 0.25,    // громкость фона, пока играет отбивка/пэд (0..1)
  masterVolume: 1,    // фейдеры каналов (0..1)
  bgVolume: 0.8,
  jingleVolume: 1,
  padVolume: 1,
  jingleTags: [],     // разделы отбивок: «хаус», «рок»…
  showJingleTags: false, // показывать переключатель разделов под кнопкой «Отбивка»
  // Фоновая музыка: теги (trackTags: трек -> [теги]), закладки и плейлисты (треки по порядку)
  bgLibrary: { tags: [], trackTags: {}, bookmarks: [], playlists: [] },
  bgSource: { type: 'all' }, // что играет фоном: all | tag | bookmarks | playlist (+ name)
  bgPlaylistPos: {},         // плейлист -> последний начатый трек: после Stop продолжаем со следующего
  mixer: Object.fromEntries(MIXER_IDS.map((id) => [id, defaultStrip(id)])),
  midi: {},           // назначения MIDI: действие -> { type: 'note'|'cc', channel, number }
};

for (const c of CATEGORIES) fs.mkdirSync(path.join(MUSIC, c), { recursive: true });
// Переезд: настройки из корня проекта — в music/
if (fs.existsSync(OLD_SETTINGS_FILE) && !fs.existsSync(SETTINGS_FILE)) fs.renameSync(OLD_SETTINGS_FILE, SETTINGS_FILE);

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  // Переезды старых файлов: 3 сэмпла -> 8 пэдов -> банки пэдов
  if (saved.samples && !saved.pads && !saved.banks) {
    saved.pads = saved.samples.map((s, i) => ({ ...emptyPad(i + 1), name: s.name, file: s.file }));
  }
  if (saved.pads && !saved.banks) saved.banks = [{ name: 'A', pads: saved.pads }];
  delete saved.samples;
  delete saved.pads;
  const banks = (saved.banks?.length ? saved.banks : DEFAULT_SETTINGS.banks)
    .map((b, i) => ({ name: b.name || String.fromCharCode(65 + i), pads: fillPads(b.pads) }));
  // Микшер: недостающие блоки берём из умолчаний (настройки могли сохраниться старой версией)
  const mixer = Object.fromEntries(MIXER_IDS.map((id) => {
    const def = defaultStrip(id);
    const m = saved.mixer?.[id] || {};
    return [id, { ...def, ...m, eq: { ...def.eq, ...m.eq }, comp: { ...def.comp, ...m.comp }, ...(def.limiter ? { limiter: { ...def.limiter, ...m.limiter } } : {}) }];
  }));
  const activeBank = Math.min(Math.max(0, saved.activeBank | 0), banks.length - 1);
  const bgLibrary = { ...DEFAULT_SETTINGS.bgLibrary, ...saved.bgLibrary };
  return { ...DEFAULT_SETTINGS, ...saved, banks, activeBank, mixer, bgLibrary };
}

// Через временный файл, как и разметку: сбой посреди записи не обнулит пэды и микшер
function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(settings, null, 2));
  fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE);
}

function listFiles(category, exts) {
  return fs.readdirSync(path.join(MUSIC, category))
    .filter((f) => exts.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}
const listAudio = (category) => listFiles(category, AUDIO_EXT);

// Файл точек лежит рядом с треком: "Track.mp3" -> "Track.json"
function cuesFile(track) {
  const base = path.basename(track, path.extname(track));
  return path.join(MUSIC, 'jingles', base + '.json');
}

// В файле рядом с треком: точки (cues) и разделы (tags)
function readMeta(track) {
  try {
    const m = JSON.parse(fs.readFileSync(cuesFile(track), 'utf8'));
    return { cues: m.cues || [], tags: m.tags || [] };
  } catch {
    return { cues: [], tags: [] };
  }
}

// Пишем через временный файл: при сбое посреди записи разметка не обнулится.
// Ни точек, ни разделов — нет файла (трек «не тронут»).
function writeMeta(track, { cues, tags }) {
  const file = cuesFile(track);
  if (!cues.length && !tags.length) return fs.rmSync(file, { force: true });
  const data = { track, cues };
  if (tags.length) data.tags = tags;
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// Точка отбивки: просто время старта (число) или объект со своими параметрами:
// { t, len, fadeIn, fadeOut, curveIn, curveOut } — всё, кроме t, необязательно (берётся из настроек)
const cueTime = (c) => (typeof c === 'number' ? c : c.t);
const CUE_NUM = ['len', 'fadeIn', 'fadeOut'];
const CUE_STR = ['curveIn', 'curveOut'];
function normalizeCue(c) {
  if (typeof c === 'number' || typeof c === 'string') return Number(c) >= 0 ? Number(c) : null;
  if (!c || !(Number(c.t) >= 0)) return null;
  const out = { t: Number(c.t) };
  for (const k of CUE_NUM) if (Number(c[k]) >= 0 && c[k] !== null && c[k] !== '') out[k] = Number(c[k]);
  for (const k of CUE_STR) if (typeof c[k] === 'string') out[k] = c[k];
  return Object.keys(out).length === 1 ? out.t : out; // без своих параметров — снова просто число
}

const jingleExists = (track) => fs.existsSync(path.join(MUSIC, 'jingles', track));

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // Приватные сети (раздача с телефона, домашний Wi-Fi) — первыми
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => isPrivate(b) - isPrivate(a));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/wavesurfer', express.static(path.join(ROOT, 'node_modules/wavesurfer.js/dist')));
app.get('/remote', (req, res) => res.sendFile(path.join(ROOT, 'public/remote.html')));

// express.static отдаёт файлы с поддержкой Range — нужно для перемотки
app.use('/media', express.static(MUSIC));

app.get('/api/library', (req, res) => {
  res.json({
    background: listAudio('background'),
    jingles: listAudio('jingles').map((name) => ({ name, ...readMeta(name) })),
    samples: listAudio('samples'),
    images: listFiles('images', IMAGE_EXT),
  });
});

// Текстуры оформления, которые положили в public/textures (необязательные)
app.get('/api/textures', (req, res) => {
  let files = [];
  try { files = fs.readdirSync(TEXTURES).filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase())); } catch {}
  res.json(files);
});

app.put('/api/cues/:track', (req, res) => {
  const track = path.basename(req.params.track);
  if (!jingleExists(track)) return res.status(404).json({ error: 'no track' });
  const cues = (req.body.cues || []).map(normalizeCue).filter(Boolean).sort((a, b) => cueTime(a) - cueTime(b));
  writeMeta(track, { ...readMeta(track), cues }); // разделы трека сохраняются как были
  res.json({ cues });
});

app.put('/api/tags/:track', (req, res) => {
  const track = path.basename(req.params.track);
  if (!jingleExists(track)) return res.status(404).json({ error: 'no track' });
  const tags = [...new Set((req.body.tags || []).map(String))];
  writeMeta(track, { ...readMeta(track), tags }); // точки трека сохраняются как были
  res.json({ tags });
});

// Удаление раздела: убираем его из списка и из всех треков (точки не трогаем)
app.delete('/api/tags/:tag', (req, res) => {
  const tag = req.params.tag;
  for (const track of listAudio('jingles')) {
    const meta = readMeta(track);
    if (meta.tags.includes(tag)) writeMeta(track, { ...meta, tags: meta.tags.filter((t) => t !== tag) });
  }
  const settings = loadSettings();
  settings.jingleTags = settings.jingleTags.filter((t) => t !== tag);
  writeSettings(settings);
  broadcast({ type: 'settings', settings });
  res.json(settings);
});

// Drag & drop на пэд: браузер шлёт файл как есть, имя — в заголовке
app.post('/api/upload/:kind', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  const kind = req.params.kind;
  const exts = { samples: AUDIO_EXT, images: IMAGE_EXT }[kind];
  const name = path.basename(decodeURIComponent(req.get('x-filename') || ''));
  if (!exts || !name || !exts.includes(path.extname(name).toLowerCase())) {
    return res.status(400).json({ error: 'Неподходящий тип файла' });
  }
  fs.writeFileSync(path.join(MUSIC, kind, name), req.body);
  res.json({ file: name });
});

app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.put('/api/settings', (req, res) => {
  writeSettings({ ...loadSettings(), ...req.body });
  const settings = loadSettings(); // с дозаполненными пэдами и микшером
  broadcast({ type: 'settings', settings });
  res.json(settings);
});

app.get('/api/qr', async (req, res) => {
  const urls = lanAddresses().map((ip) => `http://${ip}:${PORT}/remote`);
  const url = urls[0] || null;
  res.json({ url, urls, qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 320 }) : null });
});

// --- WebSocket: плеер (ноутбук) <-> пульты (телефоны) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let lastStatus = null;
let acceptRemotes = true; // ноутбук может заблокировать пульты

function broadcast(msg, role) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1 && (!role || c.role === role)) c.send(data);
  }
}

// count — открытые соединения (вкладки), devices — разные устройства (браузеры)
function remotesInfo() {
  const remotes = [...wss.clients].filter((c) => c.role === 'remote');
  const devices = new Set(remotes.map((c) => c.deviceId)).size;
  broadcast({ type: 'remotes', count: remotes.length, devices, accept: acceptRemotes }, 'player');
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      if (msg.role === 'remote' && !acceptRemotes) {
        ws.send(JSON.stringify({ type: 'rejected' }));
        return ws.close();
      }
      // Плеер может быть только один, иначе каждая команда с пульта играла бы
      // в двух вкладках. Нажатие «Начать эфир» (takeover) вытесняет прежний плеер;
      // простое переподключение старой вкладки эфир не отнимает.
      if (msg.role === 'player') {
        const others = [...wss.clients].filter((c) => c !== ws && c.role === 'player');
        if (others.length && !msg.takeover) {
          ws.send(JSON.stringify({ type: 'replaced' }));
          return ws.close();
        }
        for (const c of others) {
          c.role = null;
          c.send(JSON.stringify({ type: 'replaced' }));
          c.close();
        }
      }
      ws.role = msg.role;
      ws.deviceId = String(msg.deviceId || Math.random());
      // На одном телефоне живёт одна вкладка пульта: новая отключает прежние
      if (ws.role === 'remote') {
        for (const c of wss.clients) {
          if (c !== ws && c.role === 'remote' && c.deviceId === ws.deviceId) {
            c.role = null;
            c.send(JSON.stringify({ type: 'replaced' }));
            c.close();
          }
        }
      }
      if (ws.role === 'remote') ws.send(JSON.stringify(lastStatus || { type: 'status', offline: true }));
      remotesInfo();
    } else if (msg.type === 'cmd' && ws.role) {
      broadcast(msg, 'player');
    } else if (msg.type === 'status' && ws.role === 'player') {
      lastStatus = msg;
      broadcast(msg, 'remote');
    } else if (msg.type === 'acceptRemotes' && ws.role === 'player') {
      acceptRemotes = Boolean(msg.value);
      if (!acceptRemotes) {
        for (const c of wss.clients) {
          if (c.role === 'remote') { c.send(JSON.stringify({ type: 'rejected' })); c.close(); }
        }
      }
      remotesInfo();
    }
  });
  ws.on('close', () => {
    if (ws.role === 'player') { // вытесненный плеер сюда не попадает: у него role = null
      lastStatus = null;
      broadcast({ type: 'status', offline: true }, 'remote');
    }
    remotesInfo();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Event Music Player запущен`);
  console.log(`  Ноутбук:  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Пульт:    http://${ip}:${PORT}/remote`);
  console.log(`\n  Не закрывай это окно, пока идёт мероприятие.\n`);
});
