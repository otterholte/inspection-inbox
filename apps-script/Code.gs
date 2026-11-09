/**
 * Inspection Inbox + Desk backend (Google Apps Script web app).
 *
 * Uploads: files posted by the phone app go to  <root folder> / <property> / <file>
 * Desk:    one JSON document per inspection in   <root folder> / _desk / <slug>.json
 *          and its screenshots in                <root folder> / _desk / images /
 *
 * Config comes from Script Properties, or from a Secrets.gs file kept out of the public repo:
 *   UPLOAD_TOKEN    long token for Claude Code on the PC
 *   APP_TOKEN       token the phone app derives from its access code
 *   ROOT_FOLDER_ID  Drive folder to save into (default: a folder named "Inspections Inbox")
 *   WORK_EMAIL      address invited to follow-up calls (Eli's work calendar)
 * Deploy as a Web app, Execute as: Me, Who has access: Anyone.
 *
 * The app's access code is short, so wrong tokens are rate limited: after MAX_FAILURES
 * failures within the lockout window every request is refused until the window passes.
 */

const ROOT_FOLDER_NAME = 'Inspections Inbox';
const DESK_FOLDER = '_desk', IMAGE_FOLDER = 'images';
const MAX_FAILURES = 10, LOCKOUT_SECONDS = 3600;

function config_(key) {
  const fromProps = PropertiesService.getScriptProperties().getProperty(key);
  if (fromProps) return fromProps;
  return typeof SECRETS !== 'undefined' ? SECRETS[key] : null;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    switch (body.action) {
      case 'desk.list': return json_({ ok: true, docs: deskList_() });
      case 'desk.get': return json_({ ok: true, doc: deskGet_(body.slug) });
      case 'desk.set': return json_({ ok: true, version: deskWrite_(body.slug, body.doc, body.ifVersion, false) });
      case 'desk.update': return json_({ ok: true, version: deskWrite_(body.slug, body.patch, body.ifVersion, true) });
      case 'desk.image': return json_({ ok: true, ...imageGet_(body.id) });
      case 'desk.putImage': return json_({ ok: true, id: imagePut_(body) });
      case 'desk.bookCall': return json_({ ok: true, ...bookCall_(body.slug, body.zNotes) });
      case 'desk.freeSlot': return json_({ ok: true, ...freeSlot_(body.date, body.time) });
      case 'desk.deleteDraft': return json_({ ok: true, ...deleteDraft_(body.slug) });
      case 'desk.reminderStatus': return json_({ ok: true, triggerOn: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendFollowupReminders'), mailQuota: MailApp.getRemainingDailyQuota() });
      case 'desk.calendarCheck': return json_({ ok: true, ...calendarCheck_() });
      case 'desk.testReminder': return json_({ ok: true, ...sendReminder_(body.slug, true) });
      default: return json_({ ok: true, ...upload_(body) });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// Connection check for the app header.
function doGet(e) {
  try {
    checkToken_(e.parameter.token);
    return json_({ ok: true, root: rootFolder_().getName() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function upload_(body) {
  const folder = propertyFolder_(body.property);
  const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mimeType || 'application/octet-stream', safeName_(body.filename));
  const file = folder.createFile(blob);
  if (body.kind) file.setDescription(body.kind);
  return { id: file.getId(), name: file.getName(), folder: folder.getName() };
}

// ---- Desk documents ----
function deskFolder_() { return childFolder_(rootFolder_(), DESK_FOLDER); }
function docFile_(slug) {
  if (!/^[a-z0-9][a-z0-9._-]{0,150}$/.test(slug || '')) throw new Error('Bad inspection id');
  const it = deskFolder_().getFilesByName(slug + '.json');
  return it.hasNext() ? it.next() : null;
}
function readDoc_(file) { return JSON.parse(file.getBlob().getDataAsString('UTF-8')); }

function deskList_() {
  const out = [], it = deskFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.json$/.test(f.getName())) continue;
    const d = readDoc_(f);
    // The list only needs summary fields; the page fetches the rest on open.
    out.push({ _id: f.getName().replace(/\.json$/, ''), _version: d._version, property: d.property, ownerName: d.ownerName,
      date: d.date, steps: d.steps, requests: d.requests, checks: d.checks, checklistPdf: d.checklistPdf || null,
      draft: !!d.draft, uploads: (d.uploads || []).length });
  }
  return out;
}
// Only an unsent draft (the Inbox saves one as soon as an address is typed) can be removed; uploaded files stay in Drive.
function deleteDraft_(slug) {
  const f = docFile_(slug);
  if (!f) return { deleted: false };
  if (!readDoc_(f).draft) throw new Error('Only unsent drafts can be deleted');
  f.setTrashed(true);
  return { deleted: true };
}
function deskGet_(slug) {
  const f = docFile_(slug);
  if (!f) throw new Error('Not found');
  return { _id: slug, ...readDoc_(f) };
}
// Writes are pinned to the version the writer last read, so the phone and Claude never overwrite each other.
function deskWrite_(slug, data, ifVersion, merge) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = docFile_(slug);
    const cur = f ? readDoc_(f) : null;
    if (cur && ifVersion !== cur._version) throw new Error('Version conflict: now at ' + cur._version);
    const next = merge ? deepMerge_(cur || {}, data || {}) : { ...(data || {}) };
    delete next._id;
    next._version = (cur ? cur._version : 0) + 1;
    const text = JSON.stringify(next);
    if (f) f.setContent(text); else deskFolder_().createFile(slug + '.json', text, 'application/json');
    return next._version;
  } finally { lock.releaseLock(); }
}
function deepMerge_(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && v.__delete__) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) out[k] = deepMerge_(a[k], v);
    else out[k] = v;
  }
  return out;
}

