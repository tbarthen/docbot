// End-to-end test: loads the unpacked extension into Chromium, records a
// click-through of the local test site, and checks the recording, the report,
// the saved HTML file, pause, markers, and the edge cases from AUDIT-2.md.
//
//   npm test            (needs `npm install` once; Playwright downloads Chromium)
//
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out');
const SITE = 'http://127.0.0.1:8765';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${message}`);
  if (!condition) failures++;
}

const server = await startSite(8765);
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 1.25,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

const swState = () => sw.evaluate(() => ({
  isRecording, isPaused,
  actions: recordingData ? recordingData.actions.map((a) => ({ type: a.type, sub: a.details.type || null, text: a.details.text ?? null, sentAt: a.sentAt, err: a.screenshotError || null })) : [],
  shots: recordingData ? recordingData.screenshots.map((s) => ({ crop: s.isCropped, caption: s.caption, url: s.url, timestamp: s.timestamp })) : [],
  skipped: recordingData ? recordingData.skippedScreenshots : 0
}));
const reportTabs = () => ctx.pages().filter((p) => p.url().includes('report.html'));

// ---------------------------------------------------------------------------
console.log('\n1. Basic click-through');
const page = await ctx.newPage();
await page.goto(`${SITE}/`);
await page.bringToFront();
const start = await sw.evaluate(() => startRecording({}));
check(start.success, 'recording starts on an http page');
await sleep(1500);

await page.click('#toggle');                                    // in-page change
await sleep(1800);
await page.click('#bigtext');                                   // large container: no text in log
await sleep(800);
await page.click('#start'); await page.waitForURL('**/form');   // full page load
await sleep(1500);
await page.click('#fn'); await page.keyboard.type('Jane');
await page.click('#em'); await page.keyboard.type('jane@example.com');
await page.selectOption('#st', 'NY');
await sleep(800);
await page.click('#submit'); await page.waitForURL('**/done**');
await sleep(1500);

let s = await swState();
const clickTexts = s.actions.filter((a) => a.type === 'click').map((a) => a.text);
check(clickTexts.includes('Show details') && clickTexts.includes('Start enrollment'), 'buttons and links are labelled by their text');
check(clickTexts.includes('First name'), 'clicking an input is labelled by its <label>');
check(clickTexts.includes(''), 'clicking a large container records no text (M2)');
check(!s.actions.some((a) => (a.text || '').includes('4485')), 'account number from the container never reaches the log (M2)');
check(s.shots.filter((x) => !x.crop).length === 4, `one full capture per screen so far (got ${s.shots.filter((x) => !x.crop).length}, expected 4)`);
check(s.actions.filter((a) => a.type === 'input').length === 2, 'one input action per field, not per keystroke');
check(s.shots.some((x) => x.caption === 'Page: Enrollment form'), 'page captions use the document title (L2)');

// ---------------------------------------------------------------------------
console.log('\n2. pushState routing is seen from the background (M1)');
await page.goto(`${SITE}/spa`); await sleep(1500);
await page.click('#step2'); await sleep(2200);
await page.click('#filter'); await sleep(1200);
s = await swState();
const history = s.actions.filter((a) => a.sub === 'history');
check(history.length === 2, `history navigations logged (got ${history.length}, expected 2)`);
check(s.shots.some((x) => !x.crop && x.url.endsWith('/spa/step2')), 'a full capture exists for the new route');
check(!s.shots.some((x) => !x.crop && x.url.includes('filter=on')), 'a query-only change does not add a screenshot');

// ---------------------------------------------------------------------------
console.log('\n3. Held click still lands when the element re-renders (H3)');
await page.goto(`${SITE}/rerender`); await sleep(1500);
await page.click('#rb'); await sleep(600);
const clicks = await page.evaluate(() => window.__clicks);
check(clicks === 1, `re-rendered button received the replayed click (clicks=${clicks})`);

// ---------------------------------------------------------------------------
console.log('\n4. Fast clicking: no stale close-ups (H2)');
await page.goto(`${SITE}/`); await sleep(1500);
const before = (await swState()).shots.length;
// Raw mouse events, no per-click waiting: six clicks in well under a second,
// faster than Chrome allows screenshots to be taken.
const box = await page.locator('#toggle').boundingBox();
for (let i = 0; i < 6; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(40); }
await sleep(4500);
s = await swState();
const cropActions = s.actions.filter((a) => a.type === 'click');
const crops = s.shots.filter((x) => x.crop);
// Every crop that was taken must have been taken within the click hold window.
const late = crops.filter((c) => {
  const action = cropActions.slice().reverse().find((a) => a.sentAt <= c.timestamp);
  return action && c.timestamp - action.sentAt > 1500 + 800;
});
check(late.length === 0, `no close-up taken long after its click (${late.length} late)`);
check(s.skipped > 0, `stale close-ups were skipped and counted (skipped=${s.skipped})`);
console.log(`     ${s.shots.length - before} screenshots for 6 rapid clicks`);

// ---------------------------------------------------------------------------
console.log('\n5. Pause and markers');
await sw.evaluate(() => setPaused(true));
await sleep(300);
const pausedBefore = (await swState()).shots.length;
const t0 = Date.now(); await page.click('#start'); const held = Date.now() - t0;
await page.waitForURL('**/form'); await sleep(1500);
check((await swState()).shots.length === pausedBefore, 'no screenshots while paused');
check(held < 300, `clicks are not held while paused (${held} ms)`);
check((await sw.evaluate(() => chrome.action.getBadgeText({}))) === 'II', 'badge shows II while paused');
await sw.evaluate(() => setPaused(false));
await sleep(300);
await page.click('#fn'); await sleep(1200);
check((await swState()).shots.length === pausedBefore + 1, 'capture resumes after unpausing');

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`); await sleep(600);
await popup.screenshot({ path: path.join(OUT, 'popup-recording.png') });
await popup.close();
await page.bringToFront();

