# DocBot 2.0 hardening audit

Scope: every file as of commit `a0b44e2` (the version with pause and the marker toggle). Read in full and reviewed adversarially; two findings were verified with a live Chromium experiment rather than asserted. Nothing was changed. The first audit is in `AUDIT.md`.

## Summary

The structural problems from the first audit are gone: single encode, one policy for captures, restore-before-handle, re-injection on every new document, stop from any tab, a durable export. What remains is a second tier: edge cases in click replay, one data-correctness bug in Save as HTML, a dead feature, and a handful of state races. Nothing here corrupts a recording in normal use; most of it shows up only under fast clicking, browser restarts, or unusual pages.

Ranked by impact:

| # | Finding | Severity | Effort |
|---|---|---|---|
| H1 | Save as HTML pairs images with screenshots by index; one missing image shifts every later one | High | Small |
| H2 | Fast clicking backs up the capture queue; a click close-up can then be taken after the screen changed, with the marker at stale coordinates | High | Small |
| H3 | Replayed click is lost when the page re-rendered the clicked element during the hold | Medium | Small |
| H4 | Browser restart leaves a recording "running" against a tab ID that no longer exists | Medium | Small |
| M1 | The pushState / replaceState hook never fires (isolated world); SPA route changes are logged only via clicks and hash changes | Medium | Medium |
| M2 | Click captions and the action log take the first 100 characters of whatever was clicked, including large containers | Medium | Small |
| M3 | Two simultaneous Start calls both pass the guard | Low | Tiny |
| M4 | Tab replaced by prerender or tab-discard gives a new tab ID the recorder doesn't follow | Low | Tiny |
| M5 | Stale window ID after moving the tab between windows | Low | Tiny |
| L1 | Concurrent IndexedDB opens leak a connection | Low | Tiny |
| L2 | Page-load caption prefers the tab title over the document title captured in the page | Low | Tiny |
| L3 | Skipped screenshots are logged but never shown to the user | Low | Small |
| L4 | No tests in the repo; the end-to-end scripts that validated 2.0 live outside it | Medium | Small |
| L5 | Alt+Shift shortcuts collide with the Windows input-language switch on some setups | Low | None |
| L6 | Clicks inside cross-origin iframes are not recorded | Info | Medium |

## High

### H1. Save as HTML misaligns images when any screenshot is missing

`report.js` `saveAsHtml` (line 148 onward) clones the page and walks `clone.querySelectorAll('img')`, pairing `images[i]` with `session.screenshots[i]`. But `renderSession` (line 75) replaces a missing screenshot's `<img>` with a placeholder `<div>`. After one missing image the indices no longer line up: every later step gets the previous step's picture. A missing image is unusual (a capture that failed after the record was written, a pruned session opened from a stale tab, a legacy v1 session) but the failure is silent and the saved document is wrong.

**Fix:** put `data-shot-id` on each `<img>` in `buildStep` and look the blob up by that id in `saveAsHtml`. Five lines.

### H2. Capture backlog under fast clicking produces misleading close-ups

Every click enqueues a crop, and every click whose DOM changed also enqueues a full capture 600 ms later; the queue enforces 550 ms spacing (`background.js` line 418). Click five times in two seconds and the queue holds roughly ten jobs, or five seconds of work. Meanwhile the content script releases each held click after 1.5 s (`content.js` line 13). The crop for a late click then runs well after the click was replayed, so it captures the *new* screen with the marker at the *old* coordinates. The dedupe rule only merges consecutive full captures, so it does not help here.

**Fix (three parts, all small):**
1. In `doCapture`, skip a crop whose enqueue time is older than the click timeout; record `screenshotError = 'stale'` on the action instead of taking a misleading picture.
2. In `handleClick`, cancel the previous click's pending `waitForStabilization` when a new click arrives. Only the last click's settled state matters, and this stops full captures from piling up. Keep a reference to the current observer's cancel function.
3. Optionally, when the content script's hold times out, send a `cancelCapture` message so the background drops the queued crop immediately rather than at dequeue time.

