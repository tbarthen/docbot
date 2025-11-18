// DocBot Background Service Worker
let recordingData = {
  startTime: null,
  endTime: null,
  screenshots: [], // Stores screenshot IDs (actual images stored in IndexedDB)
  actions: [],
  settings: {},
  sessionId: null // Unique ID for this recording session
};

let isRecording = false;
let recordingTabId = null; // Track which tab is being recorded
let lastScreenshotTime = 0;
const SCREENSHOT_COOLDOWN = 600; // Chrome allows max 2 screenshots/sec, so 600ms = safe rate

// IndexedDB for screenshot storage (no 10MB limit like chrome.storage.local)
let screenshotDB = null;

// Initialize IndexedDB
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

// Initialize DB on startup
initScreenshotDB().catch(console.error);

// Restore recording state on service worker startup (handles service worker restarts)
async function restoreRecordingState() {
  try {
    const state = await chrome.storage.local.get(['isRecording', 'recordingTabId', 'recordingData']);

    if (state.isRecording && state.recordingData) {
      console.log('DocBot [background]: Restoring recording state after service worker restart');
      isRecording = state.isRecording;
      recordingTabId = state.recordingTabId;
      recordingData = state.recordingData;

      console.log('DocBot [background]: Restored data:', {
        actions: recordingData.actions?.length,
        screenshots: recordingData.screenshots?.length,
        tabId: recordingTabId
      });

      // Restore badge
      chrome.action.setBadgeText({ text: 'REC' });
      chrome.action.setBadgeBackgroundColor({ color: '#dc3545' });
    }
  } catch (error) {
    console.error('DocBot [background]: Failed to restore recording state:', error);
  }
}

// Restore state on service worker startup
restoreRecordingState();

// Create context menu on installation
chrome.runtime.onInstalled.addListener(() => {
  // Remove existing context menu if it exists (prevents duplicate errors on reload)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'docbot-autofill-field',
      title: 'Auto-fill this field',
      contexts: ['editable']
    });
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'docbot-autofill-field' && tab) {
    // Send message to content script to fill the clicked field
    chrome.tabs.sendMessage(tab.id, {
      action: 'fillClickedField'
    });
  }
});

// Helper function to inject all content scripts into a tab
async function injectContentScripts(tabId) {
  try {
    console.log('DocBot: Injecting scripts into tab', tabId);

    // Inject dependencies first, sequentially to avoid race conditions
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['autofill.js']
    });

    // Then inject content script which depends on the above
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });

    console.log('DocBot: Scripts injected successfully');
  } catch (error) {
    console.error('DocBot: Failed to inject scripts:', error);
  }
}

// Listen for tab navigation to re-inject scripts
// We need to track the last URL to detect actual page changes vs. hash changes
let lastRecordedUrl = null;

