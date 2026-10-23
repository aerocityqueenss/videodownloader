/**
 * test-popup.mjs — loads the real popup.html in headless Chrome with a mocked
 * `chrome` extension API and asserts on the rendered DOM.
 *
 * This is the closest thing to loading the extension without a full Chrome
 * profile: same HTML, same CSS, same popup.js, real layout engine.
 *
 * Run:  node _dev/test-popup.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PLAYWRIGHT = 'C:/Users/Sapna/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.js';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// playwright-core is CommonJS; load it through require so we get the real
// module object rather than an empty named-import namespace.
const require = createRequire(import.meta.url);
const { chromium } = require(PLAYWRIGHT);

const popupUrl = pathToFileURL(resolve(new URL('../popup.html', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))).href;

/* --------------------------------------------------------------------------
 * Mock data the fake chrome API will serve
 * ------------------------------------------------------------------------ */
const ENTRIES = [
  {
    url: 'https://cdn.video.test/hls/master.m3u8',
    ext: 'm3u8',
    kind: 'hls',
    size: -1,
    sizeText: '',
    fileName: 'master.m3u8',
    host: 'cdn.video.test',
    title: 'Big Buck Bunny — Adaptive',
    source: 'network',
    segments: 42,
    lastSeen: Date.now()
  },
  {
    url: 'https://cdn.video.test/files/trailer.mp4',
    ext: 'mp4',
    kind: 'video',
    size: 15728640,
    sizeText: '15.0 MB',
    fileName: 'trailer.mp4',
    host: 'cdn.video.test',
    title: 'trailer.mp4',
    source: 'media',
    segments: 0,
    lastSeen: Date.now()
  },
  {
    url: 'https://other.test/clip.webm',
    ext: 'webm',
    kind: 'video',
    size: -1,
    sizeText: '',
    fileName: 'clip.webm',
    host: 'other.test',
    title: 'clip.webm',
    source: 'dom',
    segments: 0,
    lastSeen: Date.now()
  }
];

/** Scenario switches, set per test before navigation. */
let scenario = { entries: ENTRIES, tabUrl: 'https://example.test/watch', failDownload: false };

/**
 * Injected before any page script runs.
 *
 * NOTE: this is installed via a SINGLE addInitScript call that also defines
 * window.__scenario. Two separate addInitScript calls do not share ordering
 * guarantees, and the mock must read the scenario at call time (not at
 * injection time), so the config is baked into this same source string.
 */
function mockChrome(cfg) {
  window.__scenario = cfg;
  const state = cfg;
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        const reply = (value) => setTimeout(() => callback(value), 0);

        if (message.type === 'MP_GET_MEDIA') {
          reply({ ok: true, tabId: 1, entries: state.entries, total: state.entries.length, updated: Date.now() });
        } else if (message.type === 'MP_DOWNLOAD') {
          if (state.failDownload) reply({ ok: false, error: 'Server refused the download.' });
          else reply({ ok: true, downloadId: 1, filename: 'saved.mp4' });
        } else if (message.type === 'MP_CLEAR') {
          reply({ ok: true });
        } else {
          reply(undefined);
        }
      },
      onMessage: { addListener() {} },
      getURL: (p) => `chrome-extension://mock/${p}`
    },
    tabs: {
      query(_query, callback) {
        callback([{ id: 1, url: state.tabUrl, active: true, currentWindow: true }]);
      },
      sendMessage(_id, _msg) {
        return Promise.resolve({ ok: true });
      }
    },
    scripting: { executeScript() { return Promise.resolve([]); } }
  };
}

/* --------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------ */
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

/**
 * Open the popup in a FRESH page for each scenario.
 *
 * A fresh page matters: Playwright accumulates addInitScript calls for the
 * lifetime of a page, so reusing one page would stack mocks and the last one
 * would silently win. A new page keeps every scenario hermetic.
 */
