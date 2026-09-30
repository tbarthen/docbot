// DocBot popup

const el = (id) => document.getElementById(id);
const ui = {};
let durationTimer = null;
let currentSummary = null;

document.addEventListener('DOMContentLoaded', async () => {
  for (const id of [
    'dot', 'statusText', 'tabLine', 'stats', 'screenshotCount', 'actionCount', 'duration', 'error',
    'startBtn', 'stopBtn', 'pauseBtn', 'gotoBtn', 'startHint', 'recentCard', 'sessionList',
    'captureClicks', 'autoScreenshot', 'clickMarkers', 'captureNavigation', 'captureInputs', 'screenshotQuality', 'optionsLink'
  ]) ui[id] = el(id);

  await loadSettings();
  attachListeners();
  await refresh();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function loadSettings() {
  const s = await chrome.storage.local.get(['captureClicks', 'autoScreenshot', 'clickMarkers', 'captureNavigation', 'captureInputs', 'screenshotQuality']);
  ui.captureClicks.checked = s.captureClicks !== false;
  ui.autoScreenshot.checked = s.autoScreenshot !== false;
  ui.clickMarkers.checked = s.clickMarkers !== false;
  ui.captureNavigation.checked = s.captureNavigation !== false;
  ui.captureInputs.checked = s.captureInputs !== false;
  ui.screenshotQuality.value = s.screenshotQuality || 'medium';
}

function currentSettings() {
  return {
    captureClicks: ui.captureClicks.checked,
    autoScreenshot: ui.autoScreenshot.checked,
    clickMarkers: ui.clickMarkers.checked,
    captureNavigation: ui.captureNavigation.checked,
    captureInputs: ui.captureInputs.checked,
    screenshotQuality: ui.screenshotQuality.value
  };
}

async function saveSettings() {
  await chrome.storage.local.set(currentSettings());
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function attachListeners() {
  ui.startBtn.addEventListener('click', startRecording);
  ui.stopBtn.addEventListener('click', stopRecording);
  ui.pauseBtn.addEventListener('click', togglePause);
  ui.gotoBtn.addEventListener('click', () => send({ action: 'focusRecordingTab' }));
  ui.optionsLink.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  for (const id of ['captureClicks', 'autoScreenshot', 'clickMarkers', 'captureNavigation', 'captureInputs', 'screenshotQuality']) {
    ui[id].addEventListener('change', saveSettings);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'recordingUpdate' && message.summary) {
      currentSummary = message.summary;
      renderStats();
    }
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.isRecording || changes.isPaused) refresh();
  });
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function startRecording() {
  showError(null);
  ui.startBtn.disabled = true;
  const response = await send({ action: 'startRecording', settings: currentSettings() });
  ui.startBtn.disabled = false;
  if (!response || !response.success) {
    showError(response?.error || 'Could not start recording.');
    return;
  }
  await refresh();
}

async function togglePause() {
  const state = await send({ action: 'getState' });
  const response = await send({ action: 'setPaused', paused: !state?.isPaused });
  if (!response || !response.success) showError(response?.error || 'Could not change pause state.');
  await refresh();
}

async function stopRecording() {
  showError(null);
  ui.stopBtn.disabled = true;
  const response = await send({ action: 'stopRecording' });
  ui.stopBtn.disabled = false;
  if (!response || !response.success) {
    showError(response?.error || 'Could not stop recording.');
    return;
  }
  window.close(); // the report tab has been opened by the background worker
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
async function refresh() {
  const state = await send({ action: 'getState' });
  if (!state || !state.success) {
    setStatus('error', 'DocBot is not responding');
    showError('Try reloading the extension from chrome://extensions.');
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (state.isRecording) {
    currentSummary = state.summary;
    const onRecordedTab = activeTab && activeTab.id === state.recordingTabId;
    setStatus(state.isPaused ? 'paused' : 'recording', state.isPaused ? 'Recording (screenshots paused)' : 'Recording');
    ui.tabLine.textContent = state.summary?.title || '';
    ui.pauseBtn.textContent = state.isPaused ? 'Resume screenshots' : 'Pause screenshots';
    show(ui.pauseBtn, true);
    ui.stats.hidden = false;
    renderStats();
    startDurationTimer();
    show(ui.startBtn, false);
    show(ui.stopBtn, true);
    show(ui.gotoBtn, !onRecordedTab);
    show(ui.startHint, false);
    if (!onRecordedTab) {
      showError('Recording is running in another tab. Only that tab is captured.');
    }
  } else {
    currentSummary = null;
    stopDurationTimer();
    setStatus('idle', 'Ready to record');
    ui.tabLine.textContent = activeTab?.title ? `Tab: ${activeTab.title}` : '';
    ui.stats.hidden = true;
    show(ui.startBtn, true);
    show(ui.stopBtn, false);
    show(ui.pauseBtn, false);
    show(ui.gotoBtn, false);
    show(ui.startHint, true);
    const recordable = activeTab && /^https?:\/\//i.test(activeTab.url || '');
    ui.startBtn.disabled = !recordable;
    if (!recordable) showError('Open a regular web page (http or https) to record it.');
  }

  await renderSessions();
}

function setStatus(kind, text) {
  ui.dot.className = 'dot' + (kind === 'idle' ? '' : ` ${kind}`);
  ui.statusText.textContent = text;
}

function show(element, visible) {
  element.hidden = !visible;
}

function showError(message) {
  ui.error.hidden = !message;
  ui.error.textContent = message || '';
}

function renderStats() {
  if (!currentSummary) return;
  ui.screenshotCount.textContent = currentSummary.screenshotCount ?? 0;
  ui.actionCount.textContent = currentSummary.actionCount ?? 0;
  renderDuration();
}

function renderDuration() {
  if (!currentSummary?.startTime) return;
  const end = currentSummary.endTime || Date.now();
  ui.duration.textContent = formatDuration(Math.floor((end - currentSummary.startTime) / 1000));
}

function startDurationTimer() {
  stopDurationTimer();
  durationTimer = setInterval(renderDuration, 1000);
}

function stopDurationTimer() {
  if (durationTimer) clearInterval(durationTimer);
  durationTimer = null;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function renderSessions() {
  let sessions = [];
  try {
    sessions = await DocBotDB.listSessions();
  } catch (error) {
    console.warn('DocBot: could not list sessions', error);
  }
  ui.recentCard.hidden = sessions.length === 0;
  ui.sessionList.replaceChildren(...sessions.map((session) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = session.title || session.url || 'Recording';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const when = new Date(session.startTime).toLocaleString();
    meta.textContent = `${when} · ${session.screenshots?.length || 0} screens`;
    info.append(title, meta);
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.addEventListener('click', () => send({ action: 'openReport', sessionId: session.sessionId }).then(() => window.close()));
    li.append(info, open);
    return li;
  }));
}
