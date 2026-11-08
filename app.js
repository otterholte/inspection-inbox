const $ = id => document.getElementById(id);
const KEY = 'inspection-inbox-v1';

// Upload endpoint (Apps Script web app). Useless without the key, which comes from the access code.
const ENDPOINT = 'https://script.google.com/macros/s/AKfycby9yLYqCNJYxrktB-x-_Re82PkP21J5fhEfXCqy_h7Q8cQVMhmX7lfifYI_TH6t7QL5/exec';
// The access code is checked only by the server, which locks out after repeated wrong codes.
// Nothing in this public file can be used to work the code out offline.
let uploadKey = null;

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- per-device memory (recent properties) ----
function loadState() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return s;
}
let state = loadState();

// ---- access code, asked each time the app is opened ----
async function tryKey(key) {
  try {
    const r = await fetch(`${ENDPOINT}?token=${key}`).then(r => r.json());
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch { return { ok: false, error: 'offline' }; }
}
function unlock(key) {
  uploadKey = key;
  try { sessionStorage.setItem(KEY + '-key', key); } catch {}
  document.body.classList.remove('locked');
  $('lock').remove();
  setConn(true, 'Connected');
  start();
  window.dispatchEvent(new Event('unlocked'));
}
(async () => {
  let saved = null;
  try { saved = sessionStorage.getItem(KEY + '-key'); } catch {}
  if (saved && (await tryKey(saved)).ok) unlock(saved);
})();
$('lockForm').onsubmit = async e => {
  e.preventDefault();
  const btn = $('lockForm').querySelector('button');
  btn.disabled = true; $('lockMsg').textContent = 'Checking…';
  const key = await sha256('inspection-inbox-upload:' + $('pin').value);
  const r = await tryKey(key);
  btn.disabled = false;
  if (r.ok) return unlock(key);
  $('pin').value = '';
  $('lockMsg').textContent = r.error === 'offline' ? 'No connection. Try again when you have signal.'
    : r.error === 'Bad token' ? 'Wrong code. Try again.' : r.error;
};

function start() {
  $('property').value = state.lastProperty || '';
  renderRecent();
}
async function checkConnection() {
  try {
    const r = await fetch(`${ENDPOINT}?token=${uploadKey}`).then(r => r.json());
    setConn(r.ok, r.ok ? 'Connected' : 'Not connected');
  } catch { setConn(false, 'Offline'); }
}
function setConn(ok, text) {
  $('connDot').className = 'dot ' + (ok ? 'on' : 'off');
  $('connText').textContent = text;
}

// ---- property ----
function renderRecent() {
  const box = $('recent');
  box.innerHTML = '';
  for (const p of (state.recent || []).slice(0, 6)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p;
    b.onclick = () => { $('property').value = p; };
    box.appendChild(b);
  }
}
function property() {
  const p = $('property').value.trim();
  if (!p) {
    const card = $('propCard');
    card.classList.remove('need'); void card.offsetWidth; card.classList.add('need');
    $('property').focus();
    return null;
  }
  const recent = [p, ...(state.recent || []).filter(x => x !== p)].slice(0, 15);
  state = saveState({ lastProperty: p, recent });
  renderRecent();
  return p;
}

// ---- upload ----
const KIND_ICON = {
  'voice-memo': ['var(--memo-soft)', 'var(--memo)', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'],
  'checklist-scan': ['var(--scan-soft)', 'var(--scan)', '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>'],
  'note': ['var(--note-soft)', 'var(--note)', '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'],
};
function stamp() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
function toBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function addQueueItem(name, kind, prop) {
  const q = $('queue');
  if (q.querySelector('.empty')) q.innerHTML = '';
  const [bg, fg, path] = KIND_ICON[kind];
  const li = document.createElement('li');
  li.innerHTML = `<span class="k" style="background:${bg};color:${fg}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>
    <span class="n"><div></div><small></small></span><span class="pill">Uploading…</span>`;
  li.querySelector('.n div').textContent = name;
  li.querySelector('.n small').textContent = prop;
  q.prepend(li);
  return li.querySelector('.pill');
}
const sentFiles = [];
async function upload(blob, filename, kind, prop) {
  const st = addQueueItem(filename, kind, prop);
  try {
    const body = JSON.stringify({
      token: uploadKey, property: prop, kind, filename,
      mimeType: blob.type || 'application/octet-stream', data: await toBase64(blob),
    });
    // text/plain keeps this a "simple" request so Apps Script needs no CORS preflight.
    const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body })
      .then(r => r.json());
    if (!r.ok) throw new Error(r.error);
    st.textContent = '✓ Saved'; st.className = 'pill ok';
    // Remember what was sent this visit, so "Send to Claude" can attach it to the inspection.
    sentFiles.push({ driveId: r.id, name: filename, kind, property: prop });
    renderSendCard();
    return true;
  } catch (e) {
    st.textContent = 'Failed'; st.className = 'pill err';
    st.title = e.message || '';
    return false;
  }
}

// ---- voice memo: pick a file ----
$('audioFile').onchange = async e => {
  const prop = property(); if (!prop) { e.target.value = ''; return; }
  for (const f of e.target.files) {
    const ext = (f.name.match(/\.[^.]+$/) || [''])[0];
    await upload(f, `memo_${stamp()}${ext}`, 'voice-memo', prop);
  }
  e.target.value = '';
};

