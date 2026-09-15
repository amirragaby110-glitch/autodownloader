// job.js — a single multi-connection download job (aria2/IDM style)
//
// Strategy for speed:
//  • probe the server once (HEAD, fallback to a 1-byte ranged GET)
//  • split the file into N small chunks (N ≈ connections × 8, ≥ 512 KiB each)
//  • run `connections` parallel workers; each pulls the next pending chunk
//    (dynamic load-balancing — fast workers simply get more chunks)
//  • every worker writes directly at its chunk offset in the .part file
//    (positional pwrite) → zero merge/concatenation phase, zero extra disk IO
//  • per-chunk retry with exponential backoff, resumable at byte granularity
//  • optional token-bucket speed limiter shared by all workers of the job

import fsp from 'node:fs/promises';
import path from 'node:path';
import { uid, parseContentRange, filenameFromDisposition, filenameFromURL, safeFilename, uniquePath, sleep, clamp, MB } from './utils.js';

const MIN_CHUNK = 512 * 1024;      // never split finer than 512 KiB
const MAX_CHUNKS = 2048;
const STALL_TIMEOUT_MS = 25_000;   // no data for 25s → kill that connection and retry
const SPEED_EMA = 0.35;

const FA_ERRORS = {
  ENOTFOUND: 'آدرس سرور پیدا نشد (DNS)',
  ECONNREFUSED: 'سرور اتصال را رد کرد',
  ECONNRESET: 'اتصال توسط سرور قطع شد',
  ETIMEDOUT: 'مهلت اتصال تمام شد',
  CERT_HAS_EXPIRED: 'گواهی SSL سرور منقضی شده است',
  UND_ERR_SOCKET: 'خطای سوکت شبکه',
};

export class Job {
  constructor(engine, o = {}) {
    this.engine = engine;
    // ---- identity / options ----
    this.id = o.id || uid(12);
    this.url = o.url;
    this.filename = o.filename || null;      // resolved during probe if null
    this.dir = o.dir;                        // absolute download dir
    this.connections = clamp(o.connections ?? 8, 1, 32);
    this.speedLimit = Math.max(0, o.speedLimit ?? 0);   // bytes/sec, 0 = unlimited
    this.retries = Math.max(0, o.retries ?? 5);
    this.headers = { ...(o.headers || {}) };  // { 'user-agent': ..., referer: ... }
    // ---- remote facts (filled by probe) ----
    this.totalBytes = o.totalBytes ?? null;
    this.contentType = o.contentType ?? null;
    this.etag = o.etag ?? null;
    this.lastModified = o.lastModified ?? null;
    this.supportsRange = o.supportsRange ?? null;
    // ---- state ----
    this.status = o.status || 'queued';      // queued|probing|downloading|paused|completed|failed|canceled
    this.error = o.error || null;
    this.finalPath = o.finalPath || null;
    this.partPath = o.partPath || null;
    this.chunks = (o.chunks || []).map((c) => ({ start: c[0], end: c[1], progress: c[2] || 0, done: !!c[3] }));
    this.streamBytes = o.streamBytes || 0;   // single-stream mode byte count
    this.createdAt = o.createdAt || Date.now();
    this.startedAt = o.startedAt || null;
    this.completedAt = o.completedAt || null;
    // ---- runtime (not persisted) ----
    this.abortCtrl = null;
    this.abortReason = null;
    this.fatalError = null;
    this.limiter = null;
    this.workers = [];
    this.speed = 0;
    this.peakSpeed = 0;
    this._lastSampleAt = 0;
    this._lastSampleBytes = 0;
    this._persistTimer = null;
  }

  /* ===================== serialization ===================== */

  static fromJSON(engine, rec) {
    return new Job(engine, rec);
  }

  toJSON() {
    return {
      id: this.id, url: this.url, filename: this.filename, dir: this.dir,
      connections: this.connections, speedLimit: this.speedLimit, retries: this.retries,
      headers: this.headers, totalBytes: this.totalBytes, contentType: this.contentType,
      etag: this.etag, lastModified: this.lastModified, supportsRange: this.supportsRange,
      status: this.status, error: this.error, finalPath: this.finalPath, partPath: this.partPath,
      chunks: this.chunks.map((c) => [c.start, c.end, c.progress, c.done ? 1 : 0]),
      streamBytes: this.streamBytes,
      createdAt: this.createdAt, startedAt: this.startedAt, completedAt: this.completedAt,
    };
  }