chrome.webNavigation.onCommitted.addListener((details) => {
  // Only handle the recording tab and main frame navigations
  if (details.tabId === recordingTabId && details.frameId === 0 && isRecording) {
    // Parse URLs to compare (ignore hash fragments)
    const newUrl = new URL(details.url);
    const lastUrl = lastRecordedUrl ? new URL(lastRecordedUrl) : null;

    // Determine if this is a real page navigation that requires script re-injection
    // Real navigations include:
    // - Different origin (cross-site navigation)
    // - Different pathname (different page)
    // - Different flowId parameter (server-side flow change - common in Java webapps)
    // - Different _flowExecutionKey (new flow instance)

    let isRealNavigation = false;

    if (!lastUrl) {
      // First navigation
      isRealNavigation = true;
    } else if (newUrl.origin !== lastUrl.origin) {
      // Cross-origin navigation
      isRealNavigation = true;
    } else if (newUrl.pathname !== lastUrl.pathname) {
      // Different path
      isRealNavigation = true;
    } else {
      // Same origin and path, check if flow parameters changed (for server-side flows)
      const newFlowId = newUrl.searchParams.get('_flowId');
      const lastFlowId = lastUrl.searchParams.get('_flowId');
      const newFlowKey = newUrl.searchParams.get('_flowExecutionKey');
      const lastFlowKey = lastUrl.searchParams.get('_flowExecutionKey');

      console.log('DocBot: Comparing flow params - newFlowId:', newFlowId, 'lastFlowId:', lastFlowId, 'newFlowKey:', newFlowKey, 'lastFlowKey:', lastFlowKey);

      // If flowId changed, it's definitely a new page
      if (newFlowId !== lastFlowId) {
        console.log('DocBot: FlowId changed, treating as real navigation');
        isRealNavigation = true;
      }
      // If flowExecutionKey changed (including being added or removed), it's a new page
      else if (newFlowKey !== lastFlowKey) {
        console.log('DocBot: FlowExecutionKey changed, treating as real navigation');
        isRealNavigation = true;
      }
    }

    console.log('DocBot: Navigation detected:', details.transitionType, 'from', lastRecordedUrl, 'to', details.url, 'Real navigation:', isRealNavigation);

    // Check if this was triggered by a form submission
    chrome.storage.local.get(['formSubmitted', 'formSubmitTime', 'formSubmitUrl'], async (result) => {
      const wasFormSubmit = result.formSubmitted &&
                           (Date.now() - result.formSubmitTime < 3000); // Within 3 seconds

      if (wasFormSubmit) {
        console.log('DocBot: Form submission detected, will capture post-submit screenshot');
        // Clear the flag
        chrome.storage.local.remove(['formSubmitted', 'formSubmitTime', 'formSubmitUrl']);
      }

      if (isRealNavigation || wasFormSubmit) {
        console.log('DocBot: Re-injecting scripts for', isRealNavigation ? 'real navigation' : 'form submission');

        // Delay script re-injection to give the page time to load
        // This prevents interfering with form submissions and allows the DOM to stabilize
        setTimeout(async () => {
          await injectContentScripts(details.tabId);

          // Capture screenshot after page loads (new screen/dialog)
          chrome.tabs.get(details.tabId, async (tab) => {
            // Record the navigation
            await captureAction({
              type: 'navigation',
              details: {
                url: details.url,
                transitionType: wasFormSubmit ? 'form_submit' : details.transitionType
              },
              captureScreenshot: true // Always capture screenshot for navigation to new screen
            }, tab);
          });
        }, 500);

        // Update last recorded URL only when we actually re-inject
        lastRecordedUrl = details.url;
      } else {
        console.log('DocBot: Skipping re-injection (not a real navigation or form submit)');
      }
    });
  }
});

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'startRecording':
      startRecording(message.settings);
      sendResponse({ success: true });
      break;

    case 'stopRecording':
      stopRecording()
        .then(() => sendResponse({ success: true, data: recordingData }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response

    case 'captureAction':
      if (isRecording && sender.tab?.id === recordingTabId) {
        console.log('DocBot [background]: Capturing action:', message.data.type);
        captureAction(message.data, sender.tab)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep channel open for async response
      } else {
        console.log('DocBot [background]: SKIPPING action capture - isRecording:', isRecording, 'sender.tab.id:', sender.tab?.id, 'recordingTabId:', recordingTabId);
        sendResponse({ success: true });
      }
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

  // Return true to keep the message channel open for sendResponse
  return true;
});

async function startRecording(settings) {
  isRecording = true;
  lastScreenshotTime = 0; // Reset screenshot cooldown
  lastRecordedUrl = null; // Reset navigation tracking

  // Generate unique session ID for this recording
  const sessionId = 'docbot_' + Date.now();

  // Clear old screenshots from IndexedDB to avoid accumulation
  await clearOldScreenshots();

  recordingData = {
    startTime: Date.now(),
    endTime: null,
    screenshots: [],
    actions: [],
    settings: settings || {},
    sessionId: sessionId
  };

  // Set badge to show recording status (red dot on extension icon)
  chrome.action.setBadgeText({ text: '●' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });

  // Inject content scripts into active tab
  // Scripts must be injected sequentially to avoid race conditions
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (tabs[0]) {
      recordingTabId = tabs[0].id; // Track which tab is being recorded
      lastRecordedUrl = tabs[0].url; // Track initial URL

      // Save state and settings FIRST, before injecting scripts
      // This ensures the content script can read the settings when it loads
      await chrome.storage.local.set({
        isRecording: true,
        recordingTabId: recordingTabId,
        recordingData,
        // Also save individual settings for easy access
        captureClicks: settings.captureClicks,
        captureInputs: settings.captureInputs,
        captureNavigation: settings.captureNavigation,
        autoScreenshot: settings.autoScreenshot,
        enableAutoFill: settings.enableAutoFill,
        useRealisticData: settings.useRealisticData
      });

      // Reset the injection flag to allow re-initialization on the same page
      await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => { delete window.docbotInjected; }
      });

      // Inject scripts using helper function
      await injectContentScripts(tabs[0].id);

      // Capture initial screenshot of the starting page
      setTimeout(async () => {
        const action = {
          timestamp: Date.now(),
          type: 'navigation',
          details: {
            url: tabs[0].url,
            transitionType: 'initial_load'
          },
          url: tabs[0].url,
          title: tabs[0].title,
          elementPosition: null
        };
        recordingData.actions.push(action);
        await captureScreenshot(tabs[0].id, action, false);

        // Update storage
        await chrome.storage.local.set({ recordingData });
      }, 1000); // Wait 1 second for page to stabilize
    }
  });
}

