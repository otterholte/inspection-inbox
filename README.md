# Inspection Inbox

A small phone app (PWA) for sending property inspection files to Google Drive:

- **Voice memos**: record in the app, or upload a memo from Voice Memos / Recorder / Files (.m4a, .mp3, .wav, .ogg, .aac, .amr, .3gp, .webm)
- **Checklist scans**: photograph the front and back; the app cleans them up and uploads one PDF
- **Quick notes**: short text notes

Files land in `My Drive / Inspections Inbox / <property> /`. Transcription and write-ups happen later on the PC (local Whisper + Claude Code), so the app itself needs no AI keys.

## One-time setup

### 1. Create the upload endpoint (Google Apps Script)

The same script also books tentative owner follow-up calls on your calendar, so create it in your **work** Google account (eli@thesourcepm.com).

1. Go to <https://script.google.com>, signed in to the work account, and click **New project**.
2. Replace the code with [`apps-script/Code.gs`](apps-script/Code.gs). In **Project Settings**, tick *Show "appsscript.json"* and replace that file with [`apps-script/appsscript.json`](apps-script/appsscript.json) (sets Mountain time and the Drive + Calendar permissions). Save.
3. **Project Settings** (gear) → **Script Properties** → **Add script property**: name `UPLOAD_TOKEN`, value a long random string (treat it like a password).
4. **Deploy** → **New deployment** → type **Web app** → *Execute as*: **Me** → *Who has access*: **Anyone** → **Deploy**, then approve the Drive permission.
5. Copy the **Web app URL** (ends in `/exec`).

"Anyone" only means the URL can be reached without a Google sign-in; uploads without the matching token are rejected.

### 2. Install the app on your phone

1. Open <https://otterholte.github.io/inspection-inbox/>.
2. **iPhone (Safari):** Share → **Add to Home Screen**. **Android (Chrome):** ⋮ → **Add to Home screen** / **Install app**.
3. Open it from the home screen → **Settings** → paste the Web app URL and the token → **Save** → **Test** should say *Connected*.

## Using it

1. Type (or pick) the property address.
2. Record or upload a memo, scan the checklist front + back, or add a note.
3. Each upload shows ✓ Saved when it's in Drive.

## Call scheduling

Claude Code (on the PC) posts `{"action": "scheduleCall", "token": ..., "title": ..., "description": ...}` to the same URL. The script finds the first free 30-minute slot between 10 AM and 4 PM on the next eligible Wednesday (at least 2 days out, so a Tuesday never books tomorrow; searches up to 4 Wednesdays), creates an orange **Tentative:** event, and returns the time plus the first Friday more than 48 hours out for the "I'm also available Friday" line.

If you change `Code.gs`, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.