  get received() {
    if (!this.chunks.length) return this.streamBytes;
    let n = 0;
    for (const c of this.chunks) n += c.done ? c.end - c.start + 1 : c.progress;
    return n;
  }

  get progress() {
    if (!this.totalBytes) return null;
    return clamp(this.received / this.totalBytes, 0, 1);
  }

  get activeConnections() {
    return this.workers.filter((w) => w.active).length;
  }

  get resumable() {
    return !!(this.supportsRange && this.totalBytes && this.chunks.length);
  }

  /** compact shape sent to the browser */
  serialize() {
    return {
      id: this.id, url: this.url, filename: this.filename, dir: this.dir,
      status: this.status, error: this.error,
      totalBytes: this.totalBytes, received: this.received, progress: this.progress,
      speed: this.speed, peakSpeed: this.peakSpeed, eta: this.eta(),
      connections: this.connections, activeConnections: this.activeConnections,
      speedLimit: this.speedLimit, retries: this.retries,
      contentType: this.contentType, supportsRange: this.supportsRange,
      resumable: this.resumable,
      createdAt: this.createdAt, startedAt: this.startedAt, completedAt: this.completedAt,
      filePath: this.status === 'completed' ? this.finalPath : null,
      workers: this.workers.map((w) => ({
        id: w.id, active: w.active,
        chunk: w.chunkIndex, from: w.from, to: w.to, at: w.at, pct: w.pct,
      })),
      chunkCount: this.chunks.length,
      doneChunks: this.chunks.filter((c) => c.done).length,
    };
  }

  eta() {
    if (!this.totalBytes || this.speed <= 1 || this.status !== 'downloading') return null;
    return Math.max(0, Math.round((this.totalBytes - this.received) / this.speed));
  }

  touch(persistNow = false) {
    if (persistNow) this.engine.persistNow();
    else this.engine.persistSoon();
    this.engine.emitUpdate();
  }

  /* ===================== lifecycle ===================== */

  async start() {
    if (this.status !== 'queued') return;
    this.error = null;
    this.status = 'probing';
    this.abortReason = null;
    this.abortCtrl = new AbortController();
    this.touch(true);
    try {
      if (!this.finalPath) await this.probe();
      await this.ensurePartFile();
      if (!this.chunks.length) this.planChunks();
      await this.run();
    } catch (err) {
      if (this.abortReason === 'pause') {
        this.status = 'paused';
      } else if (this.abortReason === 'cancel') {
        await this.cleanupPart();
        this.status = 'canceled';
      } else {
        this.status = 'failed';
        this.error = humanError(err);
      }
    } finally {
      this.workers = [];
      this.speed = 0;
      this.touch(true);
      this.engine.schedule();
    }
  }

  pause() {
    if (this.status !== 'downloading' && this.status !== 'probing') return false;
    this.abortReason = 'pause';
    this.abortCtrl?.abort(new Error('pause'));
    return true;
  }

  /** requeue for download (keeps chunk progress when possible) */
  resume() {
    if (!['paused', 'failed'].includes(this.status)) return false;
    if (this.status === 'failed') this.error = null;
    this.status = 'queued';
    this.touch(true);
    this.engine.schedule();
    return true;
  }

  cancel() {
    if (this.status === 'completed') return false;
    if (this.status === 'downloading' || this.status === 'probing') {
      this.abortReason = 'cancel';
      this.abortCtrl?.abort(new Error('cancel'));
      return true; // cleanup happens in start()'s catch/finally
    }
    this.status = 'canceled';
    this.cleanupPart();
    this.touch(true);
    return true;
  }

  /** wipe progress and requeue from scratch */
  async restart() {
    this.abortReason = 'cancel';
    this.abortCtrl?.abort(new Error('cancel'));
    await sleep(50);
    await this.cleanupPart();
    this.chunks = [];
    this.streamBytes = 0;
    this.totalBytes = this.supportsRange === false ? null : this.totalBytes;
    this.error = null;
    this.status = 'queued';
    this.touch(true);
    this.engine.schedule();
  }

