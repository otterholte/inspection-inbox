// Inspection Desk tab: open/completed inspections, the owner email draft and the evidence behind it.
// Data lives in Drive behind the same Apps Script (actions desk.*); requests are jobs for Claude Code on the PC.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RUN_HINT = 'Claude starts on this within about 30 seconds while your PC is on; bigger jobs like processing a new inspection can take 10–20 minutes.';
const REQUESTS = {
  process: 'Process the checklist and run the AppFolio audit',
  link: 'Get the Z Inspector link',
  call: 'Add the follow-up call to your work calendar (tentative)',
  email: 'Open AppFolio and draft the owner email (not sent)',
  checklist: 'Fill out and initial the 2026 checklist PDF',
  docs: 'Upload the checklist to AppFolio (tenant + property, Inspections folder)',
};
const STEPS = [
  ['processed', 'Checklist processed and AppFolio audited', 'process'],
  ['zinspector', 'Notes added in Z Inspector and inspection submitted', null],
  ['link', 'Z Inspector link added to the email', 'link'],
  ['call', 'Follow-up call on your calendar', 'call'],
  ['email', 'Owner email drafted in AppFolio', 'email'],
  ['checklist', '2026 checklist filled out and initialed', 'checklist'],
  ['docs', 'Checklist uploaded to AppFolio', 'docs'],
  ['sent', 'Email sent', null],
];

async function api(action, body = {}) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: uploadKey, ...body }) }).then(r => r.json());
  if (!r.ok) throw new Error(r.error || 'Request failed');
  return r;
}

const D = { docs: [], filter: 'open', current: null, dirty: false, poll: null };
try { D.filter = localStorage.getItem('desk-filter') || 'open'; D.missing = localStorage.getItem('desk-missing') || ''; } catch {}
// Quick filters for audit gaps; they narrow whichever of Open / Completed / All is picked.
const GAPS = ['Utilities', 'Insurance', 'Pets'];
const hasGap = (d, label) => (d.checks || []).some(c => c.label === label && c.status === 'No');
const flags = d => d.steps || {};
// Done = email sent AND checklist uploaded to AppFolio, unless Eli marked it completed (or reopened it) by hand.
const isDone = d => flags(d).completed ?? !!(flags(d).sent && flags(d).docs);
const queuedCount = d => Object.values(d.requests || {}).filter(r => r.state === 'queued').length;
function statusOf(d) {
  if (isDone(d)) return ['Completed', 'st-done'];
  if (d.draft) return [`Draft · ${d.uploads ? d.uploads + ' file' + (d.uploads > 1 ? 's' : '') + ', ' : ''}not sent to Claude yet`, 'st-open'];
  const q = queuedCount(d);
  if (q) {
    const live = Object.values(d.requests || {}).filter(r => r.state === 'queued' && r.progress).sort((a, b) => String(b.progressAt).localeCompare(String(a.progressAt)))[0];
    return [live ? `Claude: ${live.progress}` : `Waiting on Claude (${q})`, 'st-wait'];
  }
  const next = STEPS.find(([k]) => !flags(d)[k]);
  return [next ? 'Next: ' + next[1].split(' and ')[0] : 'Open', 'st-open'];
}
const deskEl = () => document.getElementById('deskView');

// ---------- images: fetched once from Drive, then kept as object URLs ----------
const imgCache = new Map();
function loadImage(id) {
  if (!imgCache.has(id)) imgCache.set(id, api('desk.image', { id }).then(r => {
    const bytes = Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: r.mimeType }));
  }));
  return imgCache.get(id);
}
function hydrateImages(root) {
  root.querySelectorAll('img[data-img]').forEach(img => {
    loadImage(img.dataset.img).then(u => { img.src = u; }).catch(() => { img.alt = 'Image unavailable'; });
  });
}
function evHtml(list) {
  const seen = new Set();
  return `<div class="ev">${(list || []).filter(e => e && e.img && !seen.has(e.img) && seen.add(e.img)).map(e =>
    `<button data-ev="${esc(JSON.stringify(e))}"><img data-img="${esc(e.img)}" alt=""><span>${esc(e.caption)}</span></button>`).join('')}</div>`;
}
function wireEvidence(root) {
  root.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => openLightbox(JSON.parse(b.dataset.ev)));
  hydrateImages(root);
}
function openLightbox(e) {
  const lb = $('lightbox');
  $('lbImg').removeAttribute('src');
  $('lbImg').classList.remove('zoomed');
  $('lbImg').onclick = () => $('lbImg').classList.toggle('zoomed');
  loadImage(e.img).then(u => { $('lbImg').src = u; });
  $('lbCaption').textContent = e.caption || '';
  $('lbHi').textContent = e.highlight || 'No highlight on this screenshot.';
  $('lbFound').textContent = e.finding || e.caption || '';
  lb.classList.remove('hidden');
  history.pushState({ view: 'lightbox' }, '');
}
function closeLightbox() { $('lightbox').classList.add('hidden'); }

