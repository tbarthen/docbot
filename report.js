// DocBot report page: renders one recorded session and exports it.

let session = null;
const objectUrls = [];

// Which embellishments to show around the screenshots. "plain" hides all of
// them; the individual flags then add items back. Remembered across reports.
const LAYOUT_ITEMS = ['numbers', 'captions', 'urls', 'dividers', 'header'];
let layout = { plain: false, numbers: false, captions: false, urls: false, dividers: false, header: false };

async function loadLayout() {
  try {
    const { reportLayout } = await chrome.storage.local.get('reportLayout');
    if (reportLayout && typeof reportLayout === 'object') layout = { ...layout, ...reportLayout };
  } catch (_) { /* defaults */ }
}

function applyLayout() {
  const page = document.getElementById('page');
  page.classList.toggle('plain', layout.plain);
  for (const item of LAYOUT_ITEMS) {
    page.classList.toggle(`no-${item}`, layout.plain && !layout[item]);
  }
  document.getElementById('optPlain').checked = layout.plain;
  document.getElementById('plainSub').classList.toggle('disabled', !layout.plain);
  for (const item of LAYOUT_ITEMS) {
    document.getElementById(`opt${item[0].toUpperCase()}${item.slice(1)}`).checked = layout[item];
  }
}

function wireLayoutMenu() {
  const save = () => chrome.storage.local.set({ reportLayout: layout }).catch(() => {});
  document.getElementById('optPlain').addEventListener('change', (e) => {
    layout.plain = e.target.checked;
    applyLayout();
    save();
  });
  for (const item of LAYOUT_ITEMS) {
    document.getElementById(`opt${item[0].toUpperCase()}${item.slice(1)}`).addEventListener('change', (e) => {
      layout[item] = e.target.checked;
      applyLayout();
      save();
    });
  }
  // Close the menu when clicking elsewhere.
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('layoutMenu');
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadLayout();
  wireLayoutMenu();
  applyLayout();
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('saveBtn').addEventListener('click', saveAsHtml);
  document.getElementById('sessionSelect').addEventListener('change', (e) => {
    const url = new URL(location.href);
    url.searchParams.set('session', e.target.value);
    location.href = url.toString();
  });

  try {
    const sessions = await DocBotDB.listSessions();
    const requested = new URLSearchParams(location.search).get('session');
    session = sessions.find((s) => s.sessionId === requested) || sessions[0] || null;
    renderSessionSelect(sessions);
    if (!session) {
      showEmpty('No recordings yet. Start a recording from the DocBot toolbar button, click through the site, then stop.');
      return;
    }
    await renderSession(session);
  } catch (error) {
    console.error(error);
    showEmpty(`Could not load the recording: ${error.message}`);
  }
});

function showEmpty(message) {
  const page = document.getElementById('page');
  page.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: message }));
  document.getElementById('saveBtn').disabled = true;
}

function renderSessionSelect(sessions) {
  const select = document.getElementById('sessionSelect');
  select.replaceChildren(...sessions.map((s) => {
    const option = document.createElement('option');
    option.value = s.sessionId;
    option.textContent = `${new Date(s.startTime).toLocaleString()} – ${s.title || s.url}`;
    option.selected = session && s.sessionId === session.sessionId;
    return option;
  }));
  select.hidden = sessions.length < 2;
}

async function renderSession(s) {
  document.title = `DocBot report – ${s.title || s.url}`;
  const page = document.getElementById('page');
  page.replaceChildren(buildHeader(s));

  const shots = s.screenshots || [];
  if (shots.length === 0) {
    page.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'This recording has no screenshots.' }));
    return;
  }

  // Tab changes are shown as dividers between the screenshots, in time order.
  const dividers = (s.actions || []).filter((a) => a.type === 'tab' && a.details?.type !== 'tab_closed');
  const items = [...shots.map((shot) => ({ kind: 'shot', at: shot.timestamp, shot })), ...dividers.map((a) => ({ kind: 'tab', at: a.timestamp, action: a }))]
    .sort((a, b) => a.at - b.at);

  let number = 0;
  for (const item of items) {
    if (item.kind === 'tab') {
      page.append(buildDivider(item.action));
      continue;
    }
    const shot = item.shot;
    const step = buildStep(++number, shot);
    page.append(step);
    const img = step.querySelector('img');
    try {
      const row = await DocBotDB.getScreenshot(shot.id);
      if (row?.blob) {
        const url = URL.createObjectURL(row.blob);
        objectUrls.push(url);
        img.src = url;
      } else if (row?.dataUrl) {
        img.src = row.dataUrl; // recordings made by DocBot 1.x
      } else {
        img.alt = 'Screenshot not found';
        img.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Screenshot not found' }));
      }
    } catch (error) {
      img.replaceWith(Object.assign(document.createElement('div'), { className: 'empty', textContent: `Could not load screenshot: ${error.message}` }));
    }
  }
}

