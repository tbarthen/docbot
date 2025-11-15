// DocBot Content Script - Injected into web pages to capture user actions

(function() {
  'use strict';

  if (window.docbotInjected) return;
  window.docbotInjected = true;

  let settings = {
    captureClicks: true,
    captureInputs: true,
    captureNavigation: true,
    autoScreenshot: true,
    enableAutoFill: false,
    pauseBeforeSubmit: true,
    useRealisticData: true
  };

  let autoFillTriggered = false;
  let submitButtonsIntercepted = false;

  chrome.storage.local.get([
    'captureClicks', 'captureInputs', 'captureNavigation', 'autoScreenshot',
    'enableAutoFill', 'pauseBeforeSubmit', 'useRealisticData'
  ], (result) => {
    settings = {
      captureClicks: result.captureClicks !== false,
      captureInputs: result.captureInputs !== false,
      captureNavigation: result.captureNavigation !== false,
      autoScreenshot: result.autoScreenshot !== false,
      enableAutoFill: result.enableAutoFill === true,
      pauseBeforeSubmit: result.pauseBeforeSubmit !== false,
      useRealisticData: result.useRealisticData !== false
    };
    initializeCapture();
  });

  function initializeCapture() {
    if (settings.captureClicks) {
      document.addEventListener('click', handleClick, true);
    }
    if (settings.captureInputs) {
      document.addEventListener('input', handleInput, true);
      document.addEventListener('change', handleChange, true);
    }
    if (settings.captureNavigation) {
      capturePageLoad();
      captureNavigation();
    }
    showRecordingIndicator();

    if (settings.enableAutoFill) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(() => autoFillPage(), 1000));
      } else {
        setTimeout(() => autoFillPage(), 1000);
      }
      if (settings.pauseBeforeSubmit) {
        interceptSubmitButtons();
      }
    }
  }

  function autoFillPage() {
    if (autoFillTriggered) return;
    autoFillTriggered = true;
    const result = AutoFill.fillAllFields(settings.useRealisticData, 200);
    sendAction('autofill', {
      fieldsFound: result.total,
      fieldsFilled: result.filled,
      timestamp: Date.now()
    });
  }

  function interceptSubmitButtons() {
    if (submitButtonsIntercepted) return;
    submitButtonsIntercepted = true;
    const submitButtons = AutoFill.findSubmitButtons();

    submitButtons.forEach(button => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldContinue = await SubmitDialog.show();
        if (shouldContinue) {
          sendAction('submit_confirmed', {
            buttonText: button.textContent || button.value,
            formAction: button.form?.action || 'unknown'
          });
          button.removeEventListener('click', arguments.callee);
          button.click();
        } else {
          sendAction('submit_cancelled', {
            buttonText: button.textContent || button.value
          });
        }
      }, true);
    });

    document.addEventListener('submit', async (event) => {
      if (!settings.pauseBeforeSubmit) return;
      event.preventDefault();
      event.stopPropagation();
      const shouldContinue = await SubmitDialog.show();
      if (shouldContinue) {
        sendAction('submit_confirmed', {
          formAction: event.target.action || 'unknown',
          submitMethod: 'form_event'
        });
        event.target.submit();
      } else {
        sendAction('submit_cancelled', { submitMethod: 'form_event' });
      }
    }, true);
  }

  function handleClick(event) {
    const target = event.target;
    sendAction('click', {
      tagName: target.tagName,
      id: target.id || null,
      className: target.className || null,
      text: getElementText(target),
      href: target.href || null,
      type: target.type || null
    });
  }

  function handleInput(event) {
    const target = event.target;
    const isSensitive = target.type === 'password' ||
                       target.autocomplete === 'cc-number' ||
                       target.name?.toLowerCase().includes('ssn');
    sendAction('input', {
      tagName: target.tagName,
      id: target.id || null,
      name: target.name || null,
      type: target.type || null,
      placeholder: target.placeholder || null,
      value: isSensitive ? '[REDACTED]' : (target.value ? `"${target.value.substring(0, 50)}..."` : null),
      label: getInputLabel(target)
    });
  }

  function handleChange(event) {
    const target = event.target;
    if (target.tagName === 'SELECT') {
      sendAction('select', {
        tagName: 'SELECT',
        id: target.id || null,
        name: target.name || null,
        selectedOption: target.options[target.selectedIndex]?.text || null,
        label: getInputLabel(target)
      });
    } else if (target.type === 'checkbox' || target.type === 'radio') {
      sendAction('toggle', {
        type: target.type,
        id: target.id || null,
        name: target.name || null,
        checked: target.checked,
        value: target.value,
        label: getInputLabel(target)
      });
    }
  }

  function capturePageLoad() {
    sendAction('navigation', {
      url: window.location.href,
      title: document.title,
      type: 'initial_load'
    });
  }

  function captureNavigation() {
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
    window.addEventListener('popstate', () => {
      sendAction('navigation', {
        url: window.location.href,
        title: document.title,
        type: 'popstate'
      });
    });
  }

  function sendAction(type, details) {
    chrome.runtime.sendMessage({
      action: 'captureAction',
      data: { type, details }
    });
  }

  function getElementText(element) {
    const text = element.textContent || element.innerText || element.value || '';
    return text.trim().substring(0, 100);
  }

  function getInputLabel(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent.trim();
    }
    const parentLabel = element.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
    if (element.getAttribute('aria-label')) {
      return element.getAttribute('aria-label');
    }
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
      position: fixed; top: 10px; right: 10px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; padding: 8px 16px; border-radius: 20px;
      font-family: Arial, sans-serif; font-size: 14px; font-weight: 600;
      z-index: 999999; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
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

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.isRecording && !changes.isRecording.newValue) {
        indicator.remove();
        removeEventListeners();
      }
    });
  }

  function removeEventListeners() {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
  }

})();