// ---- Follow-up calls ----
// Books a 30-minute call on this account's calendar and invites the work address, so it lands on the
// work calendar right away as an unanswered (tentative) invite. Starts at the time chosen on the Desk;
// if that slot is taken it moves to the next free half hour between 10 and 4 that Wednesday, then later Wednesdays.
const CALL_MINUTES = 30, DAY_START = 10, DAY_END = 16, WEEKS_TO_TRY = 4;
function bookCall_(slug, zNotes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = docFile_(slug);
    if (!f) throw new Error('Not found');
    const doc = readDoc_(f), call = doc.call || {};
    if (!call.date || !call.time) throw new Error('Pick a date and time first');
    const tz = Session.getScriptTimeZone(), work = config_('WORK_EMAIL') || 'eli@thesourcepm.com';
    const cal = CalendarApp.getDefaultCalendar();
    const workCal = safeCal_(work);
    const calendars = [cal].concat(workCal ? [workCal] : []);
    const existing = call.eventId ? safeEvent_(cal, call.eventId) : null;

    let start = Utilities.parseDate(call.date + ' ' + call.time, tz, 'yyyy-MM-dd HH:mm');
    const slot = firstFree_(calendars, start, existing ? existing.getId() : null);
    if (!slot) throw new Error('No free 30-minute slot between 10 and 4 on the next ' + WEEKS_TO_TRY + ' Wednesdays');
    const end = new Date(slot.getTime() + CALL_MINUTES * 60000);

    const owner = doc.ownerName || 'owner';
    const title = 'Inspection follow-up – ' + doc.property + ' (' + owner + ')';
    const phones = [].concat(doc.ownerPhones || doc.ownerPhone || []).filter(Boolean);
    // Z Inspector notes as they read on the Desk when the call was booked (kept from the last booking if none were sent).
    const notes = String(zNotes == null ? call.zNotes || '' : zNotes).trim();
    const description = ['Call ' + owner + ' about the ' + doc.property + ' inspection (' + doc.date + ').',
      phones.length ? 'Phone: ' + phones.join(', ') : 'Phone: see the owner page in AppFolio',
      doc.zLink ? 'Z Inspector report: ' + doc.zLink : '',
      notes ? '\nZ Inspector notes:\n' + notes + '\n' : '', 'Booked from the Inspection Desk.'].filter(Boolean).join('\n');

    let ev;
    if (existing) { ev = existing; ev.setTime(slot, end); ev.setTitle(title); ev.setDescription(description); }
    else ev = cal.createEvent(title, slot, end, { description: description, guests: work, sendInvites: true });
    ev.setColor(CalendarApp.EventColor.ORANGE);
    const rem = reminderEvent_(doc, cal, work, slot, tz);

    const booked = Utilities.formatDate(slot, tz, "EEEE, MMMM d 'at' h:mm a");
    const moved = slot.getTime() !== start.getTime();
    const now = new Date().toISOString();
    const same = existing && Math.abs(existing.getStartTime().getTime() - slot.getTime()) < 60000;
    const note = (same ? 'Still on your calendar: ' : existing ? 'Moved to ' : 'On your calendar: ') + booked + (moved ? ' (your first choice was taken)' : '') +
      '. Invite sent to ' + work + '. Reminder email and a calendar backup: ' + rem.at + (workCal ? '; checked your work calendar for conflicts.' : '; your work calendar isn\u2019t shared with this account, so only the personal calendar was checked for conflicts.');
    doc.call = Object.assign({}, call, { zNotes: notes, eventId: ev.getId(), booked: booked, reminderEventId: rem.id, reminderAt: rem.at, bookedStart: slot.toISOString(),
      date: Utilities.formatDate(slot, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(slot, tz, 'HH:mm') });
    doc.steps = Object.assign({}, doc.steps, { call: true });
    doc.requests = Object.assign({}, doc.requests, { call: { state: 'done', at: now, note: note } });
    doc.activity = (doc.activity || []).concat([{ at: now, action: same ? 'Re-checked the follow-up call' : existing ? 'Moved the follow-up call' : 'Added the follow-up call to your calendar',
      detail: title + ' · ' + booked + ' · 30 min · invite to ' + work + '. ' + description.replace(/\n/g, ' · '), evidence: [] }]);
    doc.updatedAt = now;
    doc._version = (doc._version || 0) + 1;
    f.setContent(JSON.stringify(doc));
    return { booked: booked, note: note, version: doc._version };
  } finally { lock.releaseLock(); }
}
// Backup for the morning-after reminder email: a 15-minute event at 9 AM the day after the call,
// on the same calendars as the call, so the follow-up shows up even if the email is missed.
function reminderEvent_(doc, cal, work, slot, tz) {
  const day = Utilities.formatDate(new Date(slot.getTime() + 86400000), tz, 'yyyy-MM-dd');
  const s = Utilities.parseDate(day + ' 09:00', tz, 'yyyy-MM-dd HH:mm'), e = new Date(s.getTime() + 15 * 60000);
  const title = 'Follow-up – ' + doc.property + ': work orders needed?';
  const now = (doc.maintenance || []).filter(i => i.when !== 'later').map(i => '- ' + i.text);
  const description = ['After the call with ' + (doc.ownerName || 'the owner') + ', do any of these need a work order?'].concat(now.length ? now : ['- (see the Desk)'])
    .concat(['', 'A reminder email also goes to ' + work + ' around 9 AM. Inspection Desk: ' + DESK_URL]).join('\n');
  let ev = doc.call && doc.call.reminderEventId ? safeEvent_(cal, doc.call.reminderEventId) : null;
  if (ev) { ev.setTime(s, e); ev.setTitle(title); ev.setDescription(description); }
  else ev = cal.createEvent(title, s, e, { description: description, guests: work, sendInvites: true });
  ev.setColor(CalendarApp.EventColor.GRAY);
  return { id: ev.getId(), at: Utilities.formatDate(s, tz, "EEEE, MMMM d 'at' h:mm a") };
}
function firstFree_(calendars, start, ignoreId) {
  const tz = Session.getScriptTimeZone();
  const busyAt = t => {
    const e = new Date(t.getTime() + CALL_MINUTES * 60000);
    return calendars.some(c => c.getEvents(t, e).some(ev => !ev.isAllDayEvent() && ev.getId() !== ignoreId &&
      ev.getMyStatus() !== CalendarApp.GuestStatus.NO));
  };
  let day = new Date(start);
  for (let w = 0; w < WEEKS_TO_TRY; w++) {
    const dayStr = Utilities.formatDate(day, tz, 'yyyy-MM-dd');
    let t = w === 0 ? new Date(start) : Utilities.parseDate(dayStr + ' ' + DAY_START + ':00', tz, 'yyyy-MM-dd H:mm');
    const last = Utilities.parseDate(dayStr + ' ' + DAY_END + ':00', tz, 'yyyy-MM-dd H:mm');
    for (; t.getTime() + CALL_MINUTES * 60000 <= last.getTime(); t = new Date(t.getTime() + CALL_MINUTES * 60000))
      if (!busyAt(t)) return t;
    day = new Date(day.getTime() + 7 * 86400000);
  }
  return null;
}
// Read-only: the first free half hour from the Desk's suggested date and time, so the Desk (and the email) show a time that's actually open.
function freeSlot_(date, time) {
  const tz = Session.getScriptTimeZone(), work = config_('WORK_EMAIL') || 'eli@thesourcepm.com';
  const workCal = safeCal_(work), calendars = [CalendarApp.getDefaultCalendar()].concat(workCal ? [workCal] : []);
  const slot = firstFree_(calendars, Utilities.parseDate(date + ' ' + (time || '10:00'), tz, 'yyyy-MM-dd HH:mm'), null);
  return slot ? { date: Utilities.formatDate(slot, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(slot, tz, 'HH:mm') } : {};
}
// Read-only: can this account see the work calendar's busy times? Counts events in the next 7 days.
function calendarCheck_() {
  const work = config_('WORK_EMAIL') || 'eli@thesourcepm.com';
  const cal = safeCal_(work);
  if (!cal) return { workVisible: false };
  const now = new Date(), week = new Date(now.getTime() + 7 * 86400000);
  const evs = cal.getEvents(now, week).filter(ev => !ev.isAllDayEvent());
  return { workVisible: true, name: cal.getName(), eventsNext7Days: evs.length,
    sample: evs.slice(0, 3).map(ev => Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'EEE MMM d h:mm a')) };
}
function safeCal_(id) { try { return CalendarApp.getCalendarById(id); } catch (e) { return null; } }
function safeEvent_(cal, id) { try { return cal.getEventById(id); } catch (e) { return null; } }

