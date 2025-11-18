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

      // Capture final state before page unloads (e.g., form submit → new page)
      window.addEventListener('beforeunload', handleBeforeUnload);
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
    // INTERCEPT: Prevent the click from propagating until we capture screenshot
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

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

    console.log(`DocBot: Click intercepted at viewport (${elementPosition.x}, ${elementPosition.y}), scroll: (${elementPosition.scrollX}, ${elementPosition.scrollY}), element:`, target);

    // CAPTURE SNAPSHOT BEFORE CLICK - this is the "before" state
    const beforeSnapshot = captureVisibleContentSnapshot();
    console.log('DocBot: Captured BEFORE snapshot, length:', beforeSnapshot.length);

    // Send action and wait for screenshot, then re-dispatch the click
    sendAction('click', details, elementPosition, () => {
      // After screenshot is captured, re-dispatch the click to trigger original behavior
      console.log('DocBot: Re-dispatching click to trigger original behavior');

      // Remove our listener temporarily to avoid infinite loop
      document.removeEventListener('click', handleClick, true);

      // Re-dispatch the click event
      const newEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
        buttons: event.buttons,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey
      });
      target.dispatchEvent(newEvent);

      // Now detect when the page has finished responding to the click
      // Pass the BEFORE snapshot to compare against
      detectPageStabilization(beforeSnapshot, () => {
        // Page has stabilized - capture full screenshot of new state
        console.log('DocBot: Page stabilized, capturing full screenshot of new state');
        sendAction('navigation', {
          url: window.location.href,
          title: document.title,
          type: 'post_click_state',
          trigger: details
        }, null, null, true); // true = full screenshot
      });

      // Re-attach our listener after a short delay
      setTimeout(() => {
        document.addEventListener('click', handleClick, true);
      }, 100);
    });
  }


  function captureVisibleContentSnapshot() {
    // Capture a snapshot of all visible text content to detect changes
    // This helps detect jQuery show/hide that might not trigger MutationObserver
    const visibleElements = [];

    // Get all elements that might have visible content
    document.querySelectorAll('div, form, section, main, article, fieldset, p, span, label').forEach(el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      // Special handling for Bootstrap collapse elements - check classes instead of height
      const isBootstrapCollapse = el.classList.contains('collapse');
      const isCollapsed = isBootstrapCollapse && (
        !el.classList.contains('in') &&  // Bootstrap 3 uses 'in' class for expanded state
        (el.getAttribute('aria-expanded') === 'false' || !el.getAttribute('aria-expanded'))
      );

      // Skip if it's a collapsed Bootstrap element
      if (isBootstrapCollapse && isCollapsed) {
        return;
      }

      // Only include visible elements with significant size
      if (style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity) > 0 &&
          rect.width > 50 &&
          (rect.height > 50 || (isBootstrapCollapse && !isCollapsed))) {
        // Create a simple signature: tag + ID + classes + visible text snippet
        // Include ID to differentiate between similar panels (e.g., accordion panels)
        const signature = `${el.tagName}:${el.id || 'no-id'}:${el.className}:${el.textContent?.substring(0, 50) || ''}`;
        visibleElements.push(signature);
      }
    });

    // Return concatenated signatures - if content changes, this will change
    return visibleElements.join('|');
  }

  function detectPageStabilization(initialSnapshot, callback) {
    // Detect when DOM stops changing after a click action
    let debounceTimer = null;
    let observer = null;
    const STABILIZATION_DELAY = 600; // Wait 600ms after last change (Bootstrap animations are 350ms)
    const MAX_WAIT = 2000; // Don't wait more than 2 seconds total

    // initialSnapshot is passed from handleClick - captured BEFORE the click was re-dispatched
    let hasContentChanged = false;

    const cleanup = () => {
      if (observer) observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };

    const onStabilized = () => {
      cleanup();

      // Before calling callback, verify content actually changed
      const finalSnapshot = captureVisibleContentSnapshot();
      hasContentChanged = (finalSnapshot !== initialSnapshot);

      console.log('DocBot: Content changed:', hasContentChanged,
                  'Initial length:', initialSnapshot.length,
                  'Final length:', finalSnapshot.length);

      // Only capture full screenshot if content actually changed
      if (hasContentChanged) {
        callback();
      } else {
        console.log('DocBot: No significant content change detected, skipping full screenshot');
      }
    };

    // Set maximum timeout
    const maxTimeout = setTimeout(() => {
      console.log('DocBot: Max wait time reached, checking if content changed');
      onStabilized();
    }, MAX_WAIT);

    // Reset debounce timer on any DOM change
    const resetDebounce = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('DocBot: No DOM changes for 600ms, checking stability');
        clearTimeout(maxTimeout);
        onStabilized();
      }, STABILIZATION_DELAY);
    };

    // Observe DOM changes
    observer = new MutationObserver((mutations) => {
      // Log what mutations we're seeing
      const meaningfulMutations = mutations.filter(m => {
        // Check for Bootstrap accordion state changes
        if (m.type === 'attributes' && m.attributeName === 'aria-expanded') {
          console.log('DocBot: Detected accordion state change (aria-expanded):', m.target);
          return true;
        }
        // Check for visibility changes
        if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class' || m.attributeName === 'hidden')) {
          const element = m.target;
          if (element.nodeType === Node.ELEMENT_NODE) {
            const isLargeElement = element.offsetHeight > 50 || element.offsetWidth > 50;
            if (isLargeElement) {
              console.log('DocBot: Detected visibility change on large element:', element);
              return true;
            }
          }
        }
        // Check for significant DOM structure changes
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          console.log('DocBot: Detected DOM structure change:', m.addedNodes.length, 'added,', m.removedNodes.length, 'removed');
          return true;
        }
        return false;
      });

      // Only reset if we see meaningful changes
      if (meaningfulMutations.length > 0) {
        console.log('DocBot: Page still changing, resetting stabilization timer');
        resetDebounce();
      }
    });

    // Observe body for changes
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-expanded']
    });

    // Start the debounce timer
    resetDebounce();
  }

  function detectPageStabilizationExtended(initialSnapshot, callback) {
    // Extended version for hash navigation that waits longer for spinners to disappear
    let debounceTimer = null;
    let observer = null;
    const STABILIZATION_DELAY = 1000; // Wait 1 second after last change (for spinners)
    const MAX_WAIT = 5000; // Wait up to 5 seconds for complex SPA transitions
    const MIN_WAIT = 1500; // Minimum wait to ensure spinner has time to appear and disappear

    let hasContentChanged = false;
    let startTime = Date.now();

    const cleanup = () => {
      if (observer) observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };

    const onStabilized = () => {
      cleanup();

      // Check if we've waited the minimum time
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_WAIT) {
        console.log('DocBot: Hash navigation - waiting minimum time before capturing');
        setTimeout(onStabilized, MIN_WAIT - elapsed);
        return;
      }

      // Verify content actually changed
      const finalSnapshot = captureVisibleContentSnapshot();
      hasContentChanged = (finalSnapshot !== initialSnapshot);

      console.log('DocBot: Hash navigation stabilized:', hasContentChanged,
                  'Initial length:', initialSnapshot.length,
                  'Final length:', finalSnapshot.length,
                  'Elapsed:', elapsed, 'ms');

      // Only capture full screenshot if content actually changed
      if (hasContentChanged) {
        callback();
      } else {
        console.log('DocBot: No significant content change detected after hash navigation');
      }
    };

    // Set maximum timeout
    const maxTimeout = setTimeout(() => {
      console.log('DocBot: Hash navigation max wait time reached');
      onStabilized();
    }, MAX_WAIT);

    // Reset debounce timer on any DOM change
    const resetDebounce = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('DocBot: Hash navigation - no DOM changes for 1s, checking stability');
        clearTimeout(maxTimeout);
        onStabilized();
      }, STABILIZATION_DELAY);
    };

    // Observe DOM changes (same as regular stabilization)
    observer = new MutationObserver((mutations) => {
      const meaningfulMutations = mutations.filter(m => {
        if (m.type === 'attributes' && m.attributeName === 'aria-expanded') {
          console.log('DocBot: Hash nav - detected accordion state change');
          return true;
        }
        if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class' || m.attributeName === 'hidden')) {
          const element = m.target;
          if (element.nodeType === Node.ELEMENT_NODE) {
            const isLargeElement = element.offsetHeight > 50 || element.offsetWidth > 50;
            if (isLargeElement) {
              console.log('DocBot: Hash nav - detected visibility change on large element');
              return true;
            }
          }
        }
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          console.log('DocBot: Hash nav - detected DOM structure change');
          return true;
        }
        return false;
      });

      if (meaningfulMutations.length > 0) {
        console.log('DocBot: Hash nav - page still changing, resetting timer');
        resetDebounce();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-expanded']
    });

    // Start the debounce timer
    resetDebounce();
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

    // Capture hash navigation (common in custom SPAs with Handlebars, Require.js, etc.)
    window.addEventListener('hashchange', (event) => {
      console.log('DocBot: Hash navigation detected', {
        oldURL: event.oldURL,
        newURL: event.newURL,
        hash: window.location.hash
      });

      // Capture snapshot before view changes
      const beforeSnapshot = captureVisibleContentSnapshot();

      // Wait for the SPA to render the new view (with extended timeout for spinners)
      detectPageStabilizationExtended(beforeSnapshot, () => {
        console.log('DocBot: Hash navigation completed, capturing new view');

        sendAction('navigation', {
          url: window.location.href,
          title: document.title,
          type: 'hashchange',
          hash: window.location.hash,
          oldURL: event.oldURL,
          newURL: event.newURL
        }, null, null, true); // Capture full screenshot of new view
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

  function handleBeforeUnload(event) {
    // Capture final screenshot before page navigates away
    console.log('DocBot: Page unloading, capturing final state');

    const details = {
      url: window.location.href,
      title: document.title,
      type: 'page_unload',
      destination: 'unknown' // We don't know where we're going yet
    };

    // Send synchronously to ensure it captures before unload
    sendAction('navigation', details, null, null, true); // true = full screenshot
  }

  function sendAction(type, details, elementPosition = null, callback = null, captureFullScreenshot = false) {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('DocBot: Extension context invalidated, skipping action capture');
      if (callback) callback();
      return;
    }

    try {
      chrome.runtime.sendMessage({
        action: 'captureAction',
        data: {
          type,
          details,
          elementPosition,
          captureScreenshot: captureFullScreenshot // Tell background to capture full screenshot for navigation
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('DocBot: Error sending action:', chrome.runtime.lastError.message);
        }
        // Invoke callback after screenshot is captured
        if (callback) {
          callback();
        }
      });
    } catch (error) {
      // Extension was reloaded or context is invalid
      console.log('DocBot: Failed to send action, extension may have been reloaded:', error);
      if (callback) callback();
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
    window.removeEventListener('beforeunload', handleBeforeUnload);
  }

  // Expose cleanup function for re-initialization
  window.docbotCleanup = removeEventListeners;

})();
