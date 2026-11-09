// Builds the filled 2026 Property Inspection Checklist right in the app (same marks as tools/fill_checklist.py):
// typed black Helvetica, X marks in the left column, notes on each line's blank, circles, initials.
// The blank form and its line positions live in Eli's private Drive, not in this public repo.
const FORM_PDF_ID = '1nLQXUh4l33cBD00bhDn8tXmD9DnzUF6a';
const FORM_LAYOUT_ID = '18kJV9TM7d8YkvCPdenqYrWH4LKq80aPB';
const NEVER_MARK = ['Turn in inspection sheets weekly'];
// Eli checks these on every inspection.
const ALWAYS_MARK = ['Location of Sprinkler'];
// Page-2 lines that follow from the Desk's progress.
const EMAIL_LINES = ['A link to the inspection', 'A review of the condition', 'Minimum 3 proactive', 'A date and time'];
const UPLOAD_LINE = 'Upload the Inspection Checklist';

let formCache = null;
async function loadForm() {
  if (!formCache) formCache = Promise.all([api('desk.image', { id: FORM_PDF_ID }), api('desk.image', { id: FORM_LAYOUT_ID })])
    .then(([pdf, layout]) => ({ pdf: Uint8Array.from(atob(pdf.data), c => c.charCodeAt(0)), layout: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(layout.data), c => c.charCodeAt(0)))) }))
    .catch(e => { formCache = null; throw e; });
  return formCache;
}

// The marks this inspection should carry right now: what was checked at the inspection, plus the Desk's progress.
function checklistMarks(d) {
  const spec = d.checklistSpec || {};
  const marks = new Set(spec.marks || []);
  const st = d.steps || {};
  if (st.email || st.sent) EMAIL_LINES.forEach(m => marks.add(m));
  if (st.docs) marks.add(UPLOAD_LINE);
  marks.add('Complete and initial');
  ALWAYS_MARK.forEach(m => marks.add(m));
  NEVER_MARK.forEach(n => [...marks].forEach(m => { if (m.startsWith(n) || n.startsWith(m)) marks.delete(m); }));
  return [...marks];
}

async function buildChecklistPdf(d) {
  const { pdf, layout } = await loadForm();
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(pdf);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0, 0, 0), pages = doc.getPages();
  const H = p => layout.pages[p][1];
  const put = (p, x, y, s, size = 10) => s && pages[p].drawText(String(s), { x, y: H(p) - y, size, font, color: ink });
  const findLine = prefix => {
    const l = layout.lines.find(l => l.t.startsWith(prefix));
    if (!l) throw new Error('Line not found on the form: ' + prefix);
    return l;
  };
  const spec = d.checklistSpec || {};

  const header = { 'Property:': spec.property || d.property, 'Owner:': spec.owner || d.ownerName, 'PM:': spec.pm || 'Eli',
    'Inspection Date:': spec.date || fmtShort(d.date), 'Inspector:': spec.inspector || 'Eli' };
  for (const [label, val] of Object.entries(header)) {
    const L = layout.labels[label]; put(L.p, L.r[2] + 8, L.r[3] - 1, val, 11);
  }
  (spec.top_notes || []).forEach((n, i) => put(0, 400, 52 + 14 * i, n, 9.5));

  for (const prefix of checklistMarks(d)) {
    const l = findLine(prefix), [, y0, , y1] = l.r, a = y0 - 1, b = y1 + 1;
    pages[l.p].drawLine({ start: { x: 58, y: H(l.p) - a }, end: { x: 72, y: H(l.p) - b }, thickness: 1.4, color: ink });
    pages[l.p].drawLine({ start: { x: 72, y: H(l.p) - a }, end: { x: 58, y: H(l.p) - b }, thickness: 1.4, color: ink });
  }
  for (const [prefix, note] of Object.entries(spec.notes || {})) {
    const l = findLine(prefix);
    put(l.p, (l.blankX ? l.blankX + 4 : l.r[2] + 6), l.r[3] - 1, note);
  }
  for (const [prefix, phrase] of spec.circles || []) {
    const l = findLine(prefix), r = phraseRect(layout, l, phrase);
    if (!r) continue;
    const [x0, y0, x1, y1] = [r[0] - 3, r[1] - 3, r[2] + 3, r[3] + 3];
    pages[l.p].drawEllipse({ x: (x0 + x1) / 2, y: H(l.p) - (y0 + y1) / 2, xScale: (x1 - x0) / 2, yScale: (y1 - y0) / 2, borderColor: ink, borderWidth: 1.1 });
  }
  const I = layout.labels['Initials:']; put(I.p, I.r[2] + 6, I.r[3] - 1, spec.initials || 'EO', 12);
  // Object streams make this form's page tree unreadable to some viewers (pdf.js sees 1 page), so save plainly.
  return doc.save({ useObjectStreams: false });
}

