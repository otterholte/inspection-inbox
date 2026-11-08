const $ = id => document.getElementById(id);
const KEY = 'inspection-inbox-v1';

// ---- access code, asked each time the app is opened ----
// Only the SHA-256 of the code lives in this public repo.
const PIN_HASH = 'b4a906ff5d63dd73f46a93d31d43b493da0c06d4e1e071d84584e3a1d550feae';
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function unlock() { document.body.classList.remove('locked'); $('lock').remove(); }
try { if (sessionStorage.getItem(KEY + '-unlocked') === PIN_HASH) unlock(); } catch {}
$('lockForm').onsubmit = async e => {
  e.preventDefault();
  if (await sha256($('pin').value) === PIN_HASH) {
    try { sessionStorage.setItem(KEY + '-unlocked', PIN_HASH); } catch {}
    unlock();
  } else {
    $('lockMsg').textContent = 'Wrong code.';
    $('pin').value = '';
  }
};

// ---- per-device settings (only ever stored in this phone's browser) ----
function loadState() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return s;
}
let state = loadState();
$('endpoint').value = state.endpoint || '';
$('token').value = state.token || '';
$('property').value = state.lastProperty || '';
renderRecent();
if (!state.endpoint || !state.token) $('settings').classList.remove('hidden');

$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('saveSettings').onclick = () => {
  state = saveState({ endpoint: $('endpoint').value.trim(), token: $('token').value.trim() });
  $('settingsStatus').textContent = 'Saved.';
};
$('testSettings').onclick = async () => {
  $('settingsStatus').textContent = 'Testing…';
  try {
    const url = new URL($('endpoint').value.trim());
    url.searchParams.set('token', $('token').value.trim());
    const r = await fetch(url).then(r => r.json());
    $('settingsStatus').textContent = r.ok ? `Connected. Files go to “${r.root}” in Google Drive.` : `Error: ${r.error}`;
  } catch (e) {
    $('settingsStatus').textContent = 'Could not reach the upload URL.';
  }
};

function renderRecent() {
  $('recentProps').innerHTML = (state.recent || []).map(p => `<option value="${p.replace(/"/g, '&quot;')}">`).join('');
}
function property() {
  const p = $('property').value.trim();
  if (!p) { alert('Enter the property address first.'); $('property').focus(); return null; }
  const recent = [p, ...(state.recent || []).filter(x => x !== p)].slice(0, 15);
  state = saveState({ lastProperty: p, recent });
  renderRecent();
  return p;
}

// ---- upload ----
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
function addQueueItem(name) {
  const q = $('queue');
  if (q.querySelector('.muted')) q.innerHTML = '';
  const li = document.createElement('li');
  li.innerHTML = `<span></span><span class="st">Uploading…</span>`;
  li.firstChild.textContent = name;
  q.prepend(li);
  return li.querySelector('.st');
}
async function upload(blob, filename, kind, prop) {
  if (!state.endpoint || !state.token) {
    $('settings').classList.remove('hidden');
    alert('Add the upload URL and token in Settings first.');
    return false;
  }
  const st = addQueueItem(filename);
  try {
    const body = JSON.stringify({
      token: state.token, property: prop, kind, filename,
      mimeType: blob.type || 'application/octet-stream', data: await toBase64(blob),
    });
    // text/plain keeps this a "simple" request so Apps Script needs no CORS preflight.
    const r = await fetch(state.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body })
      .then(r => r.json());
    if (!r.ok) throw new Error(r.error);
    st.textContent = '✓ Saved'; st.className = 'st st-ok';
    return true;
  } catch (e) {
    st.textContent = '✗ ' + (e.message || 'Failed'); st.className = 'st st-err';
    return false;
  }
}

// ---- voice memo: pick files ----
$('audioFile').onchange = async e => {
  const prop = property(); if (!prop) { e.target.value = ''; return; }
  for (const f of e.target.files) {
    const ext = (f.name.match(/\.[^.]+$/) || [''])[0];
    await upload(f, `memo_${stamp()}${ext}`, 'voice-memo', prop);
  }
  e.target.value = '';
};

// ---- voice memo: record in app ----
let rec = null, chunks = [], timerId = null, startedAt = 0;
$('recBtn').onclick = async () => {
  if (rec) { rec.stop(); return; }
  const prop = property(); if (!prop) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert('Microphone access was blocked.'); return; }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  chunks = [];
  rec.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(timerId); $('recTimer').textContent = '';
    $('recBtn').textContent = '🎤 Record'; $('recBtn').classList.remove('rec');
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    rec = null;
    const ext = blob.type.includes('mp4') ? '.m4a' : '.webm';
    await upload(blob, `memo_${stamp()}${ext}`, 'voice-memo', prop);
  };
  rec.start(1000);
  startedAt = Date.now();
  $('recBtn').textContent = '■ Stop & upload'; $('recBtn').classList.add('rec');
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('recTimer').textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
};

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
for (const side of ['front', 'back']) {
  $(side + 'Img').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    pages[side] = await cleanPage(f);
    $(side + 'Prev').src = pages[side].toDataURL('image/jpeg', 0.6);
    $('sendScan').disabled = !(pages.front && pages.back);
    e.target.value = '';
  };
}
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
  const ok = await upload(pdf.output('blob'), `checklist-scan_${stamp()}.pdf`, 'checklist-scan', prop);
  if (ok) {
    pages.front = pages.back = null;
    $('frontPrev').removeAttribute('src'); $('backPrev').removeAttribute('src');
  } else {
    $('sendScan').disabled = false;
  }
};

// ---- quick note ----
$('sendNote').onclick = async () => {
  const text = $('note').value.trim(); if (!text) return;
  const prop = property(); if (!prop) return;
  if (await upload(new Blob([text], { type: 'text/plain' }), `note_${stamp()}.txt`, 'note', prop)) $('note').value = '';
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
