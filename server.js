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
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const PAD_COUNT = 8;

// fadeIn/fadeOut — плавный вход и затухание пэда в секундах
const emptyPad = (n) => ({ name: `Пэд ${n}`, file: null, image: null, start: 0, end: null, fadeIn: 0, fadeOut: 0 });

const DEFAULT_SETTINGS = {
  // file — из music/samples, image — из music/images; start/end — обрезка в секундах (end: null = до конца)
  pads: Array.from({ length: PAD_COUNT }, (_, i) => emptyPad(i + 1)),
  bgCrossfade: 6,     // сек: перекрытие фоновых треков
  jingleDuration: 10, // сек: сколько играет отбивка от точки
  jingleFadeOut: 2,   // сек: затухание в конце отбивки и по «Стоп отбивки»
  bgStopFade: 3,      // сек: затухание фона по Pause/Stop
  duckLevel: 0.25,    // громкость фона, пока играет отбивка/пэд (0..1)
  masterVolume: 1,    // общая громкость программы (0..1)
  bgVolume: 0.8,      // громкость фоновой музыки (0..1)
  jingleTags: [],     // разделы отбивок: «хаус», «рок»…
  showJingleTags: false, // показывать переключатель разделов под кнопкой «Отбивка»
};

for (const c of CATEGORIES) fs.mkdirSync(path.join(MUSIC, c), { recursive: true });

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  // Переезд со старых 3 сэмплов на 8 пэдов
  if (saved.samples && !saved.pads) {
    saved.pads = saved.samples.map((s, i) => ({ ...emptyPad(i + 1), name: s.name, file: s.file }));
    delete saved.samples;
  }
  const pads = DEFAULT_SETTINGS.pads.map((p, i) => ({ ...p, ...(saved.pads || [])[i] }));
  return { ...DEFAULT_SETTINGS, ...saved, pads };
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

app.put('/api/cues/:track', (req, res) => {
  const track = path.basename(req.params.track);
  if (!jingleExists(track)) return res.status(404).json({ error: 'no track' });
  const cues = (req.body.cues || []).map(Number).filter((n) => n >= 0).sort((a, b) => a - b);
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
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
  const settings = { ...loadSettings(), ...req.body };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