// ---------------------------------------------------------------------------
console.log('\n6. Stop, report, save as HTML');
const stop = await sw.evaluate(() => stopRecording());
check(stop.success, 'stop succeeds');
await sleep(1500);
const report = reportTabs()[0];
check(!!report, 'report tab opened on stop');
await report.waitForSelector('.step img[src]');
await sleep(800);
const info = await report.evaluate(async () => {
  const imgs = [...document.querySelectorAll('.step img')];
  const sizes = [];
  for (const shot of session.screenshots) sizes.push((await DocBotDB.getScreenshot(shot.id)).blob.size);
  return { steps: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length, total: sizes.reduce((a, b) => a + b, 0), note: document.querySelector('.report-header .note')?.textContent || '' };
});
check(info.steps === stop.session.screenshotCount, `report shows every screenshot (${info.steps})`);
check(info.loaded === info.steps, 'all report images load');
check(info.note.includes('skipped'), 'report header explains skipped screenshots (L3)');
console.log(`     ${info.steps} images, ${(info.total / 1024).toFixed(0)} KB total`);
await report.screenshot({ path: path.join(OUT, 'report.png'), fullPage: true });

// H1: remove one screenshot row, reload, and make sure the saved file still pairs images correctly.
const victim = stop.session.screenshotCount > 3 ? 2 : 0;
await report.evaluate((i) => DocBotDB.deleteScreenshot(session.screenshots[i].id), victim);
await report.reload();
await report.waitForSelector('.step img[src]');
await sleep(800);
const [download] = await Promise.all([report.waitForEvent('download'), report.click('#saveBtn')]);
const savedPath = path.join(OUT, download.suggestedFilename());
await download.saveAs(savedPath);
const saved = fs.readFileSync(savedPath, 'utf8');
const pairs = [...saved.matchAll(/data-shot-id="([^"]+)"[^>]*src="data:image\/jpeg;base64,([^"]+)"/g)].map((m) => ({ id: m[1], bytes: Buffer.from(m[2], 'base64').length }));
const expected = await report.evaluate(async (ids) => {
  const out = {};
  for (const id of ids) out[id] = (await DocBotDB.getScreenshot(id))?.blob?.size ?? null;
  return out;
}, pairs.map((p) => p.id));
check(pairs.length === stop.session.screenshotCount - 1, `saved file has one image per remaining screenshot (${pairs.length})`);
check(pairs.every((p) => expected[p.id] === p.bytes), 'every saved image matches its own screenshot by id (H1)');
console.log(`     saved ${download.suggestedFilename()} ${(fs.statSync(savedPath).size / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------------------
console.log('\n7. Closing the recorded tab ends the recording');
const p2 = await ctx.newPage(); await p2.goto(`${SITE}/form`); await p2.bringToFront();
await sw.evaluate(() => startRecording({}));
await sleep(1500);
const tabsBefore = reportTabs().length;
await p2.close(); await sleep(1500);
check((await swState()).isRecording === false, 'recording stopped');
check(reportTabs().length === tabsBefore + 1, 'report opened');

// ---------------------------------------------------------------------------
console.log('\n8. Double start is rejected (M3)');
const p3 = await ctx.newPage(); await p3.goto(`${SITE}/`); await p3.bringToFront();
const [a, b] = await sw.evaluate(() => Promise.all([startRecording({}), startRecording({})]));
check(a.success !== b.success, 'exactly one of two simultaneous starts succeeds');
await sw.evaluate(() => stopRecording({ openReport: false }));
await p3.close();

// ---------------------------------------------------------------------------
console.log('\n9. Browser restart with a dead tab finalizes the recording (H4)');
const tabsBefore2 = reportTabs().length;
await sw.evaluate(async () => {
  await chrome.storage.local.set({ isRecording: true, recordingTabId: 987654321, recordingData: { sessionId: 'docbot_restart_test', startTime: Date.now() - 5000, url: 'http://example.test/', title: 'Ghost tab', settings: {}, actions: [], screenshots: [] } });
  await restoreState();
});
const after = await sw.evaluate(async () => ({ isRecording, session: await DocBotDB.getSession('docbot_restart_test') }));
check(after.isRecording === false, 'no longer recording');
check(after.session?.stopReason === 'tab_missing', 'partial recording kept with reason tab_missing');
check(reportTabs().length === tabsBefore2, 'no report tab opened at startup');

// ---------------------------------------------------------------------------
console.log('\n10. Markers can be turned off');
await sw.evaluate(() => chrome.storage.local.set({ clickMarkers: false }));
const p4 = await ctx.newPage(); await p4.goto(`${SITE}/`); await p4.bringToFront();
await sw.evaluate(() => startRecording({})); await sleep(1500);
await p4.click('#toggle'); await sleep(1500);
const red = await sw.evaluate(async () => {
  const shot = recordingData.screenshots.find((x) => x.isCropped);
  const row = await DocBotDB.getScreenshot(shot.id);
  const bmp = await createImageBitmap(row.blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 80 && d[i + 2] < 80) n++;
  return n;
});
check(red === 0, `no red marker pixels when markers are off (${red})`);
await sw.evaluate(() => stopRecording({ openReport: false }));
await sw.evaluate(() => chrome.storage.local.set({ clickMarkers: true }));

await ctx.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