async function stopRecording() {
  isRecording = false;
  recordingTabId = null;

  // Defensive check: ensure recordingData exists
  if (!recordingData) {
    console.error('DocBot [background]: ERROR - recordingData is null/undefined when stopping!');
    recordingData = {
      startTime: Date.now(),
      endTime: Date.now(),
      screenshots: [],
      actions: [],
      settings: {}
    };
  }

  recordingData.endTime = Date.now();

  // Clear badge when recording stops
  chrome.action.setBadgeText({ text: '' });

  console.log('DocBot [background]: Stopping recording with data:', {
    actions: recordingData.actions?.length,
    screenshots: recordingData.screenshots?.length,
    startTime: recordingData.startTime,
    endTime: recordingData.endTime
  });

  // Save completed recording
  await chrome.storage.local.set({
    isRecording: false,
    recordingTabId: null,
    completedRecording: recordingData
  });

  console.log('DocBot [background]: Recording saved to completedRecording');
}

async function captureAction(actionData, tab) {
  // Add action to recording
  const action = {
    timestamp: Date.now(),
    type: actionData.type,
    details: actionData.details,
    url: tab.url,
    title: tab.title,
    elementPosition: actionData.elementPosition // Store element position for visual indicator
  };

  recordingData.actions.push(action);

  // Capture screenshot for:
  // 1. Navigation events (new screens/dialogs) - FULL screenshot
  // 2. Click events - CROPPED screenshot (small area around click)
  // 3. Never for input/form events
  const shouldCapture = (actionData.type === 'navigation' && actionData.captureScreenshot) ||
                        (recordingData.settings.autoScreenshot && actionData.type === 'click');

  if (shouldCapture) {
    const now = Date.now();
    if (now - lastScreenshotTime >= SCREENSHOT_COOLDOWN) {
      // Determine if we should crop (clicks) or full screenshot (navigation)
      const shouldCrop = actionData.type === 'click';
      await captureScreenshot(tab.id, action, shouldCrop);
      lastScreenshotTime = now;
    }
  }

  // Update storage (now much lighter since we're not storing base64 images)
  try {
    await chrome.storage.local.set({ recordingData });
  } catch (error) {
    console.error('DocBot: Failed to save recording data:', error);
  }

  // Notify popup of update (only if popup is open)
  chrome.runtime.sendMessage({
    action: 'recordingUpdate',
    data: recordingData
  }).catch(() => {
    // Popup is closed, ignore error
  });
}

