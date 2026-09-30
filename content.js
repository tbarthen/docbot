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
  const MAX_LABEL_LENGTH = 80;             // longer click targets get no text in the log
  const cleanups = new Set();
  let disposed = false;
  let isTopFrame = true;
  try { isTopFrame = window === window.top; } catch (_) { isTopFrame = false; }

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.add(() => target.removeEventListener(type, handler, options));
  }

  function cleanup() {
    disposed = true;
    for (const fn of Array.from(cleanups)) {
      try { fn(); } catch (_) { /* ignore */ }
    }
    cleanups.clear();
  }
  window.__docbotCleanup = cleanup;

  let paused = false;
  let recording = false;
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
    switch (message.action) {
      case 'ping':
        sendResponse({ ok: true, recording });
        return;
      case 'captureAfterSettle':
        // A same-document navigation (pushState) happened; capture the new view once it settles.
        if (recording && !paused) {
          waitForStabilization(snapshotVisibleContent(), { delay: 600, maxWait: 3000, force: true }, () => {
            sendAction('navigation', {
              url: window.location.href,
              title: document.title,
              type: message.type || 'view_settled'
            }, null, null, true);
          });
        }
        sendResponse({ ok: true });
        return;
      case 'watchForSettle':
        // A click happened inside one of our frames; if this page changes as a
        // result, capture it once it settles (the frame watches itself too).
        if (recording && !paused) {
          if (cancelPendingSettle) cancelPendingSettle();
          cancelPendingSettle = waitForStabilization(snapshotVisibleContent(), { delay: 600, maxWait: 2000 }, () => {
            sendAction('navigation', { url: window.location.href, title: document.title, type: 'post_click_state' }, null, null, true);
          });
        }
        sendResponse({ ok: true });
        return;

      case 'fillClickedField':
        if (typeof AutoFill === 'undefined') {
          sendResponse({ success: false, error: 'AutoFill module not loaded' });
        } else if (lastRightClickedElement && AutoFill.fillField(lastRightClickedElement)) {
          AutoFill.highlightField(lastRightClickedElement);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Could not fill field' });
        }
        return;
      default:
        return;
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  cleanups.add(() => chrome.runtime.onMessage.removeListener(onMessage));

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  chrome.storage.local.get([
    'isRecording', 'isPaused', 'captureClicks', 'captureInputs', 'captureNavigation', 'autoScreenshot',
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
    // Only tabs that are part of the recording capture anything; a tab that
    // got the script for the context menu must not start holding clicks.
    chrome.runtime.sendMessage({ action: 'isTabRecorded' }, (reply) => {
      if (chrome.runtime.lastError || disposed || !reply?.recorded) return;
      recording = true;
      paused = !!result.isPaused;
      initializeCapture();
    });
  });

  function initializeCapture() {
    if (settings.captureClicks) on(document, 'click', handleClick, true);
    if (settings.captureInputs) on(document, 'change', handleChange, true);
    if (settings.captureNavigation) {
      capturePageLoad();
      captureHistoryNavigation();
    }
    if (settings.enableAutoFill) setupAutoFill();
    watchForNewFrames();
    answerFramePositionQueries();

    const onStorageChanged = (changes) => {
      if (changes.isRecording && !changes.isRecording.newValue) cleanup();
      if (changes.isPaused) paused = !!changes.isPaused.newValue;
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    cleanups.add(() => chrome.storage.onChanged.removeListener(onStorageChanged));
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------
  // A click inside a frame has coordinates relative to that frame. To place
  // the marker on the whole-tab screenshot, the frame asks its parent where it
  // sits (window.postMessage works across origins); the parent finds the
  // <iframe> whose contentWindow sent the question, adds its own offset if it
  // is itself a frame, and answers. No answer within the timeout means the
  // click is recorded with a full-screen capture instead of a close-up.
  const FRAME_QUERY = '__docbot_frame_query__';
  const FRAME_REPLY = '__docbot_frame_reply__';
  const FRAME_QUERY_TIMEOUT_MS = 400;

  function answerFramePositionQueries() {
    on(window, 'message', (event) => {
      const d = event.data;
      if (!d || typeof d !== 'object' || d.type !== FRAME_QUERY) return;
      let host = null;
      for (const el of document.querySelectorAll('iframe, frame')) {
        if (el.contentWindow === event.source) { host = el; break; }
      }
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const local = { x: rect.left + host.clientLeft, y: rect.top + host.clientTop };
      const reply = (offset) => {
        try { event.source.postMessage({ type: FRAME_REPLY, nonce: d.nonce, offset }, '*'); } catch (_) { /* frame gone */ }
      };
      if (isTopFrame) reply(local);
      else resolveOwnOffset().then((mine) => reply(mine ? { x: local.x + mine.x, y: local.y + mine.y } : null));
    });
  }

  // Resolves to this frame's content-box position in the top-level viewport, or null.
  function resolveOwnOffset() {
    if (isTopFrame) return Promise.resolve({ x: 0, y: 0 });
    return new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2);
      let timer = null;
      const finish = (value) => {
        window.removeEventListener('message', onReply);
        clearTimeout(timer);
        resolve(value);
      };
      const onReply = (event) => {
        const d = event.data;
        if (event.source === window.parent && d && typeof d === 'object' && d.type === FRAME_REPLY && d.nonce === nonce) {
          finish(d.offset && typeof d.offset.x === 'number' ? d.offset : null);
        }
      };
      window.addEventListener('message', onReply);
      timer = setTimeout(() => finish(null), FRAME_QUERY_TIMEOUT_MS);
      try { window.parent.postMessage({ type: FRAME_QUERY, nonce }, '*'); } catch (_) { finish(null); }
    });
  }

  // Frames added after injection need the content script too; the background
  // worker injects into whichever frames don't answer a ping.
  function watchForNewFrames() {
    let timer = null;
    const observer = new MutationObserver((mutations) => {
      const added = mutations.some((m) => Array.from(m.addedNodes).some((node) =>
        node.nodeType === Node.ELEMENT_NODE && (node.matches('iframe, frame') || node.querySelector('iframe, frame'))
      ));
      if (!added) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (disposed || !chrome.runtime?.id) return;
        try { chrome.runtime.sendMessage({ action: 'framesChanged' }).catch(() => {}); } catch (_) { /* ignore */ }
      }, 300);
    });
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    cleanups.add(() => { observer.disconnect(); clearTimeout(timer); });
  }

  // -------------------------------------------------------------------------
  // Clicks: hold the click, take the "before" screenshot, then replay it.
  // -------------------------------------------------------------------------
  let cancelPendingSettle = null; // only the most recent click's settled state matters

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

    // While paused, and for javascript: links (which cannot be replayed under
    // a strict CSP), log the click and let it through untouched.
    const anchor = target.closest('a[href]');
    if (paused || (anchor && /^javascript:/i.test(anchor.getAttribute('href') || ''))) {
      sendAction('click', details, position);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (cancelPendingSettle) cancelPendingSettle();
    const beforeSnapshot = snapshotVisibleContent();

    const replay = () => {
      // Replay the click whether or not the screenshot succeeded, and even if
      // the recording stopped in the meantime; the user's click must land.
      // If the page re-rendered the element while we held the click, aim at
      // whatever is at the same spot now.
      const replayTarget = target.isConnected
        ? target
        : (document.elementFromPoint(event.clientX, event.clientY) || document.body);
      replayTarget.dispatchEvent(new MouseEvent('click', {
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
      cancelPendingSettle = waitForStabilization(beforeSnapshot, { delay: 600, maxWait: 2000 }, () => {
        sendAction('navigation', {
          url: window.location.href,
          title: document.title,
          type: 'post_click_state',
          trigger: details.text
        }, null, null, true);
      });
    };

    if (isTopFrame) {
      position.translated = true;
      sendAction('click', details, position, replay);
      return;
    }
    resolveOwnOffset().then((offset) => {
      if (offset) {
        position.x += offset.x;
        position.y += offset.y;
        position.translated = true;
        position.frameOffset = offset;
        sendAction('click', details, position, replay);
      } else {
        details.type = 'frame_click_fullscreen';
        sendAction('click', details, null, replay);
      }
    });
  }

  // Describe the clicked element by the nearest thing a person would call it:
  // a button, link, label or field. Large containers get no text, so nothing
  // on the page leaks into the log or the report captions by accident.
  function describeElement(el) {
    const control = el.closest('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], label, input, select, textarea, summary, [aria-label]') || el;
    return {
      tagName: el.tagName,
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className.substring(0, 100) : null,
      text: shortLabel(control),
      href: el.closest('a[href]')?.href || null,
      type: el.getAttribute('type') || null
    };
  }

  function shortLabel(el) {
    const explicit = el.getAttribute('aria-label') || el.getAttribute('title');
    if (explicit) return clip(explicit);
    if (el.tagName === 'INPUT') {
      if (['button', 'submit', 'reset'].includes(el.type)) return clip(el.value);
      return clip(inputLabel(el) || '');
    }
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return clip(inputLabel(el) || '');
    if (el.tagName === 'IMG') return clip(el.alt || '');
    // textContent is cheap; skip innerText (forces layout) on anything large.
    const raw = el.textContent || '';
    if (raw.length > MAX_LABEL_LENGTH * 4) return '';
    const text = (el.innerText || raw).trim().replace(/\s+/g, ' ');
    return text.length <= MAX_LABEL_LENGTH ? text : '';
  }

  function clip(text) {
    const t = (text || '').trim().replace(/\s+/g, ' ');
    return t.length <= MAX_LABEL_LENGTH ? t : t.substring(0, MAX_LABEL_LENGTH - 3) + '...';
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
          type: isTopFrame ? 'page_load' : 'frame_load',
          frame: isTopFrame ? undefined : { width: window.innerWidth, height: window.innerHeight }
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

  // pushState/replaceState cannot be observed from here (content scripts run in
  // an isolated world with their own History object); the background worker
  // watches webNavigation.onHistoryStateUpdated and asks for a capture instead.
  function captureHistoryNavigation() {
    const logHistory = (type) => sendAction('navigation', { url: window.location.href, title: document.title, type });
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
  // has passed) and, unless `force`, only if the visible content differs from
  // `before`. Returns a function that cancels the wait.
  function waitForStabilization(before, { delay, maxWait, minWait = 0, force = false }, callback) {
    const startedAt = Date.now();
    let debounce = null;
    let maxTimer = null;
    let finished = false;

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(isMeaningfulMutation)) armDebounce();
    });

    const stop = () => {
      finished = true;
      observer.disconnect();
      clearTimeout(debounce);
      clearTimeout(maxTimer);
      cleanups.delete(stop);
    };

    const finish = () => {
      if (finished) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed < minWait) {
        setTimeout(finish, minWait - elapsed);
        return;
      }
      stop();
      if (disposed) return;
      if (force || snapshotVisibleContent() !== before) callback();
    };

    const armDebounce = () => {
      clearTimeout(debounce);
      debounce = setTimeout(finish, delay);
    };

    maxTimer = setTimeout(finish, maxWait);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-expanded']
    });
    cleanups.add(stop);
    armDebounce();
    return stop;
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
    cleanups.add(() => { observer.disconnect(); clearTimeout(autoFillTimer); });
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
        data: { type, details, elementPosition, captureScreenshot, sentAt: Date.now() }
      }, () => {
        void chrome.runtime.lastError; // extension reloaded or worker gone; nothing to do
        finish();
      });
    } catch (_) {
      finish();
    }
  }
})();
