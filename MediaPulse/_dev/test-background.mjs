/**
 * test-background.mjs — exercises background.js in Node with a mocked
 * `chrome` API. It verifies the pure helpers plus the end-to-end capture
 * pipeline: webRequest event -> storage -> GET_MEDIA view -> download.
 *
 * Run:  node _dev/test-background.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* --------------------------------------------------------------------------
 * Minimal chrome mock
 * ------------------------------------------------------------------------ */
const sessionStore = new Map();
const listeners = { onCompleted: [], onBeforeRedirect: [], onMessage: [], onRemoved: [], onUpdated: [], onInstalled: [] };
const downloads = [];
let downloadShouldFail = null;

const chrome = {
  storage: {
    session: {
      // Real chrome.storage round-trips values through JSON, which stringifies
      // nested object keys (a numeric tab id comes back as "1"). Mimic that
      // faithfully so a numeric-vs-string key mismatch cannot hide here.
      get: async (key) => {
        const raw = sessionStore.get(key);
        return { [key]: raw === undefined ? undefined : JSON.parse(JSON.stringify(raw)) };
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, JSON.parse(JSON.stringify(v)));
      },
      clear: async () => sessionStore.clear()
    }
  },
  webRequest: {
    onCompleted: { addListener: (fn) => listeners.onCompleted.push(fn) },
    onBeforeRedirect: { addListener: (fn) => listeners.onBeforeRedirect.push(fn) }
  },
  tabs: {
    onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
    onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) }
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
    onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
    sendMessage: async () => {
      throw new Error('No popup open'); // broadcastUpdate must swallow this
    }
  },
  downloads: {
    download: async (opts) => {
      if (downloadShouldFail) throw new Error(downloadShouldFail);
      downloads.push(opts);
      return downloads.length;
    }
  }
};

globalThis.chrome = chrome;

/* --------------------------------------------------------------------------
 * Load the worker as a module
 * ------------------------------------------------------------------------ */
const srcPath = new URL('../background.js', import.meta.url);
const tmpCopy = join(tmpdir(), `mediapulse-bg-${process.pid}.mjs`);
writeFileSync(tmpCopy, readFileSync(srcPath, 'utf8'), 'utf8');
await import(`file:///${tmpCopy.replace(/\\/g, '/')}`);
unlinkSync(tmpCopy);

const internals = globalThis.__mediaPulseInternals;
const completed = listeners.onCompleted[0];
const redirected = listeners.onBeforeRedirect[0];
const onMessage = listeners.onMessage[0];

