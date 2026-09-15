// run.mjs — engine end-to-end tests (no internet needed)
//   node test/run.mjs
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startRangeServer, MB } from './rangeserver.js';
import { Engine } from '../server/engine.js';
import { Settings } from '../server/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8931 + Math.floor(Math.random() * 100);
const SIZE = 32 * MB;
const PER_CONN = 6 * MB; // each connection throttled to 6 MB/s

const fmt = (mb) => `${(mb / MB).toFixed(1)} MB`;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.error(`  ✘ ${name} ${extra}`); }
}

async function sha256File(p) {
  const buf = await fsp.readFile(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function waitFor(job, statuses, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (statuses.includes(job.status)) return job.status;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`timeout waiting for ${statuses} (status=${job.status}, err=${job.error})`);
}

async function cleanDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

async function main() {
  console.log('\n━━━ AutoDownloader engine tests ━━━\n');
  const origin = await startRangeServer({ port: PORT, size: SIZE, perConnBps: PER_CONN });
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`origin: ${base}  file=${fmt(SIZE)}  throttle=${fmt(PER_CONN)}/s per connection\n`);

  const dataDir = path.join(__dirname, 'tmp-data');
  const dlDir = path.join(__dirname, 'tmp-downloads');
  await cleanDir(dataDir); await cleanDir(dlDir);

  const settings = new Settings(dataDir);
  await settings.init(dlDir);
  await settings.update({ maxConcurrent: 4, defaultConnections: 8, defaultRetries: 3 });
  const engine = new Engine({ dataDir, settings });
  await engine.init();

  /* ---- A) single connection ---- */
  {
    console.log('A) single connection (1×6 MB/s expected ≈ 5.3s+)');
    const job = engine.add(`${base}/file.bin`, { connections: 1, filename: 'a-single.bin' });
    const t0 = Date.now();
    await waitFor(job, ['completed', 'failed']);
    const secs = (Date.now() - t0) / 1000;
    check('completes', job.status === 'completed', job.error || '');
    check('checksum matches', await sha256File(job.finalPath) === origin.sha256);
    check(`throttled ≈ ${secs.toFixed(1)}s`, secs >= SIZE / PER_CONN - 1);
    globalThis.singleSecs = secs;
    console.log(`    → ${secs.toFixed(2)}s, avg ${fmt(SIZE / secs)}/s\n`);
  }

  /* ---- B) 8 connections ---- */
  {
    console.log('B) 8 parallel connections (8×6 = 48 MB/s expected)');
    const job = engine.add(`${base}/file.bin`, { connections: 8, filename: 'b-multi.bin' });
    const t0 = Date.now();
    await waitFor(job, ['completed', 'failed']);
    const secs = (Date.now() - t0) / 1000;
    check('completes', job.status === 'completed', job.error || '');
    check('checksum matches', await sha256File(job.finalPath) === origin.sha256);
    check('all chunks done', job.chunks.every((c) => c.done));
    const speedup = globalThis.singleSecs / secs;
    check(`speedup ×${speedup.toFixed(1)} (>${(PER_CONN ? 3 : 1).toFixed(0)}× target)`, speedup > 3);
    console.log(`    → ${secs.toFixed(2)}s, avg ${fmt(SIZE / secs)}/s — ${(speedup).toFixed(1)}× faster than single\n`);
  }

  /* ---- C) pause & resume ---- */
  {
    console.log('C) pause → resume mid-flight');
    const job = engine.add(`${base}/file.bin`, { connections: 4, filename: 'c-pause.bin' });
    await waitFor(job, ['downloading']);
    await new Promise((r) => setTimeout(r, 600));
    engine.pause(job.id);
    await waitFor(job, ['paused']);
    const kept = job.received;
    check('paused with progress', kept > 0 && kept < SIZE, `(${fmt(kept)})`);
    await new Promise((r) => setTimeout(r, 400));
    check('bytes frozen while paused', job.received === kept);
    engine.resume(job.id);
    await waitFor(job, ['completed', 'failed']);
    check('resumes and completes', job.status === 'completed', job.error || '');
    check('checksum matches', await sha256File(job.finalPath) === origin.sha256);
    const partGone = !await fsp.stat(job.partPath).then(() => true, () => false);
    check('.part renamed away', partGone);
    console.log(`    → ok, resumed from ${fmt(kept)}\n`);
  }

  /* ---- D) restart persistence (simulated server restart) ---- */
  {
    console.log('D) resume across a server restart (state file reload)');
    const job = engine.add(`${base}/file.bin`, { connections: 4, filename: 'd-restart.bin' });
    await waitFor(job, ['downloading']);
    await new Promise((r) => setTimeout(r, 700));
    engine.pause(job.id);
    await waitFor(job, ['paused']);
    const kept = job.received;
    engine.shutdown();
    // brand new engine from the same data dir
    const engine2 = new Engine({ dataDir, settings });
    await engine2.init();
    const j2 = [...engine2.jobs.values()].find((j) => j.filename === 'd-restart.bin');
    check('job restored after restart', !!j2 && j2.status === 'paused');
    check('progress preserved', j2.received === kept, `(${fmt(j2.received)})`);
    j2.resume();
    await waitFor(j2, ['completed', 'failed'], 90_000);
    check('completes after restart-resume', j2.status === 'completed', j2.error || '');
    check('checksum matches', await sha256File(j2.finalPath) === origin.sha256);
    console.log(`    → ok, continued from ${fmt(kept)}\n`);
  }

  /* ---- E) no-range fallback ---- */
  {
    console.log('E) server without Range support → single-stream fallback');
    const job = engine.add(`${base}/norange.bin`, { connections: 8, filename: 'e-norange.bin' });
    await waitFor(job, ['completed', 'failed'], 90_000);
    check('completes', job.status === 'completed', job.error || '');
    check('checksum matches', await sha256File(job.finalPath) === origin.sha256);
    check('no chunking used', job.chunks.length === 0);
    console.log('');
  }

  /* ---- F) speed limit ---- */
  {
    console.log('F) speed limit (8 MB/s cap on 32 MB file ≈ 4s)');
    const job = engine.add(`${base}/file.bin`, { connections: 8, speedLimit: 8 * MB, filename: 'f-limited.bin' });
    const t0 = Date.now();
    await waitFor(job, ['completed', 'failed'], 90_000);
    const secs = (Date.now() - t0) / 1000;
    check('completes', job.status === 'completed', job.error || '');
    check('checksum matches', await sha256File(job.finalPath) === origin.sha256);
    check(`respected the cap (${secs.toFixed(1)}s ≥ 3.2s)`, secs >= SIZE / (8 * MB) - 0.7);
    console.log(`    → ${secs.toFixed(2)}s, avg ${fmt(SIZE / secs)}/s\n`);
  }

  /* ---- G) bad url / 404 ---- */
  {
    console.log('G) error handling');
    const job = engine.add(`${base}/missing.bin`, { connections: 2, filename: 'g-404.bin', retries: 1 });
    await waitFor(job, ['failed'], 30_000);
    check('404 → failed with message', job.status === 'failed' && /404/.test(job.error), `(${job.error})`);
    let threw = false;
    try { engine.add('notaurl', {}); } catch { threw = true; }
    check('invalid URL rejected', threw);
    console.log('');
  }

  engine.shutdown();
  await engine.persistNow();      // let the final state flush settle
  origin.server.close();
  await new Promise((r) => setTimeout(r, 150));
  await cleanDir(dataDir); await cleanDir(dlDir);
  try { await fsp.rm(origin.dir, { recursive: true, force: true }); } catch {}

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