### H3. Replayed click dispatched to a detached element

`handleClick` replays on the original `target` (`content.js` line 142). If the page re-rendered that element during the hold (focus-triggered re-render in Vue or Svelte, a menu that closes on `mousedown`, a React component keyed on state that changed on focus), the node is detached, the synthetic click reaches no handlers, and the user's click silently does nothing. They click again, and the second attempt works, so it reads as "flaky site".

**Fix:** at replay time, if `!target.isConnected`, resolve a fresh target with `document.elementFromPoint(event.clientX, event.clientY)` and dispatch there. Two lines.

### H4. Recording survives a browser restart against a dead tab

`restoreState` (`background.js` line 33) trusts the stored tab ID. After Chrome is closed and reopened (tabs are restored with new IDs, and no `onRemoved` fires during shutdown), the worker restores `isRecording = true`, the badge shows REC, the popup says "Recording is running in another tab", and nothing is ever captured. Stop still works, so it is recoverable, but it looks like a stuck extension.

**Fix:** in `restoreState`, `chrome.tabs.get(recordingTabId)`; if it throws, finalize the session with `stopRecording({ reason: 'browser_restart', openReport: false })` so the partial recording is kept and listed in the popup without a report tab popping up at startup. `stopRecording` needs an `openReport` option.

## Medium

### M1. History API hook is dead code

`captureHistoryNavigation` (`content.js` lines 257 to 274) replaces `history.pushState` and `history.replaceState`. Content scripts run in an isolated world with their own `history` wrapper, so the page's own calls never go through the replacement. Verified: a hook installed from an isolated world saw zero calls when the page called `pushState`. This was equally dead in v1; the restore-on-cleanup code is likewise unnecessary. `popstate` and `hashchange` are real DOM events and do work.

Practical impact is limited because `post_click_state` already captures the screen after a click that changed the DOM, which covers most SPA route changes. What is missed: route changes not triggered by a click (redirects after login, timed transitions) and the URL in the action log.

**Fix:** delete the hook. If SPA route logging is wanted, listen to `chrome.webNavigation.onHistoryStateUpdated` and `onReferenceFragmentUpdated` in the background, which see every same-document navigation, and send the content script a `captureAfterSettle` message. Since the hash case is already handled in the page, the background can do the same for history updates.

### M2. Click captions and action log copy text from whatever was clicked

`describeElement` (`content.js` line 172) uses `innerText` of the clicked element, truncated to 100 characters, and `describeAction` puts 60 of them in the caption that appears in the report. Two problems:

- **Content leakage into the document.** Clicking a table cell, a card, or empty space inside a large container records the first 100 characters of that container's text. On a page showing customer data, that can be a name or account number, and it lands in a caption printed in the report.
- **Ugly captions.** A click on a layout `<div>` yields `Clicked "Welcome. Start the enrollment below. Start enrollment Show det..."`.
- **Cost.** `innerText` on a large container forces layout and walks the subtree; noticeable on heavy pages.

**Fix:** derive the label from the nearest interactive ancestor (`button, a, [role=button], label, input, select, summary, [aria-label]`) and only use its text when it is short (say under 60 characters). Otherwise caption as `Clicked <tag>` plus id, and record no text. This also improves captions for icon buttons via `aria-label` and `title`.

### M3. Double Start race

`startRecording` awaits `chrome.tabs.query` before setting `isRecording = true` (`background.js` lines 259 to 282). Two triggers within a few milliseconds (the shortcut and the button, or a double keypress) both pass the guard and start two sessions on the same tab. Rare, but the result is a doubly injected content script and a session that never gets stopped cleanly.

**Fix:** a module-level `starting` flag set before the first `await`, or set `isRecording = true` first and roll back on failure.

### M4. Tab ID changes on replacement