// ---------- list ----------
async function deskList() {
  D.current = null; stopPoll();
  setBar('Inspection Desk', 'Open and completed inspections');
  deskEl().innerHTML = '<section class="card empty"><p class="hint">Loading inspections…</p></section>';
  try { D.docs = (await api('desk.list')).docs; }
  catch (e) { deskEl().innerHTML = `<section class="card empty"><p class="hint">Couldn't load inspections (${esc(e.message)}). Pull down or reopen to try again.</p></section>`; return; }
  renderDeskList();
}
// Select mode: tap to pick, shift-click for a range, then download the picked checklists as one PDF.
D.sel = new Set(); D.selMode = false; D.lastPick = null;
let listPoll = null;
function renderDeskList() {
  clearInterval(listPoll);
  if (D.docs.some(queuedCount)) listPoll = setInterval(async () => {
    if (D.current || document.hidden || deskEl().classList.contains('hidden') || D.selMode) return;
    try { D.docs = (await api('desk.list')).docs; renderDeskList(); } catch {}
  }, 20000);
  const inTab = d => D.filter === 'all' ? true : D.filter === 'open' ? !isDone(d) : isDone(d);
  const shown = D.docs.filter(d => inTab(d) && (!D.missing || hasGap(d, D.missing)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const counts = { open: D.docs.filter(d => !isDone(d)).length, completed: D.docs.filter(isDone).length, all: D.docs.length };
  const queued = D.docs.reduce((n, d) => n + queuedCount(d), 0);
  const picked = [...D.sel].filter(id => shown.some(d => d._id === id));
  const pickedPdfs = picked.filter(id => D.docs.find(d => d._id === id)?.checklistPdf);
  deskEl().innerHTML = `
    <button class="primary p-new" id="newInsp">+ New inspection</button>
    ${queued ? `<div class="banner">${queued} request${queued > 1 ? 's' : ''} waiting for Claude. ${RUN_HINT}</div>` : ''}
    <div class="listbar">
      <div class="seg-tabs" role="group" aria-label="Filter">
        ${['open', 'completed', 'all'].map(k => `<button data-f="${k}" aria-pressed="${D.filter === k}">${k[0].toUpperCase() + k.slice(1)} · ${counts[k]}</button>`).join('')}
      </div>
      ${shown.length ? `<button class="linkbtn" id="selToggle">${D.selMode ? 'Done' : 'Select'}</button>` : ''}
    </div>
    <div class="gapbar" role="group" aria-label="Show only inspections missing">
      <span>Missing:</span>
      ${GAPS.map(g => `<button data-gap="${g}" aria-pressed="${D.missing === g}">${g} · ${D.docs.filter(d => inTab(d) && hasGap(d, g)).length}</button>`).join('')}
    </div>
    ${D.selMode ? `<div class="selbar"><span>${picked.length} selected${D.filter !== 'completed' ? '' : ''}</span>
      <button class="linkbtn" id="selAll">${picked.length === shown.length ? 'Clear' : 'Select all'}</button></div>
      <p class="hint" style="margin:-6px 0 0">Tap to pick. On a computer, shift-click picks everything in between.</p>` : ''}
    ${shown.length ? shown.map(d => {
      const [label, cls] = statusOf(d);
      const chips = (d.checks || []).map(c => `<span class="chip ${c.status === 'Yes' || c.status === 'No' ? c.status : 'NA'}">${esc(c.label)}: ${esc(c.status)}</span>`).join('');
      const on = D.sel.has(d._id);
      return `<button class="item${D.selMode ? ' selectable' : ''}${on ? ' picked' : ''}" data-id="${esc(d._id)}" ${D.selMode ? `aria-pressed="${on}"` : ''}>
        <span class="top">${D.selMode ? `<span class="tick" aria-hidden="true">${on ? '✓' : ''}</span>` : ''}<strong>${esc(d.property)}</strong><span class="status ${cls}">${esc(label)}</span></span>
        <span class="meta">${esc(d.ownerName || 'Owner not looked up yet')} · inspected ${esc(fmtShort(d.date))}${D.selMode && !d.checklistPdf ? ' · no checklist yet' : ''}</span>
        ${chips ? `<span class="chipsrow">${chips}</span>` : ''}</button>`;
    }).join('') : `<section class="card empty"><p class="hint">${D.docs.length ? (D.missing ? `Nothing here is missing ${D.missing.toLowerCase()}.` : 'Nothing in this list.') : 'No inspections yet. Tap + New inspection to add one.'}</p></section>`}
    ${D.selMode ? `<div class="dlbar"><button class="primary" id="dlBtn" ${pickedPdfs.length ? '' : 'disabled'}>Download ${pickedPdfs.length || ''} checklist${pickedPdfs.length === 1 ? '' : 's'} as one PDF</button>
      <p class="hint" id="dlMsg">${picked.length > pickedPdfs.length ? `${picked.length - pickedPdfs.length} picked inspection${picked.length - pickedPdfs.length > 1 ? 's have' : ' has'} no checklist yet and will be skipped.` : ''}</p></div>` : ''}`;
  $('newInsp').onclick = () => { history.pushState({ view: 'inbox' }, ''); openInbox(); };
  deskEl().querySelectorAll('[data-gap]').forEach(b => b.onclick = () => {
    D.missing = D.missing === b.dataset.gap ? '' : b.dataset.gap;
    try { localStorage.setItem('desk-missing', D.missing); } catch {}
    renderDeskList();
  });
  deskEl().querySelectorAll('[data-f]').forEach(b => b.onclick = () => { D.filter = b.dataset.f; try { localStorage.setItem('desk-filter', D.filter); } catch {} renderDeskList(); });
  if ($('selToggle')) $('selToggle').onclick = () => { D.selMode = !D.selMode; if (!D.selMode) D.sel.clear(); D.lastPick = null; renderDeskList(); };
  if ($('selAll')) $('selAll').onclick = () => {
    if (picked.length === shown.length) shown.forEach(d => D.sel.delete(d._id)); else shown.forEach(d => D.sel.add(d._id));
    renderDeskList();
  };
  if ($('dlBtn')) $('dlBtn').onclick = () => downloadChecklists(pickedPdfs.map(id => D.docs.find(d => d._id === id)));
  deskEl().querySelectorAll('.item').forEach((b, i) => b.onclick = e => {
    const doc = D.docs.find(d => d._id === b.dataset.id);
    if (!D.selMode && doc?.draft) { history.pushState({ view: 'inbox' }, ''); openInbox(doc.property, doc.date); return; }
    if (!D.selMode) { history.pushState({ view: 'detail', id: b.dataset.id }, ''); openDetail(b.dataset.id); return; }
    const id = b.dataset.id, turnOn = !D.sel.has(id);
    if (e.shiftKey && D.lastPick != null) {
      const [lo, hi] = [Math.min(D.lastPick, i), Math.max(D.lastPick, i)];
      shown.slice(lo, hi + 1).forEach(d => turnOn ? D.sel.add(d._id) : D.sel.delete(d._id));
    } else turnOn ? D.sel.add(id) : D.sel.delete(id);
    D.lastPick = i;
    const y = window.scrollY; renderDeskList(); window.scrollTo(0, y);
  });
}

// One printable PDF: each picked inspection's filled checklist, oldest inspection first.
async function downloadChecklists(docs) {
  const btn = $('dlBtn'), msg = t => { if ($('dlMsg')) $('dlMsg').textContent = t; };
  busy(btn, 'Building the PDF…');
  try {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    const ordered = [...docs].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const [n, d] of ordered.entries()) {
      msg(`Adding ${d.property} (${n + 1} of ${ordered.length})…`);
      const r = await api('desk.image', { id: d.checklistPdf });
      const src = await PDFDocument.load(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
      (await out.copyPages(src, src.getPageIndices())).forEach(pg => out.addPage(pg));
    }
    const bytes = await out.save({ useObjectStreams: false });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = `inspection-checklists_${todayStr()}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    msg(`Done: ${ordered.length} checklist${ordered.length > 1 ? 's' : ''}, ${out.getPageCount()} pages. On a phone it opens in a viewer; use Share → Print.`);
  } catch (e) { msg('Couldn\'t build it: ' + e.message); }
  unbusy(btn);
}

// ---------- new inspection: the Inbox screen ----------
const slugify = (p, d) => (p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property') + '_' + d;
const todayStr = () => { const t = new Date(), z = n => String(n).padStart(2, '0'); return `${t.getFullYear()}-${z(t.getMonth() + 1)}-${z(t.getDate())}`; };
function openInbox(prop, date) {
  stopPoll();
  D.inboxFor = prop ? { prop, date } : null;
  D.draft = null;
  $('property').value = prop || '';
  $('inspDate').value = date || todayStr();
  $('queue').innerHTML = '<li class="empty">Nothing uploaded yet.</li>';
  setBar(prop ? 'Add to ' + prop : 'New inspection', 'Record, upload or scan, then send it to Claude');
  showView('inbox');
  renderSendCard();
  if (prop) loadDraft();
}
// ---- drafts: the Inbox saves itself to the Desk as soon as there's an address, so it can be finished on another device ----
let draftChain = Promise.resolve();
const draftId = () => { const p = $('property').value.trim(); return p ? slugify(p, $('inspDate').value || todayStr()) : null; };
function draftSave(upload) {
  const prop = $('property').value.trim(), date = $('inspDate').value || todayStr();
  if (!prop) return draftChain;
  draftChain = draftChain.then(async () => {
    const id = slugify(prop, date), now = new Date().toISOString();
    for (let tries = 0; tries < 3; tries++) {
      let doc = null;
      try { doc = (await api('desk.get', { slug: id })).doc; } catch {}
      try {
        if (!doc) {
          await api('desk.set', { slug: id, doc: { property: prop, date, ownerName: '', steps: {}, uploads: upload ? [upload] : [],
            draft: true, requests: {}, createdAt: now, updatedAt: now } });
        } else if (upload && !(doc.uploads || []).some(u => u.driveId === upload.driveId)) {
          await api('desk.update', { slug: id, ifVersion: doc._version, patch: { uploads: [...(doc.uploads || []), upload], updatedAt: now } });
        }
        break;
      } catch (e) { if (!/version/i.test(e.message)) break; }
    }
    if (draftId() === id) await loadDraft(!!upload);
  }).catch(() => {});
  return draftChain;
}
function draftUpload(prop, upload) { if (prop === $('property').value.trim()) draftSave(upload); }
// Shows what's already saved for this address and date (from this device or another one).
async function loadDraft(quiet) {
  const id = draftId(); if (!id) return;
  let doc = null;
  try { doc = (await api('desk.get', { slug: id })).doc; } catch {}
  if (draftId() !== id) return;
  D.draft = doc && doc.draft ? doc : null;
  if (!quiet && D.draft && (D.draft.uploads || []).length) {
    const q = $('queue'); q.innerHTML = '';
    for (const u of D.draft.uploads) { const st = addQueueItem(u.name, KIND_ICON[u.kind] ? u.kind : 'note', D.draft.property); st.textContent = '✓ Saved'; st.className = 'pill ok'; }
  }
  renderSendCard();
}
$('property').addEventListener('change', () => { if (draftId()) draftSave(); });
$('inspDate').addEventListener('change', () => loadDraft());
function renderSendCard() {
  if (!$('sendBtn')) return;
  const prop = $('property').value.trim();
  const saved = D.draft && D.draft.property === prop ? D.draft.uploads || [] : [];
  const mine = [...saved, ...sentFiles.filter(f => f.property === prop && !saved.some(u => u.driveId === f.driveId))];
  $('sendBtn').disabled = !prop || !mine.length;
  $('draftNote').innerHTML = D.draft ? `Saved as a draft. You can finish it on any device from the Desk. <button class="linkbtn" id="dropDraft">Delete draft</button>` : '';
  if ($('dropDraft')) $('dropDraft').onclick = async () => {
    if (!confirm('Delete this draft? Files you uploaded stay in Drive.')) return;
    try { await api('desk.deleteDraft', { slug: draftId() }); D.draft = null; history.back(); } catch (e) { $('sendMsg').textContent = e.message; }
  };
  $('sendHint').textContent = !prop ? 'Type the property address in Step 1.'
    : mine.length ? `${mine.length} file${mine.length > 1 ? 's' : ''} ready for ${prop}. Claude reads them, looks up the owner, audits AppFolio and drafts everything.`
    : 'Add a memo, scan or note above first.';
}
$('property').addEventListener('input', renderSendCard);
$('inboxBack').onclick = () => history.back();
$('sendBtn').onclick = async () => {
  const prop = $('property').value.trim(), date = $('inspDate').value || todayStr();
  if (!prop) return;
  $('sendBtn').disabled = true; $('sendMsg').textContent = 'Sending…';
  await draftChain;
  const files = sentFiles.filter(f => f.property === prop);
  if (!files.length && !(D.draft?.uploads || []).length) { $('sendMsg').textContent = 'Add a memo, scan or note first.'; renderSendCard(); return; }
  const id = slugify(prop, date), now = new Date().toISOString();
  const uploads = files.map(({ driveId, name, kind }) => ({ driveId, name, kind }));
  try {
    let existing = null;
    try { existing = (await api('desk.get', { slug: id })).doc; } catch {}
    if (existing) {
      const have = existing.uploads || [];
      await api('desk.update', { slug: id, ifVersion: existing._version, patch: {
        uploads: [...have, ...uploads.filter(u => !have.some(h => h.driveId === u.driveId))], updatedAt: now, draft: { __delete__: true },
        requests: { ...(existing.requests || {}), process: { state: 'queued', at: now } } } });
    } else {
      await api('desk.set', { slug: id, doc: { property: prop, date, ownerName: '', steps: {}, uploads,
        requests: { process: { state: 'queued', at: now } }, createdAt: now, updatedAt: now } });
    }
    for (const f of files) sentFiles.splice(sentFiles.indexOf(f), 1);
    $('queue').innerHTML = '<li class="empty">Nothing uploaded yet.</li>';
    $('sendMsg').textContent = '';
    history.replaceState({ view: 'detail', id }, '');
    showView('desk'); openDetail(id);
  } catch (e) { $('sendMsg').textContent = 'Couldn\'t send it: ' + e.message; $('sendBtn').disabled = false; }
};

// ---------- detail ----------
async function openDetail(id) {
  stopPoll();
  D.current = { id, data: null }; D.dirty = false;
  deskEl().innerHTML = '<section class="card empty"><p class="hint">Loading…</p></section>';
  try { D.current.data = (await api('desk.get', { slug: id })).doc; }
  catch (e) { deskEl().innerHTML = `<section class="card empty"><p class="hint">Couldn't load this inspection (${esc(e.message)}).</p></section>`; return; }
  renderDetail();
  // Pick up Claude's work while the page is open.
  D.poll = setInterval(async () => {
    if (!D.current || D.current.id !== id || D.dirty || document.hidden || !$('lightbox').classList.contains('hidden')) return;
    try {
      const fresh = (await api('desk.get', { slug: id })).doc;
      if (fresh._version !== D.current.data._version && !D.dirty) { D.current.data = fresh; renderDetail(true); }
    } catch {}
  }, 15000);
}
// "just now", "2 min ago": a still-moving clock shows the page is alive.
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m === 1 ? '1 min ago' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
}
function stopPoll() { clearInterval(D.poll); D.poll = null; }
function reqBlock(key, label, enabled = true) {
  const r = (D.current.data.requests || {})[key];
  const queued = r?.state === 'queued';
  const live = queued && r.progress
    ? `<div class="live"><span class="pulse-dot"></span><span><b>${esc(r.progress)}</b><small>${ago(r.progressAt)}</small></span></div>` : '';
  return `${queued ? `<div class="waiting">${live ? 'Claude is working on' : 'Waiting for Claude:'} ${esc(REQUESTS[key])}.${live ? '' : ' ' + RUN_HINT}${live}</div>` : ''}
    ${r?.state === 'done' && r.note ? `<div class="doneMsg">${esc(r.note)}</div>` : ''}
    ${r?.state === 'failed' ? `<div class="waiting">Claude couldn't finish this${r.note ? ': ' + esc(r.note) : ''}. Tap to try again.</div>` : ''}
    <button class="primary" data-req="${key}" ${queued || !enabled ? 'disabled' : ''}>${esc(label)}</button>`;
}
function renderDetail(keepScroll) {
  const y = window.scrollY;
  const d = D.current.data, f = d.fields || {}, ev = d.evidence || {}, st = flags(d);
  setBar(d.property, `${d.ownerName || 'Owner not looked up yet'} · inspected ${fmtShort(d.date)}`);
  const nextIdx = STEPS.findIndex(([k]) => !st[k]);
  const steps = `<ol class="progress">${STEPS.map(([k, label, req], i) => {
    const queued = req && (d.requests || {})[req]?.state === 'queued';
    const cls = st[k] ? 'done' : queued ? 'wait' : i === nextIdx ? 'now' : '';
    return `<li class="${cls}"><span class="mk">${st[k] ? '✓' : i + 1}</span><span><b>${label}</b>${queued ? '<small>Waiting for Claude</small>' : ''}</span></li>`;
  }).join('')}</ol>`;
  const back = '<button class="sec backbtn" id="deskBack">← All inspections</button>';

  if (!st.processed) {
    deskEl().innerHTML = `${back}
      <section class="card"><h2>Progress</h2>${steps}</section>
      <section class="card"><h2>Checklist</h2>
        ${(d.uploads || []).length ? `<ul class="plain">${d.uploads.map(u => `<li>${esc(u.name)}</li>`).join('')}</ul>` : '<p class="hint">No files attached. Claude will look for a scan or memo in your Drive inbox.</p>'}
        ${d.intakeNotes ? `<p class="hint">${esc(d.intakeNotes)}</p>` : ''}
        ${reqBlock('process', 'Process this inspection')}
      </section>`;
    wireDetail(); return;
  }
  const items = d.maintenance || [];
  const recs = (d.recs || []).length ? d.recs : [['', '']];
  deskEl().innerHTML = `${back}
    <section class="card"><h2>Progress</h2>${steps}
      ${d.goodCondition === false ? '<p class="warnbox">Not in good condition: issue a violation and a follow-up inspection before sending the report.</p>' : ''}
      <p class="saved" id="saved">${d.updatedAt ? 'Saved ' + new Date(d.updatedAt).toLocaleString() : ''}</p>
    </section>

    <section class="card"><h2>What you saw <span class="pilltag">in the email</span></h2>
      <textarea id="review" aria-label="What you saw">${esc(f.review)}</textarea>
      ${(ev.review || []).length ? `<span class="src">Where this came from</span>${evHtml(ev.review)}` : ''}
      <button class="sec" id="addMore">+ Add a memo, scan or note</button>
    </section>

    <section class="card"><h2>Maintenance items <span class="pilltag">for Z Inspector</span></h2>
      <div id="items">${items.map(itemRow).join('')}</div>
      <button class="sec" id="addItem">+ Add item</button>
      ${(ev.maintenance || []).length ? `<span class="src">Where this came from</span>${evHtml(ev.maintenance)}` : ''}
    </section>

    <section class="card"><h2>Recommendations <span class="pilltag">in the email</span></h2>
      <div id="recs">${recs.map(recRow).join('')}</div>
      <datalist id="tfs"><option value="Now"><option value="At turnover"><option value="This spring"><option value="Before winter"><option value="When it fails"><option value="Within 1–2 years"></datalist>
      <button class="sec" id="addRec">+ Add recommendation</button>
      ${(ev.recs || []).length ? `<span class="src">Where this came from</span>${evHtml(ev.recs)}` : ''}
    </section>

    <section class="card"><h2>Tenant notes <span class="pilltag">just for you</span></h2>
      <textarea id="tenant" aria-label="Tenant notes">${esc(f.tenant)}</textarea>
      ${(ev.tenant || []).length ? `<span class="src">Where this came from</span>${evHtml(ev.tenant)}` : ''}
    </section>

    ${(d.audit || []).length ? `<section class="card"><h2>Audit checks</h2>
      <div class="audit">${d.audit.map((a, i) => `<div class="${a.status === 'Yes' || a.status === 'No' ? a.status : 'NA'}"><span>${esc(a.label)}${a.detail ? ' — ' + esc(a.detail) : ''}
        <span class="arow">${a.status !== 'Yes' ? `<button class="linkbtn" data-aok="${i}">✓ It's fine</button>` : `<button class="linkbtn" data-ano="${i}">Mark as a problem</button>`}<button class="linkbtn" data-arm="${i}">Remove</button></span></span><strong>${esc(a.status)}</strong></div>`).join('')}</div>
      <p class="hint">Tap “It's fine” when something checks out, or Remove for things you don't track. The list's Utilities / Insurance / Pets chips update too.</p>
      ${(ev.audit || []).length ? `<span class="src">Where this came from</span>${evHtml(ev.audit)}` : ''}
      ${(ev.property || []).length ? `<span class="src">Property pages</span>${evHtml(ev.property)}` : ''}
    </section>` : ''}

    <section class="card"><h2>Z Inspector notes</h2>
      <p class="hint">Tap the text to edit it. Copy it into the inspection's notes in Z Inspector, submit it, then tap the green button.</p>
      <textarea class="edit-box" id="zText" aria-label="Z Inspector notes"></textarea>
      <p class="hint" id="zEdited"></p>
      <button class="sec" id="copyZ">Copy notes</button>
      <button class="primary" id="zDone" ${st.zinspector ? 'disabled' : ''}>${st.zinspector ? '✓ In Z Inspector and submitted' : 'It\'s in Z Inspector and submitted'}</button>
      ${st.zinspector ? reqBlock('link', st.link ? 'Find the link again' : 'Get the Z Inspector link') : ''}
      <p class="saved" id="zMsg"></p>
    </section>

    <section class="card"><h2>Follow-up call</h2>
      ${d.call?.booked ? `<div class="doneMsg">On your calendar: ${esc(d.call.booked)}</div>` : ''}
      ${d.call?.booked ? reminderLine(d) : ''}
      <div class="grid2">
        <div><label for="callDate">Wednesday</label><input type="date" id="callDate" value="${esc(d.call?.date || nextWeekday(3, 2))}"></div>
        <div><label for="callTime">Time</label><input type="time" id="callTime" value="${esc(d.call?.time || '10:00')}"></div>
      </div>
      <label for="altDate">Also free (Friday)</label><input type="date" id="altDate" value="${esc(d.call?.alt || nextWeekday(5, 3))}">
      <p class="hint">Books right away: a 30-minute tentative invite on your work calendar with the owner's name and phone number. If this time is taken it moves to the next free half hour between 10 and 4.</p>
      ${d.requests?.call?.state === 'done' && d.requests.call.note ? `<div class="doneMsg">${esc(d.requests.call.note)}</div>` : ''}
      <button class="primary" id="bookCall">${d.call?.booked ? 'Move it to this time' : 'Sounds good, add it to my calendar'}</button>
      <p class="hint" id="callMsg"></p>
    </section>

    <section class="card"><h2>Email to the owner</h2>
      <label for="owner">Greeting</label><input type="text" id="owner" value="${esc(f.owner)}">
      ${d.ownerUrl ? `<a class="sec ownerlink" href="${esc(d.ownerUrl)}" target="_blank" rel="noopener">Open ${esc(d.ownerName || 'the owner')} in AppFolio ↗</a>` : ''}
      <label for="subjectText">Subject</label>
      <div class="mline"><input type="text" id="subjectText" value="${esc(`Inspection – ${d.property}`)}" aria-label="Email subject">
        <button class="sec" id="copySubject" type="button">Copy</button></div>
      <label for="goAhead">If they don't need a call, I'll schedule…</label>
      <input type="text" id="goAhead" value="${esc(f.goAhead ?? defaultGoAhead(d.recs || []))}" placeholder="e.g. the patio door lock repair (leave blank to skip)">
      <label for="emailText">Message</label>
      <textarea class="edit-box" id="emailText" aria-label="Email to the owner" style="min-height:320px"></textarea>
      <p class="hint" id="emailEdited"></p>
      <button class="sec" id="copyBody">Copy message</button>
      ${reqBlock('email', st.email ? 'Draft it again in AppFolio' : 'Draft it in AppFolio', !!st.link)}
      ${st.link ? '' : '<p class="hint">Available once the Z Inspector link is in.</p>'}
      <p class="hint" style="margin-top:4px">Did it yourself from another device? Tap one; Claude then updates the checklist to match.</p>
      <div class="grid2">
        <button class="sec" id="iDrafted" ${st.email ? 'disabled' : ''}>${st.email ? '✓ Drafted' : 'I drafted it'}</button>
        <button class="sec" id="iSent" ${st.sent ? 'disabled' : ''}>${st.sent ? '✓ Sent' : 'I sent it'}</button>
      </div>
      <p class="saved" id="copyMsg"></p>
    </section>

    ${(d.activity || []).length ? `<section class="card"><h2>Claude's work log <span class="pilltag">${d.activity.length} action${d.activity.length > 1 ? 's' : ''}</span></h2>
      ${[...d.activity].sort((x, y) => String(y.at).localeCompare(String(x.at))).map((a, i) => `<details class="logitem" ${i >= 3 ? 'data-older hidden' : ''}>
        <summary><b>${esc(a.action)}</b> <span class="hint">· ${esc(new Date(a.at).toLocaleString())}</span></summary>
        ${a.detail ? `<p class="hint">${esc(a.detail)}</p>` : ''}${evHtml(a.evidence)}</details>`).join('')}
      ${d.activity.length > 3 ? `<button class="linkbtn" id="logAll">Show all ${d.activity.length} actions</button>` : ''}
    </section>` : ''}

    <section class="card"><h2>Wrap up</h2>
      ${d.checklistPdf ? `<button class="sec" id="pdfBtn">Open the filled checklist (PDF)</button>` : ''}
      ${(d.checklistPages || []).length ? evHtml(d.checklistPages) : ''}
      ${d.checklistSpec
        ? `${d.requests?.checklist?.state === 'done' && d.requests.checklist.note ? `<div class="doneMsg">${esc(d.requests.checklist.note)}</div>` : ''}
           <button class="primary" id="ckNow">${st.checklist ? 'Update the checklist now' : 'Fill out the checklist now'}</button>
           <p class="hint" id="ckMsg">Takes about 10 seconds. It keeps everything from your inspection and marks what's done since, like the email and upload lines.</p>`
        : reqBlock('checklist', 'Fill out the 2026 checklist')}
      ${reqBlock('docs', st.docs ? 'Upload the latest checklist again' : 'Upload the checklist to AppFolio', !!st.checklist)}
      <p class="hint">Claude uploads it to the tenant page, and on the property page puts it and the Z Inspector report in the Inspections folder, then shows screenshots proving each one landed.</p>
      <button class="primary p-done" id="sentBtn">${isDone(d) ? '✓ Completed · reopen' : 'Mark completed'}</button>
      <p class="hint">It completes on its own once the email is sent and the checklist is uploaded to AppFolio. Use this only if a step didn't update.</p>
    </section>`;
  wireDetail();
  if (keepScroll) window.scrollTo(0, y);
}
function itemRow(item) {
  const text = item?.text ?? '', when = item?.when === 'later' ? 'later' : 'now';
  return `<div class="mline it" data-when="${when}">
    <input type="text" class="itx" value="${esc(text)}" placeholder="What needs attention" aria-label="Maintenance item">
    <span class="nl"><button type="button" class="now" aria-pressed="${when === 'now'}">Now</button><button type="button" class="later" aria-pressed="${when === 'later'}">Later</button></span>
    <button type="button" class="x" aria-label="Remove">✕</button></div>`;
}
function recRow([t, tf]) {
  return `<div class="mline rec"><input type="text" class="rt" value="${esc(t)}" placeholder="Recommendation" aria-label="Recommendation">
    <input type="text" class="tf" list="tfs" value="${esc(tf)}" placeholder="When" aria-label="When">
    <button type="button" class="x" aria-label="Remove">✕</button></div>`;
}
// Immediate feedback: the save to Google takes a couple of seconds, so show it's working right away.
function busy(btn, label) { if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = label; } }
function unbusy(btn) { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; } }
async function runChecklist(btn) {
  busy(btn, 'Updating…');
  try { await updateChecklistNow(t => { if ($('ckMsg')) $('ckMsg').textContent = t; }); renderDetail(true); }
  catch (e) { if ($('ckMsg')) $('ckMsg').textContent = 'Couldn\'t update it: ' + e.message; unbusy(btn); }
}
function wireDetail() {
  $('deskBack').onclick = () => history.back();
  if ($('ckNow')) $('ckNow').onclick = () => runChecklist($('ckNow'));
  // Marking the email done by hand also asks Claude to bring the checklist up to date.
  const markEmail = async (sent, btn) => {
    busy(btn, 'Saving…');
    await save();
    const steps = { ...(D.current.data.steps || {}), email: true, ...(sent ? { sent: true } : {}) };
    const requests = { ...(D.current.data.requests || {}), email: { state: 'done', at: new Date().toISOString(), note: sent ? 'You sent the email yourself.' : 'You drafted the email yourself.' } };
    await patch({ steps, requests });
    renderDetail(true);
    if (D.current.data.checklistSpec && $('ckNow')) { $('ckNow').scrollIntoView({ block: 'center' }); runChecklist($('ckNow')); }
  };
  if ($('iDrafted')) $('iDrafted').onclick = () => markEmail(false, $('iDrafted'));
  if ($('iSent')) $('iSent').onclick = () => markEmail(true, $('iSent'));
  if ($('bookCall')) $('bookCall').onclick = async () => {
    $('bookCall').disabled = true; $('bookCall').textContent = 'Booking…'; $('callMsg').textContent = '';
    try {
      await save();
      await api('desk.bookCall', { slug: D.current.id });
      D.current.data = (await api('desk.get', { slug: D.current.id })).doc;
      renderDetail(true);
    } catch (e) {
      $('callMsg').textContent = /authoriz|permission/i.test(e.message)
        ? 'The Google script needs your OK to use your calendar. Open it in Google Apps Script and run doGet once.'
        : 'Couldn\'t book it: ' + e.message;
      $('bookCall').disabled = false; $('bookCall').textContent = 'Try again';
    }
  };
  if ($('remStatus')) api('desk.reminderStatus').then(r => { if ($('remStatus')) $('remStatus').textContent = r.triggerOn ? '✓ The 9 AM job is on.' : '⚠ The 9 AM job is off. Tell Claude to turn it back on.'; })
    .catch(() => { if ($('remStatus')) $('remStatus').textContent = ''; });
  deskEl().querySelectorAll('[data-aok],[data-ano],[data-arm]').forEach(b => b.onclick = () => setAudit(b));
  if ($('logAll')) $('logAll').onclick = () => {
    const older = deskEl().querySelectorAll('[data-older]'), showing = !older[0].hidden;
    older.forEach(el => { el.hidden = showing; });
    $('logAll').textContent = showing ? `Show all ${older.length + 3} actions` : 'Show only the latest 3';
  };
  if ($('pdfBtn')) $('pdfBtn').onclick = async () => {
    $('pdfBtn').textContent = 'Opening…';
    const w = window.open('', '_blank');
    try { const u = await loadImage(D.current.data.checklistPdf); if (w) w.location = u; else location.href = u; }
    catch { if (w) w.close(); }
    $('pdfBtn').textContent = 'Open the filled checklist (PDF)';
  };
  wireEvidence(deskEl());
  deskEl().querySelectorAll('[data-req]').forEach(b => b.onclick = () => { busy(b, 'Sending…'); queueReq(b.dataset.req); });
  if (!D.current.data.steps?.processed) return;
  ['review', 'tenant', 'owner', 'goAhead', 'callDate', 'callTime', 'altDate'].forEach(k => $(k).addEventListener('input', changed));
  if (!D.current.data.call?.booked && !D.current.slotChecked) {
    // Pre-fill the first half hour that's actually free (unanswered invites count as busy), so the email shows the real time.
    D.current.slotChecked = true;
    const id = D.current.id;
    api('desk.freeSlot', { date: $('callDate').value, time: $('callTime').value }).then(r => {
      if (D.current?.id !== id || !r.time || !$('callTime') || D.current.data.call?.booked) return;
      if (r.date === $('callDate').value && r.time === $('callTime').value) return;
      $('callDate').value = r.date; $('callTime').value = r.time;
      $('callTime').dispatchEvent(new Event('input'));
      $('callMsg').textContent = 'Moved to the first free time on your calendar.';
    }).catch(() => {});
  }
  $('items').addEventListener('input', changed);
  $('recs').addEventListener('input', changed);
  $('items').addEventListener('click', e => {
    const row = e.target.closest('.it'); if (!row) return;
    if (e.target.matches('.nl button')) {
      row.dataset.when = e.target.classList.contains('later') ? 'later' : 'now';
      row.querySelectorAll('.nl button').forEach(b => b.setAttribute('aria-pressed', b.classList.contains(row.dataset.when)));
      changed();
    } else if (e.target.matches('.x')) { row.remove(); changed(); }
  });
  $('recs').addEventListener('click', e => { if (e.target.matches('.x')) { e.target.closest('.rec').remove(); changed(); } });
  $('addItem').onclick = () => { $('items').insertAdjacentHTML('beforeend', itemRow({})); $('items').lastElementChild.querySelector('input').focus(); };
  $('addRec').onclick = () => { $('recs').insertAdjacentHTML('beforeend', recRow(['', ''])); $('recs').lastElementChild.querySelector('input').focus(); };
  $('copyZ').onclick = () => copyText($('zText').value, 'zText', 'zMsg', 'Notes copied. Paste them into Z Inspector.');
  $('copyBody').onclick = () => copyEmail($('emailText').value);
  $('copySubject').onclick = () => copyText($('subjectText').value, 'subjectText', 'copyMsg', 'Subject copied.');
  $('addMore').onclick = async () => { await save(); history.pushState({ view: 'inbox' }, ''); openInbox(D.current.data.property, D.current.data.date); };
  // Typing in either box keeps your wording; "Use the generated version" goes back to the automatic text.
  for (const [box, key] of [['zText', 'z'], ['emailText', 'email']]) $(box).addEventListener('input', () => {
    D.current.data.overrides = { ...(D.current.data.overrides || {}), [key]: $(box).value };
    changed();
  });

  $('zDone').onclick = async () => { busy($('zDone'), 'Saving…'); await save(); await patch({ steps: { ...D.current.data.steps, zinspector: true } }); queueReq('link'); };
  $('sentBtn').onclick = async () => { busy($('sentBtn'), 'Saving…'); await save(); await patch({ steps: { ...D.current.data.steps, completed: !isDone(D.current.data) } }); renderDetail(true); };
  renderOutputs();
}

// ---------- saving (pinned to the version last read) ----------
let saveTimer = null, saving = null;
function readForm() {
  const maintenance = [...document.querySelectorAll('#items .it')].map(r => ({ text: r.querySelector('.itx').value.trim(), when: r.dataset.when })).filter(i => i.text);
  const recs = [...document.querySelectorAll('#recs .rec')].map(r => [r.querySelector('.rt').value.trim(), r.querySelector('.tf').value.trim()]).filter(r => r[0]);
  const fields = { ...(D.current.data.fields || {}), review: $('review').value, tenant: $('tenant').value, owner: $('owner').value };
  if ($('goAhead').value.trim() !== defaultGoAheadFromForm()) fields.goAhead = $('goAhead').value;
  return { fields, maintenance, recs, overrides: D.current.data.overrides || {}, call: { ...(D.current.data.call || {}), date: $('callDate').value, time: $('callTime').value, alt: $('altDate').value } };
}
function changed() {
  D.dirty = true;
  renderOutputs();
  $('saved').textContent = 'Unsaved changes…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 900);
}
async function save() {
  clearTimeout(saveTimer);
  if (!D.dirty || !$('review')) return;
  await (saving = patch(readForm()));
  D.dirty = false;
}
async function patch(p) {
  if (saving && p !== undefined) await saving.catch?.(() => {});
  const body = { ...p, updatedAt: new Date().toISOString() };
  try {
    const r = await api('desk.update', { slug: D.current.id, patch: body, ifVersion: D.current.data._version });
    Object.assign(D.current.data, body, { _version: r.version });
    if ($('saved')) $('saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
  } catch (e) {
    if (/Version conflict/.test(e.message)) {
      // Claude updated this inspection meanwhile: take its version, then re-apply this change on top.
      const fresh = (await api('desk.get', { slug: D.current.id })).doc;
      D.current.data = fresh;
      const r = await api('desk.update', { slug: D.current.id, patch: body, ifVersion: fresh._version });
      Object.assign(D.current.data, body, { _version: r.version });
      if ($('saved')) $('saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
    } else if ($('saved')) $('saved').textContent = 'Couldn\'t save (' + e.message + '). Your edits are still here.';
  }
}
async function queueReq(key) {
  await save();
  await patch({ requests: { ...(D.current.data.requests || {}), [key]: { state: 'queued', at: new Date().toISOString() } } });
  renderDetail(true);
}

// ---------- text outputs ----------
function fmtShort(v) { if (!v) return ''; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US'); }
function fmtLong(v) { if (!v) return ''; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
function fmtClock(v) { if (!v) return ''; const [h, m] = v.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
// Calls go on the first Wednesday at least 2 days out; the Friday offer skips any Friday within 48 hours.
function nextWeekday(weekday, minDays) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + minDays);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
// The morning-after reminder: when it goes out, whether the 9 AM job is on, and the calendar backup.
// Eli's own fixes to the audit: mark a row fine, flag it again, or drop it. The matching list chip follows.
const AUDIT_CHIP = { 'Utility account numbers': 'Utilities', "Renter's insurance": 'Insurance', 'Pet screening': 'Pets' };
async function setAudit(b) {
  const d = D.current.data, audit = (d.audit || []).map(a => ({ ...a }));
  const i = Number(b.dataset.aok ?? b.dataset.ano ?? b.dataset.arm), row = audit[i]; if (!row) return;
  busy(b, 'Saving…');
  if (b.dataset.arm !== undefined) audit.splice(i, 1);
  else row.status = b.dataset.aok !== undefined ? 'Yes' : 'No';
  const chip = AUDIT_CHIP[row.label];
  const checks = (d.checks || []).map(c => c.label === chip && b.dataset.arm === undefined ? { ...c, status: row.status } : c);
  const now = new Date().toISOString();
  const what = b.dataset.arm !== undefined ? 'Removed' : row.status === 'Yes' ? 'Marked fine' : 'Marked as a problem';
  await patch({ audit, checks, activity: [...(d.activity || []), { at: now, action: `${what}: ${row.label}`, detail: 'Changed on the Desk.', evidence: [] }] });
  renderDetail(true);
}
function reminderLine(d) {
  if (d.followupReminderSent) return `<p class="hint">✓ Reminder email sent ${esc(fmtShort(d.followupReminderSent.slice(0, 10)))}.</p>`;
  const at = d.call.reminderAt ? d.call.reminderAt.replace(/ at 9:00 AM$/, '') + ' around 9 AM' : 'the morning after the call';
  return `<p class="hint" id="remLine">Reminder email: ${esc(at)} to your work email${d.steps?.sent ? '' : ' (goes out once you mark the owner email sent)'}.` +
    `${d.call.reminderEventId ? ' Backup: a 9 AM “Follow-up – work orders needed?” event on your calendar.' : ''} <span id="remStatus">Checking the 9 AM job…</span></p>`;
}
function buildZ() {
  const v = readForm(), now = v.maintenance.filter(i => i.when === 'now'), later = v.maintenance.filter(i => i.when === 'later');
  const out = [];
  if (now.length) out.push('Maintenance needed now:', ...now.map(i => '- ' + i.text), '');
  if (later.length) out.push('Future maintenance to plan for:', ...later.map(i => '- ' + i.text), '');
  if (v.recs.length) out.push('Recommendations:', ...v.recs.map(([t, tf]) => '- ' + t + (tf ? ' (' + tf + ')' : '')));
  return out.join('\n').trim() || 'No maintenance items yet.';
}
const Z_PLACEHOLDER = '[Z Inspector link — Claude adds this]';
// Puts the newest Z Inspector link into an email Eli already edited, in place of the placeholder or an
// older report link, without touching anything else he wrote.
function withZLink(text, link) {
  if (!link) return text;
  if (text.includes(Z_PLACEHOLDER)) return text.split(Z_PLACEHOLDER).join(link);
  return text.replace(/https?:\/\/[^\s]*zinspector[^\s]*?(?=[.,)]?(\s|$))/gi, link);
}
function buildEmail() {
  const d = D.current.data, v = readForm(), f = v.fields, good = d.goodCondition !== false;
  const out = [`Hi ${f.owner || '[owner]'},`, '',
    `I recently completed the inspection at ${d.property}.` + (good ? ` You can view the full report with photos here: ${d.zLink || Z_PLACEHOLDER}` : ''), ''];
  if (f.review.trim()) out.push('What I saw:', f.review.trim(), '');
  if (v.recs.length) { out.push('My recommendations:', ''); v.recs.forEach(([t, tf], i) => out.push(`${i + 1}. ${t}${tf ? ' – ' + tf : ''}`)); out.push('', ''); }
  const when = d.call?.booked || [fmtLong(v.call.date), fmtClock(v.call.time)].filter(Boolean).join(' at ');
  const altDay = v.call.alt ? fmtLong(v.call.alt).split(',')[0] : '';
  const goAhead = (f.goAhead ?? defaultGoAhead(v.recs)).trim();
  out.push(`I'll give you a call on ${when || '[date and time]'} to go over the inspection and answer any questions.` +
    (v.call.alt ? ` I'm also available on ${fmtLong(v.call.alt)} if that works better.` : '') +
    ` If that time doesn't work, please reply with a few better times${altDay ? ' on either of those days' : ''} and I'll reschedule (please forward your response to eli@thesourcepm.com - since this is coming from an @noreply email).` +
    ` If this covers everything and you don't need a call, please send me an email and let me know.` +
    (goAhead ? ` I'll go ahead and schedule ${goAhead}.` : ''));
  return out.join('\n');
}
function defaultGoAheadFromForm() {
  return defaultGoAhead([...document.querySelectorAll('#recs .rec')].map(r => [r.querySelector('.rt').value.trim(), r.querySelector('.tf').value.trim()]).filter(r => r[0]));
}
// What gets scheduled if the owner skips the call; editable per inspection.
function defaultGoAhead(recs) {
  const now = recs.filter(([, tf]) => /^now$/i.test(tf || ''));
  return now.length === 1 ? 'that repair' : now.length ? 'the repairs marked Now above' : '';
}
function renderOutputs() {
  const o = D.current.data.overrides || {};
  for (const [box, key, build, note] of [['zText', 'z', buildZ, 'zEdited'], ['emailText', 'email', buildEmail, 'emailEdited']]) {
    const el = $(box); if (!el) continue;
    const custom = typeof o[key] === 'string';
    if (custom && key === 'email') {
      const linked = withZLink(o.email, D.current.data.zLink);
      if (linked !== o.email) { o.email = linked; D.current.data.overrides = { ...o }; changed(); }
    }
    if (document.activeElement !== el) el.value = custom ? o[key] : build();
    $(note).innerHTML = custom ? 'Your edited version. Changes to the sections above won\'t update it. <button class="linkbtn" data-reset="' + key + '">Use the generated version</button>' : '';
  }
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => {
    // The server merges fields, so a removed edit is sent as an explicit delete.
    D.current.data.overrides = { ...(D.current.data.overrides || {}), [b.dataset.reset]: { __delete__: true } };
    changed();
  });
}
// Copies the email twice over: formatted (bold section headings, paragraphs) for editors that keep
// formatting, and plain text for everything else.
const HEADINGS = /^(What I saw:|My recommendations:)\s*$/;
function emailHtml(text) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every(l => /^\d+\.\s/.test(l)))
      return '<ol>' + lines.map(l => `<li>${linkify(esc(l.replace(/^\d+\.\s*/, '')))}</li>`).join('') + '</ol>';
    return '<p>' + lines.map(l => HEADINGS.test(l.trim()) ? `<b>${esc(l.trim())}</b>` : linkify(esc(l))).join('<br>') + '</p>';
  }).join('');
}
const linkify = s => s.replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`);
async function copyEmail(text) {
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([emailHtml(text)], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      $('copyMsg').textContent = 'Message copied with bold headings. If they show up plain, the email editor dropped the formatting.';
      return;
    }
  } catch {}
  copyText(text, 'emailText', 'copyMsg', 'Message copied (plain text).');
}
async function copyText(text, preId, msgId, msg) {
  try { await navigator.clipboard.writeText(text); $(msgId).textContent = msg; }
  catch {
    $(preId).focus(); $(preId).select();
    $(msgId).textContent = 'Copying was blocked. The text is selected; copy it from the menu.';
  }
}

// ---------- screens + phone back button ----------
function setBar(title, sub) { $('barTitle').textContent = title; $('barSub').textContent = sub; }
function showView(v) {
  $('inboxView').classList.toggle('hidden', v !== 'inbox');
  deskEl().classList.toggle('hidden', v !== 'desk');
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', async e => {
  if (!$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
  const v = e.state?.view;
  if (D.current && $('review')) await save();
  if (v === 'detail') { showView('desk'); openDetail(e.state.id); }
  else if (v === 'inbox') { openInbox(); }
  else { D.current = null; showView('desk'); deskList(); }
});
$('lbClose').onclick = () => history.back();
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) history.back(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && D.dirty) save(); });
window.addEventListener('unlocked', () => {
  history.replaceState({ view: 'list' }, '');
  showView('desk'); deskList();
});