/** Helper: send a message to the worker and await its async reply. */
function ask(message, sender = { tab: { id: 7, url: 'https://site.test/page' } }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sendResponse never called')), 2000);
    const kept = onMessage(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    if (kept !== true && kept !== false) {
      clearTimeout(timeout);
      reject(new Error('bad listener return value'));
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------ */
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log('\nMediaPulse background.js tests\n');

/* --- pure helpers ------------------------------------------------------- */

await test('extensionOf parses paths, ignores query strings', () => {
  assert.equal(internals.extensionOf('https://cdn.test/a/b/movie.MP4?token=1'), 'mp4');
  assert.equal(internals.extensionOf('https://cdn.test/noext/index'), '');
  assert.equal(internals.extensionOf('https://cdn.test/x/playlist.m3u8#frag'), 'm3u8');
});

await test('classify prefers MIME type over extension', () => {
  // Extension-less URL, MIME identifies it.
  assert.deepEqual(internals.classify('https://cdn.test/stream/abc', 'video/mp4'), {
    ext: 'mp4',
    kind: 'video',
    source: 'mime'
  });
  // MIME with charset parameter.
  assert.equal(internals.classify('https://cdn.test/hls/x', 'application/vnd.apple.mpegurl; charset=utf-8').kind, 'hls');
  // Falls back to the extension.
  assert.equal(internals.classify('https://cdn.test/movie.webm', null).ext, 'webm');
  // Not media.
  assert.equal(internals.classify('https://cdn.test/image.png', 'image/png'), null);
  assert.equal(internals.classify('https://cdn.test/app.js', 'text/javascript'), null);
});

await test('classify maps fragments to kind=segment', () => {
  assert.equal(internals.classify('https://cdn.test/x/seg-1.ts', 'video/mp2t').kind, 'segment');
  assert.equal(internals.classify('https://cdn.test/x/init.m4s', null).kind, 'segment');
});

await test('normaliseUrl resolves relative refs and drops fragments', () => {
  assert.equal(internals.normaliseUrl('/v/a.mp4', 'https://site.test/page'), 'https://site.test/v/a.mp4');
  assert.equal(internals.normaliseUrl('https://cdn.test/a.mp4#t=10'), 'https://cdn.test/a.mp4');
  assert.equal(internals.normaliseUrl('blob:https://site.test/123'), null);
  assert.equal(internals.normaliseUrl('javascript:void(0)'), null);
});

await test('unwrapQueryUrl extracts proxied media URLs', () => {
  const wrapped = 'https://proxy.test/p?url=' + encodeURIComponent('https://cdn.test/movie.mp4');
  assert.equal(internals.unwrapQueryUrl(wrapped), 'https://cdn.test/movie.mp4');
  assert.equal(internals.unwrapQueryUrl('https://proxy.test/p?url=' + encodeURIComponent('https://cdn.test/x.png')), null);
  assert.equal(internals.unwrapQueryUrl('https://cdn.test/direct.mp4'), null);
});

await test('formatBytes renders human sizes', () => {
  assert.equal(internals.formatBytes(512), '512 B');
  assert.equal(internals.formatBytes(1024), '1.0 KB');
  assert.equal(internals.formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(internals.formatBytes(1024 * 1024 * 1024 * 2), '2.0 GB');
  assert.equal(internals.formatBytes(-1), '');
  assert.equal(internals.formatBytes(0), '');
});

await test('sanitiseFilename strips traversal and illegal characters', () => {
  // Leading dots are removed entirely, so "../.." can never escape the folder.
  assert.equal(internals.sanitiseFilename('../../etc/passwd', 'x.mp4'), '_.._etc_passwd');
  assert.equal(internals.sanitiseFilename('..\\..\\windows\\system32\\x', 'f'), '_.._windows_system32_x');
  assert.equal(internals.sanitiseFilename('a<b>c:d?.mp4', 'x'), 'a_b_c_d_.mp4');
  assert.equal(internals.sanitiseFilename('', 'fallback.mp4'), 'fallback.mp4');
  assert.equal(internals.sanitiseFilename('  spaced  out .mp4 ', 'f'), 'spaced out .mp4');
  assert.ok(internals.sanitiseFilename('x'.repeat(300) + '.mp4', 'f').length <= 150);
});

await test('suggestedFilename adds the right extension without doubling it', () => {
  assert.equal(internals.suggestedFilename({ fileName: 'clip.mp4', ext: 'mp4' }), 'clip.mp4');
  assert.equal(internals.suggestedFilename({ fileName: 'clip.webm', ext: 'webm' }), 'clip.webm');
  assert.equal(internals.suggestedFilename({ fileName: 'master', ext: 'm3u8' }), 'master.m3u8');
  assert.equal(internals.suggestedFilename({ fileName: 'Movie.MP4', ext: 'mp4' }), 'Movie.mp4');
});

await test('parseContentLength and getHeader are case-insensitive', () => {
  const headers = [
    { name: 'Content-Type', value: 'video/mp4' },
    { name: 'content-length', value: '2048' }
  ];
  assert.equal(internals.parseContentLength(headers), 2048);
  assert.equal(internals.getHeader(headers, 'CONTENT-TYPE'), 'video/mp4');
  assert.equal(internals.getHeader(undefined, 'x'), null);
  assert.equal(internals.parseContentLength(undefined), null);
});

await test('mergeEntry keeps the larger size and earliest firstSeen', () => {
  const a = { url: 'u', size: 5000, firstSeen: 10, lastSeen: 20, segments: 0, title: 'Real Title', fileName: 'f.mp4' };
  const b = { url: 'u', size: 9000, firstSeen: 30, lastSeen: 40, segments: 3, title: 'f.mp4', fileName: 'f.mp4' };
  const merged = internals.mergeEntry(a, b);
  assert.equal(merged.size, 9000);
  assert.equal(merged.firstSeen, 10);
  assert.equal(merged.lastSeen, 40);
  assert.equal(merged.segments, 3);
  assert.equal(merged.title, 'Real Title', 'a real title should survive a generic incoming one');
});

/* --- capture pipeline --------------------------------------------------- */

await test('onCompleted captures an MP4 with a size', async () => {
  completed({
    tabId: 7,
    type: 'media',
    url: 'https://cdn.test/video/movie.mp4',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '10485760' }
    ]
  });
  await sleep(30);

  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 7 });
  assert.equal(view.ok, true);
  assert.equal(view.entries.length, 1);
  const entry = view.entries[0];
  assert.equal(entry.kind, 'video');
  assert.equal(entry.ext, 'mp4');
  assert.equal(entry.sizeText, '10.0 MB');
  assert.equal(entry.host, 'cdn.test');
  assert.equal(entry.fileName, 'movie.mp4');
});

