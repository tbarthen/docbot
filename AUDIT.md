# DocBot hardening and design audit

> **Status:** the recommendations in sections 1 to 4 and the plan in section 6 were implemented in version 2.0 (see the commit history and README.md). Section 5 was resolved by removing the AI feature.

Scope: every file in the repo as of commit `625a14c` (manifest v3 Chrome extension, ~3,800 lines). Nothing was changed; this document is findings and recommendations only. Line references are to the current files.

## Summary

1. **The report is huge because click screenshots are stored as PNG and every image is encoded three times.** The capture is JPEG at your chosen quality, then re-encoded as JPEG 90, then (for clicks) re-encoded as lossless PNG. Your "quality" setting only affects the first of the three encodes. Measured: a click crop ends up 4x larger than a single JPEG encode; a full-page shot on a 200% display ends up 4x larger than a downscaled one. Details and numbers in section 1.
2. **Each click can produce up to four screenshots**, most of them of the same screen. That multiplies the byte problem by the page count. Section 1.2.
3. **The stop-and-get-results flow has a trap:** the popup only shows the Stop button when you open it on the exact tab that was being recorded. On any other tab it shows "Ready to record" with Start enabled, and pressing Start silently wipes the recording in progress. Section 2.
4. **Recording silently stops on a page reload or a same-path navigation** (for example a search results page whose only change is the query string), because the re-injection heuristic decides they are "not real navigations". Section 3, H1.
5. **Actions are dropped after ~30 seconds of idle** because the service worker restarts and handles the first message before it has finished restoring state from storage. Section 3, H2.

The AI feature has a retired model ID and a hard-coded USPS prompt. Since you don't use it, I recommend removing it or moving it behind a feature flag rather than fixing it. Section 5.

## 1. Why the exported document is so large

### 1.1 Bytes per image: triple encoding, and PNG for clicks

The pipeline in `background.js` `captureScreenshot()` (line 415) is:

| Step | Function | Output format | Honors your quality setting? |
|---|---|---|---|
| Capture | `chrome.tabs.captureVisibleTab` (line 462) | JPEG at 50/70/90 | Yes |
| Trim or crop | `trimWhitespace` (line 596) / `cropToClickArea` (line 716) | JPEG at fixed 0.9 | No |
| Draw the red circle | `addVisualIndicator` (line 863) | **PNG** (`quality` is ignored for PNG) | No |

Every click screenshot goes through all three. Navigation screenshots go through the first two. So the final bytes for clicks are a lossless PNG of an image that already contains JPEG artifacts, which is the worst case for PNG compression. The dropdown's "~2 MB / ~3-4 MB / ~7-8 MB" labels in `popup.html` (lines 90 to 92) describe a pipeline that no longer exists.

Measured with the bundled Chromium on a synthetic form-heavy page at 1920x1080, replaying the exact encode chain:

| | 100% display | 125% display (common on Windows) | 200% display |
|---|---|---|---|
| Captured bitmap | 1920x1080 | 2400x1350 | 3840x2160 |
| Click crop as stored today (PNG) | 134 KB | 159 KB | 84 KB* |
| Click crop, single JPEG 70 encode | 33 KB | 38 KB | 21 KB* |
| Full shot as stored today (JPEG 90 re-encode) | 271 KB | 349 KB | 658 KB |
| Full shot downscaled to 1600 px wide, JPEG 70 | 141 KB | 145 KB | 161 KB |

\* At 200% the fixed 1200x400 crop covers a quarter of the CSS area it covers at 100%, which is a separate bug (see H4). Real pages with more visual detail will inflate the PNG more than this synthetic page did.

There is a second, downstream cost. `report.html` is turned into a PDF through Chrome's print dialog. In practice Chrome's PDF writer passes JPEG data through unchanged but stores other image formats losslessly, so the PNG click captures get no help from the print step either.

**Fix:** decode once, do crop or trim and the indicator on one canvas, encode once as JPEG at the chosen quality. Downscale full captures to a maximum width (1600 px is plenty for a document) and divide by `devicePixelRatio` so HiDPI displays don't quadruple the pixel count. Expected result from the table: roughly 4x smaller per image before any change to the count.

### 1.2 Count per click: up to four screenshots for one action

Reading `content.js` and `background.js` together, one click on a link that loads a new page triggers:

1. The cropped click screenshot (`content.js` line 285 → `captureAction`).
2. After the click is re-dispatched, `detectPageStabilization` (line 310) sends a `post_click_state` navigation with a full screenshot if the DOM changed at all before unload.
3. `handleBeforeUnload` (line 732) sends a `page_unload` navigation with a full screenshot. This fires during unload, so the capture races the navigation and often shows either the same screen as item 2 or a blank page.
4. `webNavigation.onCommitted` (`background.js` line 120) captures another full screenshot of the new page after 500 ms.