// ---- voice memo: record in app (pause / resume / cancel) ----
let rec = null, recStream = null, chunks = [], timerId = null, elapsed = 0, segStart = 0, recProp = '', discard = false;
const fmtTime = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function recElapsed() { return elapsed + (rec && rec.state === 'recording' ? Date.now() - segStart : 0); }
function recTick() {
  $('recTime').textContent = fmtTime(recElapsed());
  $('recSub').textContent = rec && rec.state === 'paused' ? `Paused · ${fmtTime(recElapsed())}` : `${fmtTime(recElapsed())} · recording`;
}
function recUI(on) {
  $('recPanel').classList.toggle('hidden', !on);
  $('recBtn').classList.toggle('recording', on);
  $('recTitle').textContent = on ? '● Recording' : 'Record memo';
  $('recTitle').classList.toggle('pulse', on);
  if (!on) $('recSub').textContent = 'Talk through what you see';
}
$('recBtn').onclick = async () => {
  if (rec) { $('recPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const prop = property(); if (!prop) return;
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert('Microphone access was blocked.'); return; }
  closePanels();
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  rec = new MediaRecorder(recStream, type ? { mimeType: type } : undefined);
  chunks = []; elapsed = 0; segStart = Date.now(); recProp = prop; discard = false;
  rec.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
  rec.onstop = async () => {
    recStream.getTracks().forEach(t => t.stop());
    clearInterval(timerId);
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    rec = null; chunks = [];
    recUI(false);
    $('recPanel').classList.remove('paused'); $('recPause').textContent = 'Pause'; $('recState').textContent = 'Recording';
    if (!discard) await upload(blob, `memo_${stamp()}${blob.type.includes('mp4') ? '.m4a' : '.webm'}`, 'voice-memo', recProp);
  };
  rec.start(1000);
  recUI(true);
  recTick(); timerId = setInterval(recTick, 250);
  $('recPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
$('recPause').onclick = () => {
  if (!rec) return;
  if (rec.state === 'recording') {
    rec.pause(); elapsed += Date.now() - segStart;
    $('recPause').textContent = 'Resume'; $('recState').textContent = 'Paused'; $('recPanel').classList.add('paused');
  } else if (rec.state === 'paused') {
    rec.resume(); segStart = Date.now();
    $('recPause').textContent = 'Pause'; $('recState').textContent = 'Recording'; $('recPanel').classList.remove('paused');
  }
  recTick();
};
$('recCancel').onclick = () => {
  if (!rec) return;
  if (recElapsed() > 5000 && !confirm('Delete this recording without uploading it?')) return;
  discard = true; rec.stop();
};
$('recDone').onclick = () => { if (rec) { discard = false; rec.stop(); } };

// ---- panels (upload memo / scan / note) ----
const PANELS = [['memoBtn', 'memoHelp'], ['scanBtn', 'scanPanel'], ['noteBtn', 'notePanel']];
function closePanels() { for (const [b, p] of PANELS) { $(p).classList.add('hidden'); $(b).classList.remove('active'); } }
function togglePanel(btn, panel) {
  const open = $(panel).classList.contains('hidden');
  closePanels();
  if (open) { $(panel).classList.remove('hidden'); $(btn).classList.add('active'); $(panel).scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  return open;
}
$('memoBtn').onclick = () => { if (property()) togglePanel('memoBtn', 'memoHelp'); };
$('scanBtn').onclick = () => togglePanel('scanBtn', 'scanPanel');
$('noteBtn').onclick = () => { if (togglePanel('noteBtn', 'notePanel')) $('note').focus(); };

// ---- checklist scan ----
const pages = { front: null, back: null };
async function cleanPage(file) {
  const img = await createImageBitmap(file);
  const maxW = 1700; // ~200 dpi across a letter page
  const scale = Math.min(1, maxW / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
  // grayscale + stretch contrast so pencil/pen marks read clearly
  let lo = 255, hi = 0;
  const g = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (g[j] < lo) lo = g[j]; if (g[j] > hi) hi = g[j];
  }
  const white = lo + (hi - lo) * 0.85, black = lo + (hi - lo) * 0.25;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, (g[j] - black) * 255 / (white - black)));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
function showPage(side) {
  const slot = $(side + 'Slot'), img = $(side + 'Prev'), tag = slot.querySelector('.tag');
  const has = !!pages[side];
  slot.classList.toggle('filled', has);
  img.classList.toggle('hidden', !has); tag.classList.toggle('hidden', !has);
  if (has) img.src = pages[side].toDataURL('image/jpeg', 0.6); else img.removeAttribute('src');
  $('sendScan').disabled = !(pages.front && pages.back);
  $('sendScan').textContent = pages.front && pages.back ? 'Upload scan (2 pages)' : `Take the ${pages.front ? 'back' : 'front'} photo`;
}
for (const side of ['front', 'back']) {
  $(side + 'Img').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    pages[side] = await cleanPage(f);
    showPage(side);
    e.target.value = '';
  };
}
showPage('front');
$('sendScan').onclick = async () => {
  const prop = property(); if (!prop) return;
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'in', format: 'letter' });
  ['front', 'back'].forEach((side, i) => {
    const c = pages[side];
    if (i) pdf.addPage();
    const r = Math.min(8.5 / c.width, 11 / c.height);
    const w = c.width * r, h = c.height * r;
    pdf.addImage(c.toDataURL('image/jpeg', 0.82), 'JPEG', (8.5 - w) / 2, (11 - h) / 2, w, h);
  });
  $('sendScan').disabled = true;
  if (await upload(pdf.output('blob'), `checklist-scan_${stamp()}.pdf`, 'checklist-scan', prop)) {
    pages.front = pages.back = null;
    showPage('front'); showPage('back');
  } else {
    $('sendScan').disabled = false;
  }
};

// ---- quick note ----
$('sendNote').onclick = async () => {
  const text = $('note').value.trim(); if (!text) { $('note').focus(); return; }
  const prop = property(); if (!prop) return;
  if (await upload(new Blob([text], { type: 'text/plain' }), `note_${stamp()}.txt`, 'note', prop)) $('note').value = '';
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