  async cleanupPart() {
    try { await fsp.rm(this.partPath, { force: true }); } catch { /* ignore */ }
  }

  /* ===================== probe ===================== */

  async probe() {
    const base = { ...this.headers };
    let res = null;
    try {
      res = await fetch(this.url, {
        method: 'HEAD', headers: base, redirect: 'follow',
        signal: AbortSignal.any([this.abortCtrl.signal, AbortSignal.timeout(this.engine.settings.get().connectTimeoutMs)]),
      });
    } catch { res = null; }

    let size = res ? Number(res.headers.get('content-length')) : null;
    let acceptRanges = res ? /^bytes/i.test(res.headers.get('accept-ranges') || '') : false;
    const hdrs = (r) => ({
      type: r.headers.get('content-type'),
      etag: r.headers.get('etag'),
      lm: r.headers.get('last-modified'),
      cd: r.headers.get('content-disposition'),
    });
    let info = res ? hdrs(res) : {};

    if (!res || !res.ok || !size || !acceptRanges) {
      // definitive check: a 1-byte ranged GET
      const r = await fetch(this.url, {
        headers: { ...base, range: 'bytes=0-0' }, redirect: 'follow',
        signal: AbortSignal.any([this.abortCtrl.signal, AbortSignal.timeout(this.engine.settings.get().connectTimeoutMs)]),
      });
      if (!r.ok && r.status !== 206) {
        if (r.status === 405 || r.status === 501) throw httpErr(r.status);
        throw httpErr(r.status);
      }
      if (r.status === 206) {
        acceptRanges = true;
        size = parseContentRange(r.headers.get('content-range')) ?? size;
        info = hdrs(r);
      } else {
        acceptRanges = false;
        size = Number(r.headers.get('content-length')) || null;
        info = hdrs(r);
      }
      try { await r.body?.cancel(); } catch { /* ignore */ }
    }

    this.totalBytes = size && Number.isFinite(size) ? size : null;
    this.supportsRange = acceptRanges && !!this.totalBytes;
    this.contentType = info.type ? info.type.split(';')[0] : null;
    this.etag = info.etag || null;
    this.lastModified = info.lm || null;

    if (!this.filename) {
      this.filename =
        filenameFromDisposition(info.cd) ||
        filenameFromURL(this.url) ||
        `download-${new Date().toISOString().slice(0, 10)}.bin`;
    }
    const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
    this.finalPath = await uniquePath(this.dir, this.filename, exists);
    this.partPath = this.finalPath + '.part';
    this.touch(true);
  }

  async ensurePartFile() {
    if (this.resumable) {
      try {
        const st = await fsp.stat(this.partPath);
        if (st.size !== this.totalBytes) {
          // part file mismatch → wipe progress
          this.chunks = [];
          await fsp.rm(this.partPath, { force: true });
        }
      } catch {
        this.chunks = []; // part file gone → wipe progress
      }
    }
    if (!this.chunks.length) {
      const fh = await fsp.open(this.partPath, 'w');
      await fh.close();
      if (this.totalBytes) {
        try { await fsp.truncate(this.partPath, this.totalBytes); } catch { /* sparse file unsupported? fine */ }
      }
      if (this.totalBytes && !this.supportsRange) this.streamBytes = 0;
    }
  }

  planChunks() {
    if (!this.totalBytes || !this.supportsRange) return;   // single-stream mode
    const conns = clamp(this.connections, 1, 32);
    let count = clamp(conns * 8, conns, MAX_CHUNKS);
    if (this.totalBytes / count < MIN_CHUNK) {
      count = Math.max(1, Math.floor(this.totalBytes / MIN_CHUNK));
    }
    count = Math.min(count, this.totalBytes, MAX_CHUNKS);
    const size = Math.ceil(this.totalBytes / count);
    this.chunks = [];
    for (let i = 0; ; i++) {
      const start = i * size;
      if (start >= this.totalBytes) break;
      this.chunks.push({ start, end: Math.min(start + size, this.totalBytes) - 1, progress: 0, done: false });
    }
  }