await test('onCompleted captures HLS playlists and hides raw segments', async () => {
  completed({
    tabId: 7,
    type: 'xmlhttprequest',
    url: 'https://cdn.test/hls/master.m3u8',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }]
  });
  for (let i = 0; i < 4; i += 1) {
    completed({
      tabId: 7,
      type: 'xmlhttprequest',
      url: `https://cdn.test/hls/seg-${i}.ts`,
      responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }]
    });
  }
  await sleep(40);

  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 7 });
  const playlists = view.entries.filter((e) => e.kind === 'hls');
  const segments = view.entries.filter((e) => e.kind === 'segment');

  assert.equal(segments.length, 0, 'raw .ts fragments must never be listed as downloadable');
  assert.equal(playlists.length, 1);
  assert.equal(playlists[0].segments, 4, 'segments should be counted on the playlist row');
  assert.equal(view.entries[0].kind, 'hls', 'HLS should sort above progressive video');
});

await test('extension-less URL is captured via MIME type', async () => {
  completed({
    tabId: 8,
    type: 'xmlhttprequest',
    url: 'https://stream.test/abcdef/play',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }]
  });
  await sleep(30);
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 8 });
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].ext, 'mp4');
});

await test('proxied URLs are unwrapped', async () => {
  const inner = 'https://cdn.test/proxied/clip.webm';
  completed({
    tabId: 9,
    type: 'media',
    url: 'https://proxy.test/fetch?url=' + encodeURIComponent(inner),
    responseHeaders: []
  });
  await sleep(30);
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 9 });
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].url, inner);
});

await test('onBeforeRedirect records the redirect target', async () => {
  redirected({ tabId: 10, type: 'main_frame', url: 'https://site.test/go/1', redirectUrl: 'https://cdn.test/real/redirected.mp4' });
  await sleep(30);
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 10 });
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].fileName, 'redirected.mp4');
});

await test('content-script items are added with the sender tab, not the claimed tab', async () => {
  const reply = await ask(
    { type: 'MP_ADD_MEDIA', tabId: 999, items: [{ url: '/dom/from-content.mp4' }], pageUrl: 'https://site.test/page' },
    { tab: { id: 11, url: 'https://site.test/page' } }
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.added, 1);

  const forSender = await ask({ type: 'MP_GET_MEDIA', tabId: 11 });
  assert.equal(forSender.entries.length, 1);
  assert.equal(forSender.entries[0].url, 'https://site.test/dom/from-content.mp4');

  const forClaimed = await ask({ type: 'MP_GET_MEDIA', tabId: 999 });
  assert.equal(forClaimed.entries.length, 0, 'a content script must not write into another tab');
});

await test('non-media responses are ignored', async () => {
  completed({ tabId: 12, type: 'xmlhttprequest', url: 'https://cdn.test/data.json', responseHeaders: [{ name: 'content-type', value: 'application/json' }] });
  completed({ tabId: 12, type: 'script', url: 'https://cdn.test/x.mp4', responseHeaders: [] });
  await sleep(30);
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 12 });
  assert.equal(view.entries.length, 0);
});

/* --- downloads ---------------------------------------------------------- */

await test('download succeeds and sanitises the filename', async () => {
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 7 });
  const target = view.entries.find((e) => e.fileName === 'movie.mp4');
  const reply = await ask({ type: 'MP_DOWNLOAD', tabId: 7, url: target.url });
  assert.equal(reply.ok, true);
  assert.equal(reply.filename, 'movie.mp4');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].conflictAction, 'uniquify');
  assert.equal(downloads[0].saveAs, false);
});

await test('download of an untracked URL is refused', async () => {
  const reply = await ask({ type: 'MP_DOWNLOAD', tabId: 7, url: 'https://evil.test/payload.exe' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /no longer tracked/);
  assert.equal(downloads.length, 1, 'nothing should have been downloaded');
});

await test('download of a raw segment is refused', async () => {
  completed({ tabId: 13, type: 'xmlhttprequest', url: 'https://cdn.test/hls/only-seg.ts', responseHeaders: [] });
  await sleep(30);
  const reply = await ask({ type: 'MP_DOWNLOAD', tabId: 13, url: 'https://cdn.test/hls/only-seg.ts' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /fragments cannot be downloaded/);
});

await test('chrome.downloads failures are reported, not thrown', async () => {
  downloadShouldFail = 'Network error';
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 7 });
  const reply = await ask({ type: 'MP_DOWNLOAD', tabId: 7, url: view.entries[0].url });
  downloadShouldFail = null;
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'Network error');
});

/* --- lifecycle ---------------------------------------------------------- */

