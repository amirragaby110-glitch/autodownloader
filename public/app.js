/* ═══════════════════════════════════════════════════════════
   AutoDownloader — frontend (vanilla ES2024, no build step)
   Live updates over SSE · keyed DOM reconciliation
   ═══════════════════════════════════════════════════════════ */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ── formatting (fa-IR) ─────────────────────────── */
const faInt = new Intl.NumberFormat('fa-IR');
const fa1 = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
const faDate = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' });

const UNITS = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت', 'ترابایت'];
function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '؟';
  if (n < 1024) return `${faInt.format(n)} بایت`;
  let u = 0;
  while (n >= 1024 && u < UNITS.length - 1) { n /= 1024; u++; }
  return `${fa1.format(n)} ${UNITS[u]}`;
}
function fmtSpeed(bps) {
  if (!bps || bps < 1) return '۰';
  return `${fa1.format(bps / 1024 / 1024)} MB/s`;
}
function fmtEta(sec) {
  if (sec == null) return '—';
  if (sec < 5) return 'چند لحظه';
  if (sec < 60) return `${faInt.format(Math.round(sec))} ثانیه`;
  if (sec < 3600) return `${faInt.format(Math.floor(sec / 60))} دقیقه و ${faInt.format(Math.round(sec % 60))} ثانیه`;
  return `${faInt.format(Math.floor(sec / 3600))} ساعت و ${faInt.format(Math.floor((sec % 3600) / 60))} دقیقه`;
}
const STATUS_FA = {
  queued: 'در صف', probing: 'در حال بررسی', downloading: 'در حال دانلود',
  paused: 'متوقف', completed: 'کامل شد', failed: 'ناموفق', canceled: 'لغو شد',
};

/* ── icons ──────────────────────────────────────── */
const I = {
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 4H6v16h4zM18 4h-4v16h4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
};

const CATS = {
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'opus', 'wma'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'epub', 'csv'],
  app: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'bin', 'jar', 'sh'],
};
function fileCat(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  for (const [cat, exts] of Object.entries(CATS)) if (exts.includes(ext)) return { cat, ext };
  return { cat: 'file', ext: ext.slice(0, 4) || 'file' };
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

/* ── toasts ─────────────────────────────────────── */
function toast(msg, type = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

/* ── api helper ─────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ═════════════════ state ═════════════════ */
const state = {
  jobs: new Map(),       // id → job
  settings: null,
  spark: [],
  dirOverride: null,     // per-session folder override in the add panel
};

/* ═════════════════ job cards ═════════════════ */
const jobList = $('#jobList');
const emptyState = $('#emptyState');

function buildCard(job) {
  const { cat, ext } = fileCat(job.filename);
  const el = document.createElement('article');
  el.className = 'job glass';
  el.dataset.id = job.id;
  el.innerHTML = `
    <div class="job-head">
      <div class="file-icon cat-${cat}">${ext.toUpperCase()}</div>
      <div class="job-title">
        <div class="job-name" title=""></div>
        <div class="job-sub">
          <span class="host" dir="ltr"></span>
          <span class="size"></span>
          <span class="date"></span>
        </div>
      </div>
      <span class="chip"></span>
    </div>
    <div class="progress-wrap">
      <div class="bar"><div class="fill"></div></div>
      <div class="pct" dir="ltr"></div>
    </div>
    <div class="stats">
      <div class="stat"><span class="k">سرعت</span><span class="v v-speed" dir="ltr"></span></div>
      <div class="stat"><span class="k">دانلود شده</span><span class="v v-got"></span></div>
      <div class="stat"><span class="k">زمان باقی‌مانده</span><span class="v v-eta"></span></div>
      <div class="stat"><span class="k">اتصال‌ها</span><span class="v v-conns" dir="ltr"></span></div>
    </div>
    <div class="conns-block">
      <div class="conns-label"><span>اتصال‌های موازی</span><span class="chunks"></span></div>
      <div class="conns"></div>
    </div>
    <div class="job-error" hidden></div>
    <div class="job-actions">
      <button class="btn icon act-pause" title="توقف" data-act="pause">${I.pause}</button>
      <button class="btn icon act-resume" title="ادامه" data-act="resume">${I.play}</button>
      <button class="btn icon act-restart" title="شروع از ابتدا" data-act="restart">${I.retry}</button>
      <button class="btn icon act-save" title="ذخیره در دستگاه" data-act="save">${I.save}</button>
      <button class="btn icon act-preview" title="پیش‌نمایش" data-act="preview">${I.eye}</button>
      <span class="spacer"></span>
      <button class="btn icon danger act-cancel" title="لغو" data-act="cancel">${I.x}</button>
      <button class="btn icon danger act-delfile" title="حذف از فهرست و پاک‌کردن فایل" data-act="delfile">${I.trash}</button>
      <button class="btn icon danger act-del" title="حذف از فهرست" data-act="del">${I.x}</button>
    </div>`;
  el._r = {
    name: $('.job-name', el), host: $('.host', el), size: $('.size', el), date: $('.date', el),
    chip: $('.chip', el), fill: $('.fill', el), pct: $('.pct', el),
    speed: $('.v-speed', el), got: $('.v-got', el), eta: $('.v-eta', el), conns: $('.v-conns', el),
    connsBox: $('.conns', el), chunks: $('.chunks', el), err: $('.job-error', el),
  };
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) doAction(job.id, btn.dataset.act, btn);
  });
  return el;
}