// ---- Desk images ----
function imageFolder_() { return childFolder_(deskFolder_(), IMAGE_FOLDER); }
function imagePut_(body) {
  const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mimeType || 'image/jpeg', safeName_(body.filename));
  return imageFolder_().createFile(blob).getId();
}
function imageGet_(id) {
  const f = DriveApp.getFileById(id);
  // Only serve files the Desk owns or the app uploaded under the root folder.
  if (!isUnder_(f, rootFolder_().getId())) throw new Error('Not a Desk file');
  return { mimeType: f.getMimeType(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}
function isUnder_(file, rootId) {
  const seen = {};
  let parents = file.getParents();
  for (let depth = 0; depth < 4 && parents.hasNext(); depth++) {
    const p = parents.next();
    if (p.getId() === rootId) return true;
    if (seen[p.getId()]) break;
    seen[p.getId()] = true;
    parents = p.getParents();
  }
  return false;
}

// ---- auth ----
function checkToken_(token) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILURES) throw new Error('Too many wrong codes. Try again in an hour.');
  const accepted = [config_('UPLOAD_TOKEN'), config_('APP_TOKEN')].filter(Boolean);
  if (!accepted.length) throw new Error('UPLOAD_TOKEN is not set');
  if (!token || accepted.indexOf(token) < 0) {
    cache.put('fails', String(fails + 1), LOCKOUT_SECONDS);
    Utilities.sleep(1000);
    throw new Error('Bad token');
  }
}

