// DocBot include banner. Injected into a web tab that the user switched to
// while a recording is running in other tabs. Offers to add this tab.

(function () {
  'use strict';
  if (document.getElementById('docbot-offer-host')) return;

  const host = document.createElement('div');
  host.id = 'docbot-offer-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .bar { font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #212529;
             background: #fff; border-bottom: 3px solid #667eea; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
             display: flex; align-items: center; gap: 12px; padding: 10px 16px; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #dc3545; flex-shrink: 0; }
      .text { flex: 1; }
      .text b { color: #667eea; }
      button { font: inherit; font-weight: 600; padding: 7px 14px; border-radius: 6px; cursor: pointer; border: 1px solid #667eea; background: #fff; color: #667eea; }
      button.primary { background: #667eea; color: #fff; }
      button:hover { filter: brightness(0.95); }
    </style>
    <div class="bar" role="region" aria-label="DocBot">
      <span class="dot"></span>
      <span class="text"><b>DocBot</b> is recording in another tab. Include this tab in the recording?</span>
      <button class="primary" id="include">Include this tab</button>
      <button id="dismiss">Not this tab</button>
    </div>`;

  const remove = () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    host.remove();
  };
  const onMessage = (message) => {
    if (message && message.action === 'offerClose') remove();
  };
  chrome.runtime.onMessage.addListener(onMessage);

  root.getElementById('include').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'includeTab' }).catch(() => {}).finally(remove);
  });
  root.getElementById('dismiss').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'dismissOffer' }).catch(() => {}).finally(remove);
  });

  (document.body || document.documentElement).appendChild(host);
})();
