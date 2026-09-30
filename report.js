// DocBot report page: renders one recorded session and exports it.

let session = null;
const objectUrls = [];

document.addEventListener('DOMContentLoaded', async () => {
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

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const step = buildStep(i + 1, shot);
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
  meta.append(
    `${new Date(s.startTime).toLocaleString()} · ${formatDuration(duration)} · ${(s.screenshots || []).length} screens · ${(s.actions || []).length} actions`,
    document.createElement('br'),
    link
  );
  header.append(h1, meta);
  return header;
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
  text.textContent = shot.caption || (shot.isCropped ? 'Click' : 'Screen');
  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = shot.url ? shortUrl(shot.url) : '';
  url.title = shot.url || '';
  caption.append(num, text, url);
  const img = document.createElement('img');
  img.alt = shot.caption || `Screenshot ${number}`;
  step.append(caption, img);
  return step;
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
    const images = clone.querySelectorAll('img');
    const shots = session.screenshots || [];
    for (let i = 0; i < images.length; i++) {
      const shot = shots[i];
      const row = shot ? await DocBotDB.getScreenshot(shot.id) : null;
      if (row?.blob) images[i].src = await blobToDataUrl(row.blob);
      else if (row?.dataUrl) images[i].src = row.dataUrl;
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