If the link is a hash link, the `hashchange` handler (line 686) adds a fifth, and both it and item 2 capture the same view at different delays. The 600 ms cooldown in `captureAction` (line 391) silently drops whichever capture arrives too soon, so which of these survive is timing dependent, and sometimes the one dropped is the click crop itself, leaving a click with no image.

**Fix:** decide on one policy and enforce it in one place. The policy that matches your use case: one cropped shot per click, plus one full shot per new screen, taken when the screen has settled. Concretely: drop the `beforeunload` capture (unreliable by construction), and have the background dedupe by comparing the new capture's hash or URL and timestamp against the last full capture, replacing rather than appending when a full capture arrives within about two seconds of the previous one for the same URL. Queue captures behind the 2-per-second limit instead of dropping them.

### 1.3 Other bloat

- `handleInput` (`content.js` line 582) fires on every keystroke, and each one appends an action and rewrites the whole `recordingData` object to `chrome.storage.local` and messages the popup. A 30-character field produces 30 actions. Listen to `change` (or debounce `input`) and record one action per field.
- Each screenshot record embeds a full copy of its action (`associatedAction`, `background.js` line 518), so the JSON export contains every action twice.

## 2. The record, stop, get-results flow

What you want: press record, click through, press stop, be offered the results. What the code does today, and where it breaks:

**Stop is only reachable from the original tab.** `popup.js` `checkRecordingState` (line 113) shows the recording UI only when `recordingTabId` equals the active tab. Open the popup anywhere else and you get "Ready to record" with Start enabled. Pressing Start calls `startRecording`, which clears IndexedDB (`background.js` line 262) and replaces `recordingData`, so the in-progress recording is gone with no warning. If the site you're documenting opens a new tab or window, this is the state you're in.

**No feedback when recording can't start.** `startRecording` responds `success: true` (line 215) before it has injected anything. On a `chrome://` page, the Web Store, a PDF viewer, or a page whose tab has been discarded, injection fails inside `injectContentScripts` (line 111), which only logs. The popup shows "Recording in progress..." forever with nothing captured.

**A closed tab leaves recording on.** There is no `chrome.tabs.onRemoved` handler. Close the recorded tab and the badge stays red, storage says recording, and nothing can stop it except starting a new recording (which discards the old one).

**"Export to PDF" is two hops with a misleading name.** It opens `report.html`, which has a "Print to PDF" button, which opens Chrome's print dialog. There's no way to save the report as a file directly.

**"Export Raw Data" is broken.** `handleExportJson` (`popup.js` line 400) calls `chrome.downloads.download`, but `manifest.json` doesn't declare the `downloads` permission, so `chrome.downloads` is undefined and the click throws.

**The report depends on live extension storage.** `report.js` reads `completedRecording` and IndexedDB at load time. There is exactly one slot: the next recording overwrites it. If you record again before printing, the previous report is unrecoverable.

**The popup mixes four concerns.** Capture settings, screenshot quality, auto-fill, and the API key are in one settings panel, with the AI button first in the export list.

### Proposed flow

1. **Start.** Popup: one big Record button and one line of text saying which tab will be recorded. Start validates the tab URL is http(s), awaits injection, and returns an error string to the popup on failure. The badge shows REC while recording.
2. **While recording.** The popup, opened from any tab, shows "Recording *page title*" with a Stop button and the live counts. Stop works from any tab. Closing the recorded tab auto-stops and finalizes the recording rather than losing it.
3. **Stop.** On stop, the background finalizes and immediately opens the report tab. That is the "offer": the report page has two primary buttons, **Save as HTML** (a single self-contained file with the images embedded, via a Blob download from the report page itself, which needs no extra permission) and **Print / Save as PDF**. The popup, if reopened, shows "Last recording: N screens" with Open report and Save buttons. Starting a new recording while an unsaved one exists asks for confirmation.
4. **Keep the last few recordings.** Key IndexedDB entries by session ID (the ID already has the prefix) and delete only sessions older than the last three, instead of clearing everything on start.
5. **Settings.** Move auto-fill and the API key to a separate Options page (`options_ui` in the manifest). Keep the popup to capture toggles and the quality dropdown, with honest size labels. Optionally add a keyboard shortcut (`commands` in the manifest) to stop recording without opening the popup.

A self-contained HTML file with JPEG data URLs will typically be smaller than Chrome's print-to-PDF output for the same images, and it is the natural artifact for "download the results".

## 3. Hardening findings