  /** validate the remote file still matches what we partially downloaded */
  async validateRemote() {
    if (!this.engine.settings.get().validateOnResume) return true;
    if (!this.etag && !this.lastModified) return true;
    try {
      const res = await fetch(this.url, {
        method: 'HEAD', headers: { ...this.headers }, redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return true; // can't tell → optimistic
      const etag = res.headers.get('etag');
      const lm = res.headers.get('last-modified');
      if ((this.etag && etag && this.etag !== etag) || (!this.etag && this.lastModified && lm && this.lastModified !== lm)) {
        return false; // file changed on the server
      }
      return true;
    } catch { return true; }
  }

  /* ===================== the run loop ===================== */

  async run() {
    // resume validation
    if (this.chunks.some((c) => c.progress > 0 && !c.done) || this.chunks.some((c) => c.done)) {
      const ok = await this.validateRemote();
      if (!ok) {
        this.chunks = [];
        await fsp.rm(this.partPath, { force: true });
        this.planChunks();
        await this.ensurePartFile();
      }
    }

    this.status = 'downloading';
    this.startedAt ||= Date.now();
    this.abortReason = null;
    this.fatalError = null;
    this.abortCtrl = new AbortController();
    this.limiter = new Limiter(this.speedLimit);
    this._lastSampleAt = Date.now();
    this._lastSampleBytes = this.received;

    const speedTimer = setInterval(() => this.sampleSpeed(), 500);
    const stallTimer = setInterval(() => this.checkStalls(), 5_000);

    try {
      if (this.chunks.length) {
        const n = clamp(this.connections, 1, 32);
        this.workers = Array.from({ length: n }, (_, i) => ({
          id: i, active: false, chunkIndex: -1, from: 0, to: 0, at: 0, pct: 0,
          bytes: 0, lastDataAt: Date.now(), curCtrl: null,
        }));
        const results = await Promise.allSettled(this.workers.map((w) => this.workerLoop(w)));
        const fatal = results.find((r) => r.status === 'rejected' && !(r.reason instanceof PausedError));
        if (fatal) throw fatal.reason;
        if (this.abortReason === 'pause') throw new PausedError();
        if (this.abortReason === 'cancel') throw new CanceledError();
        if (!this.chunks.every((c) => c.done)) {
          throw new Error('دانلود ناقص ماند — دوباره تلاش کنید');
        }
      } else {
        await this.singleStream();
      }
      await this.complete();
    } finally {
      clearInterval(speedTimer);
      clearInterval(stallTimer);
    }
  }

  async workerLoop(w) {
    while (this.status === 'downloading' && !this.fatalError) {
      const idx = this.chunks.findIndex((c) => !c.done && !c.claimed);
      if (idx === -1) break;
      const chunk = this.chunks[idx];
      chunk.claimed = true;
      w.active = true;
      w.chunkIndex = idx; w.from = chunk.start + chunk.progress; w.to = chunk.end; w.at = w.from; w.pct = 0;
      try {
        await this.fetchChunk(chunk, w);
        chunk.done = true;
        w.active = false;
        this.persistSoonLocal();
        this.engine.emitUpdate();
      } catch (err) {
        chunk.claimed = false;
        w.active = false;
        if (err instanceof PausedError || err instanceof CanceledError || this.abortReason) {
          // keep already-buffered bytes on pause (chunk.progress stays disk-accurate)
          if (this.abortReason === 'pause' && w.flush) { try { await w.flush(); } catch { /* ignore */ } }
          throw err;
        }
        if (err.fatal || this.fatalError) {
          // remember the first fatal error and stop every worker quickly
          this.fatalError ||= err;
          this.abortCtrl?.abort(err);
          throw this.fatalError;
        }
        chunk.attempts = (chunk.attempts || 0) + 1;
        if (chunk.attempts > this.retries) {
          this.fatalError ||= Object.assign(new Error(`بخش #${idx} پس از ${this.retries} تلاش ناموفق بود: ${humanError(err)}`), { fatal: true });
          this.abortCtrl?.abort(this.fatalError);
          throw this.fatalError;
        }
        const backoff = Math.min(8_000, 400 * 2 ** (chunk.attempts - 1)) + Math.random() * 250;
        await sleep(backoff);
      } finally {
        chunk.claimed = false;
        w.active = false;
      }
    }
    if (this.fatalError && !this.abortReason) throw this.fatalError;
  }

  async fetchChunk(chunk, w) {
    const start = chunk.start + chunk.progress;
    const end = chunk.end;
    const ctrl = new AbortController();
    w.curCtrl = ctrl;
    w.lastDataAt = Date.now();
    const res = await fetch(this.url, {
      headers: { ...this.headers, range: `bytes=${start}-${end}` },
      redirect: 'follow',
      signal: AbortSignal.any([this.abortCtrl.signal, ctrl.signal]),
    });
    if (res.status === 200 && !(chunk.start === 0 && chunk.end === this.totalBytes - 1 && start === 0)) {
      // server ignored our Range header mid-flight — cannot continue chunked
      throw Object.assign(new Error('سرور درخواست Range را نادیده گرفت (این سرور از ادامه دانلود پشتیبانی نمی‌کند)'), { fatal: true });
    }
    if (!res.ok && res.status !== 206) throw httpErr(res.status);

    const fh = await fsp.open(this.partPath, 'r+');
    // buffered positional writer — coalesce network buffers into 1 MiB disk writes
    const writer = new ChunkWriter(fh, chunk, Math.min(1024 * 1024, end - start + 1));
    w.flush = () => writer.flush();
    let logical = start; // bytes pulled from the network (UI); disk-accurate progress lives in chunk.progress
    try {
      for await (const buf of res.body) {
        if (this.status !== 'downloading' || this.abortReason) throw new PausedError();
        w.lastDataAt = Date.now();
        await this.limiter.acquire(buf.length);
        await writer.push(buf);
        logical += buf.length;
        w.at = logical;
        w.pct = (logical - chunk.start) / (end - chunk.start + 1);
      }
      await writer.flush();
      if (writer.filePos !== end + 1) {
        throw new Error(`بخش ناقص دریافت شد (${writer.filePos - chunk.start} از ${end - chunk.start + 1} بایت)`);
      }
    } finally {
      w.flush = null;
      await fh.close();
      w.curCtrl = null;
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
  }

  async singleStream() {
    const res = await fetch(this.url, {
      headers: { ...this.headers }, redirect: 'follow',
      signal: AbortSignal.any([this.abortCtrl.signal, AbortSignal.timeout(STALL_TIMEOUT_MS * 4)]),
    });
    if (!res.ok) throw httpErr(res.status);
    const len = Number(res.headers.get('content-length'));
    if (len && Number.isFinite(len)) this.totalBytes = len;
    this.workers = [{ id: 0, active: true, chunkIndex: -1, from: 0, to: this.totalBytes || 0, at: 0, pct: 0, lastDataAt: Date.now(), curCtrl: null }];
    const w = this.workers[0];
    const fh = await fsp.open(this.partPath, 'r+');
    let pos = 0;
    try {
      for await (const buf of res.body) {
        if (this.status !== 'downloading' || this.abortReason) throw new PausedError();
        w.lastDataAt = Date.now();
        await this.limiter.acquire(buf.length);
        await fh.write(buf, 0, buf.length, pos);
        pos += buf.length;
        this.streamBytes = pos;
        w.at = pos;
        w.pct = this.totalBytes ? pos / this.totalBytes : 0;
      }
      w.active = false;
      if (!this.totalBytes) this.totalBytes = pos;
      else if (pos !== this.totalBytes) throw new Error('دانلود ناقص ماند');
    } finally {
      await fh.close();
    }
  }

  checkStalls() {
    const now = Date.now();
    for (const w of this.workers) {
      if (w.curCtrl && now - w.lastDataAt > STALL_TIMEOUT_MS) {
        w.curCtrl.abort(new Error('stalled connection'));
        w.lastDataAt = now; // avoid repeated aborts
      }
    }
  }

  sampleSpeed() {
    if (this.status !== 'downloading') { this.speed = 0; return; }
    const now = Date.now();
    const dt = (now - this._lastSampleAt) / 1000;
    if (dt <= 0) return;
    const dBytes = this.received - this._lastSampleBytes;
    const inst = Math.max(0, dBytes / dt);
    this.speed = this.speed ? this.speed * (1 - SPEED_EMA) + inst * SPEED_EMA : inst;
    if (this.speed > this.peakSpeed) this.peakSpeed = this.speed;
    this._lastSampleAt = now;
    this._lastSampleBytes = this.received;
  }

  async complete() {
    if (this.finalPath !== this.partPath) {
      const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
      let target = this.finalPath;
      if (await exists(target)) target = await uniquePath(this.dir, this.filename, exists);
      await fsp.rename(this.partPath, target);
      this.finalPath = target;
    }
    this.status = 'completed';
    this.completedAt = Date.now();
    this.workers = [];
    this.touch(true);
  }

  persistSoonLocal() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.engine.persistNow();
    }, 1000);
  }
}

