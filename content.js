// DocBot content script. Injected by the background worker into the tab
// being recorded; reports clicks, form changes and navigations back to it.

(function () {
  'use strict';

  // Re-injection: tear down the previous instance completely.
  if (typeof window.__docbotCleanup === 'function') {
    try { window.__docbotCleanup(); } catch (_) { /* ignore */ }
  }
  if (!chrome.runtime?.id) return;

  const CLICK_ROUNDTRIP_TIMEOUT_MS = 1500; // never hold a click longer than this
  const cleanups = [];
  let disposed = false;

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  function cleanup() {
    disposed = true;
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch (_) { /* ignore */ }
    }
  }
  window.__docbotCleanup = cleanup;

  let settings = {
    captureClicks: true,
    captureInputs: true,
    captureNavigation: true,
    autoScreenshot: true,
    recordInputValues: false,
    enableAutoFill: false,
    useRealisticData: true
  };

  // -------------------------------------------------------------------------
  // Messages from the background worker
  // -------------------------------------------------------------------------
  let lastRightClickedElement = null;
  on(document, 'contextmenu', (event) => {
    if (event.target instanceof Element && event.target.matches('input, select, textarea')) {
      lastRightClickedElement = event.target;
    }
  }, true);

  const onMessage = (message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ ok: true });
      return;
    }
    if (message.action === 'fillClickedField') {
      if (typeof AutoFill === 'undefined') {
        sendResponse({ success: false, error: 'AutoFill module not loaded' });
      } else if (lastRightClickedElement && AutoFill.fillField(lastRightClickedElement)) {
        AutoFill.highlightField(lastRightClickedElement);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Could not fill field' });
      }
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  cleanups.push(() => chrome.runtime.onMessage.removeListener(onMessage));

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  chrome.storage.local.get([
    'isRecording', 'captureClicks', 'captureInputs', 'captureNavigation', 'autoScreenshot',
    'recordInputValues', 'enableAutoFill', 'useRealisticData'
  ], (result) => {
    if (chrome.runtime.lastError || disposed) return;
    settings = {
      captureClicks: result.captureClicks !== false,
      captureInputs: result.captureInputs !== false,
      captureNavigation: result.captureNavigation !== false,
      autoScreenshot: result.autoScreenshot !== false,
      recordInputValues: result.recordInputValues === true,
      enableAutoFill: result.enableAutoFill === true,
      useRealisticData: result.useRealisticData !== false
    };
    if (!result.isRecording) return; // injected only for the context menu
    initializeCapture();
  });

  function initializeCapture() {
    if (settings.captureClicks) on(document, 'click', handleClick, true);
    if (settings.captureInputs) on(document, 'change', handleChange, true);
    if (settings.captureNavigation) {
      capturePageLoad();
      captureHistoryNavigation();
    }
    if (settings.enableAutoFill) setupAutoFill();

    const onStorageChanged = (changes) => {
      if (changes.isRecording && !changes.isRecording.newValue) cleanup();
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    cleanups.push(() => chrome.storage.onChanged.removeListener(onStorageChanged));
  }

  // -------------------------------------------------------------------------
  // Clicks: hold the click, take the "before" screenshot, then replay it.
  // -------------------------------------------------------------------------
  function handleClick(event) {
    // Our own replayed click (and clicks the page generates itself) pass through.
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const details = describeElement(target);
    const position = {
      x: event.clientX,
      y: event.clientY,
      dpr: window.devicePixelRatio || 1
    };

    // javascript: links cannot be replayed under a strict CSP; log only.
    const anchor = target.closest('a[href]');
    if (anchor && /^javascript:/i.test(anchor.getAttribute('href') || '')) {
      sendAction('click', details, position);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const beforeSnapshot = snapshotVisibleContent();

    sendAction('click', details, position, () => {
      // Replay the click whether or not the screenshot succeeded, and even if
      // the recording stopped in the meantime; the user's click must land.
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        button: event.button,
        buttons: event.buttons,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey
      }));

      if (disposed) return;
      // If the click changed what is on screen, capture the new state once it settles.
      waitForStabilization(beforeSnapshot, { delay: 600, maxWait: 2000 }, () => {
        sendAction('navigation', {
          url: window.location.href,
          title: document.title,
          type: 'post_click_state',
          trigger: details.text
        }, null, null, true);
      });
    });
  }

  function describeElement(el) {
    return {
      tagName: el.tagName,
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      text: visibleText(el),
      href: el.closest('a[href]')?.href || null,
      type: el.getAttribute('type') || null
    };
  }

  function visibleText(el) {
    const text = el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    return text.trim().replace(/\s+/g, ' ').substring(0, 100);
  }

  // -------------------------------------------------------------------------
  // Form changes: one action per field, values only when opted in.
  // -------------------------------------------------------------------------
  function handleChange(event) {
    const t = event.target;
    if (!(t instanceof Element)) return;

    const base = {
      tagName: t.tagName,
      id: t.id || null,
      name: t.name || null,
      label: inputLabel(t)
    };

    if (t.tagName === 'SELECT') {
      sendAction('select', { ...base, selectedOption: t.options[t.selectedIndex]?.text || null });
    } else if (t.type === 'checkbox' || t.type === 'radio') {
      sendAction('toggle', { ...base, type: t.type, checked: t.checked });
    } else if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
      const sensitive = t.type === 'password' ||
        /cc-|card|cvc|cvv/i.test(t.autocomplete || '') ||
        /ssn|social|passw|secret|token|card|cvv|account/i.test(`${t.name} ${t.id} ${base.label}`);
      let value = null;
      if (settings.recordInputValues && !sensitive && t.value) {
        value = t.value.length > 50 ? `${t.value.substring(0, 50)}...` : t.value;
      } else if (t.value) {
        value = sensitive ? '[redacted]' : '[entered]';
      }
      sendAction('input', { ...base, type: t.type || null, value });
    }
  }

  function inputLabel(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const parent = el.closest('label');
    if (parent) return parent.textContent.trim();
    return el.getAttribute('aria-label') || el.placeholder || null;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  function capturePageLoad() {
    let fired = false;
    const fire = () => {
      if (fired || disposed) return;
      fired = true;
      // Give the page a moment to paint before the full screenshot.
      setTimeout(() => {
        if (disposed) return;
        sendAction('navigation', {
          url: window.location.href,
          title: document.title,
          type: 'page_load'
        }, null, null, true);
      }, 400);
    };
    if (document.readyState === 'complete') {
      fire();
    } else {
      on(window, 'load', fire);
      setTimeout(fire, 3000); // slow resources must not block the first screenshot
    }
  }

  function captureHistoryNavigation() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const logHistory = (type) => sendAction('navigation', { url: window.location.href, title: document.title, type });

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      logHistory('pushState');
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      logHistory('replaceState');
      return result;
    };
    cleanups.push(() => {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    });

    on(window, 'popstate', () => logHistory('popstate'));

    // Hash routers (Handlebars/Require.js style SPAs): wait for the new view,
    // including spinners that appear and disappear, then capture it.
    on(window, 'hashchange', (event) => {
      const before = snapshotVisibleContent();
      waitForStabilization(before, { delay: 1000, maxWait: 5000, minWait: 1500 }, () => {
        sendAction('navigation', {
          url: window.location.href,
          title: document.title,
          type: 'hashchange',
          oldURL: event.oldURL,
          newURL: event.newURL
        }, null, null, true);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Detecting when the page has finished reacting to something
  // -------------------------------------------------------------------------
  function snapshotVisibleContent() {
    const parts = [];
    document.querySelectorAll('div, form, section, main, article, fieldset, p, span, label, table').forEach((el) => {
      const isCollapse = el.classList.contains('collapse');
      if (isCollapse && !el.classList.contains('in') && !el.classList.contains('show')) return; // Bootstrap collapsed
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && (rect.height > 50 || isCollapse)) {
        parts.push(`${el.tagName}:${el.id || ''}:${el.className}:${(el.textContent || '').substring(0, 50)}`);
      }
    });
    return parts.join('|');
  }

  function isMeaningfulMutation(m) {
    if (m.type === 'childList') return m.addedNodes.length > 0 || m.removedNodes.length > 0;
    if (m.type !== 'attributes' || !(m.target instanceof Element)) return false;
    if (m.attributeName === 'aria-expanded') return true;
    if (m.attributeName === 'class' && m.target.classList.contains('collapse')) return true;
    return m.target.offsetHeight > 50 || m.target.offsetWidth > 50;
  }

  // Calls `callback` once the DOM has been quiet for `delay` ms (or `maxWait`
  // has passed) and only if the visible content differs from `before`.
  function waitForStabilization(before, { delay, maxWait, minWait = 0 }, callback) {
    const startedAt = Date.now();
    let debounce = null;
    let finished = false;

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(isMeaningfulMutation)) armDebounce();
    });

    const finish = () => {
      if (finished) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed < minWait) {
        setTimeout(finish, minWait - elapsed);
        return;
      }
      finished = true;
      observer.disconnect();
      clearTimeout(debounce);
      clearTimeout(maxTimer);
      if (disposed) return;
      if (snapshotVisibleContent() !== before) callback();
    };

    const armDebounce = () => {
      clearTimeout(debounce);
      debounce = setTimeout(finish, delay);
    };

    const maxTimer = setTimeout(finish, maxWait);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-expanded']
    });
    cleanups.push(() => { observer.disconnect(); clearTimeout(debounce); clearTimeout(maxTimer); });
    armDebounce();
  }

  // -------------------------------------------------------------------------
  // Auto-fill (optional)
  // -------------------------------------------------------------------------
  let autoFillTimer = null;
  let isAutoFilling = false;
  let filledFieldsCount = 0;

  function setupAutoFill() {
    const schedule = () => {
      clearTimeout(autoFillTimer);
      autoFillTimer = setTimeout(autoFillPage, 1000);
    };
    if (document.readyState === 'loading') on(document, 'DOMContentLoaded', schedule);
    else schedule();

    const observer = new MutationObserver((mutations) => {
      if (isAutoFilling) return;
      const added = mutations.some((m) => Array.from(m.addedNodes).some((node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.matches('form, input, textarea, select') || node.querySelector('input, textarea, select'))
      ));
      if (added) schedule();
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    cleanups.push(() => { observer.disconnect(); clearTimeout(autoFillTimer); });
  }

  function autoFillPage() {
    if (disposed || typeof AutoFill === 'undefined') return;
    isAutoFilling = true;
    const result = AutoFill.fillAllFields();
    if (result.total > 0 && result.total > filledFieldsCount) {
      filledFieldsCount = result.total;
      sendAction('autofill', { fieldsFound: result.total, fieldsFilled: result.filled });
    }
    setTimeout(() => { isAutoFilling = false; }, 1500);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------
  function sendAction(type, details, elementPosition = null, callback = null, captureScreenshot = false) {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (callback) callback();
    };

    if (!chrome.runtime?.id) { finish(); return; }

    // A held click must never wait on a background worker that does not answer.
    if (callback) timer = setTimeout(finish, CLICK_ROUNDTRIP_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage({
        action: 'captureAction',
        data: { type, details, elementPosition, captureScreenshot }
      }, () => {
        void chrome.runtime.lastError; // extension reloaded or worker gone; nothing to do
        finish();
      });
    } catch (_) {
      finish();
    }
  }
})();