const ACTION_VISIBILITY = {
  queued:     ['pause', 'cancel', 'del'],
  probing:    ['cancel', 'del'],
  downloading:['pause', 'cancel', 'del'],
  paused:     ['resume', 'restart', 'cancel', 'del'],
  failed:     ['resume', 'restart', 'cancel', 'del'],
  canceled:   ['resume', 'restart', 'del'],
  completed:  ['restart', 'save', 'preview', 'del', 'delfile'],
};

function updateCard(el, job, firstBuild = false) {
  const r = el._r;
  el.className = `job glass ${job.status}`;
  if (firstBuild) {
    r.name.textContent = job.filename || '…';
    r.name.title = job.filename || '';
    r.host.textContent = hostOf(job.url);
    r.date.textContent = faDate.format(job.createdAt);
  }
  r.size.textContent = job.totalBytes ? fmtBytes(job.totalBytes) : 'حجم نامشخص';
  r.chip.className = `chip ${job.status}`;
  r.chip.textContent = STATUS_FA[job.status] || job.status;

  // progress
  if (job.progress != null) {
    r.fill.style.setProperty('--p', (job.progress * 100).toFixed(2));
    r.pct.textContent = `${faInt.format(Math.round(job.progress * 100))}٪`;
    r.pct.classList.remove('indet');
  } else if (job.status === 'downloading') {
    r.fill.style.setProperty('--p', 100);
    r.pct.textContent = '…';
    r.pct.classList.add('indet');
  } else {
    r.fill.style.setProperty('--p', 0);
    r.pct.textContent = '—';
    r.pct.classList.remove('indet');
  }

  r.speed.textContent = fmtSpeed(job.speed);
  r.got.textContent = fmtBytes(job.received);
  r.eta.textContent = job.status === 'completed' ? '✓' : fmtEta(job.eta);
  r.conns.textContent = job.connections > 0
    ? `${faInt.format(job.activeConnections)}/${faInt.format(job.connections)}` : '—';

  // per-connection bars
  const n = Math.max(1, job.workers.length || (job.connections || 1));
  if (r.connsBox.childElementCount !== n) {
    r.connsBox.innerHTML = '<i></i>'.repeat(n);
  }
  const bars = r.connsBox.children;
  for (let i = 0; i < n; i++) {
    const w = job.workers[i];
    const b = bars[i];
    if (w && job.status === 'downloading') {
      b.className = w.active ? 'active' : '';
      b.style.setProperty('--p', Math.round((w.pct || 0) * 100));
    } else {
      b.className = '';
      b.style.setProperty('--p', 0);
    }
  }
  r.chunks.textContent = job.chunkCount
    ? `${faInt.format(job.doneChunks)}/${faInt.format(job.chunkCount)} بخش` : '';

  // error
  if (job.error) { r.err.hidden = false; r.err.textContent = job.error; }
  else r.err.hidden = true;

  // action buttons
  const vis = ACTION_VISIBILITY[job.status] || ['del'];
  for (const btn of $$('.job-actions [data-act]', el)) {
    btn.hidden = !vis.includes(btn.dataset.act);
  }
  if (job.status === 'completed' && job.filePath) {
    $('.act-save', el).disabled = false;
  }
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  emptyState.hidden = jobs.length > 0;
  const have = new Set();
  let prev = null;
  for (const job of jobs) {
    have.add(job.id);
    let el = jobList.querySelector(`[data-id="${job.id}"]`);
    if (!el) {
      el = buildCard(job);
      updateCard(el, job, true);
    } else {
      updateCard(el, job);
    }
    // place: newest first
    const at = [...jobList.children].indexOf(el);
    const want = prev ? prev.nextElementSibling : jobList.firstChild;
    if (at === -1) jobList.insertBefore(el, want);
    else if (el !== want) jobList.insertBefore(el, want);
    prev = el;
  }
  for (const el of [...jobList.children]) {
    if (!have.has(el.dataset.id)) el.remove();
  }
}