Ranked by impact on your stated use case. H = high, M = medium, L = low.

### H1. Recording stops after a reload or same-path navigation

`background.js` lines 134 to 164 decide whether to re-inject the content script by comparing origin, path, and two flow-ID query parameters. But `webNavigation.onCommitted` for a main frame means a new document has loaded and the old content script is gone, regardless of URL. A reload, a search page whose query string changed, or a form post back to the same URL more than three seconds after the `submit` flag was set all take the "skip re-injection" branch (line 204). From then on, clicks are neither intercepted nor recorded, with no indication.

**Fix:** always re-inject on main-frame `onCommitted`. Chrome may also fire it for same-document navigations, so make injection idempotent: send a `ping` message to the tab first and inject only if there's no answer. Keep the URL comparison only for deciding whether to take a screenshot.

### H2. Actions dropped while the service worker restarts

`restoreRecordingState()` (line 43) is called at module load but is async. When Chrome wakes the worker to deliver a `captureAction` message (which happens after every idle period longer than about 30 seconds), the message handler at line 225 runs before the storage read has resolved, sees `isRecording === false`, and discards the action with a console log. `recordingData` is also the empty default object at that moment; anything pushed to it is overwritten when the restore completes.

**Fix:** store the restore promise (`const ready = restoreRecordingState()`) and `await ready` at the top of the message handler and the `onCommitted` handler before touching state.

### H3. Click interception can swallow a click

