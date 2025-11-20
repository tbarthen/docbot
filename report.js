// DocBot Report Generator
// This script runs in the report.html page to populate it with recording data

// IndexedDB helper functions
let screenshotDB = null;

function initScreenshotDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('DocBotScreenshots', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      screenshotDB = request.result;
      resolve(screenshotDB);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('screenshots')) {
        db.createObjectStore('screenshots', { keyPath: 'id' });
      }
    };
  });
}

async function loadScreenshotFromDB(id) {
  if (!screenshotDB) {
    await initScreenshotDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = screenshotDB.transaction(['screenshots'], 'readonly');
    const store = transaction.objectStore('screenshots');
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

(async function() {
  // Add print button handler
  document.getElementById('printBtn').addEventListener('click', () => {
    window.print();
  });

  // Initialize IndexedDB
  await initScreenshotDB();

  try {
    // Get recording data from storage
    const data = await chrome.storage.local.get('completedRecording');
    const recordingData = data.completedRecording;

    if (!recordingData) {
      document.getElementById('content').innerHTML = `
        <div class="report-section">
          <h2>No Recording Data Found</h2>
          <p>Please complete a recording first, then export to PDF.</p>
        </div>
      `;
      return;
    }

    // Update page title with recording timestamp
    const recordingDate = new Date(recordingData.startTime).toLocaleString();
    document.title = `DocBot Report - ${recordingDate}`;

    // Add timestamp to header
    const subtitle = document.querySelector('.subtitle');
    if (subtitle) {
      subtitle.textContent = `Recording from ${recordingDate}`;
    }

    // Load screenshots from IndexedDB
    const container = document.createElement('div');

    for (let idx = 0; idx < recordingData.screenshots.length; idx++) {
      const screenshot = recordingData.screenshots[idx];
      const screenshotDiv = document.createElement('div');
      screenshotDiv.className = 'screenshot-item';

      const img = document.createElement('img');
      img.alt = `Screenshot ${idx + 1}`;

      try {
        // Load screenshot from IndexedDB
        const screenshotData = await loadScreenshotFromDB(screenshot.id);

        if (screenshotData && screenshotData.dataUrl) {
          img.src = screenshotData.dataUrl;
        } else {
          // Screenshot not found
          img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text x="50%" y="50%" text-anchor="middle">Screenshot not found</text></svg>';
        }
      } catch (error) {
        console.error('Failed to load screenshot:', error);
        img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text x="50%" y="50%" text-anchor="middle">Error loading screenshot</text></svg>';
      }

      screenshotDiv.appendChild(img);
      container.appendChild(screenshotDiv);
    }

    // Update the page content - SCREENSHOTS ONLY (no text summary)
    const contentDiv = document.getElementById('content');
    contentDiv.innerHTML = '';

    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'report-section';
    sectionDiv.appendChild(container);

    contentDiv.appendChild(sectionDiv);
  } catch (error) {
    console.error('Error loading report:', error);
    document.getElementById('content').innerHTML = `
      <div class="report-section">
        <h2>Error Loading Report</h2>
        <p>An error occurred while loading the recording data: ${error.message}</p>
      </div>
    `;
  }
})();

function formatActionDetails(details) {
  if (typeof details === 'string') return details;
  if (typeof details === 'object') {
    return Object.entries(details)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  }
  return String(details);
}