function buildHeader(s) {
  const header = document.createElement('div');
  header.className = 'report-header';
  const h1 = document.createElement('h1');
  h1.textContent = s.title || s.url || 'Recording';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const duration = s.endTime && s.startTime ? Math.round((s.endTime - s.startTime) / 1000) : 0;
  const link = document.createElement('a');
  link.href = s.url || '#';
  link.textContent = s.url || '';
  const tabs = (s.tabs || []).length;
  meta.append(
    `${new Date(s.startTime).toLocaleString()} · ${formatDuration(duration)} · ${(s.screenshots || []).length} screens · ${(s.actions || []).length} actions${tabs > 1 ? ` \u00b7 ${tabs} tabs` : ''}`,
    document.createElement('br'),
    link
  );
  header.append(h1, meta);
  if (s.skippedScreenshots > 0) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = `${s.skippedScreenshots} screenshot${s.skippedScreenshots === 1 ? ' was' : 's were'} skipped: the recorded tab was not visible, or clicks came faster than screenshots can be taken.`;
    header.append(note);
  }
  if (s.stopReason === 'tab_missing') {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'This recording ended because the browser was restarted while it was running.';
    header.append(note);
  }
  return header;
}

function buildDivider(action) {
  const d = action.details || {};
  const div = document.createElement('div');
  div.className = 'divider';
  const label = d.type === 'tab_included'
    ? (d.reason === 'opened' ? 'Opened in a new tab' : 'Added tab')
    : 'Switched to tab';
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  const title = document.createElement('span');
  title.textContent = d.title || d.url || '';
  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = d.url ? shortUrl(d.url) : '';
  div.append(strong, title, url);
  return div;
}

function buildStep(number, shot) {
  const step = document.createElement('div');
  step.className = 'step' + (shot.isCropped ? ' crop' : '');
  const caption = document.createElement('div');
  caption.className = 'caption';
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(number);
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = shot.caption || (shot.isCropped ? 'Click' : 'Screen');
  if (shot.isCropped && !shot.marker) {
    text.textContent += shot.markerSkipped ? ' (marker off)' : ' (marker missing)';
  }
  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = shot.url ? shortUrl(shot.url) : '';
  url.title = shot.url || '';
  caption.append(num, text, url);
  const img = document.createElement('img');
  img.alt = shot.caption || `Screenshot ${number}`;
  img.dataset.shotId = shot.id;
  img.title = 'Click to view at full size';
  img.addEventListener('click', () => openLightbox(img));
  step.append(caption, img);
  return step;
}

// Show one screenshot at its real size; click anywhere or press Escape to close.
function openLightbox(img) {
  if (!img.src) return;
  const box = document.createElement('div');
  box.className = 'lightbox';
  const full = document.createElement('img');
  full.src = img.src;
  full.alt = img.alt;
  box.append(full);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(box);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

// ---------------------------------------------------------------------------
// Save as a single self-contained HTML file
// ---------------------------------------------------------------------------
async function saveAsHtml() {
  if (!session) return;
  const button = document.getElementById('saveBtn');
  button.disabled = true;
  button.textContent = 'Preparing...';
  try {
    const clone = document.getElementById('page').cloneNode(true);
    // Leave out whatever the layout options hide, so the file is clean.
    if (layout.plain) {
      const gone = [];
      if (!layout.numbers) gone.push('.num');
      if (!layout.captions) gone.push('.caption .text');
      if (!layout.urls) gone.push('.caption .url');
      if (!layout.dividers) gone.push('.divider');
      if (!layout.header) gone.push('.report-header');
      if (!layout.numbers && !layout.captions && !layout.urls) gone.push('.caption');
      for (const el of clone.querySelectorAll(gone.join(', '))) el.remove();
    }
    // Match each image to its screenshot by id, never by position: a missing
    // screenshot is rendered as a placeholder and would shift the indices.
    for (const img of clone.querySelectorAll('img[data-shot-id]')) {
      const row = await DocBotDB.getScreenshot(img.dataset.shotId);
      if (row?.blob) img.src = await blobToDataUrl(row.blob);
      else if (row?.dataUrl) img.src = row.dataUrl;
      else img.remove();
    }
    const styles = document.getElementById('reportStyles').textContent;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.title)}</title>
<style>${styles}</style>
</head>
<body>
${clone.outerHTML}
</body>
</html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(session);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    button.textContent = `Saved (${formatBytes(blob.size)})`;
    setTimeout(() => { button.textContent = 'Save as HTML'; button.disabled = false; }, 2500);
  } catch (error) {
    console.error(error);
    button.textContent = 'Save failed';
    setTimeout(() => { button.textContent = 'Save as HTML'; button.disabled = false; }, 2500);
  }
}

function fileName(s) {
  const date = new Date(s.startTime);
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = (s.title || 'recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'recording';
  return `docbot_${slug}_${stamp}.html`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