async function captureScreenshot(tabId, associatedAction = null, shouldCrop = false) {
  try {
    // Get current scroll position AND viewport info to detect if page scrolled since click
    let currentScrollPos = null;
    if (shouldCrop && associatedAction?.elementPosition?.scrollX !== undefined) {
      try {
        const scrollResult = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => ({
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            pageWidth: document.documentElement.scrollWidth,
            pageHeight: document.documentElement.scrollHeight
          })
        });
        currentScrollPos = scrollResult[0].result;
        console.log(`DocBot [background]: Viewport info: ${currentScrollPos.viewportWidth}x${currentScrollPos.viewportHeight}, Page: ${currentScrollPos.pageWidth}x${currentScrollPos.pageHeight}`);
      } catch (error) {
        console.warn('DocBot: Could not get scroll position:', error);
      }
    }

    // Log what we're about to capture
    if (shouldCrop && associatedAction?.elementPosition) {
      console.log(`DocBot [background]: About to capture screenshot for click at (${associatedAction.elementPosition.x}, ${associatedAction.elementPosition.y}), recorded scroll: (${associatedAction.elementPosition.scrollX}, ${associatedAction.elementPosition.scrollY})`);
      if (currentScrollPos) {
        console.log(`DocBot [background]: Current scroll position: (${currentScrollPos.scrollX}, ${currentScrollPos.scrollY})`);
      }
    }

    // Capture screenshot immediately to match the exact state when coordinates were captured
    // No delay needed since we removed the on-page indicator

    // Get quality setting from storage
    const qualitySettings = await chrome.storage.local.get('screenshotQuality');
    const qualitySetting = qualitySettings.screenshotQuality || 'medium';

    // Map quality setting to JPEG quality value
    const qualityMap = {
      'high': 90,   // Best quality, ~7-8 MB
      'medium': 70, // Balanced, ~3-4 MB
      'low': 50     // Smallest, ~2 MB
    };
    const jpegQuality = qualityMap[qualitySetting] || 70;

    let dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'jpeg',
      quality: jpegQuality
    });

    console.log(`DocBot [background]: Screenshot captured (${shouldCrop ? 'CROP' : 'FULL'})`);

    // Track trim offset for coordinate adjustment
    let trimOffset = { x: 0, y: 0 };

    // Track the actual position where the indicator should be placed in the cropped image
    let indicatorPosInCrop = null;

    if (shouldCrop && associatedAction?.elementPosition) {
      // Adjust coordinates if page scrolled between click and screenshot
      let adjustedPosition = { ...associatedAction.elementPosition };
      if (currentScrollPos && associatedAction.elementPosition.scrollX !== undefined) {
        const scrollDeltaX = currentScrollPos.scrollX - associatedAction.elementPosition.scrollX;
        const scrollDeltaY = currentScrollPos.scrollY - associatedAction.elementPosition.scrollY;

        if (scrollDeltaX !== 0 || scrollDeltaY !== 0) {
          console.log(`DocBot: Page scrolled by (${scrollDeltaX}, ${scrollDeltaY}) since click`);
          adjustedPosition.x -= scrollDeltaX;
          adjustedPosition.y -= scrollDeltaY;
        }
      }

      // For CLICK screenshots: crop directly from the full screenshot WITHOUT trimming
      // Since we're only showing a 400x400 area around the click, trimming isn't necessary
      // and it avoids coordinate adjustment issues
      const cropResult = await cropToClickArea(dataUrl, adjustedPosition);
      dataUrl = cropResult.dataUrl;
      indicatorPosInCrop = cropResult.indicatorPosition; // Actual position in cropped image
    } else {
      // For NAVIGATION screenshots: just trim whitespace
      const trimResult = await trimWhitespace(dataUrl);
      dataUrl = trimResult.dataUrl;
      trimOffset = trimResult.offset;
    }

    // Add visual indicator if action has element position
    // For clicks, use the calculated position from crop; for navigation, adjust for trim offset
    if (associatedAction?.elementPosition) {
      const indicatorOffset = shouldCrop ? { x: 0, y: 0 } : trimOffset;
      dataUrl = await addVisualIndicator(dataUrl, associatedAction, indicatorOffset, shouldCrop, indicatorPosInCrop);
    }

    // Generate unique ID for this screenshot
    const screenshotId = `${recordingData.sessionId}_${Date.now()}_${associatedAction?.type || 'screenshot'}`;

    // Save to IndexedDB instead of chrome.storage
    await saveScreenshotToDB(screenshotId, dataUrl);

    const screenshot = {
      id: screenshotId,
      timestamp: Date.now(),
      associatedAction: associatedAction,
      isCropped: shouldCrop
    };

    recordingData.screenshots.push(screenshot);

    return screenshot;
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    return null;
  }
}

