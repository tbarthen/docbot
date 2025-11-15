// DocBot Background Service Worker
let recordingData = {
  startTime: null,
  endTime: null,
  screenshots: [],
  actions: [],
  settings: {}
};

let isRecording = false;
let lastScreenshotTime = 0;
const SCREENSHOT_COOLDOWN = 1000; // Minimum 1 second between screenshots

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'startRecording':
      startRecording(message.settings);
      sendResponse({ success: true });
      break;

    case 'stopRecording':
      stopRecording();
      sendResponse({ success: true });
      break;

    case 'captureAction':
      if (isRecording) {
        captureAction(message.data, sender.tab);
      }
      sendResponse({ success: true });
      break;

    case 'analyzeRecording':
      analyzeWithAI(message.apiKey, message.recordingData)
        .then(analysis => sendResponse({ success: true, analysis }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response

    case 'exportToPdf':
      exportToPdf(message.recordingData);
      sendResponse({ success: true });
      break;
  }
});

function startRecording(settings) {
  isRecording = true;
  lastScreenshotTime = 0; // Reset screenshot cooldown
  recordingData = {
    startTime: Date.now(),
    endTime: null,
    screenshots: [],
    actions: [],
    settings: settings || {}
  };

  // Save state
  chrome.storage.local.set({
    isRecording: true,
    recordingData
  });

  // Inject content script into active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        files: ['content.js']
      });
    }
  });

  console.log('Recording started');
}

function stopRecording() {
  isRecording = false;
  recordingData.endTime = Date.now();

  // Save completed recording
  chrome.storage.local.set({
    isRecording: false,
    completedRecording: recordingData
  });

  console.log('Recording stopped', recordingData);
}

async function captureAction(actionData, tab) {
  // Add action to recording
  const action = {
    timestamp: Date.now(),
    type: actionData.type,
    details: actionData.details,
    url: tab.url,
    title: tab.title
  };

  recordingData.actions.push(action);

  // Capture screenshot if auto-screenshot is enabled and cooldown has passed
  if (recordingData.settings.autoScreenshot) {
    const now = Date.now();
    if (now - lastScreenshotTime >= SCREENSHOT_COOLDOWN) {
      await captureScreenshot(tab.id, action);
      lastScreenshotTime = now;
    }
  }

  // Update storage and notify popup
  chrome.storage.local.set({ recordingData });

  // Notify popup of update (only if popup is open)
  try {
    chrome.runtime.sendMessage({
      action: 'recordingUpdate',
      data: recordingData
    });
  } catch (error) {
    // Popup is closed, ignore error
  }
}

async function captureScreenshot(tabId, associatedAction = null) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 80
    });

    const screenshot = {
      timestamp: Date.now(),
      dataUrl: dataUrl,
      associatedAction: associatedAction
    };

    recordingData.screenshots.push(screenshot);

    // Update storage
    chrome.storage.local.set({ recordingData });

    return screenshot;
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    return null;
  }
}

async function analyzeWithAI(apiKey, recordingData) {
  // Prepare data for Claude API
  const prompt = buildAnalysisPrompt(recordingData);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('AI analysis failed:', error);
    throw error;
  }
}

function buildAnalysisPrompt(recordingData) {
  const actionsSummary = recordingData.actions.map((action, idx) => {
    return `${idx + 1}. [${action.type}] ${JSON.stringify(action.details)} on page: ${action.title}`;
  }).join('\n');

  const duration = Math.floor((recordingData.endTime - recordingData.startTime) / 1000);

  return [
    {
      type: 'text',
      text: `You are analyzing a recorded user workflow from a USPS web application where customers enroll in services.

Please analyze the following workflow and create a professional, high-level documentation suitable for executive review.

Recording Duration: ${duration} seconds
Number of Actions: ${recordingData.actions.length}
Number of Screenshots: ${recordingData.screenshots.length}

Actions Performed:
${actionsSummary}

Please provide:
1. **Overview**: A brief summary of what functionality this workflow demonstrates
2. **Key Features**: High-level description of the main features/capabilities shown
3. **User Journey**: Step-by-step description of the enrollment process (in business terms, not technical)
4. **Business Value**: What this functionality enables for USPS customers

Format your response as clean HTML that can be embedded in a document.`
    },
    // Include screenshots (up to 10 to stay within limits)
    ...recordingData.screenshots.slice(0, 10).map(screenshot => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: screenshot.dataUrl.split(',')[1]
      }
    }))
  ];
}

async function exportToPdf(recordingData) {
  // Create a formatted HTML page and open it in a new tab
  // User can then print to PDF
  const html = generateReportHTML(recordingData);

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  chrome.tabs.create({ url: url });
}

