// DocBot Popup Script
let isRecording = false;
let recordingData = null;
let durationInterval = null;

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const recordingInfo = document.getElementById('recordingInfo');
const exportSection = document.getElementById('exportSection');
const screenshotCount = document.getElementById('screenshotCount');
const actionCount = document.getElementById('actionCount');
const durationElement = document.getElementById('duration');

const analyzeBtn = document.getElementById('analyzeBtn');
const exportPdfBtn = document.getElementById('exportPdfBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');

// Settings
const captureClicksCheckbox = document.getElementById('captureClicks');
const captureInputsCheckbox = document.getElementById('captureInputs');
const captureNavigationCheckbox = document.getElementById('captureNavigation');
const autoScreenshotCheckbox = document.getElementById('autoScreenshot');
const enableAutoFillCheckbox = document.getElementById('enableAutoFill');
const pauseBeforeSubmitCheckbox = document.getElementById('pauseBeforeSubmit');
const useRealisticDataCheckbox = document.getElementById('useRealisticData');
const apiKeyInput = document.getElementById('apiKey');

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await checkRecordingState();
  attachEventListeners();
});

// Load settings from storage
async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'captureClicks',
    'captureInputs',
    'captureNavigation',
    'autoScreenshot',
    'enableAutoFill',
    'pauseBeforeSubmit',
    'useRealisticData',
    'apiKey'
  ]);

  captureClicksCheckbox.checked = settings.captureClicks !== false;
  captureInputsCheckbox.checked = settings.captureInputs !== false;
  captureNavigationCheckbox.checked = settings.captureNavigation !== false;
  autoScreenshotCheckbox.checked = settings.autoScreenshot !== false;
  enableAutoFillCheckbox.checked = settings.enableAutoFill === true;
  pauseBeforeSubmitCheckbox.checked = settings.pauseBeforeSubmit !== false;
  useRealisticDataCheckbox.checked = settings.useRealisticData !== false;
  apiKeyInput.value = settings.apiKey || '';
}

// Save settings to storage
async function saveSettings() {
  await chrome.storage.local.set({
    captureClicks: captureClicksCheckbox.checked,
    captureInputs: captureInputsCheckbox.checked,
    captureNavigation: captureNavigationCheckbox.checked,
    autoScreenshot: autoScreenshotCheckbox.checked,
    enableAutoFill: enableAutoFillCheckbox.checked,
    pauseBeforeSubmit: pauseBeforeSubmitCheckbox.checked,
    useRealisticData: useRealisticDataCheckbox.checked,
    apiKey: apiKeyInput.value
  });
}

// Check current recording state
async function checkRecordingState() {
  const state = await chrome.storage.local.get(['isRecording', 'recordingData', 'completedRecording']);

  if (state.isRecording) {
    isRecording = true;
    recordingData = state.recordingData;
    updateUIForRecording();
    startDurationTimer();
  } else if (state.completedRecording) {
    recordingData = state.completedRecording;
    updateUIForCompleted();
  } else {
    updateUIForIdle();
  }
}

// Attach event listeners
function attachEventListeners() {
  startBtn.addEventListener('click', handleStartRecording);
  stopBtn.addEventListener('click', handleStopRecording);
  analyzeBtn.addEventListener('click', handleAnalyze);
  exportPdfBtn.addEventListener('click', handleExportPdf);
  exportJsonBtn.addEventListener('click', handleExportJson);

  // Settings change listeners
  [captureClicksCheckbox, captureInputsCheckbox, captureNavigationCheckbox,
   autoScreenshotCheckbox, enableAutoFillCheckbox, pauseBeforeSubmitCheckbox,
   useRealisticDataCheckbox].forEach(checkbox => {
    checkbox.addEventListener('change', saveSettings);
  });

  apiKeyInput.addEventListener('change', saveSettings);

  // Listen for recording updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'recordingUpdate') {
      recordingData = message.data;
      updateRecordingStats();
    }
  });

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.isRecording) {
      isRecording = changes.isRecording.newValue;
      if (!isRecording) {
        stopDurationTimer();
      }
    }
    if (changes.recordingData) {
      recordingData = changes.recordingData.newValue;
      updateRecordingStats();
    }
  });
}

