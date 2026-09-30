// DocBot background service worker
// Owns recording state, screenshot capture, and session storage.
'use strict';

importScripts('db.js');

const QUALITY = { high: 85, medium: 70, low: 50 }; // JPEG quality per setting
const MAX_FULL_WIDTH = 1600;     // CSS px; full-screen captures are downscaled to at most this width
const CROP_WIDTH = 1200;         // CSS px; click captures show this much around the click
const CROP_HEIGHT = 400;
const CROP_CLICK_OFFSET = 0.75;  // the click sits 75% from the left edge of the crop
const CAPTURE_SPACING_MS = 550;  // Chrome allows two captureVisibleTab calls per second
const FULL_DEDUPE_WINDOW_MS = 2500; // a full capture of the same URL inside this window replaces the previous one
const PAGE_LOAD_REPLACE_MS = 15000; // a later page-load capture of the same page replaces the earlier one within this window
const SESSIONS_TO_KEEP = 3;
const STALE_CROP_MS = 1500;      // matches the content script's click hold; a crop older than this is skipped
const MIN_FRAME_AREA = 0.2;      // a frame smaller than this share of the tab is not a "screen" when it loads
const TRIM_PADDING = 24;         // CSS px kept around the page content when empty margins are trimmed
const TRIM_THRESHOLD = 40;       // how different a pixel must be from the background to count as content

// ---------------------------------------------------------------------------
// State. Everything here is also mirrored to chrome.storage.local so a
// service worker restart can pick up where it left off.
// ---------------------------------------------------------------------------
let isRecording = false;
let isPaused = false; // recording continues, screenshots are skipped
let recordedTabs = []; // tab ids that are part of the recording, in the order they were added
let lastActiveRecordedTab = null;
let recordingData = null;
let starting = false; // guards against two Start calls racing
const dismissedOffers = new Set(); // tabs where the user said "not this tab"
const bannerTabs = new Set();      // tabs currently showing the include banner

let lastCaptureTime = 0;
let captureChain = Promise.resolve(); // serializes captureVisibleTab calls

// Every event handler awaits this before touching state, so a message that
// wakes the worker cannot be handled before the state has been restored.
const ready = restoreState();

async function restoreState() {
  try {
    const state = await chrome.storage.local.get([
      'isRecording', 'isPaused', 'recordedTabs', 'lastActiveRecordedTab', 'recordingData'
    ]);
    if (state.isRecording && state.recordingData) {
      isRecording = true;
      isPaused = !!state.isPaused;
      recordingData = state.recordingData;
      lastActiveRecordedTab = state.lastActiveRecordedTab ?? null;
      // After a browser restart the recorded tabs are gone (tab IDs are not
      // preserved). Keep what was captured, but don't stay "recording" forever.
      const existing = [];
      for (const id of state.recordedTabs || []) {
        if (await chrome.tabs.get(id).then(() => true, () => false)) existing.push(id);
      }
      recordedTabs = existing;
      setBadge();
      if (recordedTabs.length === 0) {
        console.warn('DocBot: recorded tabs no longer exist; finalizing the recording');
        await stopRecording({ reason: 'tab_missing', openReport: false });
      } else {
        await chrome.storage.local.set({ recordedTabs });
      }
    }
    await migrateLegacyRecording();
  } catch (error) {
    console.error('DocBot: failed to restore state', error);
  }
}

