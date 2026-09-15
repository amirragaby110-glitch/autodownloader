// settings.js — persistent app settings (atomic JSON file)
import { homedir } from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  downloadsDir: '',           // resolved in init() → <repo>/downloads
  maxConcurrent: 3,           // simultaneous active downloads
  defaultConnections: 8,      // per-download parallel connections
  maxConnections: 32,
  defaultRetries: 5,          // per-chunk retry attempts
  autoStartQueue: true,       // queued jobs start automatically
  validateOnResume: true,     // re-HEAD and compare ETag/Last-Modified when resuming
  connectTimeoutMs: 15000,
};

export class Settings {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'settings.json');
    this.values = { ...DEFAULTS };
  }

  async init(defaultDownloadsDir) {
    this.values.downloadsDir = defaultDownloadsDir;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const saved = JSON.parse(raw);
      this.values = { ...DEFAULTS, ...saved };
    } catch { /* first run */ }
    if (!path.isAbsolute(this.values.downloadsDir)) this.values.downloadsDir = defaultDownloadsDir;
    await fsp.mkdir(this.values.downloadsDir, { recursive: true });
    await this.save();
    return this.values;
  }

  get() { return { ...this.values }; }

  async update(patch) {
    const next = { ...this.values };
    if (typeof patch.downloadsDir === 'string' && patch.downloadsDir.trim()) {
      const dir = path.resolve(patch.downloadsDir.trim());
      // allow any absolute path (self-hosted tool), but keep it sane
      if (!dir.startsWith(homedir()) && !dir.startsWith(process.cwd())) {
        throw Object.assign(new Error('مسیر باید داخل پوشه کاربر باشد'), { statusCode: 400 });
      }
      await fsp.mkdir(dir, { recursive: true });
      next.downloadsDir = dir;
    }
    if (patch.maxConcurrent !== undefined) next.maxConcurrent = clampInt(patch.maxConcurrent, 1, 16);
    if (patch.defaultConnections !== undefined) next.defaultConnections = clampInt(patch.defaultConnections, 1, 32);
    if (patch.defaultRetries !== undefined) next.defaultRetries = clampInt(patch.defaultRetries, 0, 20);
    if (patch.autoStartQueue !== undefined) next.autoStartQueue = !!patch.autoStartQueue;
    if (patch.validateOnResume !== undefined) next.validateOnResume = !!patch.validateOnResume;
    if (patch.connectTimeoutMs !== undefined) next.connectTimeoutMs = clampInt(patch.connectTimeoutMs, 2000, 120000);
    this.values = next;
    await this.save();
    return this.get();
  }

  async save() {
    const tmp = this.file + '.tmp';
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(this.values, null, 2));
    await fsp.rename(tmp, this.file);
  }
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw Object.assign(new Error('مقدار عددی نامعتبر'), { statusCode: 400 });
  return Math.min(max, Math.max(min, n));
}
