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
const SESSIONS_TO_KEEP = 3;
const STALE_CROP_MS = 1500;      // matches the content script's click hold; a crop older than this is skipped

// ---------------------------------------------------------------------------
// State. Everything here is also mirrored to chrome.storage.local so a
// service worker restart can pick up where it left off.
// ---------------------------------------------------------------------------
let isRecording = false;
let isPaused = false; // recording continues, screenshots are skipped
let recordingTabId = null;
let recordingData = null;
let starting = false; // guards against two Start calls racing

let lastCaptureTime = 0;
let captureChain = Promise.resolve(); // serializes captureVisibleTab calls

// Every event handler awaits this before touching state, so a message that
// wakes the worker cannot be handled before the state has been restored.
const ready = restoreState();

async function restoreState() {
  try {
    const state = await chrome.storage.local.get([
      'isRecording', 'isPaused', 'recordingTabId', 'recordingData'
    ]);
    if (state.isRecording && state.recordingData) {
      isRecording = true;
      isPaused = !!state.isPaused;
      recordingTabId = state.recordingTabId;
      recordingData = state.recordingData;
      setBadge();
      // After a browser restart the recorded tab is gone (tab IDs are not
      // preserved). Keep what was captured, but don't stay "recording" forever.
      const tabExists = await chrome.tabs.get(recordingTabId).then(() => true, () => false);
      if (!tabExists) {
        console.warn('DocBot: recorded tab no longer exists; finalizing the recording');
        await stopRecording({ reason: 'tab_missing', openReport: false });
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
async function isInjected(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    // An instance injected only for the context menu must be replaced while recording.
    return !!(response && response.ok && (!isRecording || response.recording));
  } catch {
    return false;
  }
}

async function injectContentScripts(tabId) {
  // autofill.js first; content.js depends on it.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['autofill.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function ensureInjected(tabId) {
  if (await isInjected(tabId)) return;
  await injectContentScripts(tabId);
}

function isRecordableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// When the recorded tab loads a new document the old content script is gone,
// so re-inject. Same-document navigations answer the ping and are skipped.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  await ready;
  if (!isRecording || details.tabId !== recordingTabId || details.frameId !== 0) return;
  if (!isRecordableUrl(details.url)) return;
  try {
    await ensureInjected(details.tabId);
  } catch (error) {
    console.warn('DocBot: could not inject after navigation', error.message);
  }
});

// Closing the recorded tab ends the recording instead of leaving it dangling.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (isRecording && tabId === recordingTabId) {
    await stopRecording({ reason: 'tab_closed' });
  }
});

// Chrome swaps in a new tab ID when a prerendered page is activated; follow it.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ready;
  if (!isRecording || removedTabId !== recordingTabId) return;
  recordingTabId = addedTabId;
  await chrome.storage.local.set({ recordingTabId });
  await ensureInjected(addedTabId).catch(() => {});
});

// Same-document navigations (pushState) are invisible to the content script,
// so watch them here. A path change means a new view: log it and ask the page
// for a capture once it settles. Query-only or hash-only changes are logged.
let lastHistoryUrl = null;
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  await ready;
  if (!isRecording || details.tabId !== recordingTabId || details.frameId !== 0) return;
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
        recordingTabId,
        summary: recordingData ? summarize(recordingData) : null
      };

    case 'startRecording':
      return startRecording(message.settings || {});

    case 'stopRecording':
      return stopRecording();

    case 'setPaused':
      return setPaused(message.paused);

    case 'focusRecordingTab':
      if (recordingTabId !== null) {
        const tab = await chrome.tabs.get(recordingTabId).catch(() => null);
        if (tab) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        }
      }
      return { success: true };

    case 'openReport':
      await openReport(message.sessionId);
      return { success: true };

    case 'captureAction':
      if (!isRecording || !sender.tab || sender.tab.id !== recordingTabId) {
        return { success: true, ignored: true };
      }
      await captureAction(message.data, sender.tab);
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
    actions: [],
    screenshots: [],
    skippedScreenshots: 0
  };

  isRecording = true;
  isPaused = false;
  recordingTabId = tab.id;
  recordingData = data;
  lastCaptureTime = 0;
  lastHistoryUrl = tab.url;

  // Persist before injecting so the content script sees isRecording = true.
  await chrome.storage.local.set({
    isRecording: true,
    isPaused: false,
    recordingTabId,
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
  recordingTabId = null;
  recordingData = null;
  setBadge();
  await chrome.storage.local.set({
    isRecording: false, isPaused: false, recordingTabId: null, recordingData: null
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
    skippedScreenshots: data.skippedScreenshots || 0
  };
}

// ---------------------------------------------------------------------------
// Actions and screenshots
// ---------------------------------------------------------------------------
async function captureAction(actionData, tab) {
  const data = recordingData;
  const action = {
    timestamp: Date.now(),
    type: actionData.type,
    details: actionData.details || {},
    url: tab.url,
    title: tab.title,
    elementPosition: actionData.elementPosition || null,
    sentAt: actionData.sentAt || Date.now()
  };
  data.actions.push(action);

  // Policy: one cropped capture per click, one full capture per new screen.
  const wantCrop = action.type === 'click' && data.settings.autoScreenshot && !!action.elementPosition;
  const wantFull = action.type === 'navigation' && !!actionData.captureScreenshot;

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
  const blob = await processCapture(rawDataUrl, {
    cssWidth: tab.width,
    clickPosition: crop ? action.elementPosition : null,
    drawMarker: clickMarkers !== false,
    quality
  });

  const now = Date.now();
  const id = `${data.sessionId}_${now}_${crop ? 'click' : 'page'}`;

  // A second full capture of the same URL within a short window means the
  // page was still settling; keep only the later one.
  if (!crop) {
    const last = data.screenshots[data.screenshots.length - 1];
    if (last && !last.isCropped && last.url === action.url && now - last.timestamp < FULL_DEDUPE_WINDOW_MS) {
      data.screenshots.pop();
      await DocBotDB.deleteScreenshot(last.id).catch(() => {});
    }
  }

  await DocBotDB.putScreenshot({ id, sessionId: data.sessionId, blob, timestamp: now });

  const shot = {
    id,
    timestamp: now,
    isCropped: crop,
    url: action.url,
    title: action.title,
    actionType: action.type,
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
      const scale = Math.min(1, 1 / dpr, MAX_FULL_WIDTH / bitmap.width);
      dw = Math.round(bitmap.width * scale);
      dh = Math.round(bitmap.height * scale);
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

    return canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  } finally {
    bitmap.close();
  }
}

function describeAction(action) {
  const d = action.details || {};
  switch (action.type) {
    case 'click': {
      const text = (d.text || '').trim();
      if (text) return `Clicked "${text.length > 60 ? text.slice(0, 57) + '...' : text}"`;
      const tag = (d.tagName || 'element').toLowerCase();
      return d.id ? `Clicked ${tag} #${d.id}` : `Clicked ${tag}`;
    }
    case 'navigation': {
      const title = d.title || action.title || d.url || '';
      switch (d.type) {
        case 'page_load': return `Page: ${title}`;
        case 'post_click_state': return `Screen after click: ${title}`;
        case 'hashchange':
        case 'history':
        case 'view_settled': return `View changed: ${title}`;
        default: return `Screen: ${title}`;
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