// Recordings made by v1 lived in chrome.storage.local under `completedRecording`
// with base64 screenshots in IndexedDB. Fold that into the sessions store once.
async function migrateLegacyRecording() {
  const { completedRecording } = await chrome.storage.local.get('completedRecording');
  if (!completedRecording) return;
  try {
    const sessionId = completedRecording.sessionId || `docbot_${completedRecording.startTime || Date.now()}`;
    const screenshots = (completedRecording.screenshots || []).map((s) => ({
      id: s.id,
      timestamp: s.timestamp,
      isCropped: !!s.isCropped,
      url: s.associatedAction?.url || '',
      title: s.associatedAction?.title || '',
      caption: describeAction(s.associatedAction || { type: 'navigation', details: {} })
    }));
    // Tag the legacy screenshot rows with the session so pruning can find them.
    for (const s of screenshots) {
      const row = await DocBotDB.getScreenshot(s.id);
      if (row && !row.sessionId) {
        row.sessionId = sessionId;
        await DocBotDB.putScreenshot(row);
      }
    }
    const first = completedRecording.actions?.[0];
    await DocBotDB.putSession({
      sessionId,
      startTime: completedRecording.startTime,
      endTime: completedRecording.endTime,
      url: first?.url || '',
      title: first?.title || 'Recording',
      settings: completedRecording.settings || {},
      actions: completedRecording.actions || [],
      screenshots
    });
    await chrome.storage.local.set({ lastSessionId: sessionId });
  } catch (error) {
    console.error('DocBot: could not migrate legacy recording', error);
  }
  await chrome.storage.local.remove(['completedRecording', 'formSubmitted', 'formSubmitTime', 'formSubmitUrl', 'apiKey']);
  await DocBotDB.deleteOrphanScreenshots().catch(() => {});
}

function setBadge() {
  if (!isRecording) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  chrome.action.setBadgeText({ text: isPaused ? 'II' : 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: isPaused ? '#fd7e14' : '#dc3545' });
}

function isRecordedTab(tabId) {
  return isRecording && recordedTabs.includes(tabId);
}

async function persistTabs() {
  await chrome.storage.local.set({ recordedTabs, lastActiveRecordedTab });
}

async function setPaused(paused) {
  if (!isRecording) return { success: false, error: 'Nothing is being recorded.' };
  isPaused = !!paused;
  await chrome.storage.local.set({ isPaused });
  setBadge();
  return { success: true, isPaused };
}

// ---------------------------------------------------------------------------
// Context menu (auto-fill a single field)
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'docbot-autofill-field',
      title: 'DocBot: auto-fill this field',
      contexts: ['editable']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'docbot-autofill-field' || !tab) return;
  await ensureInjected(tab.id);
  chrome.tabs.sendMessage(tab.id, { action: 'fillClickedField' }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Keyboard shortcut: start or stop recording
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  await ready;
  if (command === 'toggle-pause') {
    await setPaused(!isPaused);
    return;
  }
  if (command !== 'toggle-recording') return;
  if (isRecording) {
    await stopRecording();
  } else {
    const settings = await chrome.storage.local.get(['captureClicks', 'captureInputs', 'captureNavigation', 'autoScreenshot']);
    await startRecording(settings);
  }
});

// ---------------------------------------------------------------------------
// Content script injection
// ---------------------------------------------------------------------------
async function isInjected(tabId, frameId = 0) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' }, { frameId });
    // An instance injected only for the context menu must be replaced while recording.
    return !!(response && response.ok && (!isRecording || response.recording));
  } catch {
    return false;
  }
}

async function injectFrame(tabId, frameId) {
  // autofill.js first; content.js depends on it.
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['autofill.js'] });
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
}

// The top frame must succeed; child frames are best effort (a sandboxed or
// otherwise unscriptable frame is simply skipped).
async function injectContentScripts(tabId) {
  await injectFrame(tabId, 0);
  await injectMissingFrames(tabId);
}

async function ensureInjected(tabId) {
  if (!(await isInjected(tabId))) await injectFrame(tabId, 0);
  await injectMissingFrames(tabId);
}

// Inject into every child frame that does not answer a ping. Idempotent. One
// pass runs per tab at a time; a request that arrives mid-pass schedules
// another pass, so a frame that committed during the pass is not missed.
const frameInjections = new Map();
function injectMissingFrames(tabId) {
  const running = frameInjections.get(tabId);
  if (running) {
    running.again = true;
    return running.job;
  }
  const entry = { again: false };
  entry.job = (async () => {
    do {
      entry.again = false;
      await injectFramesPass(tabId);
    } while (entry.again);
  })().finally(() => frameInjections.delete(tabId));
  frameInjections.set(tabId, entry);
  return entry.job;
}