let page = null;
const pageErrors = [];

async function openPopup(nextScenario = {}) {
  scenario = { entries: ENTRIES, failDownload: false, tabUrl: 'https://example.test/watch', ...nextScenario };

  if (page) await page.close();
  pageErrors.length = 0;

  page = await browser.newPage({ viewport: { width: 400, height: 580 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.addInitScript(mockChrome, scenario);
  await page.goto(popupUrl);
  await page.waitForTimeout(250);

  return [...pageErrors];
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}

console.log('\nMediaPulse popup tests\n');

/* --- populated state ---------------------------------------------------- */

const bootErrors = await openPopup();

await test('popup loads with no JavaScript errors', () => {
  assert.deepEqual(bootErrors, [], `page errors: ${bootErrors.join('; ')}`);
});

await test('renders one card per media entry', async () => {
  const cards = await page.locator('.card').count();
  assert.equal(cards, 3);
});

await test('empty state is hidden when media exists', async () => {
  const hidden = await page.locator('#emptyState').isHidden();
  assert.equal(hidden, true);
});

await test('shows format badge, title, host and size', async () => {
  const first = page.locator('.card').first();
  assert.equal((await first.locator('.badge').textContent()).trim(), 'M3U8');
  assert.match(await first.locator('.meta-title').textContent(), /Big Buck Bunny/);

  const sub = await first.locator('.meta-sub').textContent();
  assert.match(sub, /cdn\.video\.test/);
  assert.match(sub, /42 fragments/, 'HLS entry should report fragment count when size is unknown');

  const second = page.locator('.card').nth(1);
  assert.equal((await second.locator('.badge').textContent()).trim(), 'MP4');
  assert.match(await second.locator('.meta-sub').textContent(), /15\.0 MB/);
});

await test('HLS badge is visually distinct from progressive video', async () => {
  const hlsColor = await page.locator('.card').first().locator('.badge').evaluate((el) => getComputedStyle(el).backgroundColor);
  const vidColor = await page.locator('.card').nth(1).locator('.badge').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(hlsColor, vidColor, 'HLS and MP4 badges should use different colours');
});

await test('every card has a Download button', async () => {
  const buttons = page.locator('.card .download');
  assert.equal(await buttons.count(), 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await buttons.nth(i).textContent()).trim(), 'Download');
  }
});

await test('count label summarises the list', async () => {
  const text = await page.locator('#countLabel').textContent();
  assert.match(text, /3/);
  assert.match(text, /1 HLS stream/);
});

await test('clear button is visible when media exists', async () => {
  assert.equal(await page.locator('#clearBtn').isVisible(), true);
});

await test('page host is shown in the header', async () => {
  assert.equal((await page.locator('#pageHost').textContent()).trim(), 'example.test');
});

/* --- interactions ------------------------------------------------------- */

await test('clicking Download calls the worker and shows Saved', async () => {
  const button = page.locator('.card').nth(1).locator('.download');
  await button.click();
  await page.waitForTimeout(150);

  assert.equal((await button.textContent()).trim(), 'Saved');
  assert.match(await page.locator('#toast').textContent(), /Downloading saved\.mp4/);

  // The list refreshes in the background shortly after load; the in-flight
  // state must survive that re-render instead of resetting to "Download".
  await page.waitForTimeout(700);
  const live = page.locator('.card').nth(1).locator('.download');
  assert.equal((await live.textContent()).trim(), 'Saved', 'button state was lost by a re-render');

  // ...and it must still return to idle on its own.
  await page.waitForTimeout(2200);
  assert.equal((await page.locator('.card').nth(1).locator('.download').textContent()).trim(), 'Download');
});

await test('a failed download shows Failed + an error toast', async () => {
  await openPopup({ failDownload: true });
  const button = page.locator('.card').nth(1).locator('.download');
  await button.click();
  await page.waitForTimeout(120);
  assert.equal((await button.textContent()).trim(), 'Failed');
  assert.match(await page.locator('#toast').textContent(), /Server refused/);
  assert.equal(await page.locator('#toast').evaluate((el) => el.classList.contains('is-error')), true);
});

await test('clear empties the list and shows the empty state', async () => {
  await openPopup({ failDownload: false });
  await page.locator('#clearBtn').click();
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.card').count(), 0);
  assert.equal(await page.locator('#emptyState').isVisible(), true);
});

/* --- empty state -------------------------------------------------------- */

await test('empty state explains what to do', async () => {
  await openPopup({ entries: [] });
  assert.equal(await page.locator('#emptyState').isVisible(), true);
  assert.equal(await page.locator('.card').count(), 0);

  const text = (await page.locator('#emptyState').textContent()).replace(/\s+/g, ' ');
  assert.match(text, /Start playing the video/);
  assert.match(text, /play the video, or refresh the page/, 'should hint at playing / refreshing');
  assert.equal((await page.locator('#countLabel').textContent()).trim(), 'No media found');
  assert.equal(await page.locator('#clearBtn').isHidden(), true);
});

/* --- restricted page ---------------------------------------------------- */

await test('chrome:// pages show the unavailable state, not an error', async () => {
  const errors = await openPopup({ entries: [], tabUrl: 'chrome://extensions/' });
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#errorState').isVisible(), true);
  assert.match(await page.locator('#errorTitle').textContent(), /cannot be inspected/i);
  assert.equal(await page.locator('.card').count(), 0);
});

/* --- layout ------------------------------------------------------------- */

await test('popup fits 400px with no horizontal overflow', async () => {
  await openPopup({ entries: ENTRIES });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px`);
});

await test('long titles are truncated, not wrapped into a taller card', async () => {
  const longTitle = 'A'.repeat(220);
  await openPopup({ entries: [{ ...ENTRIES[1], title: longTitle }] });
  const card = page.locator('.card').first();
  const title = card.locator('.meta-title');
  const box = await card.boundingBox();
  const metrics = await title.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  assert.ok(metrics.scroll > metrics.client, 'title should be ellipsised');
  assert.ok(box.height < 70, `card grew to ${box.height}px`);
});

await test('download buttons align in a single column', async () => {
  await openPopup({ entries: ENTRIES });
  const boxes = await page.locator('.card .download').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
  const maxDelta = Math.max(...boxes) - Math.min(...boxes);
  assert.ok(maxDelta < 1, `button right edges differ by ${maxDelta}px`);
});

await test('dark mode is supported via prefers-color-scheme', async () => {
  const dark = await browser.newPage({ viewport: { width: 400, height: 580 } });
  await dark.emulateMedia({ colorScheme: 'dark' }); // must precede navigation
  await dark.addInitScript(mockChrome, { entries: ENTRIES, failDownload: false, tabUrl: 'https://example.test/watch' });
  await dark.goto(popupUrl);
  await dark.waitForTimeout(300);

  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const card = await dark.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor);
  assert.equal(bg, 'rgb(15, 17, 23)', `body background in dark mode was ${bg}`);
  assert.notEqual(card, bg, 'cards should be lighter than the page background');
  await dark.close();
});

await test('nothing is fetched from the network (CSP-safe, offline)', async () => {
  const requests = [];
  const probe = await browser.newPage();
  probe.on('request', (r) => requests.push(r.url()));
  await probe.addInitScript(mockChrome, { entries: ENTRIES, failDownload: false, tabUrl: 'https://example.test/watch' });
  await probe.goto(popupUrl);
  await probe.waitForTimeout(250);
  const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:'));
  assert.deepEqual(external, [], `popup made external requests: ${external.join(', ')}`);
  assert.ok(await probe.locator('.card').count() > 0, 'sanity: the popup rendered');
  await probe.close();
});

/* ------------------------------------------------------------------------ */

await browser.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
