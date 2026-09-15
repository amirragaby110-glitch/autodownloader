// rangeserver.js — local test origin with Range support + per-connection throttle
// Used by `npm test` to prove the multi-connection speedup without internet access.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KB = 1024, MB = 1024 * KB;

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {number} opts.size        bytes of the generated file
 * @param {number} opts.perConnBps  throttle per connection (bytes/sec), 0 = unlimited
 */
export function startRangeServer({ port = 8931, size = 32 * MB, perConnBps = 8 * MB } = {}) {
  const dir = fs.mkdtempSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'tmp-origin-'));
  const file = path.join(dir, 'sample.bin');
  const fd = fs.openSync(file, 'w');
  // write in 1 MiB random blocks
  for (let i = 0; i < size; i += MB) {
    const n = Math.min(MB, size - i);
    fs.writeSync(fd, crypto.randomBytes(n), 0, n, i);
  }
  fs.closeSync(fd);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/checksum') { res.end(JSON.stringify({ sha256: sum, size })); return; }
    if (u.pathname === '/redirect') { res.writeHead(302, { location: '/file.bin' }); res.end(); return; }
    if (u.pathname !== '/file.bin' && u.pathname !== '/norange.bin') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.method === 'HEAD') {
      // proper HEAD: headers only, never a body (like real servers)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'accept-ranges': 'none',
      });
      return res.end();
    }

    const noRange = u.pathname === '/norange.bin';
    const filePath = file;

    let start = 0, end = size - 1, partial = false;
    const range = req.headers.range;
    if (range && !noRange) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        partial = true;
        if (m[1]) start = Number(m[1]);
        if (m[2]) end = Number(m[2]);
        if (!m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
        end = Math.min(end, size - 1);
        if (start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}` });
          return res.end();
        }
      }
    }

    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="sample.bin"',
      'accept-ranges': noRange ? 'none' : 'bytes',
      'content-length': String(end - start + 1),
    };
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);

    // stream with per-connection throttle
    const bps = perConnBps;
    const block = 128 * KB;
    let pos = start;
    let closed = false;
    res.on('close', () => { closed = true; });
    (async () => {
      const stream = fs.createReadStream(filePath, { start, end });
      for await (const chunk of stream) {
        if (closed) break;
        res.write(chunk);
        pos += chunk.length;
        if (bps > 0) {
          let remaining = chunk.length;
          while (remaining > 0 && !closed) {
            const take = Math.min(block, remaining);
            remaining -= take;
            await new Promise((r) => setTimeout(r, (take / bps) * 1000));
          }
        }
      }
      res.end();
    })().catch(() => res.destroy());
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, file, sha256: sum, size, dir }));
  });
}