async function injectFramesPass(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames) return;
  for (const frame of frames) {
    if (frame.frameId === 0 || frame.errorOccurred) continue;
    if (!/^(https?:|about:|blob:)/i.test(frame.url)) continue;
    if (await isInjected(tabId, frame.frameId)) continue;
    try {
      await injectFrame(tabId, frame.frameId);
    } catch (error) {
      console.warn(`DocBot: frame ${frame.frameId} (${frame.url}) not injected: ${error.message}`);
    }
  }
}


function isRecordableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// When the recorded tab loads a new document the old content script is gone,
// so re-inject. Same-document navigations answer the ping and are skipped.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  await ready;
  if (!isRecording) return;
  if (!isRecordedTab(details.tabId)) {
    // A tab the user opened blank and then navigated (Ctrl+T, type an
    // address) becomes offerable once it shows a web page.
    if (details.frameId === 0 && isRecordableUrl(details.url)) {
      bannerTabs.delete(details.tabId); // the old document's banner is gone with it
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      if (tab?.active) await offerTab(details.tabId);
    }
    return;
  }
  try {
    if (details.frameId === 0) {
      if (isRecordableUrl(details.url)) await ensureInjected(details.tabId);
    } else {
      // A child frame committed a new document: inject that frame directly,
      // then sweep for any others that appeared meanwhile.
      if (/^(https?:|about:|blob:)/i.test(details.url) && !(await isInjected(details.tabId, details.frameId))) {
        await injectFrame(details.tabId, details.frameId).catch((error) => console.warn(`DocBot: frame ${details.frameId} not injected: ${error.message}`));
      }
      await injectMissingFrames(details.tabId);
    }
  } catch (error) {
    console.warn('DocBot: could not inject after navigation', error.message);
  }
});

// Closing a recorded tab drops it from the recording; closing the last one
// ends the recording instead of leaving it dangling.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  bannerTabs.delete(tabId);
  dismissedOffers.delete(tabId);
  if (!isRecordedTab(tabId)) return;
  recordedTabs = recordedTabs.filter((id) => id !== tabId);
  if (recordedTabs.length === 0) {
    await stopRecording({ reason: 'tab_closed' });
    return;
  }
  if (lastActiveRecordedTab === tabId) lastActiveRecordedTab = recordedTabs[recordedTabs.length - 1];
  await persistTabs();
  const entry = recordingData.tabs?.find((t) => t.tabId === tabId);
  await logAction({ type: 'tab', details: { type: 'tab_closed', title: entry?.title || '', url: entry?.url || '' } }, tabId);
});

// Chrome swaps in a new tab ID when a prerendered page is activated; follow it.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ready;
  if (!isRecordedTab(removedTabId)) return;
  recordedTabs = recordedTabs.map((id) => (id === removedTabId ? addedTabId : id));
  if (lastActiveRecordedTab === removedTabId) lastActiveRecordedTab = addedTabId;
  const entry = recordingData.tabs?.find((t) => t.tabId === removedTabId);
  if (entry) entry.tabId = addedTabId;
  await persistTabs();
  await ensureInjected(addedTabId).catch(() => {});
});

// A tab opened from a recorded tab (a link with target=_blank, window.open)
// is the workflow continuing: include it without asking. The content script
// is injected once the new tab commits a document.
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (!isRecording || tab.openerTabId === undefined || !isRecordedTab(tab.openerTabId)) return;
  await includeTab(tab.id, 'opened');
});

// Switching tabs: a recorded tab gets a "switched to" entry and a capture of
// what is on screen; any other web tab is offered for inclusion.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await ready;
  if (!isRecording) return;
  if (isRecordedTab(tabId)) {
    if (tabId !== lastActiveRecordedTab) {
      lastActiveRecordedTab = tabId;
      await persistTabs();
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) {
        await logAction({ type: 'tab', details: { type: 'tab_switch', title: tab.title, url: tab.url } }, tabId);
        if (!isPaused) chrome.tabs.sendMessage(tabId, { action: 'captureAfterSettle', type: 'tab_switch' }, { frameId: 0 }).catch(() => {});
      }
    }
    return;
  }
  await offerTab(tabId);
});

