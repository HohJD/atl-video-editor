// UI smoke test: drives the real frontend in headless Chrome.
// Captures console errors, exercises the main flows, and saves screenshots
// to /tmp/atl-ui-shots for visual review.
// Prereq: server running on :3000, test media in /tmp/atl-test.

import puppeteer from 'puppeteer';
import fs from 'fs/promises';

const BASE = 'http://localhost:3000';
const SHOTS = '/tmp/atl-ui-shots';
const problems = [];

await fs.mkdir(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--window-size=1500,950']
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });

page.on('console', msg => {
  if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
});
page.on('pageerror', err => problems.push(`pageerror: ${err.message}`));
page.on('requestfailed', req => {
  const err = req.failure()?.errorText || '';
  // ERR_ABORTED on media is normal: Chrome cancels ranged loads once it has
  // the metadata/frames it needs, and on navigation.
  if (err === 'net::ERR_ABORTED' && ['media', 'image'].includes(req.resourceType())) return;
  if (!req.url().includes('favicon')) problems.push(`requestfailed: ${req.url()} ${err}`);
});

const shot = async name => page.screenshot({ path: `${SHOTS}/${name}.png` });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Reset project for reproducible run
await fetch(`${BASE}/api/project/reset`, { method: 'POST' });

console.log('1. Load app (empty state)');
await page.goto(BASE, { waitUntil: 'networkidle2' });
await sleep(1200);
await shot('01-empty');

console.log('2. Upload media through the file input');
const input = await page.$('#fileInput');
await input.uploadFile('/tmp/atl-test/testclip.mp4', '/tmp/atl-test/music.m4a', '/tmp/atl-test/photo.jpg');
await sleep(1500);
await shot('02-analyzing');

console.log('3. Wait for analysis to finish');
await page.waitForFunction(
  () => [...document.querySelectorAll('.media-item')].length >= 3 && !document.querySelector('.media-item.analyzing'),
  { timeout: 120000, polling: 1000 }
);
await sleep(500);
await shot('03-analyzed');

console.log('4. Add video + audio to the timeline');
const addButtons = await page.$$('.media-item .add');
for (const b of addButtons) { await b.click(); await sleep(700); }
await shot('04-timeline-filled');

console.log('5. Select a clip, split at playhead, undo/redo');
await page.click('.tl-ruler', { offset: { x: 300, y: 12 } });
await sleep(300);
await page.click('.tl-clip.t-video');
await sleep(300);
await page.click('#splitBtn');
await sleep(500);
await shot('05-split');
await page.click('#undoBtn');
await sleep(400);
await page.click('#redoBtn');
await sleep(400);

console.log('6. Transport: play 2s then pause');
await page.click('#playBtn');
await sleep(2000);
await page.click('#playBtn');
await shot('06-playing');

console.log('7. Switch preset to vertical');
await page.select('#presetSelect', '1080x1920');
await sleep(600);
await shot('07-vertical');

console.log('8. Zoom the timeline');
await page.$eval('#zoomRange', el => { el.value = 140; el.dispatchEvent(new Event('input')); });
await sleep(400);
await shot('08-zoomed');

console.log('9. Agent panel (no key: expect friendly error, not crash)');
await page.type('#chatInput', 'make it cinematic');
await page.click('#chatSend');
await sleep(800);
await shot('09-agent-no-key');

console.log('10. Export (draft) and wait for completion');
await page.select('#exportQuality', 'draft');
await page.click('#exportBtn');
await page.waitForFunction(
  () => {
    const done = document.querySelector('#exportDone');
    const overlay = document.querySelector('#exportOverlay');
    return (done && !done.classList.contains('hidden')) || overlay.classList.contains('hidden');
  },
  { timeout: 300000, polling: 1000 }
);
await shot('10-export-done');
const exportVisible = await page.$eval('#exportDone', el => !el.classList.contains('hidden'));
if (!exportVisible) problems.push('export did not reach done state');
await page.click('#closeExport').catch(() => {});

console.log('11. Reload — state should persist');
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1500);
const clipCount = await page.$$eval('.tl-clip', els => els.length);
if (clipCount < 2) problems.push(`state lost after reload: only ${clipCount} clips`);
await shot('11-after-reload');

await browser.close();

console.log('\n================ RESULT ================');
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`);
  for (const p of [...new Set(problems)]) console.log('  -', p);
  process.exit(1);
} else {
  console.log('CLEAN — no console errors, all flows completed');
}