Chrome swaps in a new tab ID when a prerendered page is activated (common for search-result links) or a discarded tab is restored through certain paths. `recordingTabId` then points to a tab that no longer exists, so every later message is ignored and captures fail with "not visible". Add a `chrome.tabs.onReplaced` listener that updates `recordingTabId` when `removedTabId` matches. Three lines.

### M5. Stale window ID

`focusRecordingTab` (`background.js` line 228) uses `recordingWindowId` captured at start. If the tab was dragged into another window the wrong window is focused. Look the tab up with `chrome.tabs.get` and use its current `windowId`. Also drop `recordingWindowId` from the stored state, since `doCapture` already uses the live value.

## Low

### L1. Concurrent IndexedDB opens

`db.js` `open()` caches the database only after the request succeeds. Two callers before that (the popup's `loadSettings` and `renderSessions` both run early) each open a connection and the first is leaked. Harmless day to day, but a leaked connection blocks a future `onupgradeneeded`. Cache the opening promise instead of the result.

### L2. Page-load caption title source

`describeAction` (`background.js` line 522) prefers `action.title`, which is `sender.tab.title` at message time, over `d.title`, which the content script read from `document.title` right before sending. The tab title can lag the document title briefly after a navigation. Prefer `d.title`.

### L3. Skipped screenshots are invisible to the user

When `doCapture` throws (tab not visible, capture API error) the action gets `screenshotError` and the console gets a warning, but the popup and report show nothing. A user who recorded with the wrong window in front gets a short report and no explanation. Count skipped captures in the summary and show "N screenshots skipped: tab was not visible" in the popup and report header.

### L4. Tests live outside the repo

The end-to-end scripts that validated version 2.0 (extension loaded into Chromium, a three-page local site, click-through, stop, save, pause, markers off) are in this session's scratch space. Add them as `test/e2e.mjs` and `test/site.mjs` with an `npm test` script so a future change can be checked the same way. Playwright is the only dependency.

### L5. Shortcut choice on Windows

Alt+Shift is the Windows input-language toggle when more than one keyboard layout is installed. Alt+Shift+R and Alt+Shift+P still work, but users with multiple layouts may see the language flip. Ctrl+Shift+U and Ctrl+Shift+Y are free in Chrome and avoid this. Users can also rebind at `chrome://extensions/shortcuts`; the README could say so.

### L6. Cross-origin iframes

Injection targets the top frame only. Clicks inside an embedded iframe (payment widgets, embedded forms) are neither held nor recorded, though the full-screen captures still show them. Supporting frames means `allFrames: true` injection and frame-aware pings. Documenting the limitation is enough unless the sites you record use iframes.

## Things checked and found sound

- Replayed synthetic clicks still open a file picker (verified in Chromium), so intercepting `input[type=file]` is safe.
- Checkbox and radio state ends up correct after `preventDefault` plus replay.
- Device-pixel-ratio and browser-zoom handling: `tab.width` is in CSS pixels at the current zoom, so the ratio to the bitmap width is right in both cases.
- Message senders are trusted only through `sender.tab.id`, which Chrome sets; web pages cannot send runtime messages to the extension.
- Report and popup build DOM with `textContent`; the saved HTML file serializes the cloned DOM and escapes the title. No injection path from recorded page content.
- `unlimitedStorage` removes the 10 MB `chrome.storage.local` cap that the per-action `recordingData` writes would otherwise approach on long recordings.
- Extension reload mid-recording: orphaned content scripts detect the dead runtime and release clicks immediately; the interception stays on that page until reload but does no harm.

## Suggested order

1. H1, H3, M3, M4, M5, L1, L2: all tiny, no behavior risk. One commit.
2. H2 and H4: small, each needs a short test.
3. M2: caption rewrite, worth a look at the report afterward.
4. L4: move the tests in.
5. M1: delete the dead hook now; add background-side history logging only if a recorded site turns out to need it.