// ---- folders ----
function rootFolder_() {
  const id = config_('ROOT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
}
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function propertyFolder_(property) { return childFolder_(rootFolder_(), safeName_(property || 'Unsorted')); }
function safeName_(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'file';
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run this once from the editor after calendar access is added: it triggers Google's permission prompt.
function authorizeCalendar() {
  Logger.log('Calendar access OK: ' + CalendarApp.getDefaultCalendar().getName());
}


// ---- Morning-after reminder ----
// Once an inspection's email is marked sent, at 9 AM the day after its follow-up call this account emails
// the work address: how did the call go, what the concerns were, and whether work orders are needed.
const DESK_URL = 'https://otterholte.github.io/inspection-inbox/';

// Run once from the editor: approves sending mail and starts the daily 9 AM check.
function setupDailyReminder() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sendFollowupReminders').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendFollowupReminders').timeBased().atHour(9).nearMinute(0).everyDays(1).inTimezone(Session.getScriptTimeZone()).create();
  Logger.log('Daily 9 AM follow-up reminder is on. Mail quota left today: ' + MailApp.getRemainingDailyQuota());
}

function sendFollowupReminders() {
  const tz = Session.getScriptTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const it = deskFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/\.json$/.test(f.getName())) continue;
    const d = readDoc_(f), call = d.call || {};
    if (!(d.steps || {}).sent || d.followupReminderSent) continue;
    const callDay = call.bookedStart ? Utilities.formatDate(new Date(call.bookedStart), tz, 'yyyy-MM-dd') : call.date;
    if (!callDay || callDay >= today) continue;   // the morning after the call, or later if it was missed
    sendReminder_(f.getName().replace(/\.json$/, ''), false);
  }
}

