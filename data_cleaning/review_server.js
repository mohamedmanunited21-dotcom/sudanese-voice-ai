'use strict';
// أداة مراجعة محلية: تسمع المقطع وتصحح نصه وتعتمده أو تحذفه. تحفظ تقدّمك تلقائيًا في reviewed.json (يمكنك الإغلاق والمتابعة لاحقًا).
//
//   node review_server.js --dataset-dir "G:/My Drive/Sudanese_Voice_Project/fine_tuning_dataset" --work-dir work
//   ثم افتح http://localhost:3100
//
// يستمع على 127.0.0.1 فقط.

const http = require('http');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DATASET_DIR = path.resolve(arg('dataset-dir', ''));
const WORK_DIR = path.resolve(arg('work-dir', 'work'));
const PORT = Number(arg('port', 3100));
const SHEET = path.join(WORK_DIR, 'review_sheet.json');
const REVIEWED = path.join(WORK_DIR, 'reviewed.json');

if (!arg('dataset-dir', '')) {
  console.error('مطلوب: --dataset-dir');
  process.exit(1);
}
if (!fs.existsSync(SHEET)) {
  console.error(`لم أجد ${SHEET}. شغّل clean_dataset.py أولًا.`);
  process.exit(1);
}

const items = JSON.parse(fs.readFileSync(SHEET, 'utf8'));
const itemById = new Map(items.map((it) => [it.id, it]));
let reviewed = {};
if (fs.existsSync(REVIEWED)) {
  try {
    reviewed = JSON.parse(fs.readFileSync(REVIEWED, 'utf8'));
  } catch (e) {
    console.error('reviewed.json تالف، انسخه جانبًا ثم احذفه:', e.message);
    process.exit(1);
  }
}

function persist() {
  const tmp = REVIEWED + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reviewed, null, 1), 'utf8');
  fs.renameSync(tmp, REVIEWED);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveAudio(req, res, item) {
  const full = path.resolve(DATASET_DIR, item.audio_file);
  if (!full.startsWith(DATASET_DIR + path.sep) || !fs.existsSync(full)) {
    res.writeHead(404);
    return res.end('missing');
  }
  const size = fs.statSync(full).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': size });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'review.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/items') {
      return sendJson(res, 200, { items, reviewed });
    }
    if (req.method === 'GET' && url.pathname === '/audio') {
      const item = itemById.get(url.searchParams.get('id'));
      if (!item) {
        res.writeHead(404);
        return res.end('unknown id');
      }
      return serveAudio(req, res, item);
    }
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const b = await readBody(req);
      if (!itemById.has(b.id)) return sendJson(res, 400, { ok: false, error: 'unknown id' });
      if (!['keep', 'drop', 'pending'].includes(b.status)) return sendJson(res, 400, { ok: false, error: 'bad status' });
      if (b.status === 'pending') delete reviewed[b.id];
      else reviewed[b.id] = { text: String(b.text || ''), status: b.status };
      persist();
      return sendJson(res, 200, { ok: true, counts: counts() });
    }
    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

function counts() {
  const v = Object.values(reviewed);
  return { total: items.length, keep: v.filter((x) => x.status === 'keep').length, drop: v.filter((x) => x.status === 'drop').length };
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`أداة المراجعة: http://localhost:${PORT}  (${items.length} مقطعًا، تقدّمك محفوظ في ${REVIEWED})`);
});