// Handle start recording
async function handleStartRecording() {
  const settings = {
    captureClicks: captureClicksCheckbox.checked,
    captureInputs: captureInputsCheckbox.checked,
    captureNavigation: captureNavigationCheckbox.checked,
    autoScreenshot: autoScreenshotCheckbox.checked,
    enableAutoFill: enableAutoFillCheckbox.checked,
    pauseBeforeSubmit: pauseBeforeSubmitCheckbox.checked,
    useRealisticData: useRealisticDataCheckbox.checked
  };

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'startRecording',
      settings: settings
    });

    if (response.success) {
      isRecording = true;
      updateUIForRecording();
      startDurationTimer();
    }
  } catch (error) {
    console.error('Failed to start recording:', error);
    alert('Failed to start recording. Please try again.');
  }
}

// Handle stop recording
async function handleStopRecording() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'stopRecording'
    });

    if (response.success) {
      isRecording = false;
      stopDurationTimer();

      // Get completed recording data
      const state = await chrome.storage.local.get('completedRecording');
      recordingData = state.completedRecording;

      updateUIForCompleted();
    }
  } catch (error) {
    console.error('Failed to stop recording:', error);
    alert('Failed to stop recording. Please try again.');
  }
}

// Handle AI analysis
async function handleAnalyze() {
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    alert('Please enter your Claude API key in the settings section.');
    return;
  }

  if (!recordingData || !recordingData.actions || recordingData.actions.length === 0) {
    alert('No recording data available to analyze.');
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<span class="btn-icon">⏳</span> Analyzing...';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'analyzeRecording',
      apiKey: apiKey,
      recordingData: recordingData
    });

    if (response.success) {
      // Display analysis in a new tab
      const analysisHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>DocBot AI Analysis</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      max-width: 900px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 30px;
    }
    .content {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 AI Analysis Results</h1>
    <p>Generated by Claude API</p>
  </div>
  <div class="content">
    ${response.analysis}
  </div>
</body>
</html>
      `;

      const blob = new Blob([analysisHtml], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url: url });

    } else {
      alert('AI analysis failed: ' + (response.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Analysis error:', error);
    alert('Failed to analyze recording: ' + error.message);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<span class="btn-icon">🤖</span> Analyze with AI';
  }
}

// Handle PDF export
async function handleExportPdf() {
  if (!recordingData || !recordingData.actions || recordingData.actions.length === 0) {
    alert('No recording data available to export.');
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      action: 'exportToPdf',
      recordingData: recordingData
    });
  } catch (error) {
    console.error('PDF export error:', error);
    alert('Failed to export PDF: ' + error.message);
  }
}

// Handle JSON export
async function handleExportJson() {
  if (!recordingData || !recordingData.actions || recordingData.actions.length === 0) {
    alert('No recording data available to export.');
    return;
  }

  const json = JSON.stringify(recordingData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `docbot-recording-${timestamp}.json`;

  chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: true
  });
}

// Update UI for recording state
function updateUIForRecording() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusIndicator.className = 'status-indicator recording';
  statusText.textContent = 'Recording in progress...';
  recordingInfo.style.display = 'block';
  exportSection.style.display = 'none';
  updateRecordingStats();
}

// Update UI for completed state
function updateUIForCompleted() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusIndicator.className = 'status-indicator completed';
  statusText.textContent = 'Recording completed';
  recordingInfo.style.display = 'block';
  exportSection.style.display = 'block';
  updateRecordingStats();
}

// Update UI for idle state
function updateUIForIdle() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusIndicator.className = 'status-indicator';
  statusText.textContent = 'Ready to record';
  recordingInfo.style.display = 'none';
  exportSection.style.display = 'none';
}

// Update recording statistics
function updateRecordingStats() {
  if (!recordingData) return;

  screenshotCount.textContent = recordingData.screenshots?.length || 0;
  actionCount.textContent = recordingData.actions?.length || 0;

  if (recordingData.startTime) {
    const endTime = recordingData.endTime || Date.now();
    const duration = Math.floor((endTime - recordingData.startTime) / 1000);
    durationElement.textContent = formatDuration(duration);
  }
}

// Start duration timer
function startDurationTimer() {
  if (durationInterval) {
    clearInterval(durationInterval);
  }

  durationInterval = setInterval(() => {
    if (recordingData && recordingData.startTime) {
      const duration = Math.floor((Date.now() - recordingData.startTime) / 1000);
      durationElement.textContent = formatDuration(duration);
    }
  }, 1000);
}

// Stop duration timer
function stopDurationTimer() {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
}

// Format duration as MM:SS
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
