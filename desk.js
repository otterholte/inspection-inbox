// Inspection Desk tab: open/completed inspections, the owner email draft and the evidence behind it.
// Data lives in Drive behind the same Apps Script (actions desk.*); requests are jobs for Claude Code on the PC.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RUN_HINT = 'Claude checks every 15 minutes on weekdays (7 AM–7 PM) while your PC and the Claude app are on.';
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
  ['sent', 'Email sent · completed', null],
];

async function api(action, body = {}) {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: uploadKey, ...body }) }).then(r => r.json());
  if (!r.ok) throw new Error(r.error || 'Request failed');
  return r;
}

const D = { docs: [], filter: 'open', current: null, dirty: false, poll: null };
try { D.filter = localStorage.getItem('desk-filter') || 'open'; } catch {}
const flags = d => d.steps || {};
const isDone = d => !!flags(d).sent;
const queuedCount = d => Object.values(d.requests || {}).filter(r => r.state === 'queued').length;
function statusOf(d) {
  if (isDone(d)) return ['Completed', 'st-done'];
  const q = queuedCount(d);
  if (q) return [`Waiting on Claude (${q})`, 'st-wait'];
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
function renderDeskList() {
  const shown = D.docs.filter(d => D.filter === 'all' ? true : D.filter === 'open' ? !isDone(d) : isDone(d))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const counts = { open: D.docs.filter(d => !isDone(d)).length, completed: D.docs.filter(isDone).length, all: D.docs.length };
  const queued = D.docs.reduce((n, d) => n + queuedCount(d), 0);
  deskEl().innerHTML = `
    <button class="primary p-new" id="newInsp">+ New inspection</button>
    ${queued ? `<div class="banner">${queued} request${queued > 1 ? 's' : ''} waiting for Claude. ${RUN_HINT}</div>` : ''}
    <div class="seg-tabs" role="group" aria-label="Filter">
      ${['open', 'completed', 'all'].map(k => `<button data-f="${k}" aria-pressed="${D.filter === k}">${k[0].toUpperCase() + k.slice(1)} · ${counts[k]}</button>`).join('')}
    </div>
    ${shown.length ? shown.map(d => {
      const [label, cls] = statusOf(d);
      const chips = (d.checks || []).map(c => `<span class="chip ${c.status === 'Yes' || c.status === 'No' ? c.status : 'NA'}">${esc(c.label)}: ${esc(c.status)}</span>`).join('');
      return `<button class="item" data-id="${esc(d._id)}">
        <span class="top"><strong>${esc(d.property)}</strong><span class="status ${cls}">${esc(label)}</span></span>
        <span class="meta">${esc(d.ownerName || 'Owner not looked up yet')} · inspected ${esc(fmtShort(d.date))}</span>
        ${chips ? `<span class="chipsrow">${chips}</span>` : ''}</button>`;
    }).join('') : `<section class="card empty"><p class="hint">${D.docs.length ? 'Nothing in this list.' : 'No inspections yet. Tap + New inspection to add one.'}</p></section>`}`;
  $('newInsp').onclick = () => { history.pushState({ view: 'new' }, ''); renderNew(); };
  deskEl().querySelectorAll('[data-f]').forEach(b => b.onclick = () => { D.filter = b.dataset.f; try { localStorage.setItem('desk-filter', D.filter); } catch {} renderDeskList(); });
  deskEl().querySelectorAll('.item').forEach(b => b.onclick = () => { history.pushState({ view: 'detail', id: b.dataset.id }, ''); openDetail(b.dataset.id); });
}

// ---------- new inspection ----------
function renderNew() {
  setBar('New inspection', 'Claude looks up the owner, audits AppFolio and drafts everything');
  const t = new Date(), z = n => String(n).padStart(2, '0');
  deskEl().innerHTML = `
    <section class="card">
      <label for="nProp">Property address</label><input type="text" id="nProp" placeholder="e.g. 1137 Timber Lane" value="${esc(state.lastProperty || '')}">
      <label for="nDate" style="margin-top:12px">Inspection date</label><input type="date" id="nDate" value="${t.getFullYear()}-${z(t.getMonth() + 1)}-${z(t.getDate())}">
      <label for="nFiles" style="margin-top:12px">Checklist photos or PDF (front and back)</label><input type="file" id="nFiles" accept="image/*,application/pdf" multiple>
      <label for="nNotes" style="margin-top:12px">Anything else to know <span style="font-weight:400">· optional</span></label><textarea id="nNotes" placeholder="Dictate with your keyboard's mic"></textarea>
      <p class="hint" style="margin-top:10px">Voice memos and scans you send from the Inbox tab for this address get picked up too.</p>
      <button class="primary" id="nSave">Add inspection</button>
      <p class="hint" id="nMsg"></p>
    </section>`;
  $('nSave').onclick = createInspection;
}
const slugify = (p, d) => (p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property') + '_' + d;
async function createInspection() {
  const prop = $('nProp').value.trim(), date = $('nDate').value;
  if (!prop || !date) { $('nMsg').textContent = 'Add the property address and inspection date.'; return; }
  $('nSave').disabled = true;
  const uploads = [];
  try {
    for (const f of $('nFiles').files) {
      $('nMsg').textContent = `Uploading ${f.name}…`;
      const r = await api('upload', { property: prop, kind: 'checklist-scan', filename: f.name, mimeType: f.type || 'application/octet-stream', data: await toBase64(f) });
      uploads.push({ driveId: r.id, name: f.name, type: f.type });
    }
    const id = slugify(prop, date), now = new Date().toISOString();
    await api('desk.set', { slug: id, doc: { property: prop, date, ownerName: '', steps: {}, uploads, intakeNotes: $('nNotes').value.trim(),
      requests: { process: { state: 'queued', at: now } }, createdAt: now, updatedAt: now } });
    history.replaceState({ view: 'detail', id }, '');
    openDetail(id);
  } catch (e) { $('nMsg').textContent = 'Couldn\'t save it: ' + e.message; $('nSave').disabled = false; }
}

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
  }, 20000);
}
function stopPoll() { clearInterval(D.poll); D.poll = null; }
function reqBlock(key, label, enabled = true) {
  const r = (D.current.data.requests || {})[key];
  const queued = r?.state === 'queued';
  return `${queued ? `<div class="waiting">Waiting for Claude: ${esc(REQUESTS[key])}. ${RUN_HINT}</div>` : ''}
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
      <div class="audit">${d.audit.map(a => `<div class="${a.status === 'Yes' || a.status === 'No' ? a.status : 'NA'}"><span>${esc(a.label)}${a.detail ? ' — ' + esc(a.detail) : ''}</span><strong>${esc(a.status)}</strong></div>`).join('')}</div>
      ${(ev.audit || []).length ? `<span class="src">Where this came from</span>${evHtml(ev.audit)}` : ''}
      ${(ev.property || []).length ? `<span class="src">Property pages</span>${evHtml(ev.property)}` : ''}
    </section>` : ''}

    <section class="card"><h2>Z Inspector notes</h2>
      <p class="hint">Copy these into the inspection's notes in Z Inspector, submit it, then tap the green button.</p>
      <pre class="out" id="zOut"></pre>
      <button class="sec" id="copyZ">Copy notes</button>
      <button class="primary" id="zDone" ${st.zinspector ? 'disabled' : ''}>${st.zinspector ? '✓ In Z Inspector and submitted' : 'It\'s in Z Inspector and submitted'}</button>
      ${st.zinspector ? reqBlock('link', st.link ? 'Find the link again' : 'Get the Z Inspector link') : ''}
      <p class="saved" id="zMsg"></p>
    </section>

    <section class="card"><h2>Follow-up call</h2>
      ${d.call?.booked ? `<div class="doneMsg">On your calendar: ${esc(d.call.booked)}</div>` : ''}
      <div class="grid2">
        <div><label for="callDate">Wednesday</label><input type="date" id="callDate" value="${esc(d.call?.date || nextWeekday(3, 2))}"></div>
        <div><label for="callTime">Time</label><input type="time" id="callTime" value="${esc(d.call?.time || '10:00')}"></div>
      </div>
      <label for="altDate">Also free (Friday)</label><input type="date" id="altDate" value="${esc(d.call?.alt || nextWeekday(5, 3))}">
      <p class="hint">Claude adds a tentative, orange 30-minute event to your work calendar with the owner's name and phone number, moving to the next free slot between 10 and 4 if this one is taken.</p>
      ${reqBlock('call', d.call?.booked ? 'Move it to this time' : 'Sounds good, add it to my calendar')}
    </section>

    <section class="card"><h2>Email to the owner</h2>
      <label for="owner">Greeting</label><input type="text" id="owner" value="${esc(f.owner)}">
      <pre class="out" id="bodyOut"></pre>
      <button class="sec" id="copyBody">Copy message</button>
      ${reqBlock('email', st.email ? 'Draft it again in AppFolio' : 'Draft it in AppFolio', !!st.link)}
      ${st.link ? '' : '<p class="hint">Available once the Z Inspector link is in.</p>'}
      <p class="saved" id="copyMsg"></p>
    </section>

    ${(d.activity || []).length ? `<section class="card"><h2>Claude's work log</h2>
      ${[...d.activity].reverse().map(a => `<div class="logitem"><b>${esc(a.action)}</b> <span class="hint">· ${esc(new Date(a.at).toLocaleString())}</span>
        ${a.detail ? `<p class="hint">${esc(a.detail)}</p>` : ''}${evHtml(a.evidence)}</div>`).join('')}
    </section>` : ''}

    <section class="card"><h2>Wrap up</h2>
      ${d.checklistPdf ? `<button class="sec" id="pdfBtn">Open the filled checklist (PDF)</button>` : ''}
      ${(d.checklistPages || []).length ? evHtml(d.checklistPages) : ''}
      ${reqBlock('checklist', st.checklist ? 'Fill out the checklist again' : 'Fill out the 2026 checklist')}
      ${st.docs ? '<div class="doneMsg">Checklist uploaded to the tenant and property pages (Inspections folder).</div>' : reqBlock('docs', 'Upload the checklist to AppFolio', !!st.checklist)}
      <button class="primary p-done" id="sentBtn">${st.sent ? '✓ Completed · reopen' : 'Mark completed'}</button>
      <p class="hint">Mark it completed any time, even if a step above didn't update.</p>
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
function wireDetail() {
  $('deskBack').onclick = () => history.back();
  if ($('pdfBtn')) $('pdfBtn').onclick = async () => {
    $('pdfBtn').textContent = 'Opening…';
    const w = window.open('', '_blank');
    try { const u = await loadImage(D.current.data.checklistPdf); if (w) w.location = u; else location.href = u; }
    catch { if (w) w.close(); }
    $('pdfBtn').textContent = 'Open the filled checklist (PDF)';
  };
  wireEvidence(deskEl());
  deskEl().querySelectorAll('[data-req]').forEach(b => b.onclick = () => queueReq(b.dataset.req));
  if (!D.current.data.steps?.processed) return;
  ['review', 'tenant', 'owner', 'callDate', 'callTime', 'altDate'].forEach(k => $(k).addEventListener('input', changed));
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
  $('copyZ').onclick = () => copyText(buildZ(), 'zOut', 'zMsg', 'Notes copied. Paste them into Z Inspector.');
  $('copyBody').onclick = () => copyText(buildEmail(), 'bodyOut', 'copyMsg', 'Message copied.');
  $('zDone').onclick = async () => { await save(); await patch({ steps: { ...D.current.data.steps, zinspector: true } }); queueReq('link'); };
  $('sentBtn').onclick = async () => { await save(); await patch({ steps: { ...D.current.data.steps, sent: !D.current.data.steps?.sent } }); renderDetail(true); };
  renderOutputs();
}

