/**
 * shot-popup.mjs — renders the popup in the three meaningful states and saves
 * PNGs into _dev/screens/ for review.
 *
 * Run:  node _dev/shot-popup.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Sapna/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.js');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const root = 'C:/Users/Sapna/Downloads/new/MediaPulse';
const popupUrl = pathToFileURL(resolve(root, 'popup.html')).href;
const outDir = resolve(root, '_dev/screens');
mkdirSync(outDir, { recursive: true });

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

function mockChrome(cfg) {
  const s = cfg;
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(m, cb) {
        const r = (v) => setTimeout(() => cb(v), 0);
        if (m.type === 'MP_GET_MEDIA') r({ ok: true, tabId: 1, entries: s.entries, total: s.entries.length, updated: Date.now() });
        else if (m.type === 'MP_DOWNLOAD') r({ ok: true, downloadId: 1, filename: 'trailer.mp4' });
        else r({ ok: true });
      },
      onMessage: { addListener() {} },
      getURL: (x) => x
    },
    tabs: {
      query(_q, cb) {
        cb([{ id: 1, url: s.tabUrl, active: true }]);
      },
      sendMessage() {
        return Promise.resolve({});
      }
    },
    scripting: { executeScript() { return Promise.resolve([]); } }
  };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function shot(name, cfg, { dark = false, action = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 2 });
  if (dark) await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(mockChrome, cfg);
  await page.goto(popupUrl);
  await page.waitForTimeout(450);
  if (action) await action(page);

  const file = resolve(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
  await page.close();
}

const base = { failDownload: false, tabUrl: 'https://example.test/watch' };

await shot('popup-list', { ...base, entries: ENTRIES });
await shot('popup-empty', { ...base, entries: [] });
await shot('popup-dark', { ...base, entries: ENTRIES }, { dark: true });
await shot('popup-saved', { ...base, entries: ENTRIES }, {
  action: async (page) => {
    await page.locator('.card').nth(1).locator('.download').click();
    await page.waitForTimeout(200);
  }
});
await shot('popup-restricted', { ...base, entries: [], tabUrl: 'chrome://extensions/' });

await browser.close();