// Where a phrase sits on a printed line, from the form's word boxes (words can run together, e.g. "place/AC").
function phraseRect(layout, line, phrase) {
  const words = layout.words.filter(w => w.p === line.p && w.r[1] >= line.r[1] - 2 && w.r[3] <= line.r[3] + 2).sort((a, b) => a.r[0] - b.r[0]);
  let text = '', xs = [];
  for (const w of words) {
    if (text) { text += ' '; xs.push(w.r[0]); }
    for (let i = 0; i < w.w.length; i++) { text += w.w[i]; xs.push(w.r[0] + (w.r[2] - w.r[0]) * i / w.w.length); }
  }
  xs.push(words.length ? words[words.length - 1].r[2] : 0);
  const i = text.indexOf(phrase);
  if (i < 0) return null;
  return [xs[i], line.r[1], xs[i + phrase.length], line.r[3]];
}

// Page images for checking the result and for the work log.
async function renderPages(bytes) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise, out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n), vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    // 'print' renders without requestAnimationFrame, so it finishes even when the screen isn't drawing.
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    out.push(await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)));
  }
  return out;
}
const blobToB64 = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });

// Fill, save to Drive, and record it on the inspection: about 5–10 seconds, no waiting for the runner.
async function updateChecklistNow(onStep) {
  const d = D.current.data, slug = D.current.id, now = new Date().toISOString();
  onStep('Filling in the checklist…');
  const before = new Set(d.checklistMarks || []), marks = checklistMarks(d);
  const bytes = await buildChecklistPdf(d);
  onStep('Making page previews…');
  const pages = await Promise.race([renderPages(bytes), new Promise((_, r) => setTimeout(() => r(new Error('the page previews took too long')), 30000))]);
  onStep('Saving to your Drive…');
  const stamp = now.slice(0, 16).replace(/[:T]/g, '-');
  const pdfId = (await api('desk.putImage', { filename: `${slug}_checklist_${stamp}.pdf`, mimeType: 'application/pdf', data: await blobToB64(new Blob([bytes])) })).id;
  const pageIds = [];
  for (const [i, p] of pages.entries())
    pageIds.push((await api('desk.putImage', { filename: `${slug}_checklist_${stamp}_p${i + 1}.jpg`, mimeType: 'image/jpeg', data: await blobToB64(p) })).id);
  const added = marks.filter(m => !before.has(m)), removed = [...before].filter(m => !marks.includes(m));
  const changes = before.size ? (added.length || removed.length ? `Marked: ${added.join('; ') || 'nothing new'}${removed.length ? '. Unmarked: ' + removed.join('; ') : ''}.` : 'Nothing changed since the last version; refreshed it.') : 'First version filled in the app.';
  const evidence = pageIds.map((id, i) => ({ img: id, caption: `Updated checklist, page ${i + 1}`, highlight: '', finding: i === 1 ? 'Page 2 shows the email and upload steps marked as they\'re done; the "turn in to Jamie" line stays blank.' : 'Page 1: header, your notes, circles and the checked lines.' }));
  onStep('Updating the inspection…');
  await patch({
    checklistPdf: pdfId, checklistPages: evidence, checklistMarks: marks,
    steps: { ...(d.steps || {}), checklist: true },
    requests: { ...(d.requests || {}), checklist: { state: 'done', at: now, note: 'Updated just now. ' + changes } },
    activity: [...(d.activity || []), { at: now, action: 'Updated the checklist', detail: changes, evidence }],
  });
}