// Show the include banner in a web tab that is not part of the recording.
async function offerTab(tabId) {
  if (dismissedOffers.has(tabId) || bannerTabs.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isRecordableUrl(tab.url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['offer.js'] });
    bannerTabs.add(tabId);
    chrome.action.setBadgeText({ tabId, text: '+' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#667eea' });
  } catch (error) {
    console.warn('DocBot: could not offer tab', tab.url, error.message);
  }
}

async function closeBanner(tabId) {
  bannerTabs.delete(tabId);
  chrome.tabs.sendMessage(tabId, { action: 'offerClose' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch?.(() => {});
}

// Add a tab to the recording. `reason` is 'start', 'opened' or 'manual'.
async function includeTab(tabId, reason) {
  if (!isRecording || recordedTabs.includes(tabId)) return { success: false, error: 'Tab is already part of the recording.' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { success: false, error: 'That tab no longer exists.' };
  if (reason === 'manual' && !isRecordableUrl(tab.url)) {
    return { success: false, error: 'DocBot can only record regular web pages (http or https).' };
  }
  recordedTabs.push(tabId);
  dismissedOffers.delete(tabId);
  if (tab.active) lastActiveRecordedTab = tabId;
  recordingData.tabs = recordingData.tabs || [];
  recordingData.tabs.push({ tabId, title: tab.title || tab.url || '', url: tab.url || '', includedAt: Date.now(), reason });
  await persistTabs();
  await closeBanner(tabId);
  await logAction({ type: 'tab', details: { type: 'tab_included', title: tab.title || '', url: tab.url || '', reason } }, tabId);
  if (isRecordableUrl(tab.url)) {
    // The content script's own page_load capture records the tab's screen.
    await injectContentScripts(tabId).catch((error) => console.warn('DocBot: could not attach to included tab', error.message));
  }
  chrome.runtime.sendMessage({ action: 'recordingUpdate', summary: summarize(recordingData) }).catch(() => {});
  return { success: true, tab: { id: tab.id, title: tab.title, url: tab.url } };
}

// Same-document navigations (pushState) are invisible to the content script,
// so watch them here. A path change means a new view: log it and ask the page
// for a capture once it settles. Query-only or hash-only changes are logged.
let lastHistoryUrl = null;
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  await ready;
  if (!isRecordedTab(details.tabId) || details.frameId !== 0) return;
  const previous = lastHistoryUrl || recordingData?.url || '';
  lastHistoryUrl = details.url;
  let pathChanged = false;
  try {
    pathChanged = new URL(details.url).pathname !== new URL(previous).pathname;
  } catch (_) { /* ignore */ }
  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab) return;
  await captureAction({
    type: 'navigation',
    details: { url: details.url, title: tab.title, type: 'history', transitionType: details.transitionType },
    captureScreenshot: false
  }, tab);
  if (pathChanged && !isPaused) {
    chrome.tabs.sendMessage(details.tabId, { action: 'captureAfterSettle' }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Messages from the popup and content scripts
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ success: false, error: error.message || String(error) }));
  return true; // async response
});

