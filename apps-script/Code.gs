/**
 * Inspection Inbox upload endpoint (Google Apps Script web app).
 *
 * Saves files posted by the Inspection Inbox phone app into
 *   My Drive / Inspections Inbox / <property> / <file>
 *
 * Setup (once):
 *   1. Project Settings -> Script Properties -> add UPLOAD_TOKEN = <long random string>.
 *   2. Deploy -> New deployment -> Web app. Execute as: Me. Who has access: Anyone.
 *   3. Paste the web app URL and the same token into the phone app's Settings.
 * Requests without the matching token are rejected.
 */

const ROOT_FOLDER_NAME = 'Inspections Inbox';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    if (body.action === 'scheduleCall') return json_(scheduleCall_(body));

    const folder = propertyFolder_(body.property);
    const bytes = Utilities.base64Decode(body.data);
    const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', safeName_(body.filename));
    const file = folder.createFile(blob);
    if (body.kind) file.setDescription(body.kind);

    return json_({ ok: true, id: file.getId(), name: file.getName(), folder: folder.getName() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// Lets the app's Settings screen test the URL and token.
function doGet(e) {
  try {
    checkToken_(e.parameter.token);
    return json_({ ok: true, root: rootFolder_().getName() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * Books a tentative 30-minute owner follow-up call on the next eligible Wednesday,
 * in the first free slot between 10:00 and 16:00 (script time zone).
 * "Eligible" = at least MIN_DAYS_AHEAD days out, so a Tuesday inspection skips tomorrow.
 * body: { title, description, minDaysAhead? }
 * Also returns the first Friday more than 48 hours out (3+ days), for the "I'm also free Friday" line.
 */
const CALL_WEEKDAY = 3;          // Wednesday
const ALT_WEEKDAY = 5;           // Friday
const DAY_START_HOUR = 10, DAY_END_HOUR = 16, SLOT_MINUTES = 30;
const MIN_DAYS_AHEAD = 2;
const WEEKS_TO_SEARCH = 4;

function scheduleCall_(body) {
  const cal = CalendarApp.getDefaultCalendar();
  const now = new Date();
  let day = nextWeekday_(now, CALL_WEEKDAY, body.minDaysAhead || MIN_DAYS_AHEAD);

  for (let w = 0; w < WEEKS_TO_SEARCH; w++, day = addDays_(day, 7)) {
    const busy = cal.getEvents(atHour_(day, DAY_START_HOUR), atHour_(day, DAY_END_HOUR))
      .filter(ev => !ev.isAllDayEvent() && ev.getMyStatus() !== CalendarApp.GuestStatus.NO);
    for (let t = atHour_(day, DAY_START_HOUR); t.getTime() + SLOT_MINUTES * 60000 <= atHour_(day, DAY_END_HOUR).getTime();
         t = new Date(t.getTime() + SLOT_MINUTES * 60000)) {
      const end = new Date(t.getTime() + SLOT_MINUTES * 60000);
      if (busy.some(ev => ev.getStartTime() < end && ev.getEndTime() > t)) continue;
      const ev = cal.createEvent('Tentative: ' + (body.title || 'Owner follow-up call'), t, end,
        { description: body.description || '' });
      ev.setColor(CalendarApp.EventColor.ORANGE);
      return { ok: true, eventId: ev.getId(), start: t.toISOString(), end: end.toISOString(),
        startText: fmt_(t, "EEEE, MMMM d 'at' h:mm a"),
        altFriday: fmt_(nextWeekday_(now, ALT_WEEKDAY, 3), 'EEEE, MMMM d') };
    }
  }
  return { ok: false, error: 'No free 30-minute slot on the next ' + WEEKS_TO_SEARCH + ' Wednesdays (10-4)' };
}

// First date with the given weekday that is at least minDays calendar days after `from`.
function nextWeekday_(from, weekday, minDays) {
  let d = addDays_(startOfDay_(from), minDays);
  while (d.getDay() !== weekday) d = addDays_(d, 1);
  return d;
}
function startOfDay_(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function atHour_(d, h) { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; }
function fmt_(d, pattern) { return Utilities.formatDate(d, Session.getScriptTimeZone(), pattern); }

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('UPLOAD_TOKEN');
  if (!expected) throw new Error('UPLOAD_TOKEN is not set in Script Properties');
  if (token !== expected) throw new Error('Bad token');
}

function rootFolder_() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
}

function propertyFolder_(property) {
  const root = rootFolder_();
  const name = safeName_(property || 'Unsorted');
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function safeName_(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'file';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