// Trim whitespace from screenshot edges
async function trimWhitespace(imageDataUrl) {
  return new Promise(async (resolve) => {
    try {
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);

      // Create temporary canvas to analyze the image
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imageBitmap, 0, 0);

      // Get image data to find content bounds
      const imageData = ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height);
      const data = imageData.data;

      // Detect content bounds by finding non-white pixels
      let minX = imageBitmap.width;
      let minY = imageBitmap.height;
      let maxX = 0;
      let maxY = 0;

      // Sample every 4th pixel for performance (good enough for whitespace detection)
      for (let y = 0; y < imageBitmap.height; y += 4) {
        for (let x = 0; x < imageBitmap.width; x += 4) {
          const i = (y * imageBitmap.width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          // Consider pixel as "content" if it's not pure white or near-white
          // Using threshold of 245 to catch slightly off-white backgrounds
          if (r < 245 || g < 245 || b < 245) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // If we found content, crop to those bounds (with small padding)
      if (maxX > minX && maxY > minY) {
        const padding = 20; // Add small padding around content
        minX = Math.max(0, minX - padding);
        minY = Math.max(0, minY - padding);
        maxX = Math.min(imageBitmap.width, maxX + padding);
        maxY = Math.min(imageBitmap.height, maxY + padding);

        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;

        // Create cropped canvas
        const croppedCanvas = new OffscreenCanvas(contentWidth, contentHeight);
        const croppedCtx = croppedCanvas.getContext('2d');

        // Draw cropped portion
        croppedCtx.drawImage(
          imageBitmap,
          minX, minY, contentWidth, contentHeight,
          0, 0, contentWidth, contentHeight
        );

        // Convert to data URL
        const resultBlob = await croppedCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        const reader = new FileReader();
        reader.onloadend = () => resolve({
          dataUrl: reader.result,
          offset: { x: minX, y: minY }
        });
        reader.readAsDataURL(resultBlob);
      } else {
        // No content found or couldn't detect bounds, return original
        resolve({
          dataUrl: imageDataUrl,
          offset: { x: 0, y: 0 }
        });
      }
    } catch (error) {
      console.error('Failed to trim whitespace:', error);
      resolve({
        dataUrl: imageDataUrl,
        offset: { x: 0, y: 0 }
      }); // Return original if trimming fails
    }
  });
}

// Crop screenshot to small area around click position
async function cropToClickArea(imageDataUrl, position) {
  return new Promise(async (resolve) => {
    try {
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);

      // Define crop area: 400x400 pixels centered on click
      const cropSize = 400;
      const halfSize = cropSize / 2;

      // Calculate crop bounds, ensuring we don't go outside image bounds
      let cropX = Math.max(0, position.x - halfSize);
      let cropY = Math.max(0, position.y - halfSize);

      // Adjust if crop would exceed image dimensions
      if (cropX + cropSize > imageBitmap.width) {
        cropX = Math.max(0, imageBitmap.width - cropSize);
      }
      if (cropY + cropSize > imageBitmap.height) {
        cropY = Math.max(0, imageBitmap.height - cropSize);
      }

      // Ensure crop dimensions don't exceed image
      const actualWidth = Math.min(cropSize, imageBitmap.width - cropX);
      const actualHeight = Math.min(cropSize, imageBitmap.height - cropY);

      // Calculate where the click indicator should appear in the cropped image
      // It's the original position minus the crop offset
      const indicatorPosition = {
        x: position.x - cropX,
        y: position.y - cropY
      };

      console.log(`DocBot [crop]: Image size: ${imageBitmap.width}x${imageBitmap.height}, Click position: (${position.x}, ${position.y})`);
      console.log(`DocBot [crop]: Cropping region: (${cropX}, ${cropY}) to (${cropX + actualWidth}, ${cropY + actualHeight})`);
      console.log(`DocBot [crop]: Indicator will be at (${indicatorPosition.x}, ${indicatorPosition.y}) in cropped image`);

      // Create cropped canvas
      const canvas = new OffscreenCanvas(actualWidth, actualHeight);
      const ctx = canvas.getContext('2d');

      // Draw cropped portion
      ctx.drawImage(
        imageBitmap,
        cropX, cropY, actualWidth, actualHeight, // Source rectangle
        0, 0, actualWidth, actualHeight          // Destination rectangle
      );

      // Convert to data URL
      const resultBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const reader = new FileReader();
      reader.onloadend = () => resolve({
        dataUrl: reader.result,
        indicatorPosition: indicatorPosition
      });
      reader.readAsDataURL(resultBlob);
    } catch (error) {
      console.error('Failed to crop screenshot:', error);
      resolve({
        dataUrl: imageDataUrl,
        indicatorPosition: { x: 200, y: 200 } // Center fallback
      });
    }
  });
}

