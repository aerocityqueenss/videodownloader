/**
 * e2e-pipeline.mjs — drives the REAL background.js against a REAL local HTTP
 * server, with only the chrome.* APIs mocked.
 *
 * This is the closest we can get to "load it in Chrome" without a browser
 * profile: the worker code path, the network classification, the storage
 * round-trip and the download call are all exercised with genuine HTTP bodies
 * including Content-Length and Content-Type headers.
 *
 * Run:  node _dev/e2e-pipeline.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* --- a tiny fake CDN ---------------------------------------------------- */
const FRAGMENT = Buffer.alloc(188 * 40, 0x47); // plausible MPEG-TS sized payload
const MP4_BODY = Buffer.alloc(2048, 0x11);
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.0,',
  'seg-0.ts',
  '#EXTINF:4.0,',
  'seg-1.ts',
  '#EXT-X-ENDLIST'
].join('\n');

const routes = {
  '/watch': ['text/html', Buffer.from('<html><body><video src="/media/movie.mp4"></video></body></html>')],
  '/media/movie.mp4': ['video/mp4', MP4_BODY],
  '/hls/master.m3u8': ['application/vnd.apple.mpegurl', Buffer.from(PLAYLIST)],
  '/hls/seg-0.ts': ['video/mp2t', FRAGMENT],
  '/hls/seg-1.ts': ['video/mp2t', FRAGMENT],
  '/assets/app.js': ['application/javascript', Buffer.from('console.log(1)')]
};

const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const hit = routes[path];
  if (!hit) {
    res.writeHead(404).end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': hit[0], 'content-length': hit[1].length });
  res.end(hit[1]);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`\nLocal CDN on ${origin}\n`);

/* --- chrome mock (faithful storage + real fetch) ------------------------ */
const store = new Map();
const L = {};
const downloadCalls = [];

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { L.msg = fn; } },
    onInstalled: { addListener: () => {} },
    sendMessage: () => Promise.resolve()
  },
  storage: {
    session: {
      get: async (key) => {
        const raw = store.get(key);
        return { [key]: raw === undefined ? undefined : JSON.parse(JSON.stringify(raw)) };
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v)));
      },
      clear: async () => store.clear()
    }
  },
  webRequest: {
    onCompleted: { addListener: (fn) => { L.done = fn; } },
    onBeforeRedirect: { addListener: (fn) => { L.redirect = fn; } }
  },
  tabs: {
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} }
  },
  downloads: {
    download: async (opts) => {
      downloadCalls.push(opts);
      return downloadCalls.length;
    }
  },
  action: { setBadgeText: () => {} }
};

/* --- load the real worker ---------------------------------------------- */
const src = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const tmp = join(tmpdir(), `mediapulse-e2e-${process.pid}.mjs`);
writeFileSync(tmp, src, 'utf8');
await import(pathToFileURL(tmp).href);
unlinkSync(tmp);

const ask = (message, sender = { tab: { id: 1, url: `${origin}/watch` } }) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout for ${message.type}`)), 4000);
    L.msg(message, sender, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });

/**
 * Simulate what Chrome's webRequest would report for a real response. We
 * actually fetch the bytes so the Content-Length/Type come from the server.
 */
async function capture(tabId, path, type = 'media') {
  const url = origin + path;
  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  const headers = [...res.headers.entries()].map(([name, value]) => ({ name, value }));
  L.done({ tabId, url, type, statusCode: res.status, responseHeaders: headers, initiator: origin });
  return body.length;
}

/* --- tests ------------------------------------------------------------- */
let passed = 0;
let failed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${label}\n        ${err.message}`);
  }
}

console.log('MediaPulse end-to-end pipeline\n');

await test('progressive MP4 is captured with its real size', async () => {
  const bytes = await capture(1, '/media/movie.mp4');
  await new Promise((r) => setTimeout(r, 80));

  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 1 });
  const mp4 = view.entries.find((e) => e.ext === 'mp4');
  assert.ok(mp4, 'mp4 not captured');
  assert.equal(mp4.size, bytes, `size ${mp4.size} != real ${bytes}`);
  assert.equal(mp4.sizeText, '2.0 KB');
  assert.equal(mp4.kind, 'video');
  assert.equal(mp4.fileName, 'movie.mp4');
});

await test('HLS playlist + fragments fold into one downloadable row', async () => {
  await capture(1, '/hls/master.m3u8', 'xmlhttprequest');
  await capture(1, '/hls/seg-0.ts', 'xmlhttprequest');
  await capture(1, '/hls/seg-1.ts', 'xmlhttprequest');
  await new Promise((r) => setTimeout(r, 80));

  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 1 });
  const hls = view.entries.filter((e) => e.kind === 'hls');
  const segs = view.entries.filter((e) => e.kind === 'segment');
  assert.equal(hls.length, 1, 'expected exactly one playlist row');
  assert.equal(segs.length, 0, 'fragments must not be listed as rows');
  assert.equal(hls[0].segments, 2, 'both fragments should be counted');
  assert.equal(view.entries[0].kind, 'hls', 'HLS should sort first');
});

await test('non-media responses are ignored', async () => {
  await capture(1, '/assets/app.js', 'script');
  await new Promise((r) => setTimeout(r, 60));
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 1 });
  assert.ok(!view.entries.some((e) => e.fileName === 'app.js'), 'a .js file must not be listed');
});

await test('the playlist downloads with a sensible filename', async () => {
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 1 });
  const hls = view.entries.find((e) => e.kind === 'hls');
  downloadCalls.length = 0;
  const result = await ask({ type: 'MP_DOWNLOAD', url: hls.url, tabId: 1 });
  assert.equal(result.ok, true, result.error);
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].filename, 'master.m3u8');
  assert.equal(downloadCalls[0].url, hls.url);
});

await test('the downloaded playlist URL really serves valid HLS', async () => {
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 1 });
  const hls = view.entries.find((e) => e.kind === 'hls');
  const body = await (await fetch(hls.url)).text();
  assert.match(body, /#EXTM3U/, 'downloaded playlist must start with #EXTM3U');
  assert.match(body, /seg-0\.ts/);
});

await test('fragments cannot be downloaded as whole videos', async () => {
  const result = await ask({ type: 'MP_DOWNLOAD', url: `${origin}/hls/seg-0.ts`, tabId: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /fragments cannot be downloaded/i);
});

await test('a second tab has an independent list', async () => {
  await capture(2, '/media/movie.mp4');
  await new Promise((r) => setTimeout(r, 60));
  const tab2 = await ask({ type: 'MP_GET_MEDIA', tabId: 2 }, { tab: { id: 2 } });
  assert.equal(tab2.entries.length, 1, 'tab 2 should only see its own media');
  const tab1 = await ask({ type: 'MP_GET_MEDIA', tabId: 1 });
  assert.equal(tab1.entries.length, 2, 'tab 1 should be unaffected');
});

await test('closing a tab drops its list', async () => {
  await ask({ type: 'MP_CLEAR', tabId: 2 }, { tab: { id: 2 } });
  const tab2 = await ask({ type: 'MP_GET_MEDIA', tabId: 2 }, { tab: { id: 2 } });
  assert.equal(tab2.entries.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
server.close();
process.exitCode = failed === 0 ? 0 : 1;