`handleClick` (`content.js` line 253) calls `preventDefault` and `stopImmediatePropagation` on every click, then re-dispatches a synthetic click after the background answers. If the background never answers (worker killed mid-message, `captureVisibleTab` hanging on a tab that isn't visible), the callback never runs and the user's click does nothing. There is no timeout in `sendAction` (line 747).

Also: the synthetic event has `isTrusted: false`, so anything the page gates on a trusted click may not work (file pickers are the usual casualty). And the listener is removed and re-added on a 100 ms timer (line 322); if the recording stops inside that window, the re-add reinstalls the interceptor on a page that is no longer recording, so every later click still takes the round trip until the page is reloaded.

**Fix:** add a timeout (about 800 ms) in `sendAction` that fires the callback regardless. Consider not intercepting at all: capture the crop on `mousedown` instead (the screen hasn't changed yet, and no re-dispatch is needed) and let the real click proceed untouched. That removes the synthetic-event and swallowed-click classes of bugs entirely.

### H4. Click coordinates are in CSS pixels, the screenshot is in device pixels

`captureVisibleTab` returns the viewport at the device pixel ratio, but `cropToClickArea` (line 621) and `addVisualIndicator` (line 791) use `event.clientX/Y` directly. At 125% Windows scaling a click at CSS (800, 400) is at bitmap (1000, 500), so the crop and the red circle are off by 200 and 100 pixels. The fixed 1200x400 crop also covers a different physical area at each scaling.

**Fix:** send `window.devicePixelRatio` with each click and multiply positions and crop size by it, or downscale the bitmap by the ratio before cropping (which also fixes the file size).

### H5. Screenshots come from the active tab, not the recorded tab

`captureVisibleTab(null, ...)` (line 462) captures whatever is active in the current window. If you switch tabs or windows while a delayed capture fires (the 500 ms and 1000 ms timers, the stabilization callback), the image is of the wrong tab. If the recorded tab isn't visible at all, the call throws and the screenshot is silently null.

**Fix:** pass the recorded tab's `windowId`, and before capturing check `tab.active`; if not, skip with a recorded reason.

### M1. Only one recording survives, and starting a new one destroys it

Covered in section 2. `clearOldScreenshots()` on every start (line 262) plus a single `completedRecording` key. Consider also adding the `unlimitedStorage` permission; without it, IndexedDB data in an extension is eligible for eviction under storage pressure.

### M2. Listener lifecycle leaks

`removeEventListeners` (`content.js` line 810) removes the click, input, change, and beforeunload listeners only. The `contextmenu`, `submit`, `popstate`, and `hashchange` listeners, the storage `onChanged` listener, the mutation observer for auto-fill, and the `history.pushState` / `replaceState` monkey-patches (line 658) are never removed. Starting recording twice on the same page (which re-injects) stacks a second `hashchange` handler, so hash navigations then produce duplicate screenshots. `pushState` gets double-wrapped.

**Fix:** collect every listener and observer in one cleanup function and restore the original history methods.

### M3. Form values recorded in plain text, per keystroke

`handleInput` records up to 50 characters of every field's value, redacting only `type=password`, `autocomplete=cc-number`, and names containing "ssn". Email, date of birth, account numbers, and card fields not annotated that way all land in `chrome.storage.local` and the JSON export in plain text. Since the report is screenshots-only, the values serve no purpose in the document.

**Fix:** record that a field changed and its label, not its value, unless a setting explicitly opts in.

### M4. Duplicate `initial_load` action

`startRecording` pushes a synthetic `initial_load` navigation after one second (line 309) and the injected content script's `capturePageLoad` (line 644) sends another. The first two actions of every recording are the same event.

### M5. `chrome.tabs.get` callback doesn't check for errors

`background.js` line 188: if the tab was closed during the 500 ms delay, `tab` is undefined and `captureAction` throws on `tab.url` inside a timer, unhandled.

### L1. The popup's AI result page is likely to fail intermittently

`handleAnalyze` (`popup.js` line 331) creates a Blob URL in the popup document and opens it in a new tab. Creating the tab closes the popup, which revokes the Blob URL, so the tab can load a dead URL. It also injects model output into HTML unescaped. Moot if the AI feature is removed.

### L2. Permissions

`<all_urls>` plus `tabs`, `scripting`, and `webNavigation` is broad but justified for re-injection after navigation. Missing: `downloads` (needed by the current JSON export, or drop that code) and arguably `unlimitedStorage`. The API key is stored in plain text in `chrome.storage.local`; that's normal for an extension but worth a note in the options page.

### L3. `setup.sh` would corrupt the icons

It writes SVG text into the three `.png` files. The PNGs in the repo are real PNGs now, so running the script again would break them. It also hard-codes a WSL path. Delete it or replace it with a README section.

## 4. Dead code and duplication

Removing these takes ~500 lines out of ~3,800 with no behavior change:

- `background.js` `generateReportHTML` (lines 986 to 1223) and `formatActionDetails` (line 1225): unused, references `screenshot.dataUrl` which no longer exists, contains a "USPS" heading.
- `background.js` `addVisualIndicator` branch for `input` / `select` / `toggle` (lines 840 to 860): unreachable, those types never get screenshots.
- `content.js` `detectPageStabilization` and `detectPageStabilizationExtended` (lines 368 and 473) are the same 100 lines with three constants changed. Parameterize.
- `submit-dialog.js`: never injected or referenced anywhere.
- `autofill.js` `findSubmitButtons`, the `useRealistic` parameter; `content.js` `autoFillTriggered`.
- `report.js` `formatActionDetails` (line 125): unused.
- `popup.js` `handleExportPdf` sends the whole `recordingData` over messaging (line 370); the background ignores it and just opens a tab.
- `popup.js` lines 56 to 60, the "force a repaint" hack, and the `alert()` calls; `alert` in an extension popup is jarring, an inline status line is better.
- `README.md` is empty. `.claude/settings.local.json` is committed; it's personal and usually gitignored.

## 5. The AI feature

`background.js` line 889 uses `claude-3-5-sonnet-20241022`, which is retired; requests will fail. The prompt at line 937 is hard-coded to "a USPS web application where customers enroll in services". `buildAnalysisPrompt` declares every image as `image/jpeg` (line 968) but click captures are PNG, so the API would reject them even with a valid model. The current default model ID is `claude-opus-5-5`.

Since you use DocBot on a machine without AI access, my recommendation is to remove the feature (the button, the API key field, `analyzeWithAI`, `buildAnalysisPrompt`) and keep the JSON export as the hook for doing analysis elsewhere. If you'd rather keep it, it needs the model ID updated, the prompt made generic or user-editable, the media type fixed, and the result rendered by escaping or by an extension page rather than a Blob URL.

## 6. Suggested order of work

Each phase is independently shippable.

1. **Size (one afternoon).** Single-encode pipeline in `captureScreenshot`; JPEG only; downscale by device pixel ratio to a max width; fix coordinates for DPR (H4). Remove the `beforeunload` capture. Dedupe full captures within two seconds of each other for the same URL. Honest labels on the quality dropdown. This alone should cut the report by well over 4x for the same clicks.
2. **Reliability (one afternoon).** Await restore in the message handler (H2). Always re-inject on `onCommitted` with a ping check (H1). Timeout in `sendAction` (H3). Capture from the recorded tab only (H5). Auto-stop on tab close. Full cleanup function (M2). One `initial_load`.
3. **Flow (one afternoon).** Stop from any tab; open the report on stop; "Save as HTML" on the report page; confirmation before overwriting; keep the last three sessions; error reporting from start.
4. **Cleanup.** Dead code, AI feature removal or gating, options page, README, delete `setup.sh`, `.gitignore` the local settings file.
5. **Optional.** Capture on `mousedown` instead of intercepting clicks (H3, second part). Record field labels instead of values (M3).