/* ═════════════════ actions ═════════════════ */
async function doAction(id, act, btn) {
  try {
    switch (act) {
      case 'pause': await api(`/api/downloads/${id}?action=pause`, { method: 'POST' }); break;
      case 'resume': await api(`/api/downloads/${id}?action=resume`, { method: 'POST' }); break;
      case 'restart':
        await api(`/api/downloads/${id}?action=restart`, { method: 'POST' });
        toast('دانلود از ابتدا شروع شد', 'info');
        break;
      case 'cancel':
        await api(`/api/downloads/${id}?action=cancel`, { method: 'POST' });
        break;
      case 'save': {
        const a = document.createElement('a');
        a.href = `/api/downloads/${id}/file`;
        a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
        break;
      }
      case 'preview':
        window.open(`/api/downloads/${id}/file?inline=1`, '_blank', 'noopener');
        break;
      case 'del':
        if (btn?.classList.contains('confirm')) await api(`/api/downloads/${id}`, { method: 'DELETE' });
        else {
          btn?.classList.add('confirm');
          btn?.setAttribute('title', 'برای تأیید دوباره کلیک کنید');
          toast('برای حذف کامل، دوباره روی دکمه کلیک کنید', 'info', 2500);
          setTimeout(() => btn?.classList.remove('confirm'), 2600);
          return;
        }
        break;
      case 'delfile':
        if (btn?.classList.contains('confirm')) await api(`/api/downloads/${id}?file=1`, { method: 'DELETE' });
        else {
          btn?.classList.add('confirm');
          toast('⚠️ فایل هم از دیسک پاک می‌شود — دوباره کلیک کنید', 'err', 2600);
          setTimeout(() => btn?.classList.remove('confirm'), 2600);
          return;
        }
        break;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ═════════════════ add downloads ═════════════════ */
function collectOptions() {
  const headers = {};
  if ($('#optUA').value.trim()) headers.userAgent = $('#optUA').value.trim();
  if ($('#optReferer').value.trim()) headers.referer = $('#optReferer').value.trim();
  return {
    connections: Number($('#optConnections').value),
    speedLimit: Number($('#optSpeed').value),
    retries: Number($('#optRetries').value),
    filename: $('#optFilename').value.trim() || undefined,
    dir: state.dirOverride || $('#optDir').value || undefined,
    headers,
  };
}

async function addDownloads() {
  const lines = $('#urlInput').value
    .split(/[\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = [...new Set(lines.filter((l) => /^https?:\/\//i.test(l)))];
  const invalid = lines.length - urls.length;

  if (!urls.length) {
    toast('حداقل یک لینک معتبر (http/https) وارد کنید', 'err');
    $('#urlInput').focus();
    return;
  }
  const opts = collectOptions();
  if (urls.length > 1) delete opts.filename;
  try {
    const res = await api('/api/downloads', { method: 'POST', body: { urls, options: opts } });
    const okMsg = res.jobs.length === 1
      ? `«${res.jobs[0].filename || 'دانلود'}» به صف اضافه شد ⚡`
      : `${faInt.format(res.jobs.length)} دانلود به صف اضافه شد ⚡`;
    toast(okMsg, 'ok');
    for (const e of res.errors || []) toast(`خطا: ${e.error}`, 'err');
    if (invalid > 0) toast(`${faInt.format(invalid)} خط معتبر نبود و نادیده گرفته شد`, 'info');
    $('#urlInput').value = '';
    autoGrow();
    $('#probeResult').hidden = true;
    // remember options for next time
    localStorage.setItem('ad:opts', JSON.stringify(opts));
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ═════════════════ probe ═════════════════ */
async function probeUrl() {
  const url = $('#urlInput').value.split(/[\n\r]+/).map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
  if (!url) { toast('یک لینک معتبر وارد کنید', 'err'); return; }
  const box = $('#probeResult');
  box.hidden = false;
  box.innerHTML = '<span class="p-ok">در حال بررسی سرور…</span>';
  try {
    const headers = {};
    if ($('#optUA').value.trim()) headers.userAgent = $('#optUA').value.trim();
    if ($('#optReferer').value.trim()) headers.referer = $('#optReferer').value.trim();
    const info = await api('/api/probe', { method: 'POST', body: { url, headers } });
    const size = info.totalBytes ? `<b>${fmtBytes(info.totalBytes)}</b>` : 'حجم نامشخص';
    const range = info.acceptRanges
      ? '<span class="p-ok">✓ دانلود چنداتصاله (سریع)</span>'
      : '<span class="p-bad">✗ فقط تک‌اتصاله</span>';
    box.innerHTML = `
      <span>فایل: <b>${info.suggestedName || 'نامشخص'}</b></span>
      <span>${size}</span>
      <span>${range}</span>
      ${info.contentType ? `<span dir="ltr" style="color:var(--faint)">${info.contentType}</span>` : ''}`;
  } catch (err) {
    box.innerHTML = `<span class="p-bad">✗ ${err.message}</span>`;
  }
}

/* ═════════════════ settings ═════════════════ */
function fillSettings(s) {
  $('#setDir').value = s.downloadsDir;
  $('#setMaxConcurrent').value = s.maxConcurrent;
  $('#setConnections').value = s.defaultConnections;
  $('#setRetries').value = s.defaultRetries;
  $('#setAutoStart').checked = s.autoStartQueue;
  $('#setValidate').checked = s.validateOnResume;
  if (!state.dirOverride) $('#optDir').value = s.downloadsDir;
  $('#optConnections').value = s.defaultConnections;
  $('#optConnectionsVal').textContent = s.defaultConnections;
}

async function saveSettings() {
  try {
    const body = {
      downloadsDir: $('#setDir').value,
      maxConcurrent: Number($('#setMaxConcurrent').value),
      defaultConnections: Number($('#setConnections').value),
      defaultRetries: Number($('#setRetries').value),
      autoStartQueue: $('#setAutoStart').checked,
      validateOnResume: $('#setValidate').checked,
    };
    const res = await api('/api/settings', { method: 'PUT', body });
    state.settings = res.settings;
    toast('تنظیمات ذخیره شد ✓', 'ok');
    $('#settingsDlg').close();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ═════════════════ folder browser ═════════════════ */
const fsState = { target: null, path: '' }; // target: 'add' | 'settings'

async function openFsBrowser(target) {
  fsState.target = target;
  fsState.path = target === 'add'
    ? (state.dirOverride || $('#optDir').value || state.settings?.downloadsDir || '')
    : $('#setDir').value || state.settings?.downloadsDir || '';
  $('#fsDlg').showModal();
  await loadFs(fsState.path);
}

async function loadFs(path) {
  try {
    const res = await api(`/api/fs?path=${encodeURIComponent(path)}`);
    fsState.path = res.path;
    // breadcrumbs
    const crumbs = $('#fsCrumbs');
    crumbs.innerHTML = '';
    if (res.parent != null) {
      const up = document.createElement('button');
      up.textContent = '↑';
      up.title = 'پوشه بالاتر';
      up.onclick = () => loadFs(res.parent);
      crumbs.appendChild(up);
      crumbs.insertAdjacentHTML('beforeend', '<span class="sep">/</span>');
    }
    const parts = res.path.split('/').filter(Boolean);
    let acc = '';
    parts.forEach((part, i) => {
      acc += '/' + part;
      const p = acc;
      const b = document.createElement('button');
      b.textContent = part;
      b.onclick = () => loadFs(p);
      crumbs.appendChild(b);
      if (i < parts.length - 1) crumbs.insertAdjacentHTML('beforeend', '<span class="sep">/</span>');
    });
    // dirs
    const list = $('#fsList');
    list.innerHTML = '';
    if (!res.dirs.length) {
      list.innerHTML = '<div class="fs-empty">زیرپوشه‌ای وجود ندارد</div>';
    }
    for (const d of res.dirs) {
      const item = document.createElement('div');
      item.className = 'fs-item';
      item.innerHTML = `${I.folder}<span></span>`;
      $('span', item).textContent = d.name;
      item.onclick = () => loadFs(d.path);
      list.appendChild(item);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function mkdirHere() {
  const list = $('#fsList');
  if ($('#mkRow')) { $('#mkRow input').focus(); return; }
  const row = document.createElement('div');
  row.id = 'mkRow';
  row.className = 'fs-item';
  row.innerHTML = `<input dir="ltr" placeholder="نام پوشه جدید" style="flex:1;background:transparent;border:none;outline:1px solid var(--accent);border-radius:8px;padding:6px 10px;color:var(--text);font:inherit" />
    <button class="btn ghost sq" style="padding:6px" title="ایجاد">✓</button>`;
  list.prepend(row);
  const input = $('input', row);
  input.focus();
  const create = async () => {
    const name = input.value.trim();
    if (!name) { row.remove(); return; }
    try {
      const res = await api('/api/fs/mkdir', { method: 'POST', body: { path: fsState.path, name } });
      toast('پوشه ساخته شد ✓', 'ok');
      await loadFs(res.path);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('button', row).onclick = create;
  input.onkeydown = (e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') row.remove(); };
}

function pickDir() {
  if (!fsState.path) return;
  if (fsState.target === 'add') {
    state.dirOverride = fsState.path;
    $('#optDir').value = fsState.path;
  } else {
    $('#setDir').value = fsState.path;
  }
  $('#fsDlg').close();
}

/* ═════════════════ HUD + sparkline ═════════════════ */
function updateHud(stats) {
  $('#hudSpeed').textContent = fa1.format((stats.totalSpeed || 0) / 1024 / 1024);
  $('#hudActive').textContent = faInt.format(stats.active || 0);
  $('#hudQueue').textContent = faInt.format(stats.queued || 0);
  $('#hudDone').textContent = faInt.format(stats.done || 0);
  // sparkline (MB/s, last 70 samples)
  state.spark.push((stats.totalSpeed || 0) / 1024 / 1024);
  if (state.spark.length > 70) state.spark.shift();
  const max = Math.max(1, ...state.spark);
  const pts = state.spark.map((v, i) =>
    `${(i / Math.max(1, state.spark.length - 1)) * 120},${32 - (v / max) * 28}`).join(' ');
  $('#sparkline').setAttribute('points', pts);
}

/* ═════════════════ SSE ═════════════════ */
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'snapshot') {
        for (const j of msg.jobs) state.jobs.set(j.id, j);
        for (const id of state.jobs.keys()) {
          if (!msg.jobs.some((j) => j.id === id)) state.jobs.delete(id);
        }
        renderJobs();
        updateHud(msg.stats);
      } else if (msg.type === 'settings') {
        state.settings = msg.settings;
        fillSettings(msg.settings);
      }
    } catch { /* ignore malformed frames */ }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

/* ═════════════════ misc UI wiring ═════════════════ */
function autoGrow() {
  const t = $('#urlInput');
  t.style.height = 'auto';
  t.style.height = Math.min(160, t.scrollHeight) + 'px';
}

function wireUI() {
  // add
  $('#btnAdd').addEventListener('click', addDownloads);
  $('#btnProbe').addEventListener('click', probeUrl);
  $('#urlInput').addEventListener('input', autoGrow);
  $('#urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addDownloads(); }
  });
  // paste anywhere → jump into the box
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t.closest && t.closest('input, textarea, [contenteditable]')) return;
    const text = e.clipboardData?.getData('text') || '';
    if (/https?:\/\//i.test(text)) {
      e.preventDefault();
      const box = $('#urlInput');
      box.value = (box.value ? box.value + '\n' : '') + text.trim();
      autoGrow();
      box.focus();
      toast('لینک چسبانده شد — «شروع دانلود» را بزنید', 'info', 2200);
    }
  });

  // options panel
  $('#btnToggleOptions').addEventListener('click', () => {
    const p = $('#optionsPanel');
    p.hidden = !p.hidden;
    localStorage.setItem('ad:optsOpen', p.hidden ? '0' : '1');
  });
  $('#optConnections').addEventListener('input', (e) => {
    $('#optConnectionsVal').textContent = e.target.value;
  });

  // dialogs
  $('#btnSettings').addEventListener('click', () => $('#settingsDlg').showModal());
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#btnBrowseDir').addEventListener('click', () => openFsBrowser('add'));
  $('#btnBrowseSetDir').addEventListener('click', () => openFsBrowser('settings'));
  $('#btnPickDir').addEventListener('click', pickDir);
  $('#btnMkdir').addEventListener('click', mkdirHere);
  $('#settingsForm').addEventListener('submit', (e) => e.preventDefault());
}

/* ═════════════════ boot ═════════════════ */
async function boot() {
  wireUI();
  // restore last-used options
  try {
    const saved = JSON.parse(localStorage.getItem('ad:opts') || 'null');
    if (saved) {
      if (saved.connections) { $('#optConnections').value = saved.connections; $('#optConnectionsVal').textContent = saved.connections; }
      if (saved.speedLimit != null) $('#optSpeed').value = String(saved.speedLimit);
      if (saved.retries != null) $('#optRetries').value = saved.retries;
      if (saved.headers?.userAgent) $('#optUA').value = saved.headers.userAgent;
      if (saved.headers?.referer) $('#optReferer').value = saved.headers.referer;
      if (saved.dir) { state.dirOverride = saved.dir; $('#optDir').value = saved.dir; }
    }
    if (localStorage.getItem('ad:optsOpen') === '1') $('#optionsPanel').hidden = false;
  } catch { /* ignore */ }

  try {
    const s = await api('/api/settings');
    state.settings = s.settings;
    fillSettings(s.settings);
  } catch { /* SSE will deliver settings too */ }
  connectSSE();
  autoGrow();
  $('#urlInput').focus();
}

boot();
