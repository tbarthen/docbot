# DocBot

A Chrome extension that records a click-through of a web application as annotated screenshots and saves the result as a single HTML file or a PDF.

## How it works

1. Open the page you want to document and click the DocBot toolbar button, then **Record this tab**.
2. Click through the site. Each click is captured as a close-up with a red marker, and each new screen is captured in full once it has settled. The popup closes; the toolbar icon shows **REC** while recording.
3. Reopen the popup (from any tab) and click **Stop & open report**, or press **Alt+Shift+R**.
4. The report opens in a new tab. **Save as HTML** downloads one self-contained file with the images embedded. **Print / Save as PDF** uses Chrome's print dialog.

Closing the recorded tab also ends the recording and opens the report. The last three recordings are kept and can be reopened from the popup; older ones are deleted when a new recording ends.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

## Settings

The popup has the capture settings: which events to record, whether to take a close-up per click, and the screenshot quality (medium is the sensible default). The options page (link in the popup, or right-click the toolbar icon and choose Options) has the privacy switch for recording typed text (off by default) and the auto-fill settings.

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

`AUDIT.md` is the review that led to version 2.0.
