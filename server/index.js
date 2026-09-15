// index.js — zero-dependency HTTP server: REST API + SSE + static frontend
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';
import { Settings } from './settings.js';
import { readJson, sendJson, mimeOf, parseContentRange, filenameFromDisposition, filenameFromURL, isValidHttpUrl } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ---------- boot ---------- */
const settings = new Settings(DATA_DIR);
await settings.init(path.join(ROOT, 'downloads'));
const engine = new Engine({ dataDir: DATA_DIR, settings });
await engine.init();

/* ---------- SSE clients ---------- */
const sseClients = new Set();

function sseSend(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ }
}

function broadcast(obj) {
  for (const res of sseClients) sseSend(res, obj);
}

engine.on('update', (snap) => broadcast({ type: 'snapshot', ...snap }));

/* ---------- helpers ---------- */

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

/** allowed roots for the file browser */
function allowedRoots() {
  return [homedir(), ROOT].filter((p, i, a) => a.indexOf(p) === i);
}

function insideAllowed(p) {
  const resolved = path.resolve(p);
  return allowedRoots().some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

async function serveFile(req, res, filePath, { downloadName, inline = false }) {
  const st = await fsp.stat(filePath);
  const headers = {
    'content-type': mimeOf(filePath),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(downloadName || path.basename(filePath))}`,
  };
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (!m[1] && m[2]) { start = st.size - Number(m[2]); end = st.size - 1; } // suffix range
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['content-length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

/** lightweight URL probe without creating a job */
async function probeUrl(url, headers = {}) {
  const h = {};
  if (headers.userAgent) h['user-agent'] = String(headers.userAgent).slice(0, 512);
  if (headers.referer) h.referer = String(headers.referer).slice(0, 1024);
  let res = null;
  try {
    res = await fetch(url, { method: 'HEAD', headers: h, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  } catch { res = null; }
  if (res && res.ok) {
    return {
      ok: true,
      totalBytes: Number(res.headers.get('content-length')) || null,
      contentType: res.headers.get('content-type')?.split(';')[0] || null,
      acceptRanges: /^bytes/i.test(res.headers.get('accept-ranges') || ''),
      suggestedName: filenameFromDisposition(res.headers.get('content-disposition')) || filenameFromURL(url) || null,
      finalUrl: res.url || url,
    };
  }
  const r = await fetch(url, { headers: { ...h, range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  if (!r.ok && r.status !== 206) {
    const err = new Error(`سرور پاسخ داد: HTTP ${r.status}`);
    err.statusCode = 502;
    try { await r.body?.cancel(); } catch {}
    throw err;
  }
  const info = {
    ok: true,
    totalBytes: r.status === 206 ? (parseContentRange(r.headers.get('content-range')) || Number(r.headers.get('content-length')) || null) : (Number(r.headers.get('content-length')) || null),
    contentType: r.headers.get('content-type')?.split(';')[0] || null,
    acceptRanges: r.status === 206,
    suggestedName: filenameFromDisposition(r.headers.get('content-disposition')) || filenameFromURL(url) || null,
    finalUrl: r.url || url,
  };
  try { await r.body?.cancel(); } catch {}
  return info;
}

/* ---------- router ---------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      cors(res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return await api(req, res, u, p);
    }
    return staticReq(req, res, u);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error(`[http] ${req.method} ${p} →`, err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || 'خطای داخلی سرور' });
    else try { res.end(); } catch {}
  }
});

async function api(req, res, u, p) {
  /* ---- health / version ---- */
  if (p === '/api/health' || p === '/api/version') {
    return sendJson(res, 200, { ok: true, version: pkg.version, node: process.version, uptime: Math.round(process.uptime()) });
  }

  /* ---- SSE stream ---- */
  if (p === '/api/events') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'متد مجاز نیست' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    sseSend(res, { type: 'snapshot', ...engine.snapshot() });
    sseSend(res, { type: 'settings', settings: settings.get() });
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  /* ---- probe a URL ---- */
  if (p === '/api/probe' && req.method === 'POST') {
    const body = await readJson(req);
    if (!isValidHttpUrl(body.url)) return sendJson(res, 400, { ok: false, error: 'لینک نامعتبر است' });
    const info = await probeUrl(body.url, body.headers || {});
    return sendJson(res, 200, { ok: true, ...info });
  }

  /* ---- settings ---- */
  if (p === '/api/settings') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, settings: settings.get() });
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJson(req);
      const updated = await settings.update(body);
      broadcast({ type: 'settings', settings: updated });
      if (updated.maxConcurrent !== undefined) engine.schedule();
      return sendJson(res, 200, { ok: true, settings: updated });
    }
  }

  /* ---- filesystem browser ---- */
  if (p === '/api/fs' && req.method === 'GET') {
    let dir = u.searchParams.get('path') || settings.get().downloadsDir;
    dir = path.resolve(dir);
    if (!insideAllowed(dir)) return sendJson(res, 400, { ok: false, error: 'مسیر خارج از محیط مجاز است' });
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return sendJson(res, 400, { ok: false, error: 'پوشه قابل خواندن نیست' }); }
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.workspace') continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = (await fsp.stat(full)).isDirectory(); } catch {}
      }
      if (isDir) dirs.push({ name: e.name, path: full });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    const parent = path.dirname(dir);
    return sendJson(res, 200, {
      ok: true,
      path: dir,
      parent: parent !== dir && insideAllowed(parent) ? parent : null,
      isRoot: !insideAllowed(parent) || parent === dir,
      dirs,
      isDefault: dir === settings.get().downloadsDir,
    });
  }

  if (p === '/api/fs/mkdir' && req.method === 'POST') {
    const body = await readJson(req);
    const base = path.resolve(body.path || settings.get().downloadsDir);
    const name = String(body.name || '').replace(/[/\\]/g, '').trim();
    if (!name) return sendJson(res, 400, { ok: false, error: 'نام پوشه نامعتبر است' });
    const target = path.join(base, name);
    if (!insideAllowed(target)) return sendJson(res, 400, { ok: false, error: 'مسیر خارج از محیط مجاز است' });
    await fsp.mkdir(target, { recursive: true });
    return sendJson(res, 200, { ok: true, path: target });
  }

  /* ---- downloads collection ---- */
  if (p === '/api/downloads') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...engine.snapshot() });
    if (req.method === 'POST') {
      const body = await readJson(req);
      const urls = Array.isArray(body.urls) ? body.urls : [body.url];
      const opts = body.options || {};
      const created = [];
      const errors = [];
      for (const raw of urls) {
        const url = String(raw || '').trim();
        if (!url) continue;
        try { created.push(engine.add(url, opts).serialize()); }
        catch (err) { errors.push({ url, error: err.message }); }
      }
      if (!created.length) {
        return sendJson(res, errors.length ? 400 : 400, { ok: false, error: errors[0]?.error || 'لینکی وارد نشده است', errors });
      }
      return sendJson(res, 201, { ok: true, jobs: created, errors });
    }
  }

  /* ---- download item ---- */
  let m = /^\/api\/downloads\/([A-Za-z0-9_-]+)(\/file)?$/.exec(p);
  if (m) {
    const job = engine.get(m[1]);
    const isFile = !!m[2];
    if (!job) return sendJson(res, 404, { ok: false, error: 'دانلودی با این شناسه یافت نشد' });

    if (isFile) {
      if (job.status !== 'completed' || !job.finalPath) {
        return sendJson(res, 409, { ok: false, error: 'فایل هنوز آماده نیست' });
      }
      try { return await serveFile(req, res, job.finalPath, { downloadName: job.filename, inline: u.searchParams.get('inline') === '1' }); }
      catch { return sendJson(res, 404, { ok: false, error: 'فایل روی دیسک یافت نشد' }); }
    }

    if (req.method === 'GET') return sendJson(res, 200, { ok: true, job: job.serialize() });

    if (req.method === 'DELETE') {
      const del = u.searchParams.get('file') === '1';
      const out = await engine.remove(job.id, { deleteFile: del });
      return sendJson(res, 200, { ok: true, ...out });
    }

    if (req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const action = (u.searchParams.get('action') || body.action || '').toLowerCase();
      switch (action) {
        case 'pause': engine.pause(job.id); break;
        case 'resume': case 'retry': engine.resume(job.id); break;
        case 'cancel': engine.cancel(job.id); break;
        case 'restart': await engine.restart(job.id); break;
        default:
          return sendJson(res, 400, { ok: false, error: 'اکشن نامعتبر است (pause|resume|cancel|restart)' });
      }
      engine.emitUpdate();
      return sendJson(res, 200, { ok: true, job: job.serialize() });
    }
  }

  sendJson(res, 404, { ok: false, error: 'مسیر API یافت نشد' });
}

/* ---------- static frontend ---------- */

async function staticReq(req, res, u) {
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  }
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('not a file');
    return serveFile(req, res, file, { inline: true });
  } catch {
    sendJson(res, 404, { ok: false, error: 'یافت نشد' });
  }
}

/* ---------- start ---------- */

server.listen(PORT, HOST, () => {
  console.log(`\n  ⚡ AutoDownloader v${pkg.version}`);
  console.log(`  ▸ listening:   http://${HOST}:${PORT}`);
  console.log(`  ▸ save folder: ${settings.get().downloadsDir}`);
  console.log(`  ▸ engine:      multi-connection (up to 32×), zero-dependency\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — flushing state…`);
    engine.shutdown();
    setTimeout(() => process.exit(0), 300);
  });
}
