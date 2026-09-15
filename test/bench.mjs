// bench.mjs — compare parallel fetch vs parallel http.get against the throttled origin
import { startRangeServer, MB } from './rangeserver.js';
import http from 'node:http';

const PORT = 8990;
const SIZE = 32 * MB;
const PER_CONN = 6 * MB;
const origin = await startRangeServer({ port: PORT, size: SIZE, perConnBps: PER_CONN });
const base = `http://127.0.0.1:${PORT}`;
const url = new URL(`${base}/file.bin`);

async function fetchRange(i) {
  const n = 8;
  const each = Math.floor(SIZE / n);
  const start = i * each, end = i === n - 1 ? SIZE - 1 : start + each - 1;
  const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error('no 206');
  let len = 0;
  let chunks = 0, minC = Infinity, maxC = 0;
  for await (const buf of res.body) { len += buf.length; chunks++; minC = Math.min(minC, buf.length); maxC = Math.max(maxC, buf.length); }
  return { len, chunks, avgChunk: len / chunks, minC, maxC };
}

function httpRange(i) {
  return new Promise((resolve, reject) => {
    const n = 8;
    const each = Math.floor(SIZE / n);
    const start = i * each, end = i === n - 1 ? SIZE - 1 : start + each - 1;
    let len = 0;
    const req = http.request(url, { headers: { range: `bytes=${start}-${end}` } }, (res) => {
      if (res.statusCode !== 206) return reject(new Error('no 206: ' + res.statusCode));
      res.on('data', (c) => { len += c.length; });
      res.on('end', () => resolve({ len }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function bench(name, fn, n) {
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
  const secs = (Date.now() - t0) / 1000;
  const total = rs.reduce((a, r) => a + r.len, 0);
  console.log(`${name}: ${n} conn → ${total / MB}MB in ${secs.toFixed(2)}s = ${(total / MB / secs).toFixed(1)} MB/s`, rs[0].avgChunk ? `avgChunk=${rs[0].avgChunk.toFixed(0)}B` : '');
}

await bench('fetch  ×1', fetchRange, 1);
await bench('fetch  ×8', fetchRange, 8);
await bench('http   ×8', httpRange, 8);
await bench('fetch  ×8', fetchRange, 8);
await bench('http   ×8', httpRange, 8);
origin.server.close();
process.exit(0);
