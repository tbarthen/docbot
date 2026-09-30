# DocBot

A Chrome extension that records a click-through of a web application as annotated screenshots and saves the result as a single HTML file or a PDF.

## How it works

1. Open the page you want to document and click the DocBot toolbar button, then **Record this tab**.
2. Click through the site. Each click is captured as a close-up with a red marker, and each new screen is captured in full once it has settled. The popup closes; the toolbar icon shows **REC** while recording.
3. To move through pages you don't want in the document, click **Pause screenshots** in the popup or press **Alt+Shift+P**; the toolbar badge shows **II**. Press it again to resume.
4. Reopen the popup (from any tab) and click **Stop & open report**, or press **Alt+Shift+R**.
5. The report opens in a new tab. **Save as HTML** downloads one self-contained file with the images embedded. **Print / Save as PDF** uses Chrome's print dialog.

Closing the recorded tab also ends the recording and opens the report. If the browser is restarted while recording, what was captured is kept and listed in the popup. The last three recordings are kept and can be reopened from the popup; older ones are deleted when a new recording ends.

The shortcuts can be changed at `chrome://extensions/shortcuts` (useful on Windows with more than one keyboard layout, where Alt+Shift also switches languages).

Only the recorded tab is captured, and only its top-level page: clicks inside embedded iframes are not logged, though full-screen captures still show them.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

## Settings

The popup has the capture settings: which events to record, whether to take a close-up per click, whether to draw the red marker on the clicked spot, and the screenshot quality (medium is the sensible default). The options page (link in the popup, or right-click the toolbar icon and choose Options) has the privacy switch for recording typed text (off by default) and the auto-fill settings.

## Testing

```
npm install
npm test
```

`test/e2e.mjs` loads the unpacked extension into Chromium, records a click-through of the local site in `test/site.mjs`, and checks captures, captions, pause, markers, the report, the saved HTML file, and the edge cases from `AUDIT-2.md`. Screenshots of the popup and report land in `test/out/`.

## Files

| File | Role |
|---|---|
| `background.js` | Service worker: recording state, screenshot capture and processing, sessions |
| `content.js` | Injected into the recorded tab: clicks, form changes, navigation, page settling |
| `autofill.js` | Optional test-data filler, also available from the right-click menu |
| `db.js` | IndexedDB helper shared by the worker, popup and report |
| `popup.*` | Toolbar popup |
| `options.*` | Options page |
| `report.*` | Report page with HTML and PDF export |

`AUDIT.md` is the review that led to version 2.0; `AUDIT-2.md` is the follow-up review whose fixes are in 2.1.