await test('navigating a tab forgets its media', async () => {
  const before = await ask({ type: 'MP_GET_MEDIA', tabId: 7 });
  assert.ok(before.entries.length > 0);
  for (const fn of listeners.onUpdated) fn(7, { status: 'loading', url: 'https://site.test/next' }, {});
  await sleep(30);
  const after = await ask({ type: 'MP_GET_MEDIA', tabId: 7 });
  assert.equal(after.entries.length, 0);
});

await test('closing a tab forgets its media', async () => {
  for (const fn of listeners.onRemoved) fn(8, {});
  await sleep(30);
  const after = await ask({ type: 'MP_GET_MEDIA', tabId: 8 });
  assert.equal(after.entries.length, 0);
});

await test('CLEAR empties a tab', async () => {
  const reply = await ask({ type: 'MP_CLEAR', tabId: 9 });
  assert.equal(reply.ok, true);
  const after = await ask({ type: 'MP_GET_MEDIA', tabId: 9 });
  assert.equal(after.entries.length, 0);
});

await test('per-tab cap evicts oldest entries', async () => {
  for (let i = 0; i < 150; i += 1) {
    completed({
      tabId: 20,
      type: 'media',
      url: `https://cdn.test/bulk/file-${i}.mp4`,
      responseHeaders: [{ name: 'content-length', value: '2000' }]
    });
  }
  await sleep(120);
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 20 });
  assert.ok(view.entries.length <= 120, `expected <=120 entries, got ${view.entries.length}`);
  assert.ok(view.entries.some((e) => e.fileName === 'file-149.mp4'), 'newest entry should survive');
  assert.ok(!view.entries.some((e) => e.fileName === 'file-0.mp4'), 'oldest entry should be evicted');
});

await test('a throwing listener does not break later events', async () => {
  // Malformed details (no responseHeaders, undefined url) must not throw out.
  completed({ tabId: 21, type: 'media', url: undefined, responseHeaders: undefined });
  redirected({ tabId: 21, type: 'media', url: 'x', redirectUrl: null });
  await sleep(20);
  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 21 });
  assert.equal(view.ok, true);
});

await test('unknown message types return false (not handled)', () => {
  const kept = onMessage({ type: 'NOPE' }, {}, () => {});
  assert.equal(kept, false);
  assert.equal(onMessage(null, {}, () => {}), false);
});

/* --- regressions -------------------------------------------------------- */

await test('storage round-trip keeps numeric tab ids addressable', async () => {
  // chrome.storage JSON-serialises, so a tab stored under 24 comes back as
  // "24". Nothing may depend on the key's type or every download fails.
  completed({
    tabId: 24,
    type: 'media',
    url: 'https://cdn.test/roundtrip.mp4',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }]
  });
  await sleep(60);

  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 24 }, { tab: { id: 24, url: 'https://site.test/page' } });
  assert.equal(view.entries.length, 1, 'entry must survive the JSON round-trip');

  const result = await ask({ type: 'MP_DOWNLOAD', url: 'https://cdn.test/roundtrip.mp4', tabId: 24 }, { tab: { id: 24 } });
  assert.equal(result.ok, true, `download failed: ${result.error}`);
});

await test('simultaneous requests are not lost to write races', async () => {
  // A player fires many requests in the same tick; each capture is a
  // read-modify-write and must not clobber its neighbours.
  completed({
    tabId: 25,
    type: 'xmlhttprequest',
    url: 'https://cdn.test/race/index.m3u8',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }]
  });
  for (let i = 0; i < 4; i += 1) {
    completed({
      tabId: 25,
      type: 'xmlhttprequest',
      url: `https://cdn.test/race/part-${i}.ts`,
      responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }]
    });
  }
  await sleep(120);

  const view = await ask({ type: 'MP_GET_MEDIA', tabId: 25 });
  const playlist = view.entries.find((e) => e.kind === 'hls');
  assert.ok(playlist, 'playlist must survive concurrent captures');
  assert.equal(playlist.segments, 4, `expected 4 counted fragments, got ${playlist.segments}`);
});

await test('downloads use a meaningful filename from the URL', async () => {
  completed({
    tabId: 26,
    type: 'media',
    url: 'https://cdn.test/movies/My%20Holiday%20Clip.mp4',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }]
  });
  await sleep(60);

  downloads.length = 0;
  const result = await ask({ type: 'MP_DOWNLOAD', url: 'https://cdn.test/movies/My%20Holiday%20Clip.mp4', tabId: 26 }, { tab: { id: 26 } });
  assert.equal(result.ok, true, `download failed: ${result.error}`);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'My Holiday Clip.mp4', 'should not collapse to a generic media.mp4');
});

/* ------------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