async function handleMessage(message, sender) {
  await ready;
  switch (message.action) {
    case 'getState':
      return {
        success: true,
        isRecording,
        isPaused,
        recordedTabIds: recordedTabs.slice(),
        summary: recordingData ? summarize(recordingData) : null
      };

    case 'startRecording':
      return startRecording(message.settings || {});

    case 'stopRecording':
      return stopRecording();

    case 'setPaused':
      return setPaused(message.paused);

    case 'focusRecordingTab': {
      const target = lastActiveRecordedTab ?? recordedTabs[0];
      if (target !== undefined && target !== null) {
        const tab = await chrome.tabs.get(target).catch(() => null);
        if (tab) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        }
      }
      return { success: true };
    }

    case 'includeTab': {
      // From the banner (sender.tab) or the popup (the active tab).
      let tabId = sender.tab?.id;
      if (tabId === undefined) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (tabId === undefined) return { success: false, error: 'No tab to include.' };
      return includeTab(tabId, 'manual');
    }

    case 'dismissOffer':
      if (sender.tab) {
        dismissedOffers.add(sender.tab.id);
        await closeBanner(sender.tab.id);
      }
      return { success: true };

    case 'isTabRecorded':
      return { success: true, recorded: !!sender.tab && isRecordedTab(sender.tab.id) };

    case 'openReport':
      await openReport(message.sessionId);
      return { success: true };

    case 'captureAction':
      if (!sender.tab || !isRecordedTab(sender.tab.id)) {
        return { success: true, ignored: true };
      }
      await captureAction(message.data, sender.tab, sender.frameId || 0);
      return { success: true };

    case 'framesChanged':
      if (sender.tab && isRecordedTab(sender.tab.id)) {
        await injectMissingFrames(sender.tab.id);
      }
      return { success: true };

    default:
      return { success: false, error: `Unknown action: ${message.action}` };
  }
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------
async function startRecording(settings) {
  if (isRecording || starting) {
    return { success: false, error: 'Already recording. Stop the current recording first.' };
  }
  starting = true;
  try {
    return await beginRecording(settings);
  } finally {
    starting = false;
  }
}

async function beginRecording(settings) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { success: false, error: 'No active tab found.' };
  if (!isRecordableUrl(tab.url)) {
    return { success: false, error: 'DocBot can only record regular web pages (http or https). Switch to the page you want to document and try again.' };
  }

  const sessionId = `docbot_${Date.now()}`;
  const data = {
    sessionId,
    startTime: Date.now(),
    endTime: null,
    url: tab.url,
    title: tab.title || tab.url,
    settings: {
      captureClicks: settings.captureClicks !== false,
      captureInputs: settings.captureInputs !== false,
      captureNavigation: settings.captureNavigation !== false,
      autoScreenshot: settings.autoScreenshot !== false
    },
    tabs: [{ tabId: tab.id, title: tab.title || tab.url, url: tab.url, includedAt: Date.now(), reason: 'start' }],
    actions: [],
    screenshots: [],
    skippedScreenshots: 0
  };

  isRecording = true;
  isPaused = false;
  recordedTabs = [tab.id];
  lastActiveRecordedTab = tab.id;
  dismissedOffers.clear();
  recordingData = data;
  lastCaptureTime = 0;
  lastHistoryUrl = tab.url;

  // Persist before injecting so the content script sees isRecording = true.
  await chrome.storage.local.set({
    isRecording: true,
    isPaused: false,
    recordedTabs,
    lastActiveRecordedTab,
    recordingData: data,
    ...data.settings
  });

  try {
    // Always (re)inject on start so the content script picks up current settings.
    await injectContentScripts(tab.id);
  } catch (error) {
    await resetState();
    return { success: false, error: `Could not attach to this page: ${error.message}` };
  }

  setBadge();
  return { success: true, tab: { id: tab.id, title: tab.title, url: tab.url } };
}

async function resetState() {
  isRecording = false;
  isPaused = false;
  recordedTabs = [];
  lastActiveRecordedTab = null;
  recordingData = null;
  for (const tabId of Array.from(bannerTabs)) await closeBanner(tabId);
  dismissedOffers.clear();
  setBadge();
  await chrome.storage.local.set({
    isRecording: false, isPaused: false, recordedTabs: [], lastActiveRecordedTab: null, recordingData: null
  });
}