// ---------- saving (pinned to the version last read) ----------
let saveTimer = null, saving = null;
function readForm() {
  const maintenance = [...document.querySelectorAll('#items .it')].map(r => ({ text: r.querySelector('.itx').value.trim(), when: r.dataset.when })).filter(i => i.text);
  const recs = [...document.querySelectorAll('#recs .rec')].map(r => [r.querySelector('.rt').value.trim(), r.querySelector('.tf').value.trim()]).filter(r => r[0]);
  const fields = { ...(D.current.data.fields || {}), review: $('review').value, tenant: $('tenant').value, owner: $('owner').value };
  return { fields, maintenance, recs, call: { ...(D.current.data.call || {}), date: $('callDate').value, time: $('callTime').value, alt: $('altDate').value } };
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
function buildZ() {
  const v = readForm(), now = v.maintenance.filter(i => i.when === 'now'), later = v.maintenance.filter(i => i.when === 'later');
  const out = [];
  if (now.length) out.push('Maintenance needed now:', ...now.map(i => '- ' + i.text), '');
  if (later.length) out.push('Future maintenance to plan for:', ...later.map(i => '- ' + i.text), '');
  if (v.recs.length) out.push('Recommendations:', ...v.recs.map(([t, tf]) => '- ' + t + (tf ? ' (' + tf + ')' : '')));
  return out.join('\n').trim() || 'No maintenance items yet.';
}
function buildEmail() {
  const d = D.current.data, v = readForm(), f = v.fields, good = d.goodCondition !== false;
  const out = [`Hi ${f.owner || '[owner]'},`, '',
    `I completed the inspection at ${d.property} on ${fmtShort(d.date)}.` + (good ? ` You can view the full report with photos here: ${d.zLink || '[Z Inspector link — Claude adds this]'}` : ''), ''];
  if (f.review.trim()) out.push('What I saw:', f.review.trim(), '');
  if (v.recs.length) { out.push('My recommendations:'); v.recs.forEach(([t, tf], i) => out.push(`${i + 1}. ${t}${tf ? ' – ' + tf : ''}`)); out.push(''); }
  const when = d.call?.booked || [fmtLong(v.call.date), fmtClock(v.call.time)].filter(Boolean).join(' at ');
  out.push(`I'll give you a call on ${when || '[date and time]'} to go over this and answer any questions.` +
    (v.call.alt ? ` I'm also available on ${fmtLong(v.call.alt)} if that works better.` : '') +
    ` If that time doesn't work, just reply with a better time and I'll reschedule. If this covers everything and you don't need a call, please reply to this email and let me know.`);
  return out.join('\n');
}
function renderOutputs() { $('zOut').textContent = buildZ(); $('bodyOut').textContent = buildEmail(); }
async function copyText(text, preId, msgId, msg) {
  try { await navigator.clipboard.writeText(text); $(msgId).textContent = msg; }
  catch {
    const r = document.createRange(); r.selectNodeContents($(preId));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    $(msgId).textContent = 'Copying was blocked. The text is selected; copy it from the menu.';
  }
}

// ---------- tabs + phone back button ----------
let deskLoaded = false;
function setBar(title, sub) { $('barTitle').textContent = title; $('barSub').textContent = sub; }
function showTab(tab, push = true) {
  $('inboxView').classList.toggle('hidden', tab !== 'inbox');
  deskEl().classList.toggle('hidden', tab !== 'desk');
  document.querySelectorAll('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  try { localStorage.setItem('last-tab', tab); } catch {}
  if (push) history.pushState({ view: tab === 'desk' ? 'list' : 'inbox' }, '');
  window.scrollTo(0, 0);
  if (tab === 'inbox') { stopPoll(); setBar('Inspection Inbox', 'Saves to Drive · 2026/27 Inspections'); }
  else if (!deskLoaded || !D.current) { deskLoaded = true; deskList(); }
}
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = async () => {
  if (b.dataset.tab === 'desk' && D.current) await save();
  if (b.dataset.tab === 'desk') { D.current = null; deskLoaded = false; }
  showTab(b.dataset.tab);
});
window.addEventListener('popstate', async e => {
  if (!$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
  const v = e.state?.view;
  if (D.current) await save();
  if (v === 'detail') { showTab('desk', false); openDetail(e.state.id); }
  else if (v === 'new') { showTab('desk', false); renderNew(); }
  else if (v === 'inbox') { D.current = null; showTab('inbox', false); }
  else { D.current = null; deskLoaded = true; showTab('desk', false); deskList(); }
});
$('lbClose').onclick = () => history.back();
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('lightbox').classList.contains('hidden')) history.back(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && D.dirty) save(); });
window.addEventListener('unlocked', () => {
  let last = 'inbox';
  try { last = localStorage.getItem('last-tab') || 'inbox'; } catch {}
  history.replaceState({ view: last === 'desk' ? 'list' : 'inbox' }, '');
  showTab(last, false);
});