/* ===================== helpers ===================== */

export class PausedError extends Error { constructor() { super('paused'); } }
export class CanceledError extends Error { constructor() { super('canceled'); } }

/**
 * Coalesces small network buffers into large positional writes.
 * `progress` on the target object only advances after bytes hit the disk,
 * so persisted resume offsets are always disk-accurate.
 */
export class ChunkWriter {
  constructor(fileHandle, target, bufSize) {
    this.fh = fileHandle;
    this.target = target;             // { start, progress } — a chunk or the single-stream sink
    this.buf = Buffer.allocUnsafe(Math.max(4096, bufSize));
    this.len = 0;                     // bytes buffered
    this.filePos = target.start + (target.progress || 0);
  }
  /** copy `src` in, flushing to disk whenever the buffer fills */
  async push(src) {
    // web streams hand us plain Uint8Array views — wrap as a zero-copy Buffer view
    const buf = Buffer.isBuffer(src) ? src : Buffer.from(src.buffer, src.byteOffset, src.byteLength);
    let off = 0;
    while (off < buf.length) {
      const take = Math.min(buf.length - off, this.buf.length - this.len);
      buf.copy(this.buf, this.len, off, off + take);
      this.len += take;
      off += take;
      if (this.len === this.buf.length) await this.flush();
    }
  }
  async flush() {
    if (this.len === 0) return;
    await this.fh.write(this.buf, 0, this.len, this.filePos);
    this.filePos += this.len;
    this.len = 0;
    if (this.target) this.target.progress = this.filePos - this.target.start;
  }
}