async function stopRecording({ reason = 'user', openReport: shouldOpenReport = true } = {}) {
  if (!isRecording || !recordingData) {
    return { success: false, error: 'Nothing is being recorded.' };
  }

  const data = recordingData;
  isRecording = false;

  // Let any in-flight capture finish so its screenshot lands in the session.
  await captureChain.catch(() => {});

  data.endTime = Date.now();
  data.stopReason = reason;

  await DocBotDB.putSession(data);
  await DocBotDB.pruneSessions(SESSIONS_TO_KEEP);
  await chrome.storage.local.set({ lastSessionId: data.sessionId });
  await resetState();

  if (shouldOpenReport) await openReport(data.sessionId);
  return { success: true, session: summarize(data) };
}

async function openReport(sessionId) {
  const id = sessionId || (await chrome.storage.local.get('lastSessionId')).lastSessionId;
  const url = chrome.runtime.getURL('report.html' + (id ? `?session=${encodeURIComponent(id)}` : ''));
  await chrome.tabs.create({ url });
}

function summarize(data) {
  return {
    sessionId: data.sessionId,
    title: data.title,
    url: data.url,
    startTime: data.startTime,
    endTime: data.endTime,
    actionCount: data.actions.length,
    screenshotCount: data.screenshots.length,
    skippedScreenshots: data.skippedScreenshots || 0,
    tabCount: data.tabs ? data.tabs.length : 1
  };
}

// ---------------------------------------------------------------------------
// Actions and screenshots
// ---------------------------------------------------------------------------
// Record an action that has no screenshot of its own (tab bookkeeping).
async function logAction(actionData, tabId) {
  const data = recordingData;
  if (!data) return;
  data.actions.push({
    timestamp: Date.now(),
    type: actionData.type,
    details: actionData.details || {},
    url: actionData.details?.url || '',
    title: actionData.details?.title || '',
    tabId,
    frameId: 0,
    elementPosition: null,
    sentAt: Date.now()
  });
  await persist(data);
  chrome.runtime.sendMessage({ action: 'recordingUpdate', summary: summarize(data) }).catch(() => {});
}

async function captureAction(actionData, tab, frameId = 0) {
  const data = recordingData;
  const action = {
    timestamp: Date.now(),
    type: actionData.type,
    details: actionData.details || {},
    url: tab.url,
    title: tab.title,
    tabId: tab.id,
    frameId,
    elementPosition: actionData.elementPosition || null,
    sentAt: actionData.sentAt || Date.now()
  };
  data.actions.push(action);

  // Policy: one cropped capture per click, one full capture per new screen.
  let wantCrop = action.type === 'click' && data.settings.autoScreenshot && !!action.elementPosition;
  let wantFull = action.type === 'navigation' && !!actionData.captureScreenshot;

  if (action.type === 'click' && frameId !== 0) {
    // The click came from an embedded frame. The content script translates
    // the coordinates to the top-level viewport; if it could not, take a
    // full-screen capture rather than a close-up of the wrong place.
    if (!action.elementPosition?.translated) {
      action.elementPosition = null;
      if (wantCrop && data.settings.autoScreenshot) wantFull = true;
      wantCrop = false;
      action.details.type = 'frame_click_fullscreen';
    }
    // The outer page may change in response; let it watch for that.
    chrome.tabs.sendMessage(tab.id, { action: 'watchForSettle' }, { frameId: 0 }).catch(() => {});
  }

  if (action.type === 'navigation' && action.details.type === 'frame_load') {
    // A frame finishing a load is a new screen only if it takes up real space.
    const f = action.details.frame;
    const share = f && tab.width && tab.height ? (f.width * f.height) / (tab.width * tab.height) : 0;
    wantFull = wantFull && share >= MIN_FRAME_AREA;
  }

  if (isPaused) {
    action.paused = true; // logged, but no screenshot while paused
  } else if (wantCrop || wantFull) {
    await captureScreenshot(data, tab.id, action, wantCrop);
  }

  await persist(data);
  chrome.runtime.sendMessage({ action: 'recordingUpdate', summary: summarize(data) }).catch(() => {});
}

async function persist(data) {
  try {
    await chrome.storage.local.set({ recordingData: data });
  } catch (error) {
    console.error('DocBot: failed to save recording data', error);
  }
}