// Save screenshot to IndexedDB
async function saveScreenshotToDB(id, dataUrl) {
  if (!screenshotDB) {
    await initScreenshotDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = screenshotDB.transaction(['screenshots'], 'readwrite');
    const store = transaction.objectStore('screenshots');

    const screenshot = {
      id: id,
      dataUrl: dataUrl,
      timestamp: Date.now()
    };

    const request = store.put(screenshot);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Load screenshot from IndexedDB
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

// Clear all screenshots from IndexedDB (called when starting a new recording)
async function clearOldScreenshots() {
  if (!screenshotDB) {
    await initScreenshotDB();
  }

  return new Promise((resolve, reject) => {
    const transaction = screenshotDB.transaction(['screenshots'], 'readwrite');
    const store = transaction.objectStore('screenshots');
    const request = store.clear();

    request.onsuccess = () => {
      console.log('DocBot: Cleared old screenshots from IndexedDB');
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function addVisualIndicator(imageDataUrl, action, trimOffset = { x: 0, y: 0 }, isCroppedClick = false, cropIndicatorPos = null) {
  return new Promise(async (resolve) => {
    try {
      // Service workers don't have Image constructor, so we need to use fetch + createImageBitmap
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);

      // Create canvas
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d');

      // Draw original image
      ctx.drawImage(imageBitmap, 0, 0);

      const pos = action.elementPosition;

      // Calculate adjusted position based on image type
      let adjustedX = pos.x;
      let adjustedY = pos.y;

      // For cropped click screenshots, use the exact calculated position from the crop function
      if (isCroppedClick && cropIndicatorPos) {
        // Use the precise position calculated during cropping
        adjustedX = cropIndicatorPos.x;
        adjustedY = cropIndicatorPos.y;
      } else {
        // This is a full/trimmed screenshot - adjust for whitespace trim offset
        adjustedX = pos.x - trimOffset.x;
        adjustedY = pos.y - trimOffset.y;
      }

      // Draw visual indicator based on action type
      if (action.type === 'click') {
        // Red pulsing circle for clicks
        ctx.strokeStyle = '#FF0000';
        ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
        ctx.lineWidth = 3;

        // Draw filled circle
        ctx.beginPath();
        ctx.arc(adjustedX, adjustedY, 25, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Draw outer ring
        ctx.beginPath();
        ctx.arc(adjustedX, adjustedY, 35, 0, Math.PI * 2);
        ctx.stroke();
      } else if (action.type === 'input' || action.type === 'select' || action.type === 'toggle') {
        // Blue highlight box for input fields
        ctx.strokeStyle = '#0066FF';
        ctx.fillStyle = 'rgba(0, 102, 255, 0.1)';
        ctx.lineWidth = 3;

        // Draw rectangle around element
        const padding = 5;
        ctx.fillRect(
          pos.x - padding,
          pos.y - padding,
          pos.width + (padding * 2),
          pos.height + (padding * 2)
        );
        ctx.strokeRect(
          pos.x - padding,
          pos.y - padding,
          pos.width + (padding * 2),
          pos.height + (padding * 2)
        );
      }

      // Convert canvas to data URL
      const resultBlob = await canvas.convertToBlob({ type: 'image/png', quality: 0.8 });
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(resultBlob);
    } catch (error) {
      console.error('Failed to add visual indicator:', error);
      // Return original image if indicator fails
      resolve(imageDataUrl);
    }
  });
}

async function analyzeWithAI(apiKey, recordingData) {
  // Prepare data for Claude API - load screenshots from IndexedDB
  const prompt = await buildAnalysisPrompt(recordingData);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
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
      // Try to get error details from response
      let errorMessage = `API request failed: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        }
      } catch (e) {
        // If we can't parse the error, use the status text
        if (response.status === 401) {
          errorMessage = 'Invalid API key. Please check that your Claude API key is correct and has the format: sk-ant-...';
        } else if (response.status === 429) {
          errorMessage = 'Rate limit exceeded or insufficient credits. Please check your Anthropic account.';
        } else if (response.status === 400) {
          errorMessage = 'Invalid request. The request format may be incorrect.';
        }
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('AI analysis failed:', error);
    throw error;
  }
}

async function buildAnalysisPrompt(recordingData) {
  const actionsSummary = recordingData.actions.map((action, idx) => {
    return `${idx + 1}. [${action.type}] ${JSON.stringify(action.details)} on page: ${action.title}`;
  }).join('\n');

  const duration = Math.floor((recordingData.endTime - recordingData.startTime) / 1000);

  const promptParts = [
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
    }
  ];

  // Load screenshots from IndexedDB and include up to 10
  const screenshotsToInclude = recordingData.screenshots.slice(0, 10);
  for (const screenshot of screenshotsToInclude) {
    try {
      const screenshotData = await loadScreenshotFromDB(screenshot.id);
      if (screenshotData && screenshotData.dataUrl) {
        promptParts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: screenshotData.dataUrl.split(',')[1]
          }
        });
      }
    } catch (error) {
      console.error('Failed to load screenshot for AI analysis:', error);
    }
  }

  return promptParts;
}

async function exportToPdf(recordingData) {
  // Open the report.html page which will load the recording data from storage
  chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
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
