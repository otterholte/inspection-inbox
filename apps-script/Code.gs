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
      date: d.date, steps: d.steps, requests: d.requests, checks: d.checks });
  }
  return out;
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
