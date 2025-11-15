// DocBot Content Script - Injected into web pages to capture user actions

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.docbotInjected) {
    return;
  }
  window.docbotInjected = true;

  let settings = {
    captureClicks: true,
    captureInputs: true,
    captureNavigation: true,
    autoScreenshot: true,
    enableAutoFill: true,
    pauseBeforeSubmit: true,
    useRealisticData: true
  };

  let autoFillTriggered = false;
  let submitButtonsIntercepted = false;

  // Check if extension context is valid before initializing
  if (!chrome.runtime?.id) {
    console.log('DocBot: Extension context invalid, script will not initialize');
    return;
  }

  // Load settings and check if recording is active
  try {
    chrome.storage.local.get([
      'isRecording',
      'captureClicks', 'captureInputs', 'captureNavigation', 'autoScreenshot',
      'enableAutoFill', 'pauseBeforeSubmit', 'useRealisticData'
    ], (result) => {
      settings = {
        captureClicks: result.captureClicks !== false,
        captureInputs: result.captureInputs !== false,
        captureNavigation: result.captureNavigation !== false,
        autoScreenshot: result.autoScreenshot !== false,
        enableAutoFill: result.enableAutoFill !== false,
        pauseBeforeSubmit: result.pauseBeforeSubmit !== false,
        useRealisticData: result.useRealisticData !== false
      };

      // Only initialize if recording is actually active
      if (result.isRecording) {
        initializeCapture();
      }
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
    }

    // Show recording indicator
    showRecordingIndicator();

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

      // Intercept submit buttons
      if (settings.pauseBeforeSubmit) {
        interceptSubmitButtons();
      }
    }
  }

  function autoFillPage() {
    if (autoFillTriggered) return;
    autoFillTriggered = true;

    console.log('DocBot: Auto-filling forms...');

    // Use the AutoFill module
    const result = AutoFill.fillAllFields(settings.useRealisticData, 200);

    // Send notification
    sendAction('autofill', {
      fieldsFound: result.total,
      fieldsFilled: result.filled,
      timestamp: Date.now()
    });

    console.log(`DocBot: Auto-filled ${result.filled} of ${result.total} fields`);
  }

  function interceptSubmitButtons() {
    if (submitButtonsIntercepted) return;
    submitButtonsIntercepted = true;

    // Track if we're in the middle of showing a dialog
    let showingDialog = false;
    let allowedButton = null; // Button that's allowed to submit without dialog

    // Find all submit buttons
    const submitButtons = AutoFill.findSubmitButtons();

    console.log(`DocBot: Intercepting ${submitButtons.length} submit buttons`);

    submitButtons.forEach(button => {
      button.addEventListener('click', async (event) => {
        // Skip if this button was just confirmed
        if (allowedButton === button) {
          console.log('DocBot: Allowing confirmed button to submit');
          allowedButton = null;
          return;
        }

        // Skip if we're already showing dialog or if pauseBeforeSubmit is disabled
        if (showingDialog || !settings.pauseBeforeSubmit) return;

        // Prevent default submission
        event.preventDefault();
        event.stopPropagation();

        showingDialog = true;
        console.log('DocBot: Submit button clicked, showing dialog...');

        // Show confirmation dialog
        const shouldContinue = await SubmitDialog.show();
        showingDialog = false;

        if (shouldContinue) {
          console.log('DocBot: User chose to continue');

          // Record the submission action
          sendAction('submit_confirmed', {
            buttonText: button.textContent || button.value,
            formAction: button.form?.action || 'unknown'
          });

          // Mark this button as allowed for the next click
          allowedButton = button;

          // Trigger a new click event that will go through naturally
          setTimeout(() => {
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            button.dispatchEvent(clickEvent);

            // Clear the allowed button after a delay
            setTimeout(() => {
              allowedButton = null;
            }, 1000);
          }, 10);
        } else {
          console.log('DocBot: User cancelled submission');

          // Record cancellation
          sendAction('submit_cancelled', {
            buttonText: button.textContent || button.value
          });
        }
      }, true);
    });

    // Also intercept form submissions via Enter key
    let allowedForm = null;

    document.addEventListener('submit', async (event) => {
      // Skip if this form was just confirmed
      if (allowedForm === event.target) {
        console.log('DocBot: Allowing confirmed form to submit');
        allowedForm = null;
        return;
      }

      if (!settings.pauseBeforeSubmit || showingDialog) return;

      event.preventDefault();
      event.stopPropagation();

      showingDialog = true;
      console.log('DocBot: Form submit detected, showing dialog...');

      const shouldContinue = await SubmitDialog.show();
      showingDialog = false;

      if (shouldContinue) {
        // Record the submission
        sendAction('submit_confirmed', {
          formAction: event.target.action || 'unknown',
          submitMethod: 'form_event'
        });

        // Mark this form as allowed
        allowedForm = event.target;

        // Try to find and click the submit button, or submit the form
        const submitBtn = event.target.querySelector('[type="submit"]') ||
                         event.target.querySelector('button:not([type="button"])');

        if (submitBtn) {
          // Click the submit button to trigger normal flow
          setTimeout(() => {
            allowedButton = submitBtn;
            submitBtn.click();
            setTimeout(() => {
              allowedForm = null;
              allowedButton = null;
            }, 1000);
          }, 10);
        } else {
          // No submit button found, use form.submit()
          setTimeout(() => {
            event.target.submit();
            setTimeout(() => {
              allowedForm = null;
            }, 1000);
          }, 10);
        }
      } else {
        sendAction('submit_cancelled', {
          submitMethod: 'form_event'
        });
      }
    }, true);
  }

  function handleClick(event) {
    const target = event.target;
    const details = {
      tagName: target.tagName,
      id: target.id || null,
      className: target.className || null,
      text: getElementText(target),
      href: target.href || null,
      type: target.type || null
    };

    sendAction('click', details);
  }

  function handleInput(event) {
    const target = event.target;

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

    sendAction('input', details);
  }

  function handleChange(event) {
    const target = event.target;

    if (target.tagName === 'SELECT') {
      const details = {
        tagName: 'SELECT',
        id: target.id || null,
        name: target.name || null,
        selectedOption: target.options[target.selectedIndex]?.text || null,
        label: getInputLabel(target)
      };
      sendAction('select', details);
    } else if (target.type === 'checkbox' || target.type === 'radio') {
      const details = {
        type: target.type,
        id: target.id || null,
        name: target.name || null,
        checked: target.checked,
        value: target.value,
        label: getInputLabel(target)
      };
      sendAction('toggle', details);
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

  function sendAction(type, details) {
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
          details
        }
      });
    } catch (error) {
      // Extension was reloaded or context is invalid
      console.log('DocBot: Failed to send action, extension may have been reloaded');
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

  function showRecordingIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'docbot-recording-indicator';
    indicator.innerHTML = '● Recording';
    indicator.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-family: Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      animation: docbot-pulse 2s infinite;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes docbot-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.8; transform: scale(0.98); }
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(indicator);

    // Listen for recording stop
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.isRecording && !changes.isRecording.newValue) {
          if (indicator && indicator.parentNode) {
            indicator.remove();
          }
          removeEventListeners();
        }
      });
    } catch (error) {
      console.log('DocBot: Failed to add stop listener, extension may have been reloaded');
    }
  }

  // Listen for recording start from popup
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.isRecording && changes.isRecording.newValue && !changes.isRecording.oldValue) {
        // Recording just started - initialize capture
        if (chrome.runtime?.id) {
          initializeCapture();
        }
      }
    });
  } catch (error) {
    console.log('DocBot: Failed to add storage listener, extension may have been reloaded');
  }

  function removeEventListeners() {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
  }

})();