// Queue captures so they never exceed Chrome's rate limit and never overlap.
function captureScreenshot(data, tabId, action, crop) {
  const job = captureChain
    .then(() => doCapture(data, tabId, action, crop))
    .catch((error) => {
      console.warn('DocBot: screenshot skipped:', error.message);
      action.screenshotError = error.message;
      data.skippedScreenshots = (data.skippedScreenshots || 0) + 1;
      return null;
    });
  captureChain = job;
  return job;
}

async function doCapture(data, tabId, action, crop) {
  // A click close-up must show the screen as it was when the click happened.
  // If the queue held it past the content script's click hold, the page has
  // moved on and the picture would be misleading; skip it instead.
  if (crop && Date.now() - action.sentAt > STALE_CROP_MS) {
    throw new Error('stale: clicks came faster than screenshots can be taken');
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('recorded tab is not visible');

  const wait = CAPTURE_SPACING_MS - (Date.now() - lastCaptureTime);
  if (wait > 0) await sleep(wait);

  const { screenshotQuality, clickMarkers } = await chrome.storage.local.get(['screenshotQuality', 'clickMarkers']);
  const quality = QUALITY[screenshotQuality] || QUALITY.medium;

  lastCaptureTime = Date.now();
  const rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality });

  // The bitmap is in device pixels; tab.width is CSS pixels.
  const { blob, marker } = await processCapture(rawDataUrl, {
    cssWidth: tab.width,
    clickPosition: crop ? action.elementPosition : null,
    drawMarker: clickMarkers !== false,
    quality
  });

  const now = Date.now();
  const id = `${data.sessionId}_${now}_${crop ? 'click' : 'page'}`;

  // A second full capture of the same URL within a short window means the
  // page was still settling; keep only the later one. A page-load capture
  // that follows another page-load capture of the same page (the app kept
  // rendering) replaces it within a longer window.
  if (!crop) {
    const last = data.screenshots[data.screenshots.length - 1];
    const kind = action.details?.type;
    if (last && !last.isCropped && last.url === action.url && last.tabId === action.tabId) {
      const age = now - last.timestamp;
      const sameLoad = last.kind === 'page_load' && kind === 'page_load';
      if (age < FULL_DEDUPE_WINDOW_MS || (sameLoad && age < PAGE_LOAD_REPLACE_MS)) {
        data.screenshots.pop();
        await DocBotDB.deleteScreenshot(last.id).catch(() => {});
      }
    }
  }

  await DocBotDB.putScreenshot({ id, sessionId: data.sessionId, blob, timestamp: now });

  const shot = {
    id,
    timestamp: now,
    isCropped: crop,
    url: action.url,
    title: action.title,
    tabId: action.tabId,
    actionType: action.type,
    kind: action.details?.type || null,
    marker: marker || null, // where the click marker was drawn, in image pixels
    caption: describeAction(action)
  };
  data.screenshots.push(shot);
  return shot;
}

// Decode once, crop or downscale, draw the click marker, encode once as JPEG.
async function processCapture(dataUrl, { cssWidth, clickPosition, drawMarker = true, quality }) {
  const response = await fetch(dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const dpr = cssWidth ? Math.max(1, bitmap.width / cssWidth) : (clickPosition?.dpr || 1);

    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height, dw, dh;
    let marker = null;

    if (clickPosition) {
      sw = Math.min(bitmap.width, Math.round(CROP_WIDTH * dpr));
      sh = Math.min(bitmap.height, Math.round(CROP_HEIGHT * dpr));
      const cx = clickPosition.x * dpr;
      const cy = clickPosition.y * dpr;
      sx = clamp(Math.round(cx - sw * CROP_CLICK_OFFSET), 0, bitmap.width - sw);
      sy = clamp(Math.round(cy - sh / 2), 0, bitmap.height - sh);
      dw = Math.round(sw / dpr);
      dh = Math.round(sh / dpr);
      marker = { x: (cx - sx) / dpr, y: (cy - sy) / dpr };
    } else {
      // A narrow page on a wide screen is mostly empty margin; cut that away
      // so the content, not the viewport, fills the picture.
      const box = findContentBox(bitmap, Math.round(TRIM_PADDING * dpr));
      if (box) ({ x: sx, y: sy, width: sw, height: sh } = box);
      const scale = Math.min(1, 1 / dpr, MAX_FULL_WIDTH / sw);
      dw = Math.round(sw * scale);
      dh = Math.round(sh * scale);
    }

    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);

    if (marker && drawMarker) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#e02020';
      ctx.fillStyle = 'rgba(224, 32, 32, 0.15)';
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 32, 0, Math.PI * 2);
      ctx.stroke();
    }

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    return { blob, marker: marker && drawMarker ? { x: Math.round(marker.x), y: Math.round(marker.y) } : null };
  } finally {
    bitmap.close();
  }
}