function generateReportHTML(recordingData) {
  const duration = Math.floor((recordingData.endTime - recordingData.startTime) / 1000);
  const startDate = new Date(recordingData.startTime).toLocaleString();

  const actionsHtml = recordingData.actions.map((action, idx) => {
    const time = new Date(action.timestamp).toLocaleTimeString();
    return `
      <div class="action-item">
        <div class="action-number">${idx + 1}</div>
        <div class="action-details">
          <div class="action-type">${action.type}</div>
          <div class="action-info">${formatActionDetails(action.details)}</div>
          <div class="action-page">${action.title}</div>
          <div class="action-time">${time}</div>
        </div>
      </div>
    `;
  }).join('');

  const screenshotsHtml = recordingData.screenshots.map((screenshot, idx) => {
    return `
      <div class="screenshot-item">
        <h4>Screenshot ${idx + 1}</h4>
        <img src="${screenshot.dataUrl}" alt="Screenshot ${idx + 1}">
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>DocBot Recording Report</title>
  <style>
    @media print {
      .no-print { display: none; }
      body { margin: 0; }
    }

    body {
      font-family: Arial, sans-serif;
      max-width: 1000px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #f5f5f5;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 30px;
    }

    .header h1 {
      margin: 0 0 10px 0;
    }

    .header .subtitle {
      opacity: 0.9;
      font-size: 14px;
    }

    .report-section {
      background: white;
      padding: 25px;
      margin-bottom: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .report-section h2 {
      color: #667eea;
      margin-top: 0;
      border-bottom: 2px solid #e9ecef;
      padding-bottom: 10px;
    }

    .meta-info {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-bottom: 20px;
    }

    .meta-item {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 6px;
    }

    .meta-label {
      font-size: 12px;
      color: #6c757d;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .meta-value {
      font-size: 24px;
      font-weight: bold;
      color: #495057;
    }

    .action-item {
      display: flex;
      gap: 15px;
      padding: 15px;
      border-left: 3px solid #667eea;
      background: #f8f9fa;
      margin-bottom: 10px;
      border-radius: 4px;
    }

    .action-number {
      background: #667eea;
      color: white;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      flex-shrink: 0;
    }

    .action-details {
      flex: 1;
    }

    .action-type {
      font-weight: bold;
      color: #495057;
      margin-bottom: 4px;
    }

    .action-info {
      color: #6c757d;
      font-size: 14px;
      margin-bottom: 4px;
    }

    .action-page {
      color: #764ba2;
      font-size: 13px;
      margin-bottom: 4px;
    }

    .action-time {
      color: #adb5bd;
      font-size: 12px;
    }

    .screenshot-item {
      margin-bottom: 30px;
      page-break-inside: avoid;
    }

    .screenshot-item h4 {
      color: #495057;
      margin-bottom: 10px;
    }

    .screenshot-item img {
      max-width: 100%;
      border: 1px solid #dee2e6;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .print-button {
      position: fixed;
      top: 20px;
      right: 20px;
      background: #667eea;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      box-shadow: 0 4px 8px rgba(0,0,0,0.2);
      z-index: 1000;
    }

    .print-button:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <button class="print-button no-print" onclick="window.print()">🖨️ Print to PDF</button>

  <div class="header">
    <h1>📝 DocBot Recording Report</h1>
    <div class="subtitle">USPS Web Application Workflow Documentation</div>
  </div>

  <div class="report-section">
    <h2>Recording Summary</h2>
    <div class="meta-info">
      <div class="meta-item">
        <div class="meta-label">Duration</div>
        <div class="meta-value">${Math.floor(duration / 60)}m ${duration % 60}s</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Actions Captured</div>
        <div class="meta-value">${recordingData.actions.length}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Screenshots</div>
        <div class="meta-value">${recordingData.screenshots.length}</div>
      </div>
    </div>
    <p><strong>Recording Date:</strong> ${startDate}</p>
  </div>

  <div class="report-section">
    <h2>Actions Timeline</h2>
    ${actionsHtml}
  </div>

  <div class="report-section">
    <h2>Screenshots</h2>
    ${screenshotsHtml}
  </div>

  <script>
    // Auto-focus print dialog after page loads (optional)
    // window.onload = () => setTimeout(() => window.print(), 500);
  </script>
</body>
</html>
  `;
}

function formatActionDetails(details) {
  if (typeof details === 'string') return details;
  if (typeof details === 'object') {
    return Object.entries(details)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  }
  return String(details);
}
