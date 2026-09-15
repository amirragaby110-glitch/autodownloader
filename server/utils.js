// utils.js — shared helpers (no external dependencies)
import path from 'node:path';
import crypto from 'node:crypto';

export const KB = 1024;
export const MB = 1024 * 1024;
export const GB = 1024 * MB;

/** Short random id */
export function uid(len = 10) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

/** Parse "bytes=start-end" from a Content-Range header → total size */
export function parseContentRange(hdr) {
  if (!hdr) return null;
  const m = /bytes\s+\/\s*(\d+)$/i.exec(String(hdr).trim()) || /bytes\s+\d+-\d+\/(\d+)/i.exec(String(hdr).trim());
  return m ? Number(m[1]) : null;
}

/** Extract filename from Content-Disposition (RFC 6266, incl. RFC 5987 ext) */
export function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  if (star) {
    const raw = star[1].trim().replace(/^UTF-8/i, '').replace(/^''/i, '');
    try { return safeFilename(decodeURIComponent(raw)); } catch { /* fallthrough */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain) {
    const raw = plain[1].trim();
    try { return safeFilename(decodeURIComponent(raw)); } catch { return safeFilename(raw); }
  }
  return null;
}

/** Sanitize a filename: strip paths / control chars, cap length */
export function safeFilename(name) {
  if (!name) return null;
  let s = String(name)
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!s) return null;
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

/** Guess filename from a URL */
export function filenameFromURL(urlStr) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname || '');
    if (base) {
      try { return safeFilename(decodeURIComponent(base)); } catch { return safeFilename(base); }
    }
    if (u.searchParams.get('filename')) return safeFilename(u.searchParams.get('filename'));
  } catch { /* invalid url */ }
  return null;
}

/** Unique file path: if target exists, append " (n)" before extension */
export async function uniquePath(dir, filename, exists) {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = path.join(dir, filename);
  let n = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n++})${ext}`);
    if (n > 9999) { candidate = path.join(dir, `${stem}-${Date.now()}${ext}`); break; }
  }
  return candidate;
}

/** mime map for static serving */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
export function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/** sleep(ms) */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** clamp */
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** JSON fetch body helper */
export async function readJson(req, limit = 256 * KB) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { statusCode: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { statusCode: 400 }); }
}

/** send JSON response */
export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Time-diff in ms → human "x min ago" (fa) — kept latin-neutral, UI formats */
export function isValidHttpUrl(s) {
  try {
    const u = new URL(String(s).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