// Bounding box of everything that differs from the page background, in
// bitmap pixels, with padding. The background colour is the most common
// colour along the edges. Returns null when there is nothing to trim or the
// page has no uniform background (a photo or gradient), so nothing is lost.
function findContentBox(bitmap, padding) {
  const step = 4; // analyse at quarter resolution; plenty for margins
  const w = Math.max(1, Math.floor(bitmap.width / step));
  const h = Math.max(1, Math.floor(bitmap.height / step));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const at = (x, y) => (y * w + x) * 4;

  // Background = most common edge colour (quantised).
  const counts = new Map();
  const edge = [];
  for (let x = 0; x < w; x++) edge.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y++) edge.push([0, y], [w - 1, y]);
  for (const [x, y] of edge) {
    const i = at(x, y);
    const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bgKey = null, bgCount = 0;
  for (const [key, count] of counts) if (count > bgCount) { bgKey = key; bgCount = count; }
  if (bgCount < edge.length * 0.6) return null; // no dominant background: leave as is
  const [br, bgc, bb] = bgKey.split(',').map((v) => (Number(v) << 3) + 4);

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgc) + Math.abs(data[i + 2] - bb) > TRIM_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // blank page

  const x0 = Math.max(0, minX * step - padding);
  const y0 = Math.max(0, minY * step - padding);
  const x1 = Math.min(bitmap.width, (maxX + 1) * step + padding);
  const y1 = Math.min(bitmap.height, (maxY + 1) * step + padding);
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  // Not worth it unless it removes a real amount of margin.
  if (box.width > bitmap.width * 0.92 && box.height > bitmap.height * 0.92) return null;
  return box;
}

function describeAction(action) {
  const d = action.details || {};
  switch (action.type) {
    case 'click': {
      const text = (d.text || '').trim();
      const tag = (d.tagName || 'element').toLowerCase();
      let label = text ? `Clicked "${text.length > 60 ? text.slice(0, 57) + '...' : text}"` : (d.id ? `Clicked ${tag} #${d.id}` : `Clicked ${tag}`);
      if (action.frameId) label += ' (embedded frame)';
      return label;
    }
    case 'navigation': {
      const title = d.title || action.title || d.url || '';
      switch (d.type) {
        case 'page_load': return `Page: ${title}`;
        case 'frame_load': return `Embedded page: ${title}`;
        case 'post_click_state': return `Screen after click: ${title}`;
        case 'hashchange':
        case 'history':
        case 'view_settled': return `View changed: ${title}`;
        case 'tab_switch': return `Tab: ${title}`;
        default: return `Screen: ${title}`;
      }
    }
    case 'tab': {
      const title = d.title || d.url || 'tab';
      switch (d.type) {
        case 'tab_included': return d.reason === 'opened' ? `Opened in a new tab: ${title}` : `Added tab: ${title}`;
        case 'tab_switch': return `Switched to tab: ${title}`;
        case 'tab_closed': return `Closed tab: ${title}`;
        default: return `Tab: ${title}`;
      }
    }
    default:
      return action.type;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