export class Limiter {
  constructor(bytesPerSec) {
    this.rate = bytesPerSec > 0 ? bytesPerSec : 0;
    this.cap = this.rate ? Math.min(this.rate, 4 * 1024 * 1024) : Infinity; // small burst window
    this.tokens = this.cap === Infinity ? Infinity : this.cap / 2;
    this.last = Date.now();
  }
  async acquire(n) {
    if (!this.rate) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= n) { this.tokens -= n; return; }
      const waitMs = Math.min(150, Math.ceil(((n - this.tokens) / this.rate) * 1000) + 5);
      await sleep(waitMs);
    }
  }
}

export function httpErr(status) {
  const map = {
    400: 'درخواست نامعتبر (400)', 401: 'نیاز به احراز هویت (401)', 403: 'دسترسی ممنوع است (403)',
    404: 'فایل پیدا نشد (404)', 405: 'متد مجاز نیست (405)', 410: 'فایل حذف شده است (410)',
    429: 'درخواست‌های بیش از حد (429)', 500: 'خطای داخلی سرور (500)', 502: 'سرور در دسترس نیست (502)',
    503: 'سرور موقتاً در دسترس نیست (503)', 507: 'فضای کافی روی سرور نیست (507)',
  };
  const e = new Error(map[status] || `خطای HTTP ${status} از سرور`);
  e.statusCode = status;
  if (status === 429 || status >= 500) e.retryable = true;
  return e;
}

export function humanError(err) {
  if (!err) return 'خطای نامشخص';
  if (err.cause?.code && FA_ERRORS[err.cause.code]) return FA_ERRORS[err.cause.code];
  if (err.cause?.code) return `خطای شبکه (${err.cause.code})`;
  if (err.name === 'TimeoutError') return 'مهلت اتصال تمام شد';
  if (err.name === 'AbortError') return 'لغو شد';
  return err.message || String(err);
}
