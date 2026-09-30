// A small local web app used by the end-to-end test. Exercises the things
// DocBot has to handle: full page loads, a form post, an in-page panel toggle,
// pushState routing, and an element that re-renders itself while clicked.
import http from 'node:http';

const shell = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:Arial;margin:0;background:#fff}
  header{background:#004b87;color:#fff;padding:14px 24px;font-size:20px}
  main{padding:24px;max-width:1100px}
  input,select{padding:8px;border:1px solid #999;border-radius:4px}
  button,a.btn{display:inline-block;padding:10px 20px;background:#0a6;color:#fff;border:0;border-radius:4px;text-decoration:none;cursor:pointer;font-size:14px}
  .row{display:flex;gap:16px;align-items:center;margin:12px 0}label{width:200px}
  .panel{display:none;background:#eef;padding:20px;margin-top:20px}.panel.open{display:block}
  .bigtext{background:#f6f6f6;padding:20px;margin-top:20px;line-height:1.5}
</style></head>
<body><header>${title}</header><main>${body}</main><script>${script}</script></body></html>`;

const routes = {
  '/': shell('Home page', `
    <p>Welcome. Start the enrollment below.</p>
    <p><a class="btn" id="start" href="/form">Start enrollment</a></p>
    <button id="toggle" onclick="document.getElementById('p').classList.toggle('open')">Show details</button>
    <div class="panel" id="p"><h3>Details panel</h3><p>${'Detail text. '.repeat(30)}</p></div>
    <div class="bigtext" id="bigtext">Customer record: Jane Q. Example, account 4485-1122-9087. ${'Filler text that should never appear in a caption. '.repeat(8)}</div>
    <p><a class="btn" id="spa" href="/spa">Single-page section</a> <a class="btn" id="rerender" href="/rerender">Re-render test</a>
       <a class="btn" id="newtab" href="/done" target="_blank" rel="opener">Open in new tab</a></p>`),

  '/form': shell('Enrollment form', `<form method="get" action="/done">
    <div class="row"><label for="fn">First name</label><input id="fn" name="fn"></div>
    <div class="row"><label for="em">Email address</label><input id="em" name="em" type="email"></div>
    <div class="row"><label for="st">State</label><select id="st" name="st"><option value="">Choose</option><option>CA</option><option>NY</option></select></div>
    <div class="row"><label></label><button id="submit" type="submit">Continue</button></div></form>`),

  '/done': shell('Enrollment complete', `<p>Thank you. Your enrollment is complete.</p><p><a class="btn" href="/">Back to home</a></p>`),

  '/spa': shell('Single-page app', `<div id="view"><h2>Step 1</h2><p>Pick a step.</p></div>
    <button id="step2">Go to step 2</button> <button id="filter">Apply filter (query only)</button>`,
    `document.getElementById('step2').addEventListener('click', () => {
       document.getElementById('view').innerHTML = '<h2>Step 2</h2><p>' + 'Step two content. '.repeat(20) + '</p>';
       history.pushState({}, '', '/spa/step2');
     });
     document.getElementById('filter').addEventListener('click', () => {
       history.pushState({}, '', location.pathname + '?filter=on');
     });`),

  // Frames: a cross-origin frame (localhost vs 127.0.0.1), a nested frame, a
  // sandboxed frame that cannot run scripts, and a button that adds a frame.
  '/frames': shell('Portal with frames', `
    <button id="topbtn">Top-level button</button>
    <div style="display:flex;gap:30px;margin-top:20px;align-items:flex-start">
      <iframe id="f1" src="http://localhost:8765/form" style="width:800px;height:420px;border:6px solid #999"></iframe>
      <iframe id="sandboxed" sandbox srcdoc="<p style='font-family:Arial'>Sandboxed frame, no scripts allowed.</p>" style="width:220px;height:120px;border:1px solid #ccc"></iframe>
    </div>
    <iframe id="f2" src="/nested" style="width:700px;height:360px;border:2px solid #c66;margin-top:20px"></iframe>
    <p><button id="addframe">Add a frame</button></p>
    <div id="dyn"></div>`,
    `document.getElementById('addframe').addEventListener('click', () => {
       const f = document.createElement('iframe'); f.id = 'f3'; f.src = '/form'; f.style.cssText = 'width:600px;height:300px;border:2px solid #6a6';
       document.getElementById('dyn').appendChild(f);
     });`),

  '/nested': shell('Nested holder', `<p style="margin:0 0 10px">This page holds another frame.</p>
    <iframe id="inner" src="/form" style="width:560px;height:220px;border:3px solid #66c;margin-left:40px"></iframe>`),

  '/rerender': shell('Re-render test', `<div id="wrap"><button id="rb">Re-render me</button></div><p id="count">Clicks: 0</p>`,
    `window.__clicks = 0;
     // The button replaces itself shortly after it receives focus (which happens on
     // mousedown), so by the time a held click is replayed the original node is gone.
     function arm(btn) {
       btn.addEventListener('focus', () => setTimeout(() => {
         const fresh = document.createElement('button'); fresh.id = 'rb'; fresh.textContent = 'Re-render me';
         btn.replaceWith(fresh); arm(fresh);
       }, 30));
     }
     arm(document.getElementById('rb'));
     document.addEventListener('click', (e) => {
       if (e.target.id === 'rb') { window.__clicks++; document.getElementById('count').textContent = 'Clicks: ' + window.__clicks; }
     });`)
};

export function startSite(port = 8765) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const html = routes[path] || (path.startsWith('/spa/') ? routes['/spa'] : null);
    if (!html) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  // No host: listen on IPv4 and IPv6 so both 127.0.0.1 and localhost work (they are different origins).
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && process.argv[1].endsWith('site.mjs')) {
  startSite().then(() => console.log('test site on http://127.0.0.1:8765'));
}
