// engine.js — job registry, queue scheduler, persistence, stats
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Job } from './job.js';
import { isValidHttpUrl, safeFilename } from './utils.js';

const MAX_HISTORY = 300;

export class Engine extends EventEmitter {
  constructor({ dataDir, settings }) {
    super();
    this.dataDir = dataDir;
    this.settings = settings;
    this.jobsFile = path.join(dataDir, 'jobs.json');
    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    this.sessionBytesAt = Date.now();
    this._persistTimer = null;
    this._emitTimer = null;
    this._dirty = false;
  }

  async init() {
    try {
      const raw = await fsp.readFile(this.jobsFile, 'utf8');
      const arr = JSON.parse(raw);
      for (const rec of arr) {
        try {
          const job = Job.fromJSON(this, rec);
          // anything mid-flight at shutdown → resumable 'paused'
          if (['queued', 'probing', 'downloading'].includes(job.status)) {
            job.status = 'paused';
            job.error = 'سرور ری‌استارت شد — برای ادامه دکمه «ادامه» را بزنید';
          }
          this.jobs.set(job.id, job);
        } catch { /* skip corrupt records */ }
      }
    } catch { /* first run */ }
    this.persistNow();
  }

  /* ---------------- job CRUD ---------------- */

  /**
   * @param {string} url
   * @param {object} opts {connections, speedLimit, filename, dir, retries, headers}
   */
  add(url, opts = {}) {
    if (!isValidHttpUrl(url)) {
      throw Object.assign(new Error('لینک نامعتبر است (فقط http/https)'), { statusCode: 400 });
    }
    const s = this.settings.get();
    const dir = opts.dir && path.isAbsolute(opts.dir) ? opts.dir : s.downloadsDir;
    const headers = {};
    if (opts.headers?.userAgent) headers['user-agent'] = String(opts.headers.userAgent).slice(0, 512);
    if (opts.headers?.referer) headers.referer = String(opts.headers.referer).slice(0, 1024);
    const job = new Job(this, {
      url,
      dir,
      filename: opts.filename ? safeFilename(opts.filename) : null,
      connections: opts.connections ?? s.defaultConnections,
      speedLimit: bytesPerSec(opts.speedLimit) ?? 0,
      retries: opts.retries ?? s.defaultRetries,
      headers,
    });
    this.jobs.set(job.id, job);
    this.persistNow();
    this.emitUpdate();
    this.schedule();
    return job;
  }

  get(id) { return this.jobs.get(id); }

  pause(id) {
    const j = this.jobs.get(id);
    if (!j) throw notFound();
    if (!j.pause()) throw Object.assign(new Error('این دانلود قابل توقف نیست'), { statusCode: 409 });
    return j;
  }

  resume(id) {
    const j = this.jobs.get(id);
    if (!j) throw notFound();
    if (!j.resume()) throw Object.assign(new Error('این دانلود قابل ادامه نیست'), { statusCode: 409 });
    return j;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) throw notFound();
    j.cancel();
    return j;
  }

  retry(id) { return this.resume(id); }

  async restart(id) {
    const j = this.jobs.get(id);
    if (!j) throw notFound();
    await j.restart();
    return j;
  }

  async remove(id, { deleteFile = false } = {}) {
    const j = this.jobs.get(id);
    if (!j) throw notFound();
    if (['downloading', 'probing'].includes(j.status)) j.cancel();
    if (deleteFile) {
      const p = j.status === 'completed' ? j.finalPath : j.partPath;
      if (p) { try { await fsp.rm(p, { force: true }); } catch { /* ignore */ } }
      try { await fsp.rm(j.finalPath, { force: true }); } catch { /* ignore */ }
    }
    this.jobs.delete(id);
    this.persistNow();
    this.emitUpdate();
    this.schedule();
    return { ok: true };
  }

  /* ---------------- scheduler ---------------- */

  activeCount() {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'downloading' || j.status === 'probing') n++;
    return n;
  }

  schedule() {
    const s = this.settings.get();
    if (!s.autoStartQueue) return;
    const max = s.maxConcurrent;
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const j of queued) {
      if (this.activeCount() >= max) break;
      j.start().catch(() => { /* handled inside start() */ });
    }
  }

  /* ---------------- stats / serialization ---------------- */

  stats() {
    let active = 0, queued = 0, done = 0, totalSpeed = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'downloading' || j.status === 'probing') { active++; totalSpeed += j.speed; }
      else if (j.status === 'queued') queued++;
      else if (j.status === 'completed') done++;
    }
    return { active, queued, done, totalSpeed, uptimeMs: Date.now() - this.sessionBytesAt, jobs: this.jobs.size };
  }

  snapshot() {
    return {
      jobs: [...this.jobs.values()].map((j) => j.serialize()),
      stats: this.stats(),
    };
  }

  /* ---------------- events + persistence ---------------- */

  emitUpdate() {
    this._dirty = true;
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      if (!this._dirty) return;
      this._dirty = false;
      this.emit('update', this.snapshot());
    }, 250);
  }

  persistSoon() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.persistNow(); }, 500);
  }

  async persistNow() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    // serialize disk writes (concurrent atomic renames would collide on the tmp file)
    this._persistChain = (this._persistChain || Promise.resolve())
      .then(() => this._writeJobs())
      .catch((err) => console.error('[engine] persist failed:', err.message));
    return this._persistChain;
  }

  async _writeJobs() {
    const arr = [...this.jobs.values()].map((j) => j.toJSON()).slice(-MAX_HISTORY);
    const tmp = this.jobsFile + '.tmp';
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(arr));
    await fsp.rename(tmp, this.jobsFile);
  }

  shutdown() {
    for (const j of this.jobs.values()) {
      if (j.status === 'downloading' || j.status === 'probing') {
        j.pause(); // flush a consistent paused state to disk
      }
    }
    this.persistNow();
  }
}

function notFound() {
  return Object.assign(new Error('دانلودی با این شناسه یافت نشد'), { statusCode: 404 });
}

/** accepts number (bytes/s) or "2MB/s" style strings → bytes/sec */
function bytesPerSec(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const m = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*\/?\s*s?/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'mb').toLowerCase();
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
  if (!Number.isFinite(n) || !mult) return null;
  return Math.max(0, Math.round(n * mult));
}