function reminderSubject_(d) { return 'Inspection follow-up – ' + d.property; }
function sendReminder_(slug, isTest) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = docFile_(slug);
    if (!f) throw new Error('Not found');
    const d = readDoc_(f), call = d.call || {};
    const now = (d.maintenance || []).filter(i => i.when !== 'later').map(i => i.text);
    const later = (d.maintenance || []).filter(i => i.when === 'later').map(i => i.text);
    const recs = (d.recs || []).map(r => r[0] + (r[1] ? ' (' + r[1] + ')' : ''));
    const callText = call.booked || [call.date, call.time].filter(Boolean).join(' ');
    const owner = d.ownerName || 'the owner';
    const phones = [].concat(d.ownerPhones || []).join(', ');
    const list = (title, items) => items.length ? '<p><b>' + title + '</b></p><ul>' + items.map(t => '<li>' + esc_(t) + '</li>').join('') + '</ul>' : '';
    const html = '<p>How did the follow-up call with <b>' + esc_(owner) + '</b> go?</p>' +
      '<p><b>Property:</b> ' + esc_(d.property) + '<br><b>Call:</b> ' + esc_(callText || 'not booked') + (phones ? '<br><b>Phone:</b> ' + esc_(phones) : '') +
      (d.zLink ? '<br><b>Report:</b> <a href="' + d.zLink + '">' + d.zLink + '</a>' : '') + '</p>' +
      list('Needs attention now', now) + list('Plan for later', later) + list('Recommendations you sent', recs) +
      '<p><b>Do any of these need a work order?</b> If the owner didn\u2019t reply, it\u2019s worth putting them in so nothing gets missed.</p>' +
      '<p><a href="' + DESK_URL + '">Open the Inspection Desk</a></p>';
    const plain = html.replace(/<li>/g, '- ').replace(/<br>|<\/p>|<\/li>|<\/ul>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n');
    const subject = (isTest ? '[Test] ' : '') + reminderSubject_(d);
    MailApp.sendEmail({ to: config_('WORK_EMAIL') || 'eli@thesourcepm.com', subject: subject, htmlBody: html, body: plain, name: 'Inspection Desk' });
    if (!isTest) {
      const at = new Date().toISOString();
      d.followupReminderSent = at;
      d.activity = (d.activity || []).concat([{ at: at, action: 'Sent you the follow-up reminder email', detail: subject + ' → ' + (config_('WORK_EMAIL') || 'eli@thesourcepm.com'), evidence: [] }]);
      d._version = (d._version || 0) + 1;
      f.setContent(JSON.stringify(d));
    }
    return { subject: subject };
  } finally { lock.releaseLock(); }
}
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
