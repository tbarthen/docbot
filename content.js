// DocBot Content Script - Injected into web pages to capture user actions

(function() {
  'use strict';

  // Prevent multiple injections - clean up old listeners if re-injecting
  if (window.docbotInjected) {
    console.log('DocBot: Script already injected, cleaning up old listeners');
    // Remove old event listeners if they exist
    if (window.docbotCleanup) {
      window.docbotCleanup();
    }
  }
  window.docbotInjected = true;

  // Track the last right-clicked element for context menu
  let lastRightClickedElement = null;
  document.addEventListener('contextmenu', (event) => {
    if (event.target.matches('input, select, textarea')) {
      lastRightClickedElement = event.target;
    }
  }, true);

  // Listen for messages from background script (e.g., context menu clicks)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fillClickedField' && lastRightClickedElement) {
      // Check if AutoFill module is available
      if (typeof AutoFill !== 'undefined') {
        const filled = AutoFill.fillField(lastRightClickedElement, true);
        if (filled) {
          AutoFill.highlightField(lastRightClickedElement);
          console.log('DocBot: Filled field via context menu');
          sendResponse({ success: true });
        } else {
          console.log('DocBot: Could not fill field via context menu');
          sendResponse({ success: false, error: 'Could not fill field' });
        }
      } else {
        sendResponse({ success: false, error: 'AutoFill module not loaded' });
      }
    }
    return true; // Keep message channel open for async response
  });

  let settings = {
    captureClicks: true,
    captureInputs: true,
    captureNavigation: true,
    autoScreenshot: true,
    enableAutoFill: true,
    useRealisticData: true
  };

  let autoFillTriggered = false;
  let autoFillTimeout = null; // Debounce timer for auto-fill
  let isAutoFilling = false; // Track if we're currently auto-filling to prevent cascading triggers
  let filledFieldsCount = 0; // Track how many fields we've filled to avoid re-filling same fields

  // Check if extension context is valid before initializing
  if (!chrome.runtime?.id) {
    console.log('DocBot: Extension context invalid, script will not initialize');
    return;
  }

  // Load settings and initialize capture
  // Note: This script is injected by background.js when recording starts,
  // so we can assume recording is active
  try {
    chrome.storage.local.get([
      'isRecording',
      'captureClicks', 'captureInputs', 'captureNavigation', 'autoScreenshot',
      'enableAutoFill', 'useRealisticData'
    ], (result) => {
      settings = {
        captureClicks: result.captureClicks !== false,
        captureInputs: result.captureInputs !== false,
        captureNavigation: result.captureNavigation !== false,
        autoScreenshot: result.autoScreenshot !== false,
        enableAutoFill: result.enableAutoFill === true, // Default to OFF
        useRealisticData: result.useRealisticData !== false
      };

      console.log('DocBot: Settings loaded, initializing capture...', settings);

      // Initialize capture since this script is only injected when recording starts
      initializeCapture();
    });
  } catch (error) {
    console.log('DocBot: Failed to load settings, extension may have been reloaded');
  }

  function initializeCapture() {
    console.log('DocBot: Capture initialized', settings);

    // Capture clicks
    if (settings.captureClicks) {
      document.addEventListener('click', handleClick, true);
    }

    // Capture form inputs
    if (settings.captureInputs) {
      document.addEventListener('input', handleInput, true);
      document.addEventListener('change', handleChange, true);
    }

    // Capture navigation
    if (settings.captureNavigation) {
      capturePageLoad();
      captureNavigation();

      // Capture form submissions to detect same-page reloads
      captureFormSubmissions();
    }

    // Listen for recording stop
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.isRecording && !changes.isRecording.newValue) {
        removeEventListeners();
      }
    });

    // Auto-fill forms if enabled
    if (settings.enableAutoFill) {
      // Wait for page to be fully loaded
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(() => autoFillPage(), 1000);
        });
      } else {
        setTimeout(() => autoFillPage(), 1000);
      }

      // Watch for new forms being added to the page
      const formObserver = new MutationObserver((mutations) => {
        // Don't trigger if we're currently auto-filling (prevents cascading triggers)
        if (isAutoFilling) return;

        // Track if we found any genuinely new form elements
        let foundNewFormElement = false;

        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if a form or form fields were added
              if (node.tagName === 'FORM' ||
                  node.tagName === 'INPUT' ||
                  node.tagName === 'TEXTAREA' ||
                  node.tagName === 'SELECT' ||
                  (node.querySelectorAll && node.querySelectorAll('input, textarea, select').length > 0)) {
                foundNewFormElement = true;
                break;
              }
            }
          }
          if (foundNewFormElement) break;
        }

        // Only trigger auto-fill if we actually found new form elements AND auto-fill is enabled
        if (foundNewFormElement && settings.enableAutoFill) {
          // Debounce: cancel any pending auto-fill and schedule a new one
          if (autoFillTimeout) {
            clearTimeout(autoFillTimeout);
          }
          autoFillTimeout = setTimeout(() => {
            autoFillPage();
            autoFillTimeout = null;
          }, 1000); // Wait 1 second after last DOM change
        }
      });

      // Start observing for new forms
      if (document.body) {
        formObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    }
  }

  function autoFillPage() {
    // Check if AutoFill module is available
    if (typeof AutoFill === 'undefined') {
      console.error('DocBot: AutoFill module not loaded!');
      return;
    }

    console.log(`DocBot [autofill]: Starting auto-fill, current scroll: (${window.scrollX}, ${window.scrollY})`);

    // Set flag to prevent mutation observer from triggering during auto-fill
    isAutoFilling = true;

    // Use the AutoFill module - disable visual highlighting (delay=0) to prevent page scrolling
    const result = AutoFill.fillAllFields(settings.useRealisticData, 0);

    console.log(`DocBot [autofill]: Auto-fill complete, final scroll: (${window.scrollX}, ${window.scrollY})`);

    // Only send notification and log if we actually found NEW fields
    // (not the same fields being re-added to the DOM)
    if (result.total > 0 && result.total > filledFieldsCount) {
      autoFillTriggered = true;
      filledFieldsCount = result.total; // Update our count

      // Send notification
      sendAction('autofill', {
        fieldsFound: result.total,
        fieldsFilled: result.filled,
        timestamp: Date.now()
      });

      console.log(`DocBot: Auto-filled ${result.filled} of ${result.total} fields`);
    } else if (result.total > 0) {
      console.log(`DocBot: Skipping auto-fill - same ${result.total} fields already filled`);
    }

    // Clear flag after a delay (to allow all mutations to complete)
    setTimeout(() => {
      isAutoFilling = false;
    }, 1500);
  }

  function handleClick(event) {
    const target = event.target;
    const rect = target.getBoundingClientRect();

    const details = {
      tagName: target.tagName,
      id: target.id || null,
      className: target.className || null,
      text: getElementText(target),
      href: target.href || null,
      type: target.type || null
    };

    // Use the actual mouse click coordinates from the event
    // This is more reliable than getBoundingClientRect() which can be affected by CSS transforms
    // clientX/clientY give us the exact viewport coordinates where the user clicked
    const elementPosition = {
      x: event.clientX,  // Exact click X in viewport
      y: event.clientY,  // Exact click Y in viewport
      width: rect.width,
      height: rect.height,
      scrollX: window.scrollX,  // Current scroll position
      scrollY: window.scrollY
    };

    console.log(`DocBot: Click captured at viewport (${elementPosition.x}, ${elementPosition.y}), scroll: (${elementPosition.scrollX}, ${elementPosition.scrollY}), element:`, target);

    sendAction('click', details, elementPosition);
  }

  function handleInput(event) {
    const target = event.target;
    const rect = target.getBoundingClientRect();

    // Don't capture actual password or sensitive data
    const isSensitive = target.type === 'password' ||
                       target.autocomplete === 'cc-number' ||
                       target.name?.toLowerCase().includes('ssn');

    const details = {
      tagName: target.tagName,
      id: target.id || null,
      name: target.name || null,
      type: target.type || null,
      placeholder: target.placeholder || null,
      value: isSensitive ? '[REDACTED]' : (target.value ? `"${target.value.substring(0, 50)}..."` : null),
      label: getInputLabel(target)
    };

    const elementPosition = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };

    sendAction('input', details, elementPosition);
  }

  function handleChange(event) {
    const target = event.target;
    const rect = target.getBoundingClientRect();

    const elementPosition = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };

    if (target.tagName === 'SELECT') {
      const details = {
        tagName: 'SELECT',
        id: target.id || null,
        name: target.name || null,
        selectedOption: target.options[target.selectedIndex]?.text || null,
        label: getInputLabel(target)
      };
      sendAction('select', details, elementPosition);
    } else if (target.type === 'checkbox' || target.type === 'radio') {
      const details = {
        type: target.type,
        id: target.id || null,
        name: target.name || null,
        checked: target.checked,
        value: target.value,
        label: getInputLabel(target)
      };
      sendAction('toggle', details, elementPosition);
    }
  }

  function capturePageLoad() {
    const details = {
      url: window.location.href,
      title: document.title,
      type: 'initial_load'
    };
    sendAction('navigation', details);
  }

  function captureNavigation() {
    // Capture navigation via History API
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(this, args);
      sendAction('navigation', {
        url: window.location.href,
        title: document.title,
        type: 'pushState'
      });
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      sendAction('navigation', {
        url: window.location.href,
        title: document.title,
        type: 'replaceState'
      });
    };

    // Capture popstate (back/forward)
    window.addEventListener('popstate', () => {
      sendAction('navigation', {
        url: window.location.href,
        title: document.title,
        type: 'popstate'
      });
    });
  }

  function captureFormSubmissions() {
    // Listen for form submissions to detect page reloads (even to same URL)
    document.addEventListener('submit', (event) => {
      const form = event.target;
      console.log('DocBot: Form submission detected', form);

      // Set a flag in storage to indicate a form was submitted
      // This will be checked after the page reloads
      try {
        chrome.storage.local.set({
          formSubmitted: true,
          formSubmitTime: Date.now(),
          formSubmitUrl: window.location.href
        });
      } catch (error) {
        console.log('DocBot: Failed to set form submission flag:', error);
      }
    }, true);
  }

  function sendAction(type, details, elementPosition = null) {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('DocBot: Extension context invalidated, skipping action capture');
      return;
    }

    try {
      chrome.runtime.sendMessage({
        action: 'captureAction',
        data: {
          type,
          details,
          elementPosition
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('DocBot: Error sending action:', chrome.runtime.lastError.message);
        }
      });
    } catch (error) {
      // Extension was reloaded or context is invalid
      console.log('DocBot: Failed to send action, extension may have been reloaded:', error);
    }
  }

  function getElementText(element) {
    // Get visible text from element
    const text = element.textContent || element.innerText || element.value || '';
    return text.trim().substring(0, 100);
  }

  function getInputLabel(element) {
    // Try to find associated label
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent.trim();
    }

    // Check parent label
    const parentLabel = element.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();

    // Check aria-label
    if (element.getAttribute('aria-label')) {
      return element.getAttribute('aria-label');
    }

    // Check placeholder
    if (element.placeholder) {
      return element.placeholder;
    }

    return null;
  }

  function removeEventListeners() {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
  }

  // Expose cleanup function for re-initialization
  window.docbotCleanup = removeEventListeners;

})();
